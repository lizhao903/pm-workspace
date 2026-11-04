package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 会话增删改查 ---

func TestCreateAgentSessionAutoCreatesOllamaProvider(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	// 一个供应商都没有：对话框必须仍然能用，自动补一条指向本机 Ollama 的配置。
	w := do(s, http.MethodPost, "/api/agent/sessions", `{"title":"随手记"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	sess := envelopeData(t, w)
	if sess["provider_id"] == "" {
		t.Fatal("应当自动挂上一个供应商")
	}
	if sess["model"] != defaultOllamaModel {
		t.Errorf("模型 = %v，期望 %s", sess["model"], defaultOllamaModel)
	}

	list, err := f.ListProviders(t.Context())
	if err != nil {
		t.Fatalf("列供应商: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("应当只自动建 1 条供应商，得到 %d 条", len(list))
	}
	p := list[0]
	if p.Kind != domain.ProviderOllama || p.BaseURL != defaultOllamaBaseURL {
		t.Errorf("自动建的供应商不对: %+v", p)
	}
	if p.HasAPIKey {
		t.Error("本机 ollama 不需要密钥")
	}

	// 再建一个会话不该重复创建供应商。
	if w := do(s, http.MethodPost, "/api/agent/sessions", `{}`); w.Code != http.StatusCreated {
		t.Fatalf("第二次建会话失败: %s", w.Body.String())
	}
	if list, _ := f.ListProviders(t.Context()); len(list) != 1 {
		t.Errorf("供应商被重复创建了，共 %d 条", len(list))
	}
}

// TestCreateAgentSessionUsesExistingDefault 确认自动创建只在「一条都没有」时发生，
// 绝不覆盖用户已经配好的东西。
func TestCreateAgentSessionUsesExistingDefault(t *testing.T) {
	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_mine", Name: "我的 DeepSeek", Kind: domain.ProviderOpenAI,
		BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat",
		Enabled: true, IsDefault: true,
	}, "sk-mine-0001-abcd")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/sessions", `{}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("建会话失败: %s", w.Body.String())
	}
	sess := envelopeData(t, w)
	if sess["provider_id"] != "apv_mine" {
		t.Errorf("应当用已有的默认供应商，得到 %v", sess["provider_id"])
	}
	if sess["model"] != "deepseek-chat" {
		t.Errorf("模型应取自供应商，得到 %v", sess["model"])
	}
	if list, _ := f.ListProviders(t.Context()); len(list) != 1 {
		t.Errorf("不该额外创建供应商，共 %d 条", len(list))
	}
}

