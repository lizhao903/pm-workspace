// Package schedule 是定时任务（TASK-03a）：规则、下次执行时间的计算，和 schedules 表（0020）的读写。
// 调度执行与执行记录归 TASK-03b，这里不跑任何东西。
//
// 规则移植自原型 web-next/src/scheduledata.ts，按「墙上时间」理解：每天 09:00 指的是所在时区的 09:00。
// 时区由调用方给（服务用 time.Local），夏令时切换时：
//   - 拨快跳过的时刻（如 02:30 不存在）顺延到同样时长之后（03:30），当天仍执行一次；
//   - 拨慢重复的时刻（如 01:30 出现两次）只在第一次执行。
//
// 不用夏令时的时区（如 Asia/Shanghai）不受影响。
package schedule

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 频率。
const (
	FreqOnce     = "once"
	FreqDaily    = "daily"
	FreqWeekdays = "weekdays"
	FreqWeekly   = "weekly"
	FreqMonthly  = "monthly"
	FreqCron     = "cron"
)

// Freqs 是全部频率，校验和文档用。
var Freqs = []string{FreqOnce, FreqDaily, FreqWeekdays, FreqWeekly, FreqMonthly, FreqCron}

// searchDays 是往后找的天数上限：要覆盖「2 月 29 号」这种四年一次的 cron。
const searchDays = 366*4 + 2

// Rule 与原型 ScheduleRule 同形。各频率只用到自己的字段，其余字段原样保存，切换频率时不丢。
type Rule struct {
	Freq string `json:"freq"`
	// Time 是 HH:mm；cron 不用它
	Time string `json:"time"`
	// Weekdays 是每周的周几，0 为周日
	Weekdays []int `json:"weekdays"`
	// Day 是每月几号，1 到 31；小月没有这一天时按月底算
	Day int `json:"day"`
	// Date 是只执行一次的日期，yyyy-mm-dd
	Date string `json:"date"`
	// Cron 是 5 段：分 时 日 月 周
	Cron string `json:"cron"`
}

// Normalize 补零值：weekdays 不为 null、去重排序，cron 去掉首尾空白。
func (r Rule) Normalize() Rule {
	out := r
	out.Freq = strings.TrimSpace(r.Freq)
	out.Time = strings.TrimSpace(r.Time)
	out.Date = strings.TrimSpace(r.Date)
	out.Cron = strings.TrimSpace(r.Cron)
	ws := slices.Clone(r.Weekdays)
	slices.Sort(ws)
	out.Weekdays = slices.Compact(ws)
	if out.Weekdays == nil {
		out.Weekdays = []int{}
	}
	return out
}

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", domain.ErrValidation, fmt.Sprintf(format, a...))
}

// Validate 检查规则是否完整，不看是否已经过去（一次性的过期判断见 Expired）。
func (r Rule) Validate() error {
	switch r.Freq {
	case FreqOnce, FreqDaily, FreqWeekdays, FreqWeekly, FreqMonthly:
		if _, _, err := parseHHMM(r.Time); err != nil {
			return err
		}
	case FreqCron:
		_, err := parseCron(r.Cron)
		return err
	default:
		return invalid("rule.freq must be one of %s, got %q", strings.Join(Freqs, " / "), r.Freq)
	}
	switch r.Freq {
	case FreqWeekly:
		if len(r.Weekdays) == 0 {
			return invalid("rule.weekdays: weekly needs at least one weekday (0 = Sunday .. 6 = Saturday)")
		}
		for _, d := range r.Weekdays {
			if d < 0 || d > 6 {
				return invalid("rule.weekdays: %d out of range 0..6 (0 = Sunday)", d)
			}
		}
	case FreqMonthly:
		if r.Day < 1 || r.Day > 31 {
			return invalid("rule.day must be 1..31, got %d", r.Day)
		}
	case FreqOnce:
		if _, err := time.Parse("2006-01-02", r.Date); err != nil {
			return invalid("rule.date must be yyyy-mm-dd, got %q", r.Date)
		}
	}
	return nil
}

