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
	"net/url"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// geminiChat 打 POST {base_url}/models/{model}:streamGenerateContent?alt=sse&key=…
//
// 密钥走 query 是 Google 的设计，因此这个 URL 本身是敏感的：
// 它绝不能出现在 error、日志或任何返回值里（net/http 的 *url.Error 会把它拼进 Error()，
// 所以下面所有传输层错误都走 transportError 归类，不透原文）。
//
// 不加 alt=sse 的话 streamGenerateContent 回的是一个「逐步吐出的 JSON 数组」，
// 得自己做增量 JSON 解析；加上之后就是标准 SSE，一行一个完整对象。
type geminiChat struct {
	baseURL string
	apiKey  string
}

func (c *geminiChat) Stream(ctx context.Context, req Request, on func(Event)) error {
	system, contents := geminiContents(req.Messages)
	body := map[string]any{"contents": contents}
	if system != "" {
		// systemInstruction 是独立字段，不能混在 contents 里——
		// Gemini 只认 user / model 两种 role，塞个 system 进去会被拒。
		body["systemInstruction"] = map[string]any{
			"parts": []map[string]any{{"text": system}},
		}
	}
	if len(req.Tools) > 0 {
		decls := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			decls = append(decls, map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.Parameters,
			})
		}
		body["tools"] = []map[string]any{{"functionDeclarations": decls}}
	}
	level := thinkingLevel(req.Thinking)
	return streamThinking("gemini", req.Model, level, body, geminiThinking(level),
		func(b map[string]any, on func(Event)) error { return c.post(ctx, req.Model, b, on) }, on)
}

func (c *geminiChat) post(ctx context.Context, model string, body map[string]any, on func(Event)) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("编码请求体失败: %w", err)
	}

	endpoint := fmt.Sprintf("%s/models/%s:streamGenerateContent?%s",
		strings.TrimRight(c.baseURL, "/"), url.PathEscape(model),
		url.Values{"alt": {"sse"}, "key": {c.apiKey}}.Encode())
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		// err 里带着完整 URL（含 query 上的 key），只能丢掉。
		return fmt.Errorf("base_url 不是合法的地址")
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := streamClient.Do(httpReq)
	if err != nil {
		return transportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return upstreamError(resp.StatusCode)
	}
	return parseGeminiStream(resp.Body, on)
}

// parseGeminiStream 读 alt=sse 的流：每个 data: 是一个 GenerateContentResponse，
// parts 里 text 和 functionCall 是并列的两种，按出现顺序处理即可。
func parseGeminiStream(r io.Reader, on func(Event)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	seq := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}

		var chunk struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text         string `json:"text"`
						FunctionCall *struct {
							Name string          `json:"name"`
							Args json.RawMessage `json:"args"`
						} `json:"functionCall"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		for _, cand := range chunk.Candidates {
			for _, p := range cand.Content.Parts {
				if p.Text != "" {
					on(Event{Kind: EventDelta, Text: p.Text})
				}
				if p.FunctionCall != nil && p.FunctionCall.Name != "" {
					// Gemini 同样不给 call id，自己编一个供 tool 结果对回。
					seq++
					on(Event{Kind: EventToolCall, Call: ToolCall{
						ID:   fmt.Sprintf("gemini_%s_%d", p.FunctionCall.Name, seq),
						Name: p.FunctionCall.Name,
						Args: defaultArgs(string(p.FunctionCall.Args)),
					}})
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("读取模型响应流中断")
	}
	return nil
}

// geminiContents 把统一的消息列表翻成 Gemini 的形状，并把 system 提出来单独返回。
// 角色只有 user / model 两种：assistant 映射成 model，tool 结果作为一条 user 内容回传
// （functionResponse 必须挂在 user 这一侧）。
func geminiContents(msgs []Message) (system string, contents []map[string]any) {
	var sys strings.Builder
	contents = []map[string]any{}

	for _, m := range msgs {
		switch m.Role {
		case RoleSystem:
			if sys.Len() > 0 {
				sys.WriteString("\n\n")
			}
			sys.WriteString(m.Content)

		case domain.RoleTool:
			// response 必须是对象，工具返回的纯文本包一层 result 字段。
			contents = append(contents, map[string]any{
				"role": "user",
				"parts": []map[string]any{{
					"functionResponse": map[string]any{
						"name":     m.ToolName,
						"response": map[string]any{"result": m.Content},
					},
				}},
			})

		case domain.RoleAssistant:
			parts := []map[string]any{}
			if m.Content != "" {
				parts = append(parts, map[string]any{"text": m.Content})
			}
			for _, c := range m.ToolCalls {
				var args any = map[string]any{}
				if err := json.Unmarshal([]byte(defaultArgs(c.Args)), &args); err != nil {
					args = map[string]any{}
				}
				parts = append(parts, map[string]any{
					"functionCall": map[string]any{"name": c.Name, "args": args},
				})
			}
			if len(parts) == 0 {
				continue // 空的 model 轮次会被 Gemini 拒掉
			}
			contents = append(contents, map[string]any{"role": "model", "parts": parts})

		default: // user
			contents = append(contents, map[string]any{
				"role":  "user",
				"parts": []map[string]any{{"text": m.Content}},
			})
		}
	}
	return sys.String(), contents
}