func TestAgentSessionCRUD(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/sessions", `{"title":"原标题","workdir":"/tmp/a"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("建会话: %s", w.Body.String())
	}
	id, _ := envelopeData(t, w)["id"].(string)

	w = do(s, http.MethodGet, "/api/agent/sessions?unscoped=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("列会话: %s", w.Body.String())
	}
	if items := envelopeList(t, w); len(items) != 1 {
		t.Fatalf("会话数 = %d", len(items))
	}

	w = do(s, http.MethodPatch, "/api/agent/sessions/"+id, `{"title":"新标题","workdir":"/tmp/b"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("改会话: %s", w.Body.String())
	}
	got := envelopeData(t, w)
	if got["title"] != "新标题" || got["workdir"] != "/tmp/b" {
		t.Errorf("改后 = %v", got)
	}

	if w := do(s, http.MethodDelete, "/api/agent/sessions/"+id, ""); w.Code != http.StatusOK {
		t.Fatalf("删会话: %s", w.Body.String())
	}
	if w := do(s, http.MethodGet, "/api/agent/sessions/"+id+"/messages", ""); w.Code != http.StatusNotFound {
		t.Errorf("删掉后取消息应 404，得到 %d", w.Code)
	}
}

func TestAgentSessionNotFound(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, target := range []string{
		"/api/agent/sessions/ags_nope/messages",
		"/api/agent/sessions/ags_nope/artifacts",
	} {
		if w := do(s, http.MethodGet, target, ""); w.Code != http.StatusNotFound {
			t.Errorf("%s 应 404，得到 %d", target, w.Code)
		}
	}
	if w := do(s, http.MethodDelete, "/api/agent/sessions/ags_nope", ""); w.Code != http.StatusNotFound {
		t.Errorf("删不存在的会话应 404，得到 %d", w.Code)
	}
}

// --- 产物目录检查 ---

func TestCheckWorkdirEndpoint(t *testing.T) {
	s := newTestServer(newFakeStore())
	dir := t.TempDir()

	w := do(s, http.MethodPost, "/api/agent/workdir/check",
		fmt.Sprintf(`{"path":%q}`, dir))
	if w.Code != http.StatusOK {
		t.Fatalf("检查目录: %s", w.Body.String())
	}
	got := envelopeData(t, w)
	if got["exists"] != true || got["is_dir"] != true || got["writable"] != true {
		t.Errorf("正常目录应当可用: %v", got)
	}

	// 不可用也是 200，前端看字段而不是状态码；但 message 必须说清原因。
	w = do(s, http.MethodPost, "/api/agent/workdir/check",
		fmt.Sprintf(`{"path":%q}`, filepath.Join(dir, "nope")))
	if w.Code != http.StatusOK {
		t.Fatalf("目录不存在时不该是 HTTP 错误，得到 %d", w.Code)
	}
	got = envelopeData(t, w)
	if got["exists"] != false || got["writable"] != false {
		t.Errorf("不存在的目录 = %v", got)
	}
	msg, _ := got["message"].(string)
	if msg == "" {
		t.Error("不可用时必须给出原因，不能只回 false")
	}
}

// --- 流式对话 ---

// fakeOllama 起一个假的 Ollama：先让模型调一次 create_object，
// 收到工具结果后再回一句话收尾。用它来验证完整的 SSE 事件序列。
func fakeOllama(t *testing.T) *httptest.Server {
	t.Helper()
	var turn int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		w.Header().Set("Content-Type", "application/x-ndjson")
		if turn == 1 {
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"好的，这就记下来。","tool_calls":[{"function":{"name":"create_object","arguments":{"type_id":"task","title":"和财务对账单口径"}}}]},"done":false}`+"\n")
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":""},"done":true}`+"\n")
			return
		}
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"已经记好了。"},"done":true}`+"\n")
	}))
	t.Cleanup(srv.Close)
	return srv
}

// plainOllama 是只回一句话、不调工具的上游。归属相关的测试只关心会话落在哪儿，
// 用 fakeOllama 会顺带建出对象，把断言搅浑。
func plainOllama(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"好的。"},"done":true}`+"\n")
	}))
	t.Cleanup(srv.Close)
	return srv
}

// sseEvents 把 SSE 响应体解析成事件列表。
func sseEvents(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, block := range strings.Split(body, "\n\n") {
		line := strings.TrimSpace(block)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev map[string]any
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			t.Fatalf("SSE 事件不是合法 JSON: %v (%q)", err, payload)
		}
		out = append(out, ev)
	}
	return out
}

func eventTypes(evs []map[string]any) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i], _ = e["type"].(string)
	}
	return out
}

