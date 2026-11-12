// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 私信我（TSK-0411，迁移 0013_ask_me.sql）：SOP 里需要「我」拍板时，私信我本人问一句，等我回复。
//
// 两个 SOP 节点：
//   - 私信我确认 im_ask_me：私信我 config.text（后面固定附上回复方式），挂起等我在私信里回复；认出「执行 / 分配 某人 / 不做」
//     三类就往下走，认不出再问一次，第二次还认不出、或者超时提醒一次后仍没回复，以 choice=none 往下走（流程据此不执行）。
//     输出加 answer：choice（execute / assign / cancel / none）、assignee（分配给谁，原文）、text（我的回复）、
//     reason（none 时 unknown 或 timeout）、reason_text（给人看的一句）、asked（问了几次）；输入里有 task.id 时补上 task.url（看板链接）。
//   - 私信我 im_tell_me：私信我 config.text，不等回复。输出加 told：{text, external_id, at}。
//
// 「我」是谁：config.to 填了渠道编号（Slack Member ID）就用它；没填按连接器认：Slack「我本人」身份取连接器账号里的 Member ID
// （连通测试时 auth.test 回的），Bot 身份取连接器配置里的「我的 Member ID」；都没有时失败并说明去哪里填。
// 用哪个连接器：config.connector 填了用它；没填用这个渠道最新建的、能发（不是只收、没暂停断开）的那个；
// 这个渠道一个连接器都没有时，用不靠连接器的适配器（演练用的假适配器，「我」是它给的第一个称呼）。
// 发不出去时这一步失败（「私信发不出去：…」），SOP 照常记一条运行异常，不静默。
//
// 我的回复怎么认：在同一个渠道、同一个连接器上，我自己发的（Slack 本人身份拉回来的 FromSelf），或者发送人编号是我的，
// 发在这条私信会话里（会话编号不知道时：任意私聊），时间晚于这次提问 —— 到达时（ingest）直接记到等待行上，
// 不当新消息落库，所以不进待处理，也不触发 IM 消息流程。同时有几条在等时：回在某条提问的串里的归那条，否则归最近问的那条。

const (
	NodeAskMe  = "im_ask_me"
	NodeTellMe = "im_tell_me"

	defaultAskTimeout = 24 * time.Hour

	askChoiceExecute = "execute"
	askChoiceAssign  = "assign"
	askChoiceCancel  = "cancel"
	askChoiceNone    = "none"

	askHint = "回复「执行」开工，「分配 某人」交给别人，「不做」取消。"

	// askClockSkew 是认回复时对时间的宽容：回复的时间是渠道给的（Slack 的 ts），提问时间是本机钟，两边差一点时
	// 秒回的那条可能比本机记的提问时间还早；早出这么多以内的也算（私信里在等的只有这几条提问，不会认错别的）。
	askClockSkew = time.Minute
)

// askEvery 是多久看一次挂起中的私信确认；测试里调小。
var askEvery = 3 * time.Second

func (in *inbox) registerAskMe(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeAskMe, Group: "沟通", Required: []plugin.SOPNodeField{{Key: "text", Label: "内容"}}, Run: in.askMeNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeTellMe, Group: "沟通", Required: []plugin.SOPNodeField{{Key: "text", Label: "内容"}}, Run: in.tellMeNode})
	r.Job(plugin.Job{Name: "ask_waits", Every: askEvery, Run: in.askJob})
}

/* ---------- 回复解析 ---------- */

var (
	askAssignRe  = regexp.MustCompile(`(?i)^(?:分配给?|分给|交给|指派给?|派给|转给|assign(?:\s+to)?)\s*[:：]?\s*(.*)$`)
	askExecWords = map[string]bool{"执行": true, "确认": true, "好": true, "好的": true, "开工": true, "做": true, "做吧": true, "干": true,
		"可以": true, "行": true, "去做": true, "执行吧": true, "ok": true, "yes": true, "y": true, "go": true, "run": true}
	askCancelWords = map[string]bool{"不做": true, "取消": true, "不用": true, "算了": true, "不要": true, "不执行": true, "不用做": true,
		"no": true, "n": true, "cancel": true}
)

