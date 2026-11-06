package sop

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// 结构化条件（TSK-0490）：条件分支（decide）和条件回退（loopback）的条件存成结构，不存一句话。
// 用户 2026-11-06：「程序没法把自然语言自动转成规则」——条件只能是「字段 + 运算符 + 值」，字段从这一步真实拿得到的字段里选
// （触发自动带入、输入字段、上游节点声明的输出，见 fields.go），多条用且 / 或组合；自然语言只能写进步骤说明。
//
// 步骤上的 cond：{logic: "and" | "or", items: [{field, op, value}]}。logic 缺省 and。
// 旧的一行 rule（「字段 等于 值」）只为已有流程保留：没有 cond 时执行仍按它判断，保存时给警告提示改成 cond；
// rule 不是这个写法（一句话）的不让存。cond 和 rule 都没有的条件分支是人工判断。

// Cond 是一组条件。
type Cond struct {
	Logic string     `json:"logic"`
	Items []CondItem `json:"items"`
}

// CondItem 是一条条件。Value 是文字；模型写成数字、布尔值的照样认成文字。
type CondItem struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

func (c *CondItem) UnmarshalJSON(b []byte) error {
	var raw struct {
		Field string          `json:"field"`
		Op    string          `json:"op"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	c.Field, c.Op, c.Value = raw.Field, raw.Op, ""
	v := strings.TrimSpace(string(raw.Value))
	switch {
	case v == "" || v == "null":
	case v[0] == '"':
		if err := json.Unmarshal(raw.Value, &c.Value); err != nil {
			return err
		}
	case v == "true" || v == "false":
		c.Value = v
	default:
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			return &json.UnmarshalTypeError{Value: "value", Field: "value", Type: reflect.TypeOf("")}
		}
		c.Value = v
	}
	return nil
}

const (
	logicAnd = "and"
	logicOr  = "or"
	maxCond  = 20
)

// condOps 是运算符和它的写法，顺序即编辑器下拉的顺序。
var condOps = []Option{
	{Value: "eq", Label: "等于"}, {Value: "ne", Label: "不等于"},
	{Value: "contains", Label: "包含"}, {Value: "not_contains", Label: "不包含"},
	{Value: "empty", Label: "为空"}, {Value: "not_empty", Label: "不为空"},
}

func opLabel(op string) string {
	for _, o := range condOps {
		if o.Value == op {
			return o.Label
		}
	}
	return op
}

func unaryOp(op string) bool { return op == "empty" || op == "not_empty" }

// condProblems 是结构上的问题（字段存不存在另查）。
func condProblems(c *Cond) []string {
	var out []string
	if c.Logic != "" && c.Logic != logicAnd && c.Logic != logicOr {
		out = append(out, fmt.Sprintf("条件的组合方式「%s」不认，只能是 and（且）或 or（或）", c.Logic))
	}
	if len(c.Items) == 0 {
		out = append(out, "条件是空的：至少要有一条「字段 + 运算符 + 值」；要人来选就删掉 cond")
	}
	if len(c.Items) > maxCond {
		out = append(out, fmt.Sprintf("条件最多 %d 条", maxCond))
	}
	ops := make([]string, len(condOps))
	for i, o := range condOps {
		ops[i] = o.Value + "（" + o.Label + "）"
	}
	for i, it := range c.Items {
		n := fmt.Sprintf("第 %d 条条件", i+1)
		if strings.TrimSpace(it.Field) == "" {
			out = append(out, n+"没选字段")
		}
		if !slices.ContainsFunc(condOps, func(o Option) bool { return o.Value == it.Op }) {
			out = append(out, fmt.Sprintf("%s的运算符「%s」不认，只能是 %s", n, it.Op, strings.Join(ops, "、")))
			continue
		}
		if (it.Op == "contains" || it.Op == "not_contains") && it.Value == "" {
			out = append(out, n+"「"+opLabel(it.Op)+"」后面要有值")
		}
	}
	return out
}

// condText 是给人看的一句：「relevance 等于 me 且 channel 不为空」。
func condText(c *Cond) string {
	sep := " 且 "
	if c.Logic == logicOr {
		sep = " 或 "
	}
	parts := make([]string, len(c.Items))
	for i, it := range c.Items {
		if unaryOp(it.Op) {
			parts[i] = it.Field + " " + opLabel(it.Op)
		} else {
			parts[i] = fmt.Sprintf("%s %s %s", it.Field, opLabel(it.Op), quoteVal(it.Value))
		}
	}
	return strings.Join(parts, sep)
}

func quoteVal(v string) string {
	if v == "" || strings.ContainsAny(v, " \t") {
		return strconv.Quote(v)
	}
	return v
}

// evalCond 求一组条件：and 全部成立才成立，or 有一条成立就成立。
func evalCond(c *Cond, input Json) bool {
	or := c.Logic == logicOr
	for _, it := range c.Items {
		ok := evalItem(it, input)
		if or && ok {
			return true
		}
		if !or && !ok {
			return false
		}
	}
	return !or
}

// evalItem 口径同旧规则 evalRule：等于按文字比；包含对文字是子串，对列表是有一项等于这个值；为空是取不到、空串、空列表、空对象。
func evalItem(it CondItem, input Json) bool {
	got := getPath(input, strings.TrimSpace(it.Field))
	switch it.Op {
	case "eq":
		return txt(got) == it.Value
	case "ne":
		return txt(got) != it.Value
	case "contains", "not_contains":
		var ok bool
		if arr, isArr := got.([]any); isArr {
			ok = slices.ContainsFunc(arr, func(x any) bool { return txt(x) == it.Value })
		} else {
			ok = strings.Contains(txt(got), it.Value)
		}
		return ok == (it.Op == "contains")
	case "empty", "not_empty":
		return isEmpty(got) == (it.Op == "empty")
	}
	return false
}

func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(x) == ""
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}

// legacyCond 把旧的一行规则换成等价的结构化条件；不是旧写法的回 false。
func legacyCond(rule string) (*Cond, bool) {
	m := ruleRe.FindStringSubmatch(rule)
	if m == nil {
		return nil, false
	}
	op := map[string]string{"等于": "eq", "不等于": "ne", "包含": "contains", "不包含": "not_contains"}[m[2]]
	return &Cond{Logic: logicAnd, Items: []CondItem{{Field: m[1], Op: op, Value: unquote(m[3])}}}, true
}

// stepCond 是这一步实际用的条件：有 cond 用 cond，否则旧规则能换就换；都没有回 nil。
func stepCond(def stepDef) (*Cond, string) {
	if def.Cond != nil {
		return def.Cond, condText(def.Cond)
	}
	if r := strings.TrimSpace(def.Rule); r != "" {
		c, _ := legacyCond(r)
		return c, r
	}
	return nil, ""
}

// hasCondition 是这一步写了条件（cond 或旧规则）；条件分支两样都没有就是人工判断。
func hasCondition(def stepDef) bool {
	return def.Cond != nil || strings.TrimSpace(def.Rule) != ""
}

// judge 求条件分支、条件回退的条件，回成立不成立和给人看的条件原文；写法不认时回错误（只有旧规则会这样）。
func judge(def stepDef) func(input Json) (bool, string, error) {
	return func(input Json) (bool, string, error) {
		if def.Cond != nil {
			return evalCond(def.Cond, input), condText(def.Cond), nil
		}
		ok, err := evalRule(def.Rule, input)
		return ok, strings.TrimSpace(def.Rule), err
	}
}
