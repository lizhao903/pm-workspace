package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// 节点执行（SOP-01b）：按类型和配置算输出，口径同原型 web-next/src/nodetypes.tsx 里各类型的 run。
// 这里是 template、aggregate、decide、review、wait、subflow、end、auto；AI 类和外部节点（SOP-01c）在 nodes_ai.go，
// 写节点 task、doc、contact 在 nodes_write.go（SOP-02a），notify 归 SOP-02b，在那之前执行直接失败。wait、subflow 要等，由引擎（engine.go）处理，这里只算到点时间和子执行的输入。

// Json 是步骤的输入输出、执行参数，同原型的 Json。
type Json = map[string]any

const notWired = "这个节点还没接上"

// nodeResult 是一次执行的结果：失败时 err 非空；分支节点 route 非空；人工节点 review 为真。
type nodeResult struct {
	output Json
	err    string
	route  string
	reason string
	review bool
	log    string
	// waiting 非空表示插件节点挂起等唤醒，是挂起的原因（SOP-03a）
	waiting string
	// outage 是这一步失败是因为模型服务商不可用（TSK-0392，provider_wait.go）
	outage *providerOutage
}

// runNode 执行能当场算出结果、不用内核句柄的节点。wait、subflow 不走这里，AI 类和外部节点先过 execNode。
// deps 是上游步骤 key，按依赖顺序，变量聚合按这个顺序合并。
func runNode(def stepDef, input Json, deps []string) nodeResult {
	cfg := def.Config
	switch def.Kind {
	case "auto":
		// 真正的写操作由写节点做（SOP-02a），这里只透传
		return nodeResult{output: input, log: "透传输入，没有执行写操作"}
	case "template":
		key := cfg["output"]
		if key == "" {
			key = "text"
		}
		return nodeResult{output: with(input, key, render(cfg["template"], input))}
	case "aggregate":
		return nodeResult{output: aggregate(cfg["mode"], input, deps)}
	case "review":
		return nodeResult{output: input, review: true}
	case "decide":
		if isManual(def) {
			return nodeResult{output: input, review: true}
		}
		ok, text, err := judge(def)(input)
		if err != nil {
			return nodeResult{err: err.Error()}
		}
		if len(def.Cases) < 2 {
			return nodeResult{err: "判断节点至少要有两个分支"}
		}
		c := def.Cases[1]
		why := "不成立"
		if ok {
			c, why = def.Cases[0], "成立"
		}
		word := "规则"
		if def.Cond != nil {
			word = "条件"
		}
		return nodeResult{output: input, route: c.Key, reason: fmt.Sprintf("%s「%s」%s", word, text, why)}
	case loopbackKind:
		// 条件回退（AUTO-02，loopback.go）：成立时由 runner 退回上游或走超限
		return runLoopback(def, input)
	case "end":
		keys := list(cfg["outputs"])
		if len(keys) == 0 {
			return nodeResult{output: input}
		}
		out := Json{}
		for _, k := range keys {
			out[k] = getPath(input, k)
		}
		return nodeResult{output: out}
	}
	return nodeResult{err: notWired}
}

// isManual 同原型 isManualDecide：没有条件（cond、旧规则都没有）的条件分支是人工判断。
func isManual(def stepDef) bool { return def.Kind == "decide" && !hasCondition(def) }

func with(input Json, key string, v any) Json {
	out := make(Json, len(input)+1)
	for k, x := range input {
		out[k] = x
	}
	out[key] = v
	return out
}

