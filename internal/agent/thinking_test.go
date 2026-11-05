package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 思考档位翻成各家请求参数、模型不认时降级（见 thinking.go）。全程本机 httptest。

// thinkServer 是一个假上游：记下每次请求体；reject 回 true 时这次回 rejectStatus，否则回 ok。
type thinkServer struct {
	mu     sync.Mutex
	bodies []map[string]any
}

func newThinkServer(t *testing.T, ok string, reject func(body map[string]any) bool, rejectBody string) (*httptest.Server, *thinkServer) {
	t.Helper()
	ts := &thinkServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		ts.mu.Lock()
		ts.bodies = append(ts.bodies, body)
		ts.mu.Unlock()
		if reject != nil && reject(body) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, rejectBody)
			return
		}
		_, _ = io.WriteString(w, ok)
	}))
	t.Cleanup(srv.Close)
	return srv, ts
}

const (
	okOpenAI    = "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DONE]\n\n"
	okAnthropic = "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}\n\n"
	okOllama    = "{\"message\":{\"content\":\"好\"},\"done\":true}\n"
	okGemini    = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"好\"}]}}]}\n\n"
)

func j(v any) string { b, _ := json.Marshal(v); return string(b) }

// streamOnce 发一次，回拿到的文本。
func streamOnce(t *testing.T, c Chat, model, level string) string {
	t.Helper()
	text, _ := collect(t, c, Request{Model: model, Thinking: level,
		Messages: []Message{{Role: domain.RoleUser, Content: "hi"}}})
	return text
}

// 每家每档的第一次请求体。default（含空串、不认识的值）一律不带任何思考字段。
func TestThinkingRequestBodies(t *testing.T) {
	type tc struct {
		level string
		want  map[string]string // 字段 -> 期望的 JSON；值为 "" 表示不该有这个字段
	}
	none := func(keys ...string) map[string]string {
		m := map[string]string{}
		for _, k := range keys {
			m[k] = ""
		}
		return m
	}
	cases := []struct {
		name, model, ok string
		mk              func(url string) Chat
		cases           []tc
	}{
		{"openai", "gpt-5.1", okOpenAI, func(u string) Chat { return &openAIChat{baseURL: u} }, []tc{
			{"default", none("reasoning_effort")},
			{"", none("reasoning_effort")},
			{"weird", none("reasoning_effort")},
			{"off", map[string]string{"reasoning_effort": `"none"`}},
			{"low", map[string]string{"reasoning_effort": `"low"`}},
			{"medium", map[string]string{"reasoning_effort": `"medium"`}},
			{"high", map[string]string{"reasoning_effort": `"high"`}},
		}},
		{"anthropic", "claude-opus-4-8", okAnthropic, func(u string) Chat { return &anthropicChat{baseURL: u} }, []tc{
			{"default", none("thinking", "output_config")},
			{"off", map[string]string{"thinking": `{"type":"disabled"}`, "output_config": ""}},
			{"low", map[string]string{"thinking": `{"type":"adaptive"}`, "output_config": `{"effort":"low"}`, "max_tokens": "8192"}},
			{"high", map[string]string{"thinking": `{"type":"adaptive"}`, "output_config": `{"effort":"high"}`}},
		}},
		{"anthropic 老模型", "claude-sonnet-4-5", okAnthropic, func(u string) Chat { return &anthropicChat{baseURL: u} }, []tc{
			{"medium", map[string]string{"thinking": `{"budget_tokens":8192,"type":"enabled"}`, "max_tokens": "16384", "output_config": ""}},
		}},
		{"ollama", "qwen3:8b", okOllama, func(u string) Chat { return &ollamaChat{baseURL: u} }, []tc{
			{"default", none("think")},
			{"off", map[string]string{"think": "false"}},
			{"low", map[string]string{"think": "true"}},
			{"high", map[string]string{"think": "true"}},
		}},
		{"ollama gpt-oss", "gpt-oss:20b", okOllama, func(u string) Chat { return &ollamaChat{baseURL: u} }, []tc{
			{"off", map[string]string{"think": `"low"`}},
			{"medium", map[string]string{"think": `"medium"`}},
			{"high", map[string]string{"think": `"high"`}},
		}},
		{"gemini", "gemini-2.5-flash", okGemini, func(u string) Chat { return &geminiChat{baseURL: u, apiKey: "k"} }, []tc{
			{"default", none("generationConfig")},
			{"off", map[string]string{"generationConfig": `{"thinkingConfig":{"thinkingBudget":0}}`}},
			{"low", map[string]string{"generationConfig": `{"thinkingConfig":{"thinkingBudget":1024}}`}},
			{"high", map[string]string{"generationConfig": `{"thinkingConfig":{"thinkingBudget":24576}}`}},
		}},
	}
	for _, c := range cases {
		for _, k := range c.cases {
			srv, ts := newThinkServer(t, c.ok, nil, "")
			if got := streamOnce(t, c.mk(srv.URL), c.model, k.level); got != "好" {
				t.Fatalf("%s %s：回复 %q", c.name, k.level, got)
			}
			if len(ts.bodies) != 1 {
				t.Fatalf("%s %s：应只发一次，发了 %d 次", c.name, k.level, len(ts.bodies))
			}
			b := ts.bodies[0]
			for field, want := range k.want {
				v, has := b[field]
				if want == "" {
					if has {
						t.Errorf("%s %s：不该带 %s，带了 %s", c.name, k.level, field, j(v))
					}
					continue
				}
				if !has || j(v) != want {
					t.Errorf("%s %s：%s = %s，期望 %s", c.name, k.level, field, j(v), want)
				}
			}
		}
	}
}

