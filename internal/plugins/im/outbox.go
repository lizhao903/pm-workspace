// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 主动发消息（0.17.0，迁移 0011_outbox.sql）：发到一个会话里，不针对哪条消息、不串在哪条下面；
// 发出的（含失败的）记在 im_outbox。入口：消息页标题行「发消息」、群组管理每行「发消息」、SOP 节点「发消息」（source=sop）。
//
// POST /api/im/send，body {text, conversation_id?, connector_id?, conversation_external_id?, conversation_name?, mentions?}
// （mentions 0.18.0，同回复，见 mention.go）：
//   - 给 conversation_id：已登记的会话。connector_id 可省，省了用会话里最近收到的一条消息所在的连接器；会话还没收过消息时必须给。
//   - 不给 conversation_id 时给 connector_id + conversation_external_id：账号所在、还没收过消息的群组频道（GET /api/im/connectors/{id}/conversations 列出的），
//     先按收消息时的规则登记会话（group，名字取 conversation_name，没有用编号），再发。不支持给没联系过的人新开私聊。
//
// 身份按连接器配置（Slack 的 Bot 或我本人）；私聊发给对方。会话、连接器不存在 404；连接器和会话不是同一渠道、缺字段 400；
// 不知道用哪个连接器、连接器暂停/断开/只收 409（reason 同回复，另有 no_messages）；渠道发送失败 502 send_failed（记录照样留着，能重发）。
// GET /api/im/conversations/{conversation_id}/sent?limit= 新的在前，默认 50 条、最多 200 条。
//
// 对上对方的回复（读时算，fillSentLinks）：串里回复的父消息就是我发出的那条（external_id 相同）时挂上；
// 不是串里回复的，发件之后同会话第一条来信算「回复了我发出的」。消息上多 replied_sent。
// 以本人身份发出的，拉取时又会看到（from_self）：按发件记录的 external_id 去重，不再记成回复（ingest.go recordSelf）。

const (
	outboxDefaultLimit = 50
	outboxMaxLimit     = 200
)

// OutboxItem 是发出的一条。Status 为 sent / failed，失败时 Error 是原因；Source 为 manual / sop，sop 的 RunID 是执行 id。
type OutboxItem struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Channel        string `json:"channel"`
	ConnectorID    string `json:"connector_id"`
	Text           string `json:"text"`
	Status         string `json:"status"`
	Error          string `json:"error"`
	ExternalID     string `json:"external_id"`
	Source         string `json:"source"`
	RunID          string `json:"run_id"`
	CreatedAt      string `json:"created_at"`
}

// SentRef 是一条来信回复的「我发出的」那条：Via 为 thread（在那条的串里回复）或 next（发件后同会话第一条来信）。
type SentRef struct {
	OutboxID string `json:"outbox_id"`
	Text     string `json:"text"`
	At       string `json:"at"`
	Via      string `json:"via"`
}

// sendVia 定一个会话用哪个连接器、适配器发，私聊发给谁：借一条「代表」消息，交给 replyBlocker 和 outgoingTo。
// connectorID 为空时用会话里最近收到的一条；给了时要是同一渠道的连接器。
func (in *inbox) sendVia(ctx context.Context, cv plugin.ConversationInfo, connectorID string) (Message, error) {
	last, err := in.query(ctx, `SELECT `+messageCols+` FROM im_messages WHERE `+convCond+` ORDER BY sent_at DESC, rowid DESC LIMIT 1`,
		convArgs(cv.ID, cv.Channel, cv.ExternalID)...)
	if err != nil {
		return Message{}, err
	}
	if connectorID == "" {
		if len(last) == 0 {
			return Message{}, blocked("no_messages", convLabel(cv)+"里还没收到过消息，不知道用哪个连接器发")
		}
		return last[0], nil
	}
	cn, err := in.c.Connectors().Get(ctx, connectorID)
	if errors.Is(err, plugin.ErrNoRows) {
		return Message{}, apiErr(errNotFound, "connector %s not found", connectorID)
	}
	if err != nil {
		return Message{}, err
	}
	if cn.Tool != cv.Channel {
		return Message{}, apiErr(errValidation, "connector %s is %s, conversation is %s", connectorID, cn.Tool, cv.Channel)
	}
	via := Message{Channel: cv.Channel, ConnectorID: connectorID}
	for _, m := range last {
		if m.ConnectorID == connectorID {
			via.Adapter = m.Adapter
		}
		via.SenderID = m.SenderID
	}
	if cv.Kind == "direct" && via.SenderID == "" {
		return Message{}, blocked("no_messages", "和这个人还没有私聊消息，不能新开私聊")
	}
	return via, nil
}

