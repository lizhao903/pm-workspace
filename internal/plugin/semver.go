// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 版本号和版本范围，规则见 docs/plugin-api.md 1.2；前端 frontend/src/core/plugin/semver.ts 是同一套。

// Version 是 MAJOR.MINOR.PATCH，不支持预发布标签。
type Version [3]int

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

func (v Version) cmp(o Version) int {
	for i := range 3 {
		if v[i] != o[i] {
			if v[i] < o[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// 每段最多 9 位，前端用 Number 也不会丢精度。
var (
	versionRe    = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	comparatorRe = regexp.MustCompile(`^(>=|<=|>|<|=|\^|~)?(0|[1-9][0-9]{0,8})(?:\.(0|[1-9][0-9]{0,8}))?(?:\.(0|[1-9][0-9]{0,8}))?$`)
)

// ParseVersion 解析完整的 MAJOR.MINOR.PATCH。
func ParseVersion(s string) (Version, bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return Version{}, false
	}
	var v Version
	for i := range 3 {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

type comparator struct {
	op string // >= > <= < =
	v  Version
}

func (c comparator) match(v Version) bool {
	d := v.cmp(c.v)
	switch c.op {
	case ">=":
		return d >= 0
	case ">":
		return d > 0
	case "<=":
		return d <= 0
	case "<":
		return d < 0
	default:
		return d == 0
	}
}

// Range 是一组同时满足的比较。
type Range []comparator

// ParseRange 解析版本范围。省略写法（>=1.2）只允许跟比较运算符，按补零处理；
// ^、~ 和精确版本必须写全三段。不支持 ||、*、x 和预发布标签。
func ParseRange(s string) (Range, bool) {
	parts := strings.Fields(s)
	if len(parts) == 0 {
		return nil, false
	}
	var r Range
	for _, p := range parts {
		m := comparatorRe.FindStringSubmatch(p)
		if m == nil {
			return nil, false
		}
		op := m[1]
		full := m[3] != "" && m[4] != ""
		if !full && (op == "" || op == "=" || op == "^" || op == "~") {
			return nil, false
		}
		var v Version
		for i := range 3 {
			if m[i+2] != "" {
				v[i], _ = strconv.Atoi(m[i+2])
			}
		}
		switch op {
		case "^":
			var hi Version
			switch {
			case v[0] > 0:
				hi = Version{v[0] + 1, 0, 0}
			case v[1] > 0:
				hi = Version{0, v[1] + 1, 0}
			default:
				hi = Version{0, 0, v[2] + 1}
			}
			r = append(r, comparator{">=", v}, comparator{"<", hi})
		case "~":
			r = append(r, comparator{">=", v}, comparator{"<", Version{v[0], v[1] + 1, 0}})
		case "":
			r = append(r, comparator{"=", v})
		default:
			r = append(r, comparator{op, v})
		}
	}
	return r, true
}

// Match 判断版本是否落在范围里。
func (r Range) Match(v Version) bool {
	for _, c := range r {
		if !c.match(v) {
			return false
		}
	}
	return true
}

// Satisfies 是 ParseRange 加 Match 的便捷写法，任一边不合法都返回 false。
func Satisfies(version, rng string) bool {
	v, ok := ParseVersion(version)
	if !ok {
		return false
	}
	r, ok := ParseRange(rng)
	return ok && r.Match(v)
}
