package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/store"
)

const artifactCols = `a.id, a.object_id, a.session_id, a.run_id, a.title, a.path,
	a.base_dir, a.url, a.platform, a.size, a.source, a.note, a.created_at, a.updated_at,
	a.kind, a.status, a.actor_type, a.actor_id, a.actor_label, a.scope_type, a.scope_id, a.props`

// artifactSelect 顺带带出归属对象的编号和标题。产物页每行都要显示「属于哪件事」，
// 逐行回查就是 N+1——而这个页面的默认视图是全量清单，行数正好是最多的时候。
// 用 LEFT JOIN 而不是 JOIN：object_id 可空，未归属的产物必须仍然出现在列表里。
const artifactSelect = `SELECT ` + artifactCols + `, o.ref, o.title
	FROM artifacts a
	LEFT JOIN objects o ON o.id = a.object_id`

// 产物的时间戳用纳秒精度，和 agent 那几张表同一套。
//
// 不能用秒级的 nowStr()：执行后扫目录可能一次登记几十个文件，它们全落在同一秒内，
// created_at 完全相同，排序退化成按 id 比较，而 idgen 的 id 低位是随机数——
// 产物列表会乱序。这不是理论风险，扫目录是本功能的四个来源之一。
const artifactTimeLayout = agentTimeLayout

func nowArtifact() string { return time.Now().UTC().Format(artifactTimeLayout) }

// artifactSources 是 source 的白名单。
// 不做校验的话，写错一个字母会安静地存进去，然后在统计页多出一个永远是 1 的分组。
var artifactSources = map[string]bool{
	domain.ArtifactSourceManual: true,
	domain.ArtifactSourceAgent:  true,
	domain.ArtifactSourceRun:    true,
	domain.ArtifactSourceMCP:    true,
}

// artifactActors 是 actor_type 的白名单，空串表示没声明（入库前按 source 补）。
var artifactActors = map[string]bool{
	domain.ActorUser: true, domain.ActorAgent: true, domain.ActorSkill: true,
	domain.ActorSOP: true, domain.ActorRun: true, domain.ActorMCP: true,
	domain.ActorIM: true, domain.ActorSync: true,
}

// artifactStatuses 是 status 的白名单，空串表示不跟踪。
var artifactStatuses = map[string]bool{
	"": true, "draft": true, "review": true, "final": true, "published": true,
}

// actorOfSource 是没声明产出者时的默认值，和 0031 回填老数据的口径一致。
func actorOfSource(source string) string {
	switch source {
	case domain.ArtifactSourceManual:
		return domain.ActorUser
	case domain.ArtifactSourceAgent:
		return domain.ActorAgent
	case domain.ArtifactSourceRun:
		return domain.ActorRun
	case domain.ArtifactSourceMCP:
		return domain.ActorMCP
	}
	return ""
}

func scanArtifact(sc rowScanner) (*domain.Artifact, error) {
	var (
		a                   domain.Artifact
		objectID, sessionID sql.NullString
		runID               sql.NullString
		objRef, objTitle    sql.NullString
		created, updated    string
		props               string
	)
	if err := sc.Scan(&a.ID, &objectID, &sessionID, &runID, &a.Title, &a.Path,
		&a.BaseDir, &a.URL, &a.Platform, &a.Size, &a.Source, &a.Note,
		&created, &updated, &a.Kind, &a.Status, &a.ActorType, &a.ActorID,
		&a.ActorLabel, &a.ScopeType, &a.ScopeID, &props, &objRef, &objTitle); err != nil {
		return nil, err
	}
	a.Props = map[string]any{}
	_ = json.Unmarshal([]byte(props), &a.Props)
	if a.Props == nil {
		a.Props = map[string]any{}
	}
	a.ObjectID = nullStrPtr(objectID)
	a.SessionID = nullStrPtr(sessionID)
	a.RunID = nullStrPtr(runID)
	a.ObjectRef, a.ObjectTitle = objRef.String, objTitle.String
	a.CreatedAt, a.UpdatedAt = parseTime(created), parseTime(updated)
	a.RelPath = relPath(a.BaseDir, a.Path)
	a.DisplayKind = domain.DisplayKindOf(&a)
	return &a, nil
}

