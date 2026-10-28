package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// collect 把一次 Stream 的事件摊平成「文本」和「工具调用」两份，方便断言。
// 这三家的流格式差异很大，但收敛到 Event 之后应该长得一模一样——这正是要验的东西。
func collect(t *testing.T, c Chat, req Request) (string, []ToolCall) {
	t.Helper()
	var text strings.Builder
	var calls []ToolCall
	if err := c.Stream(context.Background(), req, func(ev Event) {
		switch ev.Kind {
		case EventDelta:
			text.WriteString(ev.Text)
		case EventToolCall:
			calls = append(calls, ev.Call)
		}
	}); err != nil {
		t.Fatalf("stream: %v", err)
	}
	return text.String(), calls
}

// stubServer 起一个只回固定 body 的假上游，并把收到的请求体交给回调断言。
// 全程本机 httptest，不出网。
func stubServer(t *testing.T, contentType, body string, onReq func(path string, payload map[string]any)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if onReq != nil {
			raw, _ := io.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(raw, &payload)
			onReq(r.URL.Path, payload)
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// --- OpenAI：SSE，工具调用分片到达 ---

func TestOpenAIStreamParsesSSEAndFragmentedToolCalls(t *testing.T) {
	// arguments 被拆成四片，name 只在第一片出现——这是 OpenAI 流的真实形态，
	// 也是它与另外两家最大的差别。
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"好的"}}]}`,
		`data: {"choices":[{"delta":{"content":"，这就记下来。"}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"create_object","arguments":"{\"type_id\""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"task\","}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"title\":\"和财务对账\""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}`,
		`data: [DONE]`,
		``,
	}, "\n\n")

	var gotPath string
	var gotPayload map[string]any
	srv := stubServer(t, "text/event-stream", body, func(p string, payload map[string]any) {
		gotPath, gotPayload = p, payload
	})

	c, err := New(domain.ProviderOpenAI, srv.URL, "sk-secret-key-0001")
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	text, calls := collect(t, c, Request{
		Model:    "gpt-test",
		Messages: []Message{{Role: domain.RoleUser, Content: "记一个待办"}},
		Tools:    []ToolDef{{Name: "create_object", Description: "建对象", Parameters: obj(props{}, nil)}},
	})

	if gotPath != "/chat/completions" {
		t.Errorf("端点 = %q，期望 /chat/completions", gotPath)
	}
	if gotPayload["stream"] != true {
		t.Errorf("必须带 stream:true，得到 %v", gotPayload["stream"])
	}
	if text != "好的，这就记下来。" {
		t.Errorf("文本 = %q", text)
	}
	if len(calls) != 1 {
		t.Fatalf("工具调用数 = %d，期望 1", len(calls))
	}
	if calls[0].Name != "create_object" || calls[0].ID != "call_1" {
		t.Errorf("调用 = %+v", calls[0])
	}
	// 四片必须被拼回成一个完整可解析的 JSON。
	var args map[string]any
	if err := json.Unmarshal([]byte(calls[0].Args), &args); err != nil {
		t.Fatalf("分片参数没有被拼成合法 JSON: %v（原文 %q）", err, calls[0].Args)
	}
	if args["type_id"] != "task" || args["title"] != "和财务对账" {
		t.Errorf("参数 = %v", args)
	}
}

func TestOpenAIStreamKeepsMultipleToolCallsInIndexOrder(t *testing.T) {
	// 两个工具调用交错到达，必须按 index 而不是到达顺序吐出。
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{}"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}]}}]}`,
		`data: [DONE]`,
		``,
	}, "\n\n")
	srv := stubServer(t, "text/event-stream", body, nil)

	c, _ := New(domain.ProviderOpenAI, srv.URL, "")
	_, calls := collect(t, c, Request{Model: "m"})
	if len(calls) != 2 {
		t.Fatalf("工具调用数 = %d，期望 2", len(calls))
	}
	if calls[0].Name != "first" || calls[1].Name != "second" {
		t.Errorf("顺序错了: %s, %s", calls[0].Name, calls[1].Name)
	}
}

// --- Ollama：NDJSON，工具调用一次给全且 arguments 是对象 ---

