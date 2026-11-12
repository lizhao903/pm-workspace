// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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

// AnthropicVersion 是 Messages API 要求的版本头，没有它请求直接 400。
const AnthropicVersion = "2023-06-01"

// anthropicMaxTokens 是 max_tokens 的取值。Messages API 要求必填；
// 写文档的回答可能很长，给 8192，当前在售的 Claude 模型都支持。
const anthropicMaxTokens = 8192

// anthropicChat 打 POST {base_url}/v1/messages，stream=true，SSE。
//
// 和 OpenAI 的差别：
//  1. 鉴权走 x-api-key + anthropic-version 两个头，不是 Bearer；
//  2. system 是顶层字段，messages 里只有 user / assistant；
//  3. 工具结果是 user 消息里的 tool_result 块，同一轮的多个结果必须并进同一条 user；
//  4. 流按 content block 组织：content_block_start 给出 tool_use 的 id 和 name，
//     input_json_delta 一片片拼参数，content_block_stop 时才算齐。
type anthropicChat struct {
	baseURL string
	apiKey  string
}

// AnthropicEndpoint 拼 Messages API 的地址。base_url 写成 https://api.anthropic.com
// 或 https://api.anthropic.com/v1 都认：前者是官方 SDK 的写法，后者和 openai 的习惯一致。
func AnthropicEndpoint(baseURL, path string) string {
	base := strings.TrimRight(baseURL, "/")
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return base + path
}

func (c *anthropicChat) Stream(ctx context.Context, req Request, on func(Event)) error {
	system, msgs := anthropicMessages(req.Messages)
	body := map[string]any{
		"model":      req.Model,
		"max_tokens": anthropicMaxTokens,
		"messages":   msgs,
		"stream":     true,
	}
	if system != "" {
		body["system"] = system
	}
	if len(req.Tools) > 0 {
		body["tools"] = anthropicTools(req.Tools)
	}
	level := thinkingLevel(req.Thinking)
	return streamThinking("anthropic", req.Model, level, body, anthropicThinking(req.Model, level),
		func(b map[string]any, on func(Event)) error { return c.post(ctx, b, on) }, on)
}

func (c *anthropicChat) post(ctx context.Context, body map[string]any, on func(Event)) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("编码请求体失败: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		AnthropicEndpoint(c.baseURL, "/messages"), bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("base_url 不是合法的地址")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("anthropic-version", AnthropicVersion)
	if c.apiKey != "" {
		httpReq.Header.Set("x-api-key", c.apiKey)
	}

	resp, err := streamClient.Do(httpReq)
	if err != nil {
		return transportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return upstreamError(resp.StatusCode)
	}
	return parseAnthropicStream(resp.Body, on)
}

// parseAnthropicStream 只看 data: 行，事件类型以 JSON 里的 type 为准（event: 行与之重复）。
// thinking 块不给人看，理由同 Ollama 的 thinking 字段；但要攒齐吐成 EventThinkingBlock，
// 调工具的下一轮原样回传（见 thinking.go）。
func parseAnthropicStream(r io.Reader, on func(Event)) error {
	type toolAcc struct {
		id, name string
		args     strings.Builder
	}
	acc := map[int]*toolAcc{}
	type thinkAcc struct {
		typ, data, signature string
		text                 strings.Builder
	}
	thinks := map[int]*thinkAcc{}
	var thinkOrder []int

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}

		var ev struct {
			Type         string `json:"type"`
			Index        int    `json:"index"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
				Data string `json:"data"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				Thinking    string `json:"thinking"`
				Signature   string `json:"signature"`
			} `json:"delta"`
			Error struct {
				Type string `json:"type"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}

		switch ev.Type {
		case "content_block_start":
			switch ev.ContentBlock.Type {
			case "tool_use":
				acc[ev.Index] = &toolAcc{id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			case "thinking", "redacted_thinking":
				thinks[ev.Index] = &thinkAcc{typ: ev.ContentBlock.Type, data: ev.ContentBlock.Data}
				thinkOrder = append(thinkOrder, ev.Index)
			}
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					on(Event{Kind: EventDelta, Text: ev.Delta.Text})
				}
			case "input_json_delta":
				if a := acc[ev.Index]; a != nil {
					a.args.WriteString(ev.Delta.PartialJSON)
				}
			case "thinking_delta":
				if t := thinks[ev.Index]; t != nil {
					t.text.WriteString(ev.Delta.Thinking)
				}
			case "signature_delta":
				if t := thinks[ev.Index]; t != nil {
					t.signature += ev.Delta.Signature
				}
			}
		case "error":
			// 流中途的错误（overloaded_error 等）HTTP 状态已经是 200，只能从事件里拿。
			// 只回显类型，message 不透出。
			return fmt.Errorf("模型服务返回错误：%s", ev.Error.Type)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("读取模型响应流中断")
	}

	// thinking 块先于工具调用吐出：调用方要把它们放在下一轮 assistant 的最前面。
	for _, i := range thinkOrder {
		t := thinks[i]
		on(Event{Kind: EventThinkingBlock, Raw: thinkingBlockJSON(t.typ, t.text.String(), t.signature, t.data)})
	}

	// 和 OpenAI 一样等流结束再按 index 吐出，执行顺序与模型给出的顺序一致。
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

// anthropicMessages 把统一的消息列表翻成 Messages API 的形状，system 单独返回。
// 连续的 tool 结果并进同一条 user 消息：API 要求一轮里所有 tool_use 的结果紧跟在下一条 user 里。
func anthropicMessages(msgs []Message) (system string, out []map[string]any) {
	var sys strings.Builder
	out = []map[string]any{}
	var pending []map[string]any // 还没落成消息的 tool_result 块

	flush := func() {
		if len(pending) > 0 {
			out = append(out, map[string]any{"role": "user", "content": pending})
			pending = nil
		}
	}

	for _, m := range msgs {
		switch m.Role {
		case RoleSystem:
			if sys.Len() > 0 {
				sys.WriteString("\n\n")
			}
			sys.WriteString(m.Content)

		case domain.RoleTool:
			pending = append(pending, map[string]any{
				"type":        "tool_result",
				"tool_use_id": m.ToolCallID,
				"content":     m.Content,
			})

		case domain.RoleAssistant:
			flush()
			blocks := []map[string]any{}
			// 带工具调用时才回传 thinking 块：API 只要求调工具的那一轮带上
			if len(m.ToolCalls) > 0 {
				for _, raw := range m.Thinking {
					var b map[string]any
					if json.Unmarshal(raw, &b) == nil {
						blocks = append(blocks, b)
					}
				}
			}
			if m.Content != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, c := range m.ToolCalls {
				var input any = map[string]any{}
				if err := json.Unmarshal([]byte(defaultArgs(c.Args)), &input); err != nil {
					input = map[string]any{}
				}
				blocks = append(blocks, map[string]any{
					"type": "tool_use", "id": c.ID, "name": c.Name, "input": input,
				})
			}
			if len(blocks) == 0 {
				continue // 空的 assistant 轮次会被拒
			}
			out = append(out, map[string]any{"role": "assistant", "content": blocks})

		default: // user
			flush()
			out = append(out, map[string]any{"role": "user", "content": m.Content})
		}
	}
	flush()
	return sys.String(), out
}

// anthropicTools 的 schema 字段叫 input_schema，且必须是 type=object。
func anthropicTools(tools []ToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		schema := t.Parameters
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": schema,
		})
	}
	return out
}
