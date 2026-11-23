// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 插件出网代理（P2，docs/plugin-spec-v2.md 7.5 host.http.request）：
// 插件请求宿主的 HTTP 代理，宿主只按插件清单里「已声明且已授予」的 network:<group>
// 放行域名；每一跳重定向都重新检查；不跟 Cookie、不允许非 http(s)。
// P2 暂不实现流式（stream=true 回 validation）。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	httpProxyBodyLimit = 8 << 20
	httpProxyMaxHops   = 5
)

// allowedNetworkGroups 返回插件已声明且用户已授予的 network:<group>。
func (p *pluginProcess) allowedNetworkGroups() []string {
	var groups []string
	for _, perm := range p.manifest.Permissions {
		group, ok := strings.CutPrefix(perm, "network:")
		if !ok || !p.hasGranted(perm) {
			continue
		}
		groups = append(groups, group)
	}
	return groups
}

func urlAllowedBy(groups []string, u *url.URL) bool {
	for _, g := range groups {
		if plugin.NetworkAllows(g, u) {
			return true
		}
	}
	return false
}

func (p *pluginProcess) httpRequest(ctx context.Context, params json.RawMessage) (any, error) {
	var in struct {
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Headers   map[string]string `json:"headers"`
		BodyB64   string            `json:"body_b64"`
		TimeoutMS int               `json:"timeout_ms"`
		Stream    bool              `json:"stream"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "host.http.request 参数不合法：%v", err)
	}
	if in.Stream {
		return nil, rpcErrorf("validation", "流式 host.http.request 还没实现（P2）")
	}
	target, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, rpcErrorf("validation", "URL 必须是 http(s) 绝对地址")
	}
	groups := p.allowedNetworkGroups()
	if !urlAllowedBy(groups, target) {
		return nil, &rpcError{
			Code:    rpcErrorCodes["permission_denied"],
			Message: "插件没有访问 " + target.Host + " 的 network 权限",
			Data:    map[string]any{"url": in.URL, "groups": groups},
		}
	}
	var body io.Reader
	if in.BodyB64 != "" {
		raw, derr := base64.StdEncoding.DecodeString(in.BodyB64)
		if derr != nil {
			return nil, rpcErrorf("validation", "body_b64 不是合法 base64")
		}
		body = strings.NewReader(string(raw))
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = http.MethodGet
	}
	timeout := 30 * time.Second
	if in.TimeoutMS > 0 && in.TimeoutMS < int((2*time.Minute)/time.Millisecond) {
		timeout = time.Duration(in.TimeoutMS) * time.Millisecond
	}
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, rpcErrorf("validation", "构造 HTTP 请求失败：%v", err)
	}
	for k, v := range in.Headers {
		switch strings.ToLower(k) {
		case "host", "cookie", "content-length", "connection", "transfer-encoding":
			continue
		}
		req.Header.Set(k, v)
	}
	client := *p.host.httpClient
	client.Timeout = timeout
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= httpProxyMaxHops {
			return wrap(ErrValidation, "重定向次数过多")
		}
		if !urlAllowedBy(groups, next.URL) {
			return wrap(ErrPermission, "重定向到没有 network 权限的地址：%s", next.URL.Host)
		}
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		if strings.Contains(err.Error(), "插件权限不足") {
			return nil, rpcErrorf("permission_denied", "%s", err.Error())
		}
		return nil, rpcErrorf("unavailable", "请求失败：%v", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, httpProxyBodyLimit+1))
	if err != nil {
		return nil, rpcErrorf("unavailable", "读取响应失败：%v", err)
	}
	if len(data) > httpProxyBodyLimit {
		return nil, rpcErrorf("validation", "响应超过 %d 字节", httpProxyBodyLimit)
	}
	headers := map[string]string{}
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
	}
	return map[string]any{
		"status":   resp.StatusCode,
		"headers":  headers,
		"body_b64": base64.StdEncoding.EncodeToString(data),
	}, nil
}
