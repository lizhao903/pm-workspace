// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// FakeTool 是内置假连接器的 key。它不联网，只给测试和演练用：cmd/pmw 带 --fake-connector 才登记。
const FakeTool = "fake"

// Fake 是内置的假连接器：Token 认证，token 里含 invalid 或 expired 时测试失败；
// 失败说明故意带上 token 原文，用来验证框架会把凭证从错误文本里抹掉。
// variant 填 v2 时工具清单换一组（去掉 get_item、加上 delete_item），用来验证重新拉取时保留已配的授权。
func Fake() Def {
	return Def{
		Tool: FakeTool, Label: "测试连接器", Category: "dev", Color: "#64748b",
		Desc: "内置的假连接器，不联网，只用于测试和演练", Auth: []AuthMode{AuthToken},
		Fields: []Field{
			{Key: "base_url", Label: "服务地址", Kind: "text", Placeholder: "https://fake.example.com"},
			{Key: "variant", Label: "工具清单版本", Kind: "select", Options: []string{"v1", "v2"}},
			{Key: "token", Label: "访问令牌", Kind: "secret", Required: true},
		},
		Tools: fakeTools("v1"),
		Test: func(ctx context.Context, cfg Config) (string, error) {
			tok := cfg.Secret("token")
			switch {
			case tok == "":
				return "", errors.New("还没填访问令牌")
			case strings.Contains(tok, "invalid") || strings.Contains(tok, "expired"):
				return "", errors.New("401 Unauthorized: token " + tok + " rejected")
			}
			return "fake-user", ctx.Err()
		},
		ListTools: func(ctx context.Context, cfg Config) ([]ToolDef, error) {
			if strings.Contains(cfg.Secret("token"), "invalid") {
				return nil, errors.New("401 Unauthorized: token " + cfg.Secret("token") + " rejected")
			}
			return fakeTools(cfg.Get("variant")), ctx.Err()
		},
		Call: fakeCall,
	}
}

// fakeCall 是假连接器的工具调用（AG-02a）：不联网，按工具名回一段固定的 JSON，参数原样带回，方便测试断言。
func fakeCall(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) {
	if tok := cfg.Secret("token"); strings.Contains(tok, "invalid") {
		return "", errors.New("401 Unauthorized: token " + tok + " rejected")
	}
	var out any
	switch tool {
	case "list_items":
		out = map[string]any{"items": []map[string]any{{"id": "it_1", "title": "第一条"}, {"id": "it_2", "title": "第二条"}}}
	case "get_item", "create_item", "delete_item":
		out = map[string]any{"tool": tool, "ok": true, "args": args}
	default:
		return "", fmt.Errorf("unknown tool %s", tool)
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), ctx.Err()
}

func fakeTools(variant string) []ToolDef {
	if variant == "v2" {
		return []ToolDef{
			{Name: "list_items", Desc: "列出条目", Write: false},
			{Name: "create_item", Desc: "新建条目", Write: true},
			{Name: "delete_item", Desc: "删除条目", Write: true},
		}
	}
	return []ToolDef{
		{Name: "list_items", Desc: "列出条目", Write: false},
		{Name: "get_item", Desc: "读取一个条目", Write: false},
		{Name: "create_item", Desc: "新建条目", Write: true},
	}
}

// FakeOAuthTool 是内置假 OAuth 连接器的 key，和 fake 一样只在 --fake-connector 时登记。
const FakeOAuthTool = "fake_oauth"

// FakeOAuth 是走 OAuth 2.0 的假连接器：授权地址、令牌地址接在 config.base_url 后面（/authorize、/token），
// 连通测试拿 access_token 请求 base_url/userinfo，回 {"login": "..."}。测试和演练时自己起一个假 OAuth 服务对接。
func FakeOAuth() Def {
	return Def{
		Tool: FakeOAuthTool, Label: "测试 OAuth 连接器", Category: "dev", Color: "#64748b",
		Desc: "内置的假 OAuth 连接器，对接自己起的假授权服务，只用于测试和演练", Auth: []AuthMode{AuthOAuth2},
		Fields: []Field{
			{Key: "base_url", Label: "授权服务地址", Kind: "text", Placeholder: "http://127.0.0.1:7798", Required: true},
			{Key: "client_id", Label: "Client ID", Kind: "text", Required: true},
			{Key: "client_secret", Label: "Client Secret", Kind: "secret"},
		},
		OAuth: &OAuthSpec{AuthURL: "/authorize", TokenURL: "/token", Scopes: []string{"read", "write"},
			BaseURLField: "base_url", ClientIDField: "client_id", ClientSecretField: "client_secret"},
		Tools: fakeTools("v1"),
		Test: func(ctx context.Context, cfg Config) (string, error) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.Get("base_url"), "/")+"/userinfo", nil)
			if err != nil {
				return "", err
			}
			req.Header.Set("Authorization", "Bearer "+cfg.AccessToken())
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return "", err
			}
			defer func() { _ = resp.Body.Close() }()
			var out struct {
				Login string `json:"login"`
			}
			if resp.StatusCode != http.StatusOK {
				return "", fmt.Errorf("userinfo returned %d", resp.StatusCode)
			}
			if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&out); err != nil {
				return "", fmt.Errorf("userinfo: %w", err)
			}
			return out.Login, nil
		},
	}
}
