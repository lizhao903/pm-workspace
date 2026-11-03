package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// plainKey 是所有测试共用的「明文」。断言一律搜它：只要它出现在响应体里就算漏。
const plainKey = "sk-proj-LEAKCANARY-f3a2"

func seedProviders(f *fakeStore) {
	f.putProvider(&domain.AgentProvider{
		ID: "apv_openai", Name: "OpenAI", Kind: domain.ProviderOpenAI,
		BaseURL: "https://api.openai.com/v1", Model: "gpt-4o",
		Enabled: true, IsDefault: true, Extra: map[string]any{},
	}, plainKey)
	f.putProvider(&domain.AgentProvider{
		ID: "apv_ollama", Name: "本地 Ollama", Kind: domain.ProviderOllama,
		BaseURL: "http://localhost:11434", Enabled: true, Extra: map[string]any{},
	}, "")
}

// dataObj 把信封里的 data 取成对象。
func dataObj(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	m := decodeEnvelope(t, w)
	obj, ok := m["data"].(map[string]any)
	if !ok {
		t.Fatalf("data 不是对象: %s", w.Body.String())
	}
	return obj
}

// assertNoPlaintextKey 直接在序列化后的 JSON 上搜原文，这是最后一道闸。
func assertNoPlaintextKey(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if body := w.Body.String(); strings.Contains(body, plainKey) || strings.Contains(body, "LEAKCANARY") {
		t.Fatalf("响应体里出现了明文密钥: %s", body)
	}
}

func TestListProvidersMasksKey(t *testing.T) {
	f := newFakeStore()
	seedProviders(f)
	w := do(newTestServer(f), http.MethodGet, "/api/agent-providers", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	assertNoPlaintextKey(t, w)

	arr := dataList(t, w)
	if len(arr) != 2 {
		t.Fatalf("供应商数 = %d, 期望 2", len(arr))
	}
	byID := map[string]map[string]any{}
	for _, it := range arr {
		obj := it.(map[string]any)
		byID[obj["id"].(string)] = obj
	}
	first := byID["apv_openai"]
	if first["api_key_masked"] != "sk-…f3a2" {
		t.Errorf("api_key_masked = %v, 期望 sk-…f3a2", first["api_key_masked"])
	}
	if first["has_api_key"] != true {
		t.Errorf("has_api_key = %v, 期望 true", first["has_api_key"])
	}
	// 响应体里压根不该有 api_key 这个字段名。
	if _, ok := first["api_key"]; ok {
		t.Error("响应体里出现了 api_key 字段")
	}
	// 没配密钥的那条，脱敏字段该是空串 + false。
	if ollama := byID["apv_ollama"]; ollama["api_key_masked"] != "" || ollama["has_api_key"] != false {
		t.Errorf("没有密钥时 masked=%v has=%v, 期望空串/false",
			ollama["api_key_masked"], ollama["has_api_key"])
	}
}

func TestCreateProviderDoesNotEchoKey(t *testing.T) {
	f := newFakeStore()
	body := `{"name":"OpenAI","kind":"openai","model":"gpt-4o","api_key":"` + plainKey + `"}`
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	assertNoPlaintextKey(t, w)

	if f.lastProviderKey != plainKey {
		t.Errorf("传给 store 的 api_key = %q, 期望原样透传", f.lastProviderKey)
	}
	obj := dataObj(t, w)
	if obj["api_key_masked"] != "sk-…f3a2" || obj["has_api_key"] != true {
		t.Errorf("创建响应的脱敏字段不对: %v / %v", obj["api_key_masked"], obj["has_api_key"])
	}
	// 没传 enabled 时默认启用。
	if obj["enabled"] != true {
		t.Errorf("enabled = %v, 期望新建默认启用", obj["enabled"])
	}
}

func TestCreateProviderRespectsExplicitEnabled(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers",
		`{"name":"停用的","kind":"ollama","enabled":false}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if dataObj(t, w)["enabled"] != false {
		t.Error("显式传 enabled=false 被忽略了")
	}
}

func TestCreateProviderErrorMapping(t *testing.T) {
	f := newFakeStore()
	f.errCreateProvider = domain.ErrValidation
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers", `{"name":"x","kind":"bedrock"}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	// 空 body 也走 400，而不是撞进 store。
	w = do(newTestServer(newFakeStore()), http.MethodPost, "/api/agent-providers", "")
	assertError(t, w, http.StatusBadRequest, "validation")
}

// TestUpdateProviderAPIKeyTriState 只验协议层的三态解析，覆盖规则本身在 store 测。
func TestUpdateProviderAPIKeyTriState(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantNil bool
		want    string
	}{
		{"不传即不改", `{"name":"改名"}`, true, ""},
		{"空串即清除", `{"api_key":""}`, false, ""},
		{"有值即覆盖", `{"api_key":"` + plainKey + `"}`, false, plainKey},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeStore()
			seedProviders(f)
			w := do(newTestServer(f), http.MethodPatch, "/api/agent-providers/apv_openai", c.body)
			if w.Code != http.StatusOK {
				t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
			}
			assertNoPlaintextKey(t, w)

			got := f.lastProviderInput.APIKey
			if c.wantNil {
				if got != nil {
					t.Fatalf("api_key 应为 nil（不改），got %q", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("api_key 不该是 nil")
			}
			if *got != c.want {
				t.Errorf("api_key = %q, 期望 %q", *got, c.want)
			}
		})
	}
}

