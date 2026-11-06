package sop

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 触发（SOP-05）：触发方式是 im 的流程，来一条新消息自动发起一次执行。订阅 IM 插件的 im.message_received，
// 输入是事件里的归类：message_id、channel、connector_id、conversation_id、stakeholder_id、relevance、at（没有的为空串），
// 正文不在事件里，流程里用 IM 插件的「读取消息」节点（im_get_message）按 message_id 取。
// 只发起发送时间在 imTriggerMaxAge 以内的：连接器第一次同步会带进每个会话最近的若干条历史，不该每条都跑一遍。
// 同一条流程、同一条消息只发起一次（按执行的输入里的 message_id 查）。必填字段补不齐的记一行日志跳过，不报运行异常。
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
	// 按执行顺序（TSK-0481）：不符合过滤条件的不发起、不留记录；命中并发起了的拦截流程截住后面的
	rows, err := s.c.Store().Query(ctx, `SELECT `+flowSel+` FROM sop_flows WHERE trigger_desc = ? `+imOrderBy, imTrigger)
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
	_ = rows.Close()
	base := Json{"message_id": m.MessageID, "channel": m.Channel, "connector_id": m.ConnectorID,
		"conversation_id": deref(m.ConversationID), "stakeholder_id": deref(m.StakeholderID), "relevance": m.Relevance, "at": m.At}
	for i, f := range list {
		if !f.IM.matches(m) {
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
				s.c.Log().Warn("sop im trigger skipped", "flow", f.ID, "message", m.MessageID, "err", err)
				continue
			}
			run, err := s.e.create(ctx, f, input, false, origin{Source: SourceIM, SourceRef: m.MessageID})
			if err != nil {
				s.c.Log().Warn("sop im trigger failed", "flow", f.ID, "message", m.MessageID, "err", err)
				continue
			}
			started = true
			s.c.Log().Info("sop run started", "run", run.ID, "flow", f.ID, "source", "im", "source_id", m.MessageID)
		}
		if started && f.IM.Stop {
			if rest := len(list) - i - 1; rest > 0 {
				s.c.Log().Info("sop im trigger stopped", "flow", f.ID, "message", m.MessageID, "skipped_flows", rest)
			}
			break
		}
	}
	return nil
}
