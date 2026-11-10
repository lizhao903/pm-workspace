// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 交给 Claude Code 的角色（SPEC-tasks-6.18、SPEC-settings-24，AUTO-03 由「预置提示词」升级而来）：
// 每个角色有场景名、执行要求、权限（只读 / 允许改文件）、输出要求、默认目录种类。
// 弹窗里选一个，执行要求和输出要求拼进提示词「执行要求」一节，权限决定流式执行要不要放开文件编辑；
// 标了默认的那个弹窗打开时就选上。
// 存在 agent_settings 的 run_prompts 下（JSON 数组），没设过用内置的六个。
// 内置角色以后会加：读的时候把用户还没见过的内置角色（按 id）补在末尾，用户删掉的不再补回——
// 见过哪些记在 run_prompts_builtins 下，每次保存时写成当时全部内置 id。
// GET /api/run-prompts 读，PUT /api/run-prompts 整组替换，空数组表示一个都不要。
// 新字段都可选：旧数据和旧客户端不带时按 accept_edits、无输出要求、any 处理。

const (
	runPromptsKey      = "run_prompts"
	runPromptsSeenKey  = "run_prompts_builtins"
	maxRunPrompts      = 30
	maxRunPromptScene  = 40
	maxRunPromptText   = 4000
	maxRunPromptOutput = 2000
)

// 角色的权限：只读不放开文件编辑；accept_edits 交给 CLI 时加 --permission-mode acceptEdits。
const (
	PermReadOnly    = "read_only"
	PermAcceptEdits = "accept_edits"
)

// 角色默认在项目档案的哪个目录跑（AUTO-04 落地后生效，之前只存不用）。
const (
	DirKindCode      = "code"
	DirKindPrototype = "prototype"
	DirKindPRD       = "prd"
	DirKindAny       = "any"
)

// RunPrompt 是一个角色（接口和存储里沿用 run-prompts 的名字）。
type RunPrompt struct {
	ID      string `json:"id"`
	Scene   string `json:"scene"`
	Content string `json:"content"`
	Default bool   `json:"default"`
	// Permission 是 read_only 或 accept_edits，空按 accept_edits。
	Permission string `json:"permission"`
	// Output 是对输出的要求，可空。
	Output string `json:"output"`
	// DirKind 是 code / prototype / prd / any，空按 any。
	DirKind string `json:"dir_kind"`
}

// 内置角色的输出要求里共用的一句：结构化结论经 pmw_finish_run 的 result 回报（AUTO-01）。
const finishResultHint = "结束时用 pmw_finish_run 回报 summary（一段结论）和 result（JSON 对象）："

// defaultRunPrompts 是内置的六个角色，没设过时就是它们；以后加内置角色只往这里加，id 不能改。
func defaultRunPrompts() []RunPrompt {
	return []RunPrompt{
		{ID: "rp_classify", Scene: "分类", Permission: PermReadOnly, DirKind: DirKindAny,
			Content: "判断这条需求该归到哪个项目：读任务内容、来源消息和各项目档案的摘要，给出最可能的项目和理由；拿不准时列出候选项目，不要猜。",
			Output:  finishResultHint + `{"project_id": "最可能的项目 id，拿不准时留空", "confidence": 0 到 1 的置信度, "candidates": ["候选项目 id"], "reason": "一句话理由"}。`},
		{ID: "rp_pm", Scene: "产品经理工作台", Default: true, Permission: PermAcceptEdits, DirKind: DirKindPrototype,
			Content: "请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。",
			Output:  "验收标准要写成能逐条测试的样子；每份产出（PRD、原型、规格）用 pmw_record_artifact 登记。" + finishResultHint + `{"artifacts": ["产出的文件或链接"], "questions": ["需要提出人回答的问题，没有为空"]}。`},
		{ID: "rp_review", Scene: "研发评审", Permission: PermReadOnly, DirKind: DirKindCode,
			Content: "只读评审：对照任务的验收标准，审查 PRD、原型和规格是否清楚、能实现、能测试，指出歧义、遗漏和与现有代码冲突的地方。",
			Output:  finishResultHint + `{"verdict": "pass 或 reject", "issues": [{"title": "问题", "detail": "说明和依据", "severity": "blocker 或 minor"}]}；verdict 为 reject 时 issues 至少一条。`},
		{ID: "rp_dev", Scene: "研发", Permission: PermAcceptEdits, DirKind: DirKindCode,
			Content: "按任务内容和验收标准修改代码，跑通相关测试后提交；结束时说明改了哪些文件、怎么验证的。",
			Output:  finishResultHint + `{"files": ["改动的文件"], "tests": "passed 或 failed", "commits": ["提交的 sha"]}。`},
		{ID: "rp_testdesign", Scene: "测试设计", Permission: PermAcceptEdits, DirKind: DirKindCode,
			Content: "按验收标准设计测试：逐条写出测试用例（前置条件、步骤、预期），能自动化的写成测试代码或脚本放进项目的测试目录；不改业务代码。",
			Output:  finishResultHint + `{"cases": 用例条数, "automated": 已自动化的条数, "files": ["新增的测试文件"]}。`},
		{ID: "rp_protosync", Scene: "原型同步", Permission: PermAcceptEdits, DirKind: DirKindPrototype,
			Content: "把原型拉齐到已上线的代码：对照代码和规格，找出原型里过时、缺失的界面和状态并补齐，更新规格里的状态标注；拿不准的差异列出来交给产品裁决，不要自己定。",
			Output:  finishResultHint + `{"synced": ["已同步的页面或规格条目"], "pending": [{"title": "拿不准的差异", "detail": "说明"}]}。`},
	}
}

