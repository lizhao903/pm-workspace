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

const stakeholderCols = `s.id, s.name, s.role, s.email, s.note, s.color, s.sort_order,
	s.archived_at, s.created_at, s.updated_at,
	s.contact_group, s.company, s.title, s.phone, s.tags, s.photo, s.starred, s.last_contact_at`

// stakeholderSelect 把两个引用数一起带出来，不让调用方逐个回查（那就是 N+1，
// 而名册页一次就要展示全部人）。用相关子查询而不是两次 LEFT JOIN + GROUP BY：
// owner_id 和 object_participants 是两条不同的边，JOIN 到一起会互相放大计数。
//
// 软删的对象不计入这两个数：它们在回收站里，不该出现在「他手上有多少事」里。
// 注意删除前的引用检查用的是另一套口径（见 DeleteStakeholder），那边要连回收站
// 里的一起数——展示与安全是两个问题，共用一个数字必然有一边是错的。
const stakeholderSelect = `SELECT ` + stakeholderCols + `,
	(SELECT COUNT(*) FROM objects o
	   WHERE o.owner_id = s.id AND o.deleted_at IS NULL),
	(SELECT COUNT(*) FROM object_participants op
	   JOIN objects o ON o.id = op.object_id
	   WHERE op.stakeholder_id = s.id AND o.deleted_at IS NULL)
	FROM stakeholders s`

func scanStakeholder(sc rowScanner) (*domain.Stakeholder, error) {
	var (
		sh                    domain.Stakeholder
		archived, lastContact sql.NullString
		created, updated      string
		tags                  string
	)
	if err := sc.Scan(&sh.ID, &sh.Name, &sh.Role, &sh.Email, &sh.Note, &sh.Color, &sh.SortOrder,
		&archived, &created, &updated,
		&sh.Group, &sh.Company, &sh.Title, &sh.Phone, &tags, &sh.Photo, &sh.Starred, &lastContact,
		&sh.OwnedCount, &sh.ParticipatingCount); err != nil {
		return nil, err
	}
	sh.ArchivedAt = parseNullTime(archived)
	sh.LastContactAt = parseNullTime(lastContact)
	sh.CreatedAt, sh.UpdatedAt = parseTime(created), parseTime(updated)
	// tags 坏了不让整个名册读不出来，按空处理
	if err := json.Unmarshal([]byte(tags), &sh.Tags); err != nil || sh.Tags == nil {
		sh.Tags = []string{}
	}
	return &sh, nil
}

// maxStakeholderPhoto 和工作台图标的图片上限一致：原型限 1MB 文件，转成 data URL 约 1.37MB。
const maxStakeholderPhoto = 1_400_000

func checkStakeholderPhoto(photo string) error {
	if photo == "" {
		return nil
	}
	if !strings.HasPrefix(photo, "data:image/") {
		return validation("photo", "must be a data:image/ URL")
	}
	if len(photo) > maxStakeholderPhoto {
		return validation("photo", "is larger than 1MB")
	}
	return nil
}

