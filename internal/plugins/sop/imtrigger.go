package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 触发（SOP-05）：触发方式是 im 的流程，来一条新消息自动发起一次执行。订阅 IM 插件的 im.message_received，
// 输入是事件里的归类：message_id、channel、connector_id、conversation_id、stakeholder_id、relevance、at（没有的为空串），
// 正文不在事件里，流程里用 IM 插件的「读取消息」节点（im_get_message）按 message_id 取。
// 只发起发送时间在 imTriggerMaxAge 以内的：连接器第一次同步会带进每个会话最近的若干条历史，不该每条都跑一遍。
// 同一条流程、同一条消息只发起一次（按执行的输入里的 message_id 查）。必填字段补不齐的跳过，不报运行异常；
// 没发起的（过滤不符、被拦截、补不齐、发起出错）记进 sop_skips（TSK-0491，skips.go）。
// 按会话、与我的关系过滤，按执行顺序逐条判断，拦截流程命中后后面的不再发起（TSK-0481，口径见 imfilter.go）。

const (
	imTrigger       = "im"
	imReceivedEvent = "im.message_received"
	imTriggerMaxAge = 24 * time.Hour
)

// imReceived 是 im.message_received 的 payload，同 IM 插件的 Received。
type imReceived struct {
	MessageID      string  `json:"message_id"`
	Channel        string  `json:"channel"`
	ConnectorID    string  `json:"connector_id"`
	ConversationID *string `json:"conversation_id"`
	StakeholderID  *string `json:"stakeholder_id"`
	Relevance      string  `json:"relevance"`
	At             string  `json:"at"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// imTriggerNow 是判断消息新旧用的当前时间；测试里换掉。
var imTriggerNow = time.Now

func (s *starter) onIMMessage(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var m imReceived
	if err := json.Unmarshal(ev.Payload, &m); err != nil || strings.TrimSpace(m.MessageID) == "" {
		return nil
	}
	if at, err := time.Parse(time.RFC3339Nano, m.At); err == nil && imTriggerNow().Sub(at) > imTriggerMaxAge {
		return nil
	}
	// 按执行顺序（TSK-0481）：不符合过滤条件的不发起；命中并发起了的拦截流程截住后面的。
	// 没发起的都记一行原因（TSK-0491，skips.go），流程详情的「最近未发起」看得到
	list, err := imFlows(ctx, s.c)
	if err != nil {
		return err
	}
	base := Json{"message_id": m.MessageID, "channel": m.Channel, "connector_id": m.ConnectorID,
		"conversation_id": deref(m.ConversationID), "stakeholder_id": deref(m.StakeholderID), "relevance": m.Relevance, "at": m.At}
	info := imInfo(m)
	for i, f := range list {
		if why, detail := f.IM.filterMiss(m); why != "" {
			recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipFiltered, why, mergeInfo(info, detail))
			continue
		}
		var n int
		if err := s.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?`,
			f.ID, m.MessageID).Scan(&n); err != nil {
			return err
		}
		started := n > 0
		if !started {
			input, err := fillInput(f, base)
			if err != nil {
				_, msg, _ := cutKind(err)
				s.c.Log().Warn("sop im trigger skipped", "flow", f.ID, "message", m.MessageID, "err", err)
				recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipMissing, "输入"+msg+"，IM 消息没带上，补不齐",
					mergeInfo(info, map[string]any{"missing": missingFields(f, base)}))
				continue
			}
			run, err := s.e.create(ctx, f, input, false, origin{Source: SourceIM, SourceRef: m.MessageID})
			if err != nil {
				s.c.Log().Warn("sop im trigger failed", "flow", f.ID, "message", m.MessageID, "err", err)
				_, msg, _ := cutKind(err)
				recordSkip(ctx, s.c, f.ID, SourceIM, m.MessageID, skipStartFailed, "发起出错："+msg, info)
				continue
			}
			started = true
			s.c.Log().Info("sop run started", "run", run.ID, "flow", f.ID, "source", "im", "source_id", m.MessageID)
		}
		if started && f.IM.Stop {
			if rest := len(list) - i - 1; rest > 0 {
				s.c.Log().Info("sop im trigger stopped", "flow", f.ID, "message", m.MessageID, "skipped_flows", rest)
			}
			// 后面的流程过滤条件符合的记「被拦截」，不符合的本来也不会发起，记「过滤不符」
			for _, g := range list[i+1:] {
				if why, detail := g.IM.filterMiss(m); why != "" {
					recordSkip(ctx, s.c, g.ID, SourceIM, m.MessageID, skipFiltered, why, mergeInfo(info, detail))
					continue
				}
				recordSkip(ctx, s.c, g.ID, SourceIM, m.MessageID, skipStopped, fmt.Sprintf("被排在前面的「%s」拦截（它命中这条消息后不再交给后面的 IM 流程）", f.Name),
					mergeInfo(info, map[string]any{"by_flow_id": f.ID, "by_flow": f.Name}))
			}
			break
		}
	}
	return nil
}
