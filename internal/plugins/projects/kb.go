// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目知识库（TSK-0721）：每个项目绑定一个知识库（表 projects_kb，插件迁移 0012），把项目资料同步进去。
//   - 绑定：GET/PUT /api/projects/{id}/kb；项目设置里换绑、新建、解绑，可同时挂到项目默认 Agent（props.agent_ids 第一个）。
//   - 同步：SOP 节点 projects_kb_sync（项目留空或「全部」是所有没归档的项目）和 POST /api/projects/{id}/kb/sync。
//     没绑知识库（或绑的被删了）时按「<项目名> 项目知识库」新建、绑定，并挂到项目默认 Agent。
//   - 来源：项目资料里的本机文件和文件夹、笔记、链接（只收标题和备注，不联网抓网页正文），挂在项目下的工作台文档，
//     项目设置里的文档目录（props.docs_dir，TSK-0718，解析同内核 projectDocsDir）。
//   - 增量：交给内核 Core.Knowledge().Sync，知识库里 origin 为 projects:<项目 id> 的篇目和这次的资料对齐；人工加的不动。
// 内置流程「每周一 10:00 整理项目知识库」由后台任务写进 SOP，定时任务建成停用的，用户确认后启用。

const (
	NodeKBSync = "projects_kb_sync"
	// KBFlowID 是内置流程「每周一 10:00 整理项目知识库」的 id。
	KBFlowID = "sop_projects_kb_weekly"
	// kbAll 是节点「项目」配置里表示所有项目的写法（另认留空、all）。
	kbAll = "全部"
	// propAgentIDs、propDocsDir 是项目 props 里默认 Agent 列表、文档目录的 key（同前端、内核）。
	propAgentIDs = "agent_ids"
	propDocsDir  = "docs_dir"
	maxKBName    = 100
)

// kbTemplateEvery 是多久试一次写内置流程；测试里调小。
var kbTemplateEvery = time.Minute

// kbSources 是这次收哪几类资料。
type kbSources struct {
	Files   bool `json:"files"`    // 项目资料里的本机文件和文件夹
	Notes   bool `json:"notes"`    // 项目资料里的笔记
	Links   bool `json:"links"`    // 项目资料里的链接（标题和备注）
	Docs    bool `json:"docs"`     // 挂在项目下的工作台文档
	DocsDir bool `json:"docs_dir"` // 项目设置里的文档目录
}

var allSources = kbSources{Files: true, Notes: true, Links: true, Docs: true, DocsDir: true}

// ProjectKBSync 是一个项目一次同步的结果：节点输出 kb_sync.projects 的一项，POST .../kb/sync 的响应，项目设置里的「上次同步」。
type ProjectKBSync struct {
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
	Ref       string `json:"ref"`
	KbID      string `json:"kb_id"`
	KbName    string `json:"kb_name"`
	// Created 是这次新建并绑定了知识库
	Created   bool `json:"created"`
	Added     int  `json:"added"`
	Updated   int  `json:"updated"`
	Removed   int  `json:"removed"`
	Unchanged int  `json:"unchanged"`
	Skipped   int  `json:"skipped"`
	Failed    int  `json:"failed"`
	// Failures、Skips 是失败、跳过的资料和原因，各最多 50 条
	Failures []plugin.KBProblem `json:"failures"`
	Skips    []plugin.KBProblem `json:"skips"`
	// Sources 是这次交给知识库的资料条数：files、folders、notes、links、docs、docs_dir
	Sources map[string]int `json:"sources"`
	// Error 是整个项目没同步成的原因（建不了知识库、知识库正在同步……），成了为空串
	Error string    `json:"error"`
	At    time.Time `json:"at"`
}

// ProjectKB 是 GET /api/projects/{id}/kb：绑定的知识库和上次同步。
type ProjectKB struct {
	ProjectID string `json:"project_id"`
	// KbID 是绑定的知识库 id，没绑为空串；KB 是它的名称、篇数、挂着它的 Agent，没绑或已删为 null
	KbID string                    `json:"kb_id"`
	KB   *plugin.KnowledgeBaseInfo `json:"kb"`
	// Missing 是绑了但知识库已经删了
	Missing     bool `json:"missing"`
	AutoCreated bool `json:"auto_created"`
	// DefaultAgentID 是项目默认 Agent（props.agent_ids 第一个），没有为空串；AgentAttached 是它挂上了这个知识库
	DefaultAgentID string         `json:"default_agent_id"`
	AgentAttached  bool           `json:"agent_attached"`
	LastSyncAt     *time.Time     `json:"last_sync_at"`
	LastResult     *ProjectKBSync `json:"last_result"`
}