func nullStrPtr(ns sql.NullString) *string {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	v := ns.String
	return &v
}

// relPath 现算相对路径。库里只存绝对 path 和 base_dir——两个路径字符串都落库的话，
// 文件挪窝时改了一个漏了另一个，两边都不会报错，而读代码的人无从判断该信哪个。
//
// 算不出来（不在 base_dir 下、base_dir 为空）就退回绝对路径。返回 "../.." 开头的
// 结果是更坏的选择：那既不能直接打开，也看不出它到底在哪。
func relPath(baseDir, path string) string {
	if baseDir == "" || path == "" || !filepath.IsAbs(path) {
		return path
	}
	rel, err := filepath.Rel(baseDir, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return path
	}
	return rel
}

// artifactWhere 把 filter 翻成 WHERE 片段。
//
// ListArtifacts 和 ArtifactStats 共用它，这是有意的：两处各写一套 WHERE 的话，
// 某个条件下「列表显示 7 行」和「统计说共 9 件」会悄悄分叉，而两个数字都不会报错。
func artifactWhere(f domain.ArtifactFilter) (string, []any) {
	var conds []string
	var args []any

	if f.ObjectID != "" {
		conds = append(conds, `a.object_id = ?`)
		args = append(args, f.ObjectID)
	}
	if f.Unscoped {
		conds = append(conds, `a.object_id IS NULL`)
	}
	if f.SessionID != "" {
		conds = append(conds, `a.session_id = ?`)
		args = append(args, f.SessionID)
	}
	if f.RunID != "" {
		conds = append(conds, `a.run_id = ?`)
		args = append(args, f.RunID)
	}
	if f.Platform != "" {
		conds = append(conds, `a.platform = ?`)
		args = append(args, f.Platform)
	}
	if f.Source != "" {
		conds = append(conds, `a.source = ?`)
		args = append(args, f.Source)
	}
	for _, c := range []struct{ col, v string }{
		{"kind", f.Kind}, {"status", f.Status},
		{"actor_type", f.ActorType}, {"actor_id", f.ActorID},
		{"scope_type", f.ScopeType},
	} {
		if c.v != "" {
			conds = append(conds, `a.`+c.col+` = ?`)
			args = append(args, c.v)
		}
	}
	// scope_id 离开 scope_type 没有意义：不同模块的 id 可能撞上。
	if f.ScopeType != "" && f.ScopeID != "" {
		conds = append(conds, `a.scope_id = ?`)
		args = append(args, f.ScopeID)
	}
	// 三态：nil 不过滤，true 要求非空，false 要求为空。
	// 「只看还没发出去的本地文件」就是 HasURL=false，这是用户真会问的一个问题，
	// 所以不能用「零值即不过滤」的 bool。
	if f.HasURL != nil {
		if *f.HasURL {
			conds = append(conds, `a.url <> ''`)
		} else {
			conds = append(conds, `a.url = ''`)
		}
	}
	if f.HasPath != nil {
		if *f.HasPath {
			conds = append(conds, `a.path <> ''`)
		} else {
			conds = append(conds, `a.path = ''`)
		}
	}
	// 时间区间、归属对象的类型和项目（TSK-0497）。created_at 是定宽的纳秒 UTC 串，按字符串比就是按时间比。
	if f.Since != nil {
		conds = append(conds, `a.created_at >= ?`)
		args = append(args, f.Since.UTC().Format(artifactTimeLayout))
	}
	if f.Until != nil {
		conds = append(conds, `a.created_at <= ?`)
		args = append(args, f.Until.UTC().Format(artifactTimeLayout))
	}
	if f.ObjectType != "" {
		conds = append(conds, `a.object_id IN (SELECT id FROM objects WHERE type_id = ?)`)
		args = append(args, f.ObjectType)
	}
	switch f.ProjectID {
	case "":
	case "-":
		conds = append(conds, `a.object_id IN (SELECT id FROM objects WHERE project_id IS NULL)`)
	default:
		conds = append(conds, `a.object_id IN (SELECT id FROM objects WHERE project_id = ?)`)
		args = append(args, f.ProjectID)
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		// 关键词同时扫标题、路径、链接和备注：用户记得住的可能是文件名，
		// 也可能是那个 Confluence 页面的标题，还可能只记得链接里的一段。
		// 用四个 ? 而不是 ?1：?1 指的是第一个参数，前面有别的条件时会对错位。
		conds = append(conds, `(a.title LIKE ? OR a.path LIKE ? OR a.url LIKE ? OR a.note LIKE ?)`)
		like := "%" + q + "%"
		args = append(args, like, like, like, like)
	}

	if len(conds) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// ListArtifacts 返回产物，最近登记的在前。total 不含分页，产物页靠它显示「共 N 件」。
func (s *Store) ListArtifacts(ctx context.Context, f domain.ArtifactFilter) ([]*domain.Artifact, int, error) {
	where, args := artifactWhere(f)

	var total int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM artifacts a`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count artifacts: %w", err)
	}

	limit := f.Limit
	if limit <= 0 {
		limit = store.DefaultArtifactLimit
	}
	// tiebreak 用 rowid 而不是 id，理由同 ListTaskRuns：id 只到毫秒有序，
	// 同毫秒内低位是随机数。纳秒时间戳让撞车概率极低但没消除它。
	q := artifactSelect + where + ` ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`
	args = append(args, limit, f.Offset)

	rows, err := s.db.R.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list artifacts: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// 初始化成空切片而不是 nil：Go 的 nil 切片序列化成 null，前端拿到
	// null.map(...) 直接白屏，而这在「一件产物都还没有」时必然发生。
	out := []*domain.Artifact{}
	for rows.Next() {
		a, err := scanArtifact(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("scan artifact: %w", err)
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

func (s *Store) GetArtifact(ctx context.Context, id string) (*domain.Artifact, error) {
	row := s.db.R.QueryRowContext(ctx, artifactSelect+` WHERE a.id = ?`, id)
	a, err := scanArtifact(row)
	if err == sql.ErrNoRows {
		return nil, notFound("artifact")
	}
	if err != nil {
		return nil, fmt.Errorf("get artifact: %w", err)
	}
	return a, nil
}

// detectPlatform 按域名特征认出链接属于哪个平台，依据是字典
// artifact_platform 的 meta.hosts。
//
// **这件事必须在后端做。**放在前端的话，四条登记渠道里只有「界面手工登记」
// 那一条会经过它——MCP 回写、Agent 写盘、执行扫目录全都落进「其他」。
// 统计页最有用的那一列（东西都发到哪儿去了）就此失效，而它不会报错，
// 只会显示成「大部分产物的平台是：其他」。
//
// 认不出来返回 "other" 而不是空：空平台在统计页上是一个没有名字的分组。
func (s *Store) detectPlatform(ctx context.Context, rawURL string) string {
	u := strings.ToLower(strings.TrimSpace(rawURL))
	if u == "" {
		return ""
	}
	rows, err := s.db.R.QueryContext(ctx,
		`SELECT key, meta FROM dict_items
		  WHERE dict_id = ? AND archived_at IS NULL ORDER BY sort_order`,
		domain.DictArtifactPlatform)
	if err != nil {
		return "other"
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var key, metaRaw string
		if err := rows.Scan(&key, &metaRaw); err != nil {
			return "other"
		}
		var meta struct {
			Hosts []string `json:"hosts"`
		}
		if json.Unmarshal([]byte(metaRaw), &meta) != nil {
			continue
		}
		for _, h := range meta.Hosts {
			// 空串会匹配任何链接，把第一个带空 hosts 的平台变成万能匹配。
			// 种子数据里不会有（有测试守着），但用户能在字典页手填。
			h = strings.ToLower(strings.TrimSpace(h))
			if h != "" && strings.Contains(u, h) {
				return key
			}
		}
	}
	return "other"
}

// normalizeArtifact 收口所有入库前的整理与校验，Create 和 Record 共用。
//
// 分两个入口但共用这里：两处各写一遍校验的话，其中一处漏掉 source 白名单
// 不会有任何东西变红——直到统计页上多出一个拼错的分组。
func normalizeArtifact(in *domain.ArtifactInput) error {
	in.Title = strings.TrimSpace(in.Title)
	in.Path = strings.TrimSpace(in.Path)
	in.BaseDir = strings.TrimSpace(in.BaseDir)
	in.URL = strings.TrimSpace(in.URL)
	in.Platform = strings.TrimSpace(in.Platform)
	in.Note = strings.TrimSpace(in.Note)

	// 调用方给相对路径 + 基准目录时替它拼成绝对路径。agent 写盘那条路上
	// 天然就是「workdir + 相对路径」，让每个调用方各拼一次只会各拼错一次。
	if in.Path != "" && !filepath.IsAbs(in.Path) && in.BaseDir != "" {
		in.Path = filepath.Join(in.BaseDir, in.Path)
	}
	if in.Path != "" {
		in.Path = filepath.Clean(in.Path)
	}
	if in.BaseDir != "" {
		in.BaseDir = filepath.Clean(in.BaseDir)
	}

	if in.Path == "" && in.URL == "" {
		// 库里有 CHECK 兜底，但那条报错是「CHECK constraint failed」，
		// 传到界面上用户看不懂。在这里拦一次给得出人话。
		return validation("path", "本地路径和链接至少要有一个")
	}
	if in.Source == "" {
		in.Source = domain.ArtifactSourceManual
	}
	if !artifactSources[in.Source] {
		return validation("source", "未知的产物来源："+in.Source)
	}
	in.Kind = strings.TrimSpace(in.Kind)
	in.Status = strings.TrimSpace(in.Status)
	in.ActorType = strings.TrimSpace(in.ActorType)
	in.ActorID = strings.TrimSpace(in.ActorID)
	in.ActorLabel = strings.TrimSpace(in.ActorLabel)
	in.ScopeType = strings.TrimSpace(in.ScopeType)
	in.ScopeID = strings.TrimSpace(in.ScopeID)
	if in.ActorType == "" {
		in.ActorType = actorOfSource(in.Source)
	}
	if !artifactActors[in.ActorType] {
		return validation("actor_type", "未知的产出者类型："+in.ActorType)
	}
	if !artifactStatuses[in.Status] {
		return validation("status", "未知的产物状态："+in.Status)
	}
	if err := checkArtifactScope(in.ScopeType, in.ScopeID); err != nil {
		return err
	}
	// 平台留给调用方补：只有本地路径就是本地文件，有链接的交给 detectPlatform
	// 按域名认。这里不能认，因为认平台要查字典、要 ctx。
	if in.Platform == "" && in.URL == "" {
		in.Platform = "local"
	}
	// 标题空就用文件名兜底，列表里不会出现一行没有名字的记录。
	if in.Title == "" {
		if in.Path != "" {
			in.Title = filepath.Base(in.Path)
		} else {
			in.Title = in.URL
		}
	}
	return nil
}

// checkArtifactScope 要求 scope_type 和 scope_id 同时有或同时空：只有一半的归属
// 查不到、也挂不回去。
func checkArtifactScope(typ, id string) error {
	if (typ == "") != (id == "") {
		return validation("scope_type", "scope_type 和 scope_id 要同时给")
	}
	return nil
}

// checkArtifactKind 要求 kind 是字典 artifact_kind 里启用的条目。
// 不校验的话拼错的种类会安静入库，在筛选和统计里多出一个谁也认不得的分组。
func (s *Store) checkArtifactKind(ctx context.Context, kind string) error {
	if kind == "" {
		return nil
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dict_items WHERE dict_id = ? AND key = ? AND archived_at IS NULL`,
		domain.DictArtifactKind, kind).Scan(&n); err != nil {
		return fmt.Errorf("check artifact kind: %w", err)
	}
	if n == 0 {
		return validation("kind", "未知的产物种类："+kind)
	}
	return nil
}

