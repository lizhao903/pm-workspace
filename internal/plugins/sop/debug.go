package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 调试（TSK-0491）：POST /api/sop/debug。按真实数据把流程（已保存的，或编辑器里没保存的草稿）走一遍，不建执行、不写库：
//   - 输入真实取数：选一条真实消息（IM 插件的「读取消息」按 message_id 取正文、会话、与我的关系……），或手填输入；
//     IM 触发的流程不给消息时取这条流程最近一次执行（或最近一次没发起）的那条消息。
//   - 只读、只算的节点（读取消息、知识检索、模板、条件分支……）真实执行；调模型的照常调，可选跳过用占位输出；
//     写操作（标记消息、发消息、建任务、改对象、写文件、调外部 http、交给 Agent / Claude Code……）不执行，只列出将做什么和渲染后的参数，
//     声明的输出字段用占位值往下传；等待、人工节点不停下。节点算哪一类见 spec.go 的 builtinEffects 和插件声明的 SOPNodeSpec.Effect。
//   - 每一步回真实的输入输出、条件分支每条条件的真实值和判定、走了哪个分支、错误；这一步实际返回了但没声明的字段标「未声明」。
// 零副作用：不写 sop_runs、不发事件、不记运行异常、不进执行统计、不影响 IM 触发的拦截与去重（去重按 sop_runs 查，调试不写它）。
// 调模型受同一个并发名额限制。Agent 的 test_sop（launch.go）和 AI 协助出稿后的自查（assist.go）用同一套。

const (
	debugTimeout = 5 * time.Minute
	// sampleRunes 是字段真实值里文字的截断长度
	sampleRunes = 300
	// placeholderText 是模拟、跳过的节点输出里文字字段的占位值
	placeholderText = "(调试占位)"
	skippedModel    = "(调试时跳过了调模型)"
)

// 调试里一步的结果。
const (
	dbgDone       = "done"          // 真实执行完了
	dbgSimulated  = "simulated"     // 写操作、等待、人工节点：没执行，按口径模拟
	dbgModelSkip  = "skipped_model" // 选了跳过调模型，用占位输出
	dbgFailed     = "failed"
	dbgBypassed   = "bypassed"    // 所在分支没被选中
	dbgNotReached = "not_reached" // 上游失败或被条件回退截住，走不到
)

type debugger struct {
	c plugin.Core
	e *engine
}

// DebugReq 是一次调试的参数。
type DebugReq struct {
	// Input 是手填的输入，和消息带进来的字段合并（手填的优先）
	Input Json
	// MessageID 是用作输入的真实消息；IM 触发的流程不给时取最近一次执行或没发起的那条
	MessageID string
	// SkipModels 为真时调模型的节点不调，用占位输出
	SkipModels bool
	// Routes 是人工判断（和跳过调模型的问题分类器）走哪个分支：步骤 key → 分支 key，没给走第一个
	Routes map[string]string
}

// DebugParam 是写操作将用的一项配置（渲染后）。
type DebugParam struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Value string `json:"value"`
}

// DebugAction 是模拟的节点将做什么。
type DebugAction struct {
	Text   string       `json:"text"`
	Params []DebugParam `json:"params"`
}

// DebugCondItem 是一条条件这次的真实值和判定。
type DebugCondItem struct {
	Field   string `json:"field"`
	Op      string `json:"op"`
	OpLabel string `json:"op_label"`
	Value   string `json:"value"`
	Actual  any    `json:"actual"`
	Found   bool   `json:"found"`
	OK      bool   `json:"ok"`
}

// DebugCond 是条件分支、条件回退的条件这次怎么判的。
type DebugCond struct {
	Logic  string          `json:"logic"`
	Text   string          `json:"text"`
	Items  []DebugCondItem `json:"items"`
	Result bool            `json:"result"`
}

// DebugStep 是调试里的一步。
type DebugStep struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Effect string `json:"effect"`
	Status string `json:"status"`
	// Input、Output 是这一步的真实输入、输出（模拟的是占位输出）；没走到、分支没走的为 null
	Input  Json `json:"input"`
	Output Json `json:"output"`
	// Route 是分支节点走的分支 key，RouteLabel 是它的名字；条件回退成立时 route 是 back（实际会退回重做）
	Route       string       `json:"route,omitempty"`
	RouteLabel  string       `json:"route_label,omitempty"`
	RouteReason string       `json:"route_reason,omitempty"`
	Cond        *DebugCond   `json:"cond,omitempty"`
	Action      *DebugAction `json:"action,omitempty"`
	Error       string       `json:"error,omitempty"`
	// Note 是给人看的一句：为什么模拟、为什么没走到、实际执行会怎样
	Note string `json:"note,omitempty"`
	Log  string `json:"log,omitempty"`
	// Fields 是这一步加到输出里的字段：声明的带这次的真实值 sample，实际返回了但没声明的 declared=false
	Fields []FieldInfo `json:"fields"`
	Ms     int64       `json:"ms"`
}

