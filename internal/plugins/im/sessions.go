// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 从消息发起会话、拆分任务（0008）：
//   - 前端用内核 POST /api/agent/sessions 建会话（带 source_ref 指回消息，内核 0047），再调 POST /api/im/sessions
//     把会话记到这一组消息上；消息读出来带 sessions（新的在前），界面显示「已发起会话」能跳过去。
//   - 会话里 Agent 用 create_object 建的任务，内核把会话来源记进 props.source_ref；本插件订阅 object.created，
//     source_ref 里的 message_id、message_ids 是本插件的消息时记进 im_message_tasks，消息读出来带 split_tasks。

// SessionIntents 是发起会话时的意图：chat 发起会话，split 拆分任务。
var SessionIntents = []string{"chat", "split"}

// sessionLinkMax 是一次最多记几条消息（同列表一页的上限）
const sessionLinkMax = maxLimit

// MessageSession 是从这条消息发起的一个会话。
type MessageSession struct {
	SessionID string `json:"session_id"`
	Intent    string `json:"intent"`
	At        string `json:"at"`
}

// SplitTask 是会话里拆出来、来源指向这条消息的任务（不含转任务那条 task_id），软删的不列。
type SplitTask struct {
	ID    string `json:"id"`
	Ref   string `json:"ref"`
	Title string `json:"title"`
}

// fillSessions 补 sessions、split_tasks；没有为空数组。
func (in *inbox) fillSessions(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	idx := map[string]int{}
	ph := make([]string, len(ms))
	args := make([]any, len(ms))
	for i := range ms {
		ms[i].Sessions, ms[i].SplitTasks = []MessageSession{}, []SplitTask{}
		idx[ms[i].ID] = i
		ph[i], args[i] = "?", ms[i].ID
	}
	in2 := strings.Join(ph, ",")
	rows, err := in.c.Store().Query(ctx, `SELECT message_id, session_id, intent, created_at FROM im_message_sessions
		WHERE message_id IN (`+in2+`) ORDER BY created_at DESC, rowid DESC`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var mid string
		var s MessageSession
		if err := rows.Scan(&mid, &s.SessionID, &s.Intent, &s.At); err != nil {
			_ = rows.Close()
			return err
		}
		if i, ok := idx[mid]; ok {
			ms[i].Sessions = append(ms[i].Sessions, s)
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}

	type link struct{ mid, tid string }
	var links []link
	rows, err = in.c.Store().Query(ctx, `SELECT message_id, task_id FROM im_message_tasks
		WHERE message_id IN (`+in2+`) ORDER BY created_at, rowid`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.mid, &l.tid); err != nil {
			_ = rows.Close()
			return err
		}
		links = append(links, l)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	seen := map[string]*plugin.ObjectInfo{}
	for _, l := range links {
		i, ok := idx[l.mid]
		if !ok || (ms[i].TaskID != nil && *ms[i].TaskID == l.tid) {
			continue
		}
		o, err := cached(seen, l.tid, func() (plugin.ObjectInfo, error) { return in.c.Objects().Get(ctx, l.tid) })
		if err != nil {
			return err
		}
		if o == nil || o.Deleted {
			continue
		}
		ms[i].SplitTasks = append(ms[i].SplitTasks, SplitTask{ID: o.ID, Ref: o.Ref, Title: o.Title})
	}
	return nil
}

// linkSession 是 POST /api/im/sessions：把一个已建好的内核会话记到一组消息上。
// body {session_id, message_ids, intent}；回 {session_id, intent, messages}，messages 是记好后的这组消息（按给的顺序）。
// 消息有不存在的 404 不记；会话不存在 400；同一组再记一次不报错（不重复记）。
func (in *inbox) linkSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		SessionID  string   `json:"session_id"`
		MessageIDs []string `json:"message_ids"`
		Intent     string   `json:"intent"`
	}
	if err := decode(r, &body, 64<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	sid := strings.TrimSpace(body.SessionID)
	if sid == "" {
		fail(w, r, in.c, apiErr(errValidation, "会话 session_id 还没给"))
		return
	}
	intent := strings.TrimSpace(body.Intent)
	if intent == "" {
		intent = "chat"
	}
	if !slices.Contains(SessionIntents, intent) {
		fail(w, r, in.c, apiErr(errValidation, "intent 只能是 chat 或 split"))
		return
	}
	var ids []string
	for _, id := range body.MessageIDs {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		fail(w, r, in.c, apiErr(errValidation, "消息 message_ids 还没给"))
		return
	}
	if len(ids) > sessionLinkMax {
		fail(w, r, in.c, apiErr(errValidation, "一次最多 %d 条消息", sessionLinkMax))
		return
	}
	ms, err := in.byIDs(ctx, ids)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if len(ms) != len(ids) {
		for _, id := range ids {
			if !slices.ContainsFunc(ms, func(m Message) bool { return m.ID == id }) {
				fail(w, r, in.c, apiErr(errNotFound, "消息 %s 不存在", id))
				return
			}
		}
	}
	now := in.clock().UTC().Format(timeLayout)
	for _, id := range ids {
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_message_sessions (message_id, session_id, intent, created_at)
			VALUES (?, ?, ?, ?) ON CONFLICT(message_id, session_id) DO NOTHING`, id, sid, intent, now); err != nil {
			if isFKError(err) {
				fail(w, r, in.c, apiErr(errValidation, "会话 %s 不存在", sid))
				return
			}
			fail(w, r, in.c, err)
			return
		}
	}
	ms, err = in.byIDs(ctx, ids)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"session_id": sid, "intent": intent, "messages": ms}})
}

// byIDs 读一组消息，按给的顺序；不存在的跳过。
func (in *inbox) byIDs(ctx context.Context, ids []string) ([]Message, error) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i], args[i] = "?", id
	}
	out, err := in.query(ctx, `SELECT `+messageCols+` FROM im_messages WHERE id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(out, func(a, b Message) int { return slices.Index(ids, a.ID) - slices.Index(ids, b.ID) })
	return out, nil
}

func isFKError(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "FOREIGN KEY")
}