// cleanTags 去首尾空白、去空、去重，保留顺序。
func cleanTags(tags []string) []string {
	out := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

func tagsJSON(tags []string) string {
	b, _ := json.Marshal(cleanTags(tags))
	return string(b)
}

// nameTaken 是撞名时的 409 文案：name 全局唯一，提示加区分而不是只说已存在。
func nameTaken(name string) error {
	return conflict("stakeholder " + name + " already exists; add a qualifier to tell them apart, e.g. " +
		name + "（公司）")
}

// ListStakeholders 的 includeArchived=false 只返回在岗的（选人时用），
// true 返回全部（名册管理页用）。排序与 0010 的 idx_stakeholders_order 一致。
func (s *Store) ListStakeholders(ctx context.Context, includeArchived bool) ([]*domain.Stakeholder, error) {
	q := stakeholderSelect
	if !includeArchived {
		q += ` WHERE s.archived_at IS NULL`
	}
	q += ` ORDER BY s.sort_order, s.name`

	rows, err := s.db.R.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list stakeholders: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []*domain.Stakeholder{}
	for rows.Next() {
		sh, err := scanStakeholder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

func (s *Store) GetStakeholder(ctx context.Context, id string) (*domain.Stakeholder, error) {
	row := s.db.R.QueryRowContext(ctx, stakeholderSelect+` WHERE s.id = ?`, id)
	sh, err := scanStakeholder(row)
	if noRows(err) {
		return nil, notFound("stakeholder")
	}
	if err != nil {
		return nil, fmt.Errorf("get stakeholder: %w", err)
	}
	return sh, nil
}

func (s *Store) CreateStakeholder(ctx context.Context, sh *domain.Stakeholder) (*domain.Stakeholder, error) {
	if sh == nil {
		return nil, validation("stakeholder", "is required")
	}
	name := strings.TrimSpace(sh.Name)
	if name == "" {
		return nil, validation("name", "is required")
	}
	if err := checkStakeholderPhoto(sh.Photo); err != nil {
		return nil, err
	}
	id := sh.ID
	if id == "" {
		id = idgen.Prefixed("stk")
	}
	now := nowStr()

	_, err := s.db.W.ExecContext(ctx, `INSERT INTO stakeholders
		(id, name, role, email, note, color, sort_order, archived_at, created_at, updated_at,
		 contact_group, company, title, phone, tags, photo, starred, last_contact_at)
		VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)`,
		id, name, sh.Role, sh.Email, sh.Note, sh.Color, sh.SortOrder, now, now,
		strings.TrimSpace(sh.Group), sh.Company, sh.Title, sh.Phone, tagsJSON(sh.Tags), sh.Photo,
		sh.Starred, timeArg(sh.LastContactAt))
	// 同名唯一由 0010 的唯一索引兜底：干系人靠名字辨认，出现两个「李钊」时用户无从选择，
	// 而错选的后果是任务分配到了另一个人身上。
	if isUnique(err) {
		return nil, nameTaken(name)
	}
	if err != nil {
		return nil, fmt.Errorf("insert stakeholder: %w", err)
	}
	return s.GetStakeholder(ctx, id)
}

func (s *Store) UpdateStakeholder(ctx context.Context, id string, p domain.StakeholderPatch) (*domain.Stakeholder, error) {
	cur, err := s.GetStakeholder(ctx, id)
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
		name := strings.TrimSpace(*p.Name)
		if name == "" {
			return nil, validation("name", "must not be empty")
		}
		add("name", name)
	}
	if p.Role != nil {
		add("role", *p.Role)
	}
	if p.Email != nil {
		add("email", *p.Email)
	}
	if p.Note != nil {
		add("note", *p.Note)
	}
	if p.Color != nil {
		add("color", *p.Color)
	}
	if p.SortOrder != nil {
		add("sort_order", *p.SortOrder)
	}
	if p.Group != nil {
		add("contact_group", strings.TrimSpace(*p.Group))
	}
	if p.Company != nil {
		add("company", *p.Company)
	}
	if p.Title != nil {
		add("title", *p.Title)
	}
	if p.Phone != nil {
		add("phone", *p.Phone)
	}
	if p.Tags != nil {
		add("tags", tagsJSON(*p.Tags))
	}
	if p.Photo != nil {
		if err := checkStakeholderPhoto(*p.Photo); err != nil {
			return nil, err
		}
		add("photo", *p.Photo)
	}
	if p.Starred != nil {
		add("starred", *p.Starred)
	}
	if p.LastContactAt != nil {
		add("last_contact_at", timeArg(*p.LastContactAt))
	}
	if p.Archived != nil {
		// 已归档的再归档不刷新时间戳：archived_at 记的是「什么时候离开的」，
		// 重复提交不该把它推到今天。
		switch {
		case *p.Archived && cur.ArchivedAt == nil:
			add("archived_at", nowStr())
		case !*p.Archived && cur.ArchivedAt != nil:
			sets = append(sets, "archived_at = NULL")
		}
	}
	if len(sets) == 0 {
		return cur, nil
	}
	add("updated_at", nowStr())
	args = append(args, id)

	_, err = s.db.W.ExecContext(ctx,
		`UPDATE stakeholders SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if isUnique(err) {
		return nil, nameTaken(strings.TrimSpace(*p.Name))
	}
	if err != nil {
		return nil, fmt.Errorf("update stakeholder: %w", err)
	}
	return s.GetStakeholder(ctx, id)
}

// DeleteStakeholder 只在零引用时放行，有引用返回 ErrConflict 让调用方改走归档。
//
// 这里数引用连回收站里的软删对象一起数，和名册页展示的 OwnedCount 口径不同：
// owner_id 是 ON DELETE SET NULL、object_participants 是 ON DELETE CASCADE，
// 删掉一个还被软删对象引用的人，那条对象将来从回收站恢复回来时负责人已经没了，
// 而这个丢失不报错、不崩溃，只是那一行从此空着。
func (s *Store) DeleteStakeholder(ctx context.Context, id string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM stakeholders WHERE id = ?`, id).Scan(&exists)
		if noRows(err) {
			return notFound("stakeholder")
		}
		if err != nil {
			return fmt.Errorf("get stakeholder: %w", err)
		}

		var owned, participating int
		if err := tx.QueryRowContext(ctx, `SELECT
			(SELECT COUNT(*) FROM objects WHERE owner_id = ?),
			(SELECT COUNT(*) FROM object_participants WHERE stakeholder_id = ?)`,
			id, id).Scan(&owned, &participating); err != nil {
			return fmt.Errorf("count stakeholder references: %w", err)
		}
		if n := owned + participating; n > 0 {
			// 数量要进 message：界面据此提示「改用归档」时得说清影响面有多大。
			return conflict(fmt.Sprintf(
				"stakeholder is referenced by %d %s (%d as owner, %d as participant); archive instead",
				n, plural("objects", n), owned, participating))
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM stakeholders WHERE id = ?`, id); err != nil {
			return fmt.Errorf("delete stakeholder: %w", err)
		}
		return nil
	})
}

// --- 工作对象侧的干系人读写，objects.go 用 ---

// stakeholderRefsByObject 一次把这批对象的参与人全查回来，避免逐条回查。
func stakeholderRefsByObject(ctx context.Context, q queryer, ids []string) (map[string][]domain.StakeholderRef, error) {
	out := map[string][]domain.StakeholderRef{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT op.object_id, s.id, s.name, s.color
		FROM object_participants op
		JOIN stakeholders s ON s.id = op.stakeholder_id
		WHERE op.object_id IN (`+placeholders(len(ids))+`)
		ORDER BY op.sort_order, s.name`, anySlice(ids)...)
	if err != nil {
		return nil, fmt.Errorf("load participants: %w", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var oid string
		var ref domain.StakeholderRef
		if err := rows.Scan(&oid, &ref.ID, &ref.Name, &ref.Color); err != nil {
			return nil, err
		}
		out[oid] = append(out[oid], ref)
	}
	return out, rows.Err()
}

// dedupeIDs 保留首次出现的顺序去重。object_participants 的主键是 (object_id, stakeholder_id)，
// 同一个人传两次会撞主键——那是客户端的手滑，不该变成一个 500。
func dedupeIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// assertStakeholdersExist 一次查完全部 id，不逐个回查。
// 不存在的 id 当校验错误处理：外键会拦下它，但报出来的是一句
// "FOREIGN KEY constraint failed"，前端没法从中知道是哪个字段错了。
func assertStakeholdersExist(ctx context.Context, q queryer, field string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.QueryContext(ctx,
		`SELECT id FROM stakeholders WHERE id IN (`+placeholders(len(ids))+`)`, anySlice(ids)...)
	if err != nil {
		return fmt.Errorf("check stakeholders: %w", err)
	}
	defer func() { _ = rows.Close() }()

	found := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		found[id] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	missing := []string{}
	for _, id := range ids {
		if !found[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return validation(field, "references unknown stakeholders: "+strings.Join(missing, ", "))
	}
	return nil
}

// setParticipants 全量替换参与人：先清空再按给定顺序写回。
// sort_order 按下标存，这样列表里的头像顺序是用户排的那个顺序，不是 id 的字典序。
func setParticipants(ctx context.Context, tx *sql.Tx, objectID string, ids []string) error {
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM object_participants WHERE object_id = ?`, objectID); err != nil {
		return fmt.Errorf("clear participants: %w", err)
	}
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO object_participants (object_id, stakeholder_id, sort_order)
			 VALUES (?,?,?)`, objectID, id, i); err != nil {
			return fmt.Errorf("insert participant: %w", err)
		}
	}
	return nil
}