// parseAnswer 认我的回复：执行类、分配 某人、不做类；别的都是认不出（不猜）。
func parseAnswer(text string) (choice, assignee string) {
	s := strings.ToLower(strings.TrimSpace(text))
	s = strings.Trim(s, " \t\n。.！!，,~～")
	if s == "" {
		return "", ""
	}
	if askCancelWords[s] {
		return askChoiceCancel, ""
	}
	if askExecWords[s] {
		return askChoiceExecute, ""
	}
	if m := askAssignRe.FindStringSubmatch(strings.Trim(strings.TrimSpace(text), " \t\n。.！!，,~～")); m != nil {
		// 名字按原文取（大小写不动），去掉 @ 和引号
		return askChoiceAssign, strings.Trim(strings.TrimSpace(m[1]), " @「」\"'`")
	}
	return "", ""
}

/* ---------- 认出「我」 ---------- */

// askTarget 是私信我要用的：渠道、连接器、适配器、我的编号，已知的私信会话编号。
type askTarget struct {
	channel, connectorID, adapter, me string
}

var memberIDRe = regexp.MustCompile(`[（(]\s*([A-Z0-9]{6,})\s*[)）]\s*$`)

func (in *inbox) askTargetOf(ctx context.Context, n plugin.SOPNodeInput) (askTarget, error) {
	ch := strings.TrimSpace(render(n.Config["channel"], n.Input))
	if ch == "" {
		ch = connector.SlackTool
	}
	ch, err := imident.NormalizeChannel(ch)
	if err != nil {
		return askTarget{}, fmt.Errorf("渠道「%s」不认", n.Config["channel"])
	}
	t := askTarget{channel: ch, me: strings.TrimSpace(render(n.Config["to"], n.Input))}
	cid := strings.TrimSpace(render(n.Config["connector"], n.Input))
	var cn plugin.ConnectorInfo
	if cid != "" {
		if cn, err = in.c.Connectors().Get(ctx, cid); errors.Is(err, plugin.ErrNoRows) {
			return t, fmt.Errorf("连接器 %s 不存在", cid)
		} else if err != nil {
			return t, err
		}
		if cn.Tool != ch {
			return t, fmt.Errorf("连接器「%s」是 %s 的，不是 %s", cn.Name, cn.Tool, ch)
		}
	} else {
		list, err := in.c.Connectors().List(ctx, ch)
		if err != nil && !errors.Is(err, plugin.ErrNoConnectors) {
			return t, err
		}
		for _, x := range list {
			if x.Direction != "receive" && x.Status != "paused" && x.Status != "disconnected" {
				cn = x
				break
			}
		}
		if cn.ID == "" && len(list) > 0 {
			return t, fmt.Errorf("%s 的连接器都不能发消息（只收、暂停或断开），私信不了你", ch)
		}
	}
	if cn.ID == "" {
		// 没有连接器：用不靠连接器的适配器（演练用的假适配器）
		for _, a := range in.adapters {
			h, ok := a.(Handles)
			if _, rp := a.(Replier); !ok || !rp || a.Channel() != ch || len(h.Handles()) == 0 {
				continue
			}
			t.adapter = a.Key()
			if t.me == "" {
				t.me = h.Handles()[0]
			}
			return t, nil
		}
		return t, fmt.Errorf("还没接入 %s 渠道，私信不了你", ch)
	}
	t.connectorID, t.adapter = cn.ID, cn.Tool
	if t.me != "" {
		return t, nil
	}
	if ch == connector.SlackTool {
		err = in.c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
			if connector.SlackAs(cfg.Get(connector.SlackIdentityField)) == connector.SlackAsUser {
				if m := memberIDRe.FindStringSubmatch(cn.Account); m != nil {
					t.me = m[1]
				}
			}
			if t.me == "" {
				t.me = strings.TrimSpace(cfg.Get("self_user_id"))
			}
			return nil
		})
		if err != nil && !errors.Is(err, plugin.ErrNoConnectors) {
			return t, fmt.Errorf("读连接器「%s」的配置失败：%w", cn.Name, err)
		}
		if t.me == "" {
			return t, fmt.Errorf("认不出你在 Slack 上的本人身份：连接器「%s」是 Bot 身份时要在「我的 Member ID」里填你的 Member ID（U 开头），或在这一步的「发给」里填", cn.Name)
		}
		return t, nil
	}
	return t, fmt.Errorf("认不出你在 %s 上的本人身份：在这一步的「发给」里填你在 %s 的编号", ch, ch)
}

