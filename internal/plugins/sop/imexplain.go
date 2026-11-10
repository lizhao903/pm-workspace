// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
)

// 模拟 IM 触发（TSK-0491）：POST /api/sop/im-explain。拿一条真实消息（或手填的归类），按 IM 触发的真实口径（imtrigger.go）
// 把每条 IM 流程按执行顺序判一遍：过滤条件哪条不符、这条消息是不是已经为它发起过、必填输入补不补得齐、是否被前面的流程拦截，
// 最终会发起哪几条。不发起、不记没发起的记录、不改任何东西。
// 消息入库时发信人被自动忽略（IM 插件 TSK-0495）的，IM 插件不发 im.message_received，所有 IM 流程都收不到；
// 消息超过 24 小时的（连接器首次同步带进的历史）也不发起，这两种照样按「假如现在收到」把每条流程判一遍，结论里写明。

// IMExplainCheck 是过滤条件的一项：conversation（会话）或 relevance（与我的关系）。
type IMExplainCheck struct {
	Key  string   `json:"key"`
	OK   bool     `json:"ok"`
	Want []string `json:"want"`
	Mode string   `json:"mode,omitempty"`
	Got  string   `json:"got"`
	Text string   `json:"text"`
}

// IMExplainFlow 是一条 IM 流程的判定。
type IMExplainFlow struct {
	FlowID string `json:"flow_id"`
	Name   string `json:"name"`
	Order  int    `json:"order"`
	Stop   bool   `json:"stop"`
	// Verdict：start（会发起）、already（这条消息已经为它发起过，不再发起，但算命中、拦截照样生效）、
	// filtered（过滤不符）、missing（必填输入补不齐）、stopped（被前面的流程拦截）、muted（发信人被自动忽略，收不到）
	Verdict string              `json:"verdict"`
	Reason  string              `json:"reason"`
	Checks  []IMExplainCheck    `json:"checks"`
	Missing []map[string]string `json:"missing"`
	// ByFlow 是拦截它的流程（verdict 为 stopped 时）
	ByFlowID string `json:"by_flow_id,omitempty"`
	ByFlow   string `json:"by_flow,omitempty"`
	// RunID 是已经为这条消息发起过的执行（verdict 为 already 时）
	RunID string `json:"run_id,omitempty"`
	// Draft 是这一条用的是编辑器里没保存的草稿
	Draft bool `json:"draft,omitempty"`
	// Input 是会发起时的输入（start 时），其余为 null
	Input Json `json:"input"`
}

// IMExplain 是模拟 IM 触发的结果。
type IMExplain struct {
	MessageID string `json:"message_id,omitempty"`
	// Message 是读取消息节点取到的 message（手填归类时只有这几项）
	Message Json `json:"message"`
	// Event 是 im.message_received 会带的归类
	Event Json `json:"event"`
	// Delivered 为 false 时 IM 插件根本不会把这条消息交给 SOP（发信人被自动忽略），Muted 说明是哪条自动忽略
	Delivered bool `json:"delivered"`
	Muted     Json `json:"muted"`
	// SenderMuted 是发信人现在命中的自动忽略（这条消息入库后才设的也算）：之后这个人的新消息不会触发
	SenderMuted Json `json:"sender_muted"`
	// Stale 为真是消息超过 24 小时：真实触发时不发起
	Stale     bool            `json:"stale"`
	Flows     []IMExplainFlow `json:"flows"`
	WillStart []string        `json:"will_start"`
	Summary   string          `json:"summary"`
	Notes     []string        `json:"notes"`
}

