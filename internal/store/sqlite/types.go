package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

const objectTypeCols = `id,name,plural,ref_prefix,icon,color,builtin,sort_order,statuses,created_at,updated_at`

var typeIDRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,31}$`)

func scanObjectType(sc rowScanner) (*domain.ObjectType, error) {
	var (
		t          domain.ObjectType
		builtin    int
		statuses   string
		created    string
		updated    string
		icon, colr string
	)
	if err := sc.Scan(&t.ID, &t.Name, &t.Plural, &t.RefPrefix, &icon, &colr,
		&builtin, &t.SortOrder, &statuses, &created, &updated); err != nil {
		return nil, err
	}
	t.Icon, t.Color = icon, colr
	t.Builtin = builtin != 0
	t.CreatedAt = parseTime(created)
	t.UpdatedAt = parseTime(updated)
	t.Statuses = []domain.Status{}
	if statuses != "" {
		if err := json.Unmarshal([]byte(statuses), &t.Statuses); err != nil {
			return nil, fmt.Errorf("decode statuses of %s: %w", t.ID, err)
		}
	}
	return &t, nil
}

func (s *Store) ListObjectTypes(ctx context.Context) ([]*domain.ObjectType, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+objectTypeCols+` FROM object_types ORDER BY sort_order, id`)
	if err != nil {
		return nil, fmt.Errorf("list object types: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.ObjectType{}
	for rows.Next() {
		t, err := scanObjectType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetObjectType(ctx context.Context, id string) (*domain.ObjectType, error) {
	return getObjectType(ctx, s.db.R, id)
}

// queryer 覆盖 *sql.DB 与 *sql.Tx，事务内外共用同一份读逻辑。
type queryer interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, q string, args ...any) *sql.Row
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func getObjectType(ctx context.Context, q queryer, id string) (*domain.ObjectType, error) {
	row := q.QueryRowContext(ctx, `SELECT `+objectTypeCols+` FROM object_types WHERE id = ?`, id)
	t, err := scanObjectType(row)
	if noRows(err) {
		return nil, notFound("object type")
	}
	if err != nil {
		return nil, fmt.Errorf("get object type: %w", err)
	}
	return t, nil
}

func (s *Store) CreateObjectType(ctx context.Context, t *domain.ObjectType) (*domain.ObjectType, error) {
	if t == nil {
		return nil, validation("type", "is required")
	}
	id := strings.TrimSpace(strings.ToLower(t.ID))
	if !typeIDRe.MatchString(id) {
		return nil, validation("id", "must be 2-32 chars of lowercase letters, digits, - or _")
	}
	if strings.TrimSpace(t.Name) == "" {
		return nil, validation("name", "is required")
	}
	prefix := strings.ToUpper(strings.TrimSpace(t.RefPrefix))
	if prefix == "" {
		return nil, validation("ref_prefix", "is required")
	}
	plural := t.Plural
	if strings.TrimSpace(plural) == "" {
		plural = t.Name
	}
	if len(t.Statuses) == 0 {
		return nil, validation("statuses", "must contain at least one status")
	}
	if err := validateStatuses(t.Statuses); err != nil {
		return nil, err
	}
	blob, err := json.Marshal(t.Statuses)
	if err != nil {
		return nil, fmt.Errorf("encode statuses: %w", err)
	}

	now := nowStr()
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO object_types
			(`+objectTypeCols+`) VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
			id, t.Name, plural, prefix, t.Icon, t.Color, t.SortOrder, string(blob), now, now)
		if isUnique(err) {
			return conflict("object type " + id + " already exists")
		}
		if err != nil {
			return fmt.Errorf("insert object type: %w", err)
		}
		// 编号计数器与类型同生共死，建类型时就把行铺好，CreateObject 才能直接取号。
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO ref_counters (type_id, next_seq) VALUES (?, 1)`, id); err != nil {
			return fmt.Errorf("init ref counter: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetObjectType(ctx, id)
}

func (s *Store) UpdateObjectType(ctx context.Context, id string, p domain.ObjectTypePatch) (*domain.ObjectType, error) {
	cur, err := s.GetObjectType(ctx, id)
	if err != nil {
		return nil, err
	}
	// 内置类型的身份字段（名称/前缀）被界面和历史编号依赖，只放开外观与状态集。
	if cur.Builtin && (p.Name != nil || p.Plural != nil || p.RefPrefix != nil) {
		return nil, readOnly("only icon, color, sort_order and statuses are editable on a builtin object type")
	}

	sets := []string{}
	args := []any{}
	add := func(col string, v any) {
		sets = append(sets, col+" = ?")
		args = append(args, v)
	}
	if p.Name != nil {
		if strings.TrimSpace(*p.Name) == "" {
			return nil, validation("name", "must not be empty")
		}
		add("name", *p.Name)
	}
	if p.Plural != nil {
		add("plural", *p.Plural)
	}
	if p.RefPrefix != nil {
		prefix := strings.ToUpper(strings.TrimSpace(*p.RefPrefix))
		if prefix == "" {
			return nil, validation("ref_prefix", "must not be empty")
		}
		add("ref_prefix", prefix)
	}
	if p.Icon != nil {
		add("icon", *p.Icon)
	}
	if p.Color != nil {
		add("color", *p.Color)
	}
	if p.SortOrder != nil {
		add("sort_order", *p.SortOrder)
	}
	if p.Statuses != nil {
		if err := validateStatuses(*p.Statuses); err != nil {
			return nil, err
		}
		blob, err := json.Marshal(*p.Statuses)
		if err != nil {
			return nil, fmt.Errorf("encode statuses: %w", err)
		}
		add("statuses", string(blob))
	}
	if len(sets) == 0 {
		return cur, nil
	}
	add("updated_at", nowStr())
	args = append(args, id)

	if _, err := s.db.W.ExecContext(ctx,
		`UPDATE object_types SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, fmt.Errorf("update object type: %w", err)
	}
	return s.GetObjectType(ctx, id)
}

func (s *Store) DeleteObjectType(ctx context.Context, id string) error {
	cur, err := s.GetObjectType(ctx, id)
	if err != nil {
		return err
	}
	if cur.Builtin {
		return readOnly("builtin object type cannot be deleted")
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM objects WHERE type_id = ?`, id).Scan(&n); err != nil {
		return fmt.Errorf("count objects of type: %w", err)
	}
	if n > 0 {
		return conflict(fmt.Sprintf("object type %s still has %d objects", id, n))
	}
	if _, err := s.db.W.ExecContext(ctx, `DELETE FROM object_types WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete object type: %w", err)
	}
	return nil
}

func validateStatuses(ss []domain.Status) error {
	if len(ss) == 0 {
		return validation("statuses", "must contain at least one status")
	}
	seen := map[string]bool{}
	for i, st := range ss {
		key := strings.TrimSpace(st.Key)
		if key == "" {
			return validation(fmt.Sprintf("statuses[%d].key", i), "is required")
		}
		if seen[key] {
			return validation("statuses", "contains duplicated key "+key)
		}
		seen[key] = true
	}
	return nil
}

// statusOf 在类型的状态集里找 key。
func statusOf(t *domain.ObjectType, key string) (domain.Status, bool) {
	for _, st := range t.Statuses {
		if st.Key == key {
			return st, true
		}
	}
	return domain.Status{}, false
}

// terminalClause 拼出「状态非终态」的 SQL 条件。终态定义藏在 statuses 的 JSON 里，
// SQL 侧没法直接判断，只能先把 (type, status) 组合读出来再展开成条件。
func (s *Store) terminalClause(ctx context.Context, alias string) (string, []any, error) {
	types, err := s.ListObjectTypes(ctx)
	if err != nil {
		return "", nil, err
	}
	parts := []string{}
	args := []any{}
	for _, t := range types {
		keys := []string{}
		for _, st := range t.Statuses {
			if st.Terminal {
				keys = append(keys, st.Key)
			}
		}
		if len(keys) == 0 {
			continue
		}
		parts = append(parts, fmt.Sprintf("(%s.type_id = ? AND %s.status IN (%s))",
			alias, alias, placeholders(len(keys))))
		args = append(args, t.ID)
		args = append(args, anySlice(keys)...)
	}
	if len(parts) == 0 {
		return "1=1", nil, nil
	}
	return "NOT (" + strings.Join(parts, " OR ") + ")", args, nil
}
