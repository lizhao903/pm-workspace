// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- 思考档位（Agent.Thinking）翻成各家的请求参数 ---
//
// 档位只有五个：default 不传任何思考参数（老行为）；off 不思考；low / medium / high 想得越来越深。
// 各家写法差得多、同一家不同模型也不一样（Claude 新模型只认 adaptive + effort，老模型只认 budget_tokens；
// Ollama 的 qwen3 认 think:true，gpt-oss 只认 "low"/"medium"/"high"），按模型名猜不全。
// 所以每家给一串候选写法，按顺序试：上游 400 拒掉、而且还没吐过字时换下一种，
// 最后一种总是「什么都不带」——模型不支持思考参数时照 default 跑，记一行日志，调用本身不失败。

// bodyPatch 是一种思考参数的写法：要合进请求体的顶层字段。
type bodyPatch map[string]any

// thinkingLevel 把档位归一：空串、不认识的都算 default。
func thinkingLevel(s string) string {
	switch s {
	case domain.ThinkingOff, domain.ThinkingLow, domain.ThinkingMedium, domain.ThinkingHigh:
		return s
	}
	return domain.ThinkingDefault
}

// rejectedError 是上游明确拒收这次请求（HTTP 400 / 422，或 Ollama 流里说不支持思考）。
// 和 transientError 相反：原样重来没用，换掉思考参数再来可能就行。
type rejectedError struct{ msg string }

func (e rejectedError) Error() string { return e.msg }

func isRejected(err error) bool {
	var r rejectedError
	return errors.As(err, &r)
}

// thinkingLog 记降级日志，测试里可以换掉。
var thinkingLog = slog.Default

// withPatch 复制一份请求体，合进 p。
func withPatch(body map[string]any, p bodyPatch) map[string]any {
	out := maps.Clone(body)
	maps.Copy(out, p)
	return out
}

// streamThinking 按候选写法依次发请求。send 拿到合好的请求体去发；variants 为空时直接发 body。
// 换写法的条件：上游拒收（rejectedError）且这一次还没吐过任何事件——吐了一半的不重来，免得拼出两份。
func streamThinking(kind, model, level string, body map[string]any, variants []bodyPatch,
	send func(body map[string]any, on func(Event)) error, on func(Event)) error {
	if len(variants) == 0 {
		return send(body, on)
	}
	tries := append(variants, nil) // 最后一种：不带思考参数
	for i, v := range tries {
		emitted := false
		err := send(withPatch(body, v), func(ev Event) { emitted = true; on(ev) })
		if err == nil || emitted || !isRejected(err) || i == len(tries)-1 {
			return err
		}
		next := "换一种写法重试"
		if i == len(tries)-2 {
			next = "去掉思考参数按 default 重试"
		}
		thinkingLog().Info("模型不认这种思考参数，"+next, "kind", kind, "model", model, "thinking", level, "err", err.Error())
	}
	return nil
}

/* ---------- Anthropic ---------- */

// anthropicBudget 是老模型（不认 adaptive）用 budget_tokens 时各档的预算；max_tokens 要比它大，另加一份正文的额度。
var anthropicBudget = map[string]int{domain.ThinkingLow: 2048, domain.ThinkingMedium: 8192, domain.ThinkingHigh: 16384}

// legacyClaudeRe 认出 4.6 之前、不认 adaptive 的 Claude：claude-3*、*-4-0 / 4-1 / 4-5、带日期的 4.0、haiku-4。
var legacyClaudeRe = regexp.MustCompile(`claude-3|-4-[015](\b|-|$)|(opus|sonnet)-4(-\d{8})?$|(opus|sonnet)-4-\d{8}|haiku-4`)