// outgoingTo 是发到会话里的一条（不串）：私聊发给对方。
func outgoingTo(cv plugin.ConversationInfo, via Message, text string, mentions []Mention) Outgoing {
	out := Outgoing{ConnectorID: via.ConnectorID, ConversationID: cv.ExternalID, ConversationKind: cv.Kind, Text: text, Mentions: mentions}
	if cv.Kind == "direct" {
		out.RecipientID = via.SenderID
	}
	return out
}

// sendResult 是 deliver 的结果：Blocked 是发之前就拦下的（连接器暂停等，没发、不记录），SendErr 是渠道发送失败（记了一条 failed）。
type sendResult struct {
	Item    OutboxItem
	Adapter string
	Blocked error
	SendErr error
}

// deliver 是主动发消息的共用部分（界面发、SOP 节点发都走它）：选适配器、发、记发件记录、记审计（action=send、target=conversation）。
// meta 是审计的操作者和幂等键（SOP 带执行 id），detail 补进审计。
// mentions 是正文里要真正 @ 到的人（0.18.0，mention.go），由适配器按渠道换写法；发件记录里的正文仍是「@名字」原文。
func (in *inbox) deliver(ctx context.Context, cv plugin.ConversationInfo, via Message, text string, mentions []Mention, source, runID string, meta plugin.WriteMeta) sendResult {
	rp, err := in.replyBlocker(ctx, via)
	if err != nil {
		return sendResult{Blocked: err}
	}
	sendCtx, cancel := context.WithTimeout(ctx, replyTimeout)
	ext, sendErr := rp.Reply(sendCtx, outgoingTo(cv, via, text, mentions))
	cancel()
	it := in.recordOutbox(ctx, cv, via.ConnectorID, rp.Key(), text, ext, sendErr, source, runID)
	detail := map[string]any{"channel": cv.Channel, "connector_id": via.ConnectorID, "adapter": rp.Key(),
		"conversation": cv.Name, "text": clip(text, auditTextMax), "source": source, "outbox_id": it.ID}
	if sendErr != nil {
		detail["status"], detail["error"] = "failed", it.Error
		in.c.Audit().Note(ctx, plugin.AuditNote{Action: "send", TargetType: "conversation", TargetID: cv.ID,
			Summary: "发消息到" + convLabel(cv) + "失败", Detail: detail}, meta)
		in.c.Log().Warn("im send failed", "conversation", cv.ID, "adapter", rp.Key(), "source", source, "err", sendErr)
		return sendResult{Item: it, Adapter: rp.Key(), SendErr: errors.New(it.Error)}
	}
	detail["status"], detail["external_id"] = "sent", ext
	in.c.Audit().Note(ctx, plugin.AuditNote{Action: "send", TargetType: "conversation", TargetID: cv.ID,
		Summary: "发消息到" + convLabel(cv), Detail: detail}, meta)
	return sendResult{Item: it, Adapter: rp.Key()}
}

// recordOutbox 记一行发件记录；sendErr 不为空时记成失败。写不进去只记日志，不挡发送结果。
// 发成功的：发出后、记录前拉取可能已把它当「本人发的」记成了回复，按编号清掉那一条（同 reply）。
func (in *inbox) recordOutbox(ctx context.Context, cv plugin.ConversationInfo, connectorID, adapter, text, ext string, sendErr error, source, runID string) OutboxItem {
	it := OutboxItem{ID: idgen.Prefixed("ob"), ConversationID: cv.ID, Channel: cv.Channel, ConnectorID: connectorID, Text: text,
		Status: "sent", ExternalID: ext, Source: source, RunID: runID, CreatedAt: in.clock().UTC().Format(timeLayout)}
	if sendErr != nil {
		it.Status, it.Error, it.ExternalID = "failed", clip(sendErr.Error(), maxReplyError), ""
	}
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_outbox (id, conversation_id, channel, connector_id, adapter, text, status, error, external_id, source, run_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, it.ID, it.ConversationID, it.Channel, it.ConnectorID, adapter, it.Text, it.Status, it.Error,
		it.ExternalID, it.Source, it.RunID, it.CreatedAt); err != nil {
		in.c.Log().Error("im outbox record failed", "conversation", cv.ID, "err", err)
	}
	if it.ExternalID != "" {
		if _, err := in.c.Store().Exec(ctx, `DELETE FROM im_replies WHERE external_id = ? AND message_id IN
			(SELECT id FROM im_messages WHERE channel = ? AND connector_id = ?)`, it.ExternalID, cv.Channel, connectorID); err != nil {
			in.c.Log().Warn("im outbox dedupe replies failed", "conversation", cv.ID, "err", err)
		}
	}
	return it
}