// settleArtifactKind 定下入库的 kind（TSK-0497）：调用方给了就校验；没给就按备注、链接、平台、
// 扩展名推一个（domain.InferArtifactKind）。推出来的种类在字典里被停用了就留空，不因此拒掉登记——
// 调用方没要求种类，为一个推断出来的值报 400 只会让人困惑。
// 平台要先定下来（只有链接时按平台推），所以放在 detectPlatform 之后调。
func (s *Store) settleArtifactKind(ctx context.Context, in *domain.ArtifactInput) error {
	if in.Kind != "" {
		return s.checkArtifactKind(ctx, in.Kind)
	}
	k := domain.InferArtifactKind(in.Note, in.URL, in.Platform, in.Path)
	if err := s.checkArtifactKind(ctx, k); err != nil {
		if errors.Is(err, domain.ErrValidation) {
			return nil
		}
		return err
	}
	in.Kind = k
	return nil
}

func encodeArtifactProps(p map[string]any) (string, error) {
	if p == nil {
		return "{}", nil
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", validation("props", "props 不是合法的 JSON 对象")
	}
	return string(b), nil
}

// fillSize 在调用方没给大小时去读一下文件。
//
// 不读的话，手工登记的本地文件 size 恒为 0，「本地占用」这个统计永远显示 0 B——
// 一个永远是 0 的数字比不显示更糟，因为它看起来像是算过的。
// 读不到（路径打错、文件还没产出、没权限）就保持 0，不报错：
// 为了一个附属信息把整条登记拒掉，只会让用户干脆不登记。
func fillSize(in *domain.ArtifactInput) {
	if in.Path == "" || in.Size != 0 {
		return
	}
	if st, err := os.Stat(in.Path); err == nil && !st.IsDir() {
		in.Size = st.Size()
	}
}

