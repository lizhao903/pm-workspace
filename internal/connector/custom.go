package connector

// 自定义连接器（CONN-04）共用的部分：认证字段、出网限制、带认证的 HTTP 客户端。
// MCP 服务见 custom_mcp.go，OpenAPI 接口见 custom_openapi.go。
// 出网只发到用户填的地址：只认 http(s)，不跟跳转，请求的主机必须是登记时算好的那几个；回应体有上限。

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	// maxCustomBody 是自定义连接器一次回应体的上限
	maxCustomBody = 4 << 20
	// maxCustomResult 是回给模型的结果文本上限（字节）
	maxCustomResult = 256 << 10
	// maxToolSchema 是一个工具参数 Schema 的上限，超了不给模型看 Schema
	maxToolSchema = 32 << 10
	// maxCustomTools 是一个自定义连接器最多的工具数
	maxCustomTools = 500

	// 认证相关的字段 key，MCP 和 OpenAPI 共用
	fieldToken        = "token"
	fieldTokenHeader  = "token_header"
	fieldTokenPrefix  = "token_prefix"
	fieldTokenIn      = "token_in"
	fieldOAuthID      = "oauth_client_id"
	fieldOAuthSecret  = "oauth_client_secret"
	fieldOAuthAuthURL = "oauth_auth_url"
	fieldOAuthToken   = "oauth_token_url"
	fieldOAuthScopes  = "oauth_scopes"

	// token_in 的取值：Token 放请求头还是查询参数（OpenAPI 的 API Key 两种都有）
	tokenInHeader = "请求头"
	tokenInQuery  = "查询参数"
)

// customAuthFields 是认证字段：Token（请求头、前缀可改，留空前缀就只发 Token，即自定义请求头）、
// OAuth 2.0 自己填应用信息。query 为 true 时多一个「Token 放在」（OpenAPI 用）。
func customAuthFields(query bool) []Field {
	tok := []AuthMode{AuthToken}
	oa := []AuthMode{AuthOAuth2}
	fs := []Field{
		{Key: fieldToken, Label: "Token", Kind: "secret", Placeholder: "API Key 或个人访问令牌", Required: true, Auth: tok},
		{Key: fieldTokenHeader, Label: "请求头", Kind: "text", Placeholder: "Authorization", Default: "Authorization", Auth: tok},
		{Key: fieldTokenPrefix, Label: "前缀", Kind: "text", Placeholder: "留空就只发 Token", Default: "Bearer", Auth: tok},
	}
	if query {
		fs[1].Label = "请求头或参数名"
		fs = append(fs, Field{Key: fieldTokenIn, Label: "Token 放在", Kind: "select", Options: []string{tokenInHeader, tokenInQuery},
			Default: tokenInHeader, Required: true, Auth: tok})
	}
	return append(fs,
		Field{Key: fieldOAuthID, Label: "Client ID", Kind: "text", Required: true, Auth: oa},
		Field{Key: fieldOAuthSecret, Label: "Client Secret", Kind: "secret", Auth: oa},
		Field{Key: fieldOAuthAuthURL, Label: "授权地址", Kind: "text", Placeholder: "https://…/oauth/authorize", Required: true, Auth: oa},
		Field{Key: fieldOAuthToken, Label: "令牌地址", Kind: "text", Placeholder: "https://…/oauth/token", Required: true, Auth: oa},
		Field{Key: fieldOAuthScopes, Label: "授权范围", Kind: "text", Placeholder: "空格或逗号隔开", Auth: oa},
	)
}

// customOAuth 是自定义连接器的 OAuth：应用信息、地址、范围都由用户填。
func customOAuth() *OAuthSpec {
	return &OAuthSpec{AuthURLField: fieldOAuthAuthURL, TokenURLField: fieldOAuthToken, ScopesField: fieldOAuthScopes,
		ClientIDField: fieldOAuthID, ClientSecretField: fieldOAuthSecret}
}

