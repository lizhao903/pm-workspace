// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// SOP 节点（SOP-02b）：发消息 im_send_message、等回复 im_wait_reply，经内核的 SOP 节点扩展点登记（plugin-api.md 2.7）。
// 原型的内置 notify 不在 SOP 插件里实现，编辑器里由 im_send_message 代替，SOP 插件不依赖 IM 插件。
//
// 发消息：会话是内核会话 id，内容支持 {{字段}}；连接器和适配器按这个会话最近收到的一条消息找，
// 拦截口径同回复（IM-02a 的 replyBlocker：连接器暂停、断开、只收的发不出；异常的照发，发不出走失败），发出后记一条审计。
// 幂等键是「运行 id/步骤 key#尝试次数」（同 SOP 写节点）：服务重启后重跑同一次尝试时按审计查，发过的不再发（POL-02）。
// 等回复：落一行 im_sop_waits、步骤挂起；后台任务 sop_waits 看会话里有没有对方在挂起之后发的消息，
// 有就唤醒（Core.SOP().Resume），到点还没有就让步骤失败（Core.SOP().Fail）。「对方」是发送人不是「我」的称呼。

const (
	NodeSendMessage = "im_send_message"
	NodeWaitReply   = "im_wait_reply"

	defaultWaitTimeout = time.Hour
	maxWaitTimeout     = 30 * 24 * time.Hour
	auditTextMax       = 500
)

// waitEvery 是多久看一次挂起中的等待；测试里调小。
var waitEvery = 3 * time.Second

// afterSend 在发出、记完审计之后，结果发回之前调，测试用它模拟发完还没落库时进程退出。
var afterSend func(ctx context.Context, step string) error

func (in *inbox) registerSOPNodes(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeSendMessage, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "conversation", Label: "会话"}, {Key: "text", Label: "内容"}},
		Run:      in.sendNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeWaitReply, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "conversation", Label: "会话"}},
		Run:      in.waitNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeGetMessage, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.getMessageNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeMarkMessage, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "state", Label: "标记为"}}, Run: in.markMessageNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeSetProject, Group: "沟通",
		Required: []plugin.SOPNodeField{{Key: "project", Label: "项目"}}, Run: in.setProjectNode})
	r.Job(plugin.Job{Name: "sop_waits", Every: waitEvery, Run: in.waitJob})
}

/* ---------- 读取消息、标记消息（SOP-05） ---------- */

// 读取消息：config.message 是消息 id（支持 {{字段}}，留空取输入的 message_id，IM 触发的流程输入里就有），
// 输出加 message：正文、发信人（认上联系人时 sender 是联系人名）、会话、和我的关系、当前状态。
// 标记消息：config.state 为 done（已处理）、ignore（忽略）、read（已读）、reopen（改回待处理），口径同消息页的处理动作；
// 改的是本插件自己的表，重跑同一次尝试结果一样，不另做幂等。输出加 marked: {message_id, state, status}。

const (
	NodeGetMessage  = "im_get_message"
	NodeMarkMessage = "im_mark_message"
)

