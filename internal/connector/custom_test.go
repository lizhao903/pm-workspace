package connector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector/customfake"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// newCustomStore 用真库、真保险箱，登记自定义 MCP、OpenAPI 和假连接器。
func newCustomStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := NewRegistry()
	for _, d := range []Def{CustomMCP(), CustomOpenAPI(), Fake()} {
		if err := defs.Register(d); err != nil {
			t.Fatal(err)
		}
	}
	s := New(st.DB(), v, defs)
	s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	return s
}

func toolByName(c *Connector, name string) *Tool {
	for i := range c.Tools {
		if c.Tools[i].Name == name {
			return &c.Tools[i]
		}
	}
	return nil
}

// 验收：自定义 MCP（本机假服务，Streamable HTTP 和 SSE）测试连接通过、拉到工具清单、读写分对，能调工具。
func TestCustomMCP(t *testing.T) {
	ctx := context.Background()
	const tok = "mcp-secret-token-0123456789"
	fs := customfake.NewMCP(tok)
	defer fs.Close()
	s := newCustomStore(t)

	for _, tc := range []struct{ transport, path string }{{TransportStreamable, "/mcp"}, {TransportSSE, "/sse"}} {
		c, err := s.Create(ctx, Input{Tool: CustomMCPTool, Name: "笔记 " + tc.transport, AuthMode: AuthToken,
			Config: map[string]string{"url": fs.URL + tc.path, "transport": tc.transport}, Secrets: map[string]string{"token": tok}})
		if err != nil {
			t.Fatal(err)
		}
		// 请求头、前缀取默认
		if c.Config["token_header"] != "Authorization" || c.Config["token_prefix"] != "Bearer" || c.SecretHints["token"] == "" {
			t.Fatalf("默认值 = %v %v", c.Config, c.SecretHints)
		}
		res, err := s.Test(ctx, c.ID)
		if err != nil || !res.OK || res.Account != "fake-mcp 0.1.0" {
			t.Fatalf("%s 测试 = %+v %v", tc.transport, res, err)
		}
		tr, err := s.RefreshTools(ctx, c.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(tr.Connector.Tools) != 3 {
			t.Fatalf("%s 工具 = %+v", tc.transport, tr.Connector.Tools)
		}
		search, get, del := toolByName(tr.Connector, "search"), toolByName(tr.Connector, "get_note"), toolByName(tr.Connector, "delete_note")
		if search == nil || search.Write || search.Mode != ModeAuto || !strings.Contains(string(search.Schema), `"q"`) {
			t.Fatalf("search 应是只读、自动、带 Schema：%+v", search)
		}
		// 没有标注的当写工具
		if get == nil || !get.Write || get.Mode != ModeConfirm || del == nil || !del.Write {
			t.Fatalf("get_note、delete_note 应是写：%+v %+v", get, del)
		}
		out, err := s.CallTool(ctx, c.ID, "search", json.RawMessage(`{"q":"周会"}`))
		if err != nil || out != "找到 1 条：周会 周报" {
			t.Fatalf("%s 调 search = %q %v", tc.transport, out, err)
		}
		if _, err := s.CallTool(ctx, c.ID, "delete_note", json.RawMessage(`{"id":"n1"}`)); err == nil || !strings.Contains(err.Error(), "不许删 n1") {
			t.Fatalf("工具报错应原样带回：%v", err)
		}
	}

	// Token 不对：测试失败，说明里没有凭证原文
	bad := "wrong-token-abcdefghijklmn"
	c, err := s.Create(ctx, Input{Tool: CustomMCPTool, AuthMode: AuthToken,
		Config: map[string]string{"url": fs.URL + "/mcp"}, Secrets: map[string]string{"token": bad}})
	if err != nil {
		t.Fatal(err)
	}
	if res, _ := s.Test(ctx, c.ID); res.OK || strings.Contains(res.Message, bad) || res.Connector.Status != StatusError {
		t.Fatalf("错 Token 应失败且抹掉凭证：%+v", res)
	}
	// 跳转不跟
	c, err = s.Create(ctx, Input{Tool: CustomMCPTool, AuthMode: AuthToken,
		Config: map[string]string{"url": fs.URL + "/redirect"}, Secrets: map[string]string{"token": tok}})
	if err != nil {
		t.Fatal(err)
	}
	if res, _ := s.Test(ctx, c.ID); res.OK {
		t.Fatalf("跳转到别处不应测通：%+v", res)
	}
}

// 验收：同一工具接第二个实例成功，名称自动加序号；填了名称就用填的。
func TestMultipleInstancesAndNames(t *testing.T) {
	ctx := context.Background()
	s := newCustomStore(t)
	cfg := map[string]string{"url": "http://127.0.0.1:9/mcp"}
	var names []string
	for _, n := range []string{"", "", "MCP 服务", "我的笔记"} {
		c, err := s.Create(ctx, Input{Tool: CustomMCPTool, Name: n, Config: cfg})
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, c.Name)
	}
	if strings.Join(names, "|") != "MCP 服务|MCP 服务 2|MCP 服务 3|我的笔记" {
		t.Fatalf("名称 = %v", names)
	}
	// 内置的也能接第二个
	for i := 0; i < 2; i++ {
		if _, err := s.Create(ctx, Input{Tool: FakeTool, Secrets: map[string]string{"token": "abc"}}); err != nil {
			t.Fatalf("第 %d 个 fake：%v", i+1, err)
		}
	}
	if list, _ := s.List(ctx, FakeTool); len(list) != 2 || list[0].Name != "测试连接器 2" {
		t.Fatalf("fake 实例 = %+v", list)
	}
}