/* ---------- 发私信 ---------- */

// sendToMe 私信我一条：发、登记私信会话、记发件记录和审计（同主动发消息）。convExt 是已知的私信会话编号（再问、提醒时），
// threadOf 是要串在哪条下面（渠道编号，空串不串）。回发出的那条的渠道编号和私信会话编号。
func (in *inbox) sendToMe(ctx context.Context, t askTarget, convExt, text, threadOf, runID string, meta plugin.WriteMeta) (ext, conv string, err error) {
	return in.sendDirect(ctx, t, convExt, text, threadOf, runID, meta, "私信我")
}

// sendDirect 私信 t.me 一条，label 是登记的私信会话名和审计摘要（「私信我」「私信 X」，TSK-0468 私信联系人也走它）。
func (in *inbox) sendDirect(ctx context.Context, t askTarget, convExt, text, threadOf, runID string, meta plugin.WriteMeta, label string) (ext, conv string, err error) {
	if utf8.RuneCountInString(text) > maxReply {
		return "", "", fmt.Errorf("要发的内容超过 %d 字", maxReply)
	}
	via := Message{Channel: t.channel, ConnectorID: t.connectorID, Adapter: t.adapter, SenderID: t.me, ConversationKind: "direct"}
	rp, err := in.replyBlocker(ctx, via)
	if err != nil {
		return "", "", fmt.Errorf("私信发不出去：%w", err)
	}
	out := Outgoing{ConnectorID: t.connectorID, ConversationID: convExt, ConversationKind: "direct", RecipientID: t.me, Text: text, ThreadOf: threadOf}
	sendCtx, cancel := context.WithTimeout(ctx, replyTimeout)
	ext, sendErr := rp.Reply(sendCtx, out)
	cancel()
	conv = convExt
	if c, _, ok := strings.Cut(ext, ":"); ok && strings.TrimSpace(c) != "" {
		conv = c
	}
	if conv == "" {
		conv = t.me // 渠道没回会话编号（假适配器）：按「和我的私信」登记
	}
	cv, _, cerr := in.c.ConversationWriter().Ensure(ctx, plugin.NewConversation{Channel: t.channel, ExternalID: conv, Kind: "direct", Name: label})
	if cerr != nil {
		in.c.Log().Warn("im ask me conversation not registered", "channel", t.channel, "err", cerr)
	} else {
		in.recordOutbox(ctx, cv, t.connectorID, rp.Key(), text, ext, sendErr, "sop", runID)
	}
	detail := map[string]any{"channel": t.channel, "connector_id": t.connectorID, "adapter": rp.Key(), "conversation": label,
		"conversation_external_id": conv, "to": t.me, "text": clip(text, auditTextMax), "source": "sop"}
	if sendErr != nil {
		detail["status"], detail["error"] = "failed", clip(sendErr.Error(), maxReplyError)
		in.c.Audit().Note(ctx, plugin.AuditNote{Action: "send", TargetType: "conversation", TargetID: cv.ID, Summary: label + "失败", Detail: detail}, meta)
		return "", conv, fmt.Errorf("私信发不出去：%s", clip(sendErr.Error(), maxReplyError))
	}
	detail["status"], detail["external_id"] = "sent", ext
	in.c.Audit().Note(ctx, plugin.AuditNote{Action: "send", TargetType: "conversation", TargetID: cv.ID, Summary: label, Detail: detail}, meta)
	return ext, conv, nil
}