// Expired 说一次性规则在 from 时是否已经过去；其它频率总是 false。规则不完整时也是 false，交给 Validate 报。
func (r Rule) Expired(from time.Time, loc *time.Location) bool {
	if r.Freq != FreqOnce || r.Validate() != nil {
		return false
	}
	return Next(r, from, loc) == nil
}

// Next 从 from 往后（不含 from）找下一次执行时间，结果在 loc 时区。
// 规则不完整、一次性已过、cron 在四年内都碰不上时返回 nil。loc 为 nil 时用 time.Local。
func Next(r Rule, from time.Time, loc *time.Location) *time.Time {
	if loc == nil {
		loc = time.Local
	}
	r = r.Normalize()
	if r.Validate() != nil {
		return nil
	}
	from = from.In(loc)
	if r.Freq == FreqCron {
		c, _ := parseCron(r.Cron)
		return c.next(from, loc)
	}
	hh, mm, _ := parseHHMM(r.Time)
	if r.Freq == FreqOnce {
		d, _ := time.ParseInLocation("2006-01-02", r.Date, loc)
		t := wallClock(d.Year(), d.Month(), d.Day(), hh, mm, loc)
		if t.After(from) {
			return &t
		}
		return nil
	}
	y, m, d := from.Date()
	for i := 0; i < searchDays; i++ {
		day := time.Date(y, m, d+i, 12, 0, 0, 0, loc)
		if !r.matchDay(day) {
			continue
		}
		t := wallClock(day.Year(), day.Month(), day.Day(), hh, mm, loc)
		if t.After(from) {
			return &t
		}
	}
	return nil
}

// NextN 连续算 n 次，编辑时预览用；碰到 nil 就停。
func NextN(r Rule, from time.Time, loc *time.Location, n int) []time.Time {
	out := []time.Time{}
	for len(out) < n {
		t := Next(r, from, loc)
		if t == nil {
			break
		}
		out = append(out, *t)
		from = *t
	}
	return out
}

func (r Rule) matchDay(day time.Time) bool {
	wd := int(day.Weekday())
	switch r.Freq {
	case FreqDaily:
		return true
	case FreqWeekdays:
		return wd >= 1 && wd <= 5
	case FreqWeekly:
		return slices.Contains(r.Weekdays, wd)
	case FreqMonthly:
		return day.Day() == min(r.Day, daysIn(day.Year(), day.Month()))
	}
	return false
}

func daysIn(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 12, 0, 0, 0, time.UTC).Day()
}

func parseHHMM(s string) (int, int, error) {
	t, err := time.Parse("15:04", s)
	if err != nil || len(s) != 5 {
		return 0, 0, invalid("rule.time must be HH:mm like 09:00, got %q", s)
	}
	return t.Hour(), t.Minute(), nil
}

// wallClock 是 loc 里这一天 hh:mm 的那个时刻。
// 重复出现的时刻（拨慢）取第一次；不存在的时刻（拨快）顺延跳过的时长，即按切换前的偏移换算。
// time.Date 对这两种情况取哪个偏移不作保证，所以这里自己挑。
func wallClock(y int, m time.Month, d, hh, mm int, loc *time.Location) time.Time {
	t := time.Date(y, m, d, hh, mm, 0, 0, loc)
	wall := time.Date(y, m, d, hh, mm, 0, 0, time.UTC).Unix()
	// 前后各看几小时的偏移，每个偏移换算出一个候选
	var match, all []time.Time
	for _, probe := range []time.Duration{-3 * time.Hour, 0, 3 * time.Hour} {
		_, off := t.Add(probe).Zone()
		c := time.Unix(wall-int64(off), 0).In(loc)
		all = append(all, c)
		if c.Hour() == hh && c.Minute() == mm && c.Day() == d {
			match = append(match, c)
		}
	}
	if len(match) > 0 {
		return slices.MinFunc(match, time.Time.Compare)
	}
	return slices.MaxFunc(all, time.Time.Compare)
}
