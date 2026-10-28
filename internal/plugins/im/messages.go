package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 消息列表和回调（IM-01a）：GET /api/im/messages、GET /api/im/adapters、POST /api/im/callbacks/{adapter}，
// 契约见 docs/api-contract.md「IM 消息插件 im」。

// Statuses 是消息状态，和原型 MsgStatus 一致。
var Statuses = []string{"pending", "done", "ignored"}

const (
	defaultLimit = 50
	maxLimit     = 200
)

// Message 是列表里的一条。字段名对照原型 Message：conversation 是群名（私聊为空），sender_id 是渠道里的编号。
// conversation_id、identity_id 是认上的会话和 IM 身份，认不上为 null；stakeholder_id、contact_name 是身份所属的联系人。
type Message struct {
	ID                     string          `json:"id"`
	Channel                string          `json:"channel"`
	ConnectorID            string          `json:"connector_id"`
	ExternalID             string          `json:"external_id"`
	ConversationID         *string         `json:"conversation_id"`
	ConversationExternalID string          `json:"conversation_external_id"`
	ConversationKind       string          `json:"conversation_kind"`
	Conversation           string          `json:"conversation"`
	SenderID               string          `json:"sender_id"`
	SenderName             string          `json:"sender_name"`
	IdentityID             *string         `json:"identity_id"`
	StakeholderID          *string         `json:"stakeholder_id"`
	ContactName            string          `json:"contact_name"`
	Text                   string          `json:"text"`
	Attachments            json.RawMessage `json:"attachments"`
	Relevance              string          `json:"relevance"`
	Status                 string          `json:"status"`
	Read                   bool            `json:"read"`
	SnoozeUntil            *string         `json:"snooze_until"`
	At                     string          `json:"at"`
	ReceivedAt             string          `json:"received_at"`
	// 以下 IM-02a：adapter 是收这条消息的适配器 key；task_id、task_ref 是转成的任务，任务删了（含软删）为 null 和空串；
	// replies 按时间正序，含发送失败的；reply_error 是最近一次发送失败的原因，发成功后清空
	Adapter    string  `json:"adapter"`
	TaskID     *string `json:"task_id"`
	TaskRef    string  `json:"task_ref"`
	Replies    []Reply `json:"replies"`
	ReplyError string  `json:"reply_error"`
}

const messageCols = `id, channel, connector_id, external_id, conversation_id, conversation_external_id, conversation_kind,
	conversation_name, sender_identity_id, sender_external_id, sender_name, text, attachments, relevance, status,
	is_read, snooze_until, sent_at, received_at, adapter, task_id, task_ref, reply_error`

func (in *inbox) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	var where []string
	var args []any
	if s := q.Get("status"); s != "" {
		if !slices.Contains(Statuses, s) {
			fail(w, r, in.c, apiErr(errValidation, "status must be one of %s", strings.Join(Statuses, ", ")))
			return
		}
		where, args = append(where, "status = ?"), append(args, s)
	}
	if s := strings.ToLower(strings.TrimSpace(q.Get("channel"))); s != "" {
		where, args = append(where, "channel = ?"), append(args, s)
	}
	if cid := strings.TrimSpace(q.Get("conversation_id")); cid != "" {
		cv, err := in.c.Conversations().Get(ctx, cid)
		switch {
		case errors.Is(err, plugin.ErrNoRows):
			fail(w, r, in.c, apiErr(errValidation, "conversation %s not found", cid))
			return
		case err != nil:
			fail(w, r, in.c, err)
			return
		}
		// 到达时会话还没登记的消息按渠道编号算进来
		where = append(where, "(conversation_id = ? OR (conversation_id IS NULL AND channel = ? AND conversation_external_id = ?))")
		args = append(args, cv.ID, cv.Channel, cv.ExternalID)
	}
	switch q.Get("mine") {
	case "":
	case "any":
		where = append(where, "relevance <> ''")
	case "at":
		where = append(where, "relevance = 'me'")
	default:
		fail(w, r, in.c, apiErr(errValidation, "mine must be any or at"))
		return
	}
	switch q.Get("snoozed") {
	case "":
	case "true", "1":
		where, args = append(where, "status = 'pending' AND snooze_until > ?"), append(args, in.clock().UTC().Format(timeLayout))
	case "false", "0":
		where, args = append(where, "(snooze_until IS NULL OR snooze_until <= ?)"), append(args, in.clock().UTC().Format(timeLayout))
	default:
		fail(w, r, in.c, apiErr(errValidation, "snoozed must be true or false"))
		return
	}
	switch q.Get("unread") {
	case "":
	case "true", "1":
		where = append(where, "is_read = 0")
	default:
		fail(w, r, in.c, apiErr(errValidation, "unread must be true"))
		return
	}
	limit, offset, err := paging(q.Get("limit"), q.Get("offset"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_messages`+cond, args...).Scan(&total); err != nil {
		fail(w, r, in.c, err)
		return
	}
	out, err := in.query(ctx, `SELECT `+messageCols+` FROM im_messages`+cond+` ORDER BY sent_at DESC, rowid DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total, "limit": limit, "offset": offset}})
}

func paging(l, o string) (int, int, error) {
	limit, offset := defaultLimit, 0
	if l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 {
			return 0, 0, apiErr(errValidation, "limit must be a positive integer")
		}
		limit = min(n, maxLimit)
	}
	if o != "" {
		n, err := strconv.Atoi(o)
		if err != nil || n < 0 {
			return 0, 0, apiErr(errValidation, "offset must be a non-negative integer")
		}
		offset = n
	}
	return limit, offset, nil
}

