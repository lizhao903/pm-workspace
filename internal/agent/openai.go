package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// openAIChat 打 POST {base_url}/chat/completions，stream=true，标准 SSE。
// 一切 /v1 兼容端点（DeepSeek、Moonshot、vLLM…）走的都是这一份。
type openAIChat struct {
	baseURL string
	apiKey  string
}

func (c *openAIChat) Stream(ctx context.Context, req Request, on func(Event)) error {
	body := map[string]any{
		"model":    req.Model,
		"messages": openAIMessages(req.Messages),
		"stream":   true,
	}
	if len(req.Tools) > 0 {
		body["tools"] = openAITools(req.Tools)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("编码请求体失败: %w", err)
	}

	url := strings.TrimRight(c.baseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("base_url 不是合法的地址")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := streamClient.Do(httpReq)
	if err != nil {
		return transportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return upstreamError(resp.StatusCode)
	}
	return parseOpenAIStream(resp.Body, on)
}

// parseOpenAIStream 读标准 SSE：data: 开头的行是一个 JSON chunk，data: [DONE] 收尾。
//
// 工具调用在 OpenAI 的流里是碎的：name 通常只在第一片出现，arguments 一片一片拼。
// 所以要按 index 攒齐，等整个流结束再一次性吐出去。
func parseOpenAIStream(r io.Reader, on func(Event)) error {
	type toolAcc struct {
		id, name string
		args     strings.Builder
	}
	acc := map[int]*toolAcc{}

	sc := bufio.NewScanner(r)
	// SSE 单行可能很长（一大段 arguments 挤在一片里），默认 64KB 上限不够。
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		// 单个 chunk 解析失败就跳过：一片坏数据不该让整段已经收到的回答作废。
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				on(Event{Kind: EventDelta, Text: ch.Delta.Content})
			}
			for _, tc := range ch.Delta.ToolCalls {
				a := acc[tc.Index]
				if a == nil {
					a = &toolAcc{}
					acc[tc.Index] = a
				}
				if tc.ID != "" {
					a.id = tc.ID
				}
				if tc.Function.Name != "" {
					a.name = tc.Function.Name
				}
				a.args.WriteString(tc.Function.Arguments)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("读取模型响应流中断")
	}

	// 按 index 升序吐出，保证工具的执行顺序和模型给出的顺序一致。
	idx := make([]int, 0, len(acc))
	for i := range acc {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		a := acc[i]
		if a.name == "" {
			continue
		}
		on(Event{Kind: EventToolCall, Call: ToolCall{
			ID: a.id, Name: a.name, Args: defaultArgs(a.args.String()),
		}})
	}
	return nil
}

func openAIMessages(msgs []Message) []map[string]any {
	out := make([]map[string]any, 0, len(msgs))
	for _, m := range msgs {
		item := map[string]any{"role": m.Role, "content": m.Content}
		switch {
		case m.Role == domain.RoleTool:
			// tool 消息必须带上 tool_call_id，模型据此把结果对回那一次调用。
			item["tool_call_id"] = m.ToolCallID
			item["name"] = m.ToolName
		case len(m.ToolCalls) > 0:
			calls := make([]map[string]any, 0, len(m.ToolCalls))
			for _, c := range m.ToolCalls {
				calls = append(calls, map[string]any{
					"id":   c.ID,
					"type": "function",
					"function": map[string]any{
						"name":      c.Name,
						"arguments": c.Args,
					},
				})
			}
			item["tool_calls"] = calls
		}
		out = append(out, item)
	}
	return out
}

func openAITools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.Parameters,
			},
		})
	}
	return out
}

// defaultArgs 把空参数补成空对象：无参工具的 arguments 常常是空串，
// 下游按 JSON 解析会直接失败。
func defaultArgs(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}
