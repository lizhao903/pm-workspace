// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 触发的过滤条件、执行顺序与拦截（TSK-0481，插件迁移 0008_im_trigger）。
//
// 流程接口的 im 是 IMTrigger。写流程时 body 可带 im：{conversations?, relevance?, relevance_mode?, thread_related?, order?, stop?}，给哪项改哪项。
//   - conversations：会话，空表示全部。每项认内核会话 id（cv_）、渠道里的会话编号（Slack 的 C0BNCBRL5C0）、「渠道:编号」、会话名，
//     存成 cv_ id；找不到、对上多个都回 400。
//   - relevance：与我的关系 me（@我）/ all（@所有人）/ dm（私聊）/ none（无关，事件里是空串），空表示不限；
//     relevance_mode 是 include（只要这几种，缺省）或 exclude（除了这几种）。
//   - order：在 IM 流程里排第几（1 起），插进去后其余顺延；超过总数排最后。不给时：新的 IM 流程排最后，已是 IM 的不动。
//     触发方式不是 im 时 order 不认（只有 IM 流程有顺序），改成 im 时排最后。
//   - thread_related（0.23.0）：相关串里的回复按 @我 算。消息列（串）里的回复只要串和我相关，它的关系是无关或 @所有人时按 @我 判断
//     （私聊不变），口径同 IM 0.16 起「我发起的串里的回复记 @我」：「只要 @我」的流程会接，「除了 @我」的流程会放过；
//     会话那一项照样要符合，不设关系（不限）时不起作用。串和我相关 = IM 事件的 thread_related 为真
//     （我发起的串、父消息 @我、父消息是私信、父消息转过任务，见 im/threadrel.go），或父消息（thread_parent_message_id）
//     已经被这条流程跑过（任意状态：自动分诊过、批量分诊过）。只看这条流程自己跑过的，免得别的流程（例如把某个群的
//     自动消息标为忽略的流程）跑过的父消息也把回复带进来。缺省 false，已有流程行为不变。
//   - stop：拦截。命中过滤、发起了执行（或这条消息此前已经为它发起过）后，排在后面的 IM 流程对这条消息不再发起。
//     以「命中并发起」为准，不等执行跑完、不看执行成败；必填字段补不齐、发起出错的不算命中，不拦。
//
// 只管 SOP 的 IM 流程。IM 插件收消息时自己做的（认人、认会话、算与我相关、问进度的回复、确认私信的回复）、
// Agent 的 IM 触发都不受顺序和拦截影响；IM 插件写进来的内置流程（IM 需求自动受理等）本身是 SOP，改成 im 后照常排进顺序、可以被拦。

const (
	imModeInclude = "include"
	imModeExclude = "exclude"
	// imRelNone 是「无关」：事件里 relevance 是空串
	imRelNone = "none"
	// maxIMConversations 是一条流程最多选几个会话
	maxIMConversations = 50
)

// imRelevances 是 relevance 能取的值，顺序即界面上的顺序。
var imRelevances = []string{"me", "all", "dm", imRelNone}

// IMTrigger 是流程的 IM 触发设置。Order 是在 IM 流程里排第几（1 起），触发方式不是 im 时为 0。
// ThreadRelated 是「相关串里的回复按 @我 算」（0.23.0）。
type IMTrigger struct {
	Conversations []string `json:"conversations"`
	Relevance     []string `json:"relevance"`
	RelevanceMode string   `json:"relevance_mode"`
	ThreadRelated bool     `json:"thread_related"`
	Order         int      `json:"order"`
	Stop          bool     `json:"stop"`
}

// imFilter 是 im_filter 列里存的；thread_related 为 false 时不写，旧流程存的样子不变。
type imFilter struct {
	Conversations []string `json:"conversations"`
	Relevance     []string `json:"relevance"`
	RelevanceMode string   `json:"relevance_mode"`
	ThreadRelated bool     `json:"thread_related,omitempty"`
}

func (t IMTrigger) filterJSON() string {
	b, _ := json.Marshal(imFilter{Conversations: t.Conversations, Relevance: t.Relevance, RelevanceMode: t.RelevanceMode, ThreadRelated: t.ThreadRelated})
	return string(b)
}