// sentOutside 是这个编号是不是工作台主动发出去的（拉取时看到本人发的，用它去重）。
func (in *inbox) sentOutside(ctx context.Context, ch, connectorID, ext string) (bool, error) {
	var n int
	err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_outbox WHERE external_id = ? AND channel = ? AND connector_id = ?`,
		ext, ch, connectorID).Scan(&n)
	return n > 0, err
}

type sendBody struct {
	Text                   string `json:"text"`
	ConversationID         string `json:"conversation_id"`
	ConnectorID            string `json:"connector_id"`
	ConversationExternalID string `json:"conversation_external_id"`
	ConversationName       string `json:"conversation_name"`
	// Mentions 是正文里要真正 @ 到的人（0.18.0），同回复
	Mentions []mentionInput `json:"mentions"`
}

func (in *inbox) send(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body sendBody
	if err := decode(r, &body, 64<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		fail(w, r, in.c, apiErr(errValidation, "text is required"))
		return
	}
	if utf8.RuneCountInString(text) > maxReply {
		fail(w, r, in.c, apiErr(errValidation, "text must be at most %d characters", maxReply))
		return
	}
	cv, err := in.sendTarget(ctx, body)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	mentions, err := in.resolveMentions(ctx, cv.Channel, body.Mentions)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	via, err := in.sendVia(ctx, cv, strings.TrimSpace(body.ConnectorID))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	res := in.deliver(ctx, cv, via, text, mentions, "manual", "", plugin.WriteMeta{})
	switch {
	case res.Blocked != nil:
		fail(w, r, in.c, res.Blocked)
	case res.SendErr != nil:
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "send_failed", msg: "发送失败：" + res.Item.Error,
			extra: map[string]string{"outbox_id": res.Item.ID, "conversation_id": cv.ID}})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"data": res.Item})
	}
}

// sendTarget 是要发到的会话：给了 conversation_id 用它；否则按连接器和频道编号找，找不到按收消息的规则登记一个群组会话。
func (in *inbox) sendTarget(ctx context.Context, b sendBody) (plugin.ConversationInfo, error) {
	if id := strings.TrimSpace(b.ConversationID); id != "" {
		return in.conversation(ctx, id)
	}
	cid, ext := strings.TrimSpace(b.ConnectorID), strings.TrimSpace(b.ConversationExternalID)
	if cid == "" || ext == "" {
		return plugin.ConversationInfo{}, apiErr(errValidation, "conversation_id, or connector_id and conversation_external_id, is required")
	}
	cn, err := in.c.Connectors().Get(ctx, cid)
	if errors.Is(err, plugin.ErrNoRows) {
		return plugin.ConversationInfo{}, apiErr(errNotFound, "connector %s not found", cid)
	}
	if err != nil {
		return plugin.ConversationInfo{}, err
	}
	if cv, err := in.c.Conversations().Find(ctx, cn.Tool, ext); err == nil {
		return cv, nil
	} else if !errors.Is(err, plugin.ErrNoRows) {
		return plugin.ConversationInfo{}, err
	}
	name := strings.TrimSpace(b.ConversationName)
	if name == "" {
		name = ext
	}
	if cn.Tool == "slack" && !strings.HasPrefix(name, "#") && !strings.HasPrefix(name, "mpdm-") {
		name = "#" + name // 同收消息时 Slack 频道名的写法
	}
	cv, _, err := in.c.ConversationWriter().Ensure(ctx, plugin.NewConversation{Channel: cn.Tool, ExternalID: ext, Kind: "group", Name: clip(name, 100)})
	if err != nil {
		return plugin.ConversationInfo{}, apiErr(errValidation, "register conversation: %v", err)
	}
	return cv, nil
}

// conversation 读一个会话，不存在回 404。
func (in *inbox) conversation(ctx context.Context, id string) (plugin.ConversationInfo, error) {
	cv, err := in.c.Conversations().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) {
		return cv, apiErr(errNotFound, "conversation %s not found", id)
	}
	return cv, err
}

func (in *inbox) listSent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cv, err := in.conversation(ctx, r.PathValue("conversation_id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	limit := outboxDefaultLimit
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 {
			fail(w, r, in.c, apiErr(errValidation, "limit must be a positive integer"))
			return
		}
		limit = min(n, outboxMaxLimit)
	}
	var total int
	if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_outbox WHERE conversation_id = ?`, cv.ID).Scan(&total); err != nil {
		fail(w, r, in.c, err)
		return
	}
	out, err := in.outboxRows(ctx, `WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, cv.ID, limit)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit}})
}

func (in *inbox) outboxRows(ctx context.Context, tail string, args ...any) ([]OutboxItem, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT id, conversation_id, channel, connector_id, text, status, error, external_id, source, run_id, created_at
		FROM im_outbox `+tail, args...)
	if err != nil {
		return nil, err
	}
	out := []OutboxItem{}
	for rows.Next() {
		var it OutboxItem
		if err := rows.Scan(&it.ID, &it.ConversationID, &it.Channel, &it.ConnectorID, &it.Text, &it.Status, &it.Error, &it.ExternalID,
			&it.Source, &it.RunID, &it.CreatedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, it)
	}
	err = rows.Err()
	_ = rows.Close()
	return out, err
}