func TestOllamaStreamParsesNDJSON(t *testing.T) {
	// 注意这里没有 data: 前缀、没有空行分隔、没有 [DONE]，
	// 而且 arguments 是 JSON 对象不是字符串——与 OpenAI 逐条都不同。
	body := strings.Join([]string{
		`{"message":{"role":"assistant","content":"好的"},"done":false}`,
		`{"message":{"role":"assistant","content":"，记下了。"},"done":false}`,
		`{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"create_object","arguments":{"type_id":"task","title":"和财务对账"}}}]},"done":false}`,
		`{"message":{"role":"assistant","content":""},"done":true}`,
		``,
	}, "\n")

	var gotPath string
	var gotPayload map[string]any
	srv := stubServer(t, "application/x-ndjson", body, func(p string, payload map[string]any) {
		gotPath, gotPayload = p, payload
	})

	c, err := New(domain.ProviderOllama, srv.URL, "")
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	text, calls := collect(t, c, Request{
		Model:    "qwen3.5:4b",
		Messages: []Message{{Role: domain.RoleUser, Content: "记一个待办"}},
		Tools:    []ToolDef{{Name: "create_object", Parameters: obj(props{}, nil)}},
	})

	if gotPath != "/api/chat" {
		t.Errorf("端点 = %q，期望 /api/chat", gotPath)
	}
	if gotPayload["stream"] != true {
		t.Errorf("必须带 stream:true，得到 %v", gotPayload["stream"])
	}
	if text != "好的，记下了。" {
		t.Errorf("文本 = %q", text)
	}
	if len(calls) != 1 {
		t.Fatalf("工具调用数 = %d，期望 1", len(calls))
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(calls[0].Args), &args); err != nil {
		t.Fatalf("对象型 arguments 没有被原样保留成合法 JSON: %v", err)
	}
	if args["type_id"] != "task" || args["title"] != "和财务对账" {
		t.Errorf("参数 = %v", args)
	}
	// Ollama 不给 call id，必须自己编一个，否则 tool 结果无从对回。
	if calls[0].ID == "" {
		t.Error("应当为 Ollama 的工具调用补一个 id")
	}
}

// TestOllamaStreamDropsThinking 确认思考内容不会被当成回答吐给用户。
// qwen3.5 这类带思考的模型会额外给一个 thinking 字段，透出去对话框里就是一大段自言自语。
func TestOllamaStreamDropsThinking(t *testing.T) {
	body := strings.Join([]string{
		`{"message":{"role":"assistant","thinking":"用户想记待办，我应该调 create_object……","content":""},"done":false}`,
		`{"message":{"role":"assistant","content":"已经记下了。"},"done":true}`,
		``,
	}, "\n")
	srv := stubServer(t, "application/x-ndjson", body, nil)

	c, _ := New(domain.ProviderOllama, srv.URL, "")
	text, _ := collect(t, c, Request{Model: "qwen3.5:4b"})
	if text != "已经记下了。" {
		t.Errorf("thinking 泄漏进了回答: %q", text)
	}
}

// TestOllamaStreamSurfacesInlineError 覆盖 Ollama 的一个坑：
// 模型不存在这类错误它回 HTTP 200，错误藏在流里的 error 字段。
func TestOllamaStreamSurfacesInlineError(t *testing.T) {
	srv := stubServer(t, "application/x-ndjson", `{"error":"model 'nope' not found"}`+"\n", nil)
	c, _ := New(domain.ProviderOllama, srv.URL, "")
	err := c.Stream(context.Background(), Request{Model: "nope"}, func(Event) {})
	if err == nil {
		t.Fatal("流里的 error 字段应当转成错误返回")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("错误信息应带上上游说法，得到 %q", err)
	}
}

// --- Gemini：SSE，functionCall 与 text 并列在 parts 里 ---

func TestGeminiStreamParsesSSEAndFunctionCall(t *testing.T) {
	body := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"好的"}]}}]}`,
		`data: {"candidates":[{"content":{"parts":[{"text":"，记下了。"}]}}]}`,
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"create_object","args":{"type_id":"task","title":"和财务对账"}}}]}}]}`,
		``,
	}, "\n\n")

	var gotPath, gotQuery string
	var gotPayload map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotPayload)
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)

	c, err := New(domain.ProviderGemini, srv.URL, "AIza-secret-0001")
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	text, calls := collect(t, c, Request{
		Model: "gemini-test",
		Messages: []Message{
			{Role: RoleSystem, Content: "你是助理"},
			{Role: domain.RoleUser, Content: "记一个待办"},
		},
		Tools: []ToolDef{{Name: "create_object", Parameters: obj(props{}, nil)}},
	})

	if !strings.HasSuffix(gotPath, ":streamGenerateContent") {
		t.Errorf("端点 = %q，期望以 :streamGenerateContent 结尾", gotPath)
	}
	if !strings.Contains(gotQuery, "alt=sse") {
		t.Errorf("要带 alt=sse 才是标准 SSE，query = %q", gotQuery)
	}
	// system 必须走 systemInstruction，混进 contents 会被 Gemini 拒。
	if _, ok := gotPayload["systemInstruction"]; !ok {
		t.Error("system 消息应当放进 systemInstruction")
	}
	if text != "好的，记下了。" {
		t.Errorf("文本 = %q", text)
	}
	if len(calls) != 1 || calls[0].Name != "create_object" {
		t.Fatalf("工具调用 = %+v", calls)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(calls[0].Args), &args); err != nil {
		t.Fatalf("args 不是合法 JSON: %v", err)
	}
	if args["title"] != "和财务对账" {
		t.Errorf("参数 = %v", args)
	}
}

