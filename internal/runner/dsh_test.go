// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// fakeDSH 把一段 shell 写成可执行文件，当作 dsh 用。
//
// 和 fakeClaude 一样，测试一律不调真的 dsh：它依赖 npm 包、网络和账号密钥，
// 任何一条不满足都会让「事件流翻得对不对」这种纯本地的性质测不出来。
// 事件样本直接取自 dsh 仓库 headless 的期望输出（session.expected.jsonl），
// 字段名改了就说明上游词汇表变了，测试会红。
func fakeDSH(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-dsh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake dsh: %v", err)
	}
	return path
}

// dshScript 是一段完整的假 dsh：把 stdin 和密钥落盘（好断言任务和密钥真的递过去了），
// 再照原样吐一段 --json 事件流。
func dshScript(exitCode int, lines ...string) string {
	var b strings.Builder
	b.WriteString("cat > stdin.txt\n")
	b.WriteString("printf '%s' \"$PMW_DSH_API_KEY\" > key.txt\n")
	b.WriteString("printf '%s\\n'")
	for _, l := range lines {
		b.WriteString(" '" + l + "'")
	}
	b.WriteString("\n")
	b.WriteString("exit " + strconv.Itoa(exitCode) + "\n")
	return b.String()
}

// dshCompleted 是一条成功的完整流：一段正文、一次工具往返、一个 completed 的收尾。
// dshCompleted 是实测的 0.2.1 事件序列（成功那一轮）：正文、工具往返、turn_end 完成。
// 注意 final 不带 reason——这一版的 final 只有 text，成败靠退出码和 turn_end 判断。
func dshCompleted() []string {
	return []string{
		`{"type":"session","sessionId":"session-1","cwd":"/tmp"}`,
		`{"type":"status","phase":"turn_start","turn":1}`,
		`{"type":"text","text":"先看目录。"}`,
		`{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls"}}`,
		`{"type":"tool_result","callId":"c1","status":"completed","result":"a.txt"}`,
		`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}`,
		`{"type":"final","text":"做完了"}`,
	}
}

func dshRequest(t *testing.T, bin string) Request {
	t.Helper()
	return Request{
		RunID:   "run_dsh01",
		Workdir: t.TempDir(),
		Prompt:  "把需求整理成方案",
		Harness: HarnessDeepSeek,
		DeepSeek: &DeepSeekRoute{
			Kind:    domain.ProviderOpenAI,
			BaseURL: "https://api.deepseek.com",
			Model:   "deepseek-chat",
			APIKey:  "sk-test-123",
			Bin:     bin,
		},
	}
}

// --- 参数 ---

