package im

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Telegram 渠道（IM-01c）：只做 Bot API，不做用户账号（有封号风险，web-next/docs/dev-plan.md 6 节）。
// 连接器定义由本插件登记（tool telegram），Bot Token 存在连接器的保险箱条目里，调用时经 Core.Connectors().With 现取。
// 默认 getUpdates 长轮询，offset 存在 im_cursors（连同实例 id、Bot id），整批落库后才写，重启不重复；
// 填了公网地址时测试连接会 setWebhook，改由 Telegram 推到 POST /api/im/callbacks/telegram，带 secret_token 校验。
// 出网走 Core.HTTP("im")，域名清单里只有 api.telegram.org。回复走 sendMessage，附件经 getFile 下载。

// TelegramTool 是连接器 tool，也是适配器 key 和渠道 key。
const TelegramTool = "telegram"

const (
	telegramAPI       = "https://api.telegram.org"
	telegramPollEvery = time.Second      // 两次长轮询之间至少隔这么久
	telegramLongPoll  = 5 * time.Second  // getUpdates 的 timeout；立即同步要排在它后面，所以不设太长
	telegramBackoff   = 30 * time.Second // 失败后后台多久再试；立即同步不受限
	telegramRecordGap = time.Minute      // 没收到消息时多久记一次同步时间
	telegramMaxFile   = 20 << 20         // Bot API 只能下载 20MB 以内的文件
	telegramSecretHdr = "X-Telegram-Bot-Api-Secret-Token"
)

var telegramTokenRe = regexp.MustCompile(`^([0-9]{3,20}):[A-Za-z0-9_-]{20,100}$`)

// Telegram 是 Telegram Bot 适配器，cmd/pmw 交给 New。一个连接器实例一个 Bot（一个工具只接一个账号）。
type Telegram struct {
	c        plugin.Core
	poll     time.Duration
	every    time.Duration
	callback string // 回调路径，setWebhook 时接在公网地址后面

	mu         sync.Mutex
	failedAt   time.Time
	recordedAt time.Time // 最近一次记成功的时间：后台拉没新消息、状态正常时一分钟记一次就够
	background bool      // Due 放行的这一轮是后台拉；立即同步每次都记
}

// NewTelegram 建 Telegram 适配器。
func NewTelegram() *Telegram {
	return &Telegram{poll: telegramLongPoll, every: telegramPollEvery, callback: "/api/im/callbacks/" + TelegramTool}
}

func (t *Telegram) Key() string        { return TelegramTool }
func (t *Telegram) Channel() string    { return TelegramTool }
func (t *Telegram) Bind(c plugin.Core) { t.c = c }

func (t *Telegram) ConnectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: TelegramTool, Label: "Telegram", Category: "im", Color: "#229ED9",
		Desc:    "Telegram Bot：收 Bot 所在群和私聊里的消息，能回复。只接 Bot，不接个人账号",
		CanSend: true, Auth: []connector.AuthMode{connector.AuthToken},
		Fields: []connector.Field{
			{Key: "bot_token", Label: "Bot Token", Kind: "secret", Placeholder: "123456789:AA…（BotFather 给的）", Required: true},
			{Key: "webhook_url", Label: "公网地址（可选，填了改用 webhook）", Kind: "text", Placeholder: "https://bro.vip"},
		},
		Test: t.test,
	}
}

// --- Bot API ---

// tgError 是 Telegram 回的 ok=false。
type tgError struct {
	Code int
	Desc string
}

func (e *tgError) Error() string {
	msg := fmt.Sprintf("Telegram 返回 %d：%s", e.Code, e.Desc)
	switch e.Code {
	case http.StatusUnauthorized, http.StatusNotFound:
		msg += "（Bot Token 无效或已被重置，去 BotFather 重新拿一个填上）"
	case http.StatusConflict:
		msg += "（同一个 Bot 只能有一处在收消息：别的程序在 getUpdates，或者设了 webhook）"
	}
	return msg
}

func (t *Telegram) client() (*http.Client, error) {
	if t.c == nil {
		return nil, errors.New("IM 插件还没启用")
	}
	return t.c.HTTP("im")
}

