// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 自动触发没发起的记录（TSK-0491，插件迁移 0010_skips.sql）：IM 消息来了、定时到点了，流程却没有发起执行时记一行原因，
// 流程详情的「最近未发起」读 GET /api/sop/flows/{id}/skips。原来只写服务日志（sop im trigger skipped），界面上看不到为什么没跑。
//
// 原因（reason）：
//   - filtered：IM 过滤条件不符（会话不在里面、与我的关系不符）
//   - stopped：排在前面的 IM 流程命中并拦截了这条消息
//   - muted：发信人被设为自动忽略（TSK-0495），IM 插件落库即已忽略、不发 im.message_received，改发 im.message_muted
//   - missing：必填输入补不齐（IM 触发、定时触发都可能）
//   - start_failed：发起出错
//
// 不记的：消息超过 24 小时（连接器首次同步带进的历史）、同一条消息已经为这条流程发起过。
// 保留上限：每条流程 filtered 最多 100 行、其余原因合起来最多 200 行，超过 7 天的删掉，写入时顺手清。
// 调试（debug.go）、模拟 IM 触发（imexplain.go）不写这里。

const (
	skipFiltered    = "filtered"
	skipStopped     = "stopped"
	skipMuted       = "muted"
	skipMissing     = "missing"
	skipStartFailed = "start_failed"

	maxSkipsFiltered = 100
	maxSkipsOther    = 200
	skipKeep         = 7 * 24 * time.Hour
	maxSkipsList     = 200
)

// imMutedEvent 是 IM 插件对被自动忽略的消息发的事件（im 0.28.0），payload 同 im.message_received 加 mute_id、mute_name。
const imMutedEvent = "im.message_muted"

// Skip 是一条没发起的记录。
type Skip struct {
	ID        string         `json:"id"`
	FlowID    string         `json:"flow_id"`
	Source    string         `json:"source"`
	SourceRef string         `json:"source_ref"`
	Reason    string         `json:"reason"`
	Detail    string         `json:"detail"`
	Info      map[string]any `json:"info"`
	At        time.Time      `json:"at"`
}

// skipNow 是记录用的当前时间；测试里换掉。
var skipNow = now

// recordSkip 记一行并按上限清理。写不进只记日志，不影响触发。
func recordSkip(ctx context.Context, c plugin.Core, flowID, source, ref, reason, detail string, info map[string]any) {
	if info == nil {
		info = map[string]any{}
	}
	b, _ := json.Marshal(info)
	t := skipNow()
	st := c.Store()
	if _, err := st.Exec(ctx, `INSERT INTO sop_skips (id, flow_id, source, source_ref, reason, detail, info, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		idgen.Prefixed("spk"), flowID, source, ref, reason, detail, string(b), ts(t)); err != nil {
		c.Log().Warn("sop skip not recorded", "flow", flowID, "reason", reason, "err", err)
		return
	}
	// 同一条流程同一类（过滤不符 / 其余）超过上限的、超过保留期的删掉
	limit, cond := maxSkipsOther, `reason != 'filtered'`
	if reason == skipFiltered {
		limit, cond = maxSkipsFiltered, `reason = 'filtered'`
	}
	if _, err := st.Exec(ctx, `DELETE FROM sop_skips WHERE flow_id = ? AND `+cond+` AND id NOT IN
		(SELECT id FROM sop_skips WHERE flow_id = ? AND `+cond+` ORDER BY at DESC, rowid DESC LIMIT ?)`, flowID, flowID, limit); err != nil {
		c.Log().Warn("sop skips not pruned", "flow", flowID, "err", err)
	}
	if _, err := st.Exec(ctx, `DELETE FROM sop_skips WHERE at < ?`, ts(t.Add(-skipKeep))); err != nil {
		c.Log().Warn("sop skips not pruned", "err", err)
	}
}

// listSkips 是 GET /api/sop/flows/{id}/skips?limit=50&reason=：最近的在前；reason 可以逗号隔开几种，前面加 - 是排除。
// meta.total 是这条流程（按 reason 筛过）留着的总数，meta.reasons 是各原因的条数（不按 reason 筛）。
func (h *flows) listSkips(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.get(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	limit := 50
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxSkipsList {
			fail(w, r, h.c, apiErr(errValidation, "limit 要是 1 到 %d 的整数", maxSkipsList))
			return
		}
		limit = n
	}
	where, args := `flow_id = ?`, []any{id}
	if s := strings.TrimSpace(r.URL.Query().Get("reason")); s != "" {
		not := strings.HasPrefix(s, "-")
		var ph []string
		for _, x := range strings.Split(strings.TrimPrefix(s, "-"), ",") {
			x = strings.TrimSpace(x)
			if !validSkipReason(x) {
				fail(w, r, h.c, apiErr(errValidation, "reason 只能是 filtered、stopped、muted、missing、start_failed，不认 %s", x))
				return
			}
			ph = append(ph, "?")
			args = append(args, x)
		}
		op := "IN"
		if not {
			op = "NOT IN"
		}
		where += ` AND reason ` + op + ` (` + strings.Join(ph, ", ") + `)`
	}
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_skips WHERE `+where, args...).Scan(&total); err != nil {
		fail(w, r, h.c, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT id, flow_id, source, source_ref, reason, detail, info, at FROM sop_skips WHERE `+where+
		` ORDER BY at DESC, rowid DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out := []Skip{}
	for rows.Next() {
		var s Skip
		var info, at string
		if err := rows.Scan(&s.ID, &s.FlowID, &s.Source, &s.SourceRef, &s.Reason, &s.Detail, &info, &at); err != nil {
			_ = rows.Close()
			fail(w, r, h.c, err)
			return
		}
		_ = json.Unmarshal([]byte(info), &s.Info)
		if s.Info == nil {
			s.Info = map[string]any{}
		}
		if t := parseTS(&at); t != nil {
			s.At = *t
		}
		out = append(out, s)
	}
	_ = rows.Close()
	reasons := map[string]int{}
	cr, err := h.c.Store().Query(ctx, `SELECT reason, COUNT(*) FROM sop_skips WHERE flow_id = ? GROUP BY reason`, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	for cr.Next() {
		var k string
		var n int
		if err := cr.Scan(&k, &n); err != nil {
			_ = cr.Close()
			fail(w, r, h.c, err)
			return
		}
		reasons[k] = n
	}
	_ = cr.Close()
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"total": total, "reasons": reasons}})
}