func TestAgentChatStreamsFullEventSequence(t *testing.T) {
	up := fakeOllama(t)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Name: "本机", Kind: domain.ProviderOllama,
		BaseURL: up.URL, Model: "qwen3.5:4b", Enabled: true, IsDefault: true,
	}, "")
	// create_object 要有合法的类型才建得出来。
	f.types["task"] = &domain.ObjectType{
		ID: "task", Name: "待办", RefPrefix: "TSK",
		Statuses: []domain.Status{{Key: "todo", Label: "未开工"}},
	}
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat",
		`{"message":"记一个待办：明天和财务对账单口径"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q，期望 text/event-stream", ct)
	}
	// 反代缓冲必须关掉，否则增量会被攒起来一次性吐出。
	if w.Header().Get("X-Accel-Buffering") != "no" {
		t.Error("应当设置 X-Accel-Buffering: no")
	}

	evs := sseEvents(t, w.Body.String())
	types := eventTypes(evs)
	for _, want := range []string{"delta", "tool_call", "tool_result", "done"} {
		if !contains(types, want) {
			t.Fatalf("事件序列缺 %s: %v", want, types)
		}
	}
	// done 必须是最后一个，前端据此收尾。
	if types[len(types)-1] != "done" {
		t.Errorf("最后一个事件 = %s，期望 done", types[len(types)-1])
	}
	// 顺序约束：工具调用要在结果之前。
	if idx(types, "tool_call") > idx(types, "tool_result") {
		t.Errorf("tool_call 应在 tool_result 之前: %v", types)
	}

	for _, ev := range evs {
		switch ev["type"] {
		case "tool_call":
			if ev["name"] != "create_object" {
				t.Errorf("工具名 = %v", ev["name"])
			}
			if s, _ := ev["args"].(string); !strings.Contains(s, "对账") {
				t.Errorf("args 没带上参数: %v", ev["args"])
			}
		case "tool_result":
			// summary 是给人看的一句话，要带上新建对象的编号。
			sum, _ := ev["summary"].(string)
			if !strings.Contains(sum, "TSK-") {
				t.Errorf("tool_result 的 summary 应带编号，得到 %q", sum)
			}
			// 断言 object_id 能查回对象，而不只是非空——TSK-0001 也非空，
			// 但前端拿它 select 会查不到，这条断言才真正锁住语义。
			id, _ := ev["object_id"].(string)
			if id == "" {
				t.Errorf("object_id 为空，前端要靠它做跳转")
			} else if _, err := f.GetObject(t.Context(), id); err != nil {
				t.Errorf("object_id = %q 查不回对象: %v", id, err)
			}
			// 顺带钉死「不是人读编号」：TSK-0001 也非空，只断言非空是漏的。
			if strings.HasPrefix(id, "TSK-") {
				t.Errorf("object_id 发成了人读编号 %q，前端拿它 select 会查不到", id)
			}
		case "done":
			if ev["session_id"] == "" || ev["message_id"] == "" {
				t.Errorf("done 事件缺字段: %v", ev)
			}
		}
	}

	// 没给 session_id，应当自动建了一个会话，并把对话完整落库。
	sessions, err := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{Unscoped: true})
	if err != nil || len(sessions) != 1 {
		t.Fatalf("应当自动建一个会话: %v (%d 个)", err, len(sessions))
	}
	msgs, err := f.ListAgentMessages(t.Context(), sessions[0].ID, 0)
	if err != nil {
		t.Fatalf("列消息: %v", err)
	}
	var roles []string
	for _, m := range msgs {
		roles = append(roles, m.Role)
	}
	for _, want := range []string{domain.RoleUser, domain.RoleTool, domain.RoleAssistant} {
		if !contains(roles, want) {
			t.Errorf("消息落库缺 %s: %v", want, roles)
		}
	}
	// 会话标题应当取自第一句话，而不是一律「新对话」。
	if sessions[0].Title == "" || sessions[0].Title == "新对话" {
		t.Errorf("会话标题 = %q，期望取自首句", sessions[0].Title)
	}
}

// TestAgentChatWritesArtifactEvent 验证 write_file 走通时会吐 artifact 事件。
func TestAgentChatWritesArtifactEvent(t *testing.T) {
	dir := t.TempDir()

	var turn int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		w.Header().Set("Content-Type", "application/x-ndjson")
		if turn == 1 {
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"write_file","arguments":{"path":"方案.md","content":"# 方案\n正文"}}}]},"done":true}`+"\n")
			return
		}
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"写好了。"},"done":true}`+"\n")
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Kind: domain.ProviderOllama, BaseURL: up.URL,
		Model: "qwen3.5:4b", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat",
		fmt.Sprintf(`{"message":"写一份方案","workdir":%q}`, dir))
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}

	evs := sseEvents(t, w.Body.String())
	var art map[string]any
	for _, ev := range evs {
		if ev["type"] == "artifact" {
			art = ev
		}
	}
	if art == nil {
		t.Fatalf("缺 artifact 事件: %v", eventTypes(evs))
	}
	if art["path"] != "方案.md" {
		t.Errorf("产物路径 = %v，应是相对 workdir 的路径", art["path"])
	}
	if art["size"] == nil {
		t.Error("artifact 事件必须带 size")
	}

	// 文件真的落盘了。
	if _, err := os.Stat(filepath.Join(dir, "方案.md")); err != nil {
		t.Errorf("文件没有落在 workdir 里: %v", err)
	}
}

// TestAgentChatEscapeAttemptSurfacesAsToolFailure 是一条端到端的安全断言：
// 模型要求写到 workdir 之外时，请求整体仍然成功，但文件绝不能出现在外面。
func TestAgentChatEscapeAttemptSurfacesAsToolFailure(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "work")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}

	var turn int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		w.Header().Set("Content-Type", "application/x-ndjson")
		if turn == 1 {
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"write_file","arguments":{"path":"../../etc/passwd","content":"pwned"}}}]},"done":true}`+"\n")
			return
		}
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"写不了。"},"done":true}`+"\n")
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Kind: domain.ProviderOllama, BaseURL: up.URL,
		Model: "m", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat",
		fmt.Sprintf(`{"message":"写到系统目录","workdir":%q}`, dir))
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}

	evs := sseEvents(t, w.Body.String())
	for _, ev := range evs {
		if ev["type"] == "artifact" {
			t.Fatalf("越界写入竟然产生了 artifact 事件: %v", ev)
		}
	}
	// 失败要以 tool_result 的形式告诉用户，而不是静默。
	var sawResult bool
	for _, ev := range evs {
		if ev["type"] == "tool_result" {
			sawResult = true
			if sum, _ := ev["summary"].(string); !strings.Contains(sum, "失败") {
				t.Errorf("越界应当报失败，得到 %q", sum)
			}
		}
	}
	if !sawResult {
		t.Errorf("缺 tool_result 事件: %v", eventTypes(evs))
	}

	if _, err := os.Stat(filepath.Join(base, "etc", "passwd")); err == nil {
		t.Fatal("文件被写到了 workdir 之外")
	}
}

// TestAgentChatUpstreamFailureBecomesErrorEvent 确认上游挂掉时走 error 事件，
// 而不是一个半截的流。
func TestAgentChatUpstreamFailureBecomesErrorEvent(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Kind: domain.ProviderOllama, BaseURL: up.URL,
		Model: "m", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat", `{"message":"你好"}`)
	// 响应头早已发出，不能再改状态码，所以仍是 200。
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	evs := sseEvents(t, w.Body.String())
	if len(evs) == 0 || evs[len(evs)-1]["type"] != "error" {
		t.Fatalf("上游失败应以 error 事件收尾: %v", eventTypes(evs))
	}
	if msg, _ := evs[len(evs)-1]["message"].(string); msg == "" {
		t.Error("error 事件要带上可读的原因")
	}
	// 流里的 error 只有开着页面的人看得到：历史里也要留一条说明，不然回头翻只看到一句话没下文
	sessions, _ := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{Unscoped: true})
	if len(sessions) != 1 {
		t.Fatalf("会话数 = %d", len(sessions))
	}
	msgs, _ := f.ListAgentMessages(t.Context(), sessions[0].ID, 0)
	if last := msgs[len(msgs)-1]; last.Role != domain.RoleAssistant || !strings.Contains(last.Content, "这一轮没跑完") {
		t.Fatalf("失败要在历史里留说明：%+v", last)
	}
}

// 页面刷新、切走、关掉对话框时连接会断：模型调完工具、正在写下一轮时断开，这一轮要照样跑完、回复存进库。
// 原来执行绑在请求上，一断就取消且什么都不存，历史里只剩工具调用、没有下文。
func TestAgentChatFinishesAfterClientDisconnects(t *testing.T) {
	ctx, disconnect := context.WithCancel(context.Background())
	var turn int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		w.Header().Set("Content-Type", "application/x-ndjson")
		if turn == 1 {
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"create_object","arguments":{"type_id":"task","title":"和财务对账单口径"}}}]},"done":true}`+"\n")
			return
		}
		disconnect() // 工具已经执行，模型写第二轮时浏览器断开
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"已经记好了。"},"done":true}`+"\n")
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Kind: domain.ProviderOllama, BaseURL: up.URL, Model: "m", Enabled: true, IsDefault: true,
	}, "")
	f.types["task"] = &domain.ObjectType{ID: "task", Name: "待办", RefPrefix: "TSK",
		Statuses: []domain.Status{{Key: "todo", Label: "未开工"}}}
	s := newTestServer(f)

	r := httptest.NewRequest(http.MethodPost, "/api/agent/chat", strings.NewReader(`{"message":"记一个待办"}`)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	s.ServeHTTP(httptest.NewRecorder(), r)

	sessions, _ := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{Unscoped: true})
	if len(sessions) != 1 {
		t.Fatalf("会话数 = %d", len(sessions))
	}
	msgs, _ := f.ListAgentMessages(t.Context(), sessions[0].ID, 0)
	var roles []string
	for _, m := range msgs {
		roles = append(roles, m.Role)
	}
	if last := msgs[len(msgs)-1]; last.Role != domain.RoleAssistant || last.Content != "已经记好了。" {
		t.Fatalf("断开后应照样跑完并存下回复，实际消息：%v，最后一条 %+v", roles, last)
	}
}

// TestAgentChatNeverLeaksAPIKey 守住那条唯一的明文出口：
// 密钥可以被拿去调模型，但绝不能出现在任何响应字节里。
func TestAgentChatNeverLeaksAPIKey(t *testing.T) {
	const secret = "sk-super-secret-key-8888"

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 上游把 Authorization 头原样回显——刻意模拟最坏情况。
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"bad key: `+r.Header.Get("Authorization")+`"}`)
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_x", Kind: domain.ProviderOpenAI, BaseURL: up.URL,
		Model: "gpt-test", Enabled: true, IsDefault: true,
	}, secret)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat", `{"message":"你好"}`)
	if strings.Contains(w.Body.String(), secret) {
		t.Fatalf("响应体里泄漏了密钥: %s", w.Body.String())
	}

	// 会话与供应商列表同样不能带出明文。
	for _, target := range []string{"/api/agent/sessions", "/api/agent-providers"} {
		got := do(s, http.MethodGet, target, "")
		if strings.Contains(got.Body.String(), secret) {
			t.Errorf("%s 泄漏了密钥: %s", target, got.Body.String())
		}
	}
}

