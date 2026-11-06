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

// Statuses 是消息状态，和原型 MsgStatus 一致；expired（IM-07）在库里是待处理加 expired_at，见 statusCond。
var Statuses = []string{"pending", "done", "ignored", "expired"}

// statusCol 是接口上的状态：待处理且标了过期的显示为 expired。
const statusCol = `CASE WHEN status = 'pending' AND expired_at IS NOT NULL THEN 'expired' ELSE status END`

// statusCond 是按接口状态筛的条件。
func statusCond(s string) string {
	switch s {
	case "pending":
		return "status = 'pending' AND expired_at IS NULL"
	case "expired":
		return "status = 'pending' AND expired_at IS NOT NULL"
	}
	return "status = '" + s + "'"
}

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
	// ExpiredAt 是被标成已过期的时间（IM-07），不是已过期为 null
	ExpiredAt *string `json:"expired_at"`
	// ProjectID、ProjectName 是这条消息归到的项目（0006）：SOP 节点 im_set_project 或手动设的；
	// 没归、项目删了（含软删）为 null 和空串，同 task_id。
	// 消息自己没归时按所在会话的默认项目兜底（0007，convproject.go）。ProjectSource 是归属的来源：
	// message（消息上设的）、conversation（群组默认项目）、没归为空串
	ProjectID     *string `json:"project_id"`
	ProjectName   string  `json:"project_name"`
	ProjectSource string  `json:"project_source"`
	// Sessions 是从这条消息发起的 Agent 会话，新的在前；SplitTasks 是会话里拆出来、来源指向它的任务（0008，sessions.go）
	Sessions   []MessageSession `json:"sessions"`
	SplitTasks []SplitTask      `json:"split_tasks"`
	// Materials 是这条消息转成的项目资料（含附件加进资料的），新的在前；项目删了的不列（0009，materials.go）
	Materials []MessageMaterial `json:"materials"`
	// Thread 是串里回复属于哪个串（0010，threads.go），不是串里回复的为 null；
	// ReplyCount 是这条消息作为父消息时，库里收到的串里回复条数（不含我回的）
	Thread     *MessageThread `json:"thread"`
	ReplyCount int            `json:"reply_count"`
	// RepliedSent 是这条来信回复的「我发出的」那条（0.17.0，outbox.go fillSentLinks），对不上为 null
	RepliedSent *SentRef `json:"replied_sent"`
	// Muted 是「因发信人 X 被设为自动忽略」（TSK-0495，mutes.go）：被自动忽略掉的才有，改回待处理、标为已处理后为 null
	Muted *MessageMute `json:"muted"`
}