// onObjectCreated 记下来源指向本插件消息的任务（会话里拆出来的、转任务建的都会来，读的时候排除转任务那条）。
// 只看 type=task；来源里的 message_id、message_ids 有一条是本插件的消息就记。出错只记日志，不影响建对象。
func (in *inbox) onObjectCreated(ctx context.Context, c plugin.Core, ev plugin.Event) error {
	var p struct {
		ID     string `json:"id"`
		TypeID string `json:"type_id"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil || p.ID == "" || (p.TypeID != "" && p.TypeID != "task") {
		return nil
	}
	o, err := c.Objects().Get(ctx, p.ID)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if o.Type != "task" {
		return nil
	}
	ids := sourceMessageIDs(o.Props)
	if len(ids) == 0 {
		return nil
	}
	now := in.clock().UTC().Format(timeLayout)
	for _, mid := range ids {
		if _, err := c.Store().Exec(ctx, `INSERT INTO im_message_tasks (message_id, task_id, created_at)
			SELECT id, ?, ? FROM im_messages WHERE id = ? ON CONFLICT(message_id, task_id) DO NOTHING`, o.ID, now, mid); err != nil {
			return err
		}
	}
	// 从消息发起的会话里拆出来的任务（手动拆分）：排 FDE 反馈转发，攒一段汇成一条（TSK-0468）
	in.onSessionTask(ctx, o.Props, o.ID, ids)
	return nil
}

// sourceMessageIDs 取 props.source_ref 里的 message_id 和 message_ids，去重、保序。
func sourceMessageIDs(props map[string]any) []string {
	ref, _ := props[domain.PropSourceRef].(map[string]any)
	if ref == nil {
		return nil
	}
	var out []string
	add := func(v any) {
		if s, ok := v.(string); ok {
			if s = strings.TrimSpace(s); s != "" && !slices.Contains(out, s) && len(out) < sessionLinkMax {
				out = append(out, s)
			}
		}
	}
	add(ref["message_id"])
	if xs, ok := ref["message_ids"].([]any); ok {
		for _, x := range xs {
			add(x)
		}
	}
	return out
}
