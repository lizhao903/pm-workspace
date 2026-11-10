// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// sortBase 是排序号的起点。用 1 基是因为 0 被留作「未指定」的哨兵值：
// CreateShortcut 看到 0 才知道该自己算位置。
const sortBase = 1

// --- 分组 ---

const shortcutGroupCols = `id, name, color, collapsed, sort_order, created_at, updated_at`

func (s *Store) ListShortcutGroups(ctx context.Context) ([]*domain.ShortcutGroup, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+shortcutGroupCols+` FROM shortcut_groups ORDER BY sort_order, name`)
	if err != nil {
		return nil, fmt.Errorf("list shortcut groups: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.ShortcutGroup{}
	for rows.Next() {
		g, err := scanShortcutGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) CreateShortcutGroup(ctx context.Context, g *domain.ShortcutGroup) (*domain.ShortcutGroup, error) {
	if g == nil {
		return nil, validation("shortcut group", "is required")
	}
	name := strings.TrimSpace(g.Name)
	if name == "" {
		return nil, validation("name", "is required")
	}

	id := idgen.Prefixed("sgr")
	now := nowStr()
	order := g.SortOrder

	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if order == 0 {
			// 未指定就排到末尾，否则新建的组全挤在 0 上，顺序由名字决定不稳定。
			if err := tx.QueryRowContext(ctx,
				`SELECT IFNULL(MAX(sort_order),0)+? FROM shortcut_groups`, sortBase).Scan(&order); err != nil {
				return fmt.Errorf("next shortcut group sort_order: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO shortcut_groups (`+shortcutGroupCols+`) VALUES (?,?,?,?,?,?,?)`,
			id, name, g.Color, boolInt(g.Collapsed), order, now, now); err != nil {
			return fmt.Errorf("insert shortcut group: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &domain.ShortcutGroup{
		ID: id, Name: name, Color: g.Color, Collapsed: g.Collapsed, SortOrder: order,
		CreatedAt: parseTime(now), UpdatedAt: parseTime(now),
	}, nil
}

func (s *Store) UpdateShortcutGroup(ctx context.Context, id string, p domain.ShortcutGroupPatch) (*domain.ShortcutGroup, error) {
	var out *domain.ShortcutGroup
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := getShortcutGroupTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if p.Name != nil {
			name := strings.TrimSpace(*p.Name)
			if name == "" {
				return validation("name", "is required")
			}
			g.Name = name
		}
		if p.Color != nil {
			g.Color = *p.Color
		}
		if p.Collapsed != nil {
			g.Collapsed = *p.Collapsed
		}
		if p.SortOrder != nil {
			g.SortOrder = *p.SortOrder
		}

		now := nowStr()
		if _, err := tx.ExecContext(ctx,
			`UPDATE shortcut_groups SET name=?, color=?, collapsed=?, sort_order=?, updated_at=? WHERE id=?`,
			g.Name, g.Color, boolInt(g.Collapsed), g.SortOrder, now, id); err != nil {
			return fmt.Errorf("update shortcut group: %w", err)
		}
		g.UpdatedAt = parseTime(now)
		out = g
		return nil
	})
	return out, err
}

// DeleteShortcutGroup 只删组。组内条目由迁移里的 ON DELETE SET NULL 降级为未分组，
// 不在这里手工处理（dsn 每条连接都带 foreign_keys(ON)）。
func (s *Store) DeleteShortcutGroup(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := getShortcutGroupTx(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM shortcut_groups WHERE id=?`, id); err != nil {
			return fmt.Errorf("delete shortcut group: %w", err)
		}
		return nil
	})
}

func getShortcutGroupTx(ctx context.Context, tx *sql.Tx, id string) (*domain.ShortcutGroup, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+shortcutGroupCols+` FROM shortcut_groups WHERE id=?`, id)
	g, err := scanShortcutGroup(row)
	if noRows(err) {
		return nil, notFound("shortcut group")
	}
	if err != nil {
		return nil, fmt.Errorf("get shortcut group: %w", err)
	}
	return g, nil
}

func scanShortcutGroup(sc rowScanner) (*domain.ShortcutGroup, error) {
	var g domain.ShortcutGroup
	var collapsed int
	var created, updated string
	if err := sc.Scan(&g.ID, &g.Name, &g.Color, &collapsed, &g.SortOrder, &created, &updated); err != nil {
		return nil, err
	}
	g.Collapsed = collapsed != 0
	g.CreatedAt, g.UpdatedAt = parseTime(created), parseTime(updated)
	return &g, nil
}

// --- 条目 ---

const shortcutCols = `id, group_id, label, target_kind, url, nav, command, icon, color,
	description, open_in, pinned, sort_order, last_used_at, use_count, created_at, updated_at`

func (s *Store) ListShortcuts(ctx context.Context) ([]*domain.Shortcut, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+shortcutCols+` FROM shortcuts ORDER BY sort_order, label`)
	if err != nil {
		return nil, fmt.Errorf("list shortcuts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Shortcut{}
	for rows.Next() {
		sc, err := scanShortcut(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

func (s *Store) GetShortcut(ctx context.Context, id string) (*domain.Shortcut, error) {
	row := s.db.R.QueryRowContext(ctx, `SELECT `+shortcutCols+` FROM shortcuts WHERE id=?`, id)
	sc, err := scanShortcut(row)
	if noRows(err) {
		return nil, notFound("shortcut")
	}
	if err != nil {
		return nil, fmt.Errorf("get shortcut: %w", err)
	}
	return sc, nil
}

func (s *Store) CreateShortcut(ctx context.Context, in *domain.Shortcut) (*domain.Shortcut, error) {
	if in == nil {
		return nil, validation("shortcut", "is required")
	}
	sc := *in
	if err := normalizeShortcut(&sc); err != nil {
		return nil, err
	}
	sc.ID = idgen.Prefixed("sct")
	now := nowStr()

	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if sc.GroupID != nil {
			if _, err := getShortcutGroupTx(ctx, tx, *sc.GroupID); err != nil {
				return err
			}
		}
		if sc.SortOrder == 0 {
			// 未指定就排到该组末尾。各组独立计数，未分组区算一组。
			if err := tx.QueryRowContext(ctx,
				`SELECT IFNULL(MAX(sort_order),0)+? FROM shortcuts WHERE IFNULL(group_id,'')=?`,
				sortBase, groupKey(sc.GroupID)).Scan(&sc.SortOrder); err != nil {
				return fmt.Errorf("next shortcut sort_order: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO shortcuts (`+shortcutCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			sc.ID, ptrArg(sc.GroupID), sc.Label, sc.TargetKind, sc.URL, sc.Nav, sc.Command,
			sc.Icon, sc.Color, sc.Description, sc.OpenIn, boolInt(sc.Pinned), sc.SortOrder,
			nil, 0, now, now); err != nil {
			return fmt.Errorf("insert shortcut: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// 使用计数只能靠 VisitShortcut 累加，不接受创建时带进来。
	sc.UseCount, sc.LastUsedAt = 0, nil
	sc.CreatedAt, sc.UpdatedAt = parseTime(now), parseTime(now)
	return &sc, nil
}

func (s *Store) UpdateShortcut(ctx context.Context, id string, p domain.ShortcutPatch) (*domain.Shortcut, error) {
	var out *domain.Shortcut
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `SELECT `+shortcutCols+` FROM shortcuts WHERE id=?`, id)
		cur, err := scanShortcut(row)
		if noRows(err) {
			return notFound("shortcut")
		}
		if err != nil {
			return fmt.Errorf("get shortcut: %w", err)
		}

		// 先把 patch 合进当前状态再整体校验：改 target_kind 而没带 url 这类
		// 跨字段问题，只看 patch 本身是看不出来的。
		if p.GroupID != nil {
			cur.GroupID = *p.GroupID
		}
		applyStr(p.Label, &cur.Label)
		applyStr(p.TargetKind, &cur.TargetKind)
		applyStr(p.URL, &cur.URL)
		applyStr(p.Nav, &cur.Nav)
		applyStr(p.Command, &cur.Command)
		applyStr(p.Icon, &cur.Icon)
		applyStr(p.Color, &cur.Color)
		applyStr(p.Description, &cur.Description)
		applyStr(p.OpenIn, &cur.OpenIn)
		if p.Pinned != nil {
			cur.Pinned = *p.Pinned
		}
		if p.SortOrder != nil {
			cur.SortOrder = *p.SortOrder
		}
		if err := normalizeShortcut(cur); err != nil {
			return err
		}
		if cur.GroupID != nil {
			if _, err := getShortcutGroupTx(ctx, tx, *cur.GroupID); err != nil {
				return err
			}
		}

		now := nowStr()
		if _, err := tx.ExecContext(ctx,
			`UPDATE shortcuts SET group_id=?, label=?, target_kind=?, url=?, nav=?, command=?,
			 icon=?, color=?, description=?, open_in=?, pinned=?, sort_order=?, updated_at=?
			 WHERE id=?`,
			ptrArg(cur.GroupID), cur.Label, cur.TargetKind, cur.URL, cur.Nav, cur.Command,
			cur.Icon, cur.Color, cur.Description, cur.OpenIn, boolInt(cur.Pinned), cur.SortOrder,
			now, id); err != nil {
			return fmt.Errorf("update shortcut: %w", err)
		}
		cur.UpdatedAt = parseTime(now)
		out = cur
		return nil
	})
	return out, err
}

func (s *Store) DeleteShortcut(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM shortcuts WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete shortcut: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound("shortcut")
	}
	return nil
}

// VisitShortcut 记一次使用。不动 updated_at：点击是使用不是修改，
// 否则「最近修改」会被日常点击刷屏。
func (s *Store) VisitShortcut(ctx context.Context, id string) (*domain.Shortcut, error) {
	row := s.db.W.QueryRowContext(ctx,
		`UPDATE shortcuts SET use_count = use_count + 1, last_used_at = ?
		 WHERE id = ? RETURNING `+shortcutCols, nowStr(), id)
	sc, err := scanShortcut(row)
	if noRows(err) {
		return nil, notFound("shortcut")
	}
	if err != nil {
		return nil, fmt.Errorf("visit shortcut: %w", err)
	}
	return sc, nil
}

// ReorderShortcuts 按 ids 的下标重写组内排序号。ids 必须是该组的全量条目：
// 少传会让没列出的条目留在旧位置，拖拽结果就和界面对不上。
// 排序号用下标+1，避开 0（CreateShortcut 把 0 当作「未指定」）。
func (s *Store) ReorderShortcuts(ctx context.Context, groupID *string, ids []string) error {
	if len(ids) == 0 {
		return validation("ids", "is required")
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" {
			return validation("ids", "must not contain empty values")
		}
		if seen[id] {
			return validation("ids", "must not contain duplicated entries")
		}
		seen[id] = true
	}

	return s.withTx(ctx, func(tx *sql.Tx) error {
		// 整组重排必须原子：中途失败会留下半套顺序，所以先校验再写。
		current, err := shortcutIDsInGroupTx(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if len(ids) != len(current) {
			return validation("ids", fmt.Sprintf("must list all %d shortcuts of the group, got %d",
				len(current), len(ids)))
		}
		for _, id := range ids {
			if !current[id] {
				return validation("ids", "contains a shortcut outside the target group")
			}
		}

		now := nowStr()
		for i, id := range ids {
			if _, err := tx.ExecContext(ctx,
				`UPDATE shortcuts SET sort_order=?, updated_at=? WHERE id=?`,
				i+1, now, id); err != nil {
				return fmt.Errorf("reorder shortcuts: %w", err)
			}
		}
		return nil
	})
}

func shortcutIDsInGroupTx(ctx context.Context, tx *sql.Tx, groupID *string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM shortcuts WHERE IFNULL(group_id,'')=?`, groupKey(groupID))
	if err != nil {
		return nil, fmt.Errorf("list group shortcuts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func scanShortcut(sc rowScanner) (*domain.Shortcut, error) {
	var out domain.Shortcut
	var groupID, lastUsed sql.NullString
	var pinned int
	var created, updated string
	if err := sc.Scan(&out.ID, &groupID, &out.Label, &out.TargetKind, &out.URL, &out.Nav,
		&out.Command, &out.Icon, &out.Color, &out.Description, &out.OpenIn, &pinned,
		&out.SortOrder, &lastUsed, &out.UseCount, &created, &updated); err != nil {
		return nil, err
	}
	out.GroupID = strPtr(groupID)
	out.Pinned = pinned != 0
	out.LastUsedAt = parseNullTime(lastUsed)
	out.CreatedAt, out.UpdatedAt = parseTime(created), parseTime(updated)
	return &out, nil
}

// --- 校验 ---

var shortcutKinds = map[string]bool{
	domain.ShortcutURL: true, domain.ShortcutInternal: true, domain.ShortcutCommand: true,
}

var shortcutOpenIn = map[string]bool{"new_tab": true, "same_tab": true}

// shortcutSchemes 是 URL 协议白名单。即便是本地单人工具也不给自己留 XSS 面：
// javascript: / data: / vbscript: 会让一条快捷入口变成点一下就执行的脚本。
var shortcutSchemes = map[string]bool{"http": true, "https": true, "file": true}

// normalizeShortcut 归一化并校验一条完整的快捷入口，创建与更新共用。
func normalizeShortcut(sc *domain.Shortcut) error {
	sc.Label = strings.TrimSpace(sc.Label)
	if sc.Label == "" {
		return validation("label", "is required")
	}

	sc.TargetKind = strings.ToLower(strings.TrimSpace(sc.TargetKind))
	if sc.TargetKind == "" {
		sc.TargetKind = domain.ShortcutURL
	}
	if !shortcutKinds[sc.TargetKind] {
		return validation("target_kind", "must be one of url, internal, command")
	}

	sc.OpenIn = strings.ToLower(strings.TrimSpace(sc.OpenIn))
	if sc.OpenIn == "" {
		sc.OpenIn = "new_tab"
	}
	if !shortcutOpenIn[sc.OpenIn] {
		return validation("open_in", "must be new_tab or same_tab")
	}

	sc.URL = strings.TrimSpace(sc.URL)
	sc.Command = strings.TrimSpace(sc.Command)
	nav, navEmpty, err := normalizeNav(sc.Nav)
	if err != nil {
		return err
	}
	sc.Nav = nav

	// 三种目标类型各自的必填项对称校验：任一留空都会造出一条点了没反应的死入口。
	switch sc.TargetKind {
	case domain.ShortcutURL:
		if err := validateShortcutURL(sc.URL); err != nil {
			return err
		}
	case domain.ShortcutInternal:
		if navEmpty {
			return validation("nav", "is required when target_kind is internal")
		}
	case domain.ShortcutCommand:
		if sc.Command == "" {
			return validation("command", "is required when target_kind is command")
		}
	}

	// 空串当作未分组：外键不接受空串。
	if sc.GroupID != nil && strings.TrimSpace(*sc.GroupID) == "" {
		sc.GroupID = nil
	}
	return nil
}

func validateShortcutURL(raw string) error {
	if raw == "" {
		return validation("url", "is required when target_kind is url")
	}
	scheme := urlScheme(raw)
	if scheme == "" {
		return validation("url", "must be absolute and start with a scheme")
	}
	if !shortcutSchemes[scheme] {
		return validation("url", "scheme is not allowed: "+scheme)
	}
	return nil
}

// urlScheme 手工取 scheme，不走 url.Parse：URL 里要允许 {{title}} 这类变量占位符，
// 标准库遇到花括号的行为不可靠。这里按 RFC 3986 只认「冒号前是一段合法 scheme」：
// 首字符为字母，其后为字母/数字/+/-/。取不到就返回空串，由调用方拒掉。
func urlScheme(raw string) string {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c == ':':
			if i == 0 {
				return ""
			}
			return strings.ToLower(raw[:i])
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			// scheme 的合法字符，继续往后看
		case c >= '0' && c <= '9', c == '+', c == '-', c == '.':
			if i == 0 {
				return "" // scheme 必须字母开头
			}
		default:
			return "" // 冒号之前出现了别的字符，说明压根没有 scheme
		}
	}
	return ""
}

// normalizeNav 只保证 nav 是个 JSON 对象，里面的业务语义（视图、筛选条件）由前端负责。
// 第二个返回值说明这个对象是不是空的：internal 类型不接受空 nav，否则跳转没有目标。
func normalizeNav(nav string) (string, bool, error) {
	nav = strings.TrimSpace(nav)
	if nav == "" {
		return "{}", true, nil
	}
	var probe any
	if err := json.Unmarshal([]byte(nav), &probe); err != nil {
		return "", false, validation("nav", "must be valid JSON")
	}
	obj, ok := probe.(map[string]any)
	if !ok {
		return "", false, validation("nav", "must be a JSON object")
	}
	return nav, len(obj) == 0, nil
}

// --- 小工具 ---

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// groupKey 把可空分组 ID 折成用于 IFNULL(group_id,”) 比较的键，未分组即空串。
func groupKey(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func applyStr(src *string, dst *string) {
	if src != nil {
		*dst = *src
	}
}