// Debug 是一次调试的结果。
type Debug struct {
	ID       string `json:"id"`
	FlowID   string `json:"flow_id"`
	FlowName string `json:"flow_name"`
	Trigger  string `json:"trigger"`
	// Source 是输入从哪来：input（手填）、message（选的消息）、latest_run / latest_skip（这条流程最近一次执行 / 没发起的那条消息）、defaults（输入字段的默认值）
	Source    string `json:"source"`
	MessageID string `json:"message_id,omitempty"`
	// Message 是用作输入的那条消息（读取消息节点的 message），没有为 null
	Message Json `json:"message"`
	Input   Json `json:"input"`
	// InputError 是必填输入补不齐：自动触发时这条消息会被跳过、手动发起会被拦，调试照样往下走
	InputError string `json:"input_error,omitempty"`
	// Status 是 done（走完）、failed（有步骤失败）、stopped（条件回退成立，实际会退回重做）
	Status     string      `json:"status"`
	Summary    string      `json:"summary"`
	Notes      []string    `json:"notes"`
	SkipModels bool        `json:"skip_models"`
	Issues     []Issue     `json:"issues"`
	Steps      []DebugStep `json:"steps"`
	StartedAt  time.Time   `json:"started_at"`
	Ms         int64       `json:"ms"`
}

// handle 是 POST /api/sop/debug：{flow_id?, draft?, input?, message_id?, skip_models?, routes?}。
// draft（编辑器里的草稿，形状同 AI 协助）优先，没有就用 flow_id 的已保存版本。
func (d *debugger) handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	f, issues, err := d.flowOf(r.Context(), raw)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	q, err := readDebugReq(raw)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	res, err := d.run(r.Context(), f, issues, q)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// flowOf 是请求里的流程：draft 优先（flow_id 补它的 id），否则按 flow_id 取已保存的。
func (d *debugger) flowOf(ctx context.Context, raw map[string]json.RawMessage) (Flow, []Issue, error) {
	var id string
	if v, ok := raw["flow_id"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &id) != nil {
			return Flow{}, nil, apiErr(errValidation, "flow_id 必须是字符串")
		}
	}
	id = strings.TrimSpace(id)
	if v, ok := raw["draft"]; ok && string(v) != "null" {
		f, issues, err := readDraft(v, kindsOf(d.c))
		if err != nil {
			return Flow{}, nil, err
		}
		if f.ID == "" {
			f.ID = id
		}
		if f.ID != "" {
			// 草稿里没有过滤条件的顺序和已保存流程的名字时，按库里的补上（最近一条消息、IM 顺序要用）
			if saved, err := findFlow(ctx, d.c, f.ID); err == nil && strings.TrimSpace(f.Name) == "" {
				f.Name = saved.Name
			}
		}
		return f, issues, nil
	}
	if id == "" {
		return Flow{}, nil, apiErr(errValidation, "要带 flow_id 或 draft")
	}
	f, err := findFlow(ctx, d.c, id)
	if err != nil {
		return Flow{}, nil, err
	}
	return f, checkFlow(&f, kindsOf(d.c)), nil
}

func readDebugReq(raw map[string]json.RawMessage) (DebugReq, error) {
	var q DebugReq
	if v, ok := raw["input"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &q.Input) != nil || q.Input == nil {
			return q, apiErr(errValidation, "input 必须是对象")
		}
	}
	if v, ok := raw["message_id"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &q.MessageID) != nil {
			return q, apiErr(errValidation, "message_id 必须是字符串")
		}
		q.MessageID = strings.TrimSpace(q.MessageID)
	}
	if v, ok := raw["skip_models"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &q.SkipModels) != nil {
			return q, apiErr(errValidation, "skip_models 必须是 true 或 false")
		}
	}
	if v, ok := raw["routes"]; ok && string(v) != "null" {
		if json.Unmarshal(v, &q.Routes) != nil {
			return q, apiErr(errValidation, "routes 必须是 {步骤 key: 分支 key}")
		}
	}
	return q, nil
}

// run 调试一次。只有流程的步骤解不开、指定的消息取不到时回错误；步骤失败记在结果里。
func (d *debugger) run(ctx context.Context, f Flow, issues []Issue, q DebugReq) (*Debug, error) {
	ctx, cancel := context.WithTimeout(ctx, debugTimeout)
	defer cancel()
	start := time.Now()
	res := &Debug{ID: idgen.Prefixed("sdb"), FlowID: f.ID, FlowName: f.Name, Trigger: f.Trigger, SkipModels: q.SkipModels,
		Issues: issues, Notes: []string{}, Steps: []DebugStep{}, StartedAt: now()}
	if res.Issues == nil {
		res.Issues = []Issue{}
	}
	input, err := d.resolveInput(ctx, f, q, res)
	if err != nil {
		return nil, err
	}
	filled, ferr := fillInput(f, input)
	if ferr != nil {
		_, msg, _ := cutKind(ferr)
		switch f.Trigger {
		case imTrigger:
			res.InputError = "输入" + msg + "：IM 消息自动发起时补不齐，这条消息会被跳过；下面按空值往下走"
		case triggerSchedule:
			res.InputError = "输入" + msg + "：定时到点发起会失败；下面按空值往下走"
		default:
			res.InputError = "输入" + msg + "：手动发起时要填；下面按空值往下走"
		}
		filled = looseFill(f, input)
	}
	res.Input = filled
	defs, ok, idx := parseDefs(f.Steps)
	for i, good := range ok {
		if !good {
			return nil, apiErr(errValidation, "第 %d 步格式不对，先按「检查」改好再调试", i+1)
		}
	}
	res.Steps = d.walk(ctx, f, defs, idx, filled, q, res.ID)
	res.Status = dbgOverall(res.Steps)
	res.Summary = debugSummary(res, defs)
	res.Ms = time.Since(start).Milliseconds()
	return res, nil
}

