package sop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 编辑器的 AI 协助（SOP-04a）：POST /api/sop/assist，口径同原型 web-next/src/sopedit.tsx 的 respond、Reply。
// 不保存；模型给的草稿过一遍保存校验（flows.go 的 Check），问题放进 notes。「检查」类请求不调模型。
// 契约见 docs/api-contract.md「SOP 编排插件 sop」的「AI 协助」。

const maxMessage = 4000

// completer 用默认服务商补全一段提示词，回模型说的原文。
type completer func(ctx context.Context, system, user string) (string, error)

// errNoModel 是还没接上模型的情况，回 503。
var errNoModel = errors.New("模型还没接上")

type assist struct {
	c        plugin.Core
	complete completer
}

// Reply 同原型 Reply，proposal 改叫 draft。
type Reply struct {
	Text  string   `json:"text"`
	Draft *Draft   `json:"draft,omitempty"`
	Notes []string `json:"notes,omitempty"`
}

// kindLabels 是节点类型的显示名，同原型 NODE_TYPES 的 label，用在概要和提示词里。
var kindLabels = map[string]string{
	"auto": "自动执行", "ai": "AI 处理", "knowledge": "知识检索", "extract": "参数提取", "template": "模板转换",
	"aggregate": "变量聚合", "code": "代码执行", "decide": "条件分支", "classifier": "问题分类器", "iterate": "迭代",
	"wait": "等待", "review": "人工检查", "http": "HTTP 请求", "notify": "发送消息", "task": "创建任务",
	"doc": "写文档", "contact": "写联系人", "local_append": "写进项目目录",
	"agent": "调用 Agent", "subflow": "子流程", "end": "结束",
}

// 同原型 respond 里认「检查」的写法
var checkRe = regexp.MustCompile(`^(帮我)?(检查|看看|校验)|有没有问题|哪里不对`)

func (h *assist) handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var msg string
	if v, ok := raw["message"]; !ok || json.Unmarshal(v, &msg) != nil || strings.TrimSpace(msg) == "" {
		fail(w, r, h.c, apiErr(errValidation, "message 必填"))
		return
	}
	msg = strings.TrimSpace(msg)
	if utf8.RuneCountInString(msg) > maxMessage {
		fail(w, r, h.c, apiErr(errValidation, "message 最多 %d 字", maxMessage))
		return
	}
	draft, issues, err := readDraft(raw["draft"], kindsOf(h.c))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	steps := draftSteps(draft.Steps)
	selected := -1
	if v, ok := raw["selected"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &selected) != nil || selected < 0 || selected >= len(steps) {
			fail(w, r, h.c, apiErr(errValidation, "selected 必须是草稿里步骤的下标"))
			return
		}
	}

	if len(steps) > 0 && checkRe.MatchString(msg) {
		writeJSON(w, http.StatusOK, map[string]any{"data": checkReply(draft, issues)})
		return
	}

	out, err := h.complete(r.Context(), assistPrompt(draft, steps, selected), msg)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		if errors.Is(err, errNoModel) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"code": "model_unavailable", "message": errNoModel.Error()}})
			return
		}
		h.c.Log().Warn("sop assist model failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": map[string]string{"code": "model_failed", "message": err.Error()}})
		return
	}
	reply, err := parseReply(out, draft, kindsOf(h.c))
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]string{"code": "bad_model_reply", "message": err.Error()}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": reply})
}

