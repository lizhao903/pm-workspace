package connector

// Slack 连接器（IM-01b）：Slack App 的 Bot Token（xoxb-）方式。定义由 IM 插件登记（tool 和渠道都是 slack），
// 收消息、回复、取附件在 IM 插件的 slack 适配器里；这里是定义、连通测试，以及两边共用的 Web API 调用和回调验签。

import (
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// SlackTool 是 Slack 连接器的 key，同原型 slack，也是 IM 渠道 key。
const SlackTool = "slack"

const (
	slackAPI     = "https://slack.com/api"
	maxSlackBody = 4 << 20
	// SlackSkew 是回调时间戳和本机时钟最多差多少，超了按重放拒绝（Slack 文档建议 5 分钟）
	SlackSkew = 5 * time.Minute
)

// SlackEndpoints 是调 Slack 用的地址和客户端。API 是 Web API 的根（不带末尾 /），空串取正式地址；
// Client 给连通测试取出网客户端（IM 插件传 Core.HTTP("im")，受域名清单管），nil 用 http.DefaultClient。
type SlackEndpoints struct {
	API    string
	Client func() (*http.Client, error)
}

// Base 是补上默认值后的 API 根。
func (e SlackEndpoints) Base() string {
	if e.API == "" {
		return slackAPI
	}
	return strings.TrimRight(e.API, "/")
}

// Slack 是 Slack 连接器的定义。字段照原型 web-next/src/data.ts 的 slack，另加「我的 Member ID」。
func Slack(e SlackEndpoints) Def {
	base := e.Base()
	return Def{
		Tool: SlackTool, Label: "Slack", Category: "im", Color: "#611f69",
		Desc: "Slack App 的 Bot Token，收私信和指定频道的消息，能回复", CanSend: true, Auth: []AuthMode{AuthToken},
		Fields: []Field{
			{Key: "bot_token", Label: "Bot Token", Kind: "secret", Placeholder: "xoxb-", Required: true},
			{Key: "signing_secret", Label: "Signing Secret", Kind: "secret", Placeholder: "用事件订阅（Events API）回调时必填"},
			{Key: "channels", Label: "监听频道", Kind: "text", Placeholder: "#product, #feedback，逗号分隔；留空 = 只收私信"},
			{Key: "self_user_id", Label: "我的 Member ID", Kind: "text", Placeholder: "U 开头；@ 到它算 @我，留空只认 @Bot"},
		},
		Test: func(ctx context.Context, cfg Config) (string, error) {
			c := http.DefaultClient
			if e.Client != nil {
				var err error
				if c, err = e.Client(); err != nil {
					return "", err
				}
			}
			id, err := SlackAuthTest(ctx, c, base, cfg.Secret("bot_token"))
			if err != nil {
				return "", err
			}
			return id.Account(), nil
		},
	}
}

// SlackIdentity 是 auth.test 回的 Bot 身份。
type SlackIdentity struct {
	UserID string `json:"user_id"`
	BotID  string `json:"bot_id"`
	User   string `json:"user"`
	Team   string `json:"team"`
	TeamID string `json:"team_id"`
	URL    string `json:"url"`
}

// Account 是记到连接器上的账号：「Bot 名（Bot 的 Member ID）」，IM 插件按它认 @Bot。
func (id SlackIdentity) Account() string {
	if id.UserID == "" {
		return id.User
	}
	return fmt.Sprintf("%s（%s）", id.User, id.UserID)
}

// SlackError 是 Slack 回 ok=false 时的错误：Code 是 Slack 的错误码，如 invalid_auth、missing_scope。
type SlackError struct {
	Method string
	Code   string
	Needed string // missing_scope 时缺的 scope
}

func (e *SlackError) Error() string {
	switch {
	case e.Auth():
		return fmt.Sprintf("Slack 拒绝了 Bot Token（%s），Token 无效或已失效，重新填一个", e.Code)
	case e.Code == "missing_scope":
		return fmt.Sprintf("Slack App 缺少权限 scope：%s（%s），加上后重新安装到工作区", e.Needed, e.Method)
	case e.Code == "not_in_channel" || e.Code == "channel_not_found":
		return fmt.Sprintf("Bot 不在这个频道里或频道不存在（%s，%s），先把 Bot 加进频道", e.Code, e.Method)
	}
	return fmt.Sprintf("Slack %s 返回 %s", e.Method, e.Code)
}

var slackAuthCodes = []string{"invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"}

// Auth 是不是凭证本身的问题（Token 无效、被吊销、过期）。
func (e *SlackError) Auth() bool { return slices.Contains(slackAuthCodes, e.Code) }

// SlackAuthTest 用 Bot Token 调 auth.test，回 Bot 的身份；Token 不是 xoxb- 开头的直接失败，不调对方。
func SlackAuthTest(ctx context.Context, c *http.Client, base, token string) (SlackIdentity, error) {
	var id SlackIdentity
	switch {
	case token == "":
		return id, errors.New("还没填 Bot Token")
	case !strings.HasPrefix(token, "xoxb-"):
		return id, errors.New("Bot Token 要以 xoxb- 开头（Slack App 设置里 OAuth & Permissions 页的 Bot User OAuth Token）")
	}
	if err := SlackCall(ctx, c, base, token, "auth.test", nil, &id); err != nil {
		return id, err
	}
	if id.UserID == "" {
		return id, errors.New("auth.test 没有返回 Bot 的 user_id，确认填的是 Bot Token")
	}
	return id, nil
}

// SlackCall 带 Bot Token 以表单 POST 调一个 Web API 方法，ok 时把响应按 JSON 解进 out（可为 nil）。
// ok=false 回 *SlackError；限流（429）回带 Retry-After 的说明。错误里不带请求头和 Token。
func SlackCall(ctx context.Context, c *http.Client, base, token, method string, params url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/"+method, strings.NewReader(params.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("请求 Slack %s 失败：%w", method, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("Slack 限流（%s），%s 秒后再试", method, cmp.Or(resp.Header.Get("Retry-After"), "稍等几"))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Slack %s 返回 HTTP %d", method, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSlackBody))
	if err != nil {
		return fmt.Errorf("读 Slack %s 的响应失败：%w", method, err)
	}
	var head struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Needed string `json:"needed"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return fmt.Errorf("Slack %s 的响应不是 JSON", method)
	}
	if !head.OK {
		return &SlackError{Method: method, Code: cmp.Or(head.Error, "unknown_error"), Needed: head.Needed}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("解析 Slack %s 的响应失败：%w", method, err)
	}
	return nil
}

// SlackVerify 校验一次事件回调的签名：v0=HMAC-SHA256(signing secret, "v0:<时间戳>:<原文>")，
// 时间戳和 now 差超过 SlackSkew 的按重放拒绝。
func SlackVerify(secret, timestamp, signature string, body []byte, now time.Time) error {
	if secret == "" {
		return errors.New("还没填 Signing Secret，收不了事件回调")
	}
	sec, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return errors.New("缺少或看不懂 X-Slack-Request-Timestamp")
	}
	if d := now.Sub(time.Unix(sec, 0)); d > SlackSkew || d < -SlackSkew {
		return errors.New("回调时间戳和本机时间差太多，按重放拒绝")
	}
	if !hmac.Equal([]byte(SlackSign(secret, timestamp, body)), []byte(signature)) {
		return errors.New("签名不对")
	}
	return nil
}

// SlackSign 算签名，测试和假服务端用。
func SlackSign(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "v0:%s:", timestamp)
	_, _ = mac.Write(body)
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}