// anthropicThinking 的写法：
//   - off：先显式关 {type: disabled}；新模型里思考关不掉的（Opus 5.5 等）会 400，再退成 effort low 尽量少想。
//   - low / medium / high：4.6 及以后用 {type: adaptive} + output_config.effort；被拒或老模型用 budget_tokens。
func anthropicThinking(model, level string) []bodyPatch {
	switch level {
	case domain.ThinkingOff:
		return []bodyPatch{
			{"thinking": map[string]any{"type": "disabled"}},
			{"output_config": map[string]any{"effort": "low"}},
		}
	case domain.ThinkingLow, domain.ThinkingMedium, domain.ThinkingHigh:
		b := anthropicBudget[level]
		budget := bodyPatch{
			"thinking":   map[string]any{"type": "enabled", "budget_tokens": b},
			"max_tokens": b + anthropicMaxTokens,
		}
		if legacyClaudeRe.MatchString(model) {
			return []bodyPatch{budget}
		}
		return []bodyPatch{
			{"thinking": map[string]any{"type": "adaptive"}, "output_config": map[string]any{"effort": level}},
			budget,
		}
	}
	return nil
}

/* ---------- OpenAI 兼容 ---------- */

// openAIThinking 用 reasoning_effort（Chat Completions 的字段，vLLM、Ollama 的 /v1 也认）：
//   - off：先 "none"（gpt-5.1 以后、Ollama 的 /v1 认），不认的再试 "minimal"（gpt-5）；
//     o 系列两个都不认，最后不带——它本来就关不掉思考。
//   - low / medium / high：原样传。不是推理模型（gpt-4o 等）会 400，退成不带。
func openAIThinking(level string) []bodyPatch {
	switch level {
	case domain.ThinkingOff:
		return []bodyPatch{{"reasoning_effort": "none"}, {"reasoning_effort": "minimal"}}
	case domain.ThinkingLow, domain.ThinkingMedium, domain.ThinkingHigh:
		return []bodyPatch{{"reasoning_effort": level}}
	}
	return nil
}

/* ---------- Ollama ---------- */

// ollamaThinking 用 think：qwen3、deepseek-r1 这类认 true / false；gpt-oss 只认 "low"/"medium"/"high"、关不掉，
// off 时给它 "low"。不支持思考的模型带了 think 会 400（"does not support thinking"），退成不带。
func ollamaThinking(model, level string) []bodyPatch {
	gptOSS := strings.Contains(strings.ToLower(model), "gpt-oss")
	switch level {
	case domain.ThinkingOff:
		if gptOSS {
			return []bodyPatch{{"think": "low"}}
		}
		return []bodyPatch{{"think": false}}
	case domain.ThinkingLow, domain.ThinkingMedium, domain.ThinkingHigh:
		if gptOSS {
			return []bodyPatch{{"think": level}}
		}
		return []bodyPatch{{"think": true}}
	}
	return nil
}

/* ---------- Gemini ---------- */

// geminiBudget 是各档的 thinkingBudget；0 是关。2.5 Pro 这类关不掉的会 400，退成不带。
var geminiBudget = map[string]int{domain.ThinkingOff: 0, domain.ThinkingLow: 1024, domain.ThinkingMedium: 8192, domain.ThinkingHigh: 24576}

// geminiThinking 写在 generationConfig.thinkingConfig 里；generationConfig 现在没别的字段，整个替换。
func geminiThinking(level string) []bodyPatch {
	b, ok := geminiBudget[level]
	if !ok {
		return nil
	}
	return []bodyPatch{{"generationConfig": map[string]any{"thinkingConfig": map[string]any{"thinkingBudget": b}}}}
}

/* ---------- 思考块回传（Anthropic） ---------- */

// Claude 开着思考又调工具时，下一轮里带 tool_use 的那条 assistant 前面必须原样带回它的 thinking 块
// （含 signature），否则 400。块是不透明的，只在一轮对话的内存里传，不落库：
// 从库里重建的历史没有它，接着跑时被拒就按上面的降级去掉思考参数重来。

// EventThinkingBlock 是一个完整的 thinking / redacted_thinking 块，Raw 是要原样回传的 JSON。
const EventThinkingBlock EventKind = "thinking_block"

func thinkingBlockJSON(typ, thinking, signature, data string) json.RawMessage {
	var m map[string]any
	if typ == "redacted_thinking" {
		m = map[string]any{"type": typ, "data": data}
	} else {
		m = map[string]any{"type": typ, "thinking": thinking, "signature": signature}
	}
	b, _ := json.Marshal(m)
	return b
}
