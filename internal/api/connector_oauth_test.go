package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/connector/oauthfake"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// newOAuthServer 同 newConnectorServer，登记 fake_oauth，回调地址改成本机测试端口。
func newOAuthServer(t *testing.T) (*connRec, *connector.Store) {
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
	if err := defs.Register(connector.FakeOAuth()); err != nil {
		t.Fatal(err)
	}
	cs := connector.New(st.DB(), v, defs)
	if err := cs.SetPublicURL("http://127.0.0.1:7797"); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	s := New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Vault: v, Audit: al, Connectors: cs})
	return &connRec{t: t, s: s}, cs
}

func TestConnectorOAuthRoutes(t *testing.T) {
	r, _ := newOAuthServer(t)
	fs := oauthfake.New(3600)
	defer fs.Close()

	defs := r.call("GET", "/api/connectors/defs", "", http.StatusOK)
	d := defs["data"].([]any)[0].(map[string]any)
	if o := d["oauth"].(map[string]any); o["token_url"] != "/token" || o["base_url_field"] != "base_url" ||
		o["client_id_field"] != "client_id" || o["builtin"] != false {
		t.Fatalf("定义里的 oauth = %v", d["oauth"])
	}

	c := r.call("POST", "/api/connectors", `{"tool":"fake_oauth","config":{"base_url":"`+fs.URL+`","client_id":"`+fs.ClientID+
		`"},"secrets":{"client_secret":"`+fs.ClientSecret+`"}}`, http.StatusCreated)
	id := c["id"].(string)
	if o := c["oauth"].(map[string]any); o["authorized_at"] != nil {
		t.Fatalf("新建 oauth = %v", o)
	}

	r.call("POST", "/api/connectors/"+id+"/oauth/start", `{"return_to":"https://evil.test/"}`, http.StatusBadRequest)
	st := r.call("POST", "/api/connectors/"+id+"/oauth/start", `{"return_to":"/settings/connectors?tab=api"}`, http.StatusOK)
	if st["redirect_uri"] != "http://127.0.0.1:7797/api/connectors/oauth/callback" {
		t.Fatalf("redirect_uri = %v", st["redirect_uri"])
	}
	loc, err := oauthfake.Authorize(st["authorize_url"].(string))
	if err != nil {
		t.Fatal(err)
	}

	// state 不匹配：400 结果页，不跳转
	w := do(r.s, "GET", "/api/connectors/oauth/callback?state=forged&code=x", "")
	mustCode(t, w, http.StatusBadRequest, "forged state")
	if !strings.Contains(w.Body.String(), "授权链接无效") || w.Header().Get("Location") != "" {
		t.Fatalf("forged = %s", w.Body.String())
	}

	// 正确回调：302 回到 return_to，带上结果
	cb := "/api/connectors/oauth/callback?" + loc.RawQuery
	w = do(r.s, "GET", cb, "")
	mustCode(t, w, http.StatusFound, "callback")
	back, _ := url.Parse(w.Header().Get("Location"))
	if back.Path != "/settings/connectors" || back.Query().Get("tab") != "api" || back.Query().Get("oauth") != "ok" ||
		back.Query().Get("connector") != id {
		t.Fatalf("跳回 = %s", back)
	}
	// 重放：400
	mustCode(t, do(r.s, "GET", cb, ""), http.StatusBadRequest, "replay")

	got := r.call("GET", "/api/connectors/"+id, "", http.StatusOK)
	if got["status"] != "connected" || got["account"] != "octo" || got["oauth"].(map[string]any)["expires_at"] == nil {
		t.Fatalf("授权后 = %v", got)
	}

	// 没给 return_to：回调直接显示结果页
	st = r.call("POST", "/api/connectors/"+id+"/oauth/start", "", http.StatusOK)
	loc, _ = oauthfake.Authorize(st["authorize_url"].(string))
	w = do(r.s, "GET", "/api/connectors/oauth/callback?"+loc.RawQuery, "")
	mustCode(t, w, http.StatusOK, "callback page")
	if !strings.Contains(w.Body.String(), "授权完成") || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("结果页 = %s", w.Body.String())
	}

	// 手动刷新成功；对方吊销后刷新失败：200 + ok=false，状态变 error
	res := r.call("POST", "/api/connectors/"+id+"/oauth/refresh", "", http.StatusOK)
	if res["ok"] != true {
		t.Fatalf("refresh = %v", res)
	}
	fs.SetFailRefresh(true)
	res = r.call("POST", "/api/connectors/"+id+"/oauth/refresh", "", http.StatusOK)
	if cn := res["connector"].(map[string]any); res["ok"] != false || cn["status"] != "error" ||
		!strings.Contains(cn["error"].(string), "令牌刷新失败") {
		t.Fatalf("refresh 失败 = %v", res)
	}

	dis := r.call("POST", "/api/connectors/"+id+"/disconnect", "", http.StatusOK)
	if dis["status"] != "disconnected" || dis["oauth"].(map[string]any)["authorized_at"] != nil {
		t.Fatalf("disconnect = %v", dis)
	}
	// 断开后重新启用：回到 connecting，等重新授权
	re := r.call("PATCH", "/api/connectors/"+id, `{"enabled":true}`, http.StatusOK)
	if re["status"] != "connecting" {
		t.Fatalf("重新启用 = %v", re["status"])
	}
	r.call("POST", "/api/connectors/cn_nope/oauth/start", "", http.StatusNotFound)

	// 审计：授权和断开记 config，凭证只有「已设置」「已清除」；发起和刷新不记
	auds := r.call("GET", "/api/audits?target_type=connector", "", http.StatusOK)
	actions := map[string]int{}
	for _, x := range auds["data"].([]any) {
		a := x.(map[string]any)
		actions[a["action"].(string)]++
		if a["action"] == "oauth_authorize" {
			sec := a["detail"].(map[string]any)["secrets"].(map[string]any)
			if sec["access_token"] != audit.SecretSet || sec["refresh_token"] != audit.SecretSet {
				t.Fatalf("授权审计 = %v", a["detail"])
			}
		}
	}
	if actions["oauth_authorize"] != 2 || actions["disconnect"] != 1 || actions["create"] != 1 {
		t.Fatalf("审计 = %v", actions)
	}

	// 扫全部 JSON 响应：没有令牌和 client_secret 明文
	// 假服务签的令牌都以这两个尾巴结尾，扫尾巴就覆盖了历次签发的
	for i, b := range r.bodies {
		for _, secret := range []string{"-abcdefghijklmnop", "-qrstuvwxyz012345", fs.ClientSecret} {
			if strings.Contains(b, secret) {
				t.Fatalf("响应 %d 里有凭证明文 %q：%s", i, secret, b)
			}
		}
	}
}
