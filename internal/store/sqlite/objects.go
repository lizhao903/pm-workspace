package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const objectCols = `o.id,o.type_id,o.ref,o.title,o.body,o.status,o.priority,o.owner,o.owner_id,
	o.category_id,o.project_id,o.source,o.props,o.workdir,o.due_at,o.started_at,o.completed_at,
	o.archived_at,o.deleted_at,o.created_at,o.updated_at`

// objectSelect 把分类名、所属项目标题、负责人姓名和关联数一并带出来，省掉详情页的几次回查。
// 负责人姓名走 JOIN 而不是按 owner_id 逐行回查：列表一次 50 行，回查就是 50 次往返。
const objectSelect = `SELECT ` + objectCols + `,
	IFNULL(c.name,''), IFNULL(c.path,''), IFNULL(c.color,''), IFNULL(p.title,''),
	IFNULL(sh.name,''),
	(SELECT COUNT(*) FROM links l WHERE l.from_id = o.id OR l.to_id = o.id)
	FROM objects o
	LEFT JOIN categories c ON c.id = o.category_id
	LEFT JOIN objects p ON p.id = o.project_id
	LEFT JOIN stakeholders sh ON sh.id = o.owner_id`

const defaultLimit = 50
const maxLimit = 200

func scanObject(sc rowScanner) (*domain.Object, error) {
	var (
		o                                                    domain.Object
		owner, category, project                             sql.NullString
		due, started, completed                              sql.NullString
		archived, deleted                                    sql.NullString
		props, created, updated                              string
		categoryName, categoryPath, categoryColor, projTitle string
		ownerName                                            string
		linkCount                                            int
	)
	if err := sc.Scan(&o.ID, &o.TypeID, &o.Ref, &o.Title, &o.Body, &o.Status, &o.Priority, &o.Owner, &owner,
		&category, &project, &o.Source, &props, &o.Workdir, &due, &started, &completed,
		&archived, &deleted, &created, &updated,
		&categoryName, &categoryPath, &categoryColor, &projTitle, &ownerName, &linkCount); err != nil {
		return nil, err
	}
	o.OwnerID = strPtr(owner)
	// owner_id 为空时用 0010 之前的自由文本兜底：迁移判断错了某条的话，界面仍显示得出
	// 个人名来，不会因为漏迁而变成一片空白。前端只读 owner_name 这一个字段。
	o.OwnerName = ownerName
	if o.OwnerName == "" {
		o.OwnerName = o.Owner
	}
	o.CategoryID = strPtr(category)
	o.ProjectID = strPtr(project)
	o.DueAt = parseNullTime(due)
	o.StartedAt = parseNullTime(started)
	o.CompletedAt = parseNullTime(completed)
	o.ArchivedAt = parseNullTime(archived)
	o.DeletedAt = parseNullTime(deleted)
	o.CreatedAt = parseTime(created)
	o.UpdatedAt = parseTime(updated)
	o.CategoryName, o.CategoryPath, o.CategoryColor = categoryName, categoryPath, categoryColor
	o.ProjectTitle, o.LinkCount = projTitle, linkCount
	o.Props = map[string]any{}
	if props != "" {
		if err := json.Unmarshal([]byte(props), &o.Props); err != nil {
			return nil, fmt.Errorf("decode props of %s: %w", o.ID, err)
		}
	}
	o.Tags = []string{}
	o.Participants = []domain.StakeholderRef{}
	return &o, nil
}

func (s *Store) GetObject(ctx context.Context, id string) (*domain.Object, error) {
	row := s.db.R.QueryRowContext(ctx, objectSelect+` WHERE o.id = ?`, id)
	o, err := scanObject(row)
	if noRows(err) {
		return nil, notFound("object")
	}
	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}
	items := []*domain.Object{o}
	if err := s.fillTags(ctx, items); err != nil {
		return nil, err
	}
	if err := s.fillParticipants(ctx, items); err != nil {
		return nil, err
	}
	return o, nil
}

// --- 列表查询 ---

