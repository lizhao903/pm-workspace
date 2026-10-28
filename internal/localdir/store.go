// Package localdir 读写文档的本机目录挂载（DOC-01a，0025）。
// 只存挂载（路径、名称、顺序），文件内容不进库，读的时候走 fsbrowse，边界和 /api/fs 同一套。
package localdir

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// timeLayout 定长毫秒 UTC，字符串比较即时间比较。
const timeLayout = "2006-01-02T15:04:05.000Z"

const maxName = 100

// Dir 是一个挂载的目录。Path 是解析软链后的绝对路径。
type Dir struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Store 读写 local_dirs。
type Store struct {
	db  *db.DB
	now func() time.Time
}

func New(d *db.DB) *Store { return &Store{db: d, now: time.Now} }

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

const cols = `id, path, name, position, created_at, updated_at`

type scanner interface{ Scan(...any) error }

func scan(r scanner) (*Dir, error) {
	var d Dir
	var created, updated string
	if err := r.Scan(&d.ID, &d.Path, &d.Name, &d.Position, &created, &updated); err != nil {
		return nil, err
	}
	d.CreatedAt, _ = time.Parse(timeLayout, created)
	d.UpdatedAt, _ = time.Parse(timeLayout, updated)
	return &d, nil
}

// List 全部挂载，按 position。
func (s *Store) List(ctx context.Context) ([]Dir, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+cols+` FROM local_dirs ORDER BY position, created_at, id`)
	if err != nil {
		return nil, fmt.Errorf("list local dirs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []Dir{}
	for rows.Next() {
		d, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// Get 取一个；不存在回 ErrNotFound。
func (s *Store) Get(ctx context.Context, id string) (*Dir, error) {
	return s.get(ctx, s.db.R, id)
}

func (s *Store) get(ctx context.Context, q *sql.DB, id string) (*Dir, error) {
	d, err := scan(q.QueryRowContext(ctx, `SELECT `+cols+` FROM local_dirs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: local dir %s", domain.ErrNotFound, id)
	}
	return d, err
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalid("name is required")
	}
	if utf8.RuneCountInString(name) > maxName {
		return "", invalid("name: at most %d characters", maxName)
	}
	return name, nil
}

// Create 挂载一个目录，排在最后。路径必须是允许根内存在的目录（fsbrowse 的错误原样返回，
// 调用方据此回 403 或 404）；name 为空取目录名；同一目录挂两次回 ErrConflict。
func (s *Store) Create(ctx context.Context, path, name string) (*Dir, error) {
	real, err := fsbrowse.ResolveDir(path)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(real)
	}
	if name, err = normalizeName(name); err != nil {
		return nil, err
	}
	d := &Dir{ID: idgen.Prefixed("dir"), Path: real, Name: name}
	now := s.now().UTC().Truncate(time.Millisecond)
	d.CreatedAt, d.UpdatedAt = now, now
	// 写池单连接，position 在同一条语句里算不会重复
	row := s.db.W.QueryRowContext(ctx,
		`INSERT INTO local_dirs (id, path, name, position, created_at, updated_at)
		 VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM local_dirs), ?, ?)
		 ON CONFLICT(path) DO NOTHING RETURNING position`,
		d.ID, d.Path, d.Name, now.Format(timeLayout), now.Format(timeLayout))
	if err := row.Scan(&d.Position); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: %s is already mounted", domain.ErrConflict, real)
		}
		return nil, fmt.Errorf("insert local dir: %w", err)
	}
	return d, nil
}

// Rename 改显示名。路径不让改：换目录就是另一个挂载，移除再挂。
func (s *Store) Rename(ctx context.Context, id, name string) (*Dir, error) {
	name, err := normalizeName(name)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC().Truncate(time.Millisecond)
	res, err := s.db.W.ExecContext(ctx, `UPDATE local_dirs SET name = ?, updated_at = ? WHERE id = ?`,
		name, now.Format(timeLayout), id)
	if err != nil {
		return nil, fmt.Errorf("rename local dir: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: local dir %s", domain.ErrNotFound, id)
	}
	return s.get(ctx, s.db.W, id)
}

// Reorder 按 ids 的顺序重排，必须正好是全部挂载各一次，避免和别处的增删交错时丢掉一条。
func (s *Store) Reorder(ctx context.Context, ids []string) error {
	tx, err := s.db.W.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("reorder local dirs: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var total int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM local_dirs`).Scan(&total); err != nil {
		return fmt.Errorf("reorder local dirs: %w", err)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return invalid("ids: %s is duplicated", id)
		}
		seen[id] = true
	}
	if len(ids) != total {
		return invalid("ids must list all %d mounted dirs exactly once, got %d", total, len(ids))
	}
	for i, id := range ids {
		res, err := tx.ExecContext(ctx, `UPDATE local_dirs SET position = ? WHERE id = ?`, i+1, id)
		if err != nil {
			return fmt.Errorf("reorder local dirs: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return invalid("ids: no such local dir %s", id)
		}
	}
	return tx.Commit()
}

// Delete 移除挂载，只删记录，不动磁盘上的目录。
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM local_dirs WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete local dir: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: local dir %s", domain.ErrNotFound, id)
	}
	return nil
}
