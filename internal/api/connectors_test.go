// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// connRec 记下每一次响应体，最后统一扫一遍有没有凭证明文。
type connRec struct {
	t      *testing.T
	s      *Server
	bodies []string
}

func (c *connRec) call(method, target, body string, want int) map[string]any {
	c.t.Helper()
	w := do(c.s, method, target, body)
	c.bodies = append(c.bodies, w.Body.String())
	mustCode(c.t, w, want, method+" "+target)
	env := decodeEnvelope(c.t, w)
	if d, ok := env["data"].(map[string]any); ok {
		return d
	}
	return env
}

// newConnectorServer 用真库、真保险箱和审计，登记内置的假连接器。
func newConnectorServer(t *testing.T) (*connRec, *vault.Vault, *db.DB) {
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
	defs := connector.NewRegistry()
	if err := defs.Register(connector.Fake()); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	s := New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Vault: v, Audit: al,
		Connectors: connector.New(st.DB(), v, defs)})
	return &connRec{t: t, s: s}, v, st.DB()
}

func toolModes(c map[string]any) map[string]string {
	out := map[string]string{}
	for _, x := range c["tools"].([]any) {
		t := x.(map[string]any)
		out[t["name"].(string)] = t["mode"].(string)
	}
	return out
}

func TestConnectorLifecycleNoPlaintext(t *testing.T) {
	r, v, _ := newConnectorServer(t)
	ctx := context.Background()
	const tok = "ghp_fakeTokenValue0123456789abcdef"
	const tok2 = "ghp_secondTokenValue9876543210zyxw"
	const bad = "invalid_TokenValue_abcdefghij0123"

	defs := r.call("GET", "/api/connectors/defs", "", http.StatusOK)
	if items := defs["data"].([]any); len(items) != 1 || items[0].(map[string]any)["tool"] != "fake" {
		t.Fatalf("defs = %v", defs)
	}

	// 必填凭证没填、未知字段、未知工具都回 400
	r.call("POST", "/api/connectors", `{"tool":"fake"}`, http.StatusBadRequest)
	r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"x"},"config":{"token":"x"}}`, http.StatusBadRequest)
	r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"base_url":"x","token":"x"}}`, http.StatusBadRequest)
	r.call("POST", "/api/connectors", `{"tool":"nope","secrets":{"token":"x"}}`, http.StatusBadRequest)
	r.call("POST", "/api/connectors", `{"tool":"fake","config":{"variant":"v9"},"secrets":{"token":"x"}}`, http.StatusBadRequest)

	c := r.call("POST", "/api/connectors", `{"tool":"fake","name":" 测试 ","config":{"base_url":" https://x.test "},"secrets":{"token":"`+tok+`"}}`, http.StatusCreated)
	id := c["id"].(string)
	if !strings.HasPrefix(id, "cn_") || c["name"] != "测试" || c["status"] != "connecting" || c["auth_mode"] != "token" {
		t.Fatalf("create = %v", c)
	}
	if c["config"].(map[string]any)["base_url"] != "https://x.test" {
		t.Errorf("config = %v", c["config"])
	}
	if h := c["secret_hints"].(map[string]any)["token"]; h != vault.Hint(tok) {
		t.Errorf("hint = %v", h)
	}
	if _, ok := c["secrets"]; ok {
		t.Error("响应里不该有 secrets 字段")
	}
	// 同一工具可以再接一个（CONN-04），名称自动加序号；删掉它，后面只看第一个
	c2 := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"`+tok+`"}}`, http.StatusCreated)
	if c2["name"] == c["name"] {
		t.Errorf("第二个实例名称应加序号：%v", c2["name"])
	}
	r.call("DELETE", "/api/connectors/"+c2["id"].(string), "", http.StatusOK)

	// 明文确实进了保险箱
	cn, err := r.s.opt.Connectors.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := v.Resolve(ctx, cn.SecretID); err != nil || !strings.Contains(plain, tok) {
		t.Fatalf("resolve: %v", err)
	}

	// 连通测试成功：connected、记下账号
	res := r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK)
	if res["ok"] != true || res["account"] != "fake-user" {
		t.Fatalf("test = %v", res)
	}
	if cc := res["connector"].(map[string]any); cc["status"] != "connected" || cc["account"] != "fake-user" || cc["last_tested_at"] == nil {
		t.Fatalf("after test = %v", cc)
	}

	// 拉取工具清单：只读自动、写操作需确认
	tr := r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusOK)
	got := toolModes(tr["connector"].(map[string]any))
	if got["list_items"] != "auto" || got["get_item"] != "auto" || got["create_item"] != "confirm" || len(tr["added"].([]any)) != 3 {
		t.Fatalf("refresh = %v", tr)
	}

	// 改授权并持久；只读工具不能设 confirm，不在清单里的工具、不认识的模式回 400
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"list_items":"confirm"}}`, http.StatusBadRequest)
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"nope":"off"}}`, http.StatusBadRequest)
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"create_item":"always"}}`, http.StatusBadRequest)
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{}}`, http.StatusBadRequest)
	m := r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"create_item":"auto","list_items":"off"}}`, http.StatusOK)
	if g := toolModes(m); g["create_item"] != "auto" || g["list_items"] != "off" || g["get_item"] != "auto" {
		t.Fatalf("set modes = %v", g)
	}
	if g := toolModes(r.call("GET", "/api/connectors/"+id, "", http.StatusOK)); g["create_item"] != "auto" || g["list_items"] != "off" {
		t.Fatalf("modes not persisted: %v", g)
	}

	// 换一组工具重新拉：保留已配的授权，新出现的按默认，对方删掉的去掉
	r.call("PATCH", "/api/connectors/"+id, `{"config":{"variant":"v2"}}`, http.StatusOK)
	tr = r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusOK)
	g := toolModes(tr["connector"].(map[string]any))
	if g["create_item"] != "auto" || g["list_items"] != "off" || g["delete_item"] != "confirm" || g["get_item"] != "" {
		t.Fatalf("refresh v2 = %v", g)
	}
	if a, rm := tr["added"].([]any), tr["removed"].([]any); len(a) != 1 || a[0] != "delete_item" || len(rm) != 1 || rm[0] != "get_item" {
		t.Fatalf("added/removed = %v %v", a, rm)
	}

	// PATCH 不许改工具、状态
	r.call("PATCH", "/api/connectors/"+id, `{"status":"connected"}`, http.StatusBadRequest)
	r.call("PATCH", "/api/connectors/"+id, `{"tools":[]}`, http.StatusBadRequest)
	// 清掉必填凭证回 400
	r.call("PATCH", "/api/connectors/"+id, `{"secrets":{"token":""}}`, http.StatusBadRequest)

	// 换凭证：原地轮换，hint 跟着变；换成坏的，测试失败，错误文本里没有明文
	u := r.call("PATCH", "/api/connectors/"+id, `{"secrets":{"token":"`+tok2+`"}}`, http.StatusOK)
	if u["secret_hints"].(map[string]any)["token"] != vault.Hint(tok2) {
		t.Fatalf("hint after rotate = %v", u["secret_hints"])
	}
	r.call("PATCH", "/api/connectors/"+id, `{"secrets":{"token":"`+bad+`"}}`, http.StatusOK)
	res = r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK)
	if res["ok"] != false || !strings.Contains(res["message"].(string), "***") {
		t.Fatalf("bad test = %v", res)
	}
	if cc := res["connector"].(map[string]any); cc["status"] != "error" || !strings.Contains(cc["error"].(string), "401") {
		t.Fatalf("after bad test = %v", cc)
	}
	// 拉取失败回 409，同样抹掉凭证；工具清单不变
	r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusConflict)

	// 暂停：测试照样做，状态保持 paused；重新启用回到 connecting
	r.call("PATCH", "/api/connectors/"+id, `{"enabled":false,"secrets":{"token":"`+tok+`"}}`, http.StatusOK)
	res = r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK)
	if res["ok"] != true || res["connector"].(map[string]any)["status"] != "paused" {
		t.Fatalf("paused test = %v", res)
	}
	if e := r.call("PATCH", "/api/connectors/"+id, `{"enabled":true}`, http.StatusOK); e["status"] != "connecting" || e["error"] != "" {
		t.Fatalf("re-enable = %v", e)
	}

	list := r.call("GET", "/api/connectors?tool=fake", "", http.StatusOK)
	if n := len(list["data"].([]any)); n != 1 {
		t.Fatalf("list = %v", list)
	}

	// 审计：配置类，凭证只记「已设置」「已清除」
	auds := r.call("GET", "/api/audits?target_type=connector", "", http.StatusOK)
	actions := map[string]int{}
	for _, x := range auds["data"].([]any) {
		a := x.(map[string]any)
		if a["kind"] != "config" {
			t.Errorf("audit kind = %v", a["kind"])
		}
		actions[a["action"].(string)]++
	}
	// create 两条：第二个实例接上又删掉了
	if actions["create"] != 2 || actions["delete"] != 1 || actions["update"] < 4 || actions["set_tool_modes"] != 1 {
		t.Fatalf("audit actions = %v", actions)
	}

	del := r.call("DELETE", "/api/connectors/"+id, "", http.StatusOK)
	if del["id"] != id {
		t.Fatalf("delete = %v", del)
	}
	r.call("GET", "/api/connectors/"+id, "", http.StatusNotFound)
	if _, err := v.Resolve(ctx, cn.SecretID); err == nil {
		t.Error("删除后保险箱条目应该一起删掉")
	}
	auds = r.call("GET", "/api/audits?target_type=connector&action=delete&target_id="+id, "", http.StatusOK)
	if len(auds["data"].([]any)) != 1 {
		t.Fatalf("delete audit = %v", auds)
	}

	// 扫全部响应：没有任何一个 token 明文
	for i, b := range r.bodies {
		for _, secret := range []string{tok, tok2, bad} {
			if strings.Contains(b, secret) {
				t.Fatalf("响应 %d 里有凭证明文：%s", i, b)
			}
		}
	}
}

