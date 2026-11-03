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
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
	"github.com/lizhao903/pm-workspace/internal/webhook"
)

// newWebhookServer 用真库、真保险箱和审计：要验证的是整条链路上漏不出密钥明文。
func newWebhookServer(t *testing.T) (*Server, *vault.Vault) {
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
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	ws := audit.WrapStore(st, al)
	return New(ws, Options{Version: "test", Logger: log, Vault: v, Audit: al, Webhooks: webhook.New(st.DB(), v)}), v
}

const hookBody = `{"name":" Sentry 线上告警 ","mapping":{"title":" event.title ","desc":"event.culprit","priority":"level","assignee":"","due":""},
	"filter":"action == created","dedupe":"event.id","defaults":{"priority":"P1","assignee":"周屿"},"sample":"{\"action\":\"created\"}"}`

func createHook(t *testing.T, s *Server, body string) (data map[string]any, raw string) {
	t.Helper()
	w := do(s, "POST", "/api/webhooks", body)
	mustCode(t, w, http.StatusCreated, "create webhook")
	return decodeEnvelope(t, w)["data"].(map[string]any), w.Body.String()
}

func TestWebhookSecretShownOnce(t *testing.T) {
	s, v := newWebhookServer(t)
	ctx := context.Background()
	h, _ := createHook(t, s, hookBody)
	id := h["id"].(string)
	plain, _ := h["secret"].(string)
	if !strings.HasPrefix(id, "wh_") || h["name"] != "Sentry 线上告警" || h["enabled"] != true {
		t.Fatalf("create = %v", h)
	}
	if !strings.HasPrefix(plain, "whsec_") || len(plain) != 49 {
		t.Fatalf("新建时应给一次服务端生成的明文，得到 %q", plain)
	}
	if hint := h["secret_hint"].(string); hint != plain[:3]+"…"+plain[len(plain)-4:] {
		t.Fatalf("secret_hint = %q", hint)
	}
	if m := h["mapping"].(map[string]any); m["title"] != "event.title" {
		t.Errorf("mapping 没去空白：%v", m)
	}
	if tok := h["token"].(string); len(tok) != 24 || strings.ToLower(tok) != tok {
		t.Errorf("token = %q", tok)
	}

	// 明文确实进了保险箱，表里只有引用
	wh, err := s.opt.Webhooks.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := v.Resolve(ctx, wh.SecretID); err != nil || got != plain {
		t.Fatalf("resolve = %v", err)
	}

	// 之后的读接口一律没有明文，也没有 secret 字段
	reads := []struct{ method, path, body string }{
		{"GET", "/api/webhooks", ""},
		{"GET", "/api/webhooks/" + id, ""},
		{"PATCH", "/api/webhooks/" + id, `{"name":"改个名","enabled":false}`},
		{"GET", "/api/webhooks/" + id + "/usage", ""},
		{"GET", "/api/secrets", ""},
		{"GET", "/api/audits", ""},
	}
	for _, rq := range reads {
		w := do(s, rq.method, rq.path, rq.body)
		mustCode(t, w, http.StatusOK, rq.method+" "+rq.path)
		if strings.Contains(w.Body.String(), plain) || strings.Contains(w.Body.String(), plain[6:30]) {
			t.Errorf("%s %s 的响应里搜到了明文", rq.method, rq.path)
		}
		// 审计的 detail.secret 是「已设置」这类提示，不算
		if rq.path != "/api/audits" && strings.Contains(w.Body.String(), `"secret":"`) {
			t.Errorf("%s %s 的响应里有 secret 字段：%s", rq.method, rq.path, w.Body.String())
		}
	}

	// 轮换：新明文只给这一次，旧的随即失效
	w := do(s, "POST", "/api/webhooks/"+id+"/rotate-secret", "")
	mustCode(t, w, http.StatusOK, "rotate")
	r := decodeEnvelope(t, w)["data"].(map[string]any)
	plain2, _ := r["secret"].(string)
	if plain2 == "" || plain2 == plain || r["secret_version"] != float64(2) || r["secret_rotated_at"] == nil {
		t.Fatalf("rotate = %v", r)
	}
	if got, _ := v.Resolve(ctx, wh.SecretID); got != plain2 {
		t.Fatal("轮换后保险箱里不是新值")
	}
	if w := do(s, "GET", "/api/webhooks/"+id, ""); strings.Contains(w.Body.String(), plain2) {
		t.Fatal("轮换后详情带出了新明文")
	}

	// 自带密钥：不回显
	own := "my-own-signing-secret-0001"
	w = do(s, "POST", "/api/webhooks/"+id+"/rotate-secret", `{"secret":"`+own+`"}`)
	mustCode(t, w, http.StatusOK, "rotate own")
	if strings.Contains(w.Body.String(), own) || strings.Contains(w.Body.String(), `"secret":"`) {
		t.Fatalf("自带的密钥被回显了：%s", w.Body.String())
	}
	if got, _ := v.Resolve(ctx, wh.SecretID); got != own {
		t.Fatal("自带密钥没存进去")
	}
	_, raw := createHook(t, s, `{"name":"自带","mapping":{"title":"t"},"secret":"`+own+`-b"}`)
	if strings.Contains(raw, own) || strings.Contains(raw, `"secret":"`) {
		t.Fatalf("新建时自带的密钥被回显了：%s", raw)
	}

	// 审计里也没有明文
	w = do(s, "GET", "/api/audits?target_type=webhook", "")
	body := w.Body.String()
	for _, p := range []string{plain, plain2, own} {
		if strings.Contains(body, p) {
			t.Fatal("审计里带了明文")
		}
	}
	if n := int(decodeEnvelope(t, w)["meta"].(map[string]any)["total"].(float64)); n != 5 {
		t.Errorf("审计 %d 条，期望 5（建两次、改一次、轮换两次）：%s", n, body)
	}
}

