// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
)

const categoryCols = `id,type_id,parent_id,name,slug,path,depth,color,description,sort_order,created_at,updated_at`

func scanCategory(sc rowScanner) (*domain.Category, error) {
	var (
		c       domain.Category
		parent  sql.NullString
		created string
		updated string
	)
	if err := sc.Scan(&c.ID, &c.TypeID, &parent, &c.Name, &c.Slug, &c.Path, &c.Depth,
		&c.Color, &c.Description, &c.SortOrder, &created, &updated); err != nil {
		return nil, err
	}
	c.ParentID = strPtr(parent)
	c.CreatedAt = parseTime(created)
	c.UpdatedAt = parseTime(updated)
	return &c, nil
}

func (s *Store) ListCategories(ctx context.Context, typeID string, withCounts bool) ([]*domain.Category, error) {
	q := `SELECT ` + categoryCols + ` FROM categories`
	args := []any{}
	if typeID != "" {
		q += ` WHERE type_id = ?`
		args = append(args, typeID)
	}
	q += ` ORDER BY type_id, path`

	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Category{}
	for rows.Next() {
		c, err := scanCategory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if withCounts {
		if err := s.fillCategoryCounts(ctx, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Store) CategoryTree(ctx context.Context, typeID string, withCounts bool) ([]*domain.Category, error) {
	flat, err := s.ListCategories(ctx, typeID, withCounts)
	if err != nil {
		return nil, err
	}
	return buildTree(flat), nil
}

// buildTree 把扁平列表按 parent_id 组装成森林，父节点缺失的（跨 type 过滤切断）当根处理。
func buildTree(flat []*domain.Category) []*domain.Category {
	byID := make(map[string]*domain.Category, len(flat))
	for _, c := range flat {
		c.Children = nil
		byID[c.ID] = c
	}
	roots := []*domain.Category{}
	for _, c := range flat {
		if c.ParentID != nil {
			if p, ok := byID[*c.ParentID]; ok {
				p.Children = append(p.Children, c)
				continue
			}
		}
		roots = append(roots, c)
	}
	var sortNodes func(ns []*domain.Category)
	sortNodes = func(ns []*domain.Category) {
		sort.SliceStable(ns, func(i, j int) bool {
			if ns[i].SortOrder != ns[j].SortOrder {
				return ns[i].SortOrder < ns[j].SortOrder
			}
			return ns[i].Name < ns[j].Name
		})
		for _, n := range ns {
			sortNodes(n.Children)
		}
	}
	sortNodes(roots)
	return roots
}

// fillCategoryCounts 一次性取回「分类 -> 直接挂载对象数」，再用物化路径在内存里累加子树，
// 避免每个节点一条递归 SQL。
func (s *Store) fillCategoryCounts(ctx context.Context, cats []*domain.Category) error {
	if len(cats) == 0 {
		return nil
	}
	// 口径要和 Counts.ByType 一致：回收站和已归档都不算，否则侧栏两处数字对不上。
	rows, err := s.db.R.QueryContext(ctx, `SELECT category_id, COUNT(*) FROM objects
		WHERE category_id IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
		GROUP BY category_id`)
	if err != nil {
		return fmt.Errorf("count objects per category: %w", err)
	}
	defer func() { _ = rows.Close() }()

	direct := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return err
		}
		direct[id] = n
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for _, c := range cats {
		c.Count = direct[c.ID]
		c.TotalCount = 0
	}
	for _, c := range cats {
		for _, d := range cats {
			if d.TypeID == c.TypeID && strings.HasPrefix(d.Path, c.Path) {
				c.TotalCount += direct[d.ID]
			}
		}
	}
	return nil
}

func (s *Store) GetCategory(ctx context.Context, id string) (*domain.Category, error) {
	return getCategory(ctx, s.db.R, id)
}

func getCategory(ctx context.Context, q queryer, id string) (*domain.Category, error) {
	row := q.QueryRowContext(ctx, `SELECT `+categoryCols+` FROM categories WHERE id = ?`, id)
	c, err := scanCategory(row)
	if noRows(err) {
		return nil, notFound("category")
	}
	if err != nil {
		return nil, fmt.Errorf("get category: %w", err)
	}
	return c, nil
}

func (s *Store) CreateCategory(ctx context.Context, c *domain.Category) (*domain.Category, error) {
	if c == nil {
		return nil, validation("category", "is required")
	}
	if strings.TrimSpace(c.Name) == "" {
		return nil, validation("name", "is required")
	}
	if _, err := s.GetObjectType(ctx, c.TypeID); err != nil {
		return nil, err
	}

	// 没显式给 slug 才从名称生成。slugify 自带随机兜底不会返回空串，所以得在调用前判空。
	slug := c.Slug
	if strings.TrimSpace(slug) == "" {
		slug = c.Name
	}
	slug = slugify(slug)

	var parentPath string
	depth := 0
	parentID := ptrArg(c.ParentID)
	if parentID != nil {
		parent, err := s.GetCategory(ctx, parentID.(string))
		if err != nil {
			return nil, err
		}
		if parent.TypeID != c.TypeID {
			return nil, validation("parent_id", "belongs to another object type")
		}
		parentPath, depth = parent.Path, parent.Depth+1
	}

	id := c.ID
	if id == "" {
		id = idgen.Prefixed("cat")
	}
	now := nowStr()
	out := &domain.Category{
		ID: id, TypeID: c.TypeID, ParentID: strPtrOrNil(parentID),
		Name: c.Name, Slug: slug, Path: normalizePath(parentPath, slug),
		Depth: depth, Color: c.Color, Description: c.Description, SortOrder: c.SortOrder,
	}

	_, err := s.db.W.ExecContext(ctx, `INSERT INTO categories (`+categoryCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		out.ID, out.TypeID, parentID, out.Name, out.Slug, out.Path, out.Depth,
		out.Color, out.Description, out.SortOrder, now, now)
	if isUnique(err) {
		return nil, conflict("category slug " + slug + " already exists under this parent")
	}
	if err != nil {
		return nil, fmt.Errorf("insert category: %w", err)
	}
	return s.GetCategory(ctx, out.ID)
}

func (s *Store) UpdateCategory(ctx context.Context, id string, p domain.CategoryPatch) (*domain.Category, error) {
	cur, err := s.GetCategory(ctx, id)
	if err != nil {
		return nil, err
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
	if p.Color != nil {
		add("color", *p.Color)
	}
	if p.Description != nil {
		add("description", *p.Description)
	}
	if p.SortOrder != nil {
		add("sort_order", *p.SortOrder)
	}

	newSlug := cur.Slug
	if p.Slug != nil {
		if strings.TrimSpace(*p.Slug) == "" {
			return nil, validation("slug", "must not be empty")
		}
		newSlug = slugify(*p.Slug)
	}
	if len(sets) == 0 && newSlug == cur.Slug {
		return cur, nil
	}

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if newSlug != cur.Slug {
			// slug 是物化路径的一段，改了就得连整棵子树的 path 一起重写。
			parentPath := parentPathOf(cur.Path, cur.Slug)
			newPath := normalizePath(parentPath, newSlug)
			add("slug", newSlug)
			add("path", newPath)
			if err := shiftSubtree(ctx, tx, cur, newPath, cur.Depth); err != nil {
				return err
			}
		}
		add("updated_at", nowStr())
		args = append(args, id)
		_, err := tx.ExecContext(ctx,
			`UPDATE categories SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
		if isUnique(err) {
			return conflict("category slug " + newSlug + " already exists under this parent")
		}
		if err != nil {
			return fmt.Errorf("update category: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetCategory(ctx, id)
}

func (s *Store) MoveCategory(ctx context.Context, id string, parentID *string, sortOrder int) (*domain.Category, error) {
	cur, err := s.GetCategory(ctx, id)
	if err != nil {
		return nil, err
	}

	var parentPath string
	newDepth := 0
	pid := ptrArg(parentID)
	if pid != nil {
		target, err := s.GetCategory(ctx, pid.(string))
		if err != nil {
			return nil, err
		}
		if target.TypeID != cur.TypeID {
			return nil, validation("parent_id", "belongs to another object type")
		}
		// 挂到自己或自己的子孙下会把这棵树从森林里切出去，直接拒绝。
		if target.ID == cur.ID || strings.HasPrefix(target.Path, cur.Path) {
			return nil, conflict("cannot move a category into its own subtree")
		}
		parentPath, newDepth = target.Path, target.Depth+1
	}
	newPath := normalizePath(parentPath, cur.Slug)

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if newPath != cur.Path {
			if err := shiftSubtree(ctx, tx, cur, newPath, newDepth); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE categories
			SET parent_id = ?, path = ?, depth = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
			pid, newPath, newDepth, sortOrder, nowStr(), id)
		if isUnique(err) {
			return conflict("category slug " + cur.Slug + " already exists under the target parent")
		}
		if err != nil {
			return fmt.Errorf("move category: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetCategory(ctx, id)
}

// shiftSubtree 把 cur 的所有子孙从旧路径前缀平移到新前缀，并同步 depth 偏移。
func shiftSubtree(ctx context.Context, tx *sql.Tx, cur *domain.Category, newPath string, newDepth int) error {
	_, err := tx.ExecContext(ctx, `UPDATE categories
		SET path = ? || SUBSTR(path, ?), depth = depth + ?, updated_at = ?
		WHERE type_id = ? AND path LIKE ? ESCAPE '\' AND id <> ?`,
		newPath, utf8.RuneCountInString(cur.Path)+1, newDepth-cur.Depth, nowStr(),
		cur.TypeID, likeEscape(cur.Path)+"%", cur.ID)
	if err != nil {
		return fmt.Errorf("shift category subtree: %w", err)
	}
	return nil
}

func (s *Store) DeleteCategory(ctx context.Context, id string, reassignTo *string) error {
	cur, err := s.GetCategory(ctx, id)
	if err != nil {
		return err
	}

	rows, err := s.db.R.QueryContext(ctx,
		`SELECT id FROM categories WHERE type_id = ? AND path LIKE ? ESCAPE '\'`,
		cur.TypeID, likeEscape(cur.Path)+"%")
	if err != nil {
		return fmt.Errorf("list category subtree: %w", err)
	}
	defer func() { _ = rows.Close() }()

	ids := []string{}
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return err
		}
		ids = append(ids, cid)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	var target any
	if t := ptrArg(reassignTo); t != nil {
		dst, err := s.GetCategory(ctx, t.(string))
		if err != nil {
			return err
		}
		for _, cid := range ids {
			if cid == dst.ID {
				return conflict("reassign target is inside the deleted subtree")
			}
		}
		target = dst.ID
	}

	return s.withTx(ctx, func(tx *sql.Tx) error {
		ph := placeholders(len(ids))
		args := append([]any{target, nowStr()}, anySlice(ids)...)
		if _, err := tx.ExecContext(ctx,
			`UPDATE objects SET category_id = ?, updated_at = ?
			 WHERE category_id IN (`+ph+`)`, args...); err != nil {
			return fmt.Errorf("reassign objects: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM categories WHERE id IN (`+ph+`)`, anySlice(ids)...); err != nil {
			return fmt.Errorf("delete categories: %w", err)
		}
		return nil
	})
}

// --- 路径与 slug ---

func normalizePath(parentPath, slug string) string {
	if parentPath == "" {
		return "/" + slug + "/"
	}
	return parentPath + slug + "/"
}

// parentPathOf 从 '/a/b/' 和 slug 'b' 还原出父路径 '/a/'。
func parentPathOf(path, slug string) string {
	return strings.TrimSuffix(path, slug+"/")
}

// slugify 把名称压成一段 path 片段。中文原样保留：path 只用于内部 LIKE 前缀匹配，
// SQLite 存 UTF-8 毫无障碍，为了 ASCII 化去引拼音依赖不划算。
// 只清掉两类字符：会切断物化路径分段的分隔符，和会污染 TEXT 的控制字符。
func slugify(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r == '/' || r == '\\' || r == '-' || unicode.IsSpace(r):
			// 分隔符与空白统一收敛成单个连字符。
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		case unicode.IsControl(r):
			// 丢弃
		default:
			b.WriteRune(r)
			prevDash = false
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return idgen.New()[:8]
	}
	return out
}

func strPtrOrNil(v any) *string {
	if v == nil {
		return nil
	}
	s := v.(string)
	return &s
}