// relevanceLabel 同原型 RELEVANCE，给模型看的是字面意思；无关为「无关」。
func relevanceLabel(r string) string {
	if s, ok := map[string]string{"me": "@我", "all": "@所有人", "dm": "私聊"}[r]; ok {
		return s
	}
	return "无关"
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (in *inbox) messageOf(ctx context.Context, cfg map[string]string, input map[string]any) (Message, error) {
	tpl := cfg["message"]
	if strings.TrimSpace(tpl) == "" {
		tpl = "{{message_id}}"
	}
	id := strings.TrimSpace(render(tpl, input))
	if id == "" {
		return Message{}, errors.New("没有指定消息：配置里填消息 id，或者输入里要有 message_id")
	}
	m, err := in.get(ctx, id)
	if errors.Is(err, errNotFound) {
		return m, fmt.Errorf("消息 %s 不存在", id)
	}
	return m, err
}

func (in *inbox) getMessageNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	m, err := in.messageOf(ctx, n.Config, n.Input)
	if err != nil {
		return nil, err
	}
	sender := m.ContactName
	if sender == "" {
		sender = m.SenderName
	}
	kind := map[string]string{"direct": "私聊", "group": "群聊"}[m.ConversationKind]
	return with(n.Input, "message", map[string]any{
		"id": m.ID, "text": m.Text, "sender": sender, "sender_name": m.SenderName, "contact_id": deref(m.StakeholderID),
		"channel": m.Channel, "conversation": m.Conversation, "conversation_kind": kind,
		"relevance": relevanceLabel(m.Relevance), "status": m.Status, "at": m.At,
		// 归到的项目（含群组默认项目兜底），没归为空串
		"project_id": deref(m.ProjectID), "project": m.ProjectName,
		// 归类（0.28.0，TSK-0491）：同 im.message_received 带的，SOP 调试、模拟 IM 触发按它判过滤条件
		"conversation_id": deref(m.ConversationID), "connector_id": m.ConnectorID, "relevance_key": m.Relevance,
		"muted": mutedOut(m.Muted), "sender_muted": in.senderMuted(ctx, m),
	}), nil
}

// mutedOut 是消息入库时被自动忽略的那条（TSK-0495），没有为 nil。
func mutedOut(m *MessageMute) any {
	if m == nil {
		return nil
	}
	return map[string]any{"mute_id": m.MuteID, "name": m.Name, "active": m.Active}
}

// senderMuted 是发信人现在命中的自动忽略（之后的新消息会被自动忽略），没有为 nil；查不了也当没有。
func (in *inbox) senderMuted(ctx context.Context, m Message) any {
	id, name, err := in.muteFor(ctx, row{channel: m.Channel, senderExt: m.SenderID, stakeholderID: m.StakeholderID, convID: m.ConversationID})
	if err != nil || id == "" {
		return nil
	}
	return map[string]any{"mute_id": id, "name": name}
}