// explainIM 是 POST /api/sop/im-explain：{message_id?, message?: {channel, connector_id, conversation_id, stakeholder_id, relevance, at}, draft?}。
// draft 是编辑器里没保存的那条流程（带 id 的替换库里的同一条；没有 id 或库里没有的按草稿的顺序插进去，触发方式不是 im 的从名单里拿掉）。
func (d *debugger) explainIM(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	var q struct {
		MessageID string `json:"message_id"`
		Message   *struct {
			Channel        string `json:"channel"`
			ConnectorID    string `json:"connector_id"`
			ConversationID string `json:"conversation_id"`
			StakeholderID  string `json:"stakeholder_id"`
			Relevance      string `json:"relevance"`
			At             string `json:"at"`
		} `json:"message"`
	}
	b, _ := json.Marshal(raw)
	if json.Unmarshal(b, &q) != nil {
		fail(w, r, d.c, apiErr(errValidation, "message_id 必须是字符串，message 必须是对象"))
		return
	}
	var draft *Flow
	if v, ok := raw["draft"]; ok && string(v) != "null" {
		f, _, err := readDraft(v, kindsOf(d.c))
		if err != nil {
			fail(w, r, d.c, err)
			return
		}
		draft = &f
	}
	var ev *imReceived
	if q.Message != nil && strings.TrimSpace(q.MessageID) == "" {
		m := q.Message
		ev = &imReceived{Channel: m.Channel, ConnectorID: m.ConnectorID, ConversationID: strPtr(m.ConversationID),
			StakeholderID: strPtr(m.StakeholderID), Relevance: strings.TrimSpace(m.Relevance), At: m.At}
		if ev.Relevance == imRelNone {
			ev.Relevance = ""
		}
	} else if strings.TrimSpace(q.MessageID) == "" {
		fail(w, r, d.c, apiErr(errValidation, "要带 message_id，或手填的 message"))
		return
	}
	res, err := d.explain(r.Context(), strings.TrimSpace(q.MessageID), ev, draft)
	if err != nil {
		fail(w, r, d.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

func strPtr(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

// explain 按真实口径判一遍。msgID 非空时取真实消息；否则用 ev（手填的归类）。
func (d *debugger) explain(ctx context.Context, msgID string, ev *imReceived, draft *Flow) (*IMExplain, error) {
	res := &IMExplain{MessageID: msgID, Delivered: true, Flows: []IMExplainFlow{}, WillStart: []string{}, Notes: []string{}}
	if msgID != "" {
		msg, err := d.readMessage(ctx, "", msgID)
		if err != nil {
			return nil, err
		}
		res.Message = msg
		in := triggerInput(msgID, msg)
		ev = &imReceived{MessageID: msgID, Channel: txt(in["channel"]), ConnectorID: txt(in["connector_id"]),
			ConversationID: strPtr(txt(in["conversation_id"])), StakeholderID: strPtr(txt(in["stakeholder_id"])),
			Relevance: txt(in["relevance"]), At: txt(in["at"])}
		if _, ok := msg["conversation_id"]; !ok {
			res.Notes = append(res.Notes, "IM 插件版本旧，读取消息没给会话 id、与我的关系等归类，过滤条件判不准；升级 IM 插件到 0.28.0")
		}
		if m, ok := msg["muted"].(map[string]any); ok && len(m) > 0 {
			res.Delivered, res.Muted = false, m
		}
		if m, ok := msg["sender_muted"].(map[string]any); ok && len(m) > 0 {
			res.SenderMuted = m
		}
	} else {
		res.Message = Json{"channel": ev.Channel, "conversation_id": deref(ev.ConversationID), "relevance_key": ev.Relevance, "at": ev.At}
	}
	res.Event = Json{"message_id": msgID, "channel": ev.Channel, "connector_id": ev.ConnectorID, "conversation_id": deref(ev.ConversationID),
		"stakeholder_id": deref(ev.StakeholderID), "relevance": ev.Relevance, "at": ev.At}
	if at, err := time.Parse(time.RFC3339Nano, ev.At); err == nil && imTriggerNow().Sub(at) > imTriggerMaxAge {
		res.Stale = true
	}
	list, err := imFlows(ctx, d.c)
	if err != nil {
		return nil, err
	}
	list, drafted := withDraft(list, draft)
	base := Json(res.Event)
	var stopper *Flow
	for i := range list {
		f := list[i]
		x := IMExplainFlow{FlowID: f.ID, Name: f.Name, Order: i + 1, Stop: f.IM.Stop, Checks: imChecks(f.IM, *ev), Missing: []map[string]string{},
			Draft: drafted == f.ID && f.ID != ""}
		if drafted == "" && draft != nil && f.ID == "" {
			x.Draft = true
		}
		hit := !slices.ContainsFunc(x.Checks, func(c IMExplainCheck) bool { return !c.OK })
		switch {
		case !res.Delivered:
			x.Verdict, x.Reason = "muted", "发信人「"+orDefault(txt(res.Muted["name"]), "这个人")+"」被设为自动忽略，消息落库即已忽略，IM 流程收不到"
		case stopper != nil:
			x.Verdict, x.ByFlowID, x.ByFlow = "stopped", stopper.ID, stopper.Name
			x.Reason = fmt.Sprintf("被排在前面的「%s」拦截", stopper.Name)
			if !hit {
				x.Reason += "（过滤条件本来也不符）"
			}
		case !hit:
			why, _ := f.IM.filterMiss(*ev)
			x.Verdict, x.Reason = "filtered", why
		default:
			if run := d.startedRun(ctx, f.ID, msgID); run != "" {
				x.Verdict, x.RunID, x.Reason = "already", run, "这条消息已经为它发起过（执行 "+run+"），不再发起"
			} else if input, err := fillInput(f, base); err != nil {
				_, msg, _ := cutKind(err)
				x.Verdict, x.Missing, x.Reason = "missing", missingFields(f, base), "输入"+msg+"，IM 消息没带上，补不齐，会被跳过"
			} else {
				x.Verdict, x.Input, x.Reason = "start", input, "过滤条件符合，会发起一次执行"
				res.WillStart = append(res.WillStart, f.ID)
			}
			if f.IM.Stop && (x.Verdict == "start" || x.Verdict == "already") {
				stopper = &list[i]
				x.Reason += "；它开了拦截，后面的 IM 流程不再处理这条消息"
			}
		}
		res.Flows = append(res.Flows, x)
	}
	res.Summary = explainSummary(res)
	return res, nil
}

// withDraft 把编辑器里的草稿换进 IM 流程名单：同 id 的替换（触发方式不是 im 了就拿掉），新的按草稿的顺序插进去（没给排最后）。
// 回草稿的 id（新草稿没有 id 时回空串）。
func withDraft(list []Flow, draft *Flow) ([]Flow, string) {
	if draft == nil {
		return list, ""
	}
	out := make([]Flow, 0, len(list)+1)
	for _, f := range list {
		if draft.ID != "" && f.ID == draft.ID {
			if draft.Trigger == imTrigger {
				d := *draft
				d.Name = orDefault(strings.TrimSpace(d.Name), f.Name)
				out = append(out, d)
			}
			continue
		}
		out = append(out, f)
	}
	if draft.Trigger == imTrigger && !slices.ContainsFunc(out, func(f Flow) bool { return draft.ID != "" && f.ID == draft.ID }) {
		at := len(out)
		if draft.IM.Order > 0 && draft.IM.Order-1 < at {
			at = draft.IM.Order - 1
		}
		d := *draft
		d.Name = orDefault(strings.TrimSpace(d.Name), "（编辑中的流程）")
		out = slices.Insert(out, at, d)
	} else if draft.Trigger == imTrigger && draft.IM.Order > 0 {
		// 已有的流程在编辑器里改了顺序：挪到草稿说的位置
		i := slices.IndexFunc(out, func(f Flow) bool { return f.ID == draft.ID })
		to := min(draft.IM.Order-1, len(out)-1)
		if i >= 0 && to != i {
			f := out[i]
			out = slices.Delete(out, i, i+1)
			out = slices.Insert(out, to, f)
		}
	}
	return out, draft.ID
}

// imChecks 是过滤条件逐项的判定；没设的那项不列。
func imChecks(t IMTrigger, m imReceived) []IMExplainCheck {
	out := []IMExplainCheck{}
	if len(t.Conversations) > 0 {
		got := deref(m.ConversationID)
		ok := containsStr(t.Conversations, got)
		text := "会话在过滤条件里"
		if !ok {
			text = fmt.Sprintf("会话 %s 不在过滤条件的 %d 个会话里", orDefault(got, "（没认上会话）"), len(t.Conversations))
		}
		out = append(out, IMExplainCheck{Key: "conversation", OK: ok, Want: t.Conversations, Got: got, Text: text})
	}
	if len(t.Relevance) > 0 {
		rel := m.Relevance
		if rel == "" {
			rel = imRelNone
		}
		ok := t.matches(imReceived{ConversationID: m.ConversationID, Relevance: m.Relevance})
		if len(t.Conversations) > 0 {
			// matches 先看会话，这里只要与我的关系这一项
			ok = IMTrigger{Relevance: t.Relevance, RelevanceMode: t.RelevanceMode}.matches(imReceived{Relevance: m.Relevance})
		}
		labels := make([]string, len(t.Relevance))
		for i, r := range t.Relevance {
			labels[i] = imRelLabel(r)
		}
		verb := "只要"
		if t.RelevanceMode == imModeExclude {
			verb = "排除"
		}
		text := fmt.Sprintf("与我的关系是「%s」，过滤条件%s %s", imRelLabel(rel), verb, strings.Join(labels, "、"))
		out = append(out, IMExplainCheck{Key: "relevance", OK: ok, Want: t.Relevance, Mode: t.RelevanceMode, Got: rel, Text: text})
	}
	return out
}

// startedRun 是已经为这条消息发起过的执行 id（同 IM 触发的去重），没有回空串。手填归类没有消息 id 时不查。
func (d *debugger) startedRun(ctx context.Context, flowID, msgID string) string {
	if flowID == "" || msgID == "" {
		return ""
	}
	var id string
	if err := d.c.Store().QueryRow(ctx, `SELECT id FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?
		ORDER BY started_at LIMIT 1`, flowID, msgID).Scan(&id); err != nil {
		return ""
	}
	return id
}

// explainSummary 是一段结论：消息能不能到 SOP、会发起哪几条、每条没发起的原因。
func explainSummary(res *IMExplain) string {
	var b strings.Builder
	if !res.Delivered {
		fmt.Fprintf(&b, "发信人「%s」被设为自动忽略，这条消息落库即已忽略，IM 插件不会交给 SOP，所有 IM 流程都不会发起。",
			orDefault(txt(res.Muted["name"]), "这个人"))
	}
	if res.Stale {
		b.WriteString("消息发送时间超过 24 小时，真实触发时不发起（连接器首次同步带进的历史）；下面按「假如现在收到」判定。")
	}
	if res.SenderMuted != nil && res.Delivered {
		fmt.Fprintf(&b, "发信人现在命中自动忽略「%s」，之后这个人的新消息不会触发。", orDefault(txt(res.SenderMuted["name"]), "这个人"))
	}
	if len(res.Flows) == 0 {
		b.WriteString("现在没有触发方式是 IM 消息的流程。")
		return b.String()
	}
	var names []string
	for _, f := range res.Flows {
		if f.Verdict == "start" {
			names = append(names, "「"+f.Name+"」")
		}
	}
	if len(names) > 0 && res.Delivered {
		fmt.Fprintf(&b, "会发起 %s。", strings.Join(names, "、"))
	} else if res.Delivered {
		b.WriteString("不会发起任何流程。")
	}
	for _, f := range res.Flows {
		if f.Verdict != "start" && f.Verdict != "muted" {
			fmt.Fprintf(&b, "第 %d 个「%s」：%s。", f.Order, f.Name, f.Reason)
		}
	}
	return b.String()
}

// explainReport 是给 Agent（explain_im_trigger）看的结论：总结一段，再逐条流程列出判定。
func explainReport(res *IMExplain) string {
	var b strings.Builder
	fmt.Fprintf(&b, "模拟消息 %s 触发 IM 流程（不真发起）：%s\n", res.MessageID, res.Summary)
	if len(res.Notes) > 0 {
		b.WriteString("说明：" + strings.Join(res.Notes, "；") + "\n")
	}
	if m := res.Message; len(m) > 0 {
		fmt.Fprintf(&b, "消息：发信人=%s 会话=%s（%s） 与我的关系=%s 状态=%s 正文=%s\n", txt(m["sender"]), txt(m["conversation"]), txt(m["conversation_id"]),
			orDefault(txt(m["relevance"]), "无关"), txt(m["status"]), clipRunes(oneLineText(txt(m["text"])), 200))
	}
	label := map[string]string{"start": "会发起", "already": "已发起过", "filtered": "过滤不符", "missing": "必填补不齐", "stopped": "被拦截", "muted": "收不到"}
	for _, f := range res.Flows {
		fmt.Fprintf(&b, "%d. 「%s」（%s）%s：%s", f.Order, f.Name, f.FlowID, label[f.Verdict], f.Reason)
		if f.Stop {
			b.WriteString("；开了拦截")
		}
		b.WriteString("\n")
	}
	return b.String()
}