// 传 null 会被拒：手滑的 null 不该静默清掉密钥。
func TestUpdateProviderRejectsNullAPIKey(t *testing.T) {
	f := newFakeStore()
	seedProviders(f)
	w := do(newTestServer(f), http.MethodPatch, "/api/agent-providers/apv_openai", `{"api_key":null}`)
	assertError(t, w, http.StatusBadRequest, "validation")
}

func TestUpdateProviderNotFound(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPatch, "/api/agent-providers/apv_nope", `{"name":"x"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestDeleteProvider(t *testing.T) {
	f := newFakeStore()
	seedProviders(f)
	s := newTestServer(f)
	if w := do(s, http.MethodDelete, "/api/agent-providers/apv_ollama", ""); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastProviderDelID != "apv_ollama" {
		t.Errorf("删除的 id = %q", f.lastProviderDelID)
	}
	assertError(t, do(s, http.MethodDelete, "/api/agent-providers/apv_ollama", ""),
		http.StatusNotFound, "not_found")
}

// TestProviderRouteOrder 确认 {id}/default 与 {id}/test 没被 {id} 吃掉，
// 也没把 "default" / "test" 当成一个供应商 id。
func TestProviderRouteOrder(t *testing.T) {
	f := newFakeStore()
	seedProviders(f)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent-providers/apv_ollama/default", "")
	if w.Code != http.StatusOK {
		t.Fatalf("set default 状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastProviderDefID != "apv_ollama" {
		t.Errorf("SetDefaultProvider 收到的 id = %q, 期望 apv_ollama", f.lastProviderDefID)
	}
	obj := dataObj(t, w)
	if obj["is_default"] != true {
		t.Error("设为默认后返回的记录 is_default 不是 true")
	}
	if obj["id"] != "apv_ollama" {
		t.Errorf("返回的 id = %v, 期望 apv_ollama（说明 default 被当成了 id）", obj["id"])
	}

	// PATCH 仍然落在 update 上。
	if w := do(s, http.MethodPatch, "/api/agent-providers/apv_openai", `{"name":"改名"}`); w.Code != http.StatusOK {
		t.Fatalf("patch 状态码 = %d", w.Code)
	}
	// 不存在的子路径回 JSON 404，而不是掉进 SPA fallback。
	assertError(t, do(s, http.MethodPost, "/api/agent-providers/apv_openai/nope", ""),
		http.StatusNotFound, "not_found")
}

func TestSetDefaultProviderNotFound(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/apv_nope/default", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

// --- 测试连接 ---

// stubProvider 把供应商指向一个打桩的上游，避免测试真连外网。
func stubProvider(t *testing.T, f *fakeStore, kind, key string, h http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	id := "apv_" + kind
	f.putProvider(&domain.AgentProvider{
		ID: id, Name: kind, Kind: kind, BaseURL: srv.URL, Enabled: true, Extra: map[string]any{},
	}, key)
	return id
}

func TestTestProviderOpenAI(t *testing.T) {
	f := newFakeStore()
	var gotPath, gotAuth string
	id := stubProvider(t, f, domain.ProviderOpenAI, plainKey, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"gpt-4o"},{"id":"o3-mini"}]}`))
	})

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if gotPath != "/models" {
		t.Errorf("探测路径 = %q, 期望 /models", gotPath)
	}
	if gotAuth != "Bearer "+plainKey {
		t.Errorf("Authorization = %q, 期望 Bearer + 明文密钥", gotAuth)
	}
	// 密钥进了请求头，但不许回到响应体里。
	assertNoPlaintextKey(t, w)

	obj := dataObj(t, w)
	if obj["ok"] != true {
		t.Fatalf("ok = %v (%s)", obj["ok"], w.Body.String())
	}
	models, _ := obj["models"].([]any)
	if len(models) != 2 || models[0] != "gpt-4o" {
		t.Errorf("models = %v, 期望 [gpt-4o o3-mini]", models)
	}
}