// readIMFilter 解 im_filter 列，解不开当不过滤。
func readIMFilter(raw string, t *IMTrigger) {
	var f imFilter
	_ = json.Unmarshal([]byte(raw), &f)
	t.Conversations, t.Relevance, t.RelevanceMode, t.ThreadRelated = f.Conversations, f.Relevance, f.RelevanceMode, f.ThreadRelated
	normIM(t)
}

// normIM 补齐空数组和缺省方式，接口里不出现 null。
func normIM(t *IMTrigger) {
	if t.Conversations == nil {
		t.Conversations = []string{}
	}
	if t.Relevance == nil {
		t.Relevance = []string{}
	}
	if t.RelevanceMode != imModeExclude {
		t.RelevanceMode = imModeInclude
	}
}

// matches 是一条消息符不符合过滤条件。
func (t IMTrigger) matches(m imReceived) bool {
	if len(t.Conversations) > 0 && !slices.Contains(t.Conversations, deref(m.ConversationID)) {
		return false
	}
	return t.relevanceOK(m)
}

// relevanceOK 是与我的关系这一项符不符合（不看会话）：没设关系为符合；按 effRel 认关系。
// m.ThreadRelated 应已按这条流程补过「父消息被这条流程跑过」（threadView）。
func (t IMTrigger) relevanceOK(m imReceived) bool {
	if len(t.Relevance) == 0 {
		return true
	}
	in := slices.Contains(t.Relevance, t.effRel(m))
	if t.RelevanceMode == imModeExclude {
		in = !in
	}
	return in
}

// effRel 是这条流程按什么关系判断这条消息（无关写成 none）：勾了「相关串里的回复按 @我 算」、这条是串相关的回复、
// 关系是无关或 @所有人时按 me；其余照事件里的。
func (t IMTrigger) effRel(m imReceived) string {
	rel := m.Relevance
	if t.ThreadRelated && m.ThreadRelated && (rel == "" || rel == "all") {
		return "me"
	}
	if rel == "" {
		return imRelNone
	}
	return rel
}

// imThreadTriaged 是 SOP 这边补的串相关原因：父消息已经被这条流程跑过。
const imThreadTriaged = "triaged"