// --- 跨供应商的共同约定 ---

// TestUpstreamErrorsNeverLeakCredentials 是一条安全断言而不是功能断言：
// Gemini 把密钥放在 query 上，上游报错时常把整个 URL 回显出来。
// 任何往上抛的 error 都不许夹带密钥。
func TestUpstreamErrorsNeverLeakCredentials(t *testing.T) {
	const secret = "AIza-super-secret-key-9999"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 刻意模拟「把请求 URL 原样回显」的上游错误体。
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid key in `+r.URL.String()+`"}}`)
	}))
	t.Cleanup(srv.Close)

	for _, kind := range []string{domain.ProviderGemini, domain.ProviderOpenAI, domain.ProviderAnthropic} {
		c, err := New(kind, srv.URL, secret)
		if err != nil {
			t.Fatalf("new %s: %v", kind, err)
		}
		err = c.Stream(context.Background(), Request{Model: "m"}, func(Event) {})
		if err == nil {
			t.Fatalf("%s: 401 应当返回错误", kind)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("%s: 错误信息里泄漏了密钥: %q", kind, err)
		}
	}
}

// TestUnknownProviderKindRejected 确认没有「默默当成 openai 处理」的兜底。
func TestUnknownProviderKindRejected(t *testing.T) {
	if _, err := New("bedrock", "http://x", ""); err == nil {
		t.Fatal("未知 kind 应当报错")
	}
}

// --- Anthropic：SSE，按 content block 组织，工具参数走 input_json_delta ---

func TestAnthropicStreamParsesContentBlocks(t *testing.T) {
	// 真实流里每个 data: 前面还有一行 event:，解析只看 data 里的 type。
	body := strings.Join([]string{
		"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"content\":[]}}",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"用户想记待办……\"}}",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"好的\"}}",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"，记下了。\"}}",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}",
		"event: ping\ndata: {\"type\":\"ping\"}",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"create_object\",\"input\":{}}}",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"type_id\\\": \\\"task\\\",\"}}",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\" \\\"title\\\": \\\"和财务对账\\\"}\"}}",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}",
		"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_2\",\"name\":\"list_types\",\"input\":{}}}",
		"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":3}",
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}",
		``,
	}, "\n\n")

	var gotPath, gotKey, gotVersion, gotAuth string
	var gotPayload map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotPayload)
		gotPath = r.URL.Path
		gotKey, gotVersion = r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)

	c, err := New(domain.ProviderAnthropic, srv.URL, "sk-ant-secret-0001")
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	text, calls := collect(t, c, Request{
		Model: "claude-test",
		Messages: []Message{
			{Role: RoleSystem, Content: "你是助理"},
			{Role: domain.RoleUser, Content: "记一个待办"},
		},
		Tools: []ToolDef{{Name: "create_object", Description: "建对象", Parameters: obj(props{}, nil)}},
	})

	if gotPath != "/v1/messages" {
		t.Errorf("端点 = %q，期望 /v1/messages", gotPath)
	}
	if gotKey != "sk-ant-secret-0001" || gotVersion != AnthropicVersion || gotAuth != "" {
		t.Errorf("鉴权头 x-api-key=%q anthropic-version=%q Authorization=%q", gotKey, gotVersion, gotAuth)
	}
	if gotPayload["stream"] != true || gotPayload["max_tokens"] == nil {
		t.Errorf("必须带 stream:true 和 max_tokens，得到 %v", gotPayload)
	}
	// system 是顶层字段，不能留在 messages 里。
	if gotPayload["system"] != "你是助理" {
		t.Errorf("system = %v", gotPayload["system"])
	}
	if msgs, _ := gotPayload["messages"].([]any); len(msgs) != 1 {
		t.Errorf("messages 应只剩 user 一条，得到 %v", gotPayload["messages"])
	}
	tools, _ := gotPayload["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["input_schema"] == nil {
		t.Errorf("tools 要用 input_schema，得到 %v", gotPayload["tools"])
	}

	if text != "好的，记下了。" {
		t.Errorf("文本 = %q（thinking 不应混进来）", text)
	}
	if len(calls) != 2 {
		t.Fatalf("工具调用数 = %d，期望 2", len(calls))
	}
	if calls[0].ID != "toolu_1" || calls[0].Name != "create_object" || calls[1].Name != "list_types" {
		t.Errorf("调用 = %+v", calls)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(calls[0].Args), &args); err != nil {
		t.Fatalf("分片参数没有被拼成合法 JSON: %v（原文 %q）", err, calls[0].Args)
	}
	if args["type_id"] != "task" || args["title"] != "和财务对账" {
		t.Errorf("参数 = %v", args)
	}
	// 没有 input_json_delta 的无参工具，参数补成空对象。
	if calls[1].Args != "{}" {
		t.Errorf("无参工具的 Args = %q，期望 {}", calls[1].Args)
	}
}