func TestTestProviderGeminiPassesKeyInQuery(t *testing.T) {
	f := newFakeStore()
	var gotKey, gotPath string
	id := stubProvider(t, f, domain.ProviderGemini, plainKey, func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath = r.URL.Query().Get("key"), r.URL.Path
		_, _ = w.Write([]byte(`{"models":[{"name":"models/gemini-2.0-flash"}]}`))
	})

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
	if gotPath != "/models" || gotKey != plainKey {
		t.Fatalf("探测请求 path=%q key=%q", gotPath, gotKey)
	}
	assertNoPlaintextKey(t, w)

	obj := dataObj(t, w)
	models, _ := obj["models"].([]any)
	// models/ 前缀要剥掉，前端下拉里显示的才是模型名本身。
	if len(models) != 1 || models[0] != "gemini-2.0-flash" {
		t.Errorf("models = %v, 期望 [gemini-2.0-flash]", models)
	}
}

func TestTestProviderOllamaNeedsNoKey(t *testing.T) {
	f := newFakeStore()
	var gotPath, gotAuth string
	id := stubProvider(t, f, domain.ProviderOllama, "", func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"models":[{"name":"llama3:8b"},{"name":"qwen2.5:7b"}]}`))
	})

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
	if gotPath != "/api/tags" {
		t.Errorf("探测路径 = %q, 期望 /api/tags", gotPath)
	}
	if gotAuth != "" {
		t.Errorf("ollama 不该带 Authorization, got %q", gotAuth)
	}
	obj := dataObj(t, w)
	if obj["ok"] != true {
		t.Fatalf("ok = %v (%s)", obj["ok"], w.Body.String())
	}
	models, _ := obj["models"].([]any)
	if len(models) != 2 || models[1] != "qwen2.5:7b" {
		t.Errorf("models = %v", models)
	}
}

func TestTestProviderAnthropic(t *testing.T) {
	f := newFakeStore()
	var gotPath, gotLimit, gotKey, gotVersion, gotAuth string
	id := stubProvider(t, f, domain.ProviderAnthropic, plainKey, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotLimit = r.URL.Path, r.URL.Query().Get("limit")
		gotKey, gotVersion = r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"data":[{"type":"model","id":"claude-opus-4-1","display_name":"Claude Opus 4.1"},` +
			`{"type":"model","id":"claude-haiku-4-5","display_name":"Claude Haiku 4.5"}],"has_more":false}`))
	})

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	// base_url 默认不带 /v1，探测时补上。
	if gotPath != "/v1/models" || gotLimit != "1000" {
		t.Errorf("探测路径 = %q limit=%q, 期望 /v1/models limit=1000", gotPath, gotLimit)
	}
	if gotKey != plainKey || gotVersion == "" || gotAuth != "" {
		t.Errorf("鉴权头 x-api-key=%q anthropic-version=%q Authorization=%q", gotKey, gotVersion, gotAuth)
	}
	assertNoPlaintextKey(t, w)

	obj := dataObj(t, w)
	if obj["ok"] != true {
		t.Fatalf("ok = %v (%s)", obj["ok"], w.Body.String())
	}
	models, _ := obj["models"].([]any)
	if len(models) != 2 || models[0] != "claude-opus-4-1" {
		t.Errorf("models = %v", models)
	}
}