type kbService struct {
	c plugin.Core
	h *stakeholders
	// mu 防同一项目同时建两个知识库（节点和「立即同步」撞上）
	mu sync.Mutex
}

func newKBService(c plugin.Core, h *stakeholders) *kbService { return &kbService{c: c, h: h} }

func (s *kbService) register(r plugin.Registrar) {
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/projects/{id}/kb", s.show)
		m.HandleFunc("PUT /api/projects/{id}/kb", s.bind)
		m.HandleFunc("POST /api/projects/{id}/kb/sync", s.syncNow)
	})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeKBSync, Group: "项目", Run: s.node})
	r.Job(plugin.Job{Name: "kb_flow_template", Every: kbTemplateEvery, Run: func(ctx context.Context, c plugin.Core) error {
		return installKBTemplate(ctx, c)
	}})
}

/* ---------- 绑定 ---------- */

type kbRow struct {
	KbID        string
	AutoCreated bool
	LastSyncAt  *time.Time
	LastResult  *ProjectKBSync
}

func (s *kbService) row(ctx context.Context, pid string) (*kbRow, error) {
	var r kbRow
	var last *string
	var result string
	err := s.c.Store().QueryRow(ctx, `SELECT kb_id, auto_created, last_sync_at, last_result FROM projects_kb WHERE project_id = ?`, pid).
		Scan(&r.KbID, &r.AutoCreated, &last, &result)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.LastSyncAt = parseTimePtr(last)
	if r.LastSyncAt != nil {
		var res ProjectKBSync
		if json.Unmarshal([]byte(result), &res) == nil {
			r.LastResult = &res
		}
	}
	return &r, nil
}

func (s *kbService) saveBinding(ctx context.Context, pid, kbID string, auto bool) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.c.Store().Exec(ctx, `INSERT INTO projects_kb (project_id, kb_id, auto_created, last_result, created_at, updated_at)
		VALUES (?, ?, ?, '{}', ?, ?)
		ON CONFLICT (project_id) DO UPDATE SET kb_id = excluded.kb_id, auto_created = excluded.auto_created, updated_at = excluded.updated_at`,
		pid, kbID, auto, now, now)
	return err
}

func defaultAgent(o plugin.ObjectInfo) string {
	if ids, ok := o.Props[propAgentIDs].([]any); ok && len(ids) > 0 {
		if id, ok := ids[0].(string); ok {
			return strings.TrimSpace(id)
		}
	}
	return ""
}

func (s *kbService) view(ctx context.Context, o plugin.ObjectInfo) (ProjectKB, error) {
	out := ProjectKB{ProjectID: o.ID, DefaultAgentID: defaultAgent(o)}
	r, err := s.row(ctx, o.ID)
	if err != nil || r == nil {
		return out, err
	}
	out.KbID, out.AutoCreated, out.LastSyncAt, out.LastResult = r.KbID, r.AutoCreated, r.LastSyncAt, r.LastResult
	info, err := s.c.Knowledge().Get(ctx, r.KbID)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		out.Missing = true
	case err != nil:
		return out, err
	default:
		out.KB = &info
		for _, a := range info.Agents {
			if a == out.DefaultAgentID {
				out.AgentAttached = true
			}
		}
	}
	return out, nil
}

func (s *kbService) projectObj(ctx context.Context, id string) (plugin.ObjectInfo, error) {
	o, err := s.c.Objects().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Type != "project" || o.Deleted)) {
		return o, apiErr(errNotFound, "project not found")
	}
	return o, err
}