// readDraft 读请求里的草稿：字段类型不对回 400；保存校验没过不算错，问题一并返回。
func readDraft(v json.RawMessage, kinds kindLookup) (Flow, []Issue, error) {
	f := Flow{Fields: json.RawMessage(`[]`), Steps: json.RawMessage(`[]`)}
	v = bytes.TrimSpace(v)
	if len(v) == 0 || string(v) == "null" {
		return f, CheckWith(&f, kinds), nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(v, &raw) != nil || raw == nil {
		return f, nil, apiErr(errValidation, "draft 必须是对象")
	}
	if id, ok := raw["id"]; ok {
		_ = json.Unmarshal(id, &f.ID)
	}
	issues, err := applyDraft(&f, raw, kinds)
	if err != nil {
		_, reason, _ := strings.Cut(err.Error(), ": ")
		return f, nil, apiErr(errValidation, "draft 格式不对：%s", reason)
	}
	return f, issues, nil
}

// applyDraft 把 raw 写进 f 并校验，校验问题单独返回，其余错误照常返回。
func applyDraft(f *Flow, raw map[string]json.RawMessage, kinds kindLookup) ([]Issue, error) {
	err := apply(f, raw, kinds)
	var ce *checkError
	if errors.As(err, &ce) {
		return ce.issues, nil
	}
	return nil, err
}

func draftSteps(v json.RawMessage) []stepDef {
	var raws []json.RawMessage
	_ = json.Unmarshal(v, &raws)
	out := make([]stepDef, 0, len(raws))
	for _, r := range raws {
		var s stepDef
		_ = json.Unmarshal(r, &s)
		out = append(out, s)
	}
	return out
}

// checkReply 同原型 respond 的检查分支：拦保存的算「必须改」，原型只提醒的算「建议」。
func checkReply(f Flow, issues []Issue) Reply {
	notes := issueNotes(f, issues)
	if len(notes) == 0 {
		return Reply{Text: "流程结构没问题：每个判断的分支都有步骤，有人工检查点，依赖也都连上了。", Notes: summarize(draftSteps(f.Steps))}
	}
	return Reply{Text: fmt.Sprintf("看了一遍，有 %d 处要注意：", len(notes)), Notes: notes}
}

func issueNotes(f Flow, issues []Issue) []string {
	var notes []string
	for _, x := range issues {
		notes = append(notes, "必须改："+x.Text)
	}
	for _, t := range warnings(draftSteps(f.Steps)) {
		notes = append(notes, "建议："+t)
	}
	return notes
}

// warnings 是原型 checkSop 里只提醒、不拦保存的几条。
func warnings(steps []stepDef) []string {
	var out []string
	idx := stepIndex(steps)
	for _, s := range steps {
		if !isBranching(s.Kind) {
			continue
		}
		for _, c := range s.Cases {
			if strings.TrimSpace(c.Label) == "" {
				continue
			}
			hit := false
			for _, x := range steps {
				if x.Branch != nil && x.Branch.Of == s.Key && x.Branch.Case == c.Key {
					hit = true
					break
				}
			}
			if !hit {
				out = append(out, fmt.Sprintf("「%s」的「%s」分支下没有步骤，选中它时流程会直接往下走", s.Name, c.Label))
			}
		}
	}
	if len(steps) > 0 && !hasCheckpoint(steps) {
		out = append(out, "整个流程没有人工检查点，执行时不会停下来让人看输出")
	}
	starts := 0
	for i := range steps {
		if len(depsOf(steps, idx, i)) == 0 {
			starts++
		}
	}
	if starts > 1 {
		out = append(out, fmt.Sprintf("有 %d 个起点，它们会在开始时同时执行", starts))
	}
	return out
}

func stepIndex(steps []stepDef) map[string]int {
	idx := map[string]int{}
	for i, s := range steps {
		if _, dup := idx[s.Key]; !dup && s.Key != "" {
			idx[s.Key] = i
		}
	}
	return idx
}

// hasCheckpoint：有人工检查，或有规则留空的判断（人工判断，同原型 isManualDecide）。
func hasCheckpoint(steps []stepDef) bool {
	for _, s := range steps {
		if s.Kind == "review" || (s.Kind == "decide" && strings.TrimSpace(s.Rule) == "") {
			return true
		}
	}
	return false
}

// summarize 同原型：各类型数量、每个判断的分支、并行分叉数。
func summarize(steps []stepDef) []string {
	idx := stepIndex(steps)
	var kinds []string
	for _, t := range NodeTypes {
		n := 0
		for _, s := range steps {
			if s.Kind == t.Kind {
				n++
			}
		}
		if n > 0 {
			kinds = append(kinds, fmt.Sprintf("%s %d", kindLabels[t.Kind], n))
		}
	}
	out := []string{fmt.Sprintf("%d 个步骤：%s", len(steps), strings.Join(kinds, "、"))}
	forks := 0
	for i, s := range steps {
		if isBranching(s.Kind) {
			var cs []string
			for _, c := range s.Cases {
				cs = append(cs, "「"+c.Label+"」")
			}
			out = append(out, fmt.Sprintf("「%s」分出 %s", s.Name, strings.Join(cs, "")))
			continue
		}
		n := 0
		for j := range steps {
			if steps[j].Branch != nil {
				continue
			}
			for _, d := range depsOf(steps, idx, j) {
				if d == i {
					n++
					break
				}
			}
		}
		if n > 1 {
			forks++
		}
	}
	if forks > 0 {
		out = append(out, fmt.Sprintf("有 %d 处并行分叉", forks))
	}
	return out
}

// Draft 是返回给前端的草稿，形状同 SopFlow 去掉 layout、version 和时间（应用时前端清掉手动位置）。
type Draft struct {
	ID      string          `json:"id,omitempty"`
	Name    string          `json:"name"`
	Desc    string          `json:"desc"`
	Trigger string          `json:"trigger"`
	Fields  json.RawMessage `json:"fields"`
	Steps   json.RawMessage `json:"steps"`
}

func draftOf(f Flow) *Draft {
	return &Draft{ID: f.ID, Name: f.Name, Desc: f.Desc, Trigger: f.Trigger, Fields: f.Fields, Steps: f.Steps}
}

func assistPrompt(f Flow, steps []stepDef, selected int) string {
	types := make([]map[string]any, len(NodeTypes))
	for i, t := range NodeTypes {
		req := t.Required
		if req == nil {
			req = []ConfigField{}
		}
		m := map[string]any{"kind": t.Kind, "label": kindLabels[t.Kind], "group": t.Group, "branching": t.Branching, "required": req}
		if len(t.DefaultCases) > 0 {
			m["default_cases"] = t.DefaultCases
		}
		types[i] = m
	}
	catalog, _ := json.Marshal(types)
	cur, _ := json.Marshal(draftOf(f))
	sel := "没有选中的步骤"
	if selected >= 0 {
		sel = fmt.Sprintf("选中的步骤是第 %d 个（下标 %d）「%s」", selected+1, selected, steps[selected].Name)
	}
	var b strings.Builder
	b.WriteString(`你是 SOP 编排页的 AI 协助。用户会描述一个流程，或者让你改当前草稿（加步骤、删步骤、改并行、加判断分支）。
只回一个 JSON 对象，不要别的文字，也不要代码块：
{"text": "一两句中文说明你做了什么", "draft": 改好的整条草稿或 null, "notes": ["要提醒的事", ...]}
- 只是回答问题、不改流程时 draft 为 null。
- draft 形状：{"name", "desc", "trigger", "fields": [{"key","label","type":"text|textarea|select"}], "steps": [步骤...]}。草稿已有名称时保留名称；fields、trigger 没要改就照抄当前草稿。
- 步骤：{"key","name","kind","desc","after":[依赖的步骤 key],"config":{配置项 key: 字符串}}，分支节点另有 "cases":[{"key","label"}]（条件分支的规则写在 "rule"，留空就是人工判断），挂在某个分支下的步骤加 "branch":{"of":分支节点 key,"case":分支 key}。
- 步骤 key 在流程内唯一，不能用 __start；保留原有步骤的 key 和配置，新步骤用没用过的 s 加数字；依赖不能成环；步骤按依赖排好顺序；required 里的配置项都要填。
- 插入一步时，原来接在锚点后面的步骤改接新步骤；删一步时，接在它后面的步骤改接它的上游。
- kind 只能用下面目录里的。

节点类型目录：
`)
	b.Write(catalog)
	b.WriteString("\n\n当前草稿：\n")
	b.Write(cur)
	b.WriteString("\n\n" + sel + "。\n")
	return b.String()
}

var fenceRe = regexp.MustCompile("(?s)^```[a-zA-Z]*\\s*(.*?)\\s*```$")

// parseReply 解析模型的回复，回不出合法 JSON、或草稿字段类型不对时返回原因（接口回 422）。
func parseReply(out string, base Flow, kinds kindLookup) (Reply, error) {
	s := strings.TrimSpace(out)
	if m := fenceRe.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	// 模型常在 JSON 前后多说一句，取最外层的花括号
	i, j := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if i < 0 || j <= i {
		return Reply{}, errors.New("模型回的不是 JSON")
	}
	s = s[i : j+1]
	var got struct {
		Text  string          `json:"text"`
		Draft json.RawMessage `json:"draft"`
		Notes []string        `json:"notes"`
	}
	if err := json.Unmarshal([]byte(s), &got); err != nil {
		var se *json.SyntaxError
		if errors.As(err, &se) {
			return Reply{}, errors.New("模型回的不是合法 JSON：有语法错误或不完整")
		}
		return Reply{}, fmt.Errorf("模型回的不是合法 JSON：%s", jsonReason(err))
	}
	reply := Reply{Text: strings.TrimSpace(got.Text)}
	for _, n := range got.Notes {
		if n = strings.TrimSpace(n); n != "" {
			reply.Notes = append(reply.Notes, n)
		}
	}
	d := bytes.TrimSpace(got.Draft)
	if len(d) == 0 || string(d) == "null" {
		if reply.Text == "" {
			return Reply{}, errors.New("模型的回复里没有 text 也没有 draft")
		}
		return reply, nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(d, &raw) != nil || raw == nil {
		return Reply{}, errors.New("模型回的 draft 不是对象")
	}
	if _, ok := raw["steps"]; !ok {
		return Reply{}, errors.New("模型回的 draft 没有 steps")
	}
	// 没给的字段沿用当前草稿；layout 不沿用，旧位置对不上新步骤
	f := Flow{ID: base.ID, Name: base.Name, Desc: base.Desc, Trigger: base.Trigger, Fields: base.Fields, Steps: json.RawMessage(`[]`)}
	delete(raw, "id")
	delete(raw, "layout")
	if base.Name != "" {
		delete(raw, "name")
	}
	issues, err := applyDraft(&f, raw, kinds)
	if err != nil {
		_, reason, _ := strings.Cut(err.Error(), ": ")
		return Reply{}, fmt.Errorf("模型回的草稿格式不对：%s", reason)
	}
	if reply.Text == "" {
		reply.Text = "按你的要求改好了流程："
	}
	reply.Draft = draftOf(f)
	reply.Notes = append(reply.Notes, issueNotes(f, issues)...)
	return reply, nil
}

// coreCompleter 走内核的 Agent 句柄（SOP-01c），用默认服务商和它的模型补全；句柄没接上时回 errNoModel。
func coreCompleter(c plugin.Core) completer {
	return func(ctx context.Context, system, user string) (string, error) {
		out, err := c.Agent().Complete(ctx, plugin.CompleteRequest{System: system, Prompt: user, Scenario: plugin.ScenarioSOPAssist})
		if errors.Is(err, plugin.ErrNoAgent) {
			return "", errNoModel
		}
		return out, err
	}
}
