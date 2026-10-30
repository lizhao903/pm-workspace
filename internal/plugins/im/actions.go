package im

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 消息处理动作（IM-02a）：处理完、忽略、重新打开、已读、稍后提醒、回复、转任务，口径照原型 App.tsx 的 actOnMessage。
// 契约见 docs/api-contract.md「IM 消息插件 im」的「处理动作」。

const (
	maxReply      = 4000 // 回复正文上限（字）
	maxSnooze     = 366 * 24 * time.Hour
	replyTimeout  = 15 * time.Second
	taskTitleMax  = 40 // 默认标题取正文前 40 字，同原型
	sourceTextMax = 500
	maxReplyError = 500
)

// snoozeEvery 是多久看一次稍后提醒到点没有；测试里调小。
var snoozeEvery = 15 * time.Second

// Reply 是消息上的一条回复，对照原型 Reply，多了发送状态。
type Reply struct {
	ID         string `json:"id"`
	Text       string `json:"text"`
	Status     string `json:"status"` // sent / failed
	Error      string `json:"error"`
	ExternalID string `json:"external_id"`
	At         string `json:"at"`
}

// actionError 是带附加字段的错误：回复被拦（409 + reason）、发送失败（502 send_failed）、已转过任务（409 + task_id）。
type actionError struct {
	status int
	code   string
	msg    string
	extra  map[string]string
}

func (e *actionError) Error() string { return e.msg }

func (e *actionError) body() map[string]string {
	b := map[string]string{"code": e.code, "message": e.msg}
	for k, v := range e.extra {
		b[k] = v
	}
	return b
}

func blocked(reason, msg string) error {
	return &actionError{status: http.StatusConflict, code: "conflict", msg: msg, extra: map[string]string{"reason": reason}}
}

// get 读一条消息，补好会话、联系人、回复、任务；没有回 not_found。
func (in *inbox) get(ctx context.Context, id string) (Message, error) {
	out, err := in.query(ctx, `SELECT `+messageCols+` FROM im_messages WHERE id = ?`, id)
	if err != nil {
		return Message{}, err
	}
	if len(out) == 0 {
		return Message{}, apiErr(errNotFound, "message %s not found", id)
	}
	return out[0], nil
}

func (in *inbox) getOne(w http.ResponseWriter, r *http.Request) {
	m, err := in.get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": m})
}

// fillActions 给一页消息补上回复，并查转成的任务还在不在（不在的不回写，读的时候置空）。
func (in *inbox) fillActions(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	idx := map[string]int{}
	ph := make([]string, len(ms))
	args := make([]any, len(ms))
	for i := range ms {
		ms[i].Replies = []Reply{}
		idx[ms[i].ID] = i
		ph[i], args[i] = "?", ms[i].ID
	}
	rows, err := in.c.Store().Query(ctx, `SELECT message_id, id, text, status, error, external_id, created_at FROM im_replies
		WHERE message_id IN (`+strings.Join(ph, ",")+`) ORDER BY created_at, rowid`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var mid string
		var rp Reply
		if err := rows.Scan(&mid, &rp.ID, &rp.Text, &rp.Status, &rp.Error, &rp.ExternalID, &rp.At); err != nil {
			_ = rows.Close()
			return err
		}
		if i, ok := idx[mid]; ok {
			ms[i].Replies = append(ms[i].Replies, rp)
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for i := range ms {
		if ms[i].TaskID == nil {
			continue
		}
		o, err := in.c.Objects().Get(ctx, *ms[i].TaskID)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
		case err != nil:
			return err
		case !o.Deleted:
			continue
		}
		ms[i].TaskID, ms[i].TaskRef = nil, ""
	}
	return nil
}

// setState 是处理完、忽略、重新打开、已读四个动作：照原型改状态、清稍后、标已读。
func (in *inbox) setState(kind string) http.HandlerFunc {
	var set string
	switch kind {
	case "done":
		set = `status = 'done', snooze_until = NULL, is_read = 1`
	case "ignore":
		set = `status = 'ignored', snooze_until = NULL, is_read = 1`
	case "reopen":
		set = `status = 'pending', snooze_until = NULL`
	case "read":
		set = `is_read = 1`
	default:
		panic("unknown message action " + kind)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		in.update(w, r, set)
	}
}

// update 改一条消息并回最新的样子。
func (in *inbox) update(w http.ResponseWriter, r *http.Request, set string, args ...any) {
	ctx := r.Context()
	id := r.PathValue("id")
	res, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET `+set+` WHERE id = ?`, append(args, id)...)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, in.c, apiErr(errNotFound, "message %s not found", id))
		return
	}
	m, err := in.get(ctx, id)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": m})
}

// snooze 稍后提醒：状态仍是待处理，到点由 wakeJob 清掉 snooze_until。只有待处理的能设，同原型（只在待处理里给这个按钮）。
func (in *inbox) snooze(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Until string `json:"until"`
	}
	if err := decode(r, &body, 4<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	until, err := time.Parse(time.RFC3339, strings.TrimSpace(body.Until))
	if err != nil {
		fail(w, r, in.c, apiErr(errValidation, "until must be an RFC3339 time"))
		return
	}
	now := in.clock()
	if !until.After(now) {
		fail(w, r, in.c, apiErr(errValidation, "until must be in the future"))
		return
	}
	if until.Sub(now) > maxSnooze {
		fail(w, r, in.c, apiErr(errValidation, "until must be within a year"))
		return
	}
	m, err := in.get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if m.Status != "pending" {
		fail(w, r, in.c, apiErr(errConflict, "only pending messages can be snoozed (status is %s)", m.Status))
		return
	}
	in.update(w, r, `snooze_until = ?, is_read = 1`, until.UTC().Format(timeLayout))
}

// wakeJob 到点把稍后提醒清掉，消息回到待处理。
func (in *inbox) wakeJob(ctx context.Context, _ plugin.Core) error {
	_, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET snooze_until = NULL WHERE snooze_until IS NOT NULL AND snooze_until <= ?`,
		in.clock().UTC().Format(timeLayout))
	return err
}

