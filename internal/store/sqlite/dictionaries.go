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

// dictSortStep 是字典条目排序号的步长。留出间隔是为了让「插到两条之间」
// 不必整体重排，直接给一个中间值即可。
const dictSortStep = 10

const dictCols = `id, name, description, scope, builtin, sort_order, created_at, updated_at`

const dictItemCols = `id, dict_id, type_id, key, label, color, description,
	sort_order, meta, archived_at, created_at, updated_at`

// --- 字典 ---

// ListDictionaries 返回全部字典。withItems=true 时一并带上未停用的条目，
// 条目的引用数按字典批量统计，不是每条一次 COUNT。
func (s *Store) ListDictionaries(ctx context.Context, withItems bool) ([]*domain.Dictionary, error) {
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT `+dictCols+` FROM dictionaries ORDER BY sort_order, id`)
	if err != nil {
		return nil, fmt.Errorf("list dictionaries: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Dictionary{}
	for rows.Next() {
		d, err := scanDictionary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !withItems {
		return out, nil
	}

	for _, d := range out {
		items, err := s.ListDictItems(ctx, d.ID, nil, false)
		if err != nil {
			return nil, err
		}
		d.Items = items
	}
	return out, nil
}

func (s *Store) getDictionary(ctx context.Context, id string) (*domain.Dictionary, error) {
	row := s.db.R.QueryRowContext(ctx, `SELECT `+dictCols+` FROM dictionaries WHERE id=?`, id)
	d, err := scanDictionary(row)
	if noRows(err) {
		return nil, notFound("dictionary")
	}
	if err != nil {
		return nil, fmt.Errorf("get dictionary: %w", err)
	}
	return d, nil
}

func getDictionaryTx(ctx context.Context, tx *sql.Tx, id string) (*domain.Dictionary, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+dictCols+` FROM dictionaries WHERE id=?`, id)
	d, err := scanDictionary(row)
	if noRows(err) {
		return nil, notFound("dictionary")
	}
	if err != nil {
		return nil, fmt.Errorf("get dictionary: %w", err)
	}
	return d, nil
}

func scanDictionary(sc rowScanner) (*domain.Dictionary, error) {
	var d domain.Dictionary
	var builtin int
	var created, updated string
	if err := sc.Scan(&d.ID, &d.Name, &d.Description, &d.Scope, &builtin,
		&d.SortOrder, &created, &updated); err != nil {
		return nil, err
	}
	d.Builtin = builtin != 0
	d.CreatedAt, d.UpdatedAt = parseTime(created), parseTime(updated)
	return &d, nil
}

// --- 条目 ---

// ListDictItems 按 sort_order 返回条目。
// typeID 为 nil 表示不按类型过滤（global 字典的条目 type_id 本就全是 NULL）；
// includeArchived=false 时排除已停用的条目——停用的值在历史数据上照常显示，
// 但不该再出现在新建/编辑的下拉里。
func (s *Store) ListDictItems(ctx context.Context, dictID string, typeID *string, includeArchived bool) ([]*domain.DictItem, error) {
	if _, err := s.getDictionary(ctx, dictID); err != nil {
		return nil, err
	}

	q := `SELECT ` + dictItemCols + ` FROM dict_items WHERE dict_id=?`
	args := []any{dictID}
	if typeID != nil {
		q += ` AND IFNULL(type_id,'')=?`
		args = append(args, *typeID)
	}
	if !includeArchived {
		q += ` AND archived_at IS NULL`
	}
	q += ` ORDER BY sort_order, key`

	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list dict items: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.DictItem{}
	for rows.Next() {
		it, err := scanDictItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	usage, err := s.dictUsageByKey(ctx, dictID)
	if err != nil {
		return nil, err
	}
	for _, it := range out {
		it.Usage = usage[it.Key]
	}
	return out, nil
}

func (s *Store) getDictItem(ctx context.Context, id string) (*domain.DictItem, error) {
	row := s.db.R.QueryRowContext(ctx, `SELECT `+dictItemCols+` FROM dict_items WHERE id=?`, id)
	it, err := scanDictItem(row)
	if noRows(err) {
		return nil, notFound("dict item")
	}
	if err != nil {
		return nil, fmt.Errorf("get dict item: %w", err)
	}
	return it, nil
}

func getDictItemTx(ctx context.Context, tx *sql.Tx, id string) (*domain.DictItem, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+dictItemCols+` FROM dict_items WHERE id=?`, id)
	it, err := scanDictItem(row)
	if noRows(err) {
		return nil, notFound("dict item")
	}
	if err != nil {
		return nil, fmt.Errorf("get dict item: %w", err)
	}
	return it, nil
}

func (s *Store) CreateDictItem(ctx context.Context, in *domain.DictItem) (*domain.DictItem, error) {
	if in == nil {
		return nil, validation("dict item", "is required")
	}
	it := *in
	it.Key = strings.TrimSpace(it.Key)
	it.Label = strings.TrimSpace(it.Label)
	if it.Key == "" {
		return nil, validation("key", "is required")
	}
	if it.Label == "" {
		return nil, validation("label", "is required")
	}
	if it.TypeID != nil && strings.TrimSpace(*it.TypeID) == "" {
		it.TypeID = nil // 外键不接受空串，空串一律当作「没有类型」
	}

	metaJSON, err := encodeDictMeta(it.Meta)
	if err != nil {
		return nil, err
	}
	it.ID = idgen.Prefixed("dit")
	it.ArchivedAt = nil // 新建的条目一定是启用状态，不接受创建时就带停用时间
	now := nowStr()

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		d, err := getDictionaryTx(ctx, tx, it.DictID)
		if err != nil {
			return err
		}
		if err := checkDictScope(d, it.TypeID); err != nil {
			return err
		}
		if it.TypeID != nil {
			// 让越界的 type_id 报成「类型不存在」，而不是一条外键约束的原始错误。
			var n int
			if err := tx.QueryRowContext(ctx,
				`SELECT COUNT(*) FROM object_types WHERE id=?`, *it.TypeID).Scan(&n); err != nil {
				return fmt.Errorf("check object type: %w", err)
			}
			if n == 0 {
				return notFound("object type")
			}
		}
		if it.SortOrder == 0 {
			// 未指定就排到末尾。0 是「未指定」的哨兵值，重排时写的也都是 step 的倍数，不会撞上。
			if err := tx.QueryRowContext(ctx,
				`SELECT IFNULL(MAX(sort_order),0)+? FROM dict_items WHERE dict_id=? AND IFNULL(type_id,'')=?`,
				dictSortStep, it.DictID, dictTypeKey(it.TypeID)).Scan(&it.SortOrder); err != nil {
				return fmt.Errorf("next dict item sort_order: %w", err)
			}
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO dict_items (`+dictItemCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			it.ID, it.DictID, ptrArg(it.TypeID), it.Key, it.Label, it.Color, it.Description,
			it.SortOrder, metaJSON, nil, now, now)
		if isUnique(err) {
			return conflict("dict item key already exists in this dictionary: " + it.Key)
		}
		if err != nil {
			return fmt.Errorf("insert dict item: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	it.Meta = decodeDictMeta(metaJSON)
	it.CreatedAt, it.UpdatedAt = parseTime(now), parseTime(now)
	// 引用数未必是 0：一个刚被删掉又重新加回来的 key，业务表里可能还留着旧值。
	if err := s.fillDictItemUsage(ctx, &it); err != nil {
		return nil, err
	}
	return &it, nil
}

// UpdateDictItem 只改展示属性。UPDATE 语句里压根没有 key 列——
// 枚举值已经落在 objects.priority / links.relation 里，改掉就会让那些行变成悬空值。
func (s *Store) UpdateDictItem(ctx context.Context, id string, p domain.DictItemPatch) (*domain.DictItem, error) {
	var out *domain.DictItem
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getDictItemTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if p.Label != nil {
			label := strings.TrimSpace(*p.Label)
			if label == "" {
				return validation("label", "is required")
			}
			cur.Label = label
		}
		applyStr(p.Color, &cur.Color)
		applyStr(p.Description, &cur.Description)
		if p.SortOrder != nil {
			cur.SortOrder = *p.SortOrder
		}
		if p.Meta != nil {
			cur.Meta = *p.Meta
		}
		metaJSON, err := encodeDictMeta(cur.Meta)
		if err != nil {
			return err
		}

		now := nowStr()
		if _, err := tx.ExecContext(ctx,
			`UPDATE dict_items SET label=?, color=?, description=?, sort_order=?, meta=?, updated_at=?
			 WHERE id=?`,
			cur.Label, cur.Color, cur.Description, cur.SortOrder, metaJSON, now, id); err != nil {
			return fmt.Errorf("update dict item: %w", err)
		}
		cur.Meta = decodeDictMeta(metaJSON)
		cur.UpdatedAt = parseTime(now)
		out = cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := s.fillDictItemUsage(ctx, out); err != nil {
		return nil, err
	}
	return out, nil
}

// ArchiveDictItem 停用/启用，只动 archived_at。停用不是删除：
// 已经引用了这个值的历史数据照常显示，只是新建时的下拉里不再出现。
func (s *Store) ArchiveDictItem(ctx context.Context, id string, archived bool) (*domain.DictItem, error) {
	var out *domain.DictItem
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		cur, err := getDictItemTx(ctx, tx, id)
		if err != nil {
			return err
		}
		now := nowStr()
		var archivedAt any
		if archived {
			archivedAt = now
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE dict_items SET archived_at=?, updated_at=? WHERE id=?`,
			archivedAt, now, id); err != nil {
			return fmt.Errorf("archive dict item: %w", err)
		}
		if archived {
			t := parseTime(now)
			cur.ArchivedAt = &t
		} else {
			cur.ArchivedAt = nil
		}
		cur.UpdatedAt = parseTime(now)
		out = cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := s.fillDictItemUsage(ctx, out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteDictItem 只在引用数为 0 时放行。有引用还删，业务表里就会留下
// 一个没有标签没有颜色的裸值，谁也说不清它是什么——那种情况只能用停用。
func (s *Store) DeleteDictItem(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		it, err := getDictItemTx(ctx, tx, id)
		if err != nil {
			return err
		}
		n, noun, err := dictUsageTx(ctx, tx, it.DictID, it.Key)
		if err != nil {
			return err
		}
		if n > 0 {
			// 数量要进 message：界面据此提示「改用停用」时得说清影响面有多大。
			return conflict(fmt.Sprintf("%s value is used by %d %s", it.DictID, n, plural(noun, n)))
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM dict_items WHERE id=?`, id); err != nil {
			return fmt.Errorf("delete dict item: %w", err)
		}
		return nil
	})
}