// threadView 是按这条流程看的消息：流程设了「相关串里的回复按 @我 算」、IM 插件没认出串相关、又有父消息 id 时，
// 查父消息是不是已经被这条流程跑过（任意状态），是的话记串相关、原因 triaged。查不了当不相关。
func threadView(ctx context.Context, c plugin.Core, f Flow, m imReceived) imReceived {
	if !f.IM.ThreadRelated || m.ThreadRelated || deref(m.ThreadParentMessageID) == "" || f.ID == "" {
		return m
	}
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?`,
		f.ID, deref(m.ThreadParentMessageID)).Scan(&n); err != nil || n == 0 {
		return m
	}
	m.ThreadRelated, m.ThreadReason = true, imThreadTriaged
	return m
}

// imThreadLabel 是串相关原因给人看的说法。
func imThreadLabel(r string) string {
	switch r {
	case "mine":
		return "我发起的消息列"
	case "mention":
		return "原消息 @我"
	case "dm":
		return "原消息是私信"
	case "task":
		return "原消息转过任务"
	case imThreadTriaged:
		return "原消息被这条流程跑过"
	}
	return r
}

// imIn 是 body 里的 im，nil 字段是没给。
type imIn struct {
	Conversations *[]string
	Relevance     *[]string
	RelevanceMode *string
	ThreadRelated *bool
	Order         *int
	Stop          *bool
}

// readIMIn 读并校验 body 里的 im，会话换成 cv_ id；先于流程校验，免得流程存了、条件没存上。
func readIMIn(ctx context.Context, c plugin.Core, raw map[string]json.RawMessage) (*imIn, error) {
	v, ok := raw["im"]
	if !ok || string(v) == "null" {
		return &imIn{}, nil
	}
	var b struct {
		Conversations *json.RawMessage `json:"conversations"`
		Relevance     *json.RawMessage `json:"relevance"`
		RelevanceMode *string          `json:"relevance_mode"`
		ThreadRelated *bool            `json:"thread_related"`
		Order         *json.RawMessage `json:"order"`
		Stop          *bool            `json:"stop"`
	}
	if err := json.Unmarshal(v, &b); err != nil {
		return nil, apiErr(errValidation, "im 必须是对象：{conversations, relevance, relevance_mode, thread_related, order, stop}")
	}
	in := &imIn{Stop: b.Stop, ThreadRelated: b.ThreadRelated}
	if b.Conversations != nil && string(*b.Conversations) != "null" {
		var refs []string
		if err := json.Unmarshal(*b.Conversations, &refs); err != nil {
			return nil, apiErr(errValidation, "im.conversations 必须是字符串数组")
		}
		ids, err := resolveConversations(ctx, c, refs)
		if err != nil {
			return nil, err
		}
		in.Conversations = &ids
	}
	if b.Relevance != nil && string(*b.Relevance) != "null" {
		var rels []string
		if err := json.Unmarshal(*b.Relevance, &rels); err != nil {
			return nil, apiErr(errValidation, "im.relevance 必须是字符串数组")
		}
		out := []string{}
		for _, r := range rels {
			r = strings.ToLower(strings.TrimSpace(r))
			if r == "" {
				r = imRelNone
			}
			if !slices.Contains(imRelevances, r) {
				return nil, apiErr(errValidation, "im.relevance 只能是 me（@我）、all（@所有人）、dm（私聊）、none（无关），不认 %s", r)
			}
			if !slices.Contains(out, r) {
				out = append(out, r)
			}
		}
		// 按固定顺序存，界面和比对都稳定
		slices.SortFunc(out, func(a, b string) int { return slices.Index(imRelevances, a) - slices.Index(imRelevances, b) })
		in.Relevance = &out
	}
	if b.RelevanceMode != nil {
		m := strings.TrimSpace(*b.RelevanceMode)
		if m == "" {
			m = imModeInclude
		}
		if m != imModeInclude && m != imModeExclude {
			return nil, apiErr(errValidation, "im.relevance_mode 只能是 include（只要）或 exclude（除了）")
		}
		in.RelevanceMode = &m
	}
	if b.Order != nil && string(*b.Order) != "null" {
		var n float64
		if err := json.Unmarshal(*b.Order, &n); err != nil || n != float64(int(n)) || n < 1 {
			return nil, apiErr(errValidation, "im.order 要是从 1 起的整数（在 IM 流程里排第几）")
		}
		o := int(n)
		in.Order = &o
	}
	return in, nil
}

// applyIM 把给了的几项写进 t。
func (in *imIn) applyIM(t *IMTrigger) {
	if in.Conversations != nil {
		t.Conversations = *in.Conversations
	}
	if in.Relevance != nil {
		t.Relevance = *in.Relevance
	}
	if in.RelevanceMode != nil {
		t.RelevanceMode = *in.RelevanceMode
	}
	if in.ThreadRelated != nil {
		t.ThreadRelated = *in.ThreadRelated
	}
	if in.Stop != nil {
		t.Stop = *in.Stop
	}
	normIM(t)
}

// resolveConversations 把会话的各种写法换成 cv_ id，去重、保持给的顺序。
func resolveConversations(ctx context.Context, c plugin.Core, refs []string) ([]string, error) {
	out := []string{}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		id, err := resolveConversation(ctx, c, ref)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	if len(out) > maxIMConversations {
		return nil, apiErr(errValidation, "im.conversations 最多选 %d 个会话", maxIMConversations)
	}
	return out, nil
}

func resolveConversation(ctx context.Context, c plugin.Core, ref string) (string, error) {
	conv := c.Conversations()
	if strings.HasPrefix(ref, "cv_") {
		info, err := conv.Get(ctx, ref)
		if errors.Is(err, plugin.ErrNoRows) {
			return "", apiErr(errValidation, "会话 %s 不存在", ref)
		}
		if err != nil {
			return "", err
		}
		return info.ID, nil
	}
	if ch, ext, ok := strings.Cut(ref, ":"); ok && !strings.Contains(ch, " ") {
		if info, err := conv.Find(ctx, ch, ext); err == nil {
			return info.ID, nil
		} else if !errors.Is(err, plugin.ErrNoRows) {
			return "", err
		}
	}
	list, err := conv.Match(ctx, ref)
	if err != nil {
		return "", err
	}
	switch len(list) {
	case 0:
		return "", apiErr(errValidation, "找不到会话 %s：填会话 id（cv_ 开头）、渠道里的会话编号（如 Slack 的 C0…）或会话名", ref)
	case 1:
		return list[0].ID, nil
	}
	names := make([]string, len(list))
	for i, x := range list {
		names[i] = fmt.Sprintf("%s（%s %s %s）", x.ID, x.Channel, x.ExternalID, x.Name)
	}
	return "", apiErr(errValidation, "会话 %s 对上了 %d 个：%s，改填其中一个的 cv_ id", ref, len(list), strings.Join(names, "、"))
}

// imRankSQL 是流程在 IM 流程里排第几（1 起），触发方式不是 im 为 0。外层表不起别名，直接用 sop_flows。
const imRankSQL = `CASE WHEN sop_flows.trigger_desc = 'im' THEN (SELECT COUNT(*) FROM sop_flows o WHERE o.trigger_desc = 'im' AND
	(o.im_order < sop_flows.im_order OR (o.im_order = sop_flows.im_order AND
	(o.created_at < sop_flows.created_at OR (o.created_at = sop_flows.created_at AND o.rowid <= sop_flows.rowid))))) ELSE 0 END`

// imOrderBy 是 IM 流程的执行顺序。
const imOrderBy = `ORDER BY im_order, created_at, rowid`

// nextIMOrder 是排在最后要用的 im_order。
const nextIMOrder = `(SELECT COALESCE(MAX(im_order), 0) + 1 FROM sop_flows)`

// placeIM 在流程写进库之后定它在 IM 流程里的位置：prev 是改之前的触发方式（新建为空）。
// 触发方式是 im：给了 order 插到那个位置、其余顺延（全部重新编号）；没给、刚改成 im 的排最后；没给、本来就是 im 的不动。
// 不是 im 时什么都不做（新建时 INSERT 已经排在最后）。
func placeIM(ctx context.Context, c plugin.Core, f Flow, prev string, order *int) error {
	if f.Trigger != imTrigger {
		return nil
	}
	if order == nil {
		if prev == imTrigger {
			return nil
		}
		_, err := c.Store().Exec(ctx, `UPDATE sop_flows SET im_order = `+nextIMOrder+` WHERE id = ?`, f.ID)
		return err
	}
	rows, err := c.Store().Query(ctx, `SELECT id FROM sop_flows WHERE trigger_desc = ? AND id != ? `+imOrderBy, imTrigger, f.ID)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	at := min(*order-1, len(ids))
	ids = slices.Insert(ids, at, f.ID)
	for i, id := range ids {
		if _, err := c.Store().Exec(ctx, `UPDATE sop_flows SET im_order = ? WHERE id = ?`, i+1, id); err != nil {
			return err
		}
	}
	return nil
}

// imDescribe 是给人和模型看的一句 IM 触发设置，会话带名字和渠道编号；不是 im 触发为空串。
func imDescribe(ctx context.Context, c plugin.Core, f Flow) string {
	if f.Trigger != imTrigger {
		return ""
	}
	t := f.IM
	var parts []string
	if len(t.Conversations) == 0 {
		parts = append(parts, "全部会话")
	} else {
		names := make([]string, 0, len(t.Conversations))
		for _, id := range t.Conversations {
			info, err := c.Conversations().Get(ctx, id)
			if err != nil {
				names = append(names, id+"（已删除）")
				continue
			}
			n := info.Name
			if n == "" {
				n = info.ExternalID
			}
			names = append(names, fmt.Sprintf("%s（%s %s，%s）", n, info.Channel, info.ExternalID, info.ID))
		}
		parts = append(parts, "会话 "+strings.Join(names, "、"))
	}
	if len(t.Relevance) > 0 {
		labels := make([]string, len(t.Relevance))
		for i, r := range t.Relevance {
			labels[i] = imRelLabel(r)
		}
		verb := "只要"
		if t.RelevanceMode == imModeExclude {
			verb = "排除"
		}
		parts = append(parts, verb+" "+strings.Join(labels, "、"))
		if t.ThreadRelated {
			parts = append(parts, "相关消息列里的回复按 @我 算")
		}
	}
	parts = append(parts, fmt.Sprintf("第 %d 个判断", t.Order))
	if t.Stop {
		parts = append(parts, "命中后不再触发后面的 IM 流程")
	}
	return strings.Join(parts, "；")
}

func imRelLabel(r string) string {
	switch r {
	case "me":
		return "@我"
	case "all":
		return "@所有人"
	case "dm":
		return "私聊"
	case imRelNone:
		return "无关"
	}
	return r
}