// 模型不认思考参数（400）时按候选写法依次换，最后去掉思考参数按 default 跑，调用不失败。
func TestThinkingFallsBackWhenRejected(t *testing.T) {
	// OpenAI 的 o 系列：none、minimal 都不认，最后不带
	srv, ts := newThinkServer(t, okOpenAI, func(b map[string]any) bool { _, has := b["reasoning_effort"]; return has }, `{"error":"unsupported value"}`)
	if got := streamOnce(t, &openAIChat{baseURL: srv.URL}, "o3", "off"); got != "好" {
		t.Fatalf("回复 %q", got)
	}
	var seen []string
	for _, b := range ts.bodies {
		seen = append(seen, j(b["reasoning_effort"]))
	}
	if strings.Join(seen, ",") != `"none","minimal",null` {
		t.Fatalf("OpenAI 降级顺序 %v", seen)
	}

	// Ollama：不支持思考的模型带 think 回 400 "does not support thinking"
	srv, ts = newThinkServer(t, okOllama, func(b map[string]any) bool { _, has := b["think"]; return has },
		`{"error":"\"llama3.2\" does not support thinking"}`)
	if got := streamOnce(t, &ollamaChat{baseURL: srv.URL}, "llama3.2", "off"); got != "好" {
		t.Fatalf("回复 %q", got)
	}
	if len(ts.bodies) != 2 {
		t.Fatalf("Ollama 应发两次，发了 %d", len(ts.bodies))
	}
	if _, has := ts.bodies[1]["think"]; has {
		t.Fatal("降级后不该再带 think")
	}

	// Anthropic：关不掉思考的模型 disabled 被拒，退成 effort low
	srv, ts = newThinkServer(t, okAnthropic, func(b map[string]any) bool { _, has := b["thinking"]; return has }, `{"type":"error"}`)
	if got := streamOnce(t, &anthropicChat{baseURL: srv.URL}, "claude-opus-5-5", "off"); got != "好" {
		t.Fatalf("回复 %q", got)
	}
	if len(ts.bodies) != 2 || j(ts.bodies[1]["output_config"]) != `{"effort":"low"}` {
		t.Fatalf("Anthropic off 降级：%v", ts.bodies)
	}

	// Gemini：2.5 Pro 关不掉，thinkingBudget 0 被拒，退成不带
	srv, ts = newThinkServer(t, okGemini, func(b map[string]any) bool { _, has := b["generationConfig"]; return has }, `{}`)
	if got := streamOnce(t, &geminiChat{baseURL: srv.URL, apiKey: "k"}, "gemini-2.5-pro", "off"); got != "好" {
		t.Fatalf("回复 %q", got)
	}
	if len(ts.bodies) != 2 {
		t.Fatalf("Gemini 应发两次，发了 %d", len(ts.bodies))
	}
}