func TestParseHarness(t *testing.T) {
	cases := []struct {
		in      string
		want    Harness
		wantErr bool
	}{
		{"", HarnessClaude, false},
		{"claude", HarnessClaude, false},
		{"deepseek", HarnessDeepSeek, false},
		{"  deepseek  ", HarnessDeepSeek, false},
		{"codex", HarnessCodex, false},
		{"unknown", "", true},
	}
	for _, c := range cases {
		got, err := ParseHarness(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("%q 应该被拒绝", c.in)
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("%q: want validation error, got %v", c.in, err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("%q: got %q, %v", c.in, got, err)
		}
	}
}

// TestHarnessValuesMatchDomain 守住两处常量的字面值。
//
// runner 的 Harness 决定起哪个进程，domain 的 RunHarness 负责落库；
// 两边一旦拼错，界面历史里就会出现一个谁都不认识的执行器。
func TestHarnessValuesMatchDomain(t *testing.T) {
	if string(HarnessClaude) != domain.RunHarnessClaude ||
		string(HarnessDeepSeek) != domain.RunHarnessDeepSeek {
		t.Fatalf("常量对不上：runner %q/%q，domain %q/%q",
			HarnessClaude, HarnessDeepSeek, domain.RunHarnessClaude, domain.RunHarnessDeepSeek)
	}
}

func TestBuildDSHArgs(t *testing.T) {
	got := strings.Join(buildDSHArgs("headless", "/tmp/p.yml", ""), " ")
	want := "--profile headless --patch /tmp/p.yml --json -"
	if got != want {
		t.Fatalf("命令行不对：\n got %s\nwant %s", got, want)
	}
	// 末尾的 "-" 是任务走 stdin 的开关，掉了 dsh 就会等一个不存在的任务。
	if !strings.HasSuffix(got, " -") {
		t.Fatal("必须用 - 让 dsh 从 stdin 读任务")
	}
	// 0.2.x 的 headless 只认 --json / --session-id；多传一个参数会被当成任务文本。
	for _, bad := range []string{"--approval-policy", "--permission-mode", "--add-dir"} {
		if strings.Contains(got, bad) {
			t.Fatalf("这一版 dsh 不认 %s，传了会把它当任务文本：%s", bad, got)
		}
	}

	resume := strings.Join(buildDSHArgs("headless", "/tmp/p.yml", "session-abc"), " ")
	if !strings.Contains(resume, "--session-id session-abc") {
		t.Fatalf("续跑要带上会话 id：%s", resume)
	}
}

func TestWriteDSHPatch(t *testing.T) {
	route := DeepSeekRoute{
		Kind:    domain.ProviderOpenAI,
		BaseURL: "https://api.deepseek.com",
		Model:   "deepseek-chat",
		APIKey:  "sk-must-not-appear",
	}

	readOnly, err := writeDSHPatch(t.TempDir(), route, "openai-completions", "/work/a b", DSHReadOnly, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	body := mustRead(t, readOnly)
	for _, want := range []string{
		"id: llm-pi-ai", "provider: pmw", "apiKeyEnv: PMW_DSH_API_KEY",
		`api: "openai-completions"`, `baseURL: "https://api.deepseek.com"`,
		`model: "deepseek-chat"`, `cwd: "/work/a b"`, `mode: "read-only"`,
		// 少了 agent-default-model，headless 会用 deepseek-official 的默认模型，
		// 根本走不到我们这条路由（实测报 no API key for provider route）。
		"id: agent-default-model",
		// 审批策略必须显式 never，否则 headless 会停在没人回答的确认上。
		"id: approval", "policy: never",
		// 预设表要和「沙箱档位 + 审批策略」对得上，否则 permission 插件不激活。
		"id: permission", "defaultPreset: read-only",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("patch 里缺 %q：\n%s", want, body)
		}
	}
	// 密钥只能走进程环境：写进文件就留在磁盘上了。
	if strings.Contains(body, route.APIKey) {
		t.Fatal("patch 里不能出现密钥")
	}
	if strings.Contains(body, "additionalWritableRoots") {
		t.Fatal("只读执行不该给额外的可写目录")
	}

	writable, err := writeDSHPatch(t.TempDir(), route, "openai-completions", "/work", DSHWorkspaceWrite, []string{"/data/x"},
		&MCPEndpoint{Bin: "/opt/pmw/pmw-mcp", API: "http://127.0.0.1:7796/"})
	if err != nil {
		t.Fatal(err)
	}
	body = mustRead(t, writable)
	if !strings.Contains(body, `mode: "workspace-write"`) || !strings.Contains(body, "defaultPreset: workspace-write") {
		t.Fatalf("勾了允许修改文件就该给 workspace-write：\n%s", body)
	}
	if !strings.Contains(body, `- "/data/x"`) {
		t.Fatalf("软链接进来的目录要进 additionalWritableRoots：\n%s", body)
	}
	// 工作台 MCP（TSK-0722）：同一个 server 名、stdio、--api 去掉末尾斜杠
	for _, want := range []string{
		"- insert:\n    - id: mcp-pmw-run", `name: "@deepseek-ai/dsh-mcp-client"`, `serverName: "pmw-run"`,
		"transport: stdio", `command: "/opt/pmw/pmw-mcp"`, `- "--api"`, `- "http://127.0.0.1:7796"`, `- "--actor"`, `- "deepseek"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("patch 里缺工作台 MCP 的 %q：\n%s", want, body)
		}
	}
	if strings.Contains(mustRead(t, readOnly), "dsh-mcp-client") {
		t.Fatal("没给 MCP 时不该挂 MCP 客户端")
	}
}

// TestDSHSandboxMode 钉住权限档位到 dsh 沙箱档位的对应（TSK-0722）：两档写入同为 workspace-write，
// 自定义白名单没有对应、必须拒绝而不是悄悄放宽；永远不给 danger-full-access。
func TestDSHSandboxMode(t *testing.T) {
	cases := []struct {
		perm  string
		allow bool
		want  string
		err   bool
	}{
		{"", false, DSHReadOnly, false},
		{"", true, DSHWorkspaceWrite, false},
		{PermReadOnly, true, DSHReadOnly, false},
		{PermAcceptEdits, false, DSHWorkspaceWrite, false},
		{PermEditsAndTests, false, DSHWorkspaceWrite, false},
		{PermCustom, true, "", true},
		{"danger", true, "", true},
	}
	for _, c := range cases {
		got, err := DSHSandboxMode(c.perm, c.allow)
		if (err != nil) != c.err || got != c.want {
			t.Errorf("DSHSandboxMode(%q, %v) = %q, %v；期望 %q，出错=%v", c.perm, c.allow, got, err, c.want, c.err)
		}
		if got == "danger-full-access" {
			t.Fatal("工作台不该替用户开 danger-full-access")
		}
	}
}

// TestDSHOllama：本机 Ollama 服务商按 OpenAI 兼容接，地址补 /v1（TSK-0722）；gemini 仍拒绝。
func TestDSHOllama(t *testing.T) {
	if api, err := dshAPI(domain.ProviderOllama); err != nil || api != "openai-completions" {
		t.Fatalf("ollama 应按 openai-completions 接：%q %v", api, err)
	}
	if _, err := dshAPI(domain.ProviderGemini); err == nil {
		t.Fatal("gemini 没有对应协议，应拒绝")
	}
	for in, want := range map[string]string{
		"http://localhost:11434":     "http://localhost:11434/v1",
		"http://localhost:11434/":    "http://localhost:11434/v1",
		"http://localhost:11434/v1/": "http://localhost:11434/v1",
	} {
		if got := dshBaseURL(domain.ProviderOllama, in); got != want {
			t.Errorf("dshBaseURL(ollama, %q) = %q，期望 %q", in, got, want)
		}
	}
	if got := dshBaseURL(domain.ProviderOpenAI, "https://api.deepseek.com/"); got != "https://api.deepseek.com" {
		t.Errorf("OpenAI 兼容的地址不该补 /v1：%q", got)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// --- 事件流 ---

func TestParseDSHLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []Event
	}{
		{"正文", `{"type":"text","text":"看完了"}`,
			[]Event{{Type: EventDelta, Text: "看完了"}}},
		{"空正文不入流", `{"type":"text","text":""}`, nil},
		// 0.2.x 发 tool + input（对象）
		{"工具调用（0.2.x）", `{"type":"tool_call","callId":"c9","tool":"bash","input":{"command":"go test ./..."}}`,
			[]Event{{Type: EventTool, ID: "c9", Name: "bash", Detail: "go test ./..."}}},
		// 新版发 name + arguments（JSON 字符串）：两套都得认
		{"工具调用（新版）", `{"type":"tool_call","callId":"c9","name":"bash","arguments":"{\"command\":\"go test ./...\"}"}`,
			[]Event{{Type: EventTool, ID: "c9", Name: "bash", Detail: "go test ./..."}}},
		{"工具成功", `{"type":"tool_result","callId":"c9","status":"completed","result":"ok"}`,
			[]Event{{Type: EventToolResult, ID: "c9", OK: true}}},
		{"工具失败带结构化错误", `{"type":"tool_result","callId":"c9","status":"error","result":"","error":{"message":"permission denied"}}`,
			[]Event{{Type: EventToolResult, ID: "c9", OK: false, Message: "permission denied"}}},
		{"草稿纸不展示", `{"type":"thinking","text":"嗯"}`, nil},
		{"轮次状态不展示", `{"type":"status","phase":"step_start","turn":1,"step":1}`, nil},
		{"不认识的类型忽略", `{"type":"brand-new-event","x":1}`, nil},
		{"不是 JSON 的行忽略", `npm warn something`, nil},
	}
	for _, c := range cases {
		got := parseDSHLine([]byte(c.line))
		if len(got) != len(c.want) {
			t.Fatalf("%s: got %d events, want %d", c.name, len(got), len(c.want))
		}
		for i := range c.want {
			if got[i] != c.want[i] {
				t.Fatalf("%s: got %+v, want %+v", c.name, got[i], c.want[i])
			}
		}
	}
}

func TestDSHStreamSignals(t *testing.T) {
	// final 只提供答复正文。实测成功和失败都带同一种 final（没有 reason），
	// 所以它绝不能自己决定成败——否则每次成功都会被标成红的。
	if text, ok := dshFinalOf([]byte(`{"type":"final","text":"答案"}`)); !ok || text != "答案" {
		t.Fatalf("final 解析不对：%q %v", text, ok)
	}
	if _, ok := dshFinalOf([]byte(`{"type":"text","text":"x"}`)); ok {
		t.Fatal("非 final 行不该被认成收尾")
	}

	// 成败看 turn_end。
	if kind, _, ok := dshTurnEndOf([]byte(`{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}`)); !ok || kind != "completed" {
		t.Fatalf("turn_end 解析不对：%q %v", kind, ok)
	}
	kind, msg, ok := dshTurnEndOf([]byte(
		`{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"message":"Connection error.","code":"TRANSPORT"}}}`))
	if !ok || kind != "error" || msg != "Connection error." {
		t.Fatalf("失败原因要从 turn_end 里取：%q %q %v", kind, msg, ok)
	}

	// 会话 id 是续跑的前提。
	if sid, ok := dshSessionOf([]byte(`{"type":"session","sessionId":"session-1","cwd":"/tmp"}`)); !ok || sid != "session-1" {
		t.Fatalf("会话 id 解析不对：%q %v", sid, ok)
	}
}

// --- 跑一整次 ---

func TestStartDSHRunsAndReports(t *testing.T) {
	var evs []Event
	req := dshRequest(t, fakeDSH(t, dshScript(0, dshCompleted()...)))
	r := &Runner{}

	res, err := r.Start(context.Background(), req, collect(&evs))
	if err != nil {
		t.Fatalf("不该失败：%v", err)
	}
	if res.Status != domain.RunDone || res.ExitCode != 0 {
		t.Fatalf("got %s / %d, want done / 0（err=%q）", res.Status, res.ExitCode, res.Error)
	}

	// 任务走 stdin，不走命令行：一次带上下文的提示词塞不进 argv。
	if got := strings.TrimSpace(mustRead(t, filepath.Join(req.Workdir, "stdin.txt"))); got != req.Prompt {
		t.Fatalf("任务没递到 stdin：got %q", got)
	}
	// 密钥走进程环境，patch 文件里没有它。
	if got := mustRead(t, filepath.Join(req.Workdir, "key.txt")); got != req.DeepSeek.APIKey {
		t.Fatalf("密钥没递到进程环境：got %q", got)
	}

	var sawDelta, sawTool, sawToolResult bool
	for _, ev := range evs {
		switch ev.Type {
		case EventDelta:
			sawDelta = sawDelta || ev.Text == "先看目录。"
		case EventTool:
			sawTool = sawTool || (ev.Name == "bash" && ev.Detail == "ls")
		case EventToolResult:
			// tool_result 那行只给 callId，名字由 readDSHStream 补。
			sawToolResult = sawToolResult || (ev.ID == "c1" && ev.Name == "bash" && ev.OK)
		}
	}
	if !sawDelta || !sawTool || !sawToolResult {
		t.Fatalf("事件不全：delta=%v tool=%v result=%v", sawTool, sawDelta, sawToolResult)
	}

	// 落库的过程记录要人读得懂，不是一堆 JSON。
	if !strings.Contains(res.Output, "先看目录。") || !strings.Contains(res.Output, "[工具] bash") {
		t.Fatalf("过程记录不对：\n%s", res.Output)
	}
	// 草稿纸不该进过程记录。
	if strings.Contains(res.Output, "草稿不该出现") {
		t.Fatal("thinking 不该进过程记录")
	}
}

func TestStartDSHFailureCarriesReason(t *testing.T) {
	// 实测的失败形状：turn_end 带 error，final 是空文本、没有 reason。
	lines := []string{
		`{"type":"session","sessionId":"session-1","cwd":"/tmp"}`,
		`{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"模型返回 401","code":"HTTP_401"}}}`,
		`{"type":"final","text":""}`,
	}
	req := dshRequest(t, fakeDSH(t, dshScript(1, lines...)))
	res, err := (&Runner{}).Start(context.Background(), req, func(Event) {})
	if err != nil {
		t.Fatalf("进程起来了就不该回 error：%v", err)
	}
	if res.Status != domain.RunFailed {
		t.Fatalf("got %s, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "模型返回 401") {
		t.Fatalf("失败原因要带上 dsh 自己的说法：%q", res.Error)
	}
}

func TestStartDSHDirectFailure(t *testing.T) {
	// 直接驱动器失败：只有 error 事件，没有 final。这时失败原因只能来自它。
	req := dshRequest(t, fakeDSH(t, dshScript(1, `{"type":"error","code":"startup","message":"profile pmw 不存在"}`)))
	res, err := (&Runner{}).Start(context.Background(), req, func(Event) {})
	if err != nil {
		t.Fatalf("进程起来了就不该回 error：%v", err)
	}
	if res.Status != domain.RunFailed {
		t.Fatalf("got %s, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "profile pmw 不存在") {
		t.Fatalf("error 事件要变成失败原因：%q", res.Error)
	}
}

func TestStartDSHRejectsMissingRoute(t *testing.T) {
	r := &Runner{}
	req := Request{RunID: "run_x", Workdir: t.TempDir(), Prompt: "x", Harness: HarnessDeepSeek}
	_, err := r.Start(context.Background(), req, nil)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("没有模型路由时必须拒绝：%v", err)
	}
	if !strings.Contains(err.Error(), "设置 > 模型") {
		t.Fatalf("要说清下一步该去哪配：%q", err.Error())
	}
}

func TestStartDSHRejectsUnsupportedProtocol(t *testing.T) {
	req := dshRequest(t, fakeDSH(t, "exit 0"))
	// ollama 有 OpenAI 兼容端点，TSK-0722 起按 OpenAI 兼容接；gemini 没有对应协议
	req.DeepSeek.Kind = domain.ProviderGemini
	_, err := (&Runner{}).Start(context.Background(), req, nil)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("gemini 没有对应的 dsh 协议，必须拒绝：%v", err)
	}
	if !strings.Contains(err.Error(), "OpenAI") {
		t.Fatalf("要说清能用什么协议：%q", err.Error())
	}
}