func TestWebhookValidation(t *testing.T) {
	s, _ := newWebhookServer(t)
	for _, body := range []string{
		`{"mapping":{"title":"a"}}`,
		`{"name":"x","mapping":{"title":""}}`,
		`{"name":"x","mapping":{"title":"a b"}}`,
		`{"name":"x","mapping":{"title":"a"},"filter":"action is opened"}`,
		`{"name":"x","mapping":{"title":"a"},"secret":"short"}`,
		`{"name":"x","mapping":{"title":"a"},"secret":" padded-secret-0000000 "}`,
	} {
		if w := do(s, "POST", "/api/webhooks", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", body, w.Code, w.Body.String())
		}
	}
	h, _ := createHook(t, s, `{"name":"x","mapping":{"title":"a"}}`)
	id := h["id"].(string)
	if d := h["defaults"].(map[string]any); d["priority"] != "P2" {
		t.Errorf("默认优先级 = %v", d)
	}
	for _, body := range []string{`{"secret":"abcdefghijklmnopqrstu"}`, `{"token":"x"}`, `{"mapping":{"desc":"a"}}`} {
		if w := do(s, "PATCH", "/api/webhooks/"+id, body); w.Code != http.StatusBadRequest {
			t.Errorf("PATCH %s = %d", body, w.Code)
		}
	}
	if w := do(s, "GET", "/api/webhooks/wh_nope", ""); w.Code != http.StatusNotFound {
		t.Errorf("get missing = %d", w.Code)
	}
}