// netErr 把出网错误换成不带地址的说明：地址里有 Bot Token。
func netErr(err error) error {
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return errors.New("插件 im 的 network:im 不允许访问这个地址")
	}
	var ne *plugin.NotGrantedError
	if errors.As(err, &ne) {
		return ne
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return fmt.Errorf("连不上 Telegram：%v", err)
}

// call 调一个 Bot API 方法，params 发 JSON，result 解进 out。
func (t *Telegram) call(ctx context.Context, token, method string, params, out any) error {
	hc, err := t.client()
	if err != nil {
		return err
	}
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, telegramAPI+"/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return errors.New("Bot Token 格式不对")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return netErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return netErr(err)
	}
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return &tgError{Code: resp.StatusCode, Desc: "回的不是 JSON"}
	}
	if !env.OK {
		code := env.ErrorCode
		if code == 0 {
			code = resp.StatusCode
		}
		return &tgError{Code: code, Desc: clip(env.Description, 200)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("Telegram %s 的结果解析不了：%v", method, err)
	}
	return nil
}

type tgUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

type tgChat struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"` // private / group / supergroup / channel
	Title     string `json:"title"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type tgFile struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	FileName     string `json:"file_name"`
	MimeType     string `json:"mime_type"`
	FileSize     int64  `json:"file_size"`
	FilePath     string `json:"file_path"`
}

type tgMessage struct {
	MessageID  int64      `json:"message_id"`
	From       *tgUser    `json:"from"`
	SenderChat *tgChat    `json:"sender_chat"`
	Chat       tgChat     `json:"chat"`
	Date       int64      `json:"date"`
	Text       string     `json:"text"`
	Caption    string     `json:"caption"`
	ReplyTo    *tgMessage `json:"reply_to_message"`
	Photo      []tgFile   `json:"photo"`
	Document   *tgFile    `json:"document"`
	Video      *tgFile    `json:"video"`
	Audio      *tgFile    `json:"audio"`
	Voice      *tgFile    `json:"voice"`
}

type tgUpdate struct {
	UpdateID    int64      `json:"update_id"`
	Message     *tgMessage `json:"message"`
	ChannelPost *tgMessage `json:"channel_post"`
}

var tgAllowedUpdates = []string{"message", "channel_post"}

func joinName(first, last string) string { return strings.TrimSpace(first + " " + last) }

// botID 是 Token 冒号前的数字，就是 Bot 自己的用户 id。
func botID(token string) string {
	if m := telegramTokenRe.FindStringSubmatch(token); m != nil {
		return m[1]
	}
	return ""
}

// webhookSecret 由 Token 派生，setWebhook 时交给 Telegram，回调时比对请求头；换 Token 后自然失效。
func webhookSecret(token string) string {
	sum := sha256.Sum256([]byte("pmw-telegram-webhook\x00" + token))
	return hex.EncodeToString(sum[:24])
}

// toIncoming 把一条更新翻成 Incoming；服务消息（进群、改群名等）没有正文和附件，跳过。
func toIncoming(connectorID, bot string, u tgUpdate) (Incoming, bool) {
	m := u.Message
	if m == nil {
		m = u.ChannelPost
	}
	if m == nil {
		return Incoming{}, false
	}
	in := Incoming{
		ExternalID:     fmt.Sprintf("%d:%d", m.Chat.ID, m.MessageID),
		ConnectorID:    connectorID,
		ConversationID: strconv.FormatInt(m.Chat.ID, 10),
		Text:           m.Text,
	}
	if in.Text == "" {
		in.Text = m.Caption
	}
	if m.Date > 0 {
		in.At = time.Unix(m.Date, 0).UTC()
	}
	if m.Chat.Type == "private" {
		in.ConversationKind = "direct"
	} else {
		in.ConversationKind = "group"
		in.ConversationName = m.Chat.Title
		if in.ConversationName == "" && m.Chat.Username != "" {
			in.ConversationName = "@" + m.Chat.Username
		}
	}
	// 发送人：IM 身份里 Telegram 记的是用户名，有用户名用用户名，没有用数字 id
	switch {
	case m.From != nil:
		if bot != "" && strconv.FormatInt(m.From.ID, 10) == bot {
			return Incoming{}, false
		}
		in.SenderID = m.From.Username
		if in.SenderID == "" {
			in.SenderID = strconv.FormatInt(m.From.ID, 10)
		}
		in.SenderName = joinName(m.From.FirstName, m.From.LastName)
	case m.SenderChat != nil:
		in.SenderID = m.SenderChat.Username
		if in.SenderID == "" {
			in.SenderID = strconv.FormatInt(m.SenderChat.ID, 10)
		}
		in.SenderName = m.SenderChat.Title
	default:
		return Incoming{}, false
	}
	// 回复 Bot 发的消息算 @我；正文里的 @用户名 由连接器账号认
	if r := m.ReplyTo; r != nil && r.From != nil && bot != "" && strconv.FormatInt(r.From.ID, 10) == bot {
		in.Mention = "me"
	}
	atts := tgAttachments(m)
	if in.Text == "" && len(atts) == 0 {
		return Incoming{}, false
	}
	if len(atts) > 0 {
		in.Attachments, _ = json.Marshal(atts)
	}
	return in, true
}

// tgAttachments 是消息里的文件，file_id 照留，下载时用。图片只取最大的那张。
func tgAttachments(m *tgMessage) []map[string]any {
	out := []map[string]any{}
	add := func(f *tgFile, kind, name string) {
		if f == nil || f.FileID == "" {
			return
		}
		if f.FileName != "" {
			name = f.FileName
		}
		a := map[string]any{"id": f.FileUniqueID, "name": name, "kind": kind, "size": f.FileSize, "file_id": f.FileID}
		if f.MimeType != "" {
			a["mime_type"] = f.MimeType
		}
		out = append(out, a)
	}
	if n := len(m.Photo); n > 0 {
		best := m.Photo[0]
		for _, p := range m.Photo[1:] {
			if p.FileSize > best.FileSize {
				best = p
			}
		}
		add(&best, "image", "photo.jpg")
	}
	add(m.Document, "file", "document")
	add(m.Video, "file", "video.mp4")
	add(m.Audio, "file", "audio")
	add(m.Voice, "file", "voice.ogg")
	return out
}

// --- 连通测试 ---

// test 是连接器的连通测试：getMe 拿 Bot 的名字和用户名，账号写成「名字（@用户名）」，正文里 @用户名 算 @我。
// 填了公网地址时顺带 setWebhook；没填时如果 Bot 还挂着 webhook 就删掉，回到 getUpdates。
func (t *Telegram) test(ctx context.Context, cfg connector.Config) (string, error) {
	token := cfg.Secret("bot_token")
	if token == "" {
		return "", errors.New("还没填 Bot Token")
	}
	if botID(token) == "" {
		return "", errors.New("Bot Token 格式不对，应形如 123456789:AA…，从 BotFather 复制完整的一串")
	}
	var me tgUser
	if err := t.call(ctx, token, "getMe", map[string]any{}, &me); err != nil {
		return "", err
	}
	if !me.IsBot {
		return "", errors.New("这个 Token 对应的不是 Bot")
	}
	if err := t.setupDelivery(ctx, token, cfg.Get("webhook_url")); err != nil {
		return "", err
	}
	name := me.FirstName
	if name == "" {
		name = me.Username
	}
	return fmt.Sprintf("%s（@%s）", name, me.Username), nil
}

func (t *Telegram) setupDelivery(ctx context.Context, token, base string) error {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		var info struct {
			URL string `json:"url"`
		}
		if err := t.call(ctx, token, "getWebhookInfo", map[string]any{}, &info); err != nil {
			return err
		}
		if info.URL == "" {
			return nil
		}
		return t.call(ctx, token, "deleteWebhook", map[string]any{"drop_pending_updates": false}, nil)
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return errors.New("公网地址要是 https://域名，不带路径，Telegram 只推 https")
	}
	return t.call(ctx, token, "setWebhook", map[string]any{
		"url": base + t.callback, "secret_token": webhookSecret(token), "allowed_updates": tgAllowedUpdates,
	}, nil)
}

// --- 拉取 ---

// tgCursor 是存在 im_cursors 里的进度：哪个实例、哪个 Bot、下一个 offset。实例或 Bot 换了从头拉。
type tgCursor struct {
	Connector string `json:"connector"`
	Bot       string `json:"bot"`
	Offset    int64  `json:"offset"`
}

func (t *Telegram) Interval() time.Duration { return t.every }

// Due 是后台这一轮拉不拉：上次失败后退避一会儿，免得令牌失效时一直打对方；立即同步不问它。
func (t *Telegram) Due(_ context.Context, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.background = t.failedAt.IsZero() || now.Sub(t.failedAt) >= telegramBackoff
	return t.background
}

// Pull 长轮询一次 getUpdates。只有一个实例（一个工具只接一个账号）；暂停、断开、走 webhook 的不拉。
// 拉完把结果回报给连接器：失败（Token 失效回 401 等）实例置为异常并写原因。
func (t *Telegram) Pull(ctx context.Context, cursor string) ([]Incoming, string, error) {
	if t.c == nil {
		return nil, cursor, nil
	}
	list, err := t.c.Connectors().List(ctx, TelegramTool)
	if err != nil {
		return nil, cursor, err
	}
	if len(list) == 0 || list[0].Status == "paused" || list[0].Status == "disconnected" {
		return nil, cursor, nil
	}
	cn := list[0]
	var cur tgCursor
	_ = json.Unmarshal([]byte(cursor), &cur)
	var msgs []Incoming
	next := cursor
	webhook := false
	err = t.c.Connectors().With(ctx, cn.ID, func(cfg connector.Config) error {
		token := cfg.Secret("bot_token")
		if token == "" {
			return errors.New("还没填 Bot Token")
		}
		if strings.TrimSpace(cfg.Get("webhook_url")) != "" {
			webhook = true
			return nil
		}
		bot := botID(token)
		if bot == "" {
			return errors.New("Bot Token 格式不对，应形如 123456789:AA…")
		}
		if cur.Connector != cn.ID || cur.Bot != bot {
			cur = tgCursor{Connector: cn.ID, Bot: bot}
		}
		params := map[string]any{"timeout": int(t.poll / time.Second), "allowed_updates": tgAllowedUpdates}
		if cur.Offset > 0 {
			params["offset"] = cur.Offset
		}
		cctx, cancel := context.WithTimeout(ctx, t.poll+15*time.Second)
		defer cancel()
		var ups []tgUpdate
		if err := t.call(cctx, token, "getUpdates", params, &ups); err != nil {
			return err
		}
		for _, u := range ups {
			if u.UpdateID >= cur.Offset {
				cur.Offset = u.UpdateID + 1
			}
			if m, ok := toIncoming(cn.ID, bot, u); ok {
				msgs = append(msgs, m)
			}
		}
		b, _ := json.Marshal(cur)
		next = string(b)
		return nil
	})
	if ctx.Err() != nil {
		return nil, cursor, ctx.Err()
	}
	if errors.Is(err, plugin.ErrNoRows) || webhook {
		return nil, cursor, nil
	}
	now := time.Now()
	t.mu.Lock()
	record := !t.background || err != nil || len(msgs) > 0 || cn.Status != "connected" || now.Sub(t.recordedAt) >= telegramRecordGap
	t.background = false
	if err != nil {
		t.failedAt, t.recordedAt = now, time.Time{}
	} else {
		t.failedAt = time.Time{}
		if record {
			t.recordedAt = now
		}
	}
	t.mu.Unlock()
	if record {
		if _, rerr := t.c.Connectors().RecordSync(ctx, cn.ID, err); rerr != nil && err == nil {
			err = rerr
		}
	}
	if err != nil {
		return nil, cursor, err
	}
	return msgs, next, nil
}

// --- 回调（webhook） ---

// Receive 收 Telegram 推来的一条更新。只有一个 Telegram 实例（一个工具只接一个账号）；
// 请求头的 secret_token 和 Token 派生的不一致回 401，实例没填公网地址（不该收到推送）也回 401。
func (t *Telegram) Receive(r *http.Request) ([]Incoming, error) {
	if t.c == nil {
		return nil, errors.New("IM 插件还没启用")
	}
	ctx := r.Context()
	list, err := t.c.Connectors().List(ctx, TelegramTool)
	if err != nil {
		return nil, err
	}
	unauthorized := Unauthorized("secret token 不对")
	if len(list) == 0 {
		return nil, unauthorized
	}
	cn := list[0]
	var bot string
	err = t.c.Connectors().With(ctx, cn.ID, func(cfg connector.Config) error {
		token := cfg.Secret("bot_token")
		got := r.Header.Get(telegramSecretHdr)
		if token == "" || strings.TrimSpace(cfg.Get("webhook_url")) == "" ||
			subtle.ConstantTimeCompare([]byte(got), []byte(webhookSecret(token))) != 1 {
			return unauthorized
		}
		bot = botID(token)
		return nil
	})
	if err != nil {
		var cr *CallbackReply
		if errors.As(err, &cr) {
			return nil, cr
		}
		// 暂停、断开时回 200 不落库，免得 Telegram 一直重推
		return nil, &CallbackReply{Status: http.StatusOK, Body: map[string]any{"data": map[string]any{"ids": []string{}, "duplicates": 0}}}
	}
	var u tgUpdate
	if err := decode(r, &u, 1<<20); err != nil {
		return nil, err
	}
	m, ok := toIncoming(cn.ID, bot, u)
	if !ok {
		return []Incoming{}, nil
	}
	return []Incoming{m}, nil
}

// --- 回复 ---

// Reply 经 sendMessage 发到原消息所在的会话，能串上原消息时串上。
func (t *Telegram) Reply(ctx context.Context, out Outgoing) (string, error) {
	chat := out.ConversationID
	if chat == "" {
		chat = out.RecipientID
	}
	if out.ConnectorID == "" || chat == "" {
		return "", errors.New("不知道发到哪个 Telegram 会话")
	}
	params := map[string]any{"chat_id": chat, "text": out.Text}
	if _, mid, ok := strings.Cut(out.ReplyTo, ":"); ok {
		if n, err := strconv.ParseInt(mid, 10, 64); err == nil {
			params["reply_parameters"] = map[string]any{"message_id": n, "allow_sending_without_reply": true}
		}
	}
	var sent tgMessage
	err := t.c.Connectors().With(ctx, out.ConnectorID, func(cfg connector.Config) error {
		return t.call(ctx, cfg.Secret("bot_token"), "sendMessage", params, &sent)
	})
	if errors.Is(err, plugin.ErrNoRows) {
		return "", errors.New("渠道已删除")
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", sent.Chat.ID, sent.MessageID), nil
}

// --- 附件 ---

// Fetch 经 getFile 拿到文件路径再下载。Bot API 只给 20MB 以内的文件。
func (t *Telegram) Fetch(ctx context.Context, ref AttachmentRef) (io.ReadCloser, error) {
	var meta struct {
		FileID string `json:"file_id"`
	}
	_ = json.Unmarshal(ref.Raw, &meta)
	if meta.FileID == "" {
		return nil, errors.New("附件没有 file_id，取不了")
	}
	var body io.ReadCloser
	err := t.c.Connectors().With(ctx, ref.ConnectorID, func(cfg connector.Config) error {
		token := cfg.Secret("bot_token")
		var f tgFile
		if err := t.call(ctx, token, "getFile", map[string]any{"file_id": meta.FileID}, &f); err != nil {
			return err
		}
		if f.FileSize > telegramMaxFile {
			return errors.New("文件超过 20MB，Bot API 下载不了")
		}
		if f.FilePath == "" {
			return errors.New("Telegram 没给文件路径")
		}
		hc, err := t.client()
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, telegramAPI+"/file/bot"+token+"/"+f.FilePath, nil)
		if err != nil {
			return err
		}
		resp, err := hc.Do(req)
		if err != nil {
			return netErr(err)
		}
		if resp.StatusCode != http.StatusOK {
			_ = resp.Body.Close()
			return &tgError{Code: resp.StatusCode, Desc: "下载文件失败"}
		}
		body = resp.Body
		return nil
	})
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, errors.New("渠道已删除")
	}
	if err != nil {
		return nil, err
	}
	return body, nil
}