// sentToMeBefore 是这次尝试已经私信过（服务重启后重跑同一次尝试）：回上次的编号；上次发失败回错误。
func (in *inbox) sentToMeBefore(ctx context.Context, meta plugin.WriteMeta) (ext, conv string, found bool, err error) {
	a, ok, ferr := in.c.Audit().Find(ctx, "send", "conversation", meta)
	if ferr != nil || !ok {
		return "", "", false, nil
	}
	str := func(k string) string { s, _ := a.Detail[k].(string); return s }
	if str("status") != "sent" {
		return "", "", true, errors.New("私信发不出去：" + str("error"))
	}
	return str("external_id"), str("conversation_external_id"), true, nil
}

func askMeta(n plugin.SOPNodeInput, suffix string) plugin.WriteMeta {
	m := writeMeta(n)
	m.Key += suffix
	return m
}

// withTaskURL 输入里有 task.id 时补上 task.url（看板链接），下游回话时用。
func (in *inbox) withTaskURL(input map[string]any) map[string]any {
	t, ok := input["task"].(map[string]any)
	if !ok {
		return input
	}
	id := strings.TrimSpace(txt(t["id"]))
	if id == "" || strings.TrimSpace(txt(t["url"])) != "" {
		return input
	}
	nt := make(map[string]any, len(t)+1)
	for k, v := range t {
		nt[k] = v
	}
	nt["url"] = in.boardURL(id)
	return with(input, "task", nt)
}

func (in *inbox) tellMeNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	input := in.withTaskURL(n.Input)
	// 回报只发状态和结论，去掉执行过程的工具行（TSK-0470）
	text := cleanReply(render(n.Config["text"], input))
	if text == "" {
		return nil, errors.New("要发的内容是空的")
	}
	meta := writeMeta(n)
	if ext, _, found, err := in.sentToMeBefore(ctx, meta); found {
		if err != nil {
			return nil, err
		}
		return with(input, "told", map[string]any{"text": text, "external_id": ext, "reused": true}), nil
	}
	t, err := in.askTargetOf(ctx, n)
	if err != nil {
		return nil, fmt.Errorf("私信发不出去：%w", err)
	}
	ext, _, err := in.sendToMe(ctx, t, "", text, "", n.RunID, meta)
	if err != nil {
		return nil, err
	}
	return with(input, "told", map[string]any{"text": text, "external_id": ext, "at": in.clock().UTC().Format(timeLayout)}), nil
}

/* ---------- 私信我确认 ---------- */

func askQuestion(text string) string { return strings.TrimSpace(text) + "\n\n" + askHint }

