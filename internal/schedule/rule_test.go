package schedule

import (
	"errors"
	"testing"
	"time"
	_ "time/tzdata" // 测试不依赖本机时区库

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// at 在 loc 里造一个时刻，"2026-10-29 08:00"。
func at(t *testing.T, loc *time.Location, s string) time.Time {
	t.Helper()
	v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func fmtNext(p *time.Time) string {
	if p == nil {
		return "nil"
	}
	return p.Format("2006-01-02 15:04 Mon")
}

func TestNextSixFrequencies(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	// 2026-10-29 是周四
	from := at(t, sh, "2026-10-29 10:00")
	cases := []struct {
		name string
		rule Rule
		want string
	}{
		{"once 将来", Rule{Freq: FreqOnce, Date: "2026-11-02", Time: "09:30"}, "2026-11-02 09:30 Mon"},
		{"once 当天稍后", Rule{Freq: FreqOnce, Date: "2026-10-29", Time: "10:01"}, "2026-10-29 10:01 Thu"},
		{"once 已过", Rule{Freq: FreqOnce, Date: "2026-10-29", Time: "09:59"}, "nil"},
		{"once 恰好是 from 不算", Rule{Freq: FreqOnce, Date: "2026-10-29", Time: "10:00"}, "nil"},
		{"daily 今天已过到明天", Rule{Freq: FreqDaily, Time: "09:00"}, "2026-10-30 09:00 Fri"},
		{"daily 今天还没到", Rule{Freq: FreqDaily, Time: "18:00"}, "2026-10-29 18:00 Thu"},
		{"daily 恰好是 from 不算", Rule{Freq: FreqDaily, Time: "10:00"}, "2026-10-30 10:00 Fri"},
		{"weekdays 周四之后是周五", Rule{Freq: FreqWeekdays, Time: "09:00"}, "2026-10-30 09:00 Fri"},
		{"weekly 周一", Rule{Freq: FreqWeekly, Time: "09:00", Weekdays: []int{1}}, "2026-11-02 09:00 Mon"},
		{"weekly 多选取最近", Rule{Freq: FreqWeekly, Time: "09:00", Weekdays: []int{0, 6}}, "2026-10-31 09:00 Sat"},
		{"weekly 当天还没到", Rule{Freq: FreqWeekly, Time: "16:00", Weekdays: []int{4}}, "2026-10-29 16:00 Thu"},
		{"weekly 当天已过到下周", Rule{Freq: FreqWeekly, Time: "09:00", Weekdays: []int{4}}, "2026-11-05 09:00 Thu"},
		{"monthly 本月还没到", Rule{Freq: FreqMonthly, Time: "10:00", Day: 30}, "2026-10-30 10:00 Fri"},
		{"monthly 本月已过到下月", Rule{Freq: FreqMonthly, Time: "10:00", Day: 1}, "2026-11-01 10:00 Sun"},
		{"cron 周一 18 点", Rule{Freq: FreqCron, Cron: "0 18 * * 1"}, "2026-11-02 18:00 Mon"},
		{"cron 每 15 分钟", Rule{Freq: FreqCron, Cron: "*/15 * * * *"}, "2026-10-29 10:15 Thu"},
		{"cron 工作日 9 到 18 点整", Rule{Freq: FreqCron, Cron: "0 9-18 * * 1-5"}, "2026-10-29 11:00 Thu"},
		{"cron 每月 1 号和 15 号", Rule{Freq: FreqCron, Cron: "30 8 1,15 * *"}, "2026-11-01 08:30 Sun"},
		{"cron 英文缩写", Rule{Freq: FreqCron, Cron: "0 9 * JAN MON"}, "2027-01-04 09:00 Mon"},
		{"cron 周日写 7", Rule{Freq: FreqCron, Cron: "0 9 * * 7"}, "2026-11-01 09:00 Sun"},
		{"cron 日和周都限定时任一满足", Rule{Freq: FreqCron, Cron: "0 9 13 * 5"}, "2026-10-30 09:00 Fri"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := fmtNext(Next(c.rule, from, sh)); got != c.want {
				t.Errorf("Next = %s, want %s", got, c.want)
			}
		})
	}
}

func TestNextWeekdaysSkipsWeekend(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	got := NextN(Rule{Freq: FreqWeekdays, Time: "09:00"}, at(t, sh, "2026-10-30 10:00"), sh, 3)
	want := []string{"2026-11-02 09:00 Mon", "2026-11-03 09:00 Tue", "2026-11-04 09:00 Wed"}
	for i, w := range want {
		if i >= len(got) || fmtNext(&got[i]) != w {
			t.Fatalf("NextN = %v, want %v", got, want)
		}
	}
}

func TestNextMonthEnd(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	cases := []struct {
		name string
		day  int
		from string
		want []string
	}{
		// 31 号在小月按月底：11 月 30、12 月 31、1 月 31、2 月 28
		{"31 号", 31, "2026-11-01 00:00", []string{"2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"}},
		// 闰年 2 月 29
		{"31 号闰年", 31, "2028-02-01 00:00", []string{"2028-02-29", "2028-03-31"}},
		{"30 号过 2 月", 30, "2027-01-31 00:00", []string{"2027-02-28", "2027-03-30"}},
		{"29 号平年", 29, "2027-02-01 00:00", []string{"2027-02-28", "2027-03-29"}},
		// 跨年
		{"跨年", 15, "2026-12-20 00:00", []string{"2027-01-15"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := NextN(Rule{Freq: FreqMonthly, Time: "10:00", Day: c.day}, at(t, sh, c.from), sh, len(c.want))
			if len(got) != len(c.want) {
				t.Fatalf("got %d runs, want %d", len(got), len(c.want))
			}
			for i, w := range c.want {
				if d := got[i].Format("2006-01-02"); d != w || got[i].Format("15:04") != "10:00" {
					t.Errorf("run %d = %s, want %s 10:00", i, got[i].Format("2006-01-02 15:04"), w)
				}
			}
		})
	}
}

func TestNextCronMonthEndAndNever(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	from := at(t, sh, "2026-10-29 10:00")
	// cron 的 31 号不按月底顺延（和常见 cron 一致），只在有 31 号的月份执行
	got := NextN(Rule{Freq: FreqCron, Cron: "0 9 31 * *"}, from, sh, 3)
	want := []string{"2026-10-31", "2026-12-31", "2027-01-31"}
	for i, w := range want {
		if got[i].Format("2006-01-02") != w {
			t.Errorf("run %d = %s, want %s", i, got[i].Format("2006-01-02"), w)
		}
	}
	// 2 月 29 号四年一次也找得到
	if n := Next(Rule{Freq: FreqCron, Cron: "0 0 29 2 *"}, from, sh); fmtNext(n) != "2028-02-29 00:00 Tue" {
		t.Errorf("Feb 29 = %s", fmtNext(n))
	}
	// 2 月 30 号永远碰不上
	if n := Next(Rule{Freq: FreqCron, Cron: "0 0 30 2 *"}, from, sh); n != nil {
		t.Errorf("Feb 30 = %s, want nil", fmtNext(n))
	}
}

func TestNextLocalTimeZone(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	ny := mustLoc(t, "America/New_York")
	// 同一时刻：上海 2026-10-29 08:00 = 纽约 10-28 20:00
	from := at(t, sh, "2026-10-29 08:00")
	r := Rule{Freq: FreqDaily, Time: "09:00"}
	if got := fmtNext(Next(r, from, sh)); got != "2026-10-29 09:00 Thu" {
		t.Errorf("上海 = %s", got)
	}
	n := Next(r, from, ny)
	if got := fmtNext(n); got != "2026-10-29 09:00 Thu" {
		t.Errorf("纽约 = %s", got)
	}
	if n.Location() != ny {
		t.Errorf("结果不在规则时区：%s", n.Location())
	}
	// 纽约 09:00（EDT，-4）比上海 09:00 晚 12 小时
	if d := n.Sub(*Next(r, from, sh)); d != 12*time.Hour {
		t.Errorf("时差 = %s", d)
	}
	// 一次性的日期也按规则时区解释
	once := Rule{Freq: FreqOnce, Date: "2026-10-29", Time: "07:00"}
	if Next(once, from, sh) != nil {
		t.Error("上海 07:00 已过")
	}
	if Next(once, from, ny) == nil {
		t.Error("纽约 07:00 还没到")
	}
	// loc 为 nil 用 time.Local
	if n := Next(r, from, nil); n == nil || n.Location() != time.Local {
		t.Errorf("nil loc = %v", n)
	}
}

func TestNextDaylightSaving(t *testing.T) {
	ny := mustLoc(t, "America/New_York")
	// 2027-03-14 02:00 拨快到 03:00，02:30 不存在：顺延到 03:30，当天仍然执行一次
	spring := NextN(Rule{Freq: FreqDaily, Time: "02:30"}, at(t, ny, "2027-03-13 12:00"), ny, 2)
	if got := spring[0].Format("2006-01-02 15:04 MST"); got != "2027-03-14 03:30 EDT" {
		t.Errorf("拨快当天 = %s", got)
	}
	if got := spring[1].Format("2006-01-02 15:04 MST"); got != "2027-03-15 02:30 EDT" {
		t.Errorf("拨快次日 = %s", got)
	}
	// 2026-11-01 02:00 拨慢到 01:00，01:30 出现两次：只在第一次（EDT）执行，下一次是第二天
	fall := NextN(Rule{Freq: FreqDaily, Time: "01:30"}, at(t, ny, "2026-10-31 12:00"), ny, 2)
	if got := fall[0].Format("2006-01-02 15:04 MST"); got != "2026-11-01 01:30 EDT" {
		t.Errorf("拨慢当天 = %s", got)
	}
	if got := fall[1].Format("2006-01-02 15:04 MST"); got != "2026-11-02 01:30 EST" {
		t.Errorf("拨慢次日 = %s", got)
	}
	// 每 30 分钟的 cron 跨过拨慢：两个 01:30 不重复执行，时间严格递增
	runs := NextN(Rule{Freq: FreqCron, Cron: "*/30 * * * *"}, at(t, ny, "2026-11-01 00:45"), ny, 4)
	var got []string
	for i, r := range runs {
		got = append(got, r.Format("15:04 MST"))
		if i > 0 && !r.After(runs[i-1]) {
			t.Errorf("不递增：%v", got)
		}
	}
	if want := "[01:00 EDT 01:30 EDT 02:00 EST 02:30 EST]"; fmtSlice(got) != want {
		t.Errorf("cron 跨拨慢 = %v, want %s", got, want)
	}
	// 不用夏令时的时区：每天间隔恒为 24 小时
	sh := mustLoc(t, "Asia/Shanghai")
	days := NextN(Rule{Freq: FreqDaily, Time: "02:30"}, at(t, sh, "2027-03-13 12:00"), sh, 3)
	for i := 1; i < len(days); i++ {
		if d := days[i].Sub(days[i-1]); d != 24*time.Hour {
			t.Errorf("上海间隔 = %s", d)
		}
	}
}

func fmtSlice(s []string) string {
	out := "["
	for i, v := range s {
		if i > 0 {
			out += " "
		}
		out += v
	}
	return out + "]"
}

func TestValidate(t *testing.T) {
	bad := []Rule{
		{Freq: "hourly", Time: "09:00"},
		{Freq: FreqDaily, Time: "9:00"},
		{Freq: FreqDaily, Time: "24:00"},
		{Freq: FreqDaily, Time: ""},
		{Freq: FreqWeekly, Time: "09:00"},
		{Freq: FreqWeekly, Time: "09:00", Weekdays: []int{7}},
		{Freq: FreqMonthly, Time: "09:00", Day: 0},
		{Freq: FreqMonthly, Time: "09:00", Day: 32},
		{Freq: FreqOnce, Time: "09:00"},
		{Freq: FreqOnce, Time: "09:00", Date: "2026-13-01"},
		{Freq: FreqCron, Cron: "0 9 * *"},
		{Freq: FreqCron, Cron: "60 9 * * *"},
		{Freq: FreqCron, Cron: "0 9 * * 8"},
		{Freq: FreqCron, Cron: "0 9-3 * * *"},
		{Freq: FreqCron, Cron: "*/0 * * * *"},
		{Freq: FreqCron, Cron: "0 9 * FOO *"},
	}
	for _, r := range bad {
		if err := r.Normalize().Validate(); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%+v: err = %v, want validation", r, err)
		}
		if Next(r, time.Now(), time.UTC) != nil {
			t.Errorf("%+v: 不完整的规则不该有下次执行", r)
		}
	}
	good := []Rule{
		{Freq: FreqDaily, Time: "00:00"},
		{Freq: FreqWeekly, Time: "23:59", Weekdays: []int{6, 0, 6}},
		{Freq: FreqMonthly, Time: "09:00", Day: 31},
		{Freq: FreqOnce, Time: "09:00", Date: "2020-01-01"},
		{Freq: FreqCron, Cron: "  5/15 0,12 1-7 * mon-fri  ", Time: "无所谓"},
	}
	for _, r := range good {
		if err := r.Normalize().Validate(); err != nil {
			t.Errorf("%+v: %v", r, err)
		}
	}
	if n := (Rule{Weekdays: []int{6, 0, 6}}).Normalize().Weekdays; fmtInts(n) != "0,6" {
		t.Errorf("weekdays 去重排序 = %v", n)
	}
	if n := (Rule{}).Normalize().Weekdays; n == nil {
		t.Error("weekdays 不该是 nil")
	}
}

func fmtInts(s []int) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += ","
		}
		out += string(rune('0' + v))
	}
	return out
}

func TestExpired(t *testing.T) {
	sh := mustLoc(t, "Asia/Shanghai")
	from := at(t, sh, "2026-10-29 10:00")
	if !(Rule{Freq: FreqOnce, Date: "2026-10-29", Time: "09:00"}).Expired(from, sh) {
		t.Error("一次性已过应为 Expired")
	}
	if (Rule{Freq: FreqOnce, Date: "2026-10-30", Time: "09:00"}).Expired(from, sh) {
		t.Error("一次性未到不该 Expired")
	}
	if (Rule{Freq: FreqDaily, Time: "09:00"}).Expired(from, sh) {
		t.Error("每天的规则不会 Expired")
	}
}