// TestTestProviderDeepSeek：DeepSeek 是 openai 协议加 preset，探测走的就是 openai 那一路。
func TestTestProviderDeepSeek(t *testing.T) {
	f := newFakeStore()
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"deepseek-chat","object":"model","owned_by":"deepseek"},` +
			`{"id":"deepseek-reasoner","object":"model","owned_by":"deepseek"}]}`))
	}))
	t.Cleanup(srv.Close)
	f.putProvider(&domain.AgentProvider{
		ID: "apv_deepseek", Name: "DeepSeek", Kind: domain.ProviderOpenAI, BaseURL: srv.URL, Enabled: true,
		Extra: map[string]any{"preset": domain.ProviderPresetDeepSeek},
	}, plainKey)

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/apv_deepseek/test", "")
	if gotPath != "/models" || gotAuth != "Bearer "+plainKey {
		t.Errorf("探测请求 path=%q auth=%q", gotPath, gotAuth)
	}
	assertNoPlaintextKey(t, w)
	obj := dataObj(t, w)
	models, _ := obj["models"].([]any)
	if obj["ok"] != true || len(models) != 2 || models[1] != "deepseek-reasoner" {
		t.Errorf("结果 = %v", obj)
	}
}

// TestTestProviderFailureMessagesAreSanitized 是脱敏要求在 /test 上的落点：
// 上游把带 key 的 URL 原样回显时，这条 message 也不能把它带出去。
func TestTestProviderFailureMessagesAreSanitized(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   string
	}{
		{"401 认证失败", http.StatusUnauthorized, "认证失败"},
		{"403 认证失败", http.StatusForbidden, "认证失败"},
		{"404 端点不存在", http.StatusNotFound, "端点不存在"},
		{"429 限流", http.StatusTooManyRequests, "限流"},
		{"500 上游异常", http.StatusInternalServerError, "上游服务异常"},
		{"418 其它", http.StatusTeapot, "请求被拒绝"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeStore()
			status := c.status
			id := stubProvider(t, f, domain.ProviderGemini, plainKey, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				// 上游把整条 URL（含 query 上的 key）回显回来，这是 Gemini 的真实行为。
				_, _ = w.Write([]byte(`{"error":{"message":"API key not valid: ` + r.URL.String() + `"}}`))
			})

			w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
			if w.Code != http.StatusOK {
				t.Fatalf("探测失败不该变成 HTTP 错误, 状态码 = %d", w.Code)
			}
			assertNoPlaintextKey(t, w)

			obj := dataObj(t, w)
			if obj["ok"] != false {
				t.Errorf("ok = %v, 期望 false", obj["ok"])
			}
			msg, _ := obj["message"].(string)
			if !strings.Contains(msg, c.want) {
				t.Errorf("message = %q, 期望包含 %q", msg, c.want)
			}
			// 上游原文一个字都不该进来。
			if strings.Contains(msg, "API key not valid") || strings.Contains(msg, "http") {
				t.Errorf("message 里混进了上游原文或 URL: %q", msg)
			}
		})
	}
}

func TestTestProviderUnreachable(t *testing.T) {
	f := newFakeStore()
	// 起一个立刻关掉的服务，拿到一个必然连不上的地址。
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.URL
	srv.Close()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_dead", Name: "连不上", Kind: domain.ProviderOllama,
		BaseURL: addr, Enabled: true, Extra: map[string]any{},
	}, "")

	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/apv_dead/test", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	obj := dataObj(t, w)
	if obj["ok"] != false {
		t.Fatalf("ok = %v, 期望 false", obj["ok"])
	}
	msg, _ := obj["message"].(string)
	if !strings.Contains(msg, "无法连接") {
		t.Errorf("message = %q, 期望归类成「无法连接」", msg)
	}
	// url.Error 的原文会把整个地址拼进去，这里必须已经被丢掉。
	if strings.Contains(msg, addr) || strings.Contains(msg, "dial") {
		t.Errorf("message 里混进了传输层原始错误: %q", msg)
	}
}

func TestTestProviderGarbageResponse(t *testing.T) {
	f := newFakeStore()
	id := stubProvider(t, f, domain.ProviderOpenAI, plainKey, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html>nginx 欢迎页</html>`))
	})
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/"+id+"/test", "")
	obj := dataObj(t, w)
	if obj["ok"] != false {
		t.Fatalf("ok = %v, 期望 false", obj["ok"])
	}
	if msg, _ := obj["message"].(string); !strings.Contains(msg, "模型列表") {
		t.Errorf("message = %q, 期望提示返回的不是模型列表", msg)
	}
}

func TestTestProviderMissingKey(t *testing.T) {
	f := newFakeStore()
	// openai 却没有密钥：不发请求，直接说清缺什么。
	f.putProvider(&domain.AgentProvider{
		ID: "apv_nokey", Name: "没配密钥", Kind: domain.ProviderOpenAI,
		BaseURL: "https://api.openai.com/v1", Enabled: true, Extra: map[string]any{},
	}, "")
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/apv_nokey/test", "")
	obj := dataObj(t, w)
	if obj["ok"] != false {
		t.Fatalf("ok = %v, 期望 false", obj["ok"])
	}
	if msg, _ := obj["message"].(string); !strings.Contains(msg, "API Key") {
		t.Errorf("message = %q, 期望提示尚未配置 API Key", msg)
	}
}

func TestTestProviderNotFound(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPost, "/api/agent-providers/apv_nope/test", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}