func (s *Store) ListObjects(ctx context.Context, f domain.ObjectFilter) ([]*domain.Object, int, error) {
	where, args, err := s.buildWhere(ctx, f)
	if err != nil {
		return nil, 0, err
	}

	var total int
	countQ := `SELECT COUNT(*) FROM objects o
		LEFT JOIN categories c ON c.id = o.category_id WHERE ` + where
	if err := s.db.R.QueryRowContext(ctx, countQ, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count objects: %w", err)
	}

	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	q := objectSelect + ` WHERE ` + where + ` ORDER BY ` + orderBy(f.Sort) + ` LIMIT ? OFFSET ?`
	rows, err := s.db.R.QueryContext(ctx, q, append(append([]any{}, args...), limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list objects: %w", err)
	}
	defer func() { _ = rows.Close() }()

	items := []*domain.Object{}
	for rows.Next() {
		o, err := scanObject(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, o)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := s.fillTags(ctx, items); err != nil {
		return nil, 0, err
	}
	if err := s.fillParticipants(ctx, items); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}

// buildWhere 按 filter 逐条拼条件。所有值一律走 ? 绑定，SQL 里只出现列名和占位符。
func (s *Store) buildWhere(ctx context.Context, f domain.ObjectFilter) (string, []any, error) {
	conds := []string{"1=1"}
	args := []any{}

	if !f.IncludeDeleted {
		conds = append(conds, "o.deleted_at IS NULL")
	}
	if !f.IncludeArchived {
		conds = append(conds, "o.archived_at IS NULL")
	}
	if len(f.TypeIDs) > 0 {
		conds = append(conds, "o.type_id IN ("+placeholders(len(f.TypeIDs))+")")
		args = append(args, anySlice(f.TypeIDs)...)
	}
	// Uncategorized 与 CategoryID 互斥：两者同时给时以 Uncategorized 为准。
	// 未分类没有子树可言，所以它对 CategorySubtree 也一并短路。
	switch {
	case f.Uncategorized:
		conds = append(conds, "o.category_id IS NULL")
	case f.CategoryID != "":
		if f.CategorySubtree {
			// 子树匹配靠物化路径前缀，不用递归 CTE。
			cat, err := s.GetCategory(ctx, f.CategoryID)
			if err != nil {
				return "", nil, err
			}
			conds = append(conds, "c.type_id = ? AND c.path LIKE ? ESCAPE '\\'")
			args = append(args, cat.TypeID, likeEscape(cat.Path)+"%")
		} else {
			conds = append(conds, "o.category_id = ?")
			args = append(args, f.CategoryID)
		}
	}
	if len(f.Statuses) > 0 {
		conds = append(conds, "o.status IN ("+placeholders(len(f.Statuses))+")")
		args = append(args, anySlice(f.Statuses)...)
	}
	if len(f.Priorities) > 0 {
		conds = append(conds, "o.priority IN ("+placeholders(len(f.Priorities))+")")
		args = append(args, anySlice(f.Priorities)...)
	}
	// 多标签是 AND：每个标签一个 EXISTS，比 GROUP BY HAVING 更省事也更好读。
	for _, tag := range f.Tags {
		if tag == "" {
			continue
		}
		conds = append(conds, `EXISTS (SELECT 1 FROM object_tags ot
			JOIN tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id AND t.name = ?)`)
		args = append(args, tag)
	}
	if f.OwnerID != "" {
		conds = append(conds, "o.owner_id = ?")
		args = append(args, f.OwnerID)
	}
	if f.ProjectID != "" {
		conds = append(conds, "o.project_id = ?")
		args = append(args, f.ProjectID)
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		like := "%" + likeEscape(q) + "%"
		conds = append(conds, `(o.title LIKE ? ESCAPE '\' OR o.body LIKE ? ESCAPE '\' OR o.ref LIKE ? ESCAPE '\')`)
		args = append(args, like, like, like)
	}
	// DueAfter/DueBefore 成对使用才能表达「同一天到期」这种窗口。只有上界的话，
	// 「今日」会把所有逾期的也扫进来，和 Counts.Today 的口径对不上。
	if f.DueAfter != nil {
		conds = append(conds, "o.due_at IS NOT NULL AND o.due_at >= ?")
		args = append(args, timeStr(*f.DueAfter))
	}
	if f.DueBefore != nil {
		conds = append(conds, "o.due_at IS NOT NULL AND o.due_at < ?")
		args = append(args, timeStr(*f.DueBefore))
	}
	if f.Overdue {
		clause, cargs, err := s.terminalClause(ctx, "o")
		if err != nil {
			return "", nil, err
		}
		conds = append(conds, "o.due_at IS NOT NULL AND o.due_at < ? AND "+clause)
		args = append(args, overdueBefore(time.Now()))
		args = append(args, cargs...)
	}
	// Stalled 的口径必须和 Counts.Stalled 逐字一致，阈值共用 stalledDays，
	// 否则「徽标 2 / 列表 20 行」那类问题会以另一种形式回来。
	if f.Stalled {
		clause, cargs, err := s.terminalClause(ctx, "o")
		if err != nil {
			return "", nil, err
		}
		conds = append(conds, "o.updated_at < ? AND "+clause)
		args = append(args, stalledBefore(time.Now()))
		args = append(args, cargs...)
	}
	// NotTerminal 单独给「今日」「本周」这类待办视图用：Counts 那边排除终态，
	// 列表不排除的话，今天到期但已完成的会混进来。
	if f.NotTerminal {
		clause, cargs, err := s.terminalClause(ctx, "o")
		if err != nil {
			return "", nil, err
		}
		conds = append(conds, clause)
		args = append(args, cargs...)
	}
	if f.Inbox {
		conds = append(conds, "(o.source = 'inbox' OR o.category_id IS NULL)")
	}
	if len(f.Sources) > 0 {
		conds = append(conds, "o.source IN ("+placeholders(len(f.Sources))+")")
		args = append(args, anySlice(f.Sources)...)
	}
	// props 上的筛选（AUTO-05）。props 是 JSON 文本，0001 起非空（默认 '{}'），json_extract 不会报错。
	if len(f.Stages) > 0 {
		var keys []string
		none := false
		for _, s := range f.Stages {
			if s == "none" {
				none = true
			} else if s != "" {
				keys = append(keys, s)
			}
		}
		var ors []string
		if len(keys) > 0 {
			ors = append(ors, "json_extract(o.props, '$.stage') IN ("+placeholders(len(keys))+")")
			args = append(args, anySlice(keys)...)
		}
		if none {
			ors = append(ors, "COALESCE(json_extract(o.props, '$.stage'), '') = ''")
		}
		if len(ors) > 0 {
			conds = append(conds, "("+strings.Join(ors, " OR ")+")")
		}
	}
	if f.RequesterID != "" {
		conds = append(conds, "json_extract(o.props, '$.requester.contact_id') = ?")
		args = append(args, f.RequesterID)
	}
	if f.RequesterChannel != "" || f.RequesterSenderID != "" {
		conds = append(conds, "json_extract(o.props, '$.requester.channel') = ? AND json_extract(o.props, '$.requester.sender_id') = ?")
		args = append(args, f.RequesterChannel, f.RequesterSenderID)
	}
	if f.SourceMessageID != "" {
		conds = append(conds, "json_extract(o.props, '$.source_ref.message_id') = ?")
		args = append(args, f.SourceMessageID)
	}
	return strings.Join(conds, " AND "), args, nil
}

// sortColumns 是排序白名单，非法值一律回落默认排序，避免把用户输入拼进 ORDER BY。
var sortColumns = map[string]string{
	"updated_at": "o.updated_at",
	"created_at": "o.created_at",
	"title":      "o.title",
	"due_at":     "o.due_at",
	"priority":   "CASE o.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END",
}

func orderBy(sortKey string) string {
	key, desc := strings.TrimPrefix(sortKey, "-"), strings.HasPrefix(sortKey, "-")
	col, ok := sortColumns[key]
	if !ok {
		col, desc = sortColumns["updated_at"], true
		key = "updated_at"
	}
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	// 空优先级和空截止日永远沉底，正序倒序都一样，否则倒序时一堆空值糊在最前面。
	prefix := ""
	switch key {
	case "priority":
		prefix = "(o.priority IS NULL OR o.priority = '') ASC, "
	case "due_at":
		prefix = "(o.due_at IS NULL) ASC, "
	}
	return prefix + col + " " + dir + ", o.id DESC"
}

// fillTags 一次把这批对象的标签全查回来，避免逐条回查。
func (s *Store) fillTags(ctx context.Context, items []*domain.Object) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	byID := make(map[string]*domain.Object, len(items))
	for i, o := range items {
		ids[i] = o.ID
		byID[o.ID] = o
	}
	rows, err := s.db.R.QueryContext(ctx, `SELECT ot.object_id, t.name FROM object_tags ot
		JOIN tags t ON t.id = ot.tag_id
		WHERE ot.object_id IN (`+placeholders(len(ids))+`) ORDER BY t.name`, anySlice(ids)...)
	if err != nil {
		return fmt.Errorf("load tags: %w", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var oid, name string
		if err := rows.Scan(&oid, &name); err != nil {
			return err
		}
		if o, ok := byID[oid]; ok {
			o.Tags = append(o.Tags, name)
		}
	}
	return rows.Err()
}

// fillParticipants 一次把这批对象的参与人全查回来，理由同 fillTags：
// 一行可能有好几个参与人，逐条回查就是 N+1。
func (s *Store) fillParticipants(ctx context.Context, items []*domain.Object) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, len(items))
	for i, o := range items {
		ids[i] = o.ID
	}
	byObject, err := stakeholderRefsByObject(ctx, s.db.R, ids)
	if err != nil {
		return err
	}
	for _, o := range items {
		if refs, ok := byObject[o.ID]; ok {
			o.Participants = refs
		}
	}
	return nil
}