func (s *Store) DictItemUsage(ctx context.Context, id string) (int, error) {
	it, err := s.getDictItem(ctx, id)
	if err != nil {
		return 0, err
	}
	src, ok := dictUsageSourceOf(it.DictID)
	if !ok {
		return 0, nil
	}
	// 按表里有没有新列选统计语句（插件新迁移没跑时用旧口径），同 dictUsageTx
	src, live, err := src.ready(ctx, s.db.R)
	if err != nil || !live {
		return 0, err
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx, src.countOne, it.Key).Scan(&n); err != nil {
		return 0, fmt.Errorf("count dict item usage: %w", err)
	}
	return n, nil
}

// ReorderDictItems 传该字典（该类型下）的全量有序 ID 列表，按下标重写 sort_order。
// 少传会让没列出的条目留在旧位置，拖拽结果就和界面对不上，所以要求全量。
// typeID 为 nil 指的是 type_id 为空的那一批（global 字典的全部条目都在这里）。
func (s *Store) ReorderDictItems(ctx context.Context, dictID string, typeID *string, ids []string) error {
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
		if _, err := getDictionaryTx(ctx, tx, dictID); err != nil {
			return err
		}
		// 整批重排必须原子：中途失败会留下半套顺序，所以先校验齐了再写。
		current, err := dictItemIDsTx(ctx, tx, dictID, typeID)
		if err != nil {
			return err
		}
		if len(ids) != len(current) {
			return validation("ids", fmt.Sprintf("must list all %d items of the dictionary, got %d",
				len(current), len(ids)))
		}
		for _, id := range ids {
			if !current[id] {
				return validation("ids", "contains an item outside the target dictionary")
			}
		}

		now := nowStr()
		for i, id := range ids {
			if _, err := tx.ExecContext(ctx,
				`UPDATE dict_items SET sort_order=?, updated_at=? WHERE id=?`,
				(i+1)*dictSortStep, now, id); err != nil {
				return fmt.Errorf("reorder dict items: %w", err)
			}
		}
		return nil
	})
}