func TestAgentChatRequiresMessage(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, body := range []string{`{}`, `{"message":"   "}`} {
		w := do(s, http.MethodPost, "/api/agent/chat", body)
		assertError(t, w, http.StatusBadRequest, "validation")
	}
}

func TestAgentChatUnknownSessionIs404(t *testing.T) {
	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_x", Kind: domain.ProviderOllama, BaseURL: "http://127.0.0.1:1",
		Model: "m", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat", `{"session_id":"ags_nope","message":"你好"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404 (body=%s)", w.Code, w.Body.String())
	}
}

// --- 会话归属 ---

// mustFakeObject 在替身里造一个工作对象，供会话挂靠。
func mustFakeObject(t *testing.T, f *fakeStore, title string) *domain.Object {
	t.Helper()
	o, err := f.CreateObject(t.Context(), &domain.Object{TypeID: "task", Title: title}, store.DefaultActor)
	if err != nil {
		t.Fatalf("建对象 %s: %v", title, err)
	}
	return o
}

// TestListAgentSessionsScoping 钉住 GET /api/agent/sessions 的三种口径。
// 重点是最后那条：两个参数都不给返回空列表，不是全部——忘了传 filter 的调用方
// 拿到空列表，比让它拿到一堆不属于自己的会话好查。
func TestListAgentSessionsScoping(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)
	obj := mustFakeObject(t, f, "一条任务")

	w := do(s, http.MethodPost, "/api/agent/sessions",
		fmt.Sprintf(`{"title":"抽屉里聊的","object_id":%q}`, obj.ID))
	if w.Code != http.StatusCreated {
		t.Fatalf("建对象会话: %s", w.Body.String())
	}
	scoped := envelopeData(t, w)
	if scoped["object_id"] != obj.ID {
		t.Errorf("响应里的 object_id = %v，期望 %s", scoped["object_id"], obj.ID)
	}

	if w := do(s, http.MethodPost, "/api/agent/sessions", `{"title":"底部聊的"}`); w.Code != http.StatusCreated {
		t.Fatalf("建全局会话: %s", w.Body.String())
	}

	// object_id：只有这个对象的。
	w = do(s, http.MethodGet, "/api/agent/sessions?object_id="+obj.ID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("按对象列会话: %s", w.Body.String())
	}
	items := envelopeList(t, w)
	if len(items) != 1 {
		t.Fatalf("object_id 口径下会话数 = %d，期望 1", len(items))
	}
	if got := items[0].(map[string]any)["title"]; got != "抽屉里聊的" {
		t.Errorf("拿到的是 %v，期望抽屉里那条", got)
	}

	// unscoped=true：只有全局的。
	w = do(s, http.MethodGet, "/api/agent/sessions?unscoped=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("列全局会话: %s", w.Body.String())
	}
	items = envelopeList(t, w)
	if len(items) != 1 {
		t.Fatalf("unscoped 口径下会话数 = %d，期望 1", len(items))
	}
	if got := items[0].(map[string]any)["title"]; got != "底部聊的" {
		t.Errorf("拿到的是 %v，期望底部那条", got)
	}
	if got := items[0].(map[string]any)["object_id"]; got != nil {
		t.Errorf("全局会话的 object_id 应为 null，得到 %v", got)
	}

	// 两个都不给：空列表，而且是 []（不是 null），前端直接 map 不用先判空。
	w = do(s, http.MethodGet, "/api/agent/sessions", "")
	if w.Code != http.StatusOK {
		t.Fatalf("不带参数列会话: %s", w.Body.String())
	}
	if items := envelopeList(t, w); len(items) != 0 {
		t.Fatalf("不带参数应返回空列表，得到 %d 条", len(items))
	}
	if !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Errorf("空结果应当是 []，得到 %s", w.Body.String())
	}
}

