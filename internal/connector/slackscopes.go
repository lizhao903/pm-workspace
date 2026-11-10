// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// SlackEmailScope 是读用户资料里邮箱要的 scope：没有它时 users.info、users.list 照常成功，只是 profile 里没有 email。
const SlackEmailScope = "users:read.email"

// SlackEmailScopeHint 是缺 users:read.email 时给人看的提示（IM 插件从 Slack 补联系人邮箱时用）。
const SlackEmailScopeHint = "Slack 应用要加 users:read.email 权限并重新安装：OAuth & Permissions 里 Bot Token Scopes（身份是我本人时加在 User Token Scopes）加上 users:read.email，再点 Reinstall to Workspace"

// SlackScopes 调一次 auth.test（Token 失效等照常回 *SlackError），读响应头 X-OAuth-Scopes 里 Token 有的 scope。
// known 为 false 表示响应里没有这个头（旧版 Token、联调的假服务），这时判断不了缺不缺 scope。
func SlackScopes(ctx context.Context, c *http.Client, base, token string) (scopes []string, known bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/auth.test", nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("请求 Slack auth.test 失败：%w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, false, &SlackError{Method: "auth.test", Code: "ratelimited", Retry: resp.Header.Get("Retry-After")}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("Slack auth.test 返回 HTTP %d", resp.StatusCode)
	}
	var head struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Needed string `json:"needed"`
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSlackBody))
	if err != nil {
		return nil, false, fmt.Errorf("读 Slack auth.test 的响应失败：%w", err)
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return nil, false, fmt.Errorf("Slack auth.test 的响应不是 JSON")
	}
	if !head.OK {
		return nil, false, &SlackError{Method: "auth.test", Code: cmp.Or(head.Error, "unknown_error"), Needed: head.Needed}
	}
	h, ok := resp.Header[http.CanonicalHeaderKey("X-OAuth-Scopes")]
	if !ok || len(h) == 0 {
		return nil, false, nil
	}
	for _, x := range strings.Split(strings.Join(h, ","), ",") {
		if x = strings.TrimSpace(x); x != "" {
			scopes = append(scopes, x)
		}
	}
	return scopes, true, nil
}