// 不是思考参数的问题（不带思考参数也 400、或者 401）不重来，原样报错。
func TestThinkingNoRetryOnOtherErrors(t *testing.T) {
	srv, ts := newThinkServer(t, okOpenAI, func(map[string]any) bool { return true }, `{}`)
	err := (&openAIChat{baseURL: srv.URL}).Stream(context.Background(), Request{Model: "m",
		Messages: []Message{{Role: domain.RoleUser, Content: "hi"}}}, func(Event) {})
	if err == nil || len(ts.bodies) != 1 {
		t.Fatalf("default 下 400 应直接报错、只发一次：%v，%d 次", err, len(ts.bodies))
	}
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) }))
	defer srv.Close()
	n := 0
	err = streamThinking("openai", "m", "low", map[string]any{}, openAIThinking("low"), func(b map[string]any, on func(Event)) error {
		n++
		return (&openAIChat{baseURL: srv.URL}).post(context.Background(), b, on)
	}, func(Event) {})
	if err == nil || n != 1 {
		t.Fatalf("401 不该重来：%v，%d 次", err, n)
	}
}

// Claude 开思考调工具：thinking 块攒齐吐出，下一轮带 tool_use 的 assistant 前面原样带回。
func TestAnthropicThinkingBlockRoundTrip(t *testing.T) {
	body := strings.Join([]string{
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先查"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"一下"}}`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig1"}}`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"enc"}}`,
		`data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_object"}}`,
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"id\":\"x\"}"}}`,
	}, "\n\n") + "\n\n"
	var kinds []EventKind
	var blocks []json.RawMessage
	if err := parseAnthropicStream(strings.NewReader(body), func(ev Event) {
		kinds = append(kinds, ev.Kind)
		if ev.Kind == EventThinkingBlock {
			blocks = append(blocks, ev.Raw)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(kinds) != 3 || kinds[0] != EventThinkingBlock || kinds[2] != EventToolCall {
		t.Fatalf("事件顺序 %v", kinds)
	}
	if string(blocks[0]) != `{"signature":"sig1","thinking":"先查一下","type":"thinking"}` || string(blocks[1]) != `{"data":"enc","type":"redacted_thinking"}` {
		t.Fatalf("thinking 块 %s %s", blocks[0], blocks[1])
	}
	_, msgs := anthropicMessages([]Message{
		{Role: domain.RoleUser, Content: "看看 x"},
		{Role: domain.RoleAssistant, ToolCalls: []ToolCall{{ID: "tu_1", Name: "get_object", Args: `{"id":"x"}`}}, Thinking: blocks},
		{Role: domain.RoleTool, ToolCallID: "tu_1", Content: "ok"},
		{Role: domain.RoleAssistant, Content: "好了", Thinking: blocks}, // 不带工具调用的不回传
	})
	got := j(msgs[1]["content"])
	if !strings.HasPrefix(got, `[{"signature":"sig1","thinking":"先查一下","type":"thinking"},{"data":"enc","type":"redacted_thinking"},{"id":"tu_1"`) {
		t.Fatalf("回传的 assistant %s", got)
	}
	if strings.Contains(j(msgs[3]["content"]), "thinking") {
		t.Fatalf("没调工具的轮次不该带 thinking：%s", j(msgs[3]["content"]))
	}
}

// Runner 按 Agent 的思考档位发请求，并把 thinking 块挂到调工具那一轮上。
func TestRunnerThinkingFromAgent(t *testing.T) {
	block := json.RawMessage(`{"type":"thinking","thinking":"t","signature":"s"}`)
	chat := &recordingChat{script: []func(func(Event)){
		func(on func(Event)) {
			on(Event{Kind: EventThinkingBlock, Raw: block})
			on(Event{Kind: EventToolCall, Call: ToolCall{ID: "c1", Name: "no_such_tool", Args: "{}"}})
		},
		grantSay("完"),
	}}
	s, st, ctx := newService(t, chat)
	p := addProvider(t, st, ctx)
	name, think := "分诊", domain.ThinkingOff
	a, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &p.ID, Thinking: &think})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunAgent(ctx, AgentRunRequest{Agent: a.ID, Prompt: "hi"}); err != nil {
		t.Fatal(err)
	}
	if len(chat.reqs) != 2 || chat.reqs[0].Thinking != "off" || chat.reqs[1].Thinking != "off" {
		t.Fatalf("请求 %d 次，档位 %+v", len(chat.reqs), chat.reqs)
	}
	var found bool
	for _, m := range chat.reqs[1].Messages {
		if len(m.ToolCalls) > 0 && len(m.Thinking) == 1 && string(m.Thinking[0]) == string(block) {
			found = true
		}
	}
	if !found {
		t.Fatal("第二轮里调工具的 assistant 应带回 thinking 块")
	}
}

// Complete 指定 Agent：用它的服务商、模型、思考档位，指令拼在系统提示前；场景默认 Agent 在没指定时生效。
func TestServiceCompleteAgentAndScenario(t *testing.T) {
	chat := &recordingChat{}
	s, st, ctx := newService(t, chat)
	var urls []string
	s.NewChat = func(kind, baseURL, key string) (Chat, error) { urls = append(urls, baseURL); return chat, nil }
	addProvider(t, st, ctx)
	other, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "另一个", Kind: domain.ProviderOllama,
		BaseURL: "http://127.0.0.1:2", Model: "x0", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	name, think, model, ins := "内容分诊", domain.ThinkingOff, "qwen3:4b", "你给 IM 消息分诊。"
	a, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &other.ID, Model: &model, Thinking: &think, Instructions: &ins})
	if err != nil {
		t.Fatal(err)
	}

	// 1 指定 Agent：节点上的服务商、模型忽略
	if _, err := s.Complete(ctx, CompleteRequest{System: "你做分类。", Prompt: "x", Agent: a.ID, Model: "ignored"}); err != nil {
		t.Fatal(err)
	}
	// 2 没指定、场景也没选：默认服务商，default
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x"}); err != nil {
		t.Fatal(err)
	}
	// 3 其他后台调用选了它：没指定时用它
	if err := SetScenarioAgent(ctx, st, ScenarioBackground, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x"}); err != nil {
		t.Fatal(err)
	}
	// 4 编排助手场景没选：照老样子
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x", Scenario: ScenarioSOPAssist}); err != nil {
		t.Fatal(err)
	}
	// 5 指定了服务商的不走场景
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x", Provider: other.ID, Model: "x9"}); err != nil {
		t.Fatal(err)
	}
	r := chat.reqs
	want := []struct{ model, thinking, url string }{
		{"qwen3:4b", "off", "http://127.0.0.1:2"},
		{"m0", "", "http://127.0.0.1:1"},
		{"qwen3:4b", "off", "http://127.0.0.1:2"},
		{"m0", "", "http://127.0.0.1:1"},
		{"x9", "", "http://127.0.0.1:2"},
	}
	for i, w := range want {
		if r[i].Model != w.model || r[i].Thinking != w.thinking || urls[i] != w.url {
			t.Fatalf("第 %d 次：模型 %s 思考 %q 地址 %s，期望 %+v", i+1, r[i].Model, r[i].Thinking, urls[i], w)
		}
	}
	if r[0].Messages[0].Role != RoleSystem || r[0].Messages[0].Content != "你给 IM 消息分诊。\n\n你做分类。" {
		t.Fatalf("系统提示 %+v", r[0].Messages[0])
	}

	// 场景选的 Agent 停用了：退回默认服务商，不报错；明确指定停用的 Agent 要报错
	off := false
	if _, err := st.UpdateAgent(ctx, a.ID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x"}); err != nil {
		t.Fatalf("场景 Agent 停用应退回默认：%v", err)
	}
	if r := chat.reqs[len(chat.reqs)-1]; r.Model != "m0" || r.Thinking != "" {
		t.Fatalf("退回默认后 %s %q", r.Model, r.Thinking)
	}
	if _, err := s.Complete(ctx, CompleteRequest{Prompt: "x", Agent: a.ID}); err == nil {
		t.Fatal("明确指定停用的 Agent 应报错")
	}

	list, err := ListScenarios(ctx, st)
	if err != nil || len(list) != 3 || list[2].Key != ScenarioTaskRun || list[1].Key != ScenarioBackground || list[1].AgentID != a.ID || list[0].AgentID != "" {
		t.Fatalf("场景列表 %+v %v", list, err)
	}
}