// 重排要连停用的条目一起算：它们在设置页里是可见的，漏掉就会让全量校验总是失败。
func dictItemIDsTx(ctx context.Context, tx *sql.Tx, dictID string, typeID *string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx,
		`SELECT id FROM dict_items WHERE dict_id=? AND IFNULL(type_id,'')=?`,
		dictID, dictTypeKey(typeID))
	if err != nil {
		return nil, fmt.Errorf("list dict items: %w", err)
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

func scanDictItem(sc rowScanner) (*domain.DictItem, error) {
	var it domain.DictItem
	var typeID, archived sql.NullString
	var meta, created, updated string
	if err := sc.Scan(&it.ID, &it.DictID, &typeID, &it.Key, &it.Label, &it.Color,
		&it.Description, &it.SortOrder, &meta, &archived, &created, &updated); err != nil {
		return nil, err
	}
	it.TypeID = strPtr(typeID)
	it.Meta = decodeDictMeta(meta)
	it.ArchivedAt = parseNullTime(archived)
	it.CreatedAt, it.UpdatedAt = parseTime(created), parseTime(updated)
	return &it, nil
}

// --- 引用计数 ---

// dictUsageSource 说明一个字典的枚举值落在哪张业务表的哪一列。
//
// 新增字典时在 dictUsageSourceOf 里加一个 case；没登记的字典引用数一律为 0，
// 不报错——新字典还没接入任何业务表是正常状态，不该把设置页打挂。
// 目前内置字典都是 global scope，所以统计不带 type_id 条件；
// 将来接 type-scoped 字典时，这里要按 type 再切一刀。
type dictUsageSource struct {
	noun     string // 计数单位，进 409 的 message
	countOne string // 统计单个 key，参数为 key
	countAll string // 一次统计整个字典，返回 (key, n)
	// table 非空表示业务表属于插件，插件没装时表不存在，引用数按 0 算
	table string
	// column 非空时表里要有这一列才用 countOne / countAll，没有（插件新版本的迁移还没跑）时用 oldOne / oldAll
	column, oldOne, oldAll string
}

// ready 报告业务表在不在，并按表里有没有 column 选用统计语句。
func (src dictUsageSource) ready(ctx context.Context, q rowQueryer) (dictUsageSource, bool, error) {
	live, err := src.present(ctx, q)
	if err != nil || !live || src.column == "" {
		return src, live, err
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, src.table, src.column).Scan(&n); err != nil {
		return src, false, fmt.Errorf("check usage column: %w", err)
	}
	if n == 0 {
		src.countOne, src.countAll = src.oldOne, src.oldAll
	}
	return src, true, nil
}

type rowQueryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// present 报告业务表在不在；内核自己的表恒在。
func (src dictUsageSource) present(ctx context.Context, q rowQueryer) (bool, error) {
	if src.table == "" {
		return true, nil
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, src.table).Scan(&n); err != nil {
		return false, fmt.Errorf("check usage table: %w", err)
	}
	return n > 0, nil
}

// projectRoleExpr 同 projects 插件的 roleExpr：role_key 非空用它，空用 role。
const projectRoleExpr = `CASE WHEN role_key <> '' THEN role_key ELSE role END`

// msgStatusExpr 同 im 插件的 statusCol：待处理且标了过期的算 expired。
const msgStatusExpr = `CASE WHEN status = 'pending' AND expired_at IS NOT NULL THEN 'expired' ELSE status END`

// contactGroupSplit 把 stakeholders.contact_group 拆成 (id, part)：多个分组用「、」连，
// 也认逗号、斜杠、分号（同前端 contacts/model.ts 的 groupsOf）；没填的算「其他」。
const contactGroupSplit = `WITH RECURSIVE g(id, rest) AS (
  SELECT id, CASE WHEN trim(contact_group) = '' THEN '其他' ELSE
    replace(replace(replace(replace(replace(replace(contact_group, ',', '、'), '，', '、'), '/', '、'), '／', '、'), ';', '、'), '；', '、') END || '、'
  FROM stakeholders
), parts(id, part, rest) AS (
  SELECT id, NULL, rest FROM g
  UNION ALL
  SELECT id, trim(substr(rest, 1, instr(rest, '、') - 1)), substr(rest, instr(rest, '、') + 1) FROM parts WHERE rest <> ''
)
`

func dictUsageSourceOf(dictID string) (dictUsageSource, bool) {
	switch dictID {
	case domain.DictPriority:
		return dictUsageSource{
			noun:     "objects",
			countOne: `SELECT COUNT(*) FROM objects WHERE priority = ? AND deleted_at IS NULL`,
			countAll: `SELECT priority, COUNT(*) FROM objects WHERE deleted_at IS NULL GROUP BY priority`,
		}, true
	case domain.DictLinkRelation:
		return dictUsageSource{
			noun:     "links",
			countOne: `SELECT COUNT(*) FROM links WHERE relation = ?`,
			countAll: `SELECT relation, COUNT(*) FROM links GROUP BY relation`,
		}, true
	case domain.DictArtifactPlatform:
		return dictUsageSource{
			noun:     "artifacts",
			countOne: `SELECT COUNT(*) FROM artifacts WHERE platform = ?`,
			countAll: `SELECT platform, COUNT(*) FROM artifacts GROUP BY platform`,
		}, true
	case domain.DictArtifactKind:
		return dictUsageSource{
			noun:     "artifacts",
			countOne: `SELECT COUNT(*) FROM artifacts WHERE kind = ?`,
			countAll: `SELECT kind, COUNT(*) FROM artifacts GROUP BY kind`,
		}, true
	case domain.DictContactGroup:
		// 一个联系人可以在几个组里，各算一次；含已归档的，它们的分组值还在
		return dictUsageSource{
			noun:     "contacts",
			countOne: contactGroupSplit + `SELECT COUNT(DISTINCT id) FROM parts WHERE part = ?`,
			countAll: contactGroupSplit + `SELECT part, COUNT(DISTINCT id) FROM parts WHERE part <> '' GROUP BY part`,
		}, true
	case domain.DictMsgStatus:
		// 已过期（im 0005，IM-07）在库里是待处理加 expired_at，按接口上的状态算
		return dictUsageSource{
			noun:     "messages",
			countOne: `SELECT COUNT(*) FROM im_messages WHERE ` + msgStatusExpr + ` = ?`,
			countAll: `SELECT ` + msgStatusExpr + ` AS s, COUNT(*) FROM im_messages GROUP BY s`,
			table:    "im_messages",
			column:   "expired_at",
			oldOne:   `SELECT COUNT(*) FROM im_messages WHERE status = ?`,
			oldAll:   `SELECT status, COUNT(*) FROM im_messages GROUP BY status`,
		}, true
	case domain.DictProjectRole:
		// 项目插件的表，插件没装时按 0 算；软删项目的干系人还在，也算（TSK-0718）。
		// 插件迁移 0011 起实际角色在 role_key（空时用 role，见 projects 插件 roleExpr）；0011 还没跑时只有 role
		return dictUsageSource{
			noun:     "project stakeholders",
			countOne: `SELECT COUNT(*) FROM projects_stakeholders WHERE ` + projectRoleExpr + ` = ?`,
			countAll: `SELECT ` + projectRoleExpr + ` AS r, COUNT(*) FROM projects_stakeholders GROUP BY r`,
			table:    "projects_stakeholders",
			column:   "role_key",
			oldOne:   `SELECT COUNT(*) FROM projects_stakeholders WHERE role = ?`,
			oldAll:   `SELECT role, COUNT(*) FROM projects_stakeholders GROUP BY role`,
		}, true
	}
	return dictUsageSource{}, false
}

func dictUsageTx(ctx context.Context, tx *sql.Tx, dictID, key string) (int, string, error) {
	src, ok := dictUsageSourceOf(dictID)
	if !ok {
		return 0, "records", nil
	}
	src, live, err := src.ready(ctx, tx)
	if err != nil || !live {
		return 0, src.noun, err
	}
	var n int
	if err := tx.QueryRowContext(ctx, src.countOne, key).Scan(&n); err != nil {
		return 0, src.noun, fmt.Errorf("count dict item usage: %w", err)
	}
	return n, src.noun, nil
}

// dictUsageByKey 一次查完整个字典的引用数，避免列表接口按条目 N+1 地 COUNT。
func (s *Store) dictUsageByKey(ctx context.Context, dictID string) (map[string]int, error) {
	src, ok := dictUsageSourceOf(dictID)
	if !ok {
		return map[string]int{}, nil
	}
	src, live, err := src.ready(ctx, s.db.R)
	if err != nil || !live {
		return map[string]int{}, err
	}
	rows, err := s.db.R.QueryContext(ctx, src.countAll)
	if err != nil {
		return nil, fmt.Errorf("count dict usage: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := map[string]int{}
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return nil, err
		}
		out[key] = n
	}
	return out, rows.Err()
}

func (s *Store) fillDictItemUsage(ctx context.Context, it *domain.DictItem) error {
	if it == nil {
		return nil
	}
	n, err := s.DictItemUsage(ctx, it.ID)
	if err != nil {
		return err
	}
	it.Usage = n
	return nil
}

// --- 小工具 ---

// checkDictScope 保证条目的 type_id 和字典的 scope 对上：
// global 字典带上 type_id、或 type 字典漏了 type_id，条目都会落到一个查不出来的位置。
func checkDictScope(d *domain.Dictionary, typeID *string) error {
	switch d.Scope {
	case domain.ScopeType:
		if typeID == nil {
			return validation("type_id", "is required for a type-scoped dictionary")
		}
	case domain.ScopeGlobal:
		if typeID != nil {
			return validation("type_id", "must be empty for a global dictionary")
		}
	default:
		return validation("scope", "must be global or type")
	}
	return nil
}

// plural 把计数单位按数量收单复数。noun 一律用复数形式登记，这里只负责在
// 恰好 1 条时去掉尾巴，免得 409 的 message 写成「used by 1 links」。
func plural(noun string, n int) string {
	if n == 1 {
		return strings.TrimSuffix(noun, "s")
	}
	return noun
}

// dictTypeKey 把可空 type_id 折成用于 IFNULL(type_id,”) 比较的键。
func dictTypeKey(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// encodeDictMeta 把 meta 序列化成库里的 JSON 文本，nil 存 {}。
func encodeDictMeta(m map[string]any) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", validation("meta", "must be a JSON object")
	}
	return string(b), nil
}

// decodeDictMeta 反序列化 meta。库里的值只由 encodeDictMeta 和迁移种子写入，
// 解析失败也不该让整个列表接口挂掉，回一个空对象即可。
func decodeDictMeta(raw string) map[string]any {
	out := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}
	}
	return out
}