// 字段按认证方式算必填；地址只认 http(s)；图标只给自定义分类。
func TestCustomFieldChecks(t *testing.T) {
	ctx := context.Background()
	s := newCustomStore(t)
	isInvalid := func(err error) bool { return errors.Is(err, domain.ErrValidation) }

	for _, u := range []string{"file:///etc/passwd", "ftp://x/y", "/tmp/data", "http://user:pw@host/mcp", ""} {
		if _, err := s.Create(ctx, Input{Tool: CustomMCPTool, Config: map[string]string{"url": u}}); !isInvalid(err) {
			t.Errorf("url %q 应该 400：%v", u, err)
		}
	}
	// 无授权不要 Token；切到 Token 认证时要
	c, err := s.Create(ctx, Input{Tool: CustomMCPTool, Config: map[string]string{"url": "http://127.0.0.1:9/mcp"}})
	if err != nil || c.AuthMode != AuthNone {
		t.Fatalf("无授权 = %+v %v", c, err)
	}
	tokMode := AuthToken
	if _, err := s.Update(ctx, c.ID, Patch{AuthMode: &tokMode}); !isInvalid(err) {
		t.Fatalf("切到 Token 不填 Token 应 400：%v", err)
	}
	if c, err = s.Update(ctx, c.ID, Patch{AuthMode: &tokMode, Secrets: map[string]string{"token": "t-0123456789abcdef"}}); err != nil || c.AuthMode != AuthToken {
		t.Fatalf("切到 Token = %v", err)
	}
	// OAuth 要自己填应用信息
	oa := AuthOAuth2
	if _, err := s.Update(ctx, c.ID, Patch{AuthMode: &oa}); !isInvalid(err) {
		t.Fatalf("OAuth 不填应用信息应 400：%v", err)
	}
	if _, err := s.Update(ctx, c.ID, Patch{AuthMode: &oa, Config: map[string]string{"oauth_client_id": "cid",
		"oauth_auth_url": "file:///x", "oauth_token_url": "http://127.0.0.1:9/token"}}); !isInvalid(err) {
		t.Fatalf("授权地址不是 http(s) 应 400：%v", err)
	}
	if c, err = s.Update(ctx, c.ID, Patch{AuthMode: &oa, Config: map[string]string{"oauth_client_id": "cid",
		"oauth_auth_url": "http://127.0.0.1:9/authorize", "oauth_token_url": "http://127.0.0.1:9/token", "oauth_scopes": "read, write"}}); err != nil {
		t.Fatal(err)
	}
	st, err := s.StartOAuth(ctx, c.ID, "")
	if err != nil || !strings.HasPrefix(st.AuthorizeURL, "http://127.0.0.1:9/authorize?") || !strings.Contains(st.AuthorizeURL, "scope=read+write") {
		t.Fatalf("自定义 OAuth 发起 = %+v %v", st, err)
	}

	// 改地址生效
	u := "http://127.0.0.1:10/mcp"
	if c, err = s.Update(ctx, c.ID, Patch{Config: map[string]string{"url": u}}); err != nil || c.Config["url"] != u {
		t.Fatalf("改地址 = %v", err)
	}

	icon := "data:image/png;base64,iVBORw0KGgo="
	if c, err = s.Update(ctx, c.ID, Patch{Icon: &icon}); err != nil || c.Icon != icon {
		t.Fatalf("换图标 = %v", err)
	}
	empty := ""
	if c, _ = s.Update(ctx, c.ID, Patch{Icon: &empty}); c.Icon != "" {
		t.Fatal("空串应换回默认图标")
	}
	bad := "https://example.com/a.png"
	if _, err := s.Update(ctx, c.ID, Patch{Icon: &bad}); !isInvalid(err) {
		t.Fatalf("不是 data URL 应 400：%v", err)
	}
	f, err := s.Create(ctx, Input{Tool: FakeTool, Secrets: map[string]string{"token": "abc"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(ctx, f.ID, Patch{Icon: &icon}); !isInvalid(err) {
		t.Fatalf("内置连接器不能换图标：%v", err)
	}
}

// 验收：自定义 OpenAPI，生成的工具数和 operationId 一致，GET 是只读；调用按参数位置拼请求。
func TestCustomOpenAPI(t *testing.T) {
	ctx := context.Background()
	const key = "api-key-0123456789abcdef"
	fs := customfake.NewOpenAPI(key)
	defer fs.Close()
	s := newCustomStore(t)

	for _, spec := range []string{"/openapi.yaml", "/openapi.json"} {
		c, err := s.Create(ctx, Input{Tool: CustomOpenAPITool, AuthMode: AuthToken,
			Config:  map[string]string{"spec_url": fs.URL + spec, "token_in": "查询参数", "token_header": "api_key"},
			Secrets: map[string]string{"token": key}})
		if err != nil {
			t.Fatal(err)
		}
		res, err := s.Test(ctx, c.ID)
		if err != nil || !res.OK || res.Account != "假笔记接口 1.2" {
			t.Fatalf("%s 测试 = %+v %v", spec, res, err)
		}
		tr, err := s.RefreshTools(ctx, c.ID)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, x := range tr.Connector.Tools {
			got = append(got, x.Name)
		}
		if strings.Join(got, ",") != "listNotes,createNote,getNote,deleteNote" {
			t.Fatalf("%s 工具 = %v", spec, got)
		}
		for _, x := range tr.Connector.Tools {
			if x.Write != (x.Name == "createNote" || x.Name == "deleteNote") {
				t.Errorf("%s 读写分错了：%+v", x.Name, x)
			}
		}
		if g := toolByName(tr.Connector, "getNote"); !strings.Contains(string(g.Schema), `"required":["id"]`) {
			t.Errorf("getNote 的 Schema = %s", g.Schema)
		}

		out, err := s.CallTool(ctx, c.ID, "getNote", json.RawMessage(`{"id":"n 1"}`))
		if err != nil || !strings.Contains(out, `"id":"n 1"`) || fs.Last.Load() != "GET /v1/notes/n 1" {
			t.Fatalf("getNote = %q %v，对方收到 %v", out, err, fs.Last.Load())
		}
		if _, err := s.CallTool(ctx, c.ID, "listNotes", json.RawMessage(`{"limit":5}`)); err != nil || fs.Last.Load() != "GET /v1/notes?limit=5" {
			t.Fatalf("listNotes = %v，对方收到 %v", err, fs.Last.Load())
		}
		if out, err := s.CallTool(ctx, c.ID, "createNote", json.RawMessage(`{"body":{"title":"x"}}`)); err != nil ||
			!strings.HasPrefix(out, "HTTP 201") || fs.Last.Load() != `POST /v1/notes {"title":"x"}` {
			t.Fatalf("createNote = %q %v，对方收到 %v", out, err, fs.Last.Load())
		}
		if _, err := s.CallTool(ctx, c.ID, "getNote", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "缺少参数 id") {
			t.Fatalf("缺路径参数应失败：%v", err)
		}
	}

	// 粘贴文档：servers 是相对地址，不填接口地址测不通；填了就行。API Key 不对时接口回 401，说明里没有 Key
	c, err := s.Create(ctx, Input{Tool: CustomOpenAPITool, Config: map[string]string{"spec_text": customfake.SpecYAML()}})
	if err != nil {
		t.Fatal(err)
	}
	if res, _ := s.Test(ctx, c.ID); res.OK || !strings.Contains(res.Message, "接口地址") {
		t.Fatalf("相对 servers 没填接口地址：%+v", res)
	}
	if _, err := s.Update(ctx, c.ID, Patch{Config: map[string]string{"base_url": fs.URL + "/v1"}}); err != nil {
		t.Fatal(err)
	}
	if res, _ := s.Test(ctx, c.ID); !res.OK {
		t.Fatalf("填了接口地址应测通：%+v", res)
	}
	if _, err := s.RefreshTools(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CallTool(ctx, c.ID, "listNotes", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("没带 Key 应 401：%v", err)
	}

	// 没有文档、不是 3.x
	if _, err := s.Create(ctx, Input{Tool: CustomOpenAPITool}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("没有文档应 400：%v", err)
	}
	if _, err := parseOpenAPI([]byte("swagger: '2.0'\npaths: {}\n")); err == nil {
		t.Fatal("Swagger 2.0 应不支持")
	}
}

func TestCappedBody(t *testing.T) {
	b := &cappedBody{rc: io.NopCloser(strings.NewReader("abcdef")), left: 4}
	if _, err := io.ReadAll(b); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("超长应报 ErrTooLarge：%v", err)
	}
	b = &cappedBody{rc: io.NopCloser(strings.NewReader("abcd")), left: 4}
	if got, err := io.ReadAll(b); err != nil || string(got) != "abcd" {
		t.Fatalf("正好上限 = %q %v", got, err)
	}
}