// looseFill 同 fillInput 补默认值，补不齐也不报错。
func looseFill(f Flow, input Json) Json {
	var fields []sopField
	_ = json.Unmarshal(f.Fields, &fields)
	out := clone(input)
	if out == nil {
		out = Json{}
	}
	for _, fd := range fields {
		if v, ok := out[fd.Key]; !ok || v == nil {
			out[fd.Key] = fd.Default
		}
	}
	return out
}

// resolveInput 定输入：消息带进来的触发字段 + 手填的（手填优先）；都没有时 IM 触发取最近一条消息、其余用默认值。
func (d *debugger) resolveInput(ctx context.Context, f Flow, q DebugReq, res *Debug) (Json, error) {
	input := Json{}
	msgID, source := q.MessageID, "message"
	if msgID == "" && len(q.Input) == 0 && f.Trigger == imTrigger {
		msgID, source = d.latestMessage(ctx, f.ID)
		if msgID == "" {
			return nil, apiErr(errValidation, "IM 触发的流程调试要选一条消息：这条流程还没有执行或没发起的记录可取")
		}
	}
	switch {
	case msgID != "":
		msg, err := d.readMessage(ctx, f.ID, msgID)
		if err != nil {
			return nil, err
		}
		res.Source, res.MessageID, res.Message = source, msgID, msg
		input = triggerInput(msgID, msg)
		if _, ok := msg["conversation_id"]; !ok {
			res.Notes = append(res.Notes, "IM 插件版本旧，读取消息没给会话 id、与我的关系等归类，只带了 message_id；升级 IM 插件到 0.28.0")
		}
	case len(q.Input) > 0:
		res.Source = "input"
	default:
		res.Source = "defaults"
	}
	for k, v := range q.Input {
		input[k] = v
	}
	if len(q.Input) > 0 && msgID != "" {
		res.Notes = append(res.Notes, "手填的输入覆盖了消息带进来的同名字段")
	}
	return input, nil
}

// latestMessage 是这条流程最近一次执行的输入里的 message_id，没有再取最近一次没发起的记录。
func (d *debugger) latestMessage(ctx context.Context, flowID string) (string, string) {
	if flowID == "" {
		return "", ""
	}
	var id *string
	err := d.c.Store().QueryRow(ctx, `SELECT json_extract(input, '$.message_id') FROM sop_runs WHERE flow_id = ?
		AND COALESCE(json_extract(input, '$.message_id'), '') != '' ORDER BY started_at DESC LIMIT 1`, flowID).Scan(&id)
	if err == nil && id != nil && *id != "" {
		return *id, "latest_run"
	}
	var ref string
	if err := d.c.Store().QueryRow(ctx, `SELECT source_ref FROM sop_skips WHERE flow_id = ? AND source = ? AND source_ref != ''
		ORDER BY at DESC, rowid DESC LIMIT 1`, flowID, SourceIM).Scan(&ref); err == nil && ref != "" {
		return ref, "latest_skip"
	}
	return "", ""
}

const getMessageKind = "im_get_message"

// readMessage 用 IM 插件的「读取消息」节点取一条消息（只读），回它的 message。
func (d *debugger) readMessage(ctx context.Context, flowID, id string) (Json, error) {
	out, err := d.c.SOP().RunNode(ctx, getMessageKind, plugin.SOPNodeInput{RunID: "debug", FlowID: flowID, Step: "__debug", Attempt: 1,
		Input: map[string]any{"message_id": id}, Config: map[string]string{"message": id}})
	switch {
	case errors.Is(err, plugin.ErrNodeUnavailable):
		return nil, apiErr(errConflict, "IM 插件没在运行，取不到消息 %s", id)
	case err != nil:
		return nil, apiErr(errValidation, "取消息 %s 失败：%s", id, err.Error())
	}
	b, _ := json.Marshal(out["message"])
	var msg Json
	_ = json.Unmarshal(b, &msg)
	if msg == nil {
		return nil, apiErr(errValidation, "取消息 %s 失败：读取消息没回 message", id)
	}
	return msg, nil
}

// triggerInput 是 IM 触发时事件带进输入的字段（同 imtrigger.go 的 base），按消息补上。
func triggerInput(id string, msg Json) Json {
	s := func(k string) string { return txt(msg[k]) }
	return Json{"message_id": id, "channel": s("channel"), "connector_id": s("connector_id"), "conversation_id": s("conversation_id"),
		"stakeholder_id": s("contact_id"), "relevance": s("relevance_key"), "at": s("at")}
}

