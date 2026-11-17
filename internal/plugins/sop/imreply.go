// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 我回复了消息（0.21.0）：触发方式是 im_reply 的流程，「我」回复了一条 IM 消息时自动发起一次执行。订阅 IM 插件 0.31.0 起发的
// im.message_replied：在工作台消息页回复发出去的、在渠道里本人回在消息列（串）里或私聊里的（群聊里不在串里发的 IM 插件不发）。
// 输入是被回复的那条消息的归类加 reply_id、via、reply_at（没有的为空串）；正文用「读取消息」（im_get_message）按 message_id 取。
// 只发起回复时间在 imTriggerMaxAge 以内的；同一条流程、同一条回复只发起一次（按执行的输入里的 reply_id 查）；
// 必填字段补不齐、发起出错的跳过并记进 sop_skips。没有 IM 触发那样的过滤条件、执行顺序与拦截：要筛就在流程里加条件分支。

const (
	imReplyTrigger = "im_reply"
	imRepliedEvent = "im.message_replied"
)

// imReplied 是 im.message_replied 的 payload，同 IM 插件的 Replied。
type imReplied struct {
	imReceived
	ReplyID string `json:"reply_id"`
	Via     string `json:"via"`
	ReplyAt string `json:"reply_at"`
}

func (s *starter) onIMReplied(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var m imReplied
	if err := json.Unmarshal(ev.Payload, &m); err != nil || strings.TrimSpace(m.MessageID) == "" || strings.TrimSpace(m.ReplyID) == "" {
		return nil
	}
	if at, err := time.Parse(time.RFC3339Nano, m.ReplyAt); err == nil && imTriggerNow().Sub(at) > imTriggerMaxAge {
		return nil
	}
	rows, err := s.c.Store().Query(ctx, `SELECT `+flowSel+` FROM sop_flows WHERE trigger_desc = ? ORDER BY created_at, id`, imReplyTrigger)
	if err != nil {
		return err
	}
	var list []Flow
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			_ = rows.Close()
			return err
		}
		list = append(list, f)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	base := Json{"message_id": m.MessageID, "reply_id": m.ReplyID, "via": m.Via, "reply_at": m.ReplyAt,
		"channel": m.Channel, "connector_id": m.ConnectorID, "conversation_id": deref(m.ConversationID),
		"stakeholder_id": deref(m.StakeholderID), "relevance": m.Relevance, "at": m.At}
	info := mergeInfo(imInfo(m.imReceived), map[string]any{"reply_id": m.ReplyID, "via": m.Via})
	for _, f := range list {
		var n int
		if err := s.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.reply_id') = ?`,
			f.ID, m.ReplyID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		input, err := fillInput(f, base)
		if err != nil {
			_, msg, _ := cutKind(err)
			s.c.Log().Warn("sop im reply trigger skipped", "flow", f.ID, "message", m.MessageID, "err", err)
			recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipMissing, "输入"+msg+"，回复事件没带上，补不齐",
				mergeInfo(info, map[string]any{"missing": missingFields(f, base)}))
			continue
		}
		run, err := s.e.create(ctx, f, input, false, origin{Source: SourceIM, SourceRef: m.MessageID})
		if err != nil {
			s.c.Log().Warn("sop im reply trigger failed", "flow", f.ID, "message", m.MessageID, "err", err)
			_, msg, _ := cutKind(err)
			recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipStartFailed, "发起出错："+msg, info)
			continue
		}
		s.c.Log().Info("sop run started", "run", run.ID, "flow", f.ID, "source", "im_reply", "source_id", m.MessageID, "reply", m.ReplyID)
	}
	return nil
}
