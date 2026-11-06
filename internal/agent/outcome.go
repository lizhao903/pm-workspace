package agent

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// --- 一轮里工具调用的实际结果（TSK-0480）---
//
// 会话 ags_06gtxj0d159ynhvd 里，助手的调用失败了一半、跑偏了一半，回复却是「已将状态设置为忽略」「好的，已经处理完了」。
// 后一句还不是模型说的：调用用满 maxTurns 轮后没给它收尾的机会，执行器自己兜了这句。
// 所以回复末尾由执行器按实际结果补一段（模型说什么都盖不掉）：有失败的调用就列出来（次数不去重、内容去重），再写这一轮实际改了什么；
// 模型没说话时的兜底也按实际结果写，不再一律「已经处理完了」。这段落进 assistant 消息，run 的结论跟着如实。

// maxOutcomeLines 是补充说明里最多列几条失败或改动，再多写「等 n 条」；maxOutcomeRunes 是每条的字数上限
// （保存流程的校验报错能有上千字，原样列进回复里就把回复淹了）。
const (
	maxOutcomeLines = 5
	maxOutcomeRunes = 160
)

type outcome struct {
	failures []string // 失败的调用，给人看的 Summary，去重
	nFailed  int      // 失败的次数，不去重
	writes   []string // 成功的写操作，给人看的 Summary
	failed   map[string]bool
}

// note 记一次执行了的调用。write 是这个工具会不会改数据。
func (o *outcome) note(call ToolCall, res ToolResult, write bool) {
	if res.Failed {
		o.nFailed++
		if !slices.Contains(o.failures, res.Summary) {
			o.failures = append(o.failures, res.Summary)
		}
		if o.failed == nil {
			o.failed = map[string]bool{}
		}
		o.failed[callKey(call)] = true
		return
	}
	if write {
		o.writes = append(o.writes, res.Summary)
	}
}

// failedBefore：这一轮里同一个工具、同样的参数已经失败过。
func (o *outcome) failedBefore(call ToolCall) bool { return o.failed[callKey(call)] }

// callKey 是工具名加规整后的参数（键排序），参数顺序不同也算同一次。
func callKey(call ToolCall) string {
	var v any
	if err := json.Unmarshal([]byte(defaultArgs(call.Args)), &v); err != nil {
		return call.Name + " " + call.Args
	}
	b, _ := json.Marshal(v)
	return call.Name + " " + string(b)
}

// repeatedFailure 是同参重试时回给模型的话，不再执行一遍。
func repeatedFailure(name string) ToolResult {
	return failedResult(name, "和这一轮前面失败的那次调用参数完全一样，没有再执行",
		"错误：这次调用和前面失败的那次参数完全一样，结果不会变，没有再执行。按前面的报错改参数；改不对就停下来如实告诉用户哪里没做成。")
}

// footer 是补在回复末尾的说明；没有失败的调用时为空。
func (o *outcome) footer() string {
	if len(o.failures) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "【执行情况】本轮有 %d 次调用没成功：%s。", o.nFailed, joinCapped(o.failures))
	if len(o.writes) == 0 {
		b.WriteString("这一轮没有改动任何数据。")
	} else {
		fmt.Fprintf(&b, "实际改动只有：%s。", joinCapped(o.writes))
	}
	return b.String()
}

// fallback 是模型一个字没说时的兜底。有失败时为空，交给 footer 说。
func (o *outcome) fallback(usedTools bool) string {
	switch {
	case len(o.failures) > 0:
		return ""
	case len(o.writes) > 0:
		return "这一轮做了：" + joinCapped(o.writes) + "。"
	case usedTools:
		return "查过了，这一轮没有改动任何数据。"
	}
	return "（模型这一轮没有给出回复）"
}

func joinCapped(xs []string) string {
	n := min(len(xs), maxOutcomeLines)
	parts := make([]string, n)
	for i := range n {
		parts[i] = clipRunes(oneLine(xs[i]), maxOutcomeRunes)
	}
	out := strings.Join(parts, "；")
	if len(xs) > n {
		out += fmt.Sprintf("等 %d 条", len(xs))
	}
	return out
}

// isWrite：这个工具会不会改数据。连接器工具看它自己的标记，内置工具看归属能力。
func (r *Runner) isWrite(name string) bool {
	if c := r.Policy.conn(name); c != nil {
		return c.Write
	}
	if ab, ok := ToolAbility[name]; ok && ab != "" {
		a, _ := AbilityOf(ab)
		return a.Write
	}
	return false
}
