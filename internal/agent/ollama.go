package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// ollamaChat 打 POST {base_url}/api/chat，stream=true。
//
// 它的流是 NDJSON 不是 SSE：一行一个完整 JSON 对象，没有 data: 前缀，也没有 [DONE]。
// 两处与 OpenAI 的实质差异决定了这份实现不能复用那一份：
//  1. 工具调用不分片，一次给全，且 arguments 是 JSON 对象而非字符串；
//  2. 带思考能力的模型（qwen3.5 等）会额外给一个 thinking 字段——
//     那是模型的草稿纸，透给用户只会让对话框里出现一大段自言自语。
//     要不要思考由请求里的 think 决定（Agent 的思考档位，见 thinking.go）。
type ollamaChat struct {
	baseURL string
}

func (c *ollamaChat) Stream(ctx context.Context, req Request, on func(Event)) error {
	body := map[string]any{
		"model":    req.Model,
		"messages": ollamaMessages(req.Messages),
		"stream":   true,
	}
	if len(req.Tools) > 0 {
		body["tools"] = openAITools(req.Tools) // Ollama 的 tools 结构与 OpenAI 一致
	}
	level := thinkingLevel(req.Thinking)
	return streamThinking("ollama", req.Model, level, body, ollamaThinking(req.Model, level),
		func(b map[string]any, on func(Event)) error { return c.post(ctx, b, on) }, on)
}

func (c *ollamaChat) post(ctx context.Context, body map[string]any, on func(Event)) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("编码请求体失败: %w", err)
	}

	url := strings.TrimRight(c.baseURL, "/") + "/api/chat"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("base_url 不是合法的地址")
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := streamClient.Do(httpReq)
	if err != nil {
		return transportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return upstreamError(resp.StatusCode)
	}
	return parseOllamaStream(resp.Body, on)
}

// parseOllamaStream 逐行解析 NDJSON。工具调用一次给全，收到即可直接吐出，
// 不需要像 OpenAI 那样按 index 攒。
func parseOllamaStream(r io.Reader, on func(Event)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var chunk struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					Function struct {
						Name string `json:"name"`
						// Arguments 是对象，用 RawMessage 原样留着，
						// 回填给模型时不必先解析再重编码。
						Arguments json.RawMessage `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &chunk); err != nil {
			continue
		}
		// Ollama 把「模型不存在」这类错误放在流里的 error 字段，HTTP 状态仍是 200。
		if chunk.Error != "" {
			// 不支持思考的模型带了 think：归为拒收，换掉思考参数重来
			if strings.Contains(strings.ToLower(chunk.Error), "think") {
				return rejectedError{"模型服务返回错误：" + chunk.Error}
			}
			return fmt.Errorf("模型服务返回错误：%s", chunk.Error)
		}
		if chunk.Message.Content != "" {
			on(Event{Kind: EventDelta, Text: chunk.Message.Content})
		}
		for i, tc := range chunk.Message.ToolCalls {
			if tc.Function.Name == "" {
				continue
			}
			// Ollama 不给 call id，自己编一个：tool 结果要靠它对回去。
			on(Event{Kind: EventToolCall, Call: ToolCall{
				ID:   fmt.Sprintf("ollama_%s_%d", tc.Function.Name, i),
				Name: tc.Function.Name,
				Args: defaultArgs(string(tc.Function.Arguments)),
			}})
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("读取模型响应流中断")
	}
	return nil
}

// ollamaMessages 与 OpenAI 的差别只在 tool 消息：Ollama 认 tool_name，不认 tool_call_id。
func ollamaMessages(msgs []Message) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		item := map[string]any{"role": m.Role, "content": m.Content}
		switch {
		case m.Role == domain.RoleTool:
			item["tool_name"] = m.ToolName
		case len(m.ToolCalls) > 0:
			calls := make([]map[string]any, 0, len(m.ToolCalls))
			for _, c := range m.ToolCalls {
				// 回填时 arguments 要还原成对象；解析不出来就给空对象，
				// 总比塞一个模型读不懂的字符串强。
				var args any = map[string]any{}
				if err := json.Unmarshal([]byte(defaultArgs(c.Args)), &args); err != nil {
					args = map[string]any{}
				}
				calls = append(calls, map[string]any{
					"function": map[string]any{"name": c.Name, "arguments": args},
				})
			}
			item["tool_calls"] = calls
		}
		out = append(out, item)
	}
	return out
}