// TestListAgentSessionsBadUnscoped：unscoped 不是布尔值要报 400，
// 而不是当成 false 安静地返回空列表——那会让前端对着一个空抽屉查半天。
func TestListAgentSessionsBadUnscoped(t *testing.T) {
	s := newTestServer(newFakeStore())
	if w := do(s, http.MethodGet, "/api/agent/sessions?unscoped=maybe", ""); w.Code != http.StatusBadRequest {
		t.Errorf("状态码 = %d，期望 400 (body=%s)", w.Code, w.Body.String())
	}
}

// TestCreateAgentSessionUnknownObject：显式挂给一个不存在的对象是 404，
// 不是静默落成全局会话。
func TestCreateAgentSessionUnknownObject(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodPost, "/api/agent/sessions", `{"object_id":"obj_nope"}`)
	if w.Code != http.StatusNotFound {
		t.Errorf("状态码 = %d，期望 404 (body=%s)", w.Code, w.Body.String())
	}
}

// TestAgentChatScopesAutoCreatedSession 是这条链路上最容易漏的一环：
// 用户在 TSK 的助手里直接说第一句话，后端自动建的那个会话必须挂在这个对象上。
// 不挂的话，刷新后它从抽屉里消失、却出现在底部对话框的列表里。
func TestAgentChatScopesAutoCreatedSession(t *testing.T) {
	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Name: "本机", Kind: domain.ProviderOllama,
		BaseURL: plainOllama(t).URL, Model: "qwen3.5:4b", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)
	obj := mustFakeObject(t, f, "一条任务")

	w := do(s, http.MethodPost, "/api/agent/chat",
		fmt.Sprintf(`{"message":"这个需求怎么推进","object_id":%q}`, obj.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}

	scoped, err := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{ObjectID: obj.ID})
	if err != nil {
		t.Fatalf("按对象列会话: %v", err)
	}
	if len(scoped) != 1 {
		t.Fatalf("自动建的会话应当挂在 %s 上，该对象下有 %d 条", obj.ID, len(scoped))
	}
	global, err := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{Unscoped: true})
	if err != nil {
		t.Fatalf("列全局会话: %v", err)
	}
	if len(global) != 0 {
		t.Errorf("它不该同时出现在全局列表里，全局有 %d 条", len(global))
	}
}