// walk 按依赖逐步走：同引擎的 advance（engine.go），不等、不落库。
func (d *debugger) walk(ctx context.Context, f Flow, defs []stepDef, idx map[string]int, input Json, q DebugReq, debugID string) []DebugStep {
	steps := make([]DebugStep, len(defs))
	kinds := kindsOf(d.c)
	for i, def := range defs {
		t, _ := kinds(def.Kind)
		steps[i] = DebugStep{Key: def.Key, Name: orDefault(strings.TrimSpace(def.Name), def.Key), Kind: def.Kind, Effect: t.Effect, Fields: []FieldInfo{}}
		if steps[i].Effect == "" {
			steps[i].Effect = effWrite
		}
	}
	over := func(s string) bool { return s != "" }
	for changed := true; changed; {
		changed = false
		for i := range defs {
			s := &steps[i]
			if over(s.Status) {
				continue
			}
			deps := depsOf(defs, idx, i)
			if slices.ContainsFunc(deps, func(j int) bool { return !over(steps[j].Status) }) {
				continue
			}
			changed = true
			def := defs[i]
			if slices.ContainsFunc(deps, func(j int) bool { return steps[j].Status == dbgFailed || steps[j].Status == dbgNotReached }) {
				s.Status, s.Note = dbgNotReached, "上游没走通，走不到这一步"
				continue
			}
			if def.Branch != nil {
				j, ok := idx[def.Branch.Of]
				switch {
				case ok && steps[j].Route == loopBack:
					s.Status, s.Note = dbgNotReached, "条件回退成立，实际执行会先退回上游重做，调试到那里为止"
					continue
				case !ok || steps[j].Route != def.Branch.Case:
					s.Status, s.Note = dbgBypassed, "所在分支没被选中，不执行"
					continue
				}
			}
			if len(deps) > 0 && !slices.ContainsFunc(deps, func(j int) bool { return steps[j].Status != dbgBypassed }) {
				s.Status, s.Note = dbgBypassed, "所在分支没被选中，不执行"
				continue
			}
			s.Input = stepInput(defs, steps, deps, input)
			started := time.Now()
			d.exec(ctx, f, def, s, deps, defs, q, debugID)
			s.Ms = time.Since(started).Milliseconds()
			if s.Status != dbgFailed && s.Output != nil {
				s.Fields = outputFields(d.c, def, s.Input, s.Output)
			}
		}
	}
	return steps
}

// stepInput 同引擎 inputFor：没有依赖用执行参数；一路依赖用它的输出；汇合时按上游 key 分组（没走到的分支不算）。
func stepInput(defs []stepDef, steps []DebugStep, deps []int, input Json) Json {
	var live []int
	for _, j := range deps {
		if steps[j].Status != dbgBypassed {
			live = append(live, j)
		}
	}
	switch len(live) {
	case 0:
		return clone(input)
	case 1:
		return orEmpty(clone(steps[live[0]].Output))
	}
	out := Json{}
	for _, j := range live {
		out[defs[j].Key] = orEmpty(clone(steps[j].Output))
	}
	return out
}

// exec 执行或模拟一步，结果写进 s。
func (d *debugger) exec(ctx context.Context, f Flow, def stepDef, s *DebugStep, deps []int, defs []stepDef, q DebugReq, debugID string) {
	input := orEmpty(clone(s.Input))
	keys := make([]string, 0, len(deps))
	for _, j := range deps {
		keys = append(keys, defs[j].Key)
	}
	t, known := kindsOf(d.c)(def.Kind)
	switch {
	case !known:
		s.Status, s.Error = dbgFailed, fmt.Sprintf("节点类型 %s 不存在", def.Kind)
		return
	case def.Kind == "decide" && isManual(def):
		d.route(def, s, input, q, "人工判断：实际执行会停下等人选分支")
		return
	case def.Kind == "review":
		s.Status, s.Output = dbgSimulated, input
		s.Note = "人工检查：实际执行会停下等人看，调试按「检查通过、输出不改」往下走"
		return
	case def.Kind == "wait":
		dur := orDefault(def.Config["duration"], "1 小时")
		if _, err := parseWait(def.Config["duration"]); err != nil {
			s.Status, s.Error = dbgFailed, err.Error()
			return
		}
		s.Status, s.Output = dbgSimulated, with(input, "waited", dur)
		s.Note = "等待：实际执行会停 " + dur + " 再往下走，调试不等"
		return
	case def.Kind == "notify":
		s.Status, s.Error = dbgFailed, notWired+"（正式产品用 IM 插件的发消息节点）"
		return
	case def.Kind == "subflow":
		ref := def.Config["sop"]
		sub, err := findFlow(ctx, d.c, ref)
		if err != nil {
			s.Status, s.Error = dbgFailed, fmt.Sprintf("子流程「%s」不存在", ref)
			return
		}
		s.Status, s.Action = dbgSimulated, &DebugAction{Text: fmt.Sprintf("将执行子流程「%s」（输入是这一步的输入）", sub.Name),
			Params: []DebugParam{{Key: "sop", Label: "子流程", Value: sub.Name + "（" + sub.ID + "）"}}}
		s.Output = with(input, "subflow", map[string]any{"run_id": placeholderText, "flow_id": sub.ID, "sop": sub.Name, "status": "done", "output": map[string]any{}})
		s.Note = "子流程不在这里起执行，要看它怎么走就单独调试那条流程"
		return
	}
	if def.Kind == "decide" || def.Kind == loopbackKind {
		c, err := condDetail(def, input)
		if err != nil {
			s.Status, s.Error = dbgFailed, err.Error()
			return
		}
		s.Cond = c
	}
	switch t.Effect {
	case effCompute, effRead:
		res := d.real(ctx, f, def, input, keys, debugID)
		d.settle(def, s, res)
		if def.Kind == loopbackKind && s.Route == loopBack {
			s.Note = fmt.Sprintf("条件成立：实际执行会退回「%s」重做，调试不退回、到这里为止", def.Config["target"])
		}
	case effModel:
		if q.SkipModels {
			d.skipModel(def, s, input, q)
			return
		}
		release := func() {}
		if d.e != nil {
			rel, err := d.e.gate.acquire(ctx, time.Now(), "debug", def.Key, func(int) {})
			if err != nil {
				s.Status, s.Error = dbgFailed, "等模型名额时取消了"
				return
			}
			release = rel
		}
		res := execNode(ctx, d.c, def, input, keys, f.Trigger == imTrigger)
		release()
		d.settle(def, s, res)
	default:
		d.simulate(def, t, s, input)
	}
}

