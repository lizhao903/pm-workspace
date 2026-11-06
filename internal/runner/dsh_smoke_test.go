package runner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 真实 dsh 的冒烟测试：起一个假的 OpenAI 兼容端点，让 dsh 真正跑一轮
// （模型 → 工具调用 → 工具结果 → 收尾），验的是那些只有真机才暴露的东西：
//
//   - 命令行参数这一版到底认不认（0.2.x 的 headless 只有 --json / --session-id）；
//   - --json 的字段名（tool_call 是 tool+input 还是 name+arguments）；
//   - final 到底带不带 reason（实测不带，只有退出码和 turn_end 能判断成败）；
//   - patch 里的插件 id 与组合能不能让 profile 正常装配。
//
// 没有 dsh 就跳过，和 TestSmokeRealClaude 一样：这类测试不该让 CI 依赖外部 CLI。
// 找 dsh 先看环境变量 DSH_BIN（不全局安装、装在别处时用它指过去），再走 PATH。
//
// TSK-0722 起补齐集成检查对应的断言：只读档写不进文件、工作台 MCP（pmw-run）回写能到工作台、
// 取消和超时都能收尾、收尾后整个进程组退干净。设置「执行器」页的一键集成检查验的是同一组东西。

// dshForTest 找 dsh：DSH_BIN 优先，其次 PATH；都没有就跳过。
func dshForTest(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("-short：不调外部 CLI")
	}
	if b := strings.TrimSpace(os.Getenv("DSH_BIN")); b != "" {
		if p, err := exec.LookPath(b); err == nil {
			return p
		}
		t.Skipf("DSH_BIN=%s 找不到", b)
	}
	bin, err := exec.LookPath(DefaultDSHBin)
	if err != nil {
		t.Skip("本机没装 dsh（npm i --prefix <目录> @deepseek-ai/dsh，再用 DSH_BIN 指过去）")
	}
	return bin
}

func TestSmokeRealDSH(t *testing.T) {
	bin := dshForTest(t)
	llm := fakeChatEndpoint(t)
	defer llm.Close()

	wd := t.TempDir()
	r := &Runner{DSHBin: bin, Timeout: 2 * time.Minute}
	route := &DeepSeekRoute{
		Kind:    domain.ProviderOpenAI,
		BaseURL: llm.URL + "/v1",
		Model:   "deepseek-chat",
		APIKey:  "sk-smoke",
	}

	var evs []Event
	res, err := r.Start(context.Background(), Request{
		RunID:    "run_dsh_smoke",
		Workdir:  wd,
		Prompt:   "写一个探针文件",
		Harness:  HarnessDeepSeek,
		DeepSeek: route,
	}, collect(&evs))
	if err != nil {
		t.Fatalf("起进程就失败了：%v", err)
	}

	// 工具行必须翻出来，名字和入参都要有。这是界面上最有价值的一半，
	// 字段名换了一版就会变成一条空白，而空白在界面上看不出是 bug。
	var tool *Event
	for i := range evs {
		if evs[i].Type == EventTool {
			tool = &evs[i]
			break
		}
	}
	if tool == nil {
		t.Fatalf("没有 tool 事件；事件序列 = %v，输出 = %q", typesOfRun(evs), res.Output)
	}
	if tool.Name != "bash" {
		t.Errorf("工具名 = %q，期望 bash（0.2.x 在 tool 字段里，新版本在 name 里）", tool.Name)
	}
	if !strings.Contains(tool.Detail, "probe.txt") {
		t.Errorf("工具入参没解析出来：detail = %q", tool.Detail)
	}
	// 只读档（没勾允许写入）：模型让 bash 写的 probe.txt 不能真写出来
	if _, err := os.Stat(filepath.Join(wd, "probe.txt")); err == nil {
		t.Error("只读执行写出了 probe.txt：沙箱 read-only 没生效")
	}

	// 会话 id 是续跑的前提，必须有。
	if res.SessionID == "" {
		t.Error("没拿到会话 id，续跑就没法做")
	}

	// 这台机器上沙箱后端可能起不来（macOS 的 sandbox-exec 在某些环境里不可用），
	// 那不是代码问题，但失败原因必须是我们能读懂的「环境没准备好」，
	// 而不是一句光秃秃的退出码。
	switch res.Status {
	case domain.RunDone:
		if strings.TrimSpace(res.Output) == "" {
			t.Error("成功但没有过程记录")
		}
	case domain.RunFailed:
		if !strings.Contains(res.Error, "沙箱") && !strings.Contains(res.Error, "模型") {
			t.Fatalf("失败了，但原因不可读：%q（输出 %q）", res.Error, res.Output)
		}
		t.Logf("这次失败在预期之内（环境或端点问题）：%s", res.Error)
	default:
		t.Fatalf("给了取消？status = %s", res.Status)
	}
}