// parseCustomURL 校验用户填的地址：只能是带主机的 http(s)，不能是 file:// 或本机路径，不带用户名密码。
func parseCustomURL(label, raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("%s只能是 http:// 或 https:// 开头的地址", label)
	}
	if u.User != nil {
		return nil, fmt.Errorf("%s里不要带用户名和密码，凭证填在认证里", label)
	}
	return u, nil
}

// checkOptionalURLs 校验几个可以不填的地址字段，填了就必须合规。
func checkOptionalURLs(values map[string]string, fields map[string]string) error {
	for key, label := range fields {
		if v := values[key]; v != "" {
			if _, err := parseCustomURL(label, v); err != nil {
				return err
			}
		}
	}
	return nil
}

// originOf 是 scheme://host[:port]，小写。
func originOf(u *url.URL) string { return strings.ToLower(u.Scheme + "://" + u.Host) }

// applyAuth 按认证方式给请求带上凭证。
func applyAuth(req *http.Request, cfg Config) {
	switch cfg.Mode {
	case AuthToken:
		tok, name := cfg.Secret(fieldToken), cfg.Get(fieldTokenHeader)
		if tok == "" {
			return
		}
		if name == "" {
			name = "Authorization"
		}
		if cfg.Get(fieldTokenIn) == tokenInQuery {
			q := req.URL.Query()
			q.Set(name, tok)
			req.URL.RawQuery = q.Encode()
			return
		}
		if p := cfg.Get(fieldTokenPrefix); p != "" {
			tok = p + " " + tok
		}
		req.Header.Set(name, tok)
	case AuthOAuth2:
		if t := cfg.AccessToken(); t != "" {
			req.Header.Set("Authorization", "Bearer "+t)
		}
	}
}

// ErrTooLarge：对方的回应体超过上限。
var ErrTooLarge = fmt.Errorf("对方返回的内容超过 %d MB", maxCustomBody>>20)

// guardTransport 只放行发往 allowed 里这几个地址的 http(s) 请求，带上凭证，回应体限长。
type guardTransport struct {
	cfg     Config
	allowed map[string]bool
	base    http.RoundTripper
}

func (t *guardTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !t.allowed[originOf(req.URL)] {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, fmt.Errorf("不往 %s 发请求：只发到连接器里填的地址", originOf(req.URL))
	}
	r := req.Clone(req.Context())
	applyAuth(r, t.cfg)
	resp, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	resp.Body = &cappedBody{rc: resp.Body, left: maxCustomBody}
	return resp, nil
}

// cappedBody 读超过 left 字节时报 ErrTooLarge。
type cappedBody struct {
	rc   io.ReadCloser
	left int64
}

func (b *cappedBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		// 正好读完上限时再试探一个字节，确认是不是还有
		var one [1]byte
		n, err := b.rc.Read(one[:])
		if n > 0 {
			return 0, ErrTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.rc.Read(p)
	b.left -= int64(n)
	return n, err
}

func (b *cappedBody) Close() error { return b.rc.Close() }

// customClient 是发往 origins 的客户端：不跟跳转（跳转可能去别的地址），超时同一次调用的上限。
func customClient(cfg Config, origins ...*url.URL) *http.Client {
	allowed := map[string]bool{}
	for _, u := range origins {
		if u != nil {
			allowed[originOf(u)] = true
		}
	}
	return &http.Client{
		Timeout:   callTimeout,
		Transport: &guardTransport{cfg: cfg, allowed: allowed, base: http.DefaultTransport},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// clipText 把回给模型的结果截到 maxCustomResult 字节（按字符边界）。
func clipText(s string) string {
	if len(s) <= maxCustomResult {
		return s
	}
	cut := maxCustomResult
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "\n…（结果太长，后面截掉了）"
}

// errSnippet 是对方错误回应体的前一段，给人看。
func errSnippet(body []byte) string {
	s := strings.TrimSpace(string(body))
	if s == "" {
		return "没有说明"
	}
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200]) + "…"
	}
	return s
}

var errNoTool = errors.New("没有这个工具，先重新获取工具清单")
