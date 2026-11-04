package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
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

func TestSmokeRealDSH(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：不调外部 CLI")
	}
	bin, err := exec.LookPath(DefaultDSHBin)
	if err != nil {
		t.Skip("本机没装 dsh（npm i -g @deepseek-ai/dsh）")
	}
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
	if testing.Short() {
		t.Skip("-short：不调外部 CLI")
	}
	bin, err := exec.LookPath(DefaultDSHBin)
	if err != nil {
		t.Skip("本机没装 dsh")
	}
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