// TestSmokeRealDSHResume 验续跑：拿第一次的会话 id 再跑一次，dsh 应该接着它。
// 只有第一次拿到了会话 id 才有意义，否则跳过。
func TestSmokeRealDSHResume(t *testing.T) {
	bin := dshForTest(t)
	llm := fakeChatEndpoint(t)
	defer llm.Close()

	wd := t.TempDir()
	r := &Runner{DSHBin: bin, Timeout: 2 * time.Minute}
	route := &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: llm.URL + "/v1", Model: "deepseek-chat", APIKey: "sk-smoke"}

	first, err := r.Start(context.Background(), Request{
		RunID: "run_dsh_r1", Workdir: wd, Prompt: "第一轮",
		Harness: HarnessDeepSeek, DeepSeek: route,
	}, func(Event) {})
	if err != nil {
		t.Fatalf("第一轮起进程失败：%v", err)
	}
	if first.SessionID == "" {
		t.Skip("第一轮没拿到会话 id（环境问题），跳过续跑")
	}

	second, err := r.Start(context.Background(), Request{
		RunID: "run_dsh_r2", Workdir: wd, Prompt: "第二轮",
		Harness: HarnessDeepSeek, DeepSeek: route, SessionID: first.SessionID,
	}, func(Event) {})
	if err != nil {
		t.Fatalf("续跑起进程失败：%v", err)
	}
	// 未知 id 会被 dsh 直接拒绝，所以能跑起来就说明 id 被认了；
	// 再确认会话 id 一致，避免 dsh 悄悄换了一段新会话。
	if second.SessionID != first.SessionID {
		t.Errorf("续跑换了会话：%q → %q", first.SessionID, second.SessionID)
	}
}

func typesOfRun(evs []Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Type
	}
	return out
}

// fakeChatEndpoint 是一个够用的 OpenAI 兼容端点：第一次让模型调一次 bash，
// 拿到工具结果之后回一段正文。只为冒烟，不模拟任何真实模型行为。
func fakeChatEndpoint(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Stream   bool `json:"stream"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
			Tools []any `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		// 见到工具结果就不再要工具，否则会死循环。
		usedTool := false
		for _, m := range req.Messages {
			if m.Role == "tool" || strings.Contains(string(m.Content), "tool_result") {
				usedTool = true
			}
		}

		if !req.Stream {
			writeJSON(t, w, map[string]any{
				"id": "chatcmpl-fake", "object": "chat.completion", "model": "deepseek-chat",
				"choices": []any{map[string]any{"index": 0, "finish_reason": "stop",
					"message": map[string]any{"role": "assistant", "content": "ok"}}},
			})
			return
		}

		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-cache")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		chunk := func(delta map[string]any, finish any) {
			b, _ := json.Marshal(map[string]any{
				"id": "chatcmpl-fake", "object": "chat.completion.chunk", "model": "deepseek-chat",
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
			})
			_, _ = w.Write([]byte("data: " + string(b) + "\n\n"))
			if flusher != nil {
				flusher.Flush()
			}
		}
		if usedTool || len(req.Tools) == 0 {
			chunk(map[string]any{"role": "assistant", "content": "收尾。"}, nil)
			chunk(map[string]any{}, "stop")
		} else {
			args, _ := json.Marshal(map[string]string{"command": "echo hi > probe.txt", "description": "探针"})
			chunk(map[string]any{"role": "assistant", "content": ""}, nil)
			chunk(map[string]any{"tool_calls": []any{map[string]any{
				"index": 0, "id": "call_smoke", "type": "function",
				"function": map[string]any{"name": "bash", "arguments": string(args)},
			}}}, "tool_calls")
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
	}))
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Errorf("marshal: %v", err)
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(b)
}