func TestConnectorsNotConfigured(t *testing.T) {
	s := New(nil, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	for _, p := range []string{"/api/connectors", "/api/connectors/defs"} {
		w := do(s, "GET", p, "")
		mustCode(t, w, http.StatusInternalServerError, p)
		if !strings.Contains(w.Body.String(), "connectors are not configured") {
			t.Errorf("%s: %s", p, w.Body.String())
		}
	}
}

func TestConnectorMissingDefinition(t *testing.T) {
	r, v, d := newConnectorServer(t)
	c := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	id := c["id"].(string)
	// 换一个没有这个定义的服务端，模拟提供定义的插件停用了
	r.s.opt.Connectors = connector.New(d, v, connector.NewRegistry())
	r.s = New(r.s.st, r.s.opt)
	g := r.call("GET", "/api/connectors/"+id, "", http.StatusOK)
	if g["available"] != false {
		t.Fatalf("available = %v", g["available"])
	}
	r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusConflict)
	r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusConflict)
	r.call("PATCH", "/api/connectors/"+id, `{"config":{"base_url":"x"}}`, http.StatusConflict)
	if p := r.call("PATCH", "/api/connectors/"+id, `{"name":"改名"}`, http.StatusOK); p["name"] != "改名" {
		t.Fatalf("rename = %v", p)
	}
	r.call("DELETE", "/api/connectors/"+id, "", http.StatusOK)
}
