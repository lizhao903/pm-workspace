package plugin

import (
	"context"
	"errors"

	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 登记 IM 会话（PR-02）：收消息时会话还没登记就登记上，项目绑定面板才能列出这个群。
// 只建不改：已有的会话原样返回，不动名字和成员；校验同 POST /api/conversations。

// maxConvName 同会话表的名字上限，消息里的群名更长时截断。
const maxConvName = 100

// NewConversation 是要登记的会话。群聊没有名字时用编号；Members 是 IM 身份 id，私聊放对方的身份。
type NewConversation struct {
	Channel    string
	ExternalID string
	Kind       string // group 或 direct
	Name       string
	Members    []string
}

// ConversationWriter 按渠道和编号登记会话；Created 为假表示已经有了。
type ConversationWriter interface {
	Ensure(ctx context.Context, in NewConversation) (info ConversationInfo, created bool, err error)
}

func (c *core) ConversationWriter() ConversationWriter { return conversationWriter{c} }

type conversationWriter struct{ c *core }

func (w conversationWriter) Ensure(ctx context.Context, in NewConversation) (ConversationInfo, bool, error) {
	d := w.c.db()
	if d == nil {
		return ConversationInfo{}, false, ErrNoStore
	}
	if info, err := w.c.Conversations().Find(ctx, in.Channel, in.ExternalID); err == nil {
		return info, false, nil
	} else if !errors.Is(err, ErrNoRows) {
		return ConversationInfo{}, false, err
	}
	name := []rune(in.Name)
	if len(name) == 0 && in.Kind == "group" {
		name = []rune(in.ExternalID)
	}
	if len(name) > maxConvName {
		name = name[:maxConvName]
	}
	cv, err := conversation.New(d).Create(ctx, conversation.Conversation{
		Channel: in.Channel, ExternalID: in.ExternalID, Kind: in.Kind, Name: string(name), Members: in.Members,
	})
	// 同时收到两条时另一条先建上了
	if errors.Is(err, domain.ErrConflict) {
		info, ferr := w.c.Conversations().Find(ctx, in.Channel, in.ExternalID)
		return info, false, ferr
	}
	if err != nil {
		return ConversationInfo{}, false, err
	}
	w.c.Log().Info("conversation registered", "conversation", cv.ID, "channel", cv.Channel, "kind", cv.Kind)
	return ConversationInfo{ID: cv.ID, Channel: cv.Channel, ExternalID: cv.ExternalID, Kind: cv.Kind, Name: cv.Name}, true, nil
}