func TestWebhookDeleteImpact(t *testing.T) {
	s, v := newWebhookServer(t)
	ctx := context.Background()
	h, _ := createHook(t, s, hookBody)
	id := h["id"].(string)
	wh, _ := s.opt.Webhooks.Get(ctx, id)

	mk := func(status, hook string) string {
		w := do(s, "POST", "/api/objects", `{"type_id":"task","title":"告警","status":"`+status+`","source":"webhook",
			"props":{"source_ref":{"hook_id":"`+hook+`","delivery_id":"dl_1"}}}`)
		mustCode(t, w, http.StatusCreated, "create task")
		return decodeEnvelope(t, w)["data"].(map[string]any)["id"].(string)
	}
	mk("todo", id)
	mk("done", id)
	gone := mk("doing", id)
	mk("todo", "wh_other")
	if w := do(s, "DELETE", "/api/objects/"+gone, ""); w.Code != http.StatusOK {
		t.Fatalf("delete task = %d", w.Code)
	}

	w := do(s, "GET", "/api/webhooks/"+id+"/usage", "")
	mustCode(t, w, http.StatusOK, "usage")
	u := decodeEnvelope(t, w)["data"].(map[string]any)
	if u["tasks"] != float64(2) || u["open_tasks"] != float64(1) {
		t.Fatalf("usage = %v", u)
	}

	w = do(s, "DELETE", "/api/webhooks/"+id, "")
	mustCode(t, w, http.StatusOK, "delete")
	if d := decodeEnvelope(t, w)["data"].(map[string]any); d["tasks"] != float64(2) {
		t.Fatalf("delete = %v", d)
	}
	if w := do(s, "GET", "/api/webhooks/"+id, ""); w.Code != http.StatusNotFound {
		t.Fatalf("删后 get = %d", w.Code)
	}
	if _, err := v.Resolve(ctx, wh.SecretID); err == nil {
		t.Fatal("删 Webhook 后保险箱里的密钥还在")
	}
	if w := do(s, "GET", "/api/objects?type=task&source=webhook", ""); decodeEnvelope(t, w)["meta"].(map[string]any)["total"] != float64(3) {
		t.Fatalf("建出来的任务应保留：%s", w.Body.String())
	}
	w = do(s, "GET", "/api/audits?target_type=webhook&action=delete", "")
	if !strings.Contains(w.Body.String(), `"tasks":2`) {
		t.Errorf("删除审计没带影响：%s", w.Body.String())
	}
	if w := do(s, "DELETE", "/api/webhooks/"+id, ""); w.Code != http.StatusNotFound {
		t.Errorf("重复删 = %d", w.Code)
	}
}

// 保险箱条目被单独删掉：Webhook 还在、提示为空，轮换一次补上。
func TestWebhookSecretRemovedFromVault(t *testing.T) {
	s, v := newWebhookServer(t)
	ctx := context.Background()
	h, _ := createHook(t, s, `{"name":"x","mapping":{"title":"a"}}`)
	id := h["id"].(string)
	wh, _ := s.opt.Webhooks.Get(ctx, id)
	if w := do(s, "DELETE", "/api/secrets/"+wh.SecretID, ""); w.Code != http.StatusOK {
		t.Fatalf("delete secret = %d", w.Code)
	}
	g := decodeEnvelope(t, do(s, "GET", "/api/webhooks/"+id, ""))["data"].(map[string]any)
	if g["secret_hint"] != "" || g["secret_version"] != float64(0) {
		t.Fatalf("get = %v", g)
	}
	w := do(s, "POST", "/api/webhooks/"+id+"/rotate-secret", "{}")
	mustCode(t, w, http.StatusOK, "rotate")
	r := decodeEnvelope(t, w)["data"].(map[string]any)
	if r["secret_version"] != float64(1) || r["secret"] == nil {
		t.Fatalf("rotate = %v", r)
	}
	wh2, _ := s.opt.Webhooks.Get(ctx, id)
	if got, err := v.Resolve(ctx, wh2.SecretID); err != nil || got != r["secret"] {
		t.Fatalf("补上的密钥取不到：%v", err)
	}
}

func TestWebhooksNotConfigured(t *testing.T) {
	s := New(newFakeStore(), Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	w := do(s, "GET", "/api/webhooks", "")
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "webhooks are not configured") {
		t.Fatalf("= %d %s", w.Code, w.Body.String())
	}
}