// adapterFor 找回复用的适配器：先按收消息的适配器 key，0002 之前收的按渠道。
func (in *inbox) adapterFor(m Message) Adapter {
	for _, a := range in.adapters {
		if m.Adapter != "" && a.Key() == m.Adapter {
			return a
		}
	}
	if m.Adapter != "" {
		return nil
	}
	for _, a := range in.adapters {
		if a.Channel() == m.Channel {
			return a
		}
	}
	return nil
}

// replyBlocker 是回不了的原因，口径和原型 messages.tsx 的 replyBlocker 一致，再加上适配器不在、不支持回复两种。
// 连接器「异常」不拦：异常多半是收消息那一侧的（Telegram 别处也在 getUpdates、某个频道读不到），发消息照样能发；
// 真发不出去（凭证失效等）走发送失败，记一行 failed 并把原因写到消息上。
func (in *inbox) replyBlocker(ctx context.Context, m Message) (Replier, error) {
	if m.ConnectorID != "" {
		cn, err := in.c.Connectors().Get(ctx, m.ConnectorID)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
			return nil, blocked("connector_missing", "渠道已删除，这条消息只能查看")
		case err != nil:
			return nil, err
		}
		switch cn.Status {
		case "paused":
			return nil, blocked("connector_paused", fmt.Sprintf("连接器「%s」已暂停", cn.Name))
		case "disconnected":
			return nil, blocked("connector_disconnected", fmt.Sprintf("连接器「%s」已断开，去设置里重新连接", cn.Name))
		case "connecting":
			return nil, blocked("connector_connecting", fmt.Sprintf("连接器「%s」正在连接", cn.Name))
		}
		if cn.Direction == "receive" {
			return nil, blocked("receive_only", fmt.Sprintf("连接器「%s」设置为只收消息", cn.Name))
		}
	}
	a := in.adapterFor(m)
	if a == nil {
		return nil, blocked("no_adapter", fmt.Sprintf("渠道 %s 没有可用的适配器，回不了", m.Channel))
	}
	rp, ok := a.(Replier)
	if !ok {
		return nil, blocked("unsupported", fmt.Sprintf("渠道 %s 不支持回复", m.Channel))
	}
	return rp, nil
}