// aggregate 同原型变量聚合：汇合节点的输入是 {上游 key: 输出}，只有一路时就是那一路的输出。
// 字段合并时后面的上游覆盖前面的，顺序按 deps；输入里不在 deps 的 key 排在后面。
func aggregate(mode string, input Json, deps []string) Json {
	var parts []Json
	all := len(input) > 0
	keys := slices.DeleteFunc(slices.Clone(deps), func(k string) bool { _, ok := input[k]; return !ok })
	for _, k := range sortedKeys(input) {
		if !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	for _, k := range keys {
		m, ok := input[k].(map[string]any)
		if !ok {
			all = false
			break
		}
		parts = append(parts, m)
	}
	if !all {
		parts = []Json{input}
	}
	switch mode {
	case "group":
		return input
	case "first":
		for _, p := range parts {
			if len(p) > 0 {
				return p
			}
		}
		return Json{}
	}
	out := Json{}
	for _, p := range parts {
		for k, v := range p {
			out[k] = v
		}
	}
	return out
}

func sortedKeys(m Json) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

var indexRe = regexp.MustCompile(`\[(\d+)\]`)

// getPath 同原型：a.b[0].c，取不到返回 nil。
func getPath(obj any, path string) any {
	p := indexRe.ReplaceAllString(strings.TrimSpace(path), ".$1")
	cur := obj
	for _, k := range strings.Split(p, ".") {
		if k == "" {
			continue
		}
		switch v := cur.(type) {
		case map[string]any:
			cur = v[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(v) {
				return nil
			}
			cur = v[i]
		default:
			return nil
		}
	}
	return cur
}

// txt 同原型：对象转 JSON，nil 是空串。
func txt(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case map[string]any, []any:
		b, _ := json.Marshal(x)
		return string(b)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

var tplRe = regexp.MustCompile(`\{\{\s*([\w.\[\]\p{Han}]+)\s*\}\}`)

// render 把 {{字段}} 换成输入里的值，取不到的留空。
func render(tpl string, input Json) string {
	return tplRe.ReplaceAllStringFunc(tpl, func(m string) string {
		return txt(getPath(input, tplRe.FindStringSubmatch(m)[1]))
	})
}

var listSep = regexp.MustCompile(`[,，、\s]+`)

func list(s string) []string {
	var out []string
	for _, x := range listSep.Split(s, -1) {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

var ruleRe = regexp.MustCompile(`^\s*(\S+)\s+(不等于|等于|不包含|包含)\s+(.*?)\s*$`)

// evalRule 求值条件分支的规则：「字段 等于 值」「字段 包含 值」，另有「不等于」「不包含」。
// 字段写法同模板（a.b[0]），值可以加引号；成立走第一个分支，不成立走第二个。
// 等于按文字比；包含对文字是子串，对列表是有一项等于这个值。
func evalRule(rule string, input Json) (bool, error) {
	m := ruleRe.FindStringSubmatch(rule)
	if m == nil {
		return false, fmt.Errorf("规则「%s」写法不对，要写成「字段 等于 值」或「字段 包含 值」", strings.TrimSpace(rule))
	}
	field, op, want := m[1], m[2], unquote(m[3])
	got := getPath(input, field)
	var ok bool
	switch strings.TrimPrefix(op, "不") {
	case "等于":
		ok = txt(got) == want
	case "包含":
		if arr, isArr := got.([]any); isArr {
			ok = slices.ContainsFunc(arr, func(x any) bool { return txt(x) == want })
		} else {
			ok = strings.Contains(txt(got), want)
		}
	}
	if strings.HasPrefix(op, "不") {
		ok = !ok
	}
	return ok, nil
}

func unquote(s string) string {
	for _, q := range [][2]string{{`"`, `"`}, {`'`, `'`}, {"「", "」"}, {"“", "”"}} {
		if len(s) >= len(q[0])+len(q[1]) && strings.HasPrefix(s, q[0]) && strings.HasSuffix(s, q[1]) {
			return s[len(q[0]) : len(s)-len(q[1])]
		}
	}
	return s
}

var durRe = regexp.MustCompile(`^\s*(\d+(?:\.\d+)?)\s*(秒钟?|分钟|分|小时|时|天|周)\s*$`)

// parseWait 解析等待节点的「等多久」：「30 分钟」「1 小时」「1 天」「10 秒」，也认 Go 的写法（90s、1h30m）。留空是 1 小时。
func parseWait(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Hour, nil
	}
	if m := durRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		unit := map[string]time.Duration{"秒": time.Second, "秒钟": time.Second, "分": time.Minute, "分钟": time.Minute,
			"时": time.Hour, "小时": time.Hour, "天": 24 * time.Hour, "周": 7 * 24 * time.Hour}[m[2]]
		return time.Duration(n * float64(unit)), nil
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return d, nil
	}
	return 0, fmt.Errorf("等待时长「%s」写法不对，要写成「30 分钟」「1 小时」「1 天」这样", s)
}

// sleepUntil 等到 at 或 ctx 取消。
func sleepUntil(ctx context.Context, at time.Time) error {
	t := time.NewTimer(time.Until(at))
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
