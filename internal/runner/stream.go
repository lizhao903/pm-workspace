package runner

import (
	"encoding/json"
	"strings"
)

// claude 的 --output-format stream-json 每行一个 JSON 对象。我们只认下面这几种：
//
//	system    启动/钩子信息，忽略
//	assistant 模型这一轮说的话与发起的工具调用
//	user      工具调用的返回值（claude 把它当成「用户」发回去的消息）
//	result    收尾，带 is_error、最终文本与 permission_denials
//
// 未知的 type 一律忽略而不是报错：这个格式由 claude CLI 定义，它升级时多出
// 一种事件是常态，为此让整次执行失败是本末倒置。
type streamLine struct {
	Type    string          `json:"type"`
	Subtype string          `json:"subtype"`
	Message json.RawMessage `json:"message"`
	IsError bool            `json:"is_error"`
	Result  string          `json:"result"`

	// PermissionDenials 只出现在 result 行，是「被权限策略挡下来的工具调用」的
	// 权威清单。它和单次 tool_result 的 is_error 是两回事，见 Denial 的注释。
	PermissionDenials []Denial `json:"permission_denials"`
}

// Denial 是一次被权限策略拒绝的工具调用。
//
// 必须和「工具自己失败了」区分开：tool_result 的 is_error 覆盖一切失败
// （bash 退出码非 0、读一个不存在的文件……），那些在 agent 干活时是家常便饭，
// 拿它判定整次执行失败会让几乎每次执行都变红。而 permission_denials 说的是
// 「claude 想做，是我们（或用户的 settings.json）不让」——这条才对应
// 「任务没做成，而且用户有办法解决」。
type Denial struct {
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
}

type streamMessage struct {
	Content []streamContent `json:"content"`
}

type streamContent struct {
	Type  string         `json:"type"`
	Text  string         `json:"text"`  // text
	Name  string         `json:"name"`  // tool_use
	Input map[string]any `json:"input"` // tool_use
	ID    string         `json:"id"`    // tool_use

	ToolUseID string `json:"tool_use_id"` // tool_result，回指上面的 ID
	// IsError 在成功的 tool_result 里整个字段都不存在，缺省 false 正好是「成功」。
	IsError bool            `json:"is_error"`
	Content json.RawMessage `json:"content"` // tool_result，可能是字符串也可能是块数组
}

// parseLine 把一行 NDJSON 翻成零到多个事件。解析不了的行返回 nil——
// claude 偶尔会往 stdout 混一行非 JSON 的告警，那不该让流断掉。
//
// tool_result 事件里没有工具名（那一行只给 tool_use_id），名字由 readStream
// 用它自己维护的 id→name 对照表补上。
func parseLine(line []byte) []Event {
	var sl streamLine
	if err := json.Unmarshal(line, &sl); err != nil {
		return nil
	}
	if sl.Type != "assistant" && sl.Type != "user" {
		return nil
	}
	if len(sl.Message) == 0 {
		return nil
	}

	var msg streamMessage
	// content 在这两种消息里恒为数组；真不是了就整条跳过，不猜。
	if err := json.Unmarshal(sl.Message, &msg); err != nil {
		return nil
	}

	var out []Event
	for _, c := range msg.Content {
		switch c.Type {
		case "text":
			if c.Text != "" {
				out = append(out, Event{Type: EventDelta, Text: c.Text})
			}
		case "tool_use":
			// 工具事件是这个界面最有价值的一半：用户要看到 claude 在动哪些文件，
			// 而不是只看到一堆文字。这条在调用「发起时」就发出去，界面才有实时感。
			out = append(out, Event{
				Type: EventTool, ID: c.ID, Name: c.Name, Detail: toolDetail(c.Input),
			})
		case "tool_result":
			// 配对的结果。没有它的话，「写成功了」和「写被拒了」在界面上一模一样。
			ev := Event{Type: EventToolResult, ID: c.ToolUseID, OK: !c.IsError}
			if c.IsError {
				ev.Message = oneLine(toolResultText(c.Content), 300)
			}
			out = append(out, ev)
		}
		// thinking / redacted_thinking 不展示：那是模型的草稿纸。
	}
	return out
}

// toolResultText 取出工具返回值里的人类可读部分。
// content 既可能是一个字符串，也可能是 [{type:"text",text:"…"}] 这样的块数组。
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var sb strings.Builder
		for _, b := range blocks {
			if b.Text != "" {
				sb.WriteString(b.Text)
				sb.WriteByte(' ')
			}
		}
		return strings.TrimSpace(sb.String())
	}
	return ""
}

// finalOf 从 result 行里取出收尾信息。ok 为 false 表示这行不是 result 行。
func finalOf(line []byte) (text string, isErr bool, denials []Denial, ok bool) {
	var sl streamLine
	if err := json.Unmarshal(line, &sl); err != nil || sl.Type != "result" {
		return "", false, nil, false
	}
	return sl.Result, sl.IsError, sl.PermissionDenials, true
}

// detailKeys 按「对用户最有意义」排序，命中第一个就用它。
// 顺序不是随意的：读写文件时路径最重要，跑命令时命令本身最重要，
// 而 description 是所有工具都可能有的兜底说明，必须排在后面。
var detailKeys = []string{
	"file_path", "path", "notebook_path",
	"command",
	"pattern", "glob",
	"url", "query",
	"skill", "subagent_type",
	"description", "prompt",
}

// toolDetail 从工具入参里挑一句话摆到界面上。
// 不返回整个 input：一次 Write 的 input 里装着整个文件内容。
func toolDetail(input map[string]any) string {
	if len(input) == 0 {
		return ""
	}
	for _, k := range detailKeys {
		if s, ok := input[k].(string); ok {
			if s = strings.TrimSpace(s); s != "" {
				return oneLine(s, 160)
			}
		}
	}
	return ""
}

// oneLine 把多行折成一行并限长。工具事件在界面上是一行标签，
// 带换行的命令会把布局撑坏。
func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
