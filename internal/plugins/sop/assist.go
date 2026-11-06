package sop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
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

// maxRepairs 是草稿没过校验时自动带着问题让模型再改的轮数上限（TSK-0490）。
const maxRepairs = 2

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

	ctx := r.Context()
	folders, _, err := listFolders(ctx, h.c)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	system := assistPrompt(draft, steps, selected, guideText(allNodeTypes(h.c), folders))
	user := msg
	var reply Reply
	valid := false
	for round := 0; ; round++ {
		out, err := h.complete(ctx, system, user)
		if err != nil {
			if ctx.Err() != nil {
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
		next, fix, err := parseReply(ctx, h.c, out, draft, kindsOf(h.c))
		if err != nil {
			switch {
			case round < maxRepairs:
				// 回的不是合法草稿（小模型常漏括号）：带着原因让它重回一次，算一轮返修
				user = repairPrompt(msg, out, []string{"回的不是合法的草稿：" + err.Error() + "。只回一个完整的 JSON 对象"})
				continue
			case valid:
				// 返修那一轮回坏了：用上一轮的草稿，说明没修好
				reply.Notes = append(reply.Notes, "自动返修时模型回的不是合法草稿（"+err.Error()+"），上面是返修前的草稿")
			default:
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]string{"code": "bad_model_reply", "message": err.Error()}})
				return
			}
			break
		}
		reply, valid = next, true
		if len(fix) == 0 || round >= maxRepairs {
			if round > 0 {
				what := "已改好"
				if len(fix) > 0 {
					what = "仍有问题没改好，见下面「必须改」"
				}
				reply.Notes = append(reply.Notes, fmt.Sprintf("草稿没过保存校验，自动让模型返修了 %d 轮，%s", round, what))
			}
			break
		}
		user = repairPrompt(msg, out, fix)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": reply})
}

// repairPrompt 是返修那一轮的用户消息：原来的要求、上一稿、校验查出的问题。
func repairPrompt(msg, prev string, fix []string) string {
	return "用户的要求：" + msg + "\n\n你上一稿回的是：\n" + prev +
		"\n\n这一稿没过保存校验，问题如下，逐条改掉后按同样的 JSON 格式回整条草稿（text 写清楚改了什么；确实做不到的写进 notes，不要硬凑）：\n- " +
		strings.Join(fix, "\n- ")
}

