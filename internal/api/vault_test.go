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

	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

const vaultPlain = "sk-test-123"

// newVaultServer 用真库和真保险箱起服务：要验证的是「整条链路上哪里都漏不出明文」，
// fakeStore 替不了。主密钥走临时目录下的密钥文件，不碰钥匙串。
func newVaultServer(t *testing.T) (*Server, *vault.Vault) {
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
	s := New(st, Options{
		Version: "test",
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		Vault:   v,
	})
	return s, v
}

func createSecret(t *testing.T, s *Server, body string) string {
	t.Helper()
	w := do(s, "POST", "/api/secrets", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), vaultPlain) {
		t.Fatalf("新建的响应里带了明文: %s", w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if _, ok := data["value"]; ok {
		t.Fatal("响应里不该有 value 字段")
	}
	return data["id"].(string)
}

// TestNoGetRouteLeaksSecret 遍历路由表里每一条 GET，{id} 都换成保险箱条目的 id，
// 响应里一律搜不到明文。以后加了新的 GET 自动纳入。
func TestNoGetRouteLeaksSecret(t *testing.T) {
	s, _ := newVaultServer(t)
	id := createSecret(t, s, `{"name":"OpenAI","value":"`+vaultPlain+`"}`)

	n := 0
	for _, pat := range registeredRoutes(t) {
		method, path, _ := strings.Cut(pat, " ")
		if method != "GET" {
			continue
		}
		path = strings.ReplaceAll(path, "{id}", id)
		targets := []string{path}
		if path == "/api/admin/export" {
			targets = []string{path + "?format=json", path + "?format=markdown"}
		}
		for _, target := range targets {
			w := do(s, "GET", target, "")
			n++
			if strings.Contains(w.Body.String(), vaultPlain) {
				t.Errorf("GET %s 的响应里搜到了明文", target)
			}
			if strings.Contains(target, "/api/admin/export") {
				if w.Code != http.StatusOK {
					t.Fatalf("export %s = %d", target, w.Code)
				}
				if strings.Contains(w.Body.String(), id) || strings.Contains(w.Body.String(), "vault") {
					t.Errorf("GET %s 带了保险箱内容", target)
				}
			}
		}
	}
	if n < 20 {
		t.Fatalf("只请求了 %d 条 GET，路由表收集多半失效了", n)
	}
}

func TestSecretListShowsHintOnly(t *testing.T) {
	s, _ := newVaultServer(t)
	createSecret(t, s, `{"name":"long","kind":"api_key","value":"sk-proj-abcdefghijklmn3f2a"}`)
	w := do(s, "GET", "/api/secrets", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	env := decodeEnvelope(t, w)
	items := env["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	got := items[0].(map[string]any)
	if got["hint"] != "sk-…3f2a" || got["kind"] != "api_key" || got["version"] != float64(1) {
		t.Fatalf("item = %v", got)
	}
	if strings.Contains(w.Body.String(), "abcdefghijklmn") {
		t.Fatal("列表带出了明文中段")
	}
}

func TestRotateSecretViaAPI(t *testing.T) {
	s, v := newVaultServer(t)
	id := createSecret(t, s, `{"name":"k","value":"`+vaultPlain+`"}`)

	w := do(s, "POST", "/api/secrets/"+id+"/rotate", `{"value":"sk-rotated-value-0000009999"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("rotate = %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "sk-rotated-value-0000009999") {
		t.Fatal("轮换的响应带了新明文")
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["version"] != float64(2) || data["rotated_at"] == nil {
		t.Fatalf("rotated = %v", data)
	}
	got, err := v.Resolve(context.Background(), id)
	if err != nil || got != "sk-rotated-value-0000009999" {
		t.Fatalf("resolve = %q, %v", got, err)
	}
	if got == vaultPlain {
		t.Fatal("轮换后还能取到旧值")
	}

	if w := do(s, "POST", "/api/secrets/"+id+"/rotate", `{"value":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("空值轮换 = %d", w.Code)
	}
	if w := do(s, "POST", "/api/secrets/nope/rotate", `{"value":"x-long-enough-value"}`); w.Code != http.StatusNotFound {
		t.Fatalf("不存在的轮换 = %d", w.Code)
	}
}

func TestDeleteSecretViaAPI(t *testing.T) {
	s, v := newVaultServer(t)
	id := createSecret(t, s, `{"name":"k","value":"`+vaultPlain+`"}`)
	if w := do(s, "DELETE", "/api/secrets/"+id, ""); w.Code != http.StatusOK {
		t.Fatalf("delete = %d", w.Code)
	}
	if w := do(s, "DELETE", "/api/secrets/"+id, ""); w.Code != http.StatusNotFound {
		t.Fatalf("delete twice = %d", w.Code)
	}
	if _, err := v.Resolve(context.Background(), id); err == nil {
		t.Fatal("删掉后还能取到")
	}
}

func TestCreateSecretValidation(t *testing.T) {
	s, _ := newVaultServer(t)
	for _, body := range []string{
		``,
		`{"name":"","value":"x"}`,
		`{"name":"k","value":""}`,
		`{"name":"k","kind":"BAD","value":"x"}`,
	} {
		if w := do(s, "POST", "/api/secrets", body); w.Code != http.StatusBadRequest {
			t.Errorf("POST %q = %d, 期望 400", body, w.Code)
		}
	}
}

func TestSecretsWithoutVault(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, "GET", "/api/secrets", "")
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "vault is not configured") {
		t.Fatalf("未配置保险箱 = %d %s", w.Code, w.Body.String())
	}
}