// legacyBuiltinIDs 是 AUTO-03 之前的内置 id：那时保存过的用户都见过它们，删掉的不补回。
var legacyBuiltinIDs = []string{"rp_pm", "rp_dev", "rp_research"}

// normalizeRole 给旧数据补新字段的默认值。旧内置的「资料调研」本来就是只读调研，按只读补。
func normalizeRole(p RunPrompt) RunPrompt {
	if p.Permission == "" {
		p.Permission = PermAcceptEdits
		if p.ID == "rp_research" {
			p.Permission = PermReadOnly
		}
	}
	if p.DirKind == "" {
		p.DirKind = DirKindAny
	}
	return p
}

func (s *Server) runPrompts(ctx context.Context) ([]RunPrompt, error) {
	raw, err := s.st.AgentSetting(ctx, runPromptsKey)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return defaultRunPrompts(), nil
	}
	var list []RunPrompt
	if err := json.Unmarshal(raw, &list); err != nil {
		s.log.Warn("bad run_prompts setting, using defaults", "err", err)
		return defaultRunPrompts(), nil
	}
	for i := range list {
		list[i] = normalizeRole(list[i])
	}
	seen := legacyBuiltinIDs
	if raw, err := s.st.AgentSetting(ctx, runPromptsSeenKey); err != nil {
		return nil, err
	} else if len(raw) > 0 {
		var ids []string
		if err := json.Unmarshal(raw, &ids); err != nil {
			s.log.Warn("bad run_prompts_builtins setting, treating as legacy", "err", err)
		} else {
			seen = ids
		}
	}
	return mergeBuiltinRoles(list, seen), nil
}

// mergeBuiltinRoles 把用户还没见过的内置角色补在末尾：已有同 id 或同场景名的不补（不覆盖用户的），
// 补进来的不抢默认，超过条数上限的不补。
func mergeBuiltinRoles(list []RunPrompt, seen []string) []RunPrompt {
	out := append([]RunPrompt{}, list...)
	skip, scenes, hasDefault := map[string]bool{}, map[string]bool{}, false
	for _, id := range seen {
		skip[id] = true
	}
	for _, p := range out {
		skip[p.ID], scenes[p.Scene] = true, true
		hasDefault = hasDefault || p.Default
	}
	for _, b := range defaultRunPrompts() {
		if skip[b.ID] || scenes[b.Scene] || len(out) >= maxRunPrompts {
			continue
		}
		if hasDefault {
			b.Default = false
		}
		hasDefault = hasDefault || b.Default
		out = append(out, b)
	}
	return out
}

func builtinRoleIDs() []string {
	var ids []string
	for _, b := range defaultRunPrompts() {
		ids = append(ids, b.ID)
	}
	return ids
}

// presetOf 按 id 取一个角色；id 为空回 nil，找不到回 400。
// 只读角色的 ReadOnly 为真：流式执行据此不放开文件编辑（run.go），提示词里也写明不改文件。
func (s *Server) presetOf(ctx context.Context, id string) (*runner.Preset, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, nil
	}
	list, err := s.runPrompts(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		if p.ID == id {
			return &runner.Preset{Scene: p.Scene, Content: p.Content, ReadOnly: p.Permission == PermReadOnly,
				Output: p.Output, DirKind: p.DirKind}, nil
		}
	}
	return nil, validationf("角色 %s 不存在，可能刚被删掉了，换一个再试", id)
}

