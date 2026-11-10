// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"strconv"
	"strings"
	"time"
)

// cronSpec 是解析好的 5 段 cron：每段一张允许值的表。
// 语义同常见的 cron：日和周都限定了（都不以 * 开头）时任一满足即可，否则两个都要满足。
type cronSpec struct {
	minute, hour, dom, month, dow [64]bool
	domAny, dowAny                bool
}

type cronField struct {
	name     string
	min, max int
	names    map[string]int
}

var (
	monthNames = map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
	dowNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

	cronFields = [5]cronField{
		{name: "minute", min: 0, max: 59},
		{name: "hour", min: 0, max: 23},
		{name: "day of month", min: 1, max: 31},
		{name: "month", min: 1, max: 12, names: monthNames},
		// 7 也是周日
		{name: "day of week", min: 0, max: 7, names: dowNames},
	}
)

// parseCron 认数字、*、a-b、*/n、a-b/n、逗号列表，月和周可写英文缩写（JAN、MON）。
func parseCron(expr string) (*cronSpec, error) {
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return nil, invalid("rule.cron needs 5 fields (minute hour day month weekday), like 0 9 * * 1; got %q", expr)
	}
	c := &cronSpec{}
	sets := [5]*[64]bool{&c.minute, &c.hour, &c.dom, &c.month, &c.dow}
	for i, p := range parts {
		if err := cronFields[i].parse(p, sets[i]); err != nil {
			return nil, err
		}
	}
	if c.dow[7] {
		c.dow[0] = true
	}
	c.domAny = strings.HasPrefix(parts[2], "*")
	c.dowAny = strings.HasPrefix(parts[4], "*")
	return c, nil
}

func (f cronField) parse(s string, set *[64]bool) error {
	for _, item := range strings.Split(s, ",") {
		rng, stepStr, hasStep := strings.Cut(item, "/")
		step := 1
		if hasStep {
			n, err := strconv.Atoi(stepStr)
			if err != nil || n < 1 {
				return invalid("rule.cron %s: bad step %q", f.name, item)
			}
			step = n
		}
		lo, hi := f.min, f.max
		switch {
		case rng == "*":
		case strings.Contains(rng, "-"):
			a, b, _ := strings.Cut(rng, "-")
			var err error
			if lo, err = f.value(a); err != nil {
				return err
			}
			if hi, err = f.value(b); err != nil {
				return err
			}
			if lo > hi {
				return invalid("rule.cron %s: range %q goes backwards", f.name, rng)
			}
		default:
			v, err := f.value(rng)
			if err != nil {
				return err
			}
			lo = v
			// 「5/15」表示从 5 开始每 15 个
			if !hasStep {
				hi = v
			}
		}
		for v := lo; v <= hi; v += step {
			set[v] = true
		}
	}
	return nil
}

func (f cronField) value(s string) (int, error) {
	if v, ok := f.names[strings.ToLower(s)]; ok {
		return v, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < f.min || v > f.max {
		return 0, invalid("rule.cron %s: %q is not in %d..%d", f.name, s, f.min, f.max)
	}
	return v, nil
}

func (c *cronSpec) matchDay(day time.Time) bool {
	if !c.month[int(day.Month())] {
		return false
	}
	dom, dow := c.dom[day.Day()], c.dow[int(day.Weekday())]
	switch {
	case c.domAny && c.dowAny:
		return true
	case c.domAny:
		return dow
	case c.dowAny:
		return dom
	default:
		return dom || dow
	}
}

// next 按天往后找，每天按时、分从小到大试；墙上时间换成时刻的规则同 wallClock。
func (c *cronSpec) next(from time.Time, loc *time.Location) *time.Time {
	y, m, d := from.Date()
	for i := 0; i < searchDays; i++ {
		day := time.Date(y, m, d+i, 12, 0, 0, 0, loc)
		if !c.matchDay(day) {
			continue
		}
		for h := 0; h < 24; h++ {
			if !c.hour[h] {
				continue
			}
			for mi := 0; mi < 60; mi++ {
				if !c.minute[mi] {
					continue
				}
				t := wallClock(day.Year(), day.Month(), day.Day(), h, mi, loc)
				if t.After(from) {
					return &t
				}
			}
		}
	}
	return nil
}