func (s *Store) insertArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	props, err := encodeArtifactProps(in.Props)
	if err != nil {
		return nil, err
	}
	id := idgen.Prefixed("art")
	now := nowArtifact()
	_, err = s.db.W.ExecContext(ctx, `INSERT INTO artifacts
		(id, object_id, session_id, run_id, title, path, base_dir, url, platform,
		 size, source, note, created_at, updated_at,
		 kind, status, actor_type, actor_id, actor_label, scope_type, scope_id, props)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, ptrArg(in.ObjectID), ptrArg(in.SessionID), ptrArg(in.RunID),
		in.Title, in.Path, in.BaseDir, in.URL, in.Platform,
		in.Size, in.Source, in.Note, now, now,
		in.Kind, in.Status, in.ActorType, in.ActorID, in.ActorLabel,
		in.ScopeType, in.ScopeID, props)
	if err != nil {
		return nil, fmt.Errorf("insert artifact: %w", err)
	}
	return s.GetArtifact(ctx, id)
}

// CreateArtifact 是手工登记的入口，不去重。
// 同一个本地文件先发 Confluence 再发飞书，那是两条合理的记录。
func (s *Store) CreateArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	if err := normalizeArtifact(&in); err != nil {
		return nil, err
	}
	if in.Platform == "" {
		in.Platform = s.detectPlatform(ctx, in.URL)
	}
	if err := s.settleArtifactKind(ctx, &in); err != nil {
		return nil, err
	}
	fillSize(&in)
	return s.insertArtifact(ctx, in)
}

// RecordArtifact 是自动来源的入口：同一来源范围内路径相同就更新，不新增。
//
// 「同一来源范围」= 同一会话，或同一次执行。跨范围不去重：两次执行都改了
// 同一个文件，那是两次产出，合并掉就看不出第二次跑过。这两个范围和 0012 里的
// 两个部分唯一索引一一对应——代码里的去重逻辑和库里的约束必须是同一个口径，
// 否则要么插入报错、要么留下索引拦不住的重复。
func (s *Store) RecordArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	if err := normalizeArtifact(&in); err != nil {
		return nil, err
	}
	if in.Platform == "" {
		in.Platform = s.detectPlatform(ctx, in.URL)
	}
	if err := s.settleArtifactKind(ctx, &in); err != nil {
		return nil, err
	}
	fillSize(&in)

	// 只有带范围且有本地路径时才查重复；纯链接的产物没有对应的唯一索引，
	// 查了也是在一个没有约束保护的维度上去重，给人一种假的确定性。
	var scopeCol, scopeVal string
	switch {
	case in.SessionID != nil && *in.SessionID != "":
		scopeCol, scopeVal = "session_id", *in.SessionID
	case in.RunID != nil && *in.RunID != "":
		scopeCol, scopeVal = "run_id", *in.RunID
	}

	if scopeCol != "" && in.Path != "" {
		var id string
		err := s.db.R.QueryRowContext(ctx,
			`SELECT id FROM artifacts WHERE `+scopeCol+` = ? AND path = ?`,
			scopeVal, in.Path).Scan(&id)
		switch {
		case err == nil:
			// 覆盖写同一个文件：更新大小和时间，不新增一行。
			// 不这么做的话，反复改一份文档会在产物列表里堆出十几行同名记录
			// ——这是 0007 当初加唯一索引要解决的问题，一并继承过来。
			if _, err := s.db.W.ExecContext(ctx,
				`UPDATE artifacts SET size = ?, updated_at = ? WHERE id = ?`,
				in.Size, nowArtifact(), id); err != nil {
				return nil, fmt.Errorf("update artifact: %w", err)
			}
			return s.GetArtifact(ctx, id)
		case err != sql.ErrNoRows:
			return nil, fmt.Errorf("lookup artifact: %w", err)
		}
	}
	return s.insertArtifact(ctx, in)
}

func (s *Store) UpdateArtifact(ctx context.Context, id string, p domain.ArtifactPatch) (*domain.Artifact, error) {
	cur, err := s.GetArtifact(ctx, id)
	if err != nil {
		return nil, err
	}

	var sets []string
	var args []any
	// ObjectID 是 **string：nil 不改，指向 nil 清空归属，指向值改挂过去。
	// 少这一层的话「移出某个对象」和「不动它」在 JSON 里长得一模一样。
	if p.ObjectID != nil {
		sets = append(sets, "object_id = ?")
		args = append(args, ptrArg(*p.ObjectID))
	}
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, strings.TrimSpace(*p.Title))
	}
	if p.Path != nil {
		sets = append(sets, "path = ?")
		args = append(args, strings.TrimSpace(*p.Path))
	}
	if p.BaseDir != nil {
		sets = append(sets, "base_dir = ?")
		args = append(args, strings.TrimSpace(*p.BaseDir))
	}
	if p.URL != nil {
		sets = append(sets, "url = ?")
		args = append(args, strings.TrimSpace(*p.URL))
	}
	if p.Platform != nil {
		sets = append(sets, "platform = ?")
		args = append(args, strings.TrimSpace(*p.Platform))
	}
	if p.Note != nil {
		sets = append(sets, "note = ?")
		args = append(args, strings.TrimSpace(*p.Note))
	}
	if p.Kind != nil {
		k := strings.TrimSpace(*p.Kind)
		if err := s.checkArtifactKind(ctx, k); err != nil {
			return nil, err
		}
		sets = append(sets, "kind = ?")
		args = append(args, k)
	}
	if p.Status != nil {
		st := strings.TrimSpace(*p.Status)
		if !artifactStatuses[st] {
			return nil, validation("status", "未知的产物状态："+st)
		}
		sets = append(sets, "status = ?")
		args = append(args, st)
	}
	if p.ScopeType != nil || p.ScopeID != nil {
		typ, sid := cur.ScopeType, cur.ScopeID
		if p.ScopeType != nil {
			typ = strings.TrimSpace(*p.ScopeType)
		}
		if p.ScopeID != nil {
			sid = strings.TrimSpace(*p.ScopeID)
		}
		if err := checkArtifactScope(typ, sid); err != nil {
			return nil, err
		}
		sets = append(sets, "scope_type = ?", "scope_id = ?")
		args = append(args, typ, sid)
	}
	if p.Props != nil {
		props, err := encodeArtifactProps(*p.Props)
		if err != nil {
			return nil, err
		}
		sets = append(sets, "props = ?")
		args = append(args, props)
	}
	if len(sets) == 0 {
		return cur, nil
	}

	// 先在内存里算出改完之后的样子再校验。直接交给库里的 CHECK 的话，
	// 「把唯一的链接清空、而这条本来就没有本地路径」会返回一句
	// CHECK constraint failed，用户看不懂自己做错了什么。
	after := *cur
	if p.Path != nil {
		after.Path = strings.TrimSpace(*p.Path)
	}
	if p.URL != nil {
		after.URL = strings.TrimSpace(*p.URL)
	}
	if after.Path == "" && after.URL == "" {
		return nil, validation("path", "本地路径和链接至少要留一个")
	}

	sets = append(sets, "updated_at = ?")
	args = append(args, nowArtifact(), id)
	if _, err := s.db.W.ExecContext(ctx,
		`UPDATE artifacts SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, fmt.Errorf("update artifact: %w", err)
	}
	return s.GetArtifact(ctx, id)
}

