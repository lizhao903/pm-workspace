// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 自动忽略发信人（TSK-0495，插件迁移 0017_mutes.sql）：把某个发信人标为「自动忽略」，之后收到的这个人的消息
// 入库即「已忽略」、已读，不发 im.message_received——SOP 的 IM 流程、Agent 的 IM 触发都收不到，消息页也不提醒。
// 按渠道身份（kind=sender：渠道 + 发信人编号，机器人也一样有编号）或按联系人（kind=contact：名下全部 IM 身份）标；
// 范围是全部会话，或只在某个会话里。标记时可选把此人已有的待处理消息一并忽略。取消标记后新消息恢复正常，
// 已被自动忽略的消息不自动恢复。接口：GET/POST /api/im/mutes、GET /api/im/mutes/pending、DELETE /api/im/mutes/{mute_id}。

// Mute 是一条自动忽略。
// kind=sender 时 channel、sender_id 是渠道身份，stakeholder_id、contact_name 是这个身份现在认上的联系人（认不上为 null 和空串）；
// kind=contact 时 channel、sender_id 为空串，stakeholder_id 是标记的联系人，contact_name 是联系人现在的名字（联系人删了为空串）。
// conversation_id 为 null 是全部会话，否则只在这个会话里忽略，conversation 是会话名（私聊为空串，会话删了也为空串）。
// name 是标记时的显示名快照；ignored 是被它自动忽略掉的消息条数（含标记时一并忽略的），last_at 是最近一条的发送时间。
type Mute struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Channel        string  `json:"channel"`
	SenderID       string  `json:"sender_id"`
	StakeholderID  *string `json:"stakeholder_id"`
	ContactName    string  `json:"contact_name"`
	ConversationID *string `json:"conversation_id"`
	Conversation   string  `json:"conversation"`
	Name           string  `json:"name"`
	Ignored        int     `json:"ignored"`
	LastAt         *string `json:"last_at"`
	CreatedAt      string  `json:"created_at"`
}