// real 真实执行只读、只算的节点：内置的走 execNode，插件的经 SOP().RunNode。
func (d *debugger) real(ctx context.Context, f Flow, def stepDef, input Json, keys []string, debugID string) nodeResult {
	if !isPluginKind(def.Kind) {
		return execNode(ctx, d.c, def, input, keys, f.Trigger == imTrigger)
	}
	cfg := make(map[string]string, len(def.Config))
	for k, v := range def.Config {
		cfg[k] = v
	}
	out, err := d.c.SOP().RunNode(ctx, def.Kind, plugin.SOPNodeInput{RunID: debugID, FlowID: f.ID, Step: def.Key, Attempt: 1, Input: input, Config: cfg})
	switch {
	case errors.Is(err, plugin.ErrWaiting):
		return nodeResult{err: "这个节点要停下等外部事件，调试里不能真实执行：" + waitReason(err)}
	case errors.Is(err, plugin.ErrNodeUnavailable):
		return nodeResult{err: plugin.ErrNodeUnavailable.Error()}
	case err != nil:
		return nodeResult{err: err.Error()}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nodeResult{err: "节点的输出不能转成 JSON：" + err.Error()}
	}
	var res Json
	_ = json.Unmarshal(b, &res)
	return nodeResult{output: orEmpty(res)}
}

// settle 把真实执行的结果记进 s。
func (d *debugger) settle(def stepDef, s *DebugStep, res nodeResult) {
	s.Log = res.log
	switch {
	case res.err != "":
		s.Status, s.Error = dbgFailed, res.err
	case res.waiting != "":
		s.Status, s.Error = dbgFailed, "这个节点要停下等外部事件，调试里不能真实执行："+res.waiting
	default:
		s.Status, s.Output = dbgDone, orEmpty(res.output)
		if res.route != "" {
			s.Route, s.RouteReason = res.route, res.reason
			s.RouteLabel = caseLabel(def, res.route)
			if res.route == loopBack {
				s.RouteLabel = "退回重做"
			}
		}
		if res.review {
			s.Note = "实际执行到这里会停下等人检查"
		}
	}
}

// route 是人工判断（和跳过调模型的问题分类器）：按 routes 指定的分支走，没指定走第一个。
func (d *debugger) route(def stepDef, s *DebugStep, input Json, q DebugReq, why string) {
	if len(def.Cases) == 0 {
		s.Status, s.Error = dbgFailed, "分支节点没有分支"
		return
	}
	c := def.Cases[0]
	how := "没指定，按第一个分支「" + c.Label + "」走"
	if k := q.Routes[def.Key]; k != "" {
		if i := slices.IndexFunc(def.Cases, func(x Case) bool { return x.Key == k }); i >= 0 {
			c, how = def.Cases[i], "按调试时指定的「"+def.Cases[i].Label+"」走"
		}
	}
	s.Status, s.Output, s.Route, s.RouteLabel = dbgSimulated, input, c.Key, c.Label
	s.RouteReason = how
	s.Note = why + "；调试" + how
}

// skipModel 是选了跳过调模型：输出字段用占位值，问题分类器按指定的分支走。
func (d *debugger) skipModel(def stepDef, s *DebugStep, input Json, q DebugReq) {
	switch def.Kind {
	case "classifier":
		d.route(def, s, input, q, "问题分类器：跳过了调模型")
		s.Status = dbgModelSkip
		return
	case "extract":
		ex := map[string]any{}
		for _, k := range list(def.Config["fields"]) {
			ex[k] = ""
		}
		s.Output = with(input, "extracted", ex)
	case "iterate":
		var results []any
		if arr, ok := getPath(input, def.Config["list"]).([]any); ok {
			for _, it := range arr {
				results = append(results, map[string]any{"item": it, "result": skippedModel})
			}
		}
		if results == nil {
			results = []any{}
		}
		s.Output = with(input, "results", results)
	default:
		s.Output = with(input, orDefault(strings.TrimSpace(def.Config["output"]), "result"), skippedModel)
	}
	s.Status, s.Note = dbgModelSkip, "跳过了调模型，输出字段是占位值"
}

// simulate 是写操作、等待类的插件节点：不执行，列出将做什么，声明的输出字段用占位值。
func (d *debugger) simulate(def stepDef, t NodeType, s *DebugStep, input Json) {
	params := renderParams(def, t, input)
	s.Action = &DebugAction{Text: actionText(def, t, params), Params: params}
	s.Output = placeholders(input, declaredOutputs(def, t))
	s.Status = dbgSimulated
	switch t.Effect {
	case effWait:
		s.Note = "要等外部事件：调试不等，" + orDefault(t.DryRun, "声明的输出字段用占位值往下走")
	default:
		s.Note = "写操作：调试不执行，" + orDefault(t.DryRun, "只列出将用的配置，声明的输出字段用占位值")
	}
}