// TestSmokeRealDSHWriteBack 验工作台 MCP 回写（TSK-0722）：patch 里挂的 pmw-run 真的被 dsh 拉起来，
// 模型调 mcp__pmw-run__pmw_finish_run，请求经 pmw-mcp 到了工作台的 POST /api/runs/{id}/finish。
// 工作台用一个记请求的假 HTTP 服务代替；pmw-mcp 现场编出来。
func TestSmokeRealDSHWriteBack(t *testing.T) {
	bin := dshForTest(t)
	mcpBin := filepath.Join(t.TempDir(), "pmw-mcp")
	if out, err := exec.Command("go", "build", "-o", mcpBin, "../../cmd/pmw-mcp").CombinedOutput(); err != nil {
		t.Skipf("编不出 pmw-mcp：%v %s", err, out)
	}

	var mu sync.Mutex
	var got []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, r.Method+" "+r.URL.Path+" "+toJSON(body))
		mu.Unlock()
		writeJSON(t, w, map[string]any{"data": map[string]any{"id": "run_dsh_wb", "status": "running", "mode": "stream",
			"started_at": time.Now().UTC().Format(time.RFC3339)}})
	}))
	defer api.Close()

	llm := fakeToolEndpoint(t, "mcp__"+MCPServer+"__pmw_finish_run",
		map[string]any{"run_id": "run_dsh_wb", "status": "done", "summary": "目录里有：a.txt"})
	defer llm.Close()

	wd := t.TempDir()
	r := &Runner{DSHBin: bin, Timeout: 2 * time.Minute}
	var evs []Event
	res, err := r.Start(context.Background(), Request{
		RunID: "run_dsh_wb", Workdir: wd, Prompt: "回写结论", Harness: HarnessDeepSeek,
		DeepSeek: &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: llm.URL + "/v1", Model: "deepseek-chat", APIKey: "sk-smoke"},
		MCP:      &MCPEndpoint{Bin: mcpBin, API: api.URL},
	}, collect(&evs))
	if err != nil {
		t.Fatalf("起进程失败：%v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || !strings.Contains(got[0], "POST /api/runs/run_dsh_wb/finish") || !strings.Contains(got[0], "目录里有：a.txt") {
		t.Fatalf("工作台没收到 pmw_finish_run 的回报：%v（status=%s error=%s 输出=%q）", got, res.Status, res.Error, res.Output)
	}
	var ok bool
	for _, ev := range evs {
		if ev.Type == EventToolResult && ev.Name == "mcp__"+MCPServer+"__pmw_finish_run" {
			ok = ev.OK
		}
	}
	if !ok {
		t.Errorf("MCP 工具那一行应是成功：%v", typesOfRun(evs))
	}
}