// TestAnthropicBaseURLWithV1 确认 base_url 写成带 /v1 的形式时不会拼成 /v1/v1。
func TestAnthropicBaseURLWithV1(t *testing.T) {
	var gotPath string
	srv := stubServer(t, "text/event-stream", "", func(p string, _ map[string]any) { gotPath = p })
	c, _ := New(domain.ProviderAnthropic, srv.URL+"/v1/", "k")
	if err := c.Stream(context.Background(), Request{Model: "m"}, func(Event) {}); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if gotPath != "/v1/messages" {
		t.Errorf("端点 = %q，期望 /v1/messages", gotPath)
	}
}

// TestAnthropicStreamSurfacesInlineError：overloaded 这类错误在 200 的流里以 error 事件到达。
func TestAnthropicStreamSurfacesInlineError(t *testing.T) {
	body := "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
	srv := stubServer(t, "text/event-stream", body, nil)
	c, _ := New(domain.ProviderAnthropic, srv.URL, "k")
	err := c.Stream(context.Background(), Request{Model: "m"}, func(Event) {})
	if err == nil || !strings.Contains(err.Error(), "overloaded_error") {
		t.Fatalf("error 事件应当转成错误返回，得到 %v", err)
	}
}

// TestAnthropicMessagesGroupsToolResults 覆盖回灌这一侧：assistant 的工具调用变成 tool_use 块，
// 同一轮的多个工具结果必须并进同一条 user 消息，否则 API 报 400。
func TestAnthropicMessagesGroupsToolResults(t *testing.T) {
	system, msgs := anthropicMessages([]Message{
		{Role: RoleSystem, Content: "甲"},
		{Role: RoleSystem, Content: "乙"},
		{Role: domain.RoleUser, Content: "建两个待办"},
		{Role: domain.RoleAssistant, ToolCalls: []ToolCall{
			{ID: "toolu_a", Name: "create_object", Args: `{"title":"一"}`},
			{ID: "toolu_b", Name: "create_object", Args: ""},
		}},
		{Role: domain.RoleTool, ToolCallID: "toolu_a", ToolName: "create_object", Content: "ok 一"},
		{Role: domain.RoleTool, ToolCallID: "toolu_b", ToolName: "create_object", Content: "ok 二"},
		{Role: domain.RoleAssistant, Content: "都建好了"},
		{Role: domain.RoleAssistant}, // 空轮次要丢掉
	})
	if system != "甲\n\n乙" {
		t.Errorf("system = %q", system)
	}
	if len(msgs) != 4 {
		t.Fatalf("消息数 = %d，期望 4：%v", len(msgs), msgs)
	}
	asst := msgs[1]["content"].([]map[string]any)
	if len(asst) != 2 || asst[0]["type"] != "tool_use" || asst[0]["id"] != "toolu_a" {
		t.Errorf("assistant 块 = %v", asst)
	}
	if in, ok := asst[1]["input"].(map[string]any); !ok || len(in) != 0 {
		t.Errorf("空参数应回填成空对象，得到 %v", asst[1]["input"])
	}
	if msgs[2]["role"] != "user" {
		t.Errorf("tool 结果应挂在 user 一侧，得到 %v", msgs[2]["role"])
	}
	results := msgs[2]["content"].([]map[string]any)
	if len(results) != 2 || results[0]["tool_use_id"] != "toolu_a" || results[1]["tool_use_id"] != "toolu_b" {
		t.Errorf("两个 tool_result 应并在一条 user 里，得到 %v", results)
	}
	if msgs[3]["role"] != "assistant" {
		t.Errorf("最后一条应是 assistant，得到 %v", msgs[3])
	}
}
