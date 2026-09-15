package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

func (s *Store) ListTags(ctx context.Context) ([]*domain.Tag, error) {
	// count 只算没被软删的对象，否则回收站里的东西会把标签徽标撑大。
	rows, err := s.db.R.QueryContext(ctx, `SELECT t.id, t.name, t.color, t.created_at, COUNT(o.id)
		FROM tags t
		LEFT JOIN object_tags ot ON ot.tag_id = t.id
		LEFT JOIN objects o ON o.id = ot.object_id AND o.deleted_at IS NULL
		GROUP BY t.id, t.name, t.color, t.created_at
		ORDER BY t.name`)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Tag{}
	for rows.Next() {
		var t domain.Tag
		var created string
		if err := rows.Scan(&t.ID, &t.Name, &t.Color, &created, &t.Count); err != nil {
			return nil, err
		}
		t.CreatedAt = parseTime(created)
		out = append(out, &t)
	}
	return out, rows.Err()
}

func (s *Store) CreateTag(ctx context.Context, name, color string) (*domain.Tag, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, validation("name", "is required")
	}
	id := idgen.Prefixed("tag")
	now := nowStr()
	_, err := s.db.W.ExecContext(ctx,
		`INSERT INTO tags (id, name, color, created_at) VALUES (?,?,?,?)`, id, name, color, now)
	if isUnique(err) {
		return nil, conflict("tag " + name + " already exists")
	}
	if err != nil {
		return nil, fmt.Errorf("insert tag: %w", err)
	}
	return &domain.Tag{ID: id, Name: name, Color: color, CreatedAt: parseTime(now)}, nil
}

func (s *Store) DeleteTag(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM tags WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete tag: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound("tag")
	}
	return nil
}

// setTags 把对象的标签整体替换成 names，缺的标签顺手建出来（界面上是自由输入）。
func setTags(ctx context.Context, tx *sql.Tx, objectID string, names []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM object_tags WHERE object_id = ?`, objectID); err != nil {
		return fmt.Errorf("clear object tags: %w", err)
	}
	seen := map[string]bool{}
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true

		tagID, err := ensureTag(ctx, tx, name)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO object_tags (object_id, tag_id) VALUES (?,?)`,
			objectID, tagID); err != nil {
			return fmt.Errorf("link tag: %w", err)
		}
	}
	return nil
}

func ensureTag(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM tags WHERE name = ?`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !noRows(err) {
		return "", fmt.Errorf("lookup tag: %w", err)
	}
	id = idgen.Prefixed("tag")
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO tags (id, name, color, created_at) VALUES (?,?,'',?)`,
		id, name, nowStr()); err != nil {
		return "", fmt.Errorf("insert tag: %w", err)
	}
	return id, nil
}

// getTag 按 id 取单个标签。Count 与 ListTags 同口径：只算未软删的对象，
// 否则回收站里的东西会把标签徽标撑大。
func getTag(ctx context.Context, q queryer, id string) (*domain.Tag, error) {
	var t domain.Tag
	var created string
	err := q.QueryRowContext(ctx, `SELECT t.id, t.name, t.color, t.created_at, COUNT(o.id)
		FROM tags t
		LEFT JOIN object_tags ot ON ot.tag_id = t.id
		LEFT JOIN objects o ON o.id = ot.object_id AND o.deleted_at IS NULL
		WHERE t.id = ?
		GROUP BY t.id, t.name, t.color, t.created_at`, id).
		Scan(&t.ID, &t.Name, &t.Color, &created, &t.Count)
	if noRows(err) {
		return nil, notFound("tag")
	}
	if err != nil {
		return nil, fmt.Errorf("get tag: %w", err)
	}
	t.CreatedAt = parseTime(created)
	return &t, nil
}

// UpdateTag 改名或改色，指针语义：nil 表示不改这一项。
func (s *Store) UpdateTag(ctx context.Context, id string, name, color *string) (*domain.Tag, error) {
	cur, err := getTag(ctx, s.db.R, id)
	if err != nil {
		return nil, err
	}

	sets := []string{}
	args := []any{}
	newName := ""
	if name != nil {
		newName = strings.TrimSpace(*name)
		if newName == "" {
			return nil, validation("name", "must not be empty")
		}
		sets = append(sets, "name = ?")
		args = append(args, newName)
	}
	if color != nil {
		sets = append(sets, "color = ?")
		args = append(args, *color)
	}
	if len(sets) == 0 {
		return cur, nil
	}
	args = append(args, id)

	_, err = s.db.W.ExecContext(ctx,
		`UPDATE tags SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	// 改名撞上已有标签名一律报冲突，绝不静默合并：用户以为只是在改个错别字，
	// 结果两个标签的对象被并到一起且不可逆，这是数据事故。要合并得显式走 MergeTags。
	if isUnique(err) {
		return nil, conflict("tag " + newName + " already exists")
	}
	if err != nil {
		return nil, fmt.Errorf("update tag: %w", err)
	}
	return getTag(ctx, s.db.R, id)
}

// MergeTags 把 srcID 的对象全部改打 dstID，然后删掉 srcID，返回合并后的 dst。
// 手工打了同义标签（「云端」和「云端平台」）之后必然需要，是标签管理最高频的操作。
func (s *Store) MergeTags(ctx context.Context, srcID, dstID string) (*domain.Tag, error) {
	if srcID == dstID {
		return nil, validation("target_id", "must differ from the tag being merged")
	}

	err := s.withTx(ctx, func(tx *sql.Tx) error {
		for _, id := range []string{srcID, dstID} {
			var found string
			err := tx.QueryRowContext(ctx, `SELECT id FROM tags WHERE id = ?`, id).Scan(&found)
			if noRows(err) {
				return notFound("tag")
			}
			if err != nil {
				return fmt.Errorf("lookup tag: %w", err)
			}
		}
		// 用 INSERT OR IGNORE + SELECT，而不是 UPDATE object_tags SET tag_id = dst：
		// 同时挂着两个标签的对象会撞上 (object_id, tag_id) 主键，整个合并连带回滚。
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO object_tags (object_id, tag_id)
			 SELECT object_id, ? FROM object_tags WHERE tag_id = ?`, dstID, srcID); err != nil {
			return fmt.Errorf("move object tags: %w", err)
		}
		// src 残留的 object_tags 行由外键 ON DELETE CASCADE 收走。
		if _, err := tx.ExecContext(ctx, `DELETE FROM tags WHERE id = ?`, srcID); err != nil {
			return fmt.Errorf("delete merged tag: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return getTag(ctx, s.db.R, dstID)
}
