package connector

import (
	"context"
	"errors"
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
	}
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