func (in *inbox) askMeNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	input := in.withTaskURL(n.Input)
	text := strings.TrimSpace(render(n.Config["text"], input))
	if text == "" {
		return nil, errors.New("要问的内容是空的")
	}
	d := defaultAskTimeout
	if strings.TrimSpace(n.Config["timeout"]) != "" {
		var err error
		if d, err = parseTimeout(n.Config["timeout"]); err != nil {
			return nil, err
		}
	}
	t, err := in.askTargetOf(ctx, n)
	if err != nil {
		return nil, fmt.Errorf("私信发不出去：%w", err)
	}
	q := askQuestion(text)
	meta := writeMeta(n)
	ext, conv, found, err := in.sentToMeBefore(ctx, meta)
	if err != nil {
		return nil, err
	}
	now := in.clock().UTC()
	if !found {
		if ext, conv, err = in.sendToMe(ctx, t, "", q, "", n.RunID, meta); err != nil {
			return nil, err
		}
	}
	b, err := json.Marshal(orEmptyMap(input))
	if err != nil {
		return nil, fmt.Errorf("输入不能转成 JSON：%w", err)
	}
	// 同一次尝试重跑（重启后）不改已有的等待：不重新计时、不丢已记下的回复
	_, err = in.c.Store().Exec(ctx, `INSERT INTO im_ask_waits (run_id, step, attempt, channel, connector_id, adapter, me_id,
		conversation_external_id, ask_external_id, question, input, timeout_ms, since, deadline)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (run_id, step) DO UPDATE SET attempt = excluded.attempt, channel = excluded.channel, connector_id = excluded.connector_id,
		adapter = excluded.adapter, me_id = excluded.me_id, conversation_external_id = excluded.conversation_external_id,
		ask_external_id = excluded.ask_external_id, question = excluded.question, input = excluded.input, timeout_ms = excluded.timeout_ms,
		reasked = 0, reminded = 0, since = excluded.since, deadline = excluded.deadline, reply_text = '', reply_at = '', reply_ref = ''
		WHERE im_ask_waits.attempt <> excluded.attempt`,
		n.RunID, n.Step, n.Attempt, t.channel, t.connectorID, t.adapter, t.me, conv, ext, q, string(b), d.Milliseconds(),
		now.Format(timeLayout), now.Add(d).Format(timeLayout))
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("私信问你了，等你回复（执行 / 分配 某人 / 不做），最多等 %s，没回复提醒一次：%w", humanDur(d), plugin.ErrWaiting)
}

// askWait 是 im_ask_waits 的一行。
type askWait struct {
	runID, step                       string
	attempt                           int
	channel, connectorID, adapter, me string
	convExt, askExt, question, input  string
	timeoutMS                         int64
	reasked, reminded                 int
	since, deadline                   string
	replyText, replyAt, replyRef      string
}

const askCols = `run_id, step, attempt, channel, connector_id, adapter, me_id, conversation_external_id, ask_external_id, question, input,
	timeout_ms, reasked, reminded, since, deadline, reply_text, reply_at, reply_ref`

