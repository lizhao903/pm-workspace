// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/connector/customfake"
)

// 验收（CONN-04）：经接口添加自定义 MCP（本机假服务，Streamable HTTP），测通、拉到工具清单、读写分对；
// 同一工具再接一个，名称自动加序号；Agent 挂上后调到只读工具，两个实例的工具名不撞。
func TestCustomMCPConnectorAgentCall(t *testing.T) {
	r, st, up := newGrantServer(t)
	for _, d := range []connector.Def{connector.CustomMCP(), connector.CustomOpenAPI()} {
		if err := r.s.opt.Connectors.Defs().Register(d); err != nil {
			t.Fatal(err)
		}
	}
	const tok = "mcp-api-token-0123456789"
	fs := customfake.NewMCP(tok)
	defer fs.Close()

	body := `{"tool":"custom_mcp","auth_mode":"token","config":{"url":"` + fs.URL + `/mcp","transport":"Streamable HTTP"},"secrets":{"token":"` + tok + `"}}`
	c1 := r.call("POST", "/api/connectors", body, http.StatusCreated)
	c2 := r.call("POST", "/api/connectors", body, http.StatusCreated)
	if c1["name"] != "MCP 服务" || c2["name"] != "MCP 服务 2" {
		t.Fatalf("名称 = %v %v", c1["name"], c2["name"])
	}
	if strings.Contains(strings.Join(r.bodies, ""), tok) {
		t.Fatal("响应里不能有 Token 原文")
	}
	ids := []string{c1["id"].(string), c2["id"].(string)}
	for _, id := range ids {
		if res := r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK); res["ok"] != true || res["account"] != "fake-mcp 0.1.0" {
			t.Fatalf("测试 = %v", res)
		}
		res := r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusOK)
		tools := res["connector"].(map[string]any)["tools"].([]any)
		modes := map[string]string{}
		for _, x := range tools {
			m := x.(map[string]any)
			modes[m["name"].(string)] = m["mode"].(string)
		}
		if len(tools) != 3 || modes["search"] != "auto" || modes["get_note"] != "confirm" || modes["delete_note"] != "confirm" {
			t.Fatalf("工具授权 = %v", modes)
		}
	}

	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"笔记助手","provider_id":"`+pid+`","mcps":["`+ids[0]+`","`+ids[1]+`"]}`, http.StatusCreated)
	aid := ag["id"].(string)
	r.call("PUT", "/api/agents/"+aid+"/grants",
		`{"grants":{"conn:`+ids[0]+`:search":"auto","conn:`+ids[1]+`:search":"auto"}}`, http.StatusOK)

	up.push(toolCallLine("custom_mcp__search", `{"q":"周会"}`))
	w := do(r.s, "POST", "/api/agent/chat", `{"agent_id":"`+aid+`","message":"搜一下周会"}`)
	mustCode(t, w, http.StatusOK, "chat")
	if tools := up.lastTools(); !hasStr(tools, "custom_mcp__search") || !hasStr(tools, "custom_mcp_2__search") || hasStr(tools, "custom_mcp__delete_note") {
		t.Fatalf("给模型的工具 = %v", tools)
	}
	tr := findEvent(sse(t, w.Body.String()), "tool_result")
	if tr == nil || !strings.Contains(tr["summary"].(string), "search") || fs.Calls.Load() != 1 {
		t.Fatalf("调只读工具：%s（对方收到 %d 次）", w.Body.String(), fs.Calls.Load())
	}
}

// 改名称、地址、认证后保存生效，凭证只有脱敏提示；图标只给自定义分类。
func TestCustomConnectorEdit(t *testing.T) {
	r, _, _ := newGrantServer(t)
	if err := r.s.opt.Connectors.Defs().Register(connector.CustomOpenAPI()); err != nil {
		t.Fatal(err)
	}
	c := r.call("POST", "/api/connectors", `{"tool":"custom_openapi","config":{"spec_url":"http://127.0.0.1:9/openapi.json"}}`, http.StatusCreated)
	id := c["id"].(string)
	const key = "openapi-key-0123456789abc"
	c = r.call("PATCH", "/api/connectors/"+id, `{"name":"笔记接口","auth_mode":"token","config":{"spec_url":"http://127.0.0.1:10/openapi.yaml","token_in":"查询参数"},"secrets":{"token":"`+key+`"},"icon":"data:image/png;base64,AAAA"}`, http.StatusOK)
	hints := c["secret_hints"].(map[string]any)
	cfg := c["config"].(map[string]any)
	if c["name"] != "笔记接口" || c["auth_mode"] != "token" || cfg["spec_url"] != "http://127.0.0.1:10/openapi.yaml" ||
		hints["token"] == "" || hints["token"] == key || c["icon"] != "data:image/png;base64,AAAA" {
		t.Fatalf("改后 = %v", c)
	}
	if strings.Contains(strings.Join(r.bodies, ""), key) {
		t.Fatal("响应里不能有凭证原文")
	}
	r.call("PATCH", "/api/connectors/"+id, `{"config":{"spec_url":"file:///etc/hosts"}}`, http.StatusBadRequest)
	f := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	r.call("PATCH", "/api/connectors/"+f["id"].(string), `{"icon":"data:image/png;base64,AAAA"}`, http.StatusBadRequest)
}