// TestAgentChatStaleObjectStillWorks：选中态指向一个已被删掉的对象时，
// 对话不能失败——最多让这条会话落成全局的。
func TestAgentChatStaleObjectStillWorks(t *testing.T) {
	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Name: "本机", Kind: domain.ProviderOllama,
		BaseURL: plainOllama(t).URL, Model: "qwen3.5:4b", Enabled: true, IsDefault: true,
	}, "")
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat", `{"message":"你好","object_id":"obj_nope"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，失效的选中态不该让对话失败 (body=%s)", w.Code, w.Body.String())
	}
	global, err := f.ListAgentSessions(t.Context(), domain.AgentSessionFilter{Unscoped: true})
	if err != nil || len(global) != 1 {
		t.Errorf("应当落成一条全局会话: %v (%d 条)", err, len(global))
	}
}

// --- 辅助 ---

func envelopeData(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	m := decodeEnvelope(t, w)
	d, ok := m["data"].(map[string]any)
	if !ok {
		t.Fatalf("data 不是对象: %v", m["data"])
	}
	return d
}

func envelopeList(t *testing.T, w *httptest.ResponseRecorder) []any {
	t.Helper()
	m := decodeEnvelope(t, w)
	d, ok := m["data"].([]any)
	if !ok {
		t.Fatalf("data 不是数组: %v", m["data"])
	}
	return d
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

func idx(ss []string, want string) int {
	for i, s := range ss {
		if s == want {
			return i
		}
	}
	return -1
}

// TestAgentChatKeepsTimeOfDayFromModel 复现真机上 100% 触发的那条缺口。
//
// 用户说「明天下午两点和财务核对账单口径」时，模型产出的是
// due_at="2026-09-16T14:00:00"——不带时区，既不是合法 RFC3339 也不是纯日期。
// 打桩的输入是人写的，人不会想到去写这种串，所以这个缺口只有真跑模型才撞得出来；
// 撞出来之后必须用打桩钉死，否则下次改 parseDue 又会悄悄退回去。
func TestAgentChatKeepsTimeOfDayFromModel(t *testing.T) {
	var turn int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		turn++
		w.Header().Set("Content-Type", "application/x-ndjson")
		if turn == 1 {
			_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"create_object","arguments":{"type_id":"task","title":"下午和财务核对账单口径","due_at":"2026-09-16T14:00:00","priority":"P1"}}}]},"done":true}`+"\n")
			return
		}
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"记好了。"},"done":true}`+"\n")
	}))
	t.Cleanup(up.Close)

	f := newFakeStore()
	f.putProvider(&domain.AgentProvider{
		ID: "apv_local", Kind: domain.ProviderOllama, BaseURL: up.URL,
		Model: "qwen3.5:4b", Enabled: true, IsDefault: true,
	}, "")
	f.types["task"] = &domain.ObjectType{
		ID: "task", Name: "待办", RefPrefix: "TSK",
		Statuses: []domain.Status{{Key: "todo", Label: "未开工"}},
	}
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/agent/chat",
		`{"message":"记一个待办：明天下午两点和财务核对账单口径"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}

	evs := sseEvents(t, w.Body.String())
	var objID string
	for _, ev := range evs {
		if ev["type"] != "tool_result" || ev["name"] != "create_object" {
			continue
		}
		// 真机上这里是「执行失败：due_at 解析不了」，待办根本没建成。
		if sum, _ := ev["summary"].(string); strings.Contains(sum, "失败") {
			t.Fatalf("带时刻的 due_at 让创建失败了: %q", sum)
		}
		objID, _ = ev["object_id"].(string)
	}
	if objID == "" {
		t.Fatalf("没有创建成功: %v", eventTypes(evs))
	}

	obj, err := f.GetObject(t.Context(), objID)
	if err != nil {
		t.Fatalf("取对象: %v", err)
	}
	if obj.DueAt == nil {
		t.Fatal("due_at 没落库")
	}
	local := obj.DueAt.In(time.Local)
	if local.Hour() != 14 || local.Minute() != 0 {
		t.Errorf("落库时刻 = %02d:%02d，期望本地 14:00——时刻信息被抹成了当天末尾",
			local.Hour(), local.Minute())
	}
	if local.Format("2006-01-02") != "2026-09-16" {
		t.Errorf("落库日期 = %s，期望 2026-09-16", local.Format("2006-01-02"))
	}
}

// 移除会话消息（SPEC-sessions-1.43）：只删这个会话里的这几条，别的会话的 id 忽略；空 ids 400，会话不存在 404，在跑时 409
func TestRemoveAgentMessages(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)
	ctx := context.Background()
	w := do(s, http.MethodPost, "/api/agent/sessions", `{"title":"a"}`)
	id, _ := envelopeData(t, w)["id"].(string)
	w = do(s, http.MethodPost, "/api/agent/sessions", `{"title":"b"}`)
	other, _ := envelopeData(t, w)["id"].(string)
	var ids []string
	for _, c := range []string{"问", "答", "再问"} {
		m, err := f.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: id, Role: domain.RoleUser, Content: c})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.ID)
	}
	o, _ := f.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: other, Role: domain.RoleUser, Content: "别处"})

	w = do(s, http.MethodPost, "/api/agent/sessions/"+id+"/messages/remove", `{"ids":["`+ids[0]+`","`+ids[1]+`","`+o.ID+`"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("移除: %d %s", w.Code, w.Body.String())
	}
	if n := envelopeData(t, w)["removed"]; n != float64(2) {
		t.Errorf("removed = %v，期望 2", n)
	}
	w = do(s, http.MethodGet, "/api/agent/sessions/"+id+"/messages", "")
	if items := envelopeList(t, w); len(items) != 1 || items[0].(map[string]any)["content"] != "再问" {
		t.Errorf("剩下的 = %v", items)
	}
	if len(f.messages[other]) != 1 {
		t.Errorf("别的会话的消息不该动")
	}
	if w := do(s, http.MethodPost, "/api/agent/sessions/"+id+"/messages/remove", `{"ids":[]}`); w.Code != http.StatusBadRequest {
		t.Errorf("空 ids 应 400，得到 %d", w.Code)
	}
	if w := do(s, http.MethodPost, "/api/agent/sessions/ags_nope/messages/remove", `{"ids":["x"]}`); w.Code != http.StatusNotFound {
		t.Errorf("会话不存在应 404，得到 %d", w.Code)
	}
	_, done := s.turns.start(ctx, id)
	defer done()
	if w := do(s, http.MethodPost, "/api/agent/sessions/"+id+"/messages/remove", `{"ids":["`+ids[2]+`"]}`); w.Code != http.StatusConflict {
		t.Errorf("在跑时应 409，得到 %d", w.Code)
	}
}

// 版本更新（SYS-UPD）：没接更新器的实例回 blocked，开始更新 409
func TestUpdateWithoutUpdater(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodGet, "/api/admin/update", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态: %d %s", w.Code, w.Body.String())
	}
	if d := envelopeData(t, w); d["blocked"] != "这个实例不支持就地更新" {
		t.Errorf("blocked = %v", d["blocked"])
	}
	if w := do(s, http.MethodPost, "/api/admin/update", ""); w.Code != http.StatusConflict {
		t.Errorf("开始更新应 409，得到 %d", w.Code)
	}
}