// fixCodes 是 AI 草稿里要自动返修的警告（错误一律返修）：条件字段拿不到、自动执行当写操作、节点不认的配置、不是条件节点写了条件、
// 自动触发补不上的必填输入。
var fixCodes = map[string]bool{codeCondField: true, codeAutoWrite: true, codeUnknownConfig: true, codeUnusedCond: true, codeInputUnfilled: true}

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
	// 草稿里的 im、folder_id（TSK-0490）是编辑器当前的设置，原样带着，给模型看、返回时沿用
	if v, ok := raw["im"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &f.IM) != nil {
			return f, nil, apiErr(errValidation, "draft 格式不对：im 必须是对象")
		}
	}
	normIM(&f.IM)
	if v, ok := raw["folder_id"]; ok && string(v) != "null" {
		var id string
		if json.Unmarshal(v, &id) != nil {
			return f, nil, apiErr(errValidation, "draft 格式不对：folder_id 必须是字符串或 null")
		}
		if id != "" {
			f.FolderID = &id
		}
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
	warns, err := apply(f, raw, kinds)
	var ce *checkError
	if errors.As(err, &ce) {
		return ce.issues, nil
	}
	return warns, err
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

// issueNotes：错误是「必须改」，按节点声明查出的警告是「注意」（TSK-0490），原型只提醒的是「建议」。
func issueNotes(f Flow, issues []Issue) []string {
	var notes []string
	for _, x := range errorsOf(issues) {
		notes = append(notes, "必须改："+x.Text)
	}
	for _, x := range warningsOf(issues) {
		notes = append(notes, "注意："+x.Text)
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
		if s.Kind == "review" || isManual(s) {
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
// im 是 IM 触发的过滤、执行顺序、拦截（会话已换成 cv_ id），folder_id 是放进哪个文件夹（TSK-0490）。
type Draft struct {
	ID       string          `json:"id,omitempty"`
	Name     string          `json:"name"`
	Desc     string          `json:"desc"`
	Trigger  string          `json:"trigger"`
	Fields   json.RawMessage `json:"fields"`
	Steps    json.RawMessage `json:"steps"`
	IM       *IMTrigger      `json:"im,omitempty"`
	FolderID *string         `json:"folder_id,omitempty"`
}

func draftOf(f Flow) *Draft {
	d := &Draft{ID: f.ID, Name: f.Name, Desc: f.Desc, Trigger: f.Trigger, Fields: f.Fields, Steps: f.Steps, FolderID: f.FolderID}
	if f.Trigger == imTrigger {
		im := f.IM
		d.IM = &im
	}
	return d
}

func assistPrompt(f Flow, steps []stepDef, selected int, guide string) string {
	cur, _ := json.Marshal(draftOf(f))
	sel := "没有选中的步骤"
	if selected >= 0 {
		sel = fmt.Sprintf("选中的步骤是第 %d 个（下标 %d）「%s」", selected+1, selected, steps[selected].Name)
	}
	var b strings.Builder
	b.WriteString(`你是 SOP 编排页的 AI 协助。用户会描述一个流程，或者让你改当前草稿（加步骤、删步骤、改并行、加判断分支、改触发方式）。
只回一个 JSON 对象，不要别的文字，也不要代码块：
{"text": "一两句中文说明你做了什么", "draft": 改好的整条草稿或 null, "notes": ["要提醒的事", ...]}
- 只是回答问题、不改流程时 draft 为 null。
- draft 形状：{"name", "desc", "trigger", "fields": [{"key","label","type":"text|textarea|select","required":true/false,"default":""}], "steps": [步骤...], "im": IM 触发设置（trigger 是 im 时）, "folder_id": 文件夹 id（要放进文件夹时）}。草稿已有名称时保留名称；fields、trigger、im 没要改就照抄当前草稿。
- 步骤：{"key","name","kind","desc","after":[依赖的步骤 key],"config":{配置项 key: 字符串}}；分支节点另有 "cases":[{"key","label"}]，挂在某个分支下的步骤加 "branch":{"of":分支节点 key,"case":分支 key}；条件写在 "cond"（见下面的写法）。
- 步骤 key 在流程内唯一，不能用 __start；保留原有步骤的 key 和配置，新步骤用没用过的 s 加数字；依赖不能成环；步骤按依赖排好顺序；必填的配置项都要填。
- 插入一步时，原来接在锚点后面的步骤改接新步骤；删一步时，接在它后面的步骤改接它的上游。
- 只按节点目录里写的能力出稿：config 只写目录里列出的配置项；要改数据（标记消息、建任务、回复……）用对应的写节点，「自动执行」（auto）什么都不做，不要拿它当写操作。
- 下游引用上游的结果（{{字段}}、条件的 field）只能用目录里声明的输出、触发方式自动带入的字段和输入字段。
- 要求里有做不到的（没有对应的节点或配置），在 notes 里如实说明哪一部分做不到，不要编一个看起来能用的步骤。

`)
	b.WriteString(guide)
	b.WriteString("\n当前草稿：\n")
	b.Write(cur)
	b.WriteString("\n\n" + sel + "。\n")
	return b.String()
}

var fenceRe = regexp.MustCompile("(?s)^```[a-zA-Z]*\\s*(.*?)\\s*```$")

// parseReply 解析模型的回复，回不出合法 JSON、或草稿字段类型不对时返回原因（接口回 422）。
// 草稿里旧写法的一行规则换成等价的结构化条件，im 的会话换成 cv_ id；fix 是要让模型返修的问题（TSK-0490）。
func parseReply(ctx context.Context, c plugin.Core, out string, base Flow, kinds kindLookup) (Reply, []string, error) {
	s := strings.TrimSpace(out)
	if m := fenceRe.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	// 模型常在 JSON 前后多说一句，取最外层的花括号
	i, j := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if i < 0 || j <= i {
		return Reply{}, nil, errors.New("模型回的不是 JSON")
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
			return Reply{}, nil, errors.New("模型回的不是合法 JSON：有语法错误或不完整")
		}
		return Reply{}, nil, fmt.Errorf("模型回的不是合法 JSON：%s", jsonReason(err))
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
			return Reply{}, nil, errors.New("模型的回复里没有 text 也没有 draft")
		}
		return reply, nil, nil
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(d, &raw) != nil || raw == nil {
		return Reply{}, nil, errors.New("模型回的 draft 不是对象")
	}
	if _, ok := raw["steps"]; !ok {
		return Reply{}, nil, errors.New("模型回的 draft 没有 steps")
	}
	// 没给的字段沿用当前草稿；layout 不沿用，旧位置对不上新步骤
	f := Flow{ID: base.ID, Name: base.Name, Desc: base.Desc, Trigger: base.Trigger, Fields: base.Fields, Steps: json.RawMessage(`[]`),
		IM: base.IM, FolderID: base.FolderID}
	f.IM.Conversations = slices.Clone(base.IM.Conversations)
	f.IM.Relevance = slices.Clone(base.IM.Relevance)
	delete(raw, "id")
	delete(raw, "layout")
	if base.Name != "" {
		delete(raw, "name")
	}
	raw["steps"] = normalizeSteps(raw["steps"])
	var fix []string
	// im：会话的各种写法换成 cv_ id；写错的不拦草稿，交给模型返修
	if v, ok := raw["im"]; ok {
		delete(raw, "im")
		in, err := readIMIn(ctx, c, map[string]json.RawMessage{"im": v})
		if err != nil {
			fix = append(fix, "im 不对："+ruleReason(err))
		} else {
			in.applyIM(&f.IM)
			if in.Order != nil {
				f.IM.Order = *in.Order
			}
		}
	}
	if v, ok := raw["folder_id"]; ok {
		delete(raw, "folder_id")
		var ref string
		_ = json.Unmarshal(v, &ref)
		switch fd, err := matchFolder(ctx, c, ref); {
		case err != nil:
			fix = append(fix, "folder_id 不对："+ruleReason(err))
		default:
			f.FolderID = fd
		}
	}
	issues, err := applyDraft(&f, raw, kinds)
	if err != nil {
		_, reason, _ := strings.Cut(err.Error(), ": ")
		return Reply{}, nil, fmt.Errorf("模型回的草稿格式不对：%s", reason)
	}
	for _, x := range issues {
		if x.Level != levelWarning || fixCodes[x.Code] {
			fix = append(fix, issueText(x))
		}
	}
	if reply.Text == "" {
		reply.Text = "按你的要求改好了流程："
	}
	reply.Draft = draftOf(f)
	reply.Notes = append(reply.Notes, issueNotes(f, issues)...)
	for _, x := range fix {
		if strings.HasPrefix(x, "im 不对") || strings.HasPrefix(x, "folder_id 不对") {
			reply.Notes = append(reply.Notes, "必须改："+x)
		}
	}
	return reply, fix, nil
}

// issueText 是带步骤序号的一条问题，给模型返修用。
func issueText(x Issue) string {
	if x.Step != nil {
		return fmt.Sprintf("第 %d 步：%s", *x.Step+1, x.Text)
	}
	return x.Text
}

// matchFolder 认文件夹 id 或名字（不分大小写），空串是未分类；AI 协助不建文件夹，对不上的回错误。
func matchFolder(ctx context.Context, c plugin.Core, ref string) (*string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" || ref == uncategorized {
		return nil, nil
	}
	if f, err := getFolder(ctx, c, ref); err == nil {
		return &f.ID, nil
	} else if !errors.Is(err, errNotFound) {
		return nil, err
	}
	if f, err := folderByName(ctx, c, ref); err == nil {
		return &f.ID, nil
	} else if !errors.Is(err, errNotFound) {
		return nil, err
	}
	return nil, apiErr(errValidation, "没有文件夹 %s，只能用已有的文件夹 id", ref)
}

// normalizeSteps 把步骤里旧写法的一行规则换成等价的结构化条件（cond），去掉 rule（TSK-0490）：AI 协助和 Agent 存的流程只用结构化条件。
// 不是旧写法的 rule 留着，交给保存校验报「是一句话」。解析不了的原样返回。
func normalizeSteps(v json.RawMessage) json.RawMessage {
	var steps []map[string]any
	if json.Unmarshal(v, &steps) != nil {
		return v
	}
	changed := false
	for _, st := range steps {
		if st == nil {
			continue
		}
		rule, _ := st["rule"].(string)
		if _, has := st["cond"]; has || strings.TrimSpace(rule) == "" {
			if has && st["cond"] != nil && strings.TrimSpace(rule) == "" {
				delete(st, "rule")
			}
			continue
		}
		if c, ok := legacyCond(strings.TrimSpace(rule)); ok {
			st["cond"] = c
			delete(st, "rule")
			changed = true
		}
	}
	if !changed {
		return v
	}
	out, err := json.Marshal(steps)
	if err != nil {
		return v
	}
	return out
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