// renderParams 是节点声明的配置项这次的值：没填用默认值，能写 {{字段}} 的按输入渲染；空的不列。
func renderParams(def stepDef, t NodeType, input Json) []DebugParam {
	out := []DebugParam{}
	seen := map[string]bool{}
	add := func(key, label, raw string, tpl bool, opts []Option) {
		seen[key] = true
		if strings.TrimSpace(raw) == "" {
			return
		}
		v := raw
		if tpl {
			v = render(raw, input)
		}
		for _, o := range opts {
			if o.Value == v && o.Label != "" && o.Label != v {
				v = o.Label + "（" + o.Value + "）"
				break
			}
		}
		out = append(out, DebugParam{Key: key, Label: orDefault(label, key), Value: clipRunes(v, 2000)})
	}
	for _, p := range t.Params {
		raw := def.Config[p.Key]
		if strings.TrimSpace(raw) == "" {
			raw = p.Default
		}
		add(p.Key, p.Label, raw, p.Template, p.Options)
	}
	// 没声明配置项的插件节点：配置原样列出（按 {{字段}} 渲染）
	for _, k := range sortedStrKeys(def.Config) {
		if !seen[k] {
			add(k, k, def.Config[k], true, nil)
		}
	}
	return out
}

func sortedStrKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// actionTexts 是常见写节点「将做什么」的说法，{配置项} 换成渲染后的值；没列的用「将执行「节点名」」加配置。
var actionTexts = map[string]string{
	"im_mark_message":   "将把消息 {message} 标为「{state}」",
	"im_send_message":   "将往会话 {conversation} 发一条消息：{text}",
	"im_reply_message":  "将在原消息 {message} 的串里回复：{text}",
	"im_set_project":    "将把消息 {message} 归到项目 {project}",
	"im_to_task":        "将把消息 {message} 转成任务",
	"im_tell_me":        "将私信我：{text}",
	"im_ask_me":         "将私信我确认并等我回复：{text}",
	"im_send_contact":   "将私信联系人 {contact}：{text}",
	"im_notify":         "将发一条平台通知：{text}",
	"im_ack_task":       "将在原消息的会话里回执需求方：{text}",
	"im_set_task_stage": "将改任务 {task} 的看板阶段",
	"im_wait_reply":     "将等会话 {conversation} 里对方的下一条消息（超时 {timeout}）",
	"im_wait_task":      "将等任务 {task} 完成（超时 {timeout}）",
	"task":              "将建任务「{title}」",
	"task_update":       "将改任务 {task}",
	"local_append":      "将往项目 {project} 的 {path} 写入内容",
	"http":              "将发 {method} {url}",
	"agent":             "将把这一步交给 Agent {agent}",
	"claude_code":       "将交给 Claude Code 在 {workdir} 执行",
	"task_run":          "将把任务 {task} 交给 Claude Code 执行",
	"contact":           "将写联系人 {name}",
}

func actionText(def stepDef, t NodeType, params []DebugParam) string {
	val := map[string]string{}
	for _, p := range params {
		val[p.Key] = p.Value
	}
	if def.Kind == "doc" {
		if def.Config["mode"] == "append" {
			return "将把内容追加到文档 " + orDefault(val["doc"], "（没填）")
		}
		return "将新建文档「" + orDefault(val["title"], "流程名 · 步骤名") + "」"
	}
	if tpl, ok := actionTexts[def.Kind]; ok {
		out := tpl
		for _, k := range placeholderKeys(tpl) {
			out = strings.ReplaceAll(out, "{"+k+"}", orDefault(clipRunes(oneLineText(val[k]), 120), "（没填）"))
		}
		return out
	}
	label := orDefault(t.Label, def.Kind)
	if len(params) == 0 {
		return "将执行「" + label + "」"
	}
	parts := make([]string, 0, len(params))
	for _, p := range params {
		parts = append(parts, p.Label+" "+clipRunes(oneLineText(p.Value), 60))
	}
	return "将执行「" + label + "」：" + strings.Join(parts, "；")
}

func placeholderKeys(tpl string) []string {
	var out []string
	for {
		i := strings.Index(tpl, "{")
		if i < 0 {
			return out
		}
		j := strings.Index(tpl[i:], "}")
		if j < 0 {
			return out
		}
		out = append(out, tpl[i+1:i+j])
		tpl = tpl[i+j+1:]
	}
}

func oneLineText(s string) string { return strings.Join(strings.Fields(s), " ") }

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// declaredOutputs 是这一步声明加到输出里的字段（路径里的 {配置项} 换好）；提取节点按配置的字段补。
func declaredOutputs(def stepDef, t NodeType) []FieldInfo {
	var out []FieldInfo
	for _, o := range t.Outputs {
		out = append(out, outInfo(o, expandPath(o.Path, def.Config, t.Params)))
	}
	if def.Kind == "extract" {
		for _, k := range list(def.Config["fields"]) {
			out = append(out, FieldInfo{Path: "extracted." + k, Type: "string", Label: "提取出的「" + k + "」", Declared: true})
		}
	}
	return out
}

// placeholders 是模拟节点的输出：输入原样往下传，声明的字段填占位值（有取值说明的取第一个，文字是「(调试占位)」）。
func placeholders(input Json, outs []FieldInfo) Json {
	out := clone(input)
	if out == nil {
		out = Json{}
	}
	// 声明里的顶层字段先清掉（写节点的输出是整块换掉的，比如 task），再按路径填
	for _, o := range outs {
		if sg := segs(o.Path); len(sg) > 0 {
			delete(out, sg[0])
		}
	}
	for _, o := range outs {
		setPath(out, o.Path, placeholderOf(o))
	}
	return out
}

func placeholderOf(o FieldInfo) any {
	if len(o.Values) > 0 {
		return o.Values[0].Value
	}
	switch o.Type {
	case "object":
		return map[string]any{}
	case "list":
		return []any{}
	case "number":
		return 0
	case "bool":
		return false
	}
	return placeholderText
}

