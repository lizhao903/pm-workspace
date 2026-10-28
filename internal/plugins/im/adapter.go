package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// 适配器（IM-01a）：一个渠道一个，把渠道里的消息翻成 Incoming，落库、认人、发事件由插件统一做。
// 两种接法：Puller 由插件的后台任务按间隔拉；Receiver 由渠道回调 POST /api/im/callbacks/{key} 推进来，
// 验签（Slack signing secret、Telegram secret token）是适配器自己的事。一个适配器可以两种都实现。

const defaultPullEvery = 30 * time.Second

var keyRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// Adapter 是所有适配器都有的两项。
type Adapter interface {
	// Key 本插件内唯一，回调路径和拉取进度用它，例 slack、telegram。
	Key() string
	// Channel 是渠道 key，和 IM 身份、会话的 channel 同一套。
	Channel() string
}

// Puller 是拉取型：Pull 拿上次的进度，返回这一批和新进度；进度在整批落库后才存。
type Puller interface {
	Adapter
	Interval() time.Duration // 0 取 30 秒
	Pull(ctx context.Context, cursor string) (msgs []Incoming, next string, err error)
}

// Receiver 是回调型：解析一次回调请求里的消息。返回错误时回 400，什么都不落库。
type Receiver interface {
	Adapter
	Receive(r *http.Request) ([]Incoming, error)
}

// Replier 是可选接口：能往渠道里回消息（IM-02a）。没实现的适配器回复时回 409 unsupported。
// 返回渠道里新消息的编号；出错时插件把原因记在消息上，不重试。
type Replier interface {
	Adapter
	Reply(ctx context.Context, out Outgoing) (externalID string, err error)
}

// Outgoing 是一条回复，编号都是渠道里的。
type Outgoing struct {
	ConnectorID      string `json:"connector_id"`
	ConversationID   string `json:"conversation_id"` // 渠道里的会话编号；私聊没有编号时为空，按 RecipientID 发
	ConversationKind string `json:"conversation_kind"`
	RecipientID      string `json:"recipient_id"` // 原消息的发送人
	ReplyTo          string `json:"reply_to"`     // 原消息的编号，渠道支持串回复时用
	Text             string `json:"text"`
}

// Handles 是可选接口：「我」在这个渠道里的称呼，正文里 @ 到它算 @我。
// 没实现的适配器只认 @所有人和私聊；称呼从连接器账号取归 IM-03。
type Handles interface {
	Handles() []string
}

// Incoming 是适配器交给插件的一条消息，字段对照原型 IncomingMessage，会话和发送人用渠道里的编号。
type Incoming struct {
	ExternalID  string `json:"external_id"`  // 渠道里的消息编号，同一渠道唯一，必填
	ConnectorID string `json:"connector_id"` // 收这条消息的连接器，可空
	// ConversationID 是渠道里的会话编号（Slack channel id、Telegram chat id）；私聊也有编号时照填
	ConversationID   string    `json:"conversation_id"`
	ConversationKind string    `json:"conversation_kind"` // group 或 direct；空时按有没有群名猜，会话认上后以会话为准
	ConversationName string    `json:"conversation_name"`
	SenderID         string    `json:"sender_id"` // 发送人在渠道里的编号，必填
	SenderName       string    `json:"sender_name"`
	Text             string    `json:"text"`
	At               time.Time `json:"at"` // 发送时间，零值取到达时间
	// Mention 是渠道明确告诉的提及：me 或 all（Slack 的 <@U..>、<!channel>）；空时按正文里的 @ 判断
	Mention     string          `json:"mention"`
	Attachments json.RawMessage `json:"attachments"` // 原型 MsgAttachment 数组，原样存
}

// Fake 是测试和演练用的假适配器，不联网：Push 进队列等拉取，也接回调 {"messages":[Incoming...]}。
type Fake struct {
	key, channel string
	every        time.Duration
	self         []string

	mu      sync.Mutex
	queue   []Incoming
	pulls   int
	sent    []Outgoing
	failMsg string
}

// NewFake 建一个假适配器；every 是拉取间隔，self 是「我」的称呼。
func NewFake(key, channel string, every time.Duration, self ...string) *Fake {
	return &Fake{key: key, channel: channel, every: every, self: self}
}

func (f *Fake) Key() string             { return f.key }
func (f *Fake) Channel() string         { return f.channel }
func (f *Fake) Interval() time.Duration { return f.every }
func (f *Fake) Handles() []string       { return f.self }

// Push 放几条消息，下一次拉取时取走。
func (f *Fake) Push(msgs ...Incoming) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queue = append(f.queue, msgs...)
}

// Pulls 是拉过几次，测试用。
func (f *Fake) Pulls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pulls
}

// Pull 取走队列；进度是累计取走的条数。
func (f *Fake) Pull(_ context.Context, cursor string) ([]Incoming, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls++
	out := f.queue
	f.queue = nil
	n := 0
	if cursor != "" {
		_ = json.Unmarshal([]byte(cursor), &n)
	}
	b, _ := json.Marshal(n + len(out))
	return out, string(b), nil
}

func (f *Fake) Receive(r *http.Request) ([]Incoming, error) {
	var body struct {
		Messages []Incoming `json:"messages"`
	}
	if err := decode(r, &body, 1<<20); err != nil {
		return nil, err
	}
	return body.Messages, nil
}

// Reply 记下回复；FailReplies 设了原因时照原因失败。
func (f *Fake) Reply(_ context.Context, out Outgoing) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failMsg != "" {
		return "", errors.New(f.failMsg)
	}
	f.sent = append(f.sent, out)
	return fmt.Sprintf("%s:reply%d", out.ConversationID, len(f.sent)), nil
}

// FailReplies 让之后的回复按 reason 失败，传空串恢复。测试用。
func (f *Fake) FailReplies(reason string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failMsg = reason
}

// Sent 是发出去的回复，测试用。
func (f *Fake) Sent() []Outgoing {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Outgoing(nil), f.sent...)
}