// MessageMute 是消息上的「因发信人 X 被设为自动忽略」：mute_id 是那条自动忽略，name 是当时的显示名，
// active 为 false 时那条自动忽略已经取消了。
type MessageMute struct {
	MuteID string `json:"mute_id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

// muteTarget 是要标记、要数待处理条数的对象（请求里的 channel、sender_id 或 stakeholder_id，加可选的 conversation_id）。
type muteTarget struct {
	kind, channel, sender, stakeholder string
	conv                               *plugin.ConversationInfo
}

func (t muteTarget) convID() string {
	if t.conv == nil {
		return ""
	}
	return t.conv.ID
}

// parseTarget 校验并规整：channel + sender_id 和 stakeholder_id 二选一；会话、联系人不在 400。
func (in *inbox) parseTarget(ctx context.Context, channel, sender, stakeholder, conv string) (muteTarget, error) {
	var t muteTarget
	channel, sender, stakeholder, conv = strings.TrimSpace(channel), strings.TrimSpace(sender), strings.TrimSpace(stakeholder), strings.TrimSpace(conv)
	switch {
	case stakeholder != "" && (channel != "" || sender != ""):
		return t, apiErr(errValidation, "give either channel and sender_id, or stakeholder_id")
	case stakeholder != "":
		if _, err := in.c.Contacts().Get(ctx, stakeholder); errors.Is(err, plugin.ErrNoRows) {
			return t, apiErr(errValidation, "contact %s not found", stakeholder)
		} else if err != nil {
			return t, err
		}
		t.kind, t.stakeholder = "contact", stakeholder
	default:
		ch, err := imident.NormalizeChannel(channel)
		if err != nil {
			return t, apiErr(errValidation, "channel and sender_id are required (or stakeholder_id)")
		}
		ext, err := imident.NormalizeExternalID(ch, sender)
		if err != nil {
			return t, apiErr(errValidation, "sender_id is required")
		}
		t.kind, t.channel, t.sender = "sender", ch, ext
	}
	if conv != "" {
		cv, err := in.c.Conversations().Get(ctx, conv)
		if errors.Is(err, plugin.ErrNoRows) {
			return t, apiErr(errValidation, "conversation %s not found", conv)
		} else if err != nil {
			return t, err
		}
		t.conv = &cv
	}
	return t, nil
}

// muteFor 找收到的这一条命中的自动忽略：按渠道身份或认上的联系人，范围是全部会话或它所在的会话。
// 只在这个会话里的优先（它更具体），同级取先建的。没命中回空串。
func (in *inbox) muteFor(ctx context.Context, r row) (id, name string, err error) {
	err = in.c.Store().QueryRow(ctx, `SELECT id, name FROM im_mutes
		WHERE ((kind = 'sender' AND channel = ? AND sender_external_id = ?) OR (kind = 'contact' AND stakeholder_id = ?))
		AND (conversation_id = '' OR conversation_id = ?)
		ORDER BY conversation_id DESC, created_at, id LIMIT 1`,
		r.channel, r.senderExt, deref(r.stakeholderID), deref(r.convID)).Scan(&id, &name)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", "", nil
	}
	return id, name, err
}

// pendingWhere 是「这个对象已有的待处理消息」的条件（含稍后、已过期的，都是库里的 pending）。
// 按联系人时先把待处理消息里的发信人逐个认一遍（认人以现在的 IM 身份为准，同列表），挑出属于这个联系人的。
func (in *inbox) pendingWhere(ctx context.Context, t muteTarget) (string, []any, error) {
	where := []string{"status = 'pending'"}
	var args []any
	switch t.kind {
	case "sender":
		where, args = append(where, "channel = ? AND sender_external_id = ?"), append(args, t.channel, t.sender)
	default:
		pairs, err := in.senderPairsOf(ctx, t.stakeholder)
		if err != nil {
			return "", nil, err
		}
		if len(pairs) == 0 {
			return "", nil, nil
		}
		ors := make([]string, len(pairs))
		for i, p := range pairs {
			ors[i] = "(channel = ? AND sender_external_id = ?)"
			args = append(args, p[0], p[1])
		}
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	if t.conv != nil {
		where = append(where, "(conversation_id = ? OR (conversation_id IS NULL AND channel = ? AND conversation_external_id = ?))")
		args = append(args, t.conv.ID, t.conv.Channel, t.conv.ExternalID)
	}
	return strings.Join(where, " AND "), args, nil
}

// senderPairsOf 列待处理消息里属于这个联系人的发信人（渠道 + 编号）。
func (in *inbox) senderPairsOf(ctx context.Context, stakeholder string) ([][2]string, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT DISTINCT channel, sender_external_id FROM im_messages WHERE status = 'pending'`)
	if err != nil {
		return nil, err
	}
	var all [][2]string
	for rows.Next() {
		var p [2]string
		if err := rows.Scan(&p[0], &p[1]); err != nil {
			_ = rows.Close()
			return nil, err
		}
		all = append(all, p)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	var out [][2]string
	for _, p := range all {
		idn, err := in.c.Identities().Find(ctx, p[0], p[1])
		if errors.Is(err, plugin.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if idn.StakeholderID == stakeholder {
			out = append(out, p)
		}
	}
	return out, nil
}

func (in *inbox) countPending(ctx context.Context, t muteTarget) (int, error) {
	cond, args, err := in.pendingWhere(ctx, t)
	if err != nil || cond == "" {
		return 0, err
	}
	var n int
	err = in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_messages WHERE `+cond, args...).Scan(&n)
	return n, err
}

// mutePending 把这个对象已有的待处理消息一并忽略，记上是哪条自动忽略。
func (in *inbox) mutePending(ctx context.Context, t muteTarget, id, name string) (int, error) {
	cond, args, err := in.pendingWhere(ctx, t)
	if err != nil || cond == "" {
		return 0, err
	}
	res, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET status = 'ignored', snooze_until = NULL, is_read = 1, expired_at = NULL,
		muted_by = ?, muted_name = ? WHERE `+cond, append([]any{id, name}, args...)...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// GET /api/im/mutes/pending：这个对象（同 POST 的 channel、sender_id 或 stakeholder_id，可加 conversation_id）已有几条待处理消息，
// 标记时「一并忽略」的确认里用。
func (in *inbox) mutePendingCount(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	t, err := in.parseTarget(r.Context(), q.Get("channel"), q.Get("sender_id"), q.Get("stakeholder_id"), q.Get("conversation_id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	n, err := in.countPending(r.Context(), t)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]int{"pending": n}})
}

// MuteResult 是 POST /api/im/mutes 的结果：created 为 false 时同一对象、同一范围已经标过，回的是原来那条；
// ignored 是这次一并忽略的已有待处理消息条数（没要求一并忽略为 0）。
type MuteResult struct {
	Mute    Mute `json:"mute"`
	Created bool `json:"created"`
	Ignored int  `json:"ignored"`
}

func (in *inbox) createMute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Channel        string `json:"channel"`
		SenderID       string `json:"sender_id"`
		StakeholderID  string `json:"stakeholder_id"`
		ConversationID string `json:"conversation_id"`
		Name           string `json:"name"`
		IgnorePending  bool   `json:"ignore_pending"`
	}
	if err := decode(r, &body, 8<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	t, err := in.parseTarget(ctx, body.Channel, body.SenderID, body.StakeholderID, body.ConversationID)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	name, err := in.muteName(ctx, t, body.Name)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	id := idgen.Prefixed("imu")
	res, err := in.c.Store().Exec(ctx, `INSERT INTO im_mutes (id, kind, channel, sender_external_id, stakeholder_id, conversation_id, name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, channel, sender_external_id, stakeholder_id, conversation_id) DO NOTHING`,
		id, t.kind, t.channel, t.sender, t.stakeholder, t.convID(), name, in.clock().UTC().Format(timeLayout))
	if err != nil {
		fail(w, r, in.c, fmt.Errorf("insert im mute: %w", err))
		return
	}
	created := true
	if n, _ := res.RowsAffected(); n == 0 {
		created = false
		if err := in.c.Store().QueryRow(ctx, `SELECT id, name FROM im_mutes WHERE kind = ? AND channel = ? AND sender_external_id = ?
			AND stakeholder_id = ? AND conversation_id = ?`, t.kind, t.channel, t.sender, t.stakeholder, t.convID()).Scan(&id, &name); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	out := MuteResult{Created: created}
	if body.IgnorePending {
		if out.Ignored, err = in.mutePending(ctx, t, id, name); err != nil {
			fail(w, r, in.c, err)
			return
		}
	}
	ms, err := in.loadMutes(ctx, "WHERE id = ?", id)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if len(ms) == 0 {
		fail(w, r, in.c, apiErr(errNotFound, "mute %s not found", id))
		return
	}
	out.Mute = ms[0]
	code := http.StatusCreated
	if !created {
		code = http.StatusOK
	}
	writeJSON(w, code, map[string]any{"data": out})
}

// muteName 定显示名：请求给了用请求的；按联系人取联系人名；按渠道身份取认上的联系人名、最近一条消息的发信人名，都没有用编号。
func (in *inbox) muteName(ctx context.Context, t muteTarget, given string) (string, error) {
	if s := clip(strings.TrimSpace(given), maxName); s != "" {
		return s, nil
	}
	if t.kind == "contact" {
		ct, err := in.c.Contacts().Get(ctx, t.stakeholder)
		if err != nil {
			return "", err
		}
		return ct.Name, nil
	}
	if idn, err := in.c.Identities().Find(ctx, t.channel, t.sender); err == nil {
		if ct, err := in.c.Contacts().Get(ctx, idn.StakeholderID); err == nil && ct.Name != "" {
			return ct.Name, nil
		}
	}
	name, err := in.knownName(ctx, t.channel, t.sender)
	if err != nil {
		return "", err
	}
	if name == "" {
		name = t.sender
	}
	return name, nil
}

func (in *inbox) listMutes(w http.ResponseWriter, r *http.Request) {
	ms, err := in.loadMutes(r.Context(), "")
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": ms, "meta": map[string]int{"total": len(ms)}})
}

// loadMutes 读自动忽略（新标的在前），补上联系人、会话名和自动忽略掉的条数。
func (in *inbox) loadMutes(ctx context.Context, cond string, args ...any) ([]Mute, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT u.id, u.kind, u.channel, u.sender_external_id, u.stakeholder_id, u.conversation_id, u.name, u.created_at,
		(SELECT count(*) FROM im_messages m WHERE m.muted_by = u.id), (SELECT max(sent_at) FROM im_messages m WHERE m.muted_by = u.id)
		FROM im_mutes u `+strings.Replace(cond, "WHERE id", "WHERE u.id", 1)+` ORDER BY u.created_at DESC, u.id DESC`, args...)
	if err != nil {
		return nil, err
	}
	out := []Mute{}
	for rows.Next() {
		var m Mute
		var stk, conv string
		if err := rows.Scan(&m.ID, &m.Kind, &m.Channel, &m.SenderID, &stk, &conv, &m.Name, &m.CreatedAt, &m.Ignored, &m.LastAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if stk != "" {
			m.StakeholderID = &stk
		}
		if conv != "" {
			m.ConversationID = &conv
		}
		out = append(out, m)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range out {
		m := &out[i]
		if m.Kind == "sender" {
			idn, err := in.c.Identities().Find(ctx, m.Channel, m.SenderID)
			if err == nil {
				sid := idn.StakeholderID
				m.StakeholderID = &sid
			} else if !errors.Is(err, plugin.ErrNoRows) {
				return nil, err
			}
		}
		if m.StakeholderID != nil {
			ct, err := in.c.Contacts().Get(ctx, *m.StakeholderID)
			if err == nil {
				m.ContactName = ct.Name
			} else if !errors.Is(err, plugin.ErrNoRows) {
				return nil, err
			}
		}
		if m.ConversationID != nil {
			cv, err := in.c.Conversations().Get(ctx, *m.ConversationID)
			if err == nil && cv.Kind != "direct" {
				m.Conversation = cv.Name
			} else if err != nil && !errors.Is(err, plugin.ErrNoRows) {
				return nil, err
			}
		}
	}
	return out, nil
}

// DELETE /api/im/mutes/{mute_id}：取消自动忽略。之后这个人的新消息恢复正常；已被它自动忽略的消息不动（还是已忽略），
// 消息上的 muted 还在、active 变 false。回 {id, ignored}：ignored 是留在「已忽略」里的条数。
func (in *inbox) deleteMute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("mute_id")
	res, err := in.c.Store().Exec(ctx, `DELETE FROM im_mutes WHERE id = ?`, id)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, in.c, apiErr(errNotFound, "mute %s not found", id))
		return
	}
	var n int
	if err := in.c.Store().QueryRow(ctx, `SELECT count(*) FROM im_messages WHERE muted_by = ? AND status = 'ignored'`, id).Scan(&n); err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"id": id, "ignored": n}})
}

// fillMutes 给自动忽略掉的消息补上 muted（那条自动忽略还在不在）。
func (in *inbox) fillMutes(ctx context.Context, ms []Message, by []string, names []string) error {
	live := map[string]bool{}
	for i := range ms {
		id := by[i]
		if id == "" {
			continue
		}
		if _, ok := live[id]; !ok {
			var x int
			err := in.c.Store().QueryRow(ctx, `SELECT 1 FROM im_mutes WHERE id = ?`, id).Scan(&x)
			if err != nil && !errors.Is(err, plugin.ErrNoRows) {
				return err
			}
			live[id] = err == nil
		}
		ms[i].Muted = &MessageMute{MuteID: id, Name: names[i], Active: live[id]}
	}
	return nil
}
