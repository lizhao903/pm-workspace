// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package webhook

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 映射和过滤照原型 web-next/src/taskdata.ts 的 getPath、asText、toPriority、mapFields、passFilter 移植，
// 推送内容按原始 JSON 逐层取，对象和数组原样压成一行，字段顺序和对方发来的一致（同 JSON.stringify）。

// maxTitle 是建任务时标题最多取多少字，和原型 slice(0, 120) 一致
const maxTitle = 120

var indexRe = regexp.MustCompile(`\[(\d+)\]`)

// GetPath 取 a.b[0].c 这类路径的值；取不到回 nil。path 为空白时也回 nil。
func GetPath(payload json.RawMessage, path string) json.RawMessage {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	cur := payload
	for _, k := range strings.Split(indexRe.ReplaceAllString(path, ".$1"), ".") {
		if k == "" {
			continue
		}
		cur = child(cur, k)
		if cur == nil {
			return nil
		}
	}
	return cur
}

// child 取对象的键或数组的下标；不是对象、数组（含 null）时回 nil，同原型 typeof o === 'object' 的判断
func child(raw json.RawMessage, k string) json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	switch raw[0] {
	case '{':
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			return nil
		}
		return m[k]
	case '[':
		var a []json.RawMessage
		if json.Unmarshal(raw, &a) != nil {
			return nil
		}
		i, err := strconv.Atoi(k)
		if err != nil || i < 0 || i >= len(a) {
			return nil
		}
		return a[i]
	}
	return nil
}

// AsText 把取到的值变成文字：取不到和 null 为空串，字符串原样，对象、数组压成一行 JSON，其余照字面。
func AsText(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	case '{', '[':
		var b bytes.Buffer
		if json.Compact(&b, raw) == nil {
			return b.String()
		}
	}
	return string(raw)
}

// MapFields 按映射取出任务各字段的文字，留空的路径取到空串。返回值的形状同 Mapping，装的是值不是路径。
func MapFields(m Mapping, payload json.RawMessage) Mapping {
	return Mapping{
		Title:    AsText(GetPath(payload, m.Title)),
		Desc:     AsText(GetPath(payload, m.Desc)),
		Priority: AsText(GetPath(payload, m.Priority)),
		Assignee: AsText(GetPath(payload, m.Assignee)),
		Due:      AsText(GetPath(payload, m.Due)),
	}
}

// PassFilter 判断推送是否满足过滤条件（路径 == 值 / 路径 != 值），不满足时给出原因。条件留空一律通过。
func PassFilter(filter string, payload json.RawMessage) (bool, string) {
	if strings.TrimSpace(filter) == "" {
		return true, ""
	}
	m := filterRe.FindStringSubmatch(filter)
	if m == nil {
		return false, "过滤条件写法不对：" + filter
	}
	actual := AsText(GetPath(payload, m[1]))
	ok := actual == unquote(m[3])
	if m[2] == "!=" {
		ok = !ok
	}
	if ok {
		return true, ""
	}
	shown := actual
	if shown == "" {
		shown = "空"
	}
	return false, "不满足过滤条件 " + filter + "（实际是「" + shown + "」）"
}

// unquote 去掉开头一个、结尾一个引号（单双都算，不要求成对），同原型 passFilter 里去引号的正则
func unquote(v string) string {
	isQuote := func(c byte) bool { return c == '\'' || c == '"' }
	start, end := 0, len(v)
	if end > 0 && isQuote(v[0]) {
		start = 1
	}
	if end > start && isQuote(v[end-1]) {
		end--
	}
	return v[start:end]
}

// ToPriority 把外部系统的级别对到 P0 到 P3，常见的几种直接对上，对不上用 fallback。
func ToPriority(v, fallback string) string {
	s := strings.ToLower(strings.TrimSpace(v))
	if len(s) == 2 && s[0] == 'p' && s[1] >= '0' && s[1] <= '3' {
		return strings.ToUpper(s)
	}
	for _, r := range []struct {
		words []string
		p     string
	}{
		{[]string{"fatal", "critical", "blocker", "紧急", "urgent"}, "P0"},
		{[]string{"error", "high", "高", "重要"}, "P1"},
		{[]string{"warn", "medium", "中", "normal"}, "P2"},
		{[]string{"info", "low", "低", "minor"}, "P3"},
	} {
		for _, w := range r.words {
			if strings.Contains(s, w) {
				return r.p
			}
		}
	}
	return fallback
}

var dueRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

// dueDay 取截止日期开头的 yyyy-mm-dd，没有回空串
func dueDay(v string) string { return dueRe.FindString(v) }

// cutTitle 去首尾空白后最多取 120 字
func cutTitle(s string) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= maxTitle {
		return s
	}
	return string([]rune(s)[:maxTitle])
}