func validSkipReason(s string) bool {
	switch s {
	case skipFiltered, skipStopped, skipMuted, skipMissing, skipStartFailed:
		return true
	}
	return false
}

// imInfo 是 IM 来源的记录里都带的：消息的归类。
func imInfo(m imReceived) map[string]any {
	return map[string]any{"channel": m.Channel, "conversation_id": deref(m.ConversationID), "relevance": m.Relevance, "at": m.At}
}

// filterMiss 是过滤条件哪一条不符，一句给人看的话和结构化的明细；符合回空串。
func (t IMTrigger) filterMiss(m imReceived) (string, map[string]any) {
	if len(t.Conversations) > 0 && !containsStr(t.Conversations, deref(m.ConversationID)) {
		got := deref(m.ConversationID)
		if got == "" {
			got = "（没认上会话）"
		}
		return fmt.Sprintf("会话 %s 不在过滤条件的 %d 个会话里", got, len(t.Conversations)),
			map[string]any{"check": "conversation", "want": t.Conversations, "got": deref(m.ConversationID)}
	}
	if len(t.Relevance) > 0 && !t.matches(imReceived{ConversationID: m.ConversationID, Relevance: m.Relevance}) {
		rel := m.Relevance
		if rel == "" {
			rel = imRelNone
		}
		labels := make([]string, len(t.Relevance))
		for i, r := range t.Relevance {
			labels[i] = imRelLabel(r)
		}
		verb := "只要"
		if t.RelevanceMode == imModeExclude {
			verb = "排除"
		}
		return fmt.Sprintf("与我的关系是「%s」，过滤条件%s %s", imRelLabel(rel), verb, strings.Join(labels, "、")),
			map[string]any{"check": "relevance", "want": t.Relevance, "mode": t.RelevanceMode, "got": rel}
	}
	return "", nil
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func mergeInfo(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

// imMuted 是 im.message_muted 的 payload。
type imMuted struct {
	imReceived
	MuteID   string `json:"mute_id"`
	MuteName string `json:"mute_name"`
}

// onIMMuted 记「发信人被自动忽略」：过滤条件符合的 IM 流程各记一行（不符合的本来也不会发起，不记）。
func (s *starter) onIMMuted(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var m imMuted
	if err := json.Unmarshal(ev.Payload, &m); err != nil || strings.TrimSpace(m.MessageID) == "" {
		return nil
	}
	if at, err := time.Parse(time.RFC3339Nano, m.At); err == nil && imTriggerNow().Sub(at) > imTriggerMaxAge {
		return nil
	}
	list, err := imFlows(ctx, s.c)
	if err != nil {
		return err
	}
	name := orDefault(m.MuteName, "这个发信人")
	for _, f := range list {
		if !f.IM.matches(m.imReceived) {
			continue
		}
		recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipMuted, fmt.Sprintf("发信人「%s」被设为自动忽略，消息落库即已忽略，IM 流程收不到", name),
			mergeInfo(imInfo(m.imReceived), map[string]any{"mute_id": m.MuteID, "mute_name": m.MuteName}))
	}
	return nil
}

// imFlows 是触发方式是 im 的流程，按执行顺序。
func imFlows(ctx context.Context, c plugin.Core) ([]Flow, error) {
	rows, err := c.Store().Query(ctx, `SELECT `+flowSel+` FROM sop_flows WHERE trigger_desc = ? `+imOrderBy, imTrigger)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var list []Flow
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	return list, rows.Err()
}