// --- 写入 ---

func (s *Store) CreateObject(ctx context.Context, o *domain.Object, a store.Actor) (*domain.Object, error) {
	if o == nil {
		return nil, validation("object", "is required")
	}
	if strings.TrimSpace(o.Title) == "" {
		return nil, validation("title", "is required")
	}
	t, err := s.GetObjectType(ctx, o.TypeID)
	if err != nil {
		return nil, err
	}
	status := o.Status
	if status == "" {
		status = t.Statuses[0].Key
	}
	if _, ok := statusOf(t, status); !ok {
		return nil, validation("status", "is not allowed for type "+t.ID+": "+status)
	}
	if o.CategoryID != nil && *o.CategoryID != "" {
		cat, err := s.GetCategory(ctx, *o.CategoryID)
		if err != nil {
			return nil, err
		}
		if cat.TypeID != o.TypeID {
			return nil, validation("category_id", "belongs to another object type")
		}
	}

	// 负责人与参与人在建对象时就能带上，否则前端只能「先建后改」两次请求，
	// 中间还会多出一条无意义的修订记录。
	// 参与人从 o.Participants 上取 id：CreateObject 的入参是整个 domain.Object，
	// 没有单独的 ids 通道，调用方填 StakeholderRef{ID: ...} 即可，Name/Color 会被忽略。
	participantIDs := make([]string, 0, len(o.Participants))
	for _, ref := range o.Participants {
		participantIDs = append(participantIDs, ref.ID)
	}
	participantIDs = dedupeIDs(participantIDs)
	if err := assertStakeholdersExist(ctx, s.db.R, "participant_ids", participantIDs); err != nil {
		return nil, err
	}
	ownerID := strings.TrimSpace(derefPtr(o.OwnerID))
	if ownerID != "" {
		if _, err := s.GetStakeholder(ctx, ownerID); err != nil {
			return nil, err
		}
	}

	props := o.Props
	if props == nil {
		props = map[string]any{}
	}
	blob, err := json.Marshal(props)
	if err != nil {
		return nil, fmt.Errorf("encode props: %w", err)
	}

	id := o.ID
	if id == "" {
		id = idgen.Prefixed("obj")
	}
	now := nowStr()
	created := now
	if !o.CreatedAt.IsZero() {
		created = timeStr(o.CreatedAt)
	}
	updated := now
	if !o.UpdatedAt.IsZero() {
		updated = timeStr(o.UpdatedAt)
	}

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		ref, err := nextRef(ctx, tx, t)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO objects
			(id,type_id,ref,title,body,status,priority,owner,owner_id,category_id,project_id,source,props,workdir,
			 due_at,started_at,completed_at,archived_at,deleted_at,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, o.TypeID, ref, o.Title, o.Body, status, o.Priority, o.Owner, nullable(ownerID),
			ptrArg(o.CategoryID), ptrArg(o.ProjectID), o.Source, string(blob), o.Workdir,
			timeArg(o.DueAt), timeArg(o.StartedAt), timeArg(o.CompletedAt),
			timeArg(o.ArchivedAt), timeArg(o.DeletedAt), created, updated); err != nil {
			return fmt.Errorf("insert object: %w", err)
		}
		if len(o.Tags) > 0 {
			if err := setTags(ctx, tx, id, o.Tags); err != nil {
				return err
			}
		}
		if len(participantIDs) > 0 {
			if err := setParticipants(ctx, tx, id, participantIDs); err != nil {
				return err
			}
		}
		return addRevision(ctx, tx, id, "created", "", o.Title, a, updated)
	})
	if err != nil {
		return nil, err
	}
	return s.GetObject(ctx, id)
}