const messageCols = `id, channel, connector_id, external_id, conversation_id, conversation_external_id, conversation_kind,
	conversation_name, sender_identity_id, sender_external_id, sender_name, text, attachments, relevance, ` + statusCol + `,
	is_read, snooze_until, sent_at, received_at, adapter, task_id, task_ref, reply_error, expired_at, project_id,
	thread_parent_external_id, thread_parent_sender, thread_parent_text, muted_by, muted_name`

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
		where = append(where, statusCond(s))
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
	if pid := strings.TrimSpace(q.Get("project_id")); pid != "" {
		// 只按归属筛，不校验项目在不在：项目删了，筛出来的是空列表。
		// 口径同读出时的 fillProject：消息自己归的项目（还在的）优先，其次所在会话的默认项目（0007，还在的）。
		// project_id=none（TSK-0723）是「未归项目」：两者都没有（或归的项目都删了）
		dead, err := in.deadProjects(ctx)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		own, ownArgs := liveProjectCond("project_id", dead)
		convs, convArgs := liveProjectCond("project_id", dead)
		if pid == ProjectNone {
			where = append(where, `NOT `+own+` AND (conversation_id IS NULL OR conversation_id NOT IN
				(SELECT conversation_id FROM im_conversation_projects WHERE `+convs+`))`)
			args = append(append(args, ownArgs...), convArgs...)
		} else {
			where = append(where, `(project_id = ? OR (NOT `+own+` AND conversation_id IN
				(SELECT conversation_id FROM im_conversation_projects WHERE project_id = ?)))`)
			args = append(append(append(args, pid), ownArgs...), pid)
		}
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
		where, args = append(where, statusCond("pending")+" AND snooze_until > ?"), append(args, in.clock().UTC().Format(timeLayout))
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

// ProjectNone 是 GET /api/im/messages?project_id= 的「未归项目」（TSK-0723）。
const ProjectNone = "none"

// deadProjects 是消息和会话默认项目里引用到、但已经不在（删了、含软删，或不是项目）的项目 id。
// 读出时这些按没归（fillProject），按项目筛也要一样算；引用到的项目数和项目总数同级，逐个查。
func (in *inbox) deadProjects(ctx context.Context) ([]string, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT DISTINCT project_id FROM im_messages WHERE project_id IS NOT NULL
		UNION SELECT project_id FROM im_conversation_projects`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	rs := newResolver(in.c)
	var dead []string
	for _, id := range ids {
		o, err := rs.project(ctx, id)
		if err != nil {
			return nil, err
		}
		if o == nil {
			dead = append(dead, id)
		}
	}
	return dead, nil
}

// liveProjectCond 是「col 归了一个还在的项目」的条件。
func liveProjectCond(col string, dead []string) (string, []any) {
	if len(dead) == 0 {
		return "(" + col + " IS NOT NULL)", nil
	}
	args := make([]any, len(dead))
	for i, id := range dead {
		args[i] = id
	}
	return "(" + col + " IS NOT NULL AND " + col + " NOT IN (?" + strings.Repeat(", ?", len(dead)-1) + "))", args
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
	var mutedBy, mutedName []string
	for rows.Next() {
		var m Message
		var convName, attachments, tParent, tSender, tText, mBy, mName string
		var read int
		if err := rows.Scan(&m.ID, &m.Channel, &m.ConnectorID, &m.ExternalID, &m.ConversationID, &m.ConversationExternalID,
			&m.ConversationKind, &convName, &m.IdentityID, &m.SenderID, &m.SenderName, &m.Text, &attachments, &m.Relevance,
			&m.Status, &read, &m.SnoozeUntil, &m.At, &m.ReceivedAt, &m.Adapter, &m.TaskID, &m.TaskRef, &m.ReplyError, &m.ExpiredAt, &m.ProjectID,
			&tParent, &tSender, &tText, &mBy, &mName); err != nil {
			_ = rows.Close()
			return nil, err
		}
		mutedBy, mutedName = append(mutedBy, mBy), append(mutedName, mName)
		m.Conversation, m.Read, m.Attachments = convName, read != 0, json.RawMessage(attachments)
		if tParent != "" {
			m.Thread = &MessageThread{ParentExternalID: tParent, ParentSenderName: tSender, ParentText: tText}
		}
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
	if err := in.fillAttachments(ctx, out); err != nil {
		return nil, err
	}
	if err := in.fillSessions(ctx, out); err != nil {
		return nil, err
	}
	if err := in.fillMaterials(ctx, out); err != nil {
		return nil, err
	}
	if err := in.fillThreads(ctx, out); err != nil {
		return nil, err
	}
	if err := in.fillSentLinks(ctx, out); err != nil {
		return nil, err
	}
	if err := in.fillMutes(ctx, out, mutedBy, mutedName); err != nil {
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
	projects map[string]*plugin.ObjectInfo
	// defaults 是会话的默认项目（0007），第一次用到时读一次
	defaults map[string]string
}

func newResolver(c plugin.Core) *resolver {
	return &resolver{c: c, convs: map[string]*plugin.ConversationInfo{},
		idents: map[string]*plugin.IdentityInfo{}, contacts: map[string]*plugin.ContactInfo{}, projects: map[string]*plugin.ObjectInfo{}}
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
	if err := rs.fillProject(ctx, m); err != nil {
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

// project 查一个没删的项目；不在、删了、不是项目的回 nil。
func (rs *resolver) project(ctx context.Context, id string) (*plugin.ObjectInfo, error) {
	o, err := cached(rs.projects, id, func() (plugin.ObjectInfo, error) { return rs.c.Objects().Get(ctx, id) })
	if err != nil || o == nil || o.Deleted || o.Type != projectType {
		return nil, err
	}
	return o, nil
}

// fillProject 补项目名；项目不在、删了、不是项目的按没归处理（不回写）。
// 消息自己没归（或归的项目没了）时按所在会话的默认项目兜底（0007）。
func (rs *resolver) fillProject(ctx context.Context, m *Message) error {
	if m.ProjectID != nil {
		o, err := rs.project(ctx, *m.ProjectID)
		if err != nil {
			return err
		}
		m.ProjectID = nil
		if o != nil {
			m.ProjectID, m.ProjectName, m.ProjectSource = &o.ID, o.Title, "message"
			return nil
		}
	}
	if m.ConversationID == nil {
		return nil
	}
	if rs.defaults == nil {
		d, err := loadDefaults(ctx, rs.c)
		if err != nil {
			return err
		}
		rs.defaults = d
	}
	pid, ok := rs.defaults[*m.ConversationID]
	if !ok {
		return nil
	}
	o, err := rs.project(ctx, pid)
	if err != nil || o == nil {
		return err
	}
	m.ProjectID, m.ProjectName, m.ProjectSource = &o.ID, o.Title, "conversation"
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
	var cr *CallbackReply
	if errors.As(err, &cr) {
		writeJSON(w, cr.Status, cr.Body)
		return
	}
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
