// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 群组管理（0.15.0，不加迁移）：给 IM 消息页「群组管理」抽屉用。
// GET /api/im/conversations/summary 一次列出有消息（或设了默认项目）的会话和统计：消息总数、待处理数、未读数、最近一条时间、默认项目。
// PUT /api/im/conversation-projects 批量设、清除默认项目：逐条校验，能写的一起写，回成功和失败明细；每个改了的会话记一条审计。
// 单个的 PUT /api/im/conversation-projects/{conversation_id} 见 convproject.go，改了也记审计。

// maxConvBatch 是批量设默认项目一次最多几个会话。
const maxConvBatch = 200

// maxParticipants 是会话统计里最多列几个发信人。
const maxParticipants = 5

// ConversationSummary 是群组管理列表的一行。
// Name 是会话名（私聊为空）；Participants 是发过消息的人（认上联系人的用联系人名），最近发言的在前，最多 5 个，私聊的对方就是第一个。
// Pending 口径同群组标签：待处理、没过期、不在稍后里。LastAt 是最近一条的发送时间，没有消息为 null。
// ProjectID 等是会话的默认项目，没设或项目删了为 null 和空串。Sent、LastSentAt 见字段注释。
type ConversationSummary struct {
	ConversationID string `json:"conversation_id"`
	Channel        string `json:"channel"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	ExternalID     string `json:"external_id"`
	// ConnectorID 是最近一条消息所在的连接器（主动发消息默认用它，0.17.0），没有消息为空串
	ConnectorID  string   `json:"connector_id"`
	Participants []string `json:"participants"`
	Total        int      `json:"total"`
	Pending      int      `json:"pending"`
	Unread       int      `json:"unread"`
	LastAt       *string  `json:"last_at"`
	ProjectID    *string  `json:"project_id"`
	ProjectRef   string   `json:"project_ref"`
	ProjectName  string   `json:"project_name"`
	// Sent、LastSentAt 是主动发出去的（发成功的）条数和最近一次的时间（0.17.0，outbox.go），没发过为 0 和 null
	Sent       int     `json:"sent"`
	LastSentAt *string `json:"last_sent_at"`
	// 查询回填（TSK-0494，names.go）：UnresolvedUsers 是 participants 里只能显示编号的人（渠道没给名字、也没认上有名字的联系人）；
	// NameUnresolved 是群名为空或就是编号；CanRefill 是能回渠道按编号查（渠道支持、有消息所在的连接器）；
	// RefillError 是之前查过、没查到的原因（几个都没查到取第一个），没查过或都查到了为空串
	UnresolvedUsers []string `json:"unresolved_users"`
	NameUnresolved  bool     `json:"name_unresolved"`
	CanRefill       bool     `json:"can_refill"`
	RefillError     string   `json:"refill_error"`
	// 补全消息（TSK-0724，history.go）：CanBackfill 是能回渠道拉这个会话的历史（渠道支持、有消息所在的连接器）；
	// BackfillNote 是不能的原因（按钮置灰时的说明），能的为空串
	CanBackfill  bool   `json:"can_backfill"`
	BackfillNote string `json:"backfill_note"`
}

func (in *inbox) conversationSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	channel := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("channel")))
	now := in.clock().UTC().Format(timeLayout)
	cond, args := "conversation_id IS NOT NULL", []any{now}
	if channel != "" {
		cond, args = cond+" AND channel = ?", append(args, channel)
	}
	// 只有一个 max() 聚合，SQLite 取的 channel、conversation_kind、conversation_name、connector_id 是最近那条的
	rows, err := in.c.Store().Query(ctx, `SELECT conversation_id, channel, conversation_kind, conversation_name, conversation_external_id, connector_id, count(*),
		sum(CASE WHEN status = 'pending' AND expired_at IS NULL AND (snooze_until IS NULL OR snooze_until <= ?) THEN 1 ELSE 0 END),
		sum(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), max(sent_at)
		FROM im_messages WHERE `+cond+` GROUP BY conversation_id`, args...)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	var out []ConversationSummary
	seen := map[string]int{}
	for rows.Next() {
		var s ConversationSummary
		var last string
		if err := rows.Scan(&s.ConversationID, &s.Channel, &s.Kind, &s.Name, &s.ExternalID, &s.ConnectorID, &s.Total, &s.Pending, &s.Unread, &last); err != nil {
			_ = rows.Close()
			fail(w, r, in.c, err)
			return
		}
		s.LastAt = &last
		seen[s.ConversationID] = len(out)
		out = append(out, s)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	if err := in.fillParticipants(ctx, out, seen, cond, args[1:]); err != nil {
		fail(w, r, in.c, err)
		return
	}
	defaults, err := loadDefaults(ctx, in.c)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	sentN, sentAt, err := in.sentStats(ctx)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	lookups, err := in.allLookups(ctx)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	rs := newResolver(in.c)
	// 设了默认项目、还没收过消息的会话也列出来
	for cid := range defaults {
		if _, ok := seen[cid]; ok {
			continue
		}
		seen[cid] = len(out)
		out = append(out, ConversationSummary{ConversationID: cid, Participants: []string{}})
	}
	kept := out[:0]
	for _, s := range out {
		cv, err := cached(rs.convs, "id:"+s.ConversationID, func() (plugin.ConversationInfo, error) { return in.c.Conversations().Get(ctx, s.ConversationID) })
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		switch {
		case cv != nil:
			s.Channel, s.Kind, s.Name, s.ExternalID = cv.Channel, cv.Kind, cv.Name, cv.ExternalID
		case s.Total == 0:
			continue // 会话删了、又没消息
		}
		if channel != "" && s.Channel != channel {
			continue
		}
		if s.Kind == "direct" {
			s.Name = ""
		}
		in.markUnresolved(&s, cv, lookups)
		if at, ok := sentAt[s.ConversationID]; ok {
			s.Sent, s.LastSentAt = sentN[s.ConversationID], &at
		}
		if pid, ok := defaults[s.ConversationID]; ok {
			o, err := rs.project(ctx, pid)
			if err != nil {
				fail(w, r, in.c, err)
				return
			}
			if o != nil {
				id := o.ID
				s.ProjectID, s.ProjectRef, s.ProjectName = &id, o.Ref, o.Title
			}
		}
		kept = append(kept, s)
	}
	out = kept
	// 最近有消息的在前；没消息的排最后，按名字
	sort.SliceStable(out, func(i, j int) bool {
		a, b := deref(out[i].LastAt), deref(out[j].LastAt)
		if a != b {
			return a > b
		}
		return out[i].Name < out[j].Name
	})
	if out == nil {
		out = []ConversationSummary{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// fillParticipants 补每个会话的发信人：按发信人取最近一次发言，认上联系人的用联系人名，同名的只列一次。
func (in *inbox) fillParticipants(ctx context.Context, out []ConversationSummary, at map[string]int, cond string, args []any) error {
	rows, err := in.c.Store().Query(ctx, `SELECT conversation_id, channel, sender_identity_id, sender_external_id, sender_name, max(sent_at) AS last_sent
		FROM im_messages WHERE `+cond+` GROUP BY conversation_id, channel, sender_external_id ORDER BY conversation_id, last_sent DESC`, args...)
	if err != nil {
		return err
	}
	type sender struct {
		cid, channel, ext, name string
		idn                     *string
	}
	var all []sender
	for rows.Next() {
		var s sender
		var last string
		if err := rows.Scan(&s.cid, &s.channel, &s.idn, &s.ext, &s.name, &last); err != nil {
			_ = rows.Close()
			return err
		}
		all = append(all, s)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	rs := newResolver(in.c)
	for _, s := range all {
		i, ok := at[s.cid]
		if !ok || len(out[i].Participants) >= maxParticipants {
			continue
		}
		name := s.name
		if s.ext == "" && name == "" {
			continue
		}
		var idn *plugin.IdentityInfo
		if s.idn != nil {
			id := *s.idn
			idn, err = cached(rs.idents, "id:"+id, func() (plugin.IdentityInfo, error) { return in.c.Identities().Get(ctx, id) })
		} else {
			idn, err = cached(rs.idents, "ext:"+s.channel+":"+s.ext, func() (plugin.IdentityInfo, error) { return in.c.Identities().Find(ctx, s.channel, s.ext) })
		}
		if err != nil {
			return err
		}
		if idn != nil {
			sid := idn.StakeholderID
			ct, err := cached(rs.contacts, sid, func() (plugin.ContactInfo, error) { return in.c.Contacts().Get(ctx, sid) })
			if err != nil {
				return err
			}
			if ct != nil && ct.Name != "" {
				name = ct.Name
			}
		}
		raw := name == ""
		if raw {
			name = s.ext
		}
		if !slices.Contains(out[i].Participants, name) {
			out[i].Participants = append(out[i].Participants, name)
			if raw {
				out[i].UnresolvedUsers = append(out[i].UnresolvedUsers, s.ext)
			}
		}
	}
	for i := range out {
		if out[i].Participants == nil {
			out[i].Participants = []string{}
		}
	}
	return nil
}

// allLookups 读查询回填的记录（channel/kind/编号 -> 结果），列表上标没查到的原因、补群名用。
func (in *inbox) allLookups(ctx context.Context) (map[string]lookupRec, error) {
	rows, err := in.c.Store().Query(ctx, `SELECT channel, kind, external_id, name, code, message FROM im_name_lookups`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]lookupRec{}
	for rows.Next() {
		var ch, kind, ext string
		var r lookupRec
		if err := rows.Scan(&ch, &kind, &ext, &r.name, &r.code, &r.message); err != nil {
			return nil, err
		}
		out[ch+"/"+kind+"/"+ext] = r
	}
	return out, rows.Err()
}

// markUnresolved 补一行的查询回填字段：群名缺的用查到的会话名，没查到的写原因。
func (in *inbox) markUnresolved(s *ConversationSummary, cv *plugin.ConversationInfo, lookups map[string]lookupRec) {
	if s.UnresolvedUsers == nil {
		s.UnresolvedUsers = []string{}
	}
	if cv != nil && convNameMissing(*cv) {
		rec := lookups[s.Channel+"/conversation/"+cv.ExternalID]
		if rec.name != "" {
			s.Name = rec.name
		} else {
			s.NameUnresolved = true
			s.RefillError = rec.message
		}
	}
	for _, x := range s.UnresolvedUsers {
		if s.RefillError != "" {
			break
		}
		s.RefillError = lookups[s.Channel+"/user/"+x].message
	}
	s.CanRefill = s.ConnectorID != "" && in.nameResolverFor(s.Channel) != nil
	s.BackfillNote = in.backfillNote(s.Channel, s.ConnectorID)
	s.CanBackfill = s.BackfillNote == ""
}

// ConversationProjectFailure 是批量设默认项目里没写成的一条；Message 是给人看的中文原因。
type ConversationProjectFailure struct {
	ConversationID string  `json:"conversation_id"`
	ProjectID      *string `json:"project_id"`
	Code           string  `json:"code"`
	Message        string  `json:"message"`
}

type convProjectItem struct {
	cid string
	raw *string
	// 校验后：pid 为空是清除
	pid  string
	proj *plugin.ObjectInfo
	cv   plugin.ConversationInfo
}

// setConversationProjects 是批量设、清除：body {items: [{conversation_id, project_id}]} 或 {conversation_ids: [...], project_id}。
// 逐条校验（会话在不在、项目在不在、同一会话不能出现两次），过了的写进去，没过的列进 failed；全都没过也回 200。
// 写入是两条语句（设的一条 upsert、清的一条 delete），后一条失败时把前一条改过的恢复原样，整批要么都写上要么都不写。
func (in *inbox) setConversationProjects(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body map[string]json.RawMessage
	if err := decode(r, &body, 128<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	items, err := parseConvProjectBody(body)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	failed := []ConversationProjectFailure{}
	bad := func(it convProjectItem, code, msg string) {
		failed = append(failed, ConversationProjectFailure{ConversationID: it.cid, ProjectID: it.raw, Code: code, Message: msg})
	}
	projects := map[string]*plugin.ObjectInfo{}
	dup := map[string]bool{}
	var ok []convProjectItem
	for _, it := range items {
		if it.cid == "" {
			bad(it, "validation", "会话 id 没填")
			continue
		}
		if dup[it.cid] {
			bad(it, "validation", "同一个会话在这批里出现了两次，只按第一次的算")
			continue
		}
		dup[it.cid] = true
		cv, err := in.c.Conversations().Get(ctx, it.cid)
		if errors.Is(err, plugin.ErrNoRows) {
			bad(it, "not_found", "会话不存在")
			continue
		}
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		it.cv = cv
		if key := strings.TrimSpace(deref(it.raw)); key != "" {
			o, seen := projects[key]
			if !seen {
				x, err := in.findProject(ctx, key)
				switch {
				case errors.Is(err, errValidation):
					o = nil
				case err != nil:
					fail(w, r, in.c, err)
					return
				default:
					o = &x
				}
				projects[key] = o
			}
			if o == nil {
				bad(it, "validation", "项目「"+key+"」不存在、已删除或不是项目")
				continue
			}
			it.pid, it.proj = o.ID, o
		}
		ok = append(ok, it)
	}

	before, err := loadDefaults(ctx, in.c)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	now := in.clock().UTC().Format(timeLayout)
	if err := in.writeConvProjects(ctx, ok, before, now); err != nil {
		fail(w, r, in.c, err)
		return
	}

	rs := newResolver(in.c)
	updated := []ConversationProject{}
	for _, it := range ok {
		x := ConversationProject{ConversationID: it.cid, UpdatedAt: now}
		if it.proj != nil {
			id := it.proj.ID
			x.ProjectID, x.ProjectRef, x.ProjectName = &id, it.proj.Ref, it.proj.Title
		}
		updated = append(updated, x)
		in.noteConvProject(ctx, rs, it.cv, before[it.cid], it.pid, true)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": map[string]any{"updated": updated, "failed": failed},
		"meta": map[string]int{"total": len(items), "updated": len(updated), "failed": len(failed)},
	})
}

func parseConvProjectBody(body map[string]json.RawMessage) ([]convProjectItem, error) {
	rawItems, hasItems := body["items"]
	rawIDs, hasIDs := body["conversation_ids"]
	var items []convProjectItem
	switch {
	case hasItems && hasIDs:
		return nil, apiErr(errValidation, "items and conversation_ids cannot be used together")
	case hasItems:
		var xs []map[string]*string
		if err := json.Unmarshal(rawItems, &xs); err != nil {
			return nil, apiErr(errValidation, "items must be an array of {conversation_id, project_id}")
		}
		for i, x := range xs {
			raw, has := x["project_id"]
			if !has {
				return nil, apiErr(errValidation, "items[%d].project_id is required (null to clear)", i)
			}
			items = append(items, convProjectItem{cid: strings.TrimSpace(deref(x["conversation_id"])), raw: raw})
		}
	case hasIDs:
		var ids []string
		if err := json.Unmarshal(rawIDs, &ids); err != nil {
			return nil, apiErr(errValidation, "conversation_ids must be an array of strings")
		}
		rawPID, has := body["project_id"]
		if !has {
			return nil, apiErr(errValidation, "project_id is required (null to clear)")
		}
		var pid *string
		if err := json.Unmarshal(rawPID, &pid); err != nil {
			return nil, apiErr(errValidation, "project_id must be a string or null")
		}
		for _, id := range ids {
			items = append(items, convProjectItem{cid: strings.TrimSpace(id), raw: pid})
		}
	default:
		return nil, apiErr(errValidation, "items or conversation_ids is required")
	}
	if len(items) == 0 {
		return nil, apiErr(errValidation, "items must not be empty")
	}
	if len(items) > maxConvBatch {
		return nil, apiErr(errValidation, "at most %d conversations at a time", maxConvBatch)
	}
	return items, nil
}

// writeConvProjects 写一批：设的一条 upsert，清的一条 delete；delete 失败时把 upsert 改过的恢复成 before。
func (in *inbox) writeConvProjects(ctx context.Context, items []convProjectItem, before map[string]string, now string) error {
	var sets []convProjectItem
	var clears []string
	for _, it := range items {
		if it.pid == "" {
			clears = append(clears, it.cid)
		} else {
			sets = append(sets, it)
		}
	}
	if len(sets) > 0 {
		vals := make([]string, len(sets))
		var args []any
		for i, it := range sets {
			vals[i] = "(?, ?, ?)"
			args = append(args, it.cid, it.pid, now)
		}
		if _, err := in.c.Store().Exec(ctx, `INSERT INTO im_conversation_projects (conversation_id, project_id, updated_at) VALUES `+strings.Join(vals, ", ")+`
			ON CONFLICT (conversation_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`, args...); err != nil {
			return err
		}
	}
	if len(clears) == 0 {
		return nil
	}
	ph := make([]string, len(clears))
	args := make([]any, len(clears))
	for i, cid := range clears {
		ph[i], args[i] = "?", cid
	}
	_, err := in.c.Store().Exec(ctx, `DELETE FROM im_conversation_projects WHERE conversation_id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err == nil || len(sets) == 0 {
		return err
	}
	// 恢复设的那些：原来没有的删掉，原来有的写回原值
	for _, it := range sets {
		var rerr error
		if old, had := before[it.cid]; had {
			_, rerr = in.c.Store().Exec(ctx, `UPDATE im_conversation_projects SET project_id = ? WHERE conversation_id = ?`, old, it.cid)
		} else {
			_, rerr = in.c.Store().Exec(ctx, `DELETE FROM im_conversation_projects WHERE conversation_id = ?`, it.cid)
		}
		if rerr != nil {
			in.c.Log().Error("im conversation project rollback failed", "conversation_id", it.cid, "err", rerr)
		}
	}
	return err
}

// noteConvProject 记一条审计：会话的默认项目从 from 改成 to（空串是没设）；没变不记。
func (in *inbox) noteConvProject(ctx context.Context, rs *resolver, cv plugin.ConversationInfo, from, to string, batch bool) {
	if from == to {
		return
	}
	label := func(pid string) string {
		if pid == "" {
			return "不归项目"
		}
		if o, err := rs.project(ctx, pid); err == nil && o != nil {
			return o.Title
		}
		return pid
	}
	name := cv.Name
	if name == "" {
		name = cv.ExternalID
	}
	detail := map[string]any{"field": "default_project", "channel": cv.Channel, "from": nullable(from), "to": nullable(to)}
	if batch {
		detail["batch"] = true
	}
	in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "conversation", TargetID: cv.ID,
		Summary: "群组默认归属「" + name + "」" + label(from) + " → " + label(to), Detail: detail}, plugin.WriteMeta{})
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