// setPath 按 a.b.c 写值，中间缺的对象补上；已有的对象不整个覆盖（先写的 task 对象、后写的 task.ref）。
func setPath(obj Json, path string, v any) {
	sg := segs(path)
	if len(sg) == 0 {
		return
	}
	cur := obj
	for _, k := range sg[:len(sg)-1] {
		next, ok := cur[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[k] = next
		}
		cur = next
	}
	last := sg[len(sg)-1]
	if _, isMap := v.(map[string]any); isMap {
		if _, has := cur[last].(map[string]any); has {
			return
		}
	}
	cur[last] = v
}

// condDetail 是条件这次怎么判的：每条条件的真实值和结果。旧规则写法不认时回错误（同执行）。
func condDetail(def stepDef, input Json) (*DebugCond, error) {
	if !hasCondition(def) {
		return nil, nil
	}
	c, text := stepCond(def)
	if c == nil {
		if _, err := evalRule(def.Rule, input); err != nil {
			return nil, err
		}
		return nil, nil
	}
	out := &DebugCond{Logic: orDefault(c.Logic, logicAnd), Text: text, Items: []DebugCondItem{}, Result: evalCond(c, input)}
	for _, it := range c.Items {
		got := getPath(input, strings.TrimSpace(it.Field))
		out.Items = append(out.Items, DebugCondItem{Field: it.Field, Op: it.Op, OpLabel: opLabel(it.Op), Value: it.Value,
			Actual: sampleOf(got, 0), Found: got != nil, OK: evalItem(it, input)})
	}
	return out, nil
}

// outputFields 是这一步加到输出里的字段：声明的带真实值；实际多出来、没声明的标 declared=false。
func outputFields(c plugin.Core, def stepDef, input, output Json) []FieldInfo {
	t, known := kindsOf(c)(def.Kind)
	var decl []FieldInfo
	if known {
		decl = declaredOutputs(def, t)
	}
	out := make([]FieldInfo, 0, len(decl))
	for _, f := range decl {
		if v := getPath(output, f.Path); v != nil {
			f.Sample = sampleOf(v, 0)
		}
		out = append(out, f)
	}
	if def.Kind == "end" || def.Kind == "aggregate" {
		// 结束节点挑字段、变量聚合重组输入，不算这一步「加」的字段
		return out
	}
	return append(out, undeclaredIn(output, input, decl)...)
}

// undeclaredIn 是 value 里（和 base 相同的顶层字段不算）没被 decl 覆盖的叶子字段，按路径排序。
func undeclaredIn(value, base Json, decl []FieldInfo) []FieldInfo {
	var out []FieldInfo
	var walk func(path string, v any, depth int)
	walk = func(path string, v any, depth int) {
		if m, ok := v.(map[string]any); ok && len(m) > 0 && depth < 4 {
			for _, k := range sortedKeys(m) {
				walk(path+"."+k, m[k], depth+1)
			}
			return
		}
		if covered(decl, path) {
			return
		}
		out = append(out, FieldInfo{Path: path, Type: typeOfValue(v), Label: "未声明：这次实际返回了，节点的字段表里没有", Declared: false, Sample: sampleOf(v, 0)})
	}
	for _, k := range sortedKeys(value) {
		if bv, ok := base[k]; ok && reflect.DeepEqual(bv, value[k]) {
			continue
		}
		walk(k, value[k], 0)
	}
	return out
}

// covered 是 decl 里有字段能取到 path（同 flowFields.lookup：列了子字段的对象只认列出来的）。
func covered(decl []FieldInfo, path string) bool {
	for _, f := range decl {
		typ := f.Type
		if !f.Open && hasChildren(decl, f.Path) {
			typ = "closed"
		}
		if pathCovers(f.Path, typ, path) {
			return true
		}
	}
	return false
}

func typeOfValue(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case float64, int, int64:
		return "number"
	case bool:
		return "bool"
	case map[string]any:
		return "object"
	case []any:
		return "list"
	}
	return "any"
}

// sampleOf 是给界面看的真实值：长文字截断、列表只留前 5 项、嵌套太深的截掉。
func sampleOf(v any, depth int) any {
	switch x := v.(type) {
	case string:
		return clipRunes(x, sampleRunes)
	case map[string]any:
		if depth >= 3 {
			return "{…}"
		}
		out := make(map[string]any, len(x))
		for k, y := range x {
			out[k] = sampleOf(y, depth+1)
		}
		return out
	case []any:
		if depth >= 3 {
			return "[…]"
		}
		n := min(len(x), 5)
		out := make([]any, 0, n)
		for _, y := range x[:n] {
			out = append(out, sampleOf(y, depth+1))
		}
		return out
	}
	return v
}

func dbgOverall(steps []DebugStep) string {
	switch {
	case slices.ContainsFunc(steps, func(s DebugStep) bool { return s.Status == dbgFailed }):
		return "failed"
	case slices.ContainsFunc(steps, func(s DebugStep) bool { return s.Route == loopBack }):
		return "stopped"
	}
	return "done"
}

