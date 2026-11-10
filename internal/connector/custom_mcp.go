// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

// 自定义 MCP 服务（CONN-04，原型 custom_mcp）：用户填服务地址、传输方式和认证。
// 测试连接走 initialize，获取工具清单走 tools/list（readOnlyHint 为 true 的算只读，没有标注的算写），
// Agent 调用走 tools/call。每次操作新开一个会话，用完关掉，不常驻连接。
// 传输方式先做 Streamable HTTP 和 SSE；stdio 要起本机进程，放到下一步。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// CustomMCPTool 是自定义 MCP 服务的 key，同原型 custom_mcp。
const CustomMCPTool = "custom_mcp"

// 传输方式，同原型的选项
const (
	TransportStreamable = "Streamable HTTP"
	TransportSSE        = "SSE"
)

// CustomMCP 是自定义 MCP 服务的定义。
func CustomMCP() Def {
	fields := append([]Field{
		{Key: "url", Label: "服务地址", Kind: "text", Placeholder: "https://mcp.example.com/mcp", Required: true},
		{Key: "transport", Label: "传输方式", Kind: "select", Options: []string{TransportStreamable, TransportSSE},
			Default: TransportStreamable, Required: true},
	}, customAuthFields(false)...)
	return Def{
		Tool: CustomMCPTool, Label: "MCP 服务", Category: "custom", Color: "#7a4fd6",
		Desc: "接一个 MCP 服务，自动发现它提供的工具", Auth: []AuthMode{AuthNone, AuthOAuth2, AuthToken},
		Fields: fields, OAuth: customOAuth(),
		CheckConfig: func(v map[string]string) error {
			if _, err := parseCustomURL("服务地址", v["url"]); err != nil {
				return err
			}
			return checkOptionalURLs(v, map[string]string{fieldOAuthAuthURL: "授权地址", fieldOAuthToken: "令牌地址"})
		},
		Test: func(ctx context.Context, cfg Config) (string, error) {
			var account string
			err := withMCP(ctx, cfg, func(cs *mcp.ClientSession) error {
				if info := cs.InitializeResult().ServerInfo; info != nil {
					account = strings.TrimSpace(info.Name + " " + info.Version)
				}
				return nil
			})
			return account, err
		},
		ListTools: func(ctx context.Context, cfg Config) ([]ToolDef, error) {
			var out []ToolDef
			err := withMCP(ctx, cfg, func(cs *mcp.ClientSession) error {
				var err error
				out, err = mcpListTools(ctx, cs)
				return err
			})
			return out, err
		},
		Call: func(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) {
			var params map[string]any
			if err := json.Unmarshal(args, &params); err != nil {
				return "", errors.New("参数要是一个 JSON 对象")
			}
			var out string
			err := withMCP(ctx, cfg, func(cs *mcp.ClientSession) error {
				res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: params})
				if err != nil {
					return callErr(err)
				}
				text := mcpResultText(res)
				if res.IsError {
					return fmt.Errorf("工具返回错误：%s", errSnippet([]byte(text)))
				}
				out = clipText(text)
				return nil
			})
			return out, err
		},
	}
}

// withMCP 按配置连上对方（initialize 加 initialized），把会话交给 fn，结束后关掉。
func withMCP(ctx context.Context, cfg Config, fn func(cs *mcp.ClientSession) error) error {
	u, err := parseCustomURL("服务地址", cfg.Get("url"))
	if err != nil {
		return err
	}
	if cfg.Mode == AuthOAuth2 && cfg.AccessToken() == "" {
		return errors.New("还没完成 OAuth 授权")
	}
	if cfg.Mode == AuthToken && cfg.Secret(fieldToken) == "" {
		return errors.New("还没填 Token")
	}
	hc := customClient(cfg, u)
	var t mcp.Transport
	switch cfg.Get("transport") {
	case TransportSSE:
		t = &mcp.SSEClientTransport{Endpoint: u.String(), HTTPClient: hc}
	case "", TransportStreamable:
		t = &mcp.StreamableClientTransport{Endpoint: u.String(), HTTPClient: hc, MaxRetries: -1, DisableStandaloneSSE: true}
	default:
		return fmt.Errorf("传输方式 %q 还不支持", cfg.Get("transport"))
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "pmw", Version: "1"}, nil)
	cs, err := client.Connect(ctx, t, nil)
	if err != nil {
		return fmt.Errorf("连不上 MCP 服务：%w", callErr(err))
	}
	defer func() { _ = cs.Close() }()
	return fn(cs)
}

// mcpListTools 翻页拉全部工具，最多 maxCustomTools 个；名字重复的只留第一个。
func mcpListTools(ctx context.Context, cs *mcp.ClientSession) ([]ToolDef, error) {
	out := []ToolDef{}
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 50; page++ {
		res, err := cs.ListTools(ctx, &mcp.ListToolsParams{Cursor: cursor})
		if err != nil {
			return nil, fmt.Errorf("tools/list 失败：%w", callErr(err))
		}
		for _, t := range res.Tools {
			if t == nil || t.Name == "" || seen[t.Name] {
				continue
			}
			if len(out) >= maxCustomTools {
				return nil, fmt.Errorf("工具超过 %d 个，暂不支持", maxCustomTools)
			}
			seen[t.Name] = true
			desc := t.Description
			if desc == "" && t.Annotations != nil {
				desc = t.Annotations.Title
			}
			// 没有标注的当写工具：宁可多确认一次
			out = append(out, ToolDef{Name: t.Name, Desc: clipRunes(desc, 500),
				Write: t.Annotations == nil || !t.Annotations.ReadOnlyHint, Schema: schemaJSON(t.InputSchema)})
		}
		if res.NextCursor == "" {
			return out, nil
		}
		cursor = res.NextCursor
	}
	return nil, errors.New("tools/list 翻页太多，停下了")
}

// mcpResultText 把 tools/call 的结果拼成文本：文字原样，结构化内容转 JSON，别的类型写个占位。
func mcpResultText(res *mcp.CallToolResult) string {
	var parts []string
	for _, c := range res.Content {
		switch x := c.(type) {
		case *mcp.TextContent:
			parts = append(parts, x.Text)
		case *mcp.ImageContent:
			parts = append(parts, fmt.Sprintf("[图片 %s]", x.MIMEType))
		case *mcp.AudioContent:
			parts = append(parts, fmt.Sprintf("[音频 %s]", x.MIMEType))
		case *mcp.ResourceLink:
			parts = append(parts, fmt.Sprintf("[资源 %s]", x.URI))
		default:
			parts = append(parts, fmt.Sprintf("[%T]", c))
		}
	}
	if len(parts) == 0 && res.StructuredContent != nil {
		if b, err := json.Marshal(res.StructuredContent); err == nil {
			parts = append(parts, string(b))
		}
	}
	return strings.Join(parts, "\n")
}

// callErr 把对外请求的错误收成一句话；超时、超长说清楚。
func callErr(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("超过 %d 秒没有回应", int(callTimeout.Seconds()))
	}
	if errors.Is(err, ErrTooLarge) {
		return ErrTooLarge
	}
	return err
}

// schemaJSON 是参数 Schema 的 JSON 原文；不是对象或太大时不给。
func schemaJSON(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil || len(b) > maxToolSchema || len(b) == 0 || b[0] != '{' {
		return nil
	}
	return b
}

func clipRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
