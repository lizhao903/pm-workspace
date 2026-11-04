package schedule_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// remindFixture 接上真的通知中心和对象查询，建一条任务给提醒关联。
func remindFixture(t *testing.T) (*fixture, *notify.Center, *domain.Object) {
	t.Helper()
	f := newFixture(t)
	nc := notify.New(f.st.DB(), f.st, nil, nil)
	f.r.Reminders = nc
	f.ss.SetObjects(f.st)
	task, err := f.st.CreateObject(context.Background(), &domain.Object{TypeID: "task", Title: "给客户回电话"}, store.Actor{Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return f, nc, task
}

func notes(t *testing.T, nc *notify.Center) []notify.Notification {
	t.Helper()
	items, _, _, err := nc.List(context.Background(), notify.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func onceRemind(objectID string, date, hhmm string) schedule.Input {
	return schedule.Input{Name: "提醒：回电话", Rule: schedule.Rule{Freq: schedule.FreqOnce, Date: date, Time: hhmm},
		Action: schedule.Action{Kind: schedule.ActionRemind, Title: " 回电话 ", Body: "", ObjectID: objectID}}
}

func TestRemindActionValidate(t *testing.T) {
	f, _, task := remindFixture(t)
	ctx := context.Background()
	bad := []schedule.Action{
		{Kind: schedule.ActionRemind, Title: "  "},
		{Kind: schedule.ActionRemind, Title: strings.Repeat("长", 101)},
		{Kind: schedule.ActionRemind, Title: "x", Body: strings.Repeat("长", 2001)},
		{Kind: schedule.ActionRemind, Title: "x", ObjectID: "obj_nope"},
	}
	for i, a := range bad {
		_, err := f.ss.Create(ctx, schedule.Input{Name: "提醒", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"}, Action: a})
		if !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("第 %d 个应校验不过：%v", i, err)
		}
	}
	// 一次性时间已过回 400，和其它动作同一口径
	if _, err := f.ss.Create(ctx, onceRemind(task.ID, "2026-10-29", "07:59")); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("过去的时间应校验不过：%v", err)
	}
	// 去空白，只留自己的字段
	sc := f.create(t, schedule.Input{Name: "提醒", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionRemind, Title: " 喝水 ", Body: " 起来走走 ", ObjectID: " " + task.ID + " ", Priority: "P1", SOPID: "x"}})
	a := sc.Action
	if a.Title != "喝水" || a.Body != "起来走走" || a.ObjectID != task.ID || a.Priority != "" || a.SOPID != "" {
		t.Fatalf("规范化不对：%+v", a)
	}
	got, err := f.ss.Get(ctx, sc.ID)
	if err != nil || got.Action.Title != a.Title || got.Action.Body != a.Body || got.Action.ObjectID != a.ObjectID {
		t.Fatalf("读回来不一致：%+v %v", got, err)
	}
	b, _ := a.MarshalJSON()
	if string(b) != `{"body":"起来走走","kind":"remind","object_id":"`+task.ID+`","popup":"toast","title":"喝水"}` {
		t.Fatalf("JSON：%s", b)
	}
	// 弹窗方式（SPEC-tasks-8.26）：没给按 toast，modal 照存，别的值 400
	m := f.create(t, schedule.Input{Name: "点餐", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "17:45"},
		Action: schedule.Action{Kind: schedule.ActionRemind, Title: "点餐", Popup: " modal "}})
	if m.Action.Popup != schedule.PopupModal {
		t.Fatalf("modal 应原样存：%+v", m.Action)
	}
	if err := (schedule.Action{Kind: schedule.ActionRemind, Title: "x", Popup: "big"}).Normalize().Validate(); err == nil {
		t.Fatal("popup 不是 toast / modal 应校验不过")
	}
	// 删掉的任务不能再关联
	if err := f.st.DeleteObject(ctx, task.ID, false, store.Actor{Name: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ss.Create(ctx, onceRemind(task.ID, "2026-10-30", "09:00")); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("回收站里的任务应校验不过：%v", err)
	}
}

func TestRemindOnceFiresAndDisables(t *testing.T) {
	f, nc, task := remindFixture(t)
	ctx := context.Background()
	sc := f.create(t, onceRemind(task.ID, "2026-10-29", "09:00"))
	if sc.NextRunAt == nil || !sc.NextRunAt.Equal(f.at(9, 0, 0)) {
		t.Fatalf("下次：%v", sc.NextRunAt)
	}

	f.clk.set(f.at(8, 59, 50))
	f.tick(t)
	if n := len(notes(t, nc)); n != 0 {
		t.Fatalf("没到点就提醒了 %d 条", n)
	}

	f.clk.set(f.at(9, 0, 10))
	f.tick(t)
	ns := notes(t, nc)
	if len(ns) != 1 {
		t.Fatalf("到点应提醒 1 条，实际 %d", len(ns))
	}
	n := ns[0]
	if n.Kind != notify.KindReminder || n.Level != notify.LevelInfo || n.Title != "回电话" || n.Body != "给客户回电话" ||
		n.ObjectID != task.ID || n.Data["object_id"] != task.ID || n.Data["type_id"] != "task" || n.Data["ref"] != task.Ref ||
		n.Data["schedule_id"] != sc.ID || n.ReadAt != nil {
		t.Fatalf("通知不对：%+v", n)
	}
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || rs[0].Text != "提醒了「回电话」，关联 "+task.Ref ||
		rs[0].ObjectID == nil || *rs[0].ObjectID != task.ID || rs[0].Ref == nil || *rs[0].Ref != task.Ref || n.Data["run_id"] != rs[0].ID {
		t.Fatalf("执行记录：%+v", rs)
	}
	got, _ := f.ss.Get(ctx, sc.ID)
	if got.Enabled || got.NextRunAt != nil {
		t.Fatalf("一次性提醒到点后应停用：%+v", got)
	}

	// 再看几遍不重复
	f.clk.add(5 * 60e9)
	f.tick(t)
	if len(notes(t, nc)) != 1 || len(f.runs(t, sc.ID)) != 1 {
		t.Fatal("不该再提醒")
	}
	// 按对象查得到，停用的也在
	list, err := f.ss.ListByObject(ctx, task.ID)
	if err != nil || len(list) != 1 || list[0].ID != sc.ID {
		t.Fatalf("按对象查：%+v %v", list, err)
	}
}

// 错过的一次性提醒：和其它动作一样记一条 missed、不补发，也停用。
func TestRemindOnceMissed(t *testing.T) {
	f, nc, task := remindFixture(t)
	sc := f.create(t, onceRemind(task.ID, "2026-10-29", "09:00"))
	f.clk.set(f.at(9, 30, 0))
	f.tick(t)
	if n := len(notes(t, nc)); n != 0 {
		t.Fatalf("错过的不补发，实际 %d 条", n)
	}
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunMissed || rs[0].Missed != 1 || rs[0].Text != "没执行：10-29 09:00 到点时服务没在运行，没有补跑" {
		t.Fatalf("应记一条错过：%+v", rs)
	}
	if got, _ := f.ss.Get(context.Background(), sc.ID); got.Enabled {
		t.Fatal("错过的一次性提醒也应停用")
	}
}

// 重复规则的提醒每次都发、不停用；没关联对象、对象删了的照样发；停用的一次性到点只记已停用。
func TestRemindRepeatAndObjectGone(t *testing.T) {
	f, nc, task := remindFixture(t)
	ctx := context.Background()
	daily := f.create(t, schedule.Input{Name: "喝水", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionRemind, Title: "喝水", Body: "起来走走"}})
	linked := f.create(t, schedule.Input{Name: "回电话", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionRemind, Title: "回电话", ObjectID: task.ID}})
	off := false
	in := onceRemind(task.ID, "2026-10-29", "09:00")
	in.Enabled = &off
	paused := f.create(t, in)
	if err := f.st.DeleteObject(ctx, task.ID, false, store.Actor{Name: "test"}); err != nil {
		t.Fatal(err)
	}

	for day := range 2 {
		f.clk.set(f.at(9, 0, 5).AddDate(0, 0, day))
		f.tick(t)
	}
	if rs := f.runs(t, daily.ID); len(rs) != 2 || rs[0].Status != schedule.RunOK || rs[0].ObjectID != nil {
		t.Fatalf("每天的提醒应发两次：%+v", rs)
	}
	if got, _ := f.ss.Get(ctx, daily.ID); !got.Enabled {
		t.Fatal("重复的提醒不该停用")
	}
	rs := f.runs(t, linked.ID)
	if len(rs) != 2 || rs[0].Text != "提醒了「回电话」（关联的任务已删除，通知不带跳转）" || rs[0].ObjectID != nil {
		t.Fatalf("对象删了：%+v", rs)
	}
	if rs := f.runs(t, paused.ID); len(rs) != 1 || rs[0].Status != schedule.RunSkipped {
		t.Fatalf("停用的一次性：%+v", rs)
	}
	var gone, plain int
	for _, n := range notes(t, nc) {
		switch n.Title {
		case "回电话":
			if n.ObjectID != "" || n.Data["object_id"] != nil {
				t.Fatalf("对象删了不带跳转：%+v", n)
			}
			gone++
		case "喝水":
			if n.Body != "起来走走" || n.ObjectID != "" {
				t.Fatalf("没关联的：%+v", n)
			}
			plain++
		}
	}
	if gone != 2 || plain != 2 {
		t.Fatalf("通知条数：%d %d", gone, plain)
	}
}

// 手动执行一次：发通知，不停用；没接通知时记暂不支持。
func TestRemindRunNowAndUnsupported(t *testing.T) {
	f, nc, task := remindFixture(t)
	ctx := context.Background()
	sc := f.create(t, onceRemind(task.ID, "2026-10-30", "09:00"))
	run, err := f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunOK || !run.Manual {
		t.Fatalf("手动执行：%+v %v", run, err)
	}
	if len(notes(t, nc)) != 1 {
		t.Fatal("手动执行应发一条")
	}
	if got, _ := f.ss.Get(ctx, sc.ID); !got.Enabled {
		t.Fatal("手动执行不停用")
	}
	f.r.Reminders = nil
	run, err = f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunUnsupported || run.Text != "没执行：通知没接上" {
		t.Fatalf("没接通知：%+v %v", run, err)
	}
}