// TestSmokeRealDSHCancelAndTimeout 验取消和超时都能收尾，收尾后整个进程组都不在了（TSK-0722）。
// 模型端点一直不回，dsh 卡在等模型那一步。
func TestSmokeRealDSHCancelAndTimeout(t *testing.T) {
	bin := dshForTest(t)
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 先读完请求体：读完之后服务端才会在后台盯连接，dsh 被杀、连接一断上下文就取消
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Minute):
		}
	}))
	defer hang.Close()
	defer hang.CloseClientConnections()
	route := &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: hang.URL + "/v1", Model: "deepseek-chat", APIKey: "sk-smoke"}
	r := &Runner{DSHBin: bin, Timeout: 2 * time.Minute}

	for _, c := range []struct {
		name    string
		timeout time.Duration
		cancel  bool
		status  string
		reason  string
	}{
		{"取消", 0, true, domain.RunCanceled, "取消"},
		{"超时", 3 * time.Second, false, domain.RunFailed, "超时"},
	} {
		runID := "run_dsh_" + map[bool]string{true: "cancel", false: "timeout"}[c.cancel]
		var pgid int
		start := time.Now()
		res, err := r.Start(context.Background(), Request{
			RunID: runID, Workdir: t.TempDir(), Prompt: "等着", Harness: HarnessDeepSeek, DeepSeek: route, Timeout: c.timeout,
			OnSpawn: func(g int) {
				pgid = g
				if c.cancel {
					time.AfterFunc(2*time.Second, func() { r.Cancel(runID) })
				}
			},
		}, nil)
		if err != nil {
			t.Fatalf("%s：起进程失败：%v", c.name, err)
		}
		if res.Status != c.status || !strings.Contains(res.Error, c.reason) {
			t.Fatalf("%s：收尾成 %s / %q，期望 %s、原因含「%s」", c.name, res.Status, res.Error, c.status, c.reason)
		}
		t.Logf("%s：收尾用了 %s", c.name, time.Since(start))
		if took := time.Since(start); took > 20*time.Second {
			t.Errorf("%s：收尾用了 %s，SIGTERM 加宽限期不该这么久", c.name, took)
		}
		gone := false
		for i := 0; i < 30 && !gone; i++ {
			gone = ProcessGroupGone(pgid)
			time.Sleep(100 * time.Millisecond)
		}
		if !gone {
			KillProcessGroup(pgid)
			t.Fatalf("%s：收尾 3 秒后进程组 %d 里还有进程", c.name, pgid)
		}
	}
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// fakeToolEndpoint 是只调一次指定工具的 OpenAI 兼容端点：请求里带了这个工具、还没见到工具结果时调它，
// 之后回一句收尾。工具不在请求里（MCP 没挂上）就直接收尾，测试那边会看到没回报。
func fakeToolEndpoint(t *testing.T, tool string, args map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Stream   bool `json:"stream"`
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		used, offered := false, false
		for _, m := range req.Messages {
			used = used || m.Role == "tool"
		}
		for _, tl := range req.Tools {
			offered = offered || tl.Function.Name == tool
		}
		if !req.Stream {
			writeJSON(t, w, map[string]any{"id": "x", "object": "chat.completion", "model": "deepseek-chat",
				"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": "ok"}}}})
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		chunk := func(delta map[string]any, finish any) {
			b, _ := json.Marshal(map[string]any{"id": "x", "object": "chat.completion.chunk", "model": "deepseek-chat",
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
			_, _ = w.Write([]byte("data: " + string(b) + "\n\n"))
			if fl != nil {
				fl.Flush()
			}
		}
		if used || !offered {
			chunk(map[string]any{"role": "assistant", "content": "收尾。"}, nil)
			chunk(map[string]any{}, "stop")
		} else {
			a, _ := json.Marshal(args)
			chunk(map[string]any{"role": "assistant", "content": ""}, nil)
			chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_wb", "type": "function",
				"function": map[string]any{"name": tool, "arguments": string(a)}}}}, "tool_calls")
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
		if fl != nil {
			fl.Flush()
		}
	}))
}

// TestSmokeRealDSHWorkspaceWrite 验「允许改文件」档（TSK-0722）：同一个让 bash 写 probe.txt 的假模型，
// workspace-write 沙箱下文件要真写进工作目录。沙箱后端在这台机器上起不来时跳过（那是环境问题，见 TestSmokeRealDSH）。
func TestSmokeRealDSHWorkspaceWrite(t *testing.T) {
	bin := dshForTest(t)
	llm := fakeChatEndpoint(t)
	defer llm.Close()
	wd := t.TempDir()
	r := &Runner{DSHBin: bin, Timeout: 2 * time.Minute}
	res, err := r.Start(context.Background(), Request{
		RunID: "run_dsh_ww", Workdir: wd, Prompt: "写一个探针文件", Harness: HarnessDeepSeek, Permission: PermAcceptEdits,
		DeepSeek: &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: llm.URL + "/v1", Model: "deepseek-chat", APIKey: "sk-smoke"},
	}, nil)
	if err != nil {
		t.Fatalf("起进程失败：%v", err)
	}
	if strings.Contains(res.Error, "沙箱后端") {
		t.Skipf("这台机器的沙箱后端起不来：%s", res.Error)
	}
	if b, err := os.ReadFile(filepath.Join(wd, "probe.txt")); err != nil || strings.TrimSpace(string(b)) != "hi" {
		t.Fatalf("workspace-write 下 probe.txt 应写进工作目录：%v %q（status=%s error=%s）", err, b, res.Status, res.Error)
	}
}