// nextRef 在事务里取号自增，保证并发写不会撞号。序号不足 4 位补零，超过就自然变长。
func nextRef(ctx context.Context, tx *sql.Tx, t *domain.ObjectType) (string, error) {
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO ref_counters (type_id, next_seq) VALUES (?, 1)`, t.ID); err != nil {
		return "", fmt.Errorf("init ref counter: %w", err)
	}
	var seq int
	if err := tx.QueryRowContext(ctx,
		`SELECT next_seq FROM ref_counters WHERE type_id = ?`, t.ID).Scan(&seq); err != nil {
		return "", fmt.Errorf("read ref counter: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE ref_counters SET next_seq = next_seq + 1 WHERE type_id = ?`, t.ID); err != nil {
		return "", fmt.Errorf("bump ref counter: %w", err)
	}
	return fmt.Sprintf("%s-%04d", t.RefPrefix, seq), nil
}

func (s *Store) UpdateObject(ctx context.Context, id string, p domain.ObjectPatch, a store.Actor) (*domain.Object, error) {
	cur, err := s.GetObject(ctx, id)
	if err != nil {
		return nil, err
	}
	t, err := s.GetObjectType(ctx, cur.TypeID)
	if err != nil {
		return nil, err
	}

	now := nowStr()
	sets := []string{}
	args := []any{}
	// revs 收集字段级差异，只有真变了的字段才进修订历史，日报才不会被噪音淹没。
	revs := []domain.Revision{}
	change := func(field, old, new string, col string, arg any) {
		if old == new {
			return
		}
		sets = append(sets, col+" = ?")
		args = append(args, arg)
		revs = append(revs, domain.Revision{Field: field, OldValue: old, NewValue: new})
	}

	if p.Title != nil {
		if strings.TrimSpace(*p.Title) == "" {
			return nil, validation("title", "must not be empty")
		}
		change("title", cur.Title, *p.Title, "title", *p.Title)
	}
	if p.Body != nil {
		change("body", cur.Body, *p.Body, "body", *p.Body)
	}
	if p.Priority != nil {
		change("priority", cur.Priority, *p.Priority, "priority", *p.Priority)
	}
	if p.OwnerID != nil {
		// 空串落 NULL：owner_id 是外键，"" 不是合法 id。
		var curID string
		if cur.OwnerID != nil {
			curID = *cur.OwnerID
		}
		if v := strings.TrimSpace(*p.OwnerID); v == "" {
			change("owner_id", curID, "", "owner_id", nil)
		} else {
			if v != curID {
				// 外键会拦下不存在的 id，但它报出来的是一句
				// "FOREIGN KEY constraint failed"，前端没法从中知道是哪个字段错了。
				if _, err := s.GetStakeholder(ctx, v); err != nil {
					return nil, err
				}
			}
			change("owner_id", curID, v, "owner_id", v)
		}
	}
	if p.Source != nil {
		change("source", cur.Source, *p.Source, "source", *p.Source)
	}
	if p.Workdir != nil {
		// 不在这里校验目录存不存在：工作区是允许先填后建的，真要用的时候
		// agent.CheckWorkdir 会拦。存库时挡一道，用户改个标题都可能被牵连报错。
		change("workdir", cur.Workdir, strings.TrimSpace(*p.Workdir), "workdir", strings.TrimSpace(*p.Workdir))
	}
	if p.Status != nil {
		st, ok := statusOf(t, *p.Status)
		if !ok {
			return nil, validation("status", "is not allowed for type "+t.ID+": "+*p.Status)
		}
		if st.Key != cur.Status {
			change("status", cur.Status, st.Key, "status", st.Key)
			ss, sa := statusTimestamps(t, cur, st, now)
			sets = append(sets, ss...)
			args = append(args, sa...)
		}
	}
	if p.CategoryID != nil {
		next := derefPtr(*p.CategoryID)
		if next != "" {
			cat, err := s.GetCategory(ctx, next)
			if err != nil {
				return nil, err
			}
			if cat.TypeID != cur.TypeID {
				return nil, validation("category_id", "belongs to another object type")
			}
		}
		change("category_id", derefPtr(cur.CategoryID), next, "category_id", nullable(next))
	}
	if p.ProjectID != nil {
		next := derefPtr(*p.ProjectID)
		if next != "" {
			if _, err := s.GetObject(ctx, next); err != nil {
				return nil, err
			}
			if next == id {
				return nil, validation("project_id", "must not reference itself")
			}
		}
		change("project_id", derefPtr(cur.ProjectID), next, "project_id", nullable(next))
	}
	if p.DueAt != nil {
		next := fmtTimePtr(*p.DueAt)
		change("due_at", fmtTimePtr(cur.DueAt), next, "due_at", nullable(next))
	}
	if p.Props != nil {
		blob, err := json.Marshal(*p.Props)
		if err != nil {
			return nil, fmt.Errorf("encode props: %w", err)
		}
		old, err := json.Marshal(cur.Props)
		if err != nil {
			return nil, fmt.Errorf("encode props: %w", err)
		}
		change("props", string(old), string(blob), "props", string(blob))
	}
	if p.Archived != nil {
		oldVal, newVal := "", ""
		if cur.ArchivedAt != nil {
			oldVal = timeStr(*cur.ArchivedAt)
		}
		if *p.Archived {
			if oldVal == "" {
				newVal = now
			} else {
				newVal = oldVal
			}
		}
		change("archived", oldVal, newVal, "archived_at", nullable(newVal))
	}

	// 标签存在关联表里，改动要单独走，但差异照样记一条修订。
	var tagChange *[]string
	if p.Tags != nil {
		next := append([]string{}, *p.Tags...)
		sort.Strings(next)
		old := append([]string{}, cur.Tags...)
		sort.Strings(old)
		if strings.Join(old, ",") != strings.Join(next, ",") {
			tagChange = &next
			revs = append(revs, domain.Revision{
				Field: "tags", OldValue: strings.Join(old, ","), NewValue: strings.Join(next, ","),
			})
		}
	}

	// 参与人也在关联表里，和标签同构：全量替换，差异记一条修订。
	// 不记的话，日报里看不出人员调整——「谁在这件事里」变了是比改个标题更重要的事。
	//
	// 比较是按顺序的：sort_order 决定界面上头像的排列，重排也是一次真实的改动。
	var participantChange *[]string
	if p.ParticipantIDs != nil {
		next := dedupeIDs(*p.ParticipantIDs)
		if err := assertStakeholdersExist(ctx, s.db.R, "participant_ids", next); err != nil {
			return nil, err
		}
		old := make([]string, 0, len(cur.Participants))
		for _, ref := range cur.Participants {
			old = append(old, ref.ID)
		}
		if strings.Join(old, ",") != strings.Join(next, ",") {
			participantChange = &next
			revs = append(revs, domain.Revision{
				Field: "participants", OldValue: strings.Join(old, ","), NewValue: strings.Join(next, ","),
			})
		}
	}

	if len(sets) == 0 && tagChange == nil && participantChange == nil {
		return cur, nil
	}

	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if len(sets) > 0 {
			sets = append(sets, "updated_at = ?")
			args = append(args, now, id)
			if _, err := tx.ExecContext(ctx,
				`UPDATE objects SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
				return fmt.Errorf("update object: %w", err)
			}
		}
		if tagChange != nil {
			if err := setTags(ctx, tx, id, *tagChange); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE objects SET updated_at = ? WHERE id = ?`, now, id); err != nil {
				return fmt.Errorf("touch object: %w", err)
			}
		}
		if participantChange != nil {
			if err := setParticipants(ctx, tx, id, *participantChange); err != nil {
				return err
			}
			// 关联表的写入不会动 objects.updated_at，不补这一下，「N 天未更新」
			// 会把刚调过人员的对象算成停滞。
			if _, err := tx.ExecContext(ctx,
				`UPDATE objects SET updated_at = ? WHERE id = ?`, now, id); err != nil {
				return fmt.Errorf("touch object: %w", err)
			}
		}
		for _, r := range revs {
			if err := addRevision(ctx, tx, id, r.Field, r.OldValue, r.NewValue, a, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetObject(ctx, id)
}

// statusTimestamps 返回切到状态 st 时要顺带维护的时间戳列。
//
// 进出终态维护完成时间、第一次离开初始状态记开始时间。这两个时间戳只经由状态切换写入，
// UpdateObject 和进展/领取（progress.go）都走这里——各写一份的话，
// 经由领取进入 doing 的任务会没有 started_at，周期时间统计就悄悄少了一截。
func statusTimestamps(t *domain.ObjectType, cur *domain.Object, st domain.Status, now string) ([]string, []any) {
	var sets []string
	var args []any
	if st.Terminal && cur.CompletedAt == nil {
		sets = append(sets, "completed_at = ?")
		args = append(args, now)
	} else if !st.Terminal && cur.CompletedAt != nil {
		sets = append(sets, "completed_at = NULL")
	}
	if !st.Terminal && cur.StartedAt == nil && st.Key != t.Statuses[0].Key {
		sets = append(sets, "started_at = ?")
		args = append(args, now)
	}
	return sets, args
}

func (s *Store) DeleteObject(ctx context.Context, id string, hard bool, a store.Actor) error {
	cur, err := s.GetObject(ctx, id)
	if err != nil {
		return err
	}
	if hard {
		// 硬删依赖外键级联清掉 tags/links/revisions。
		res, err := s.db.W.ExecContext(ctx, `DELETE FROM objects WHERE id = ?`, id)
		if err != nil {
			return fmt.Errorf("delete object: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return notFound("object")
		}
		return nil
	}
	if cur.DeletedAt != nil {
		return nil
	}
	now := nowStr()
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			`UPDATE objects SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id); err != nil {
			return fmt.Errorf("soft delete object: %w", err)
		}
		return addRevision(ctx, tx, id, "deleted", "", now, a, now)
	})
}

func (s *Store) RestoreObject(ctx context.Context, id string, a store.Actor) (*domain.Object, error) {
	cur, err := s.GetObject(ctx, id)
	if err != nil {
		return nil, err
	}
	if cur.DeletedAt == nil {
		return cur, nil
	}
	now := nowStr()
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			`UPDATE objects SET deleted_at = NULL, updated_at = ? WHERE id = ?`, now, id); err != nil {
			return fmt.Errorf("restore object: %w", err)
		}
		return addRevision(ctx, tx, id, "restored", timeStr(*cur.DeletedAt), "", a, now)
	})
	if err != nil {
		return nil, err
	}
	return s.GetObject(ctx, id)
}

// ResolveWorkdir 取对象的有效工作区：自身没设时回退到所属项目的，都没有返回空串。
//
// 只向上找一层，不做递归。项目不会再挂在项目下面，多层查找除了把一个「看一眼
// project_id」的问题变成一个「会不会成环」的问题之外没有任何收益。
//
// 都没设不是错误：大多数对象本来就不需要工作区，调用方拿到空串按「没配」处理即可。
func (s *Store) ResolveWorkdir(ctx context.Context, objectID string) (string, error) {
	var own string
	var project sql.NullString
	err := s.db.R.QueryRowContext(ctx,
		`SELECT workdir, project_id FROM objects WHERE id = ?`, objectID).Scan(&own, &project)
	if noRows(err) {
		return "", notFound("object")
	}
	if err != nil {
		return "", fmt.Errorf("resolve workdir: %w", err)
	}
	if w := strings.TrimSpace(own); w != "" {
		return w, nil
	}
	if !project.Valid || project.String == "" {
		return "", nil
	}

	var parent string
	err = s.db.R.QueryRowContext(ctx,
		`SELECT workdir FROM objects WHERE id = ?`, project.String).Scan(&parent)
	if noRows(err) {
		// project_id 指向一条已经被硬删的记录。这不该发生（有外键），真发生了
		// 也只是「没配工作区」，没必要因此让整个请求失败。
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve project workdir: %w", err)
	}
	return strings.TrimSpace(parent), nil
}

// --- 小工具 ---

// derefPtr 解 ObjectPatch 的第二层指针：指向 nil 表示置空。
func derefPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func fmtTimePtr(p *time.Time) string {
	if p == nil {
		return ""
	}
	return timeStr(*p)
}

// nullable 让空串落库成 NULL，外键列和时间列都不接受空串。
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