func (s *Server) handleListRunPrompts(w http.ResponseWriter, r *http.Request) {
	list, err := s.runPrompts(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, list)
}

func (s *Server) handlePutRunPrompts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []RunPrompt `json:"items"`
	}
	if err := decodeBody(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	list, err := cleanRunPrompts(body.Items)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	raw, _ := json.Marshal(list)
	if err := s.st.SetAgentSetting(r.Context(), runPromptsKey, raw); err != nil {
		s.fail(w, r, err)
		return
	}
	// 这次保存时的内置角色都算见过了：用户删掉的以后不再补回
	seen, _ := json.Marshal(builtinRoleIDs())
	if err := s.st.SetAgentSetting(r.Context(), runPromptsSeenKey, seen); err != nil {
		s.fail(w, r, err)
		return
	}
	scenes := make([]string, 0, len(list))
	for _, p := range list {
		scenes = append(scenes, p.Scene)
	}
	s.auditConfig(r, "update", "run_prompts", runPromptsKey, "修改交给 Claude Code 的角色", map[string]any{"scenes": scenes})
	respondData(w, http.StatusOK, list)
}

// cleanRunPrompts 去掉首尾空白、给新条目补 id、给没带新字段的补默认值；场景或内容空的、超长的、
// 场景重复的、id 重复的、超过条数的、标了不止一条默认的、权限或目录种类不认识的回 400。
func cleanRunPrompts(in []RunPrompt) ([]RunPrompt, error) {
	if len(in) > maxRunPrompts {
		return nil, validationf("角色最多 %d 个", maxRunPrompts)
	}
	out := make([]RunPrompt, 0, len(in))
	ids, scenes, defaults := map[string]bool{}, map[string]bool{}, 0
	for i, p := range in {
		p.ID, p.Scene, p.Content = strings.TrimSpace(p.ID), strings.TrimSpace(p.Scene), strings.TrimSpace(p.Content)
		p.Permission, p.Output, p.DirKind = strings.TrimSpace(p.Permission), strings.TrimSpace(p.Output), strings.TrimSpace(p.DirKind)
		p = normalizeRole(p)
		switch {
		case p.Scene == "":
			return nil, validationf("第 %d 条没写角色场景", i+1)
		case utf8.RuneCountInString(p.Scene) > maxRunPromptScene:
			return nil, validationf("角色场景「%s」超过 %d 字", p.Scene, maxRunPromptScene)
		case p.Content == "":
			return nil, validationf("「%s」没写提示词内容", p.Scene)
		case utf8.RuneCountInString(p.Content) > maxRunPromptText:
			return nil, validationf("「%s」的提示词超过 %d 字", p.Scene, maxRunPromptText)
		case utf8.RuneCountInString(p.Output) > maxRunPromptOutput:
			return nil, validationf("「%s」的输出要求超过 %d 字", p.Scene, maxRunPromptOutput)
		case p.Permission != PermReadOnly && p.Permission != PermAcceptEdits:
			return nil, validationf("「%s」的权限只能是 read_only 或 accept_edits", p.Scene)
		case p.DirKind != DirKindCode && p.DirKind != DirKindPrototype && p.DirKind != DirKindPRD && p.DirKind != DirKindAny:
			return nil, validationf("「%s」的目录种类只能是 code、prototype、prd 或 any", p.Scene)
		case scenes[p.Scene]:
			return nil, validationf("角色场景「%s」重复了", p.Scene)
		}
		if p.ID == "" {
			p.ID = idgen.Prefixed("rp")
		}
		if ids[p.ID] || !safeRunID(p.ID) {
			return nil, validationf("「%s」的 id 不合法或重复", p.Scene)
		}
		if p.Default {
			defaults++
		}
		ids[p.ID], scenes[p.Scene] = true, true
		out = append(out, p)
	}
	if defaults > 1 {
		return nil, validationf("只能有一个默认角色")
	}
	return out, nil
}

// presetLookup 给插件交给 Claude Code 的运行按 id 取角色（AUTO-01，plugin.PresetLookup）。
func (s *Server) presetLookup(ctx context.Context, id string) (*runner.Preset, error) {
	p, err := s.presetOf(ctx, id)
	if err != nil {
		return nil, errors.New(err.Error())
	}
	return p, nil
}
