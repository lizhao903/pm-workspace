package schedule

import "testing"

func TestSameRule(t *testing.T) {
	cases := []struct {
		a, b Rule
		want bool
	}{
		{Rule{Freq: "daily", Time: "09:00", Day: 3}, Rule{Freq: "daily", Time: "09:00", Day: 9, Cron: "x"}, true},
		{Rule{Freq: "daily", Time: "09:00"}, Rule{Freq: "weekdays", Time: "09:00"}, false},
		{Rule{Freq: "weekly", Time: "18:00", Weekdays: []int{5, 1}}, Rule{Freq: "weekly", Time: "18:00", Weekdays: []int{1, 5, 1}}, true},
		{Rule{Freq: "weekly", Time: "18:00", Weekdays: []int{1}}, Rule{Freq: "weekly", Time: "18:00", Weekdays: []int{2}}, false},
		{Rule{Freq: "monthly", Time: "08:00", Day: 1}, Rule{Freq: "monthly", Time: "08:00", Day: 2}, false},
		{Rule{Freq: "once", Date: "2026-12-01", Time: "08:00"}, Rule{Freq: "once", Date: "2026-12-01", Time: "08:00"}, true},
		{Rule{Freq: "cron", Cron: "0 9  * * 1"}, Rule{Freq: "cron", Cron: " 0 9 * * 1"}, true},
	}
	for i, c := range cases {
		if got := SameRule(c.a, c.b); got != c.want {
			t.Errorf("%d：SameRule(%v, %v) = %v", i, c.a, c.b, got)
		}
	}
}