// DeleteArtifact 只删这条登记记录，**不碰磁盘上的文件，也不碰云端的页面**。
// 产物表是一份索引，不是存储；删索引不该删被索引的东西。
func (s *Store) DeleteArtifact(ctx context.Context, id string) error {
	res, err := s.db.W.ExecContext(ctx, `DELETE FROM artifacts WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete artifact: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return notFound("artifact")
	}
	return nil
}

// ArtifactStats 走和 ListArtifacts 同一个 WHERE，见 artifactWhere 的注释。
func (s *Store) ArtifactStats(ctx context.Context, f domain.ArtifactFilter) (*domain.ArtifactStats, error) {
	where, args := artifactWhere(f)

	st := &domain.ArtifactStats{
		// map 必须初始化：Go 的 nil map 序列化成 null，前端
		// Object.entries(null) 直接抛异常，而这在库里一条产物都没有时必然发生。
		ByPlatform: map[string]int{},
		BySource:   map[string]int{},
		ByKind:     map[string]int{},
	}

	// Local 和 Remote 相加可能大于 Total——一份既在本地又发了云端的产物两边都算。
	// 这是有意的：它回答的是「有多少落在本地」和「有多少已经发出去了」，
	// 不是一次互斥划分。TotalSize 只累加有本地路径的，云端产物的 size 恒为 0，
	// 混进去会让「平均每件多大」这类数变得毫无意义。
	row := s.db.R.QueryRowContext(ctx, `SELECT
		COUNT(*),
		COALESCE(SUM(CASE WHEN a.path <> '' THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN a.url  <> '' THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN a.object_id IS NULL THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN a.path <> '' THEN a.size ELSE 0 END), 0)
		FROM artifacts a`+where, args...)
	if err := row.Scan(&st.Total, &st.Local, &st.Remote, &st.Unscoped, &st.TotalSize); err != nil {
		return nil, fmt.Errorf("artifact stats: %w", err)
	}

	for _, g := range []struct {
		col string
		dst map[string]int
	}{{"platform", st.ByPlatform}, {"source", st.BySource}, {"kind", st.ByKind}} {
		rows, err := s.db.R.QueryContext(ctx,
			`SELECT a.`+g.col+`, COUNT(*) FROM artifacts a`+where+` GROUP BY a.`+g.col, args...)
		if err != nil {
			return nil, fmt.Errorf("artifact stats by %s: %w", g.col, err)
		}
		for rows.Next() {
			var k string
			var n int
			if err := rows.Scan(&k, &n); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan artifact stats: %w", err)
			}
			g.dst[k] = n
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return st, nil
}

// ArtifactsByObject 按归属对象汇总产物（TSK-0497）。
//
// 和 ArtifactStats 走同一个 artifactWhere，但 kind、source 两个条件不进 SQL：
//   - kind 要按 display_kind 比——历史上没填 kind 的那批（Claude Code 执行扫出来的）
//     在库里是空串，SQL 里比 a.kind 会把它们全漏掉，而漏掉的数字看起来完全正常；
//   - 两者的分面计数（by_kind / by_source）各自不受自己那个条件影响，按钮上的数才不会一点就变成只剩一个。
//
// 只算挂在对象上且对象没进回收站的；未归属的产物不属于任何一行。
// 一次把满足条件的产物逐行读出来在内存里聚合：只读几列短字段，几千条也就几百 KB，
// 换来推断口径只有 Go 这一份。
func (s *Store) ArtifactsByObject(ctx context.Context, f domain.ArtifactFilter) (*domain.ArtifactsByObject, error) {
	kind, source := f.Kind, f.Source
	g := f
	g.Kind, g.Source, g.Limit, g.Offset = "", "", 0, 0
	where, args := artifactWhere(g)

	rows, err := s.db.R.QueryContext(ctx, `SELECT a.object_id, a.kind, a.note, a.url, a.platform, a.path,
		a.source, a.created_at, o.ref, o.title, o.type_id, o.status, o.project_id, COALESCE(p.title, ''), o.completed_at
		FROM artifacts a
		JOIN objects o ON o.id = a.object_id AND o.deleted_at IS NULL
		LEFT JOIN objects p ON p.id = o.project_id`+where, args...)
	if err != nil {
		return nil, fmt.Errorf("artifacts by object: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := &domain.ArtifactsByObject{
		// 同 ArtifactStats：nil 切片和 nil map 序列化成 null，前端一 map 就白屏
		Objects:  []domain.ArtifactObjectSummary{},
		ByKind:   map[string]int{},
		BySource: map[string]int{},
	}
	idx := map[string]int{}
	for rows.Next() {
		var (
			a                 domain.Artifact
			objID             string
			created           string
			ref, title, typ   string
			status, projTitle string
			projID, completed sql.NullString
		)
		if err := rows.Scan(&objID, &a.Kind, &a.Note, &a.URL, &a.Platform, &a.Path, &a.Source, &created,
			&ref, &title, &typ, &status, &projID, &projTitle, &completed); err != nil {
			return nil, fmt.Errorf("scan artifacts by object: %w", err)
		}
		k := domain.DisplayKindOf(&a)
		kindOK := kind == "" || k == kind
		sourceOK := source == "" || a.Source == source
		if sourceOK {
			out.ByKind[k]++
		}
		if kindOK {
			out.BySource[a.Source]++
		}
		if !kindOK || !sourceOK {
			continue
		}
		at := parseTime(created)
		i, ok := idx[objID]
		if !ok {
			sum := domain.ArtifactObjectSummary{
				ObjectID: objID, ObjectRef: ref, ObjectTitle: title, ObjectType: typ, Status: status,
				ProjectID: nullStrPtr(projID), ProjectTitle: projTitle,
				ByKind: map[string]int{}, BySource: map[string]int{}, LastAt: at,
			}
			if completed.Valid && completed.String != "" {
				t := parseTime(completed.String)
				sum.CompletedAt = &t
			}
			out.Objects = append(out.Objects, sum)
			i = len(out.Objects) - 1
			idx[objID] = i
		}
		o := &out.Objects[i]
		o.Total++
		o.ByKind[k]++
		o.BySource[a.Source]++
		if at.After(o.LastAt) {
			o.LastAt = at
		}
		out.Total++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 最近有产出的在前；同一时刻按编号，顺序稳定
	sort.SliceStable(out.Objects, func(i, j int) bool {
		a, b := out.Objects[i], out.Objects[j]
		if !a.LastAt.Equal(b.LastAt) {
			return a.LastAt.After(b.LastAt)
		}
		return a.ObjectRef > b.ObjectRef
	})
	return out, nil
}
