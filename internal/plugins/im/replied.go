// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 我回复了消息（0.31.0）：「我」回复了一条消息时发 im.message_replied，SOP 的触发方式「我回复了消息」（im_reply）据此发起流程；
// 内置流程「我回复后标为已处理」把被回复的消息标为已处理。
//
// 算「我回复了」的：
//   - 在工作台消息页回复、发成功的（via=workbench）；SOP 节点代发的回复（回执需求方、回复原消息、通知）不算；
//   - 在渠道里本人回在消息列（串）里的（via=thread，Slack 本人身份拉回来的 from_self），被回复的是这个串里在它之前最近一条；
//   - 在渠道里本人在私聊里发的（via=dm），被回复的是这个私聊里在它之前最近一条。
// 群聊里不在串里发的只挂在会话最近一条上当记录，不一定是回它，不发；补全历史拉到的不发；同一条回复只发一次
// （工作台回复拉回来时认出是同一条，不再记、不再发）。

// ReplyVia* 是 im.message_replied 的 via。
const (
	ReplyViaWorkbench = "workbench"
	ReplyViaThread    = "thread"
	ReplyViaDM        = "dm"
)

// RepliedDoneFlowID 是内置流程「我回复后标为已处理」。
const RepliedDoneFlowID = "sop_im_replied_done"

// Replied 是 im.message_replied 的 payload：被回复的那条消息的归类（同 Received，at 是那条消息的发送时间），
// 加这条回复的 id、怎么回的、回复时间。
type Replied struct {
	Received
	ReplyID string `json:"reply_id"`
	Via     string `json:"via"`
	ReplyAt string `json:"reply_at"`
}

// publishReplied 发 im.message_replied。via 为空时按会话定：私聊记 dm，群聊不发（不在串里，认不准回的是哪条）。
// 取不到消息、发不出去只记日志，不影响回复本身。
func (in *inbox) publishReplied(ctx context.Context, msgID, replyID, via, at string) {
	m, err := in.get(ctx, msgID)
	if err != nil {
		in.c.Log().Warn("im replied event skipped", "message", msgID, "err", err)
		return
	}
	if via == "" {
		if m.ConversationKind != "direct" {
			return
		}
		via = ReplyViaDM
	}
	ev := Replied{Received: Received{MessageID: m.ID, Channel: m.Channel, ConnectorID: m.ConnectorID, ConversationID: m.ConversationID,
		IdentityID: m.IdentityID, StakeholderID: m.StakeholderID, Relevance: m.Relevance, At: m.At},
		ReplyID: replyID, Via: via, ReplyAt: at}
	if err := in.c.Events().Publish(ctx, EventReplied, ev); err != nil {
		in.c.Log().Warn("publish im event failed", "message", m.ID, "reply", replyID, "err", err)
	}
}

// repliedDoneFlow 是内置流程「我回复后标为已处理」：触发方式就是「我回复了消息」，装上即生效；不想要时把触发方式改成「手动」。
func repliedDoneFlow() plugin.SOPFlowTemplate {
	steps := []intakeStep{
		{Key: "mark", Name: "标为已处理", Kind: NodeMarkMessage, After: []string{},
			Desc:   "把我回复的那条消息标为已处理（同消息页的「标为已处理」）；已经处理过的照样是已处理",
			Config: map[string]string{"state": "done", "message": "{{message_id}}"}},
	}
	fields := []map[string]any{
		{"key": "message_id", "label": "IM 消息", "type": "text", "required": true, "placeholder": "被回复的消息 id；我回复时自动带上"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: RepliedDoneFlowID, Name: "我回复后标为已处理", Trigger: "im_reply", Fields: fb, Steps: sb,
		Desc: "我回复了一条 IM 消息就把它标为已处理：在消息页点回复发出去的，或在 Slack 里本人回在消息列（串）里、私聊里的都算；" +
			"群聊里不在串里发的不算。不想自动标时把触发方式改成「手动」",
	}
}