// sentStats 是各会话发成功的条数和最近一次发出的时间（会话统计用）。
func (in *inbox) sentStats(ctx context.Context) (map[string]int, map[string]string, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT conversation_id, count(*), max(created_at) FROM im_outbox WHERE status = 'sent' GROUP BY conversation_id`)
	if err != nil {
		return nil, nil, fmt.Errorf("outbox stats: %w", err)
	}
	n, last := map[string]int{}, map[string]string{}
	for rows.Next() {
		var cid, at string
		var c int
		if err := rows.Scan(&cid, &c, &at); err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		n[cid], last[cid] = c, at
	}
	err = rows.Err()
	_ = rows.Close()
	return n, last, err
}

// fillSentLinks 补 replied_sent：这条来信回复的是哪条「我发出的」。
// 串里的回复按父消息编号对；不是串里回复的，取同会话里不晚于它的最近一条发件，它是那之后同会话第一条（非串里）来信才算。
func (in *inbox) fillSentLinks(ctx context.Context, ms []Message) error {
	convs := map[string]bool{}
	for _, m := range ms {
		if m.ConversationID != nil {
			convs[*m.ConversationID] = true
		}
	}
	if len(convs) == 0 {
		return nil
	}
	ph, args := make([]string, 0, len(convs)), make([]any, 0, len(convs))
	for c := range convs {
		ph, args = append(ph, "?"), append(args, c)
	}
	sent, err := in.outboxRows(ctx, `WHERE status = 'sent' AND conversation_id IN (`+strings.Join(ph, ",")+`) ORDER BY created_at, rowid`, args...)
	if err != nil || len(sent) == 0 {
		return err
	}
	byExt, byConv := map[string]OutboxItem{}, map[string][]OutboxItem{}
	for _, it := range sent {
		if it.ExternalID != "" {
			byExt[it.Channel+"\x00"+it.ExternalID] = it
		}
		byConv[it.ConversationID] = append(byConv[it.ConversationID], it)
	}
	firstAfter := map[string]string{} // 发件 id -> 之后第一条来信的 id（空串是还没有）
	for i := range ms {
		m := &ms[i]
		if m.Thread != nil {
			if it, ok := byExt[m.Channel+"\x00"+m.Thread.ParentExternalID]; ok {
				m.RepliedSent = &SentRef{OutboxID: it.ID, Text: it.Text, At: it.CreatedAt, Via: "thread"}
			}
			continue
		}
		if m.ConversationID == nil {
			continue
		}
		var cand *OutboxItem
		for j, it := range byConv[*m.ConversationID] {
			if it.CreatedAt <= m.At {
				cand = &byConv[*m.ConversationID][j]
			}
		}
		if cand == nil {
			continue
		}
		first, ok := firstAfter[cand.ID]
		if !ok {
			err := in.c.Store().QueryRow(ctx, `SELECT id FROM im_messages WHERE conversation_id = ? AND sent_at >= ? AND thread_parent_external_id = ''
				ORDER BY sent_at, rowid LIMIT 1`, cand.ConversationID, cand.CreatedAt).Scan(&first)
			if err != nil && !errors.Is(err, plugin.ErrNoRows) {
				return err
			}
			firstAfter[cand.ID] = first
		}
		if first == m.ID {
			m.RepliedSent = &SentRef{OutboxID: cand.ID, Text: cand.Text, At: cand.CreatedAt, Via: "next"}
		}
	}
	return nil
}