// reply 经适配器发出去。发送失败也记一行（status=failed）并把原因写到消息上，回 502 send_failed。
// done 为真且发成功时顺带标成处理完，同原型的「并处理」。
func (in *inbox) reply(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Text string `json:"text"`
		Done bool   `json:"done"`
	}
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
	m, err := in.get(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	rp, err := in.replyBlocker(ctx, m)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	out := Outgoing{ConnectorID: m.ConnectorID, ConversationID: m.ConversationExternalID, ConversationKind: m.ConversationKind,
		RecipientID: m.SenderID, ReplyTo: m.ExternalID, Text: text}
	sendCtx, cancel := context.WithTimeout(ctx, replyTimeout)
	ext, sendErr := rp.Reply(sendCtx, out)
	cancel()
	rid := idgen.Prefixed("rp")
	now := in.clock().UTC().Format(timeLayout)
	if sendErr != nil {
		reason := clip(sendErr.Error(), maxReplyError)
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_replies (id, message_id, text, status, error, created_at) VALUES (?, ?, ?, 'failed', ?, ?)`,
			rid, m.ID, text, reason, now); err != nil {
			fail(w, r, in.c, err)
			return
		}
		if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET reply_error = ? WHERE id = ?`, reason, m.ID); err != nil {
			fail(w, r, in.c, err)
			return
		}
		in.c.Log().Warn("im reply failed", "message", m.ID, "adapter", rp.Key(), "err", sendErr)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "send_failed", msg: "发送失败：" + reason,
			extra: map[string]string{"reply_id": rid}})
		return
	}
	if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_replies (id, message_id, text, status, external_id, created_at) VALUES (?, ?, ?, 'sent', ?, ?)`,
		rid, m.ID, text, ext, now); err != nil {
		fail(w, r, in.c, err)
		return
	}
	set := `reply_error = '', is_read = 1`
	if body.Done {
		set += `, status = 'done', snooze_until = NULL`
	}
	in.update(w, r, set)
}

// toTask 转任务：建 type=task、来源 im 的任务，props.source_ref 指向消息；任务 id 记在消息上。
// 已经转过、任务还在的回 409（带 task_id），前端打开那条任务；任务删了（含软删）可以再转。
func (in *inbox) toTask(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Title     string  `json:"title"`
		Body      string  `json:"body"`
		Priority  string  `json:"priority"`
		ProjectID *string `json:"project_id"`
		OwnerID   *string `json:"owner_id"`
		DueAt     *string `json:"due_at"`
		Done      bool    `json:"done"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &body, 64<<10); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	var due *time.Time
	if body.DueAt != nil && strings.TrimSpace(*body.DueAt) != "" {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(*body.DueAt))
		if err != nil {
			fail(w, r, in.c, apiErr(errValidation, "due_at must be an RFC3339 time"))
			return
		}
		due = &t
	}
	// 项目、负责人先查一遍：内核建对象时不存在的项目只报外键错误，看不出是哪个字段
	if pid := nonEmpty(body.ProjectID); pid != nil {
		o, err := in.c.Objects().Get(ctx, *pid)
		switch {
		case errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Deleted || o.Type != "project")):
			fail(w, r, in.c, apiErr(errValidation, "project %s not found", *pid))
			return
		case err != nil:
			fail(w, r, in.c, err)
			return
		}
	}
	if oid := nonEmpty(body.OwnerID); oid != nil {
		if _, err := in.c.Contacts().Get(ctx, *oid); errors.Is(err, plugin.ErrNoRows) {
			fail(w, r, in.c, apiErr(errValidation, "owner %s not found", *oid))
			return
		} else if err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	in.taskMu.Lock()
	defer in.taskMu.Unlock()
	m, err := in.get(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if m.TaskID != nil {
		fail(w, r, in.c, &actionError{status: http.StatusConflict, code: "conflict",
			msg: fmt.Sprintf("这条消息已经转成任务 %s", m.TaskRef), extra: map[string]string{"task_id": *m.TaskID, "task_ref": m.TaskRef}})
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		title = defaultTaskTitle(m)
	}
	sender := m.ContactName
	if sender == "" {
		sender = m.SenderName
	}
	ref := map[string]any{
		"message_id": m.ID, "channel": m.Channel, "connector_id": m.ConnectorID, "external_id": m.ExternalID,
		"conversation_id": m.ConversationID, "conversation": m.Conversation,
		"sender": sender, "sender_id": m.SenderID, "text": clip(m.Text, sourceTextMax), "at": m.At,
	}
	task, err := in.c.ObjectWriter().Create(ctx, plugin.NewObject{
		TypeID: "task", Title: title, Body: body.Body, Priority: body.Priority,
		ProjectID: nonEmpty(body.ProjectID), OwnerID: nonEmpty(body.OwnerID), DueAt: due,
		Props: map[string]any{domain.PropSourceRef: ref},
	})
	switch {
	case errors.Is(err, domain.ErrValidation), errors.Is(err, domain.ErrNotFound):
		fail(w, r, in.c, apiErr(errValidation, "%v", err))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	}
	set := `task_id = ?, task_ref = ?`
	if body.Done && m.Status == "pending" {
		set += `, status = 'done', snooze_until = NULL, is_read = 1`
	}
	if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET `+set+` WHERE id = ?`, task.ID, task.Ref, m.ID); err != nil {
		fail(w, r, in.c, err)
		return
	}
	m, err = in.get(ctx, m.ID)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{
		"message": m,
		"task":    map[string]string{"id": task.ID, "ref": task.Ref, "title": task.Title, "status": task.Status, "source": task.Source},
	}})
}

// defaultTaskTitle 同原型：正文压掉空白取前 40 字；没正文时写发送人。
func defaultTaskTitle(m Message) string {
	t := clip(strings.Join(strings.Fields(m.Text), " "), taskTitleMax)
	if t != "" {
		return t
	}
	who := m.ContactName
	if who == "" {
		who = m.SenderName
	}
	if who == "" {
		who = m.SenderID
	}
	return "来自 " + who + " 的消息"
}

func nonEmpty(s *string) *string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	v := strings.TrimSpace(*s)
	return &v
}

// maxBatch 是批量处理一次最多带几个 id。
const maxBatch = 500

// batch 批量处理完或忽略（PR-03）：按 id 列表，或按会话 + 时间点之前。只改待处理的，别的跳过。
// 按 id 列表时含稍后的（是挑出来的）；按会话时不含还没到点的稍后，同「待处理」视图。
func (in *inbox) batch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Action         string   `json:"action"`
		IDs            []string `json:"ids"`
		ConversationID string   `json:"conversation_id"`
		Before         string   `json:"before"`
	}
	if err := decode(r, &body, 64<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	var set string
	switch body.Action {
	case "done":
		set = `status = 'done', snooze_until = NULL, is_read = 1`
	case "ignore":
		set = `status = 'ignored', snooze_until = NULL, is_read = 1`
	default:
		fail(w, r, in.c, apiErr(errValidation, "action must be done or ignore"))
		return
	}
	cid := strings.TrimSpace(body.ConversationID)
	where := []string{"status = 'pending'"}
	var args []any
	switch {
	case len(body.IDs) > 0 && cid != "":
		fail(w, r, in.c, apiErr(errValidation, "ids and conversation_id cannot be used together"))
		return
	case len(body.IDs) > 0:
		if len(body.IDs) > maxBatch {
			fail(w, r, in.c, apiErr(errValidation, "ids must be at most %d", maxBatch))
			return
		}
		ph := make([]string, len(body.IDs))
		for i, id := range body.IDs {
			ph[i] = "?"
			args = append(args, id)
		}
		where = append(where, "id IN ("+strings.Join(ph, ",")+")")
	case cid != "":
		before, err := time.Parse(time.RFC3339, strings.TrimSpace(body.Before))
		if err != nil {
			fail(w, r, in.c, apiErr(errValidation, "before must be an RFC3339 time"))
			return
		}
		cv, err := in.c.Conversations().Get(ctx, cid)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
			fail(w, r, in.c, apiErr(errValidation, "conversation %s not found", cid))
			return
		case err != nil:
			fail(w, r, in.c, err)
			return
		}
		// 会话口径同列表的 conversation_id 筛选：没认上会话的按渠道编号算进来
		where = append(where, "(conversation_id = ? OR (conversation_id IS NULL AND channel = ? AND conversation_external_id = ?))",
			"sent_at <= ?", "(snooze_until IS NULL OR snooze_until <= ?)")
		args = append(args, cv.ID, cv.Channel, cv.ExternalID, before.UTC().Format(timeLayout), in.clock().UTC().Format(timeLayout))
	default:
		fail(w, r, in.c, apiErr(errValidation, "ids or conversation_id is required"))
		return
	}
	cond := strings.Join(where, " AND ")
	rows, err := in.c.Store().Query(ctx, `SELECT id FROM im_messages WHERE `+cond+` ORDER BY sent_at DESC, rowid DESC`, args...)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			fail(w, r, in.c, err)
			return
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if len(ids) > 0 {
		ph := make([]string, len(ids))
		idArgs := make([]any, len(ids))
		for i, id := range ids {
			ph[i], idArgs[i] = "?", id
		}
		if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET `+set+` WHERE status = 'pending' AND id IN (`+strings.Join(ph, ",")+`)`, idArgs...); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"action": body.Action, "ids": ids, "count": len(ids)}})
}