// debugSummary 是一段给人（和模型）看的结论：输入从哪来、各类步骤几步、分支怎么走、将做的写操作、失败。
func debugSummary(res *Debug, defs []stepDef) string {
	var b strings.Builder
	switch res.Source {
	case "message", "latest_run", "latest_skip":
		from := map[string]string{"message": "", "latest_run": "（这条流程最近一次执行的消息）", "latest_skip": "（这条流程最近一次没发起的消息）"}[res.Source]
		fmt.Fprintf(&b, "用消息 %s%s", res.MessageID, from)
		if txt := strings.TrimSpace(txt(res.Message["text"])); txt != "" {
			fmt.Fprintf(&b, "「%s」", clipRunes(oneLineText(txt), 40))
		}
		b.WriteString("调试。")
	case "input":
		b.WriteString("用手填的输入调试。")
	default:
		b.WriteString("用输入字段的默认值调试。")
	}
	if res.InputError != "" {
		b.WriteString(res.InputError + "。")
	}
	count := map[string]int{}
	for _, s := range res.Steps {
		count[s.Status]++
	}
	parts := []string{}
	for _, x := range []struct{ k, label string }{{dbgDone, "真实执行"}, {dbgSimulated, "模拟（不真写）"}, {dbgModelSkip, "跳过调模型"},
		{dbgFailed, "失败"}, {dbgBypassed, "分支没走"}, {dbgNotReached, "没走到"}} {
		if count[x.k] > 0 {
			parts = append(parts, fmt.Sprintf("%s %d 步", x.label, count[x.k]))
		}
	}
	fmt.Fprintf(&b, "共 %d 步：%s。", len(res.Steps), strings.Join(parts, "、"))
	for _, s := range res.Steps {
		if s.Route != "" {
			fmt.Fprintf(&b, "「%s」走「%s」", s.Name, s.RouteLabel)
			if s.Cond != nil {
				fmt.Fprintf(&b, "（%s：%s）", s.Cond.Text, condActualText(s.Cond))
			}
			b.WriteString("。")
		}
	}
	for _, s := range res.Steps {
		if s.Action != nil && s.Status == dbgSimulated {
			fmt.Fprintf(&b, "「%s」%s（没真做）。", s.Name, s.Action.Text)
		}
	}
	for _, s := range res.Steps {
		if s.Status == dbgFailed {
			fmt.Fprintf(&b, "「%s」失败：%s。", s.Name, s.Error)
		}
	}
	if len(res.Steps) > 0 && !slices.ContainsFunc(res.Steps, func(s DebugStep) bool { return s.Status == dbgFailed }) && res.InputError == "" {
		b.WriteString("没有失败的步骤。")
	}
	return b.String()
}

// condActualText 是每条条件的真实值和结果：「relevance 实际 me 成立」。
func condActualText(c *DebugCond) string {
	parts := make([]string, len(c.Items))
	for i, it := range c.Items {
		got := "取不到（空）"
		if it.Found {
			got = "实际 " + clipRunes(oneLineText(txt(it.Actual)), 40)
		}
		ok := "不成立"
		if it.OK {
			ok = "成立"
		}
		parts[i] = fmt.Sprintf("%s %s %s", it.Field, got, ok)
	}
	res := "整体不成立"
	if c.Result {
		res = "整体成立"
	}
	return strings.Join(parts, "，") + "，" + res
}

// debugReport 是给 Agent（test_sop）看的完整结论：结论一段，再逐步列出。
func debugReport(res *Debug) string {
	var b strings.Builder
	fmt.Fprintf(&b, "调试「%s」（%s，不真写、不建执行记录）：%s\n", res.FlowName, res.FlowID, res.Summary)
	if len(res.Notes) > 0 {
		b.WriteString("说明：" + strings.Join(res.Notes, "；") + "\n")
	}
	if errs := errorsOf(res.Issues); len(errs) > 0 {
		b.WriteString("保存校验有错误（先改掉）：\n")
		for _, x := range errs {
			b.WriteString("- " + x.Text + "\n")
		}
	}
	if len(res.Message) > 0 {
		fmt.Fprintf(&b, "消息：发信人=%s 会话=%s 与我的关系=%s 正文=%s\n", txt(res.Message["sender"]), txt(res.Message["conversation"]),
			txt(res.Message["relevance"]), clipRunes(oneLineText(txt(res.Message["text"])), 200))
	}
	label := map[string]string{dbgDone: "真实执行", dbgSimulated: "模拟", dbgModelSkip: "跳过调模型", dbgFailed: "失败", dbgBypassed: "分支没走", dbgNotReached: "没走到"}
	b.WriteString("逐步：\n")
	for i, s := range res.Steps {
		fmt.Fprintf(&b, "%d. 「%s」（%s）%s", i+1, s.Name, s.Kind, label[s.Status])
		switch {
		case s.Error != "":
			b.WriteString("：" + s.Error)
		case s.Action != nil:
			b.WriteString("：" + s.Action.Text)
		case s.Route != "":
			fmt.Fprintf(&b, "：走「%s」", s.RouteLabel)
			if s.Cond != nil {
				fmt.Fprintf(&b, "，%s", condActualText(s.Cond))
			}
		}
		if s.Note != "" && s.Status != dbgSimulated {
			b.WriteString("（" + s.Note + "）")
		}
		var undecl []string
		for _, f := range s.Fields {
			if !f.Declared {
				undecl = append(undecl, f.Path)
			}
		}
		if len(undecl) > 0 {
			fmt.Fprintf(&b, "；实际多返回了没声明的字段 %s", strings.Join(undecl, "、"))
		}
		if s.Status == dbgDone && s.Kind == getMessageKind {
			if m, ok := s.Output["message"].(map[string]any); ok {
				fmt.Fprintf(&b, "；取到 message.text=%s", clipRunes(oneLineText(txt(m["text"])), 80))
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}