func (in *inbox) askWaits(ctx context.Context, where string, args ...any) ([]askWait, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT `+askCols+` FROM im_ask_waits `+where, args...)
	if err != nil {
		return nil, err
	}
	var out []askWait
	for rows.Next() {
		var w askWait
		if err := rows.Scan(&w.runID, &w.step, &w.attempt, &w.channel, &w.connectorID, &w.adapter, &w.me, &w.convExt, &w.askExt,
			&w.question, &w.input, &w.timeoutMS, &w.reasked, &w.reminded, &w.since, &w.deadline, &w.replyText, &w.replyAt, &w.replyRef); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, w)
	}
	err = rows.Err()
	_ = rows.Close()
	return out, err
}

// captureAsk 是到达的一条是不是我对某个私信确认的回复：是就记到那一行上、回 true，调用方不再把它当消息落库。
// 我自己发的（fromSelf）或发送人编号是我的、在那条私信会话里（会话编号不知道时：私聊）、晚于提问的才算；工作台自己发出的那条不算。
func (in *inbox) captureAsk(ctx context.Context, ch string, m Incoming, fromSelf bool) (bool, error) {
	conn := strings.TrimSpace(m.ConnectorID)
	ws, err := in.askWaits(ctx, `WHERE channel = ? AND connector_id = ? AND reply_text = '' ORDER BY since DESC`, ch, conn)
	if err != nil || len(ws) == 0 {
		return false, err
	}
	ext := strings.TrimSpace(m.ExternalID)
	if ext != "" {
		if mine, err := in.sentOutside(ctx, ch, conn, ext); err != nil || mine {
			return false, err
		}
	}
	at := m.At
	if at.IsZero() {
		at = in.clock()
	}
	sentAt := at.UTC().Format(timeLayout)
	convExt, _ := imident.NormalizeExternalID(ch, strings.TrimSpace(m.ConversationID))
	sender := strings.TrimPrefix(strings.TrimSpace(m.SenderID), "@")
	var cands []*askWait // 按提问时间倒序
	for i := range ws {
		w := &ws[i]
		switch {
		case !fromSelf && !strings.EqualFold(sender, w.me):
			continue
		case w.convExt != "" && w.convExt != w.me && convExt != w.convExt:
			continue
		case (w.convExt == "" || w.convExt == w.me) && m.ConversationKind != "direct" && convExt != w.convExt:
			continue
		case sentAt <= skewed(w.since):
			continue
		}
		cands = append(cands, w)
	}
	var hit *askWait
	if tp := strings.TrimSpace(m.ThreadParentID); tp != "" {
		// 回在某条提问的串里：归那条
		for _, w := range cands {
			if _, ts, ok := strings.Cut(w.askExt, ":"); ok && (ts == tp || w.askExt == tp) {
				hit = w
				break
			}
		}
	}
	if hit == nil && len(cands) > 0 {
		hit = cands[0] // 最近问的那条
	}
	if hit == nil {
		return false, nil
	}
	ref := ext
	if ref == "" {
		ref = sentAt
	}
	_, err = in.c.Store().Exec(ctx, `UPDATE im_ask_waits SET reply_text = ?, reply_at = ?, reply_ref = ? WHERE run_id = ? AND step = ? AND reply_text = ''`,
		clip(strings.TrimSpace(m.Text), maxText), sentAt, ref, hit.runID, hit.step)
	if err != nil {
		return false, err
	}
	return true, nil
}

// askJob 处理挂起中的私信确认：有回复的解析，到点的提醒或结束。唤醒、失败没成（执行还没调度上）的下次再试。
func (in *inbox) askJob(ctx context.Context, c plugin.Core) error {
	ws, err := in.askWaits(ctx, `ORDER BY since`)
	if err != nil {
		return err
	}
	now := in.clock().UTC()
	for _, w := range ws {
		if err := ctx.Err(); err != nil {
			return err
		}
		var done bool
		switch {
		case strings.TrimSpace(w.replyText) != "":
			done, err = in.askReplied(ctx, c, w, now)
		case now.Format(timeLayout) >= w.deadline:
			done, err = in.askTimedOut(ctx, c, w, now)
		default:
			continue
		}
		if err != nil {
			return err
		}
		if done {
			if _, err := in.c.Store().Exec(ctx, `DELETE FROM im_ask_waits WHERE run_id = ? AND step = ? AND attempt = ?`, w.runID, w.step, w.attempt); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w askWait) meta(kind string, round int) plugin.WriteMeta {
	return plugin.WriteMeta{Session: w.runID, Key: fmt.Sprintf("%s/%s#%d/%s%d", w.runID, w.step, w.attempt, kind, round), Detail: map[string]any{
		"run_id": w.runID, "step": w.step, "attempt": w.attempt,
	}}
}

func (w askWait) target() askTarget {
	return askTarget{channel: w.channel, connectorID: w.connectorID, adapter: w.adapter, me: w.me}
}

// askAnswer 唤醒步骤：输出是输入加 answer。回 false 表示没唤醒成（下次再试）。
func (in *inbox) askAnswer(ctx context.Context, c plugin.Core, w askWait, answer map[string]any) (bool, error) {
	var input map[string]any
	_ = json.Unmarshal([]byte(w.input), &input)
	asked := 1 + w.reasked + w.reminded
	answer["asked"] = asked
	if err := c.SOP().Resume(ctx, w.runID, w.step, with(input, "answer", answer)); err != nil {
		c.Log().Debug("im ask resume failed, retry later", "run", w.runID, "step", w.step, "err", err)
		return false, nil
	}
	return true, nil
}

// askFail 让步骤失败（再问、提醒发不出去）。回 false 表示没成（下次再试）。
func (in *inbox) askFail(ctx context.Context, c plugin.Core, w askWait, reason string) (bool, error) {
	if err := c.SOP().Fail(ctx, w.runID, w.step, reason); err != nil {
		if errors.Is(err, plugin.ErrNoSOPEngine) {
			return false, nil
		}
		c.Log().Debug("im ask fail", "run", w.runID, "step", w.step, "err", err)
	}
	return true, nil
}

func (in *inbox) askReplied(ctx context.Context, c plugin.Core, w askWait, now time.Time) (bool, error) {
	choice, who := parseAnswer(w.replyText)
	if choice != "" {
		return in.askAnswer(ctx, c, w, map[string]any{"choice": choice, "assignee": who, "text": w.replyText, "reason": "", "reason_text": "", "at": w.replyAt})
	}
	if w.reasked > 0 {
		return in.askAnswer(ctx, c, w, map[string]any{"choice": askChoiceNone, "assignee": "", "text": w.replyText, "reason": "unknown",
			"reason_text": "两次都没认出你的回复", "at": w.replyAt})
	}
	// 认不出：再问一次，重新计时
	text := fmt.Sprintf("没认出「%s」。%s\n再认不出就先不执行，任务留在未开工。", clip(w.replyText, 60), askHint)
	ext, conv, err := in.sendToMe(ctx, w.target(), w.convExt, text, w.askExt, w.runID, w.meta("reask", 1))
	if err != nil {
		return in.askFail(ctx, c, w, "再问一次时"+err.Error())
	}
	d := time.Duration(w.timeoutMS) * time.Millisecond
	_, err = in.c.Store().Exec(ctx, `UPDATE im_ask_waits SET reasked = 1, reply_text = '', reply_at = '', reply_ref = '', ask_external_id = ?,
		conversation_external_id = ?, since = ?, deadline = ? WHERE run_id = ? AND step = ? AND attempt = ?`,
		orStr(ext, w.askExt), orStr(conv, w.convExt), now.Format(timeLayout), now.Add(d).Format(timeLayout), w.runID, w.step, w.attempt)
	return false, err
}

func (in *inbox) askTimedOut(ctx context.Context, c plugin.Core, w askWait, now time.Time) (bool, error) {
	d := time.Duration(w.timeoutMS) * time.Millisecond
	if w.reminded > 0 {
		return in.askAnswer(ctx, c, w, map[string]any{"choice": askChoiceNone, "assignee": "", "text": "", "reason": "timeout",
			"reason_text": fmt.Sprintf("提醒之后又等了 %s 没收到回复", humanDur(d))})
	}
	first, _, _ := strings.Cut(w.question, "\n")
	text := fmt.Sprintf("还在等你回复：%s\n%s\n再过 %s 没回复就先不执行，任务留在未开工。", clip(first, 80), askHint, humanDur(d))
	ext, conv, err := in.sendToMe(ctx, w.target(), w.convExt, text, w.askExt, w.runID, w.meta("remind", 1))
	if err != nil {
		return in.askFail(ctx, c, w, "超时提醒时"+err.Error())
	}
	_, err = in.c.Store().Exec(ctx, `UPDATE im_ask_waits SET reminded = 1, ask_external_id = ?, conversation_external_id = ?, deadline = ?
		WHERE run_id = ? AND step = ? AND attempt = ?`, orStr(ext, w.askExt), orStr(conv, w.convExt), now.Add(d).Format(timeLayout), w.runID, w.step, w.attempt)
	return false, err
}

// skewed 是提问时间往前放 askClockSkew；解析不了原样回。
func skewed(since string) string {
	t, err := time.Parse(timeLayout, since)
	if err != nil {
		return since
	}
	return t.Add(-askClockSkew).Format(timeLayout)
}

func orStr(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