func (in *inbox) markMessageNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	state := strings.TrimSpace(n.Config["state"])
	set, ok := stateSet[state]
	if !ok {
		return nil, fmt.Errorf("标记为「%s」不认，只能是 done、ignore、read、reopen", state)
	}
	m, err := in.messageOf(ctx, n.Config, n.Input)
	if err != nil {
		return nil, err
	}
	if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET `+set+` WHERE id = ?`, m.ID); err != nil {
		return nil, err
	}
	if m, err = in.get(ctx, m.ID); err != nil {
		return nil, err
	}
	return with(n.Input, "marked", map[string]any{"message_id": m.ID, "state": state, "status": m.Status}), nil
}

// conversationOf 按配置找会话（内核会话 id，支持 {{字段}}）。
func (in *inbox) conversationOf(ctx context.Context, cfg map[string]string, input map[string]any) (plugin.ConversationInfo, error) {
	id := strings.TrimSpace(render(cfg["conversation"], input))
	if id == "" {
		return plugin.ConversationInfo{}, errors.New("没有指定会话")
	}
	cv, err := in.c.Conversations().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) {
		return cv, fmt.Errorf("会话 %s 不存在", id)
	}
	return cv, err
}

func convLabel(cv plugin.ConversationInfo) string {
	if cv.Name != "" {
		return "「" + cv.Name + "」"
	}
	return "会话 " + cv.ID
}

// convCond 是这个会话里的消息：认上了会话的按 id，到达时会话还没登记的按渠道编号（同 GET /api/im/messages）。
const convCond = `(conversation_id = ? OR (conversation_id IS NULL AND channel = ? AND conversation_external_id = ?))`

func convArgs(id, channel, ext string) []any { return []any{id, channel, ext} }

/* ---------- 发消息 ---------- */

func (in *inbox) sendNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	cv, err := in.conversationOf(ctx, n.Config, n.Input)
	if err != nil {
		return nil, err
	}
	text := strings.TrimSpace(render(n.Config["text"], n.Input))
	if text == "" {
		return nil, errors.New("要发的内容是空的")
	}
	if utf8.RuneCountInString(text) > maxReply {
		return nil, fmt.Errorf("要发的内容超过 %d 字", maxReply)
	}
	meta := plugin.WriteMeta{Session: n.RunID, Key: fmt.Sprintf("%s/%s#%d", n.RunID, n.Step, n.Attempt), Detail: map[string]any{
		"run_id": n.RunID, "flow_id": n.FlowID, "step": n.Step, "attempt": n.Attempt,
	}}
	if out, ok, err := sentBefore(ctx, c, text, n.Input, meta); ok {
		return out, err
	}
	// 用会话里最近收到的一条消息定连接器和适配器；发、记发件记录、记审计走共用的 deliver（0.17.0，outbox.go）
	m, err := in.sendVia(ctx, cv, "")
	if err != nil {
		return nil, err
	}
	res := in.deliver(ctx, cv, m, text, nil, "sop", n.RunID, meta)
	if res.Blocked != nil {
		return nil, res.Blocked
	}
	if res.SendErr != nil {
		return nil, errors.New("发送失败：" + res.Item.Error)
	}
	ext, at := res.Item.ExternalID, res.Item.CreatedAt
	if h := afterSend; h != nil {
		if err := h(ctx, n.Step); err != nil {
			return nil, err
		}
	}
	return with(n.Input, "sent", map[string]any{
		"conversation_id": cv.ID, "conversation": cv.Name, "channel": cv.Channel, "connector_id": m.ConnectorID,
		"text": text, "external_id": ext, "at": at,
	}), nil
}

// sentBefore 查这次尝试有没有发过（审计里有同一幂等键的 send）：发成了回上次的输出，发失败了回上次的错误，都不再发；
// ok 为假时照常发。查不了审计时也照常发，只记日志。
func sentBefore(ctx context.Context, c plugin.Core, text string, input map[string]any, meta plugin.WriteMeta) (map[string]any, bool, error) {
	a, found, ferr := c.Audit().Find(ctx, "send", "conversation", meta)
	if ferr != nil {
		c.Log().Warn("im sop send dedupe lookup failed", "key", meta.Key, "err", ferr)
		return nil, false, nil
	}
	if !found {
		return nil, false, nil
	}
	str := func(k string) string { s, _ := a.Detail[k].(string); return s }
	if str("status") != "sent" {
		return nil, true, errors.New("发送失败：" + str("error"))
	}
	return with(input, "sent", map[string]any{
		"conversation_id": a.TargetID, "conversation": str("conversation"), "channel": str("channel"),
		"connector_id": str("connector_id"), "text": text, "external_id": str("external_id"), "at": a.At, "reused": true,
	}), true, nil
}

// with 同原型 {...input, key: v}。
func with(input map[string]any, key string, v any) map[string]any {
	out := make(map[string]any, len(input)+1)
	for k, x := range input {
		out[k] = x
	}
	out[key] = v
	return out
}

/* ---------- 等回复 ---------- */

func (in *inbox) waitNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	cv, err := in.conversationOf(ctx, n.Config, n.Input)
	if err != nil {
		return nil, err
	}
	d, err := parseTimeout(n.Config["timeout"])
	if err != nil {
		return nil, err
	}
	b, err := json.Marshal(orEmptyMap(n.Input))
	if err != nil {
		return nil, fmt.Errorf("输入不能转成 JSON：%w", err)
	}
	now := in.clock().UTC()
	deadline := now.Add(d)
	_, err = in.c.Store().Exec(ctx, `INSERT INTO im_sop_waits (run_id, step, attempt, conversation_id, channel,
		conversation_external_id, conversation_name, input, since, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (run_id, step) DO UPDATE SET attempt = excluded.attempt, conversation_id = excluded.conversation_id,
		channel = excluded.channel, conversation_external_id = excluded.conversation_external_id,
		conversation_name = excluded.conversation_name, input = excluded.input, since = excluded.since, deadline = excluded.deadline`,
		n.RunID, n.Step, n.Attempt, cv.ID, cv.Channel, cv.ExternalID, cv.Name, string(b), now.Format(timeLayout), deadline.Format(timeLayout))
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("等%s里对方回复，最多等 %s：%w", convLabel(cv), humanDur(d), plugin.ErrWaiting)
}

type sopWait struct {
	runID, step              string
	attempt                  int
	convID, channel, convExt string
	convName, input          string
	since, deadline          string
}

// waitJob 看每个挂起中的等待：会话里有对方的新消息就唤醒，到点了就让步骤失败。
// 唤醒出错（执行还没调度上、SOP 插件没在跑）留着下次再试；到点后不管 Fail 成不成都删掉。
func (in *inbox) waitJob(ctx context.Context, c plugin.Core) error {
	rows, err := in.c.Store().Query(ctx, `SELECT run_id, step, attempt, conversation_id, channel, conversation_external_id,
		conversation_name, input, since, deadline FROM im_sop_waits ORDER BY since`)
	if err != nil {
		return err
	}
	var ws []sopWait
	for rows.Next() {
		var w sopWait
		if err := rows.Scan(&w.runID, &w.step, &w.attempt, &w.convID, &w.channel, &w.convExt,
			&w.convName, &w.input, &w.since, &w.deadline); err != nil {
			_ = rows.Close()
			return err
		}
		ws = append(ws, w)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, w := range ws {
		if err := ctx.Err(); err != nil {
			return err
		}
		reply, err := in.replyAfter(ctx, w)
		if err != nil {
			return err
		}
		cv := plugin.ConversationInfo{ID: w.convID, Name: w.convName}
		switch {
		case reply != nil:
			var input map[string]any
			_ = json.Unmarshal([]byte(w.input), &input)
			out := with(input, "reply", map[string]any{
				"message_id": reply.ID, "conversation_id": w.convID, "conversation": w.convName, "channel": reply.Channel,
				"text": reply.Text, "sender_id": reply.SenderID, "sender_name": reply.SenderName,
				"stakeholder_id": reply.StakeholderID, "contact_name": reply.ContactName, "at": reply.At,
			})
			if err := c.SOP().Resume(ctx, w.runID, w.step, out); err != nil {
				c.Log().Debug("im sop wait resume failed, retry later", "run", w.runID, "step", w.step, "err", err)
				continue
			}
		case in.clock().UTC().Format(timeLayout) >= w.deadline:
			d := timeBetween(w.since, w.deadline)
			reason := fmt.Sprintf("等了 %s，%s里对方还没回复（超时）", humanDur(d), convLabel(cv))
			if err := c.SOP().Fail(ctx, w.runID, w.step, reason); err != nil {
				if errors.Is(err, plugin.ErrNoSOPEngine) {
					continue
				}
				c.Log().Debug("im sop wait timeout fail", "run", w.runID, "step", w.step, "err", err)
			}
		default:
			continue
		}
		if _, err := in.c.Store().Exec(ctx, `DELETE FROM im_sop_waits WHERE run_id = ? AND step = ? AND attempt = ?`,
			w.runID, w.step, w.attempt); err != nil {
			return err
		}
	}
	return nil
}

// replyAfter 是会话里挂起之后对方发的第一条消息，没有回 nil。
func (in *inbox) replyAfter(ctx context.Context, w sopWait) (*Message, error) {
	ms, err := in.query(ctx, `SELECT `+messageCols+` FROM im_messages WHERE `+convCond+` AND sent_at > ?
		ORDER BY sent_at, rowid LIMIT 50`, append(convArgs(w.convID, w.channel, w.convExt), w.since)...)
	if err != nil {
		return nil, err
	}
	for i := range ms {
		mine, err := in.fromMe(ctx, ms[i])
		if err != nil {
			return nil, err
		}
		if !mine {
			return &ms[i], nil
		}
	}
	return nil, nil
}

// fromMe：发送人的编号或名字是「我」的称呼（适配器给的加连接器账号拆出来的，同「与我相关」）。
func (in *inbox) fromMe(ctx context.Context, m Message) (bool, error) {
	var a Adapter
	for _, x := range in.adapters {
		if x.Key() == m.Adapter {
			a = x
		}
	}
	if a == nil {
		a = fixedAdapter{}
	}
	hs, err := newSelfHandles(a).forConnector(ctx, in.c, m.ConnectorID)
	if err != nil {
		return false, err
	}
	for _, h := range hs {
		h = strings.TrimPrefix(strings.TrimSpace(h), "@")
		if h == "" {
			continue
		}
		for _, s := range []string{m.SenderID, m.SenderName} {
			if strings.EqualFold(strings.TrimPrefix(strings.TrimSpace(s), "@"), h) {
				return true, nil
			}
		}
	}
	return false, nil
}

// fixedAdapter 是适配器已不在时的占位：没有自己的称呼，只认连接器账号。
type fixedAdapter struct{}

func (fixedAdapter) Key() string     { return "" }
func (fixedAdapter) Channel() string { return "" }

func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

/* ---------- 模板、时长：口径同 SOP 插件（nodes.go 的 render、parseWait），插件之间不互相 import ---------- */

var (
	tplRe   = regexp.MustCompile(`\{\{\s*([\w.\[\]\p{Han}]+)\s*\}\}`)
	indexRe = regexp.MustCompile(`\[(\d+)\]`)
	durRe   = regexp.MustCompile(`^\s*(\d+(?:\.\d+)?)\s*(秒钟?|分钟|分|小时|时|天|周)\s*$`)
)

// render 把 {{字段}} 换成输入里的值，取不到的留空。
func render(tpl string, input map[string]any) string {
	return tplRe.ReplaceAllStringFunc(tpl, func(m string) string {
		return txt(getPath(input, tplRe.FindStringSubmatch(m)[1]))
	})
}

func getPath(obj any, path string) any {
	p := indexRe.ReplaceAllString(strings.TrimSpace(path), ".$1")
	cur := obj
	for _, k := range strings.Split(p, ".") {
		if k == "" {
			continue
		}
		switch v := cur.(type) {
		case map[string]any:
			cur = v[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(v) {
				return nil
			}
			cur = v[i]
		default:
			return nil
		}
	}
	return cur
}

// txt 对象转 JSON，nil 是空串。
func txt(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case map[string]any, []any:
		b, _ := json.Marshal(x)
		return string(b)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// parseTimeout 解析「最多等多久」：「30 分钟」「1 小时」「2 天」，也认 Go 的写法（90s、1h30m）。留空是 1 小时，最多 30 天。
func parseTimeout(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return defaultWaitTimeout, nil
	}
	var d time.Duration
	if m := durRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		unit := map[string]time.Duration{"秒": time.Second, "秒钟": time.Second, "分": time.Minute, "分钟": time.Minute,
			"时": time.Hour, "小时": time.Hour, "天": 24 * time.Hour, "周": 7 * 24 * time.Hour}[m[2]]
		d = time.Duration(n * float64(unit))
	} else {
		var err error
		if d, err = time.ParseDuration(s); err != nil {
			return 0, fmt.Errorf("「最多等多久」写法不对：%s，要写成「30 分钟」「1 小时」「2 天」", s)
		}
	}
	if d <= 0 {
		return 0, errors.New("「最多等多久」要大于 0")
	}
	if d > maxWaitTimeout {
		return 0, errors.New("「最多等多久」不能超过 30 天")
	}
	return d, nil
}

func timeBetween(a, b string) time.Duration {
	ta, err1 := time.Parse(timeLayout, a)
	tb, err2 := time.Parse(timeLayout, b)
	if err1 != nil || err2 != nil {
		return 0
	}
	return tb.Sub(ta)
}

// humanDur 给人看的时长：整天、整小时、整分钟，其余按秒。
func humanDur(d time.Duration) string {
	switch {
	case d >= 24*time.Hour && d%(24*time.Hour) == 0:
		return fmt.Sprintf("%d 天", d/(24*time.Hour))
	case d >= time.Hour && d%time.Hour == 0:
		return fmt.Sprintf("%d 小时", d/time.Hour)
	case d >= time.Minute && d%time.Minute == 0:
		return fmt.Sprintf("%d 分钟", d/time.Minute)
	}
	return strconv.FormatFloat(d.Seconds(), 'f', -1, 64) + " 秒"
}