// query 读出消息，再按 id 补上会话名和联系人；到达时没认上的按渠道编号再认一次（不回写）。
func (in *inbox) query(ctx context.Context, sql string, args ...any) ([]Message, error) {
	rows, err := in.c.Store().Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out := []Message{}
	for rows.Next() {
		var m Message
		var convName, attachments string
		var read int
		if err := rows.Scan(&m.ID, &m.Channel, &m.ConnectorID, &m.ExternalID, &m.ConversationID, &m.ConversationExternalID,
			&m.ConversationKind, &convName, &m.IdentityID, &m.SenderID, &m.SenderName, &m.Text, &attachments, &m.Relevance,
			&m.Status, &read, &m.SnoozeUntil, &m.At, &m.ReceivedAt, &m.Adapter, &m.TaskID, &m.TaskRef, &m.ReplyError); err != nil {
			_ = rows.Close()
			return nil, err
		}
		m.Conversation, m.Read, m.Attachments = convName, read != 0, json.RawMessage(attachments)
		out = append(out, m)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	rs := newResolver(in.c)
	for i := range out {
		if err := rs.fill(ctx, &out[i]); err != nil {
			return nil, err
		}
	}
	if err := in.fillActions(ctx, out); err != nil {
		return nil, err
	}
	return out, nil
}

// resolver 在一次请求里缓存会话、身份、联系人的查询。
type resolver struct {
	c        plugin.Core
	convs    map[string]*plugin.ConversationInfo
	idents   map[string]*plugin.IdentityInfo
	contacts map[string]*plugin.ContactInfo
}

func newResolver(c plugin.Core) *resolver {
	return &resolver{c: c, convs: map[string]*plugin.ConversationInfo{},
		idents: map[string]*plugin.IdentityInfo{}, contacts: map[string]*plugin.ContactInfo{}}
}

// cached 查一次记一次；查不到也记（nil）。
func cached[T any](m map[string]*T, key string, get func() (T, error)) (*T, error) {
	if v, ok := m[key]; ok {
		return v, nil
	}
	v, err := get()
	if errors.Is(err, plugin.ErrNoRows) {
		m[key] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m[key] = &v
	return &v, nil
}

func (rs *resolver) fill(ctx context.Context, m *Message) error {
	var cv *plugin.ConversationInfo
	var err error
	switch {
	case m.ConversationID != nil:
		id := *m.ConversationID
		cv, err = cached(rs.convs, "id:"+id, func() (plugin.ConversationInfo, error) { return rs.c.Conversations().Get(ctx, id) })
	case m.ConversationExternalID != "":
		cv, err = cached(rs.convs, "ext:"+m.Channel+":"+m.ConversationExternalID, func() (plugin.ConversationInfo, error) {
			return rs.c.Conversations().Find(ctx, m.Channel, m.ConversationExternalID)
		})
	}
	if err != nil {
		return err
	}
	if cv != nil {
		m.ConversationID, m.ConversationKind, m.Conversation = &cv.ID, cv.Kind, cv.Name
	}
	if m.ConversationKind == "direct" {
		m.Conversation = ""
	}

	var idn *plugin.IdentityInfo
	if m.IdentityID != nil {
		id := *m.IdentityID
		idn, err = cached(rs.idents, "id:"+id, func() (plugin.IdentityInfo, error) { return rs.c.Identities().Get(ctx, id) })
	} else {
		idn, err = cached(rs.idents, "ext:"+m.Channel+":"+m.SenderID, func() (plugin.IdentityInfo, error) {
			return rs.c.Identities().Find(ctx, m.Channel, m.SenderID)
		})
	}
	if err != nil {
		return err
	}
	m.IdentityID = nil
	if idn == nil {
		return nil
	}
	m.IdentityID, m.StakeholderID = &idn.ID, &idn.StakeholderID
	sid := idn.StakeholderID
	ct, err := cached(rs.contacts, sid, func() (plugin.ContactInfo, error) { return rs.c.Contacts().Get(ctx, sid) })
	if err != nil {
		return err
	}
	if ct != nil {
		m.ContactName = ct.Name
	}
	return nil
}

// AdapterInfo 是 GET /api/im/adapters 的一项。
type AdapterInfo struct {
	Key      string `json:"key"`
	Channel  string `json:"channel"`
	Pull     bool   `json:"pull"`
	Callback bool   `json:"callback"`
}

func (in *inbox) listAdapters(w http.ResponseWriter, _ *http.Request) {
	out := []AdapterInfo{}
	for _, a := range in.adapters {
		_, pull := a.(Puller)
		_, cb := a.(Receiver)
		out = append(out, AdapterInfo{Key: a.Key(), Channel: a.Channel(), Pull: pull, Callback: cb})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (in *inbox) callback(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("adapter")
	var rc Receiver
	for _, a := range in.adapters {
		if x, ok := a.(Receiver); ok && a.Key() == key {
			rc = x
		}
	}
	if rc == nil {
		fail(w, r, in.c, apiErr(errNotFound, "no callback adapter %s", key))
		return
	}
	msgs, err := rc.Receive(r)
	if err != nil {
		if !errors.Is(err, errValidation) {
			err = apiErr(errValidation, "%v", err)
		}
		fail(w, r, in.c, err)
		return
	}
	res, err := in.ingest(r.Context(), rc, msgs, true)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

func decode(r *http.Request, v any, max int64) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return apiErr(errValidation, "read body: %v", err)
	}
	if int64(len(body)) > max {
		return apiErr(errValidation, "body too large")
	}
	if err := json.Unmarshal(body, v); err != nil {
		return apiErr(errValidation, "invalid json: %v", err)
	}
	return nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func fail(w http.ResponseWriter, r *http.Request, c plugin.Core, err error) {
	var ae *actionError
	if errors.As(err, &ae) {
		writeJSON(w, ae.status, map[string]any{"error": ae.body()})
		return
	}
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
