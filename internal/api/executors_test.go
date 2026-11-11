package api

import (
	"context"
	"encoding/json"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutorsCRUD(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	list := decodeEnvelope(t, do(s, "GET", "/api/executors", ""))["data"].([]any)
	if len(list) != 2 {
		t.Fatalf("defaults: %v", list)
	}
	body := `{"name":"Local test","kind":"deepseek","bin":"/tmp/my dsh","desc":"notes","enabled":true}`
	w := do(s, "POST", "/api/executors", body)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	item := decodeEnvelope(t, w)["data"].(map[string]any)
	id := item["id"].(string)
	if w := do(s, "POST", "/api/executors", body); w.Code != 409 {
		t.Fatal("duplicate", w.Code)
	}
	if w := do(s, "GET", "/api/executors/"+id, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := do(s, "GET", "/api/executors?q=local%20test", ""); len(decodeEnvelope(t, w)["data"].([]any)) != 1 {
		t.Fatal(w.Body.String())
	}
	item["name"], item["enabled"] = "Updated", false
	raw, _ := json.Marshal(item)
	if w := do(s, "PUT", "/api/executors/"+id, string(raw)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := do(s, "GET", "/api/executors/"+id, ""); decodeEnvelope(t, w)["data"].(map[string]any)["enabled"] != false {
		t.Fatal(w.Body.String())
	}
	if w := do(s, "DELETE", "/api/executors/"+id, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := do(s, "GET", "/api/executors/"+id, ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	for _, item := range list {
		id := item.(map[string]any)["id"].(string)
		if w := do(s, "DELETE", "/api/executors/"+id, ""); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if w := do(s, "GET", "/api/executors", ""); len(decodeEnvelope(t, w)["data"].([]any)) != 0 {
		t.Fatal("deleted defaults returned")
	}
}
func TestExecutorValidation(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	for _, body := range []string{
		`{"name":"","kind":"claude","bin":"claude"}`,
		`{"name":"x","kind":"unsupported","bin":"codex"}`,
		`{"name":"x","kind":"","bin":"claude"}`,
		`{"name":"x","kind":"claude","bin":"claude --help"}`,
		`{"name":"x","kind":"claude","bin":"relative/claude"}`,
		`{"name":"x","kind":"claude","bin":""}`,
	} {
		if w := do(s, "POST", "/api/executors", body); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	if w := do(s, "DELETE", "/api/executors/missing", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

func TestExecutorProbeAndStatus(t *testing.T) {
	s, f, _, _ := terminalFixture(t)
	bin := filepath.Join(t.TempDir(), "fake-cli")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'dsh 1.2.3'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(Executor{Name: "Test", Kind: "deepseek", Bin: bin, Enabled: true})
	w := do(s, "POST", "/api/executors/probe", string(body))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	probe := decodeEnvelope(t, w)["data"].(map[string]any)
	if probe["path"] != bin || probe["version"] != "dsh 1.2.3" {
		t.Fatal(probe)
	}
	status := s.executorStatus(t.Context(), Executor{Bin: bin})
	if len(status.Warnings) != 1 || status.Warnings[0] != "未选择模型服务商" {
		t.Fatal(status)
	}
	provider, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "DS", Kind: "openai", Model: "deepseek-v3", Enabled: true}, "key")
	if err != nil {
		t.Fatal(err)
	}
	status = s.executorStatus(t.Context(), Executor{Bin: bin, ProviderID: provider.ID})
	if len(status.Warnings) != 0 || status.Model != "deepseek-v3" || status.ProviderName != "DS" {
		t.Fatal(status)
	}
	status = s.executorStatus(t.Context(), Executor{Bin: "/missing/program", ProviderID: "deleted"})
	if len(status.Warnings) != 2 {
		t.Fatal(status)
	}
	// Resolve a PATH command to the stored absolute path.
	t.Setenv("PATH", filepath.Dir(bin))
	cleaned, err := cleanExecutor(Executor{Name: "Test", Kind: "deepseek", Bin: "fake-cli"})
	if err != nil || cleaned.Bin != bin {
		t.Fatal(cleaned, err)
	}
}

func TestExecutorChatUsesSelectedCLI(t *testing.T) {
	s, f, _, _ := terminalFixture(t)
	provider, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "Selected", Kind: "anthropic", BaseURL: "http://127.0.0.1:1", Model: "test-model", Enabled: true}, "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
cat >/dev/null
[ "$ANTHROPIC_MODEL" = "test-model" ] || exit 8
[ "$ANTHROPIC_API_KEY" = "test-secret" ] || exit 9
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"reply from selected CLI"}]}}' '{"type":"result","subtype":"success","is_error":false,"result":"reply from selected CLI"}'
`
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	e := Executor{Name: "CLI test", Kind: "claude", Bin: bin, ProviderID: provider.ID, Enabled: true}
	body, _ := json.Marshal(map[string]any{"executor": e, "prompt": "hello"})
	w := do(s, "POST", "/api/executors/test", string(body))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "reply from selected CLI") {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'CLI broken' >&2\nexit 7\n"), 0755); err != nil {
		t.Fatal(err)
	}
	w = do(s, "POST", "/api/executors/test", string(body))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "CLI broken") {
		t.Fatal(w.Code, w.Body.String())
	}
	incompatible, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "Wrong protocol", Kind: "openai", BaseURL: "http://127.0.0.1:1", Model: "test", Enabled: true}, "secret")
	if err != nil {
		t.Fatal(err)
	}
	e.ProviderID = incompatible.ID
	body, _ = json.Marshal(map[string]any{"executor": e, "prompt": "hello"})
	w = do(s, "POST", "/api/executors/test", string(body))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Anthropic") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestCodexExecutorUsesLocalCLI(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	bin := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
payload=$(cat)
case "$payload" in *previous-question*previous-answer*hello*) ;; *) exit 9 ;; esac
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"codex local ok"}}' '{"type":"turn.completed"}'
`
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"executor": Executor{Name: "ChatGPT", Kind: "codex", Bin: bin, UseCLIConfig: true, Enabled: true}, "prompt": "hello", "messages": []map[string]string{{"role": "user", "content": "previous-question"}, {"role": "assistant", "content": "previous-answer"}}})
	w := do(s, "POST", "/api/executors/test", string(body))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "codex local ok") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = do(s, "POST", "/api/executors", string(mustExecutorJSON(t, Executor{Name: "ChatGPT", Kind: "codex", Bin: bin, UseCLIConfig: true, Enabled: true})))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	status := s.executorStatus(t.Context(), Executor{Kind: "codex", Bin: bin, UseCLIConfig: true})
	if len(status.Warnings) != 0 || status.ProviderName != "Codex 本机登录与配置" {
		t.Fatal(status)
	}
}
func mustExecutorJSON(t *testing.T, e Executor) []byte {
	t.Helper()
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestExecutorRunSnapshot(t *testing.T) {
	s, _, _, _ := terminalFixture(t)
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
		t.Fatal(err)
	}
	input := Executor{Name: "SOP Codex", Kind: "codex", Bin: bin, Enabled: true, UseCLIConfig: true}
	raw, _ := json.Marshal(input)
	w := do(s, "POST", "/api/executors", string(raw))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	id := decodeEnvelope(t, w)["data"].(map[string]any)["id"].(string)
	req, err := s.executorRequest(context.Background(), id)
	if err != nil || req.Harness != runner.HarnessCodex || req.CodexBin != bin || req.Codex != nil {
		t.Fatalf("%+v %v", req, err)
	}
	input.Enabled = false
	raw, _ = json.Marshal(input)
	do(s, "PUT", "/api/executors/"+id, string(raw))
	if _, err := s.executorRequest(context.Background(), id); err == nil {
		t.Fatal("disabled executor accepted")
	}
	do(s, "DELETE", "/api/executors/"+id, "")
	if _, err := s.executorRequest(context.Background(), id); err == nil {
		t.Fatal("deleted executor accepted")
	}
}

func TestLocalCodexBaseURL(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	config := `model_provider = "main"
profile = "work"
[model_providers.main]
base_url = "https://main.example/v1"
[model_providers.work]
base_url = "https://work.example/v1"
[profiles.work]
model_provider = "work"
`
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	url, source := localCodexBaseURL()
	if url != "https://work.example/v1" || source != path {
		t.Fatal(url, source)
	}
	if err := os.WriteFile(path, []byte("model = 'default'"), 0600); err != nil {
		t.Fatal(err)
	}
	url, _ = localCodexBaseURL()
	if url != "" {
		t.Fatal(url)
	}
}
