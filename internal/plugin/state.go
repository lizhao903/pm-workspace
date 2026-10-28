package plugin

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// State 是插件状态表里的一行（0016_plugins）。
type State struct {
	ID            string     `json:"id"`
	Installed     bool       `json:"installed"`
	Enabled       bool       `json:"enabled"`
	Version       string     `json:"version"` // 安装或上次升级时的版本
	InstalledAt   *time.Time `json:"installed_at"`
	Permissions   []string   `json:"permissions"` // 用户确认过的权限
	PermissionsAt *time.Time `json:"permissions_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// StateStore 存取插件状态。Save 是整行写入。
type StateStore interface {
	Load(ctx context.Context) (map[string]State, error)
	Save(ctx context.Context, s State) error
}

// MemStateStore 是内存里的 StateStore，测试用。
type MemStateStore struct {
	mu sync.Mutex
	m  map[string]State
}

func NewMemStateStore() *MemStateStore { return &MemStateStore{m: map[string]State{}} }

func (s *MemStateStore) Load(context.Context) (map[string]State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]State, len(s.m))
	for k, v := range s.m {
		out[k] = v
	}
	return out, nil
}

func (s *MemStateStore) Save(_ context.Context, st State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[st.ID] = st
	return nil
}

// SQLStateStore 把状态存进 plugins 表。表由 db.Migrate 建，调用前库必须已经迁移过。
type SQLStateStore struct{ d *db.DB }

func NewSQLStateStore(d *db.DB) *SQLStateStore { return &SQLStateStore{d: d} }

func (s *SQLStateStore) Load(ctx context.Context) (map[string]State, error) {
	rows, err := s.d.R.QueryContext(ctx, `SELECT id, installed, enabled, version, installed_at,
		permissions, permissions_at, updated_at FROM plugins`)
	if err != nil {
		return nil, fmt.Errorf("load plugin state: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]State{}
	for rows.Next() {
		var st State
		var installedAt, permsAt sql.NullString
		var perms, updated string
		if err := rows.Scan(&st.ID, &st.Installed, &st.Enabled, &st.Version, &installedAt,
			&perms, &permsAt, &updated); err != nil {
			return nil, fmt.Errorf("scan plugin state: %w", err)
		}
		if err := json.Unmarshal([]byte(perms), &st.Permissions); err != nil {
			return nil, fmt.Errorf("plugin %s: bad permissions json: %w", st.ID, err)
		}
		st.InstalledAt = parseNullTime(installedAt)
		st.PermissionsAt = parseNullTime(permsAt)
		st.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
		out[st.ID] = st
	}
	return out, rows.Err()
}

func (s *SQLStateStore) Save(ctx context.Context, st State) error {
	perms := st.Permissions
	if perms == nil {
		perms = []string{}
	}
	pj, err := json.Marshal(perms)
	if err != nil {
		return err
	}
	if _, err := s.d.W.ExecContext(ctx, `INSERT INTO plugins
		(id, installed, enabled, version, installed_at, permissions, permissions_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET installed = excluded.installed, enabled = excluded.enabled,
			version = excluded.version, installed_at = excluded.installed_at,
			permissions = excluded.permissions, permissions_at = excluded.permissions_at,
			updated_at = excluded.updated_at`,
		st.ID, st.Installed, st.Enabled, st.Version, nullTime(st.InstalledAt), string(pj),
		nullTime(st.PermissionsAt), st.UpdatedAt.UTC().Format(time.RFC3339)); err != nil {
		return fmt.Errorf("save plugin state: %w", err)
	}
	return nil
}

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func parseNullTime(s sql.NullString) *time.Time {
	if !s.Valid {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s.String)
	if err != nil {
		return nil
	}
	return &t
}