func (s *kbService) show(w http.ResponseWriter, r *http.Request) {
	o, err := s.projectObj(r.Context(), r.PathValue("id"))
	if err != nil {
		s.h.fail(w, r, err)
		return
	}
	v, err := s.view(r.Context(), o)
	if err != nil {
		s.h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// kbBindInput 是 PUT /api/projects/{id}/kb：kb_id 换绑（空串解绑），create 新建并绑定，attach_agent 挂到项目默认 Agent，至少给一项。
type kbBindInput struct {
	KbID        *string `json:"kb_id"`
	Create      bool    `json:"create"`
	Name        string  `json:"name"`
	AttachAgent bool    `json:"attach_agent"`
}

func kbName(project string) string {
	if r := []rune(strings.TrimSpace(project)); len(r) > maxKBName-6 {
		project = string(r[:maxKBName-7]) + "…"
	}
	return strings.TrimSpace(project) + " 项目知识库"
}

func (s *kbService) bind(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	o, err := s.projectObj(ctx, r.PathValue("id"))
	if err != nil {
		s.h.fail(w, r, err)
		return
	}
	var in kbBindInput
	if err := decode(r, &in); err != nil {
		s.h.fail(w, r, err)
		return
	}
	switch {
	case in.Create && in.KbID != nil:
		s.h.fail(w, r, apiErr(errValidation, "kb_id 和 create 只能给一个"))
		return
	case !in.Create && in.KbID == nil && !in.AttachAgent:
		s.h.fail(w, r, apiErr(errValidation, "给 kb_id（换绑，空串解绑）、create（新建）或 attach_agent（挂到项目默认 Agent）"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case in.Create:
		name := strings.TrimSpace(in.Name)
		if name == "" {
			name = kbName(o.Title)
		}
		if utf8.RuneCountInString(name) > maxKBName {
			s.h.fail(w, r, apiErr(errValidation, "名称最多 %d 字", maxKBName))
			return
		}
		info, err := s.c.Knowledge().Create(ctx, name, "项目「"+o.Title+"」的资料，由「项目资料同步到知识库」整理")
		if err != nil {
			s.h.fail(w, r, apiErr(errValidation, "%s", err.Error()))
			return
		}
		if err := s.saveBinding(ctx, o.ID, info.ID, false); err != nil {
			s.h.fail(w, r, err)
			return
		}
	case in.KbID != nil && strings.TrimSpace(*in.KbID) == "":
		if _, err := s.c.Store().Exec(ctx, `DELETE FROM projects_kb WHERE project_id = ?`, o.ID); err != nil {
			s.h.fail(w, r, err)
			return
		}
	case in.KbID != nil:
		info, err := s.c.Knowledge().Get(ctx, strings.TrimSpace(*in.KbID))
		if errors.Is(err, plugin.ErrNoRows) {
			s.h.fail(w, r, apiErr(errValidation, "知识库 %s 不存在", strings.TrimSpace(*in.KbID)))
			return
		}
		if err != nil {
			s.h.fail(w, r, err)
			return
		}
		cur, err := s.row(ctx, o.ID)
		if err != nil {
			s.h.fail(w, r, err)
			return
		}
		if cur == nil || cur.KbID != info.ID {
			if err := s.saveBinding(ctx, o.ID, info.ID, false); err != nil {
				s.h.fail(w, r, err)
				return
			}
		}
	}
	if in.AttachAgent {
		cur, err := s.row(ctx, o.ID)
		if err != nil {
			s.h.fail(w, r, err)
			return
		}
		agent := defaultAgent(o)
		switch {
		case cur == nil:
			s.h.fail(w, r, apiErr(errValidation, "这个项目还没绑知识库"))
			return
		case agent == "":
			s.h.fail(w, r, apiErr(errValidation, "这个项目没有设 Agent，在项目的 Agent 标签里加一个"))
			return
		}
		if _, err := s.c.Knowledge().AttachAgent(ctx, agent, cur.KbID); errors.Is(err, plugin.ErrNoRows) {
			s.h.fail(w, r, apiErr(errValidation, "项目默认 Agent 或绑定的知识库已经不在了"))
			return
		} else if err != nil {
			s.h.fail(w, r, err)
			return
		}
	}
	v, err := s.view(ctx, o)
	if err != nil {
		s.h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// syncNow 是 POST /api/projects/{id}/kb/sync：body 可省，{files?, notes?, links?, docs?, docs_dir?} 不给的按收。
func (s *kbService) syncNow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	o, err := s.projectObj(ctx, r.PathValue("id"))
	if err != nil {
		s.h.fail(w, r, err)
		return
	}
	src := allSources
	var in struct {
		Files   *bool `json:"files"`
		Notes   *bool `json:"notes"`
		Links   *bool `json:"links"`
		Docs    *bool `json:"docs"`
		DocsDir *bool `json:"docs_dir"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &in); err != nil {
			s.h.fail(w, r, err)
			return
		}
	}
	for _, p := range []struct {
		v   *bool
		dst *bool
	}{{in.Files, &src.Files}, {in.Notes, &src.Notes}, {in.Links, &src.Links}, {in.Docs, &src.Docs}, {in.DocsDir, &src.DocsDir}} {
		if p.v != nil {
			*p.dst = *p.v
		}
	}
	// 大目录同步要一阵子：和浏览器连接脱钩，页面关了也跑完（同 POST /api/knowledge-bases/{id}/sync）
	res := s.syncProject(context.WithoutCancel(ctx), o, src)
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

/* ---------- 同步 ---------- */

// ensureKB 取项目绑定的知识库；没绑或绑的被删了就新建、绑定，并挂到项目默认 Agent（挂不上不算失败）。
func (s *kbService) ensureKB(ctx context.Context, o plugin.ObjectInfo) (plugin.KnowledgeBaseInfo, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.row(ctx, o.ID)
	if err != nil {
		return plugin.KnowledgeBaseInfo{}, false, err
	}
	if r != nil {
		info, err := s.c.Knowledge().Get(ctx, r.KbID)
		if !errors.Is(err, plugin.ErrNoRows) {
			return info, false, err
		}
	}
	info, err := s.c.Knowledge().Create(ctx, kbName(o.Title), "项目「"+o.Title+"」的资料，由「项目资料同步到知识库」整理")
	if err != nil {
		return info, false, fmt.Errorf("建项目知识库没成：%w", err)
	}
	if err := s.saveBinding(ctx, o.ID, info.ID, true); err != nil {
		return info, false, err
	}
	if a := defaultAgent(o); a != "" {
		if _, err := s.c.Knowledge().AttachAgent(ctx, a, info.ID); err != nil {
			s.c.Log().Warn("attach project kb to agent failed", "project", o.ID, "agent", a, "err", err)
		}
	}
	return info, true, nil
}

// docsDirOf 是项目文档目录的绝对路径，规则同内核 projectDocsDir（internal/api/projectdocs.go）：去 file://，相对路径接在项目目录后面。
// 没设回空串；相对路径但没有项目目录时回原因。
func docsDirOf(o plugin.ObjectInfo) (string, string) {
	v, _ := o.Props[propDocsDir].(string)
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "file://"))
	switch {
	case raw == "":
		return "", ""
	case filepath.IsAbs(raw):
		return filepath.Clean(raw), ""
	case o.Workdir == "":
		return "", "文档目录「" + raw + "」是相对路径，项目没填本地项目目录"
	}
	return filepath.Join(o.Workdir, raw), ""
}

// items 把项目的资料按来源开关拼成交给知识库的清单；fails 是还没交给知识库就知道收不了的（文档目录写法不对）。
func (s *kbService) items(ctx context.Context, o plugin.ObjectInfo, src kbSources) ([]plugin.KBItem, map[string]int, []plugin.KBProblem, error) {
	items := []plugin.KBItem{}
	counts := map[string]int{"files": 0, "folders": 0, "notes": 0, "links": 0, "docs": 0, "docs_dir": 0}
	fails := []plugin.KBProblem{}
	if src.Files || src.Notes || src.Links {
		rows, err := s.c.Store().Query(ctx, `SELECT `+materialCols+` FROM projects_materials WHERE project_id = ? ORDER BY created_at, rowid`, o.ID)
		if err != nil {
			return nil, nil, nil, err
		}
		var ms []Material
		for rows.Next() {
			m, err := scanMaterial(rows)
			if err != nil {
				_ = rows.Close()
				return nil, nil, nil, err
			}
			ms = append(ms, m)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, nil, err
		}
		for _, m := range ms {
			key := "material:" + m.ID
			switch {
			case m.Kind == "file" && src.Files:
				items = append(items, plugin.KBItem{Key: key, Kind: plugin.KBItemFile, Ref: m.Value, Label: m.Name})
				counts["files"]++
			case m.Kind == "folder" && src.Files:
				items = append(items, plugin.KBItem{Key: key, Kind: plugin.KBItemDir, Ref: m.Value, Label: m.Name})
				counts["folders"]++
			case m.Kind == "note" && src.Notes:
				items = append(items, plugin.KBItem{Key: key, Kind: plugin.KBItemNote, Title: m.Name, Text: m.Value})
				counts["notes"]++
			case m.Kind == "link" && src.Links:
				items = append(items, plugin.KBItem{Key: key, Kind: plugin.KBItemLink, Ref: m.Value, Title: m.Name, Text: linkText(m)})
				counts["links"]++
			}
		}
	}
	if src.Docs {
		docs, err := s.c.Objects().List(ctx, plugin.ObjectQuery{Type: "doc", ProjectID: o.ID, Limit: 2000})
		if err != nil {
			return nil, nil, nil, err
		}
		for _, d := range docs {
			items = append(items, plugin.KBItem{Key: "doc:" + d.ID, Kind: plugin.KBItemLibrary, Ref: d.ID, Label: d.Title})
			counts["docs"]++
		}
	}
	if src.DocsDir {
		dir, why := docsDirOf(o)
		switch {
		case why != "":
			fails = append(fails, plugin.KBProblem{Title: "文档目录", Reason: why})
		case dir != "":
			items = append(items, plugin.KBItem{Key: "docs_dir", Kind: plugin.KBItemDir, Ref: dir, Label: "文档目录"})
			counts["docs_dir"]++
		}
	}
	return items, counts, fails, nil
}

// linkText 是链接收进知识库的正文：只收标题和备注（分类、状态、标签），不联网抓网页正文。
func linkText(m Material) string {
	lines := []string{m.Name, m.Value}
	if m.Category != "" {
		lines = append(lines, "分类："+m.Category)
	}
	if len(m.Tags) > 0 {
		lines = append(lines, "标签："+strings.Join(m.Tags, "、"))
	}
	return strings.Join(lines, "\n")
}

// syncProject 同步一个项目，结果写进 projects_kb 的 last_result。出错不回 error，写进 Error。
func (s *kbService) syncProject(ctx context.Context, o plugin.ObjectInfo, src kbSources) ProjectKBSync {
	res := ProjectKBSync{ProjectID: o.ID, Name: o.Title, Ref: o.Ref, Failures: []plugin.KBProblem{}, Skips: []plugin.KBProblem{},
		Sources: map[string]int{}, At: time.Now().UTC().Truncate(time.Second)}
	defer func() { s.saveResult(ctx, o.ID, res) }()
	info, created, err := s.ensureKB(ctx, o)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.KbID, res.KbName, res.Created = info.ID, info.Name, created
	items, counts, fails, err := s.items(ctx, o, src)
	if err != nil {
		res.Error = "读项目资料没成：" + err.Error()
		return res
	}
	res.Sources = counts
	out, err := s.c.Knowledge().Sync(ctx, info.ID, o.ID, items)
	if err != nil {
		res.Error = "同步知识库没成：" + err.Error()
		return res
	}
	res.Added, res.Updated, res.Removed, res.Unchanged = out.Added, out.Updated, out.Removed, out.Unchanged
	res.Skipped, res.Failed = out.Skipped, out.Failed+len(fails)
	res.Failures = append(fails, out.Failures...)
	res.Skips = out.Skips
	return res
}

func (s *kbService) saveResult(ctx context.Context, pid string, res ProjectKBSync) {
	b, _ := json.Marshal(res)
	if _, err := s.c.Store().Exec(context.WithoutCancel(ctx), `UPDATE projects_kb SET last_sync_at = ?, last_result = ? WHERE project_id = ?`,
		res.At.Format(time.RFC3339), string(b), pid); err != nil {
		s.c.Log().Warn("save project kb sync result failed", "project", pid, "err", err)
	}
}

/* ---------- SOP 节点 ---------- */

// yesNo 认「是 / 否」这类写法；留空按 def。
func yesNo(v string, def bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "":
		return def, nil
	case "yes", "y", "true", "1", "是", "收", "要", "on":
		return true, nil
	case "no", "n", "false", "0", "否", "不收", "不要", "off":
		return false, nil
	}
	return false, fmt.Errorf("「%s」认不出：填 yes 或 no", v)
}

func (s *kbService) node(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	src := kbSources{}
	for _, p := range []struct {
		key, label string
		dst        *bool
	}{{"files", "本机文件和文件夹", &src.Files}, {"notes", "笔记", &src.Notes}, {"links", "链接", &src.Links},
		{"docs", "关联的文档", &src.Docs}, {"docs_dir", "文档目录", &src.DocsDir}} {
		v, err := yesNo(render(n.Config[p.key], n.Input), true)
		if err != nil {
			return nil, fmt.Errorf("「%s」%w", p.label, err)
		}
		*p.dst = v
	}
	notify := strings.TrimSpace(render(n.Config["notify"], n.Input))
	if notify != "" && notify != "always" && notify != "changed" {
		return nil, fmt.Errorf("「通知我」只能是 always、changed 或留空，填的是「%s」", notify)
	}
	key := strings.TrimSpace(render(n.Config["project"], n.Input))
	var list []plugin.ObjectInfo
	if key == "" || key == kbAll || strings.EqualFold(key, "all") {
		all, err := c.Objects().List(ctx, plugin.ObjectQuery{Type: "project"})
		if err != nil {
			return nil, err
		}
		list = all
	} else {
		o, err := c.Objects().Find(ctx, "project", key)
		if errors.Is(err, plugin.ErrNoRows) {
			return nil, fmt.Errorf("项目「%s」不存在：填项目 id、编号或名字，留空或填「全部」是所有没归档的项目", key)
		}
		if err != nil {
			return nil, err
		}
		list = []plugin.ObjectInfo{o}
	}
	results := make([]any, 0, len(list))
	tot := map[string]int{"projects": len(list), "added": 0, "updated": 0, "removed": 0, "unchanged": 0, "skipped": 0, "failed": 0, "errors": 0, "created": 0}
	var each []ProjectKBSync
	for _, o := range list {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		r := s.syncProject(ctx, o, src)
		each = append(each, r)
		b, _ := json.Marshal(r)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		results = append(results, m)
		tot["added"] += r.Added
		tot["updated"] += r.Updated
		tot["removed"] += r.Removed
		tot["unchanged"] += r.Unchanged
		tot["skipped"] += r.Skipped
		tot["failed"] += r.Failed
		if r.Error != "" {
			tot["errors"]++
		}
		if r.Created {
			tot["created"]++
		}
	}
	text := kbSyncText(each, tot)
	ok := tot["errors"] == 0 && tot["failed"] == 0
	changed := tot["added"]+tot["updated"]+tot["removed"]+tot["failed"]+tot["errors"] > 0
	notified := false
	if notify == "always" || (notify == "changed" && changed) {
		level := plugin.NotifySuccess
		if !ok {
			level = plugin.NotifyError
		}
		title, body, _ := strings.Cut(text, "\n")
		if err := c.Notify(ctx, plugin.Notification{Kind: "kb_synced", Level: level, Title: title, Body: body,
			Data: map[string]any{"run_id": n.RunID, "totals": tot}}); err != nil {
			c.Log().Warn("project kb sync notify failed", "err", err)
		} else {
			notified = true
		}
	}
	totals := map[string]any{}
	for k, v := range tot {
		totals[k] = v
	}
	return with(n.Input, map[string]any{"kb_sync": map[string]any{
		"projects": results, "totals": totals, "text": text, "ok": ok, "changed": changed, "notified": notified,
	}}), nil
}

// kbSyncText 是给通知用的几行：第一行汇总，之后每个项目一行，失败的列原因（每个项目最多 5 条）。
func kbSyncText(each []ProjectKBSync, tot map[string]int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "整理了 %d 个项目的知识库：新增 %d、更新 %d、移除 %d、失败 %d、跳过 %d", tot["projects"],
		tot["added"], tot["updated"], tot["removed"], tot["failed"], tot["skipped"])
	if tot["errors"] > 0 {
		fmt.Fprintf(&b, "，%d 个项目没同步成", tot["errors"])
	}
	for _, r := range each {
		fmt.Fprintf(&b, "\n- %s", r.Name)
		if r.KbName != "" {
			fmt.Fprintf(&b, "（%s", r.KbName)
			if r.Created {
				b.WriteString("，新建")
			}
			b.WriteString("）")
		}
		if r.Error != "" {
			fmt.Fprintf(&b, "：没同步成，%s", r.Error)
			continue
		}
		fmt.Fprintf(&b, "：新增 %d、更新 %d、移除 %d、失败 %d、跳过 %d", r.Added, r.Updated, r.Removed, r.Failed, r.Skipped)
		for i, f := range r.Failures {
			if i == 5 {
				fmt.Fprintf(&b, "\n  - 另有 %d 条失败", r.Failed-5)
				break
			}
			fmt.Fprintf(&b, "\n  - 失败：%s：%s", f.Title, f.Reason)
		}
	}
	return b.String()
}

/* ---------- 内置流程 ---------- */

// kbFlow 是内置流程「每周一 10:00 整理项目知识库」：定时触发 → 所有项目同步（有变化或失败时发平台通知）→ 结束留下汇总。
// 随流程建的定时任务是停用的：到点自动跑的事由用户在 SOP 页确认后启用。
func kbFlow() plugin.SOPFlowTemplate {
	type step struct {
		Key    string            `json:"key"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Desc   string            `json:"desc"`
		Config map[string]string `json:"config"`
	}
	steps := []step{
		{Key: "sync", Name: "同步项目资料到知识库", Kind: NodeKBSync,
			Desc:   "对所有没归档的项目：本机文件和文件夹、笔记、链接（标题和备注）、关联的工作台文档、文档目录收进项目知识库；没有知识库的新建并绑定",
			Config: map[string]string{"project": kbAll, "files": "yes", "notes": "yes", "links": "yes", "docs": "yes", "docs_dir": "yes", "notify": "changed"}},
		{Key: "done", Name: "汇总", Kind: "end", Desc: "留下每个项目的新增、更新、移除、失败条数和原因",
			Config: map[string]string{"outputs": "kb_sync"}},
	}
	sb, _ := json.Marshal(steps)
	return plugin.SOPFlowTemplate{
		ID:      KBFlowID,
		Name:    "每周一 10:00 整理项目知识库",
		Desc:    "每周一 10:00 把各个项目的资料同步进项目知识库：新增的加进去，改过的重新索引，删了的移出（只动同步加进来的，人工加的不动）；有变化或失败时发一条通知。定时任务装好时是停用的，确认后在这里启用",
		Trigger: "schedule",
		Fields:  json.RawMessage(`[]`),
		Steps:   sb,
		Schedule: &plugin.SOPFlowTemplateSchedule{
			Rule:    plugin.SOPScheduleRule{Freq: "weekly", Time: "10:00", Weekdays: []int{1}},
			Enabled: false,
		},
	}
}

// installKBTemplate 把内置流程写进 SOP，写过一次记在 projects_sop_templates，用户删了不补回来；SOP 插件没在跑就下次再试。
func installKBTemplate(ctx context.Context, c plugin.Core) error {
	t := kbFlow()
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM projects_sop_templates WHERE flow_id = ?`, t.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	created, err := c.SOP().InstallFlow(ctx, t)
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return nil
	}
	if err != nil {
		c.Log().Warn("projects sop template install failed", "flow", t.ID, "err", err)
		return nil
	}
	if _, err := c.Store().Exec(ctx, `INSERT INTO projects_sop_templates (flow_id, installed_at) VALUES (?, ?) ON CONFLICT (flow_id) DO NOTHING`,
		t.ID, time.Now().UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	c.Log().Info("projects sop template installed", "flow", t.ID, "created", created)
	return nil
}

// OnUninstall 撤下写进 SOP、用户没改过的内置流程；改过的、撤不了的留着，不挡卸载。
func (p *Plugin) OnUninstall(ctx context.Context, c plugin.Core, deleteData bool) error {
	t := kbFlow()
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM projects_sop_templates WHERE flow_id = ?`, t.ID).Scan(&n); err != nil || n == 0 {
		return nil
	}
	removed, why, err := c.SOP().RemoveFlow(ctx, t.ID)
	if err != nil {
		c.Log().Warn("projects sop template remove failed", "flow", t.ID, "err", err)
		return nil
	}
	if !removed && why != "" {
		c.Log().Info("projects sop template kept", "flow", t.ID, "reason", why)
		return nil
	}
	if !deleteData {
		_, err = c.Store().Exec(ctx, `DELETE FROM projects_sop_templates WHERE flow_id = ?`, t.ID)
	}
	return err
}
