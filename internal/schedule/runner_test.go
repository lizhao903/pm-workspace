// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// clock 是假时钟，测试里手动往前拨。
type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) set(t time.Time)     { c.t = t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

type fixture struct {
	st  *sqlite.Store
	ss  *schedule.Store
	r   *schedule.Runner
	clk *clock
	loc *time.Location
}

// newFixture 用真库、上海时区，假时钟停在 2026-10-29 08:00（周四）。
func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{st: st, loc: loc, clk: &clock{time.Date(2026, 10, 29, 8, 0, 0, 0, loc)}}
	f.ss = schedule.New(st.DB(), loc)
	f.ss.SetClock(f.clk.now)
	f.r = schedule.NewRunner(f.ss, st, nil)
	return f
}

func (f *fixture) at(hh, mm, ss int) time.Time {
	return time.Date(2026, 10, 29, hh, mm, ss, 0, f.loc)
}

func (f *fixture) tick(t *testing.T) {
	t.Helper()
	if err := f.r.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) create(t *testing.T, in schedule.Input) *schedule.Schedule {
	t.Helper()
	sc, err := f.ss.Create(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

func (f *fixture) runs(t *testing.T, id string) []schedule.Run {
	t.Helper()
	rs, err := f.ss.ListRuns(context.Background(), id, 0)
	if err != nil {
		t.Fatal(err)
	}
	return rs
}

func (f *fixture) scheduleTasks(t *testing.T) []*domain.Object {
	t.Helper()
	items, _, err := f.st.ListObjects(context.Background(), domain.ObjectFilter{TypeIDs: []string{"task"}, Sources: []string{domain.TaskSourceSchedule}, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func dailyTask(title string) schedule.Input {
	return schedule.Input{Name: "每天整理收件箱", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionTask, Title: title, Desc: "过一遍", Priority: "P1", DueDays: 1}}
}

func TestRunnerCreatesTaskOnTime(t *testing.T) {
	f := newFixture(t)
	sc := f.create(t, dailyTask("整理收件箱 {{date}}"))

	f.clk.set(f.at(8, 59, 55))
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 0 {
		t.Fatalf("没到点就建了 %d 条", n)
	}

	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	tasks := f.scheduleTasks(t)
	if len(tasks) != 1 {
		t.Fatalf("到点应建 1 条，实际 %d", len(tasks))
	}
	task := tasks[0]
	if task.Title != "整理收件箱 2026/10/29" || task.Source != domain.TaskSourceSchedule || task.Priority != "P1" || task.Body != "过一遍" {
		t.Fatalf("任务字段不对：%+v", task)
	}
	ref, _ := task.Props[domain.PropSourceRef].(map[string]any)
	if ref["schedule_id"] != sc.ID || ref["name"] != sc.Name {
		t.Fatalf("source_ref = %v", task.Props[domain.PropSourceRef])
	}
	if task.DueAt == nil || task.DueAt.In(f.loc).Format("2006-01-02 15:04") != "2026-10-30 00:00" {
		t.Fatalf("截止应为第二天零点，实际 %v", task.DueAt)
	}

	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || !rs[0].OK || rs[0].Manual ||
		rs[0].Ref == nil || *rs[0].Ref != task.Ref || rs[0].ObjectID == nil || *rs[0].ObjectID != task.ID ||
		!rs[0].At.Equal(f.at(9, 0, 0)) || rs[0].Text != "建了任务 "+task.Ref || rs[0].FinishedAt == nil {
		t.Fatalf("执行记录不对：%+v", rs)
	}

	// 同一时刻再看几遍不重复
	f.clk.add(10 * time.Second)
	f.tick(t)
	f.clk.add(time.Minute)
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 1 {
		t.Fatalf("重复执行了：%d 条", n)
	}

	// 第二天照常
	f.clk.set(f.at(9, 0, 3).AddDate(0, 0, 1))
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 2 {
		t.Fatalf("第二天应再建 1 条，共 %d", n)
	}
}

// 重启：新的 Runner、新的 Store 连同一个库。游标已推进时不再看；游标没来得及推进时靠唯一索引挡住。
func TestRunnerRestartDoesNotRepeat(t *testing.T) {
	f := newFixture(t)
	sc := f.create(t, dailyTask("整理收件箱"))
	f.clk.set(f.at(9, 0, 5))
	f.tick(t)

	restart := func() {
		ss := schedule.New(f.st.DB(), f.loc)
		ss.SetClock(f.clk.now)
		f.ss, f.r = ss, schedule.NewRunner(ss, f.st, nil)
		if err := f.r.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		f.r.Stop()
	}

	f.clk.set(f.at(9, 0, 30))
	restart()
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 1 {
		t.Fatalf("重启后重复执行：%d 条", n)
	}

	// 模拟执行完、游标没写进去就退出了
	if _, err := f.st.DB().W.Exec(`UPDATE schedules SET checked_at = NULL WHERE id = ?`, sc.ID); err != nil {
		t.Fatal(err)
	}
	restart()
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 1 {
		t.Fatalf("游标丢了也不该重复执行：%d 条", n)
	}
	if rs := f.runs(t, sc.ID); len(rs) != 1 {
		t.Fatalf("执行记录应只有 1 条：%+v", rs)
	}
}

// 上次退出时停在 running 的记录：重启时记为失败，不重跑。
func TestRunnerFailsInterruptedRun(t *testing.T) {
	f := newFixture(t)
	sc := f.create(t, dailyTask("整理收件箱"))
	if _, err := f.st.DB().W.Exec(`INSERT INTO schedule_runs (id, schedule_id, planned_at, manual, status, started_at)
		VALUES ('srn_x', ?, '2026-10-29T01:00:00.000Z', 0, 'running', '2026-10-29T01:00:00.000Z')`, sc.ID); err != nil {
		t.Fatal(err)
	}
	f.clk.set(f.at(9, 0, 30))
	if err := f.r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.r.Stop()
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunFailed || rs[0].FinishedAt == nil {
		t.Fatalf("应记为失败且不重跑：%+v", rs)
	}
	if n := len(f.scheduleTasks(t)); n != 0 {
		t.Fatalf("不该重跑：%d 条", n)
	}
}

// 服务停了三天：错过的合成一条 missed，不补跑；停的时候刚好过了准时窗口的那次也算错过。
func TestRunnerMissedRecordedOnce(t *testing.T) {
	f := newFixture(t)
	sc := f.create(t, dailyTask("整理收件箱"))
	f.clk.set(f.at(9, 30, 0).AddDate(0, 0, 2))
	f.tick(t)
	if n := len(f.scheduleTasks(t)); n != 0 {
		t.Fatalf("错过的不补跑，实际建了 %d 条", n)
	}
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunMissed || rs[0].OK || rs[0].Missed != 3 || !rs[0].At.Equal(f.at(9, 0, 0)) {
		t.Fatalf("应只有一条错过 3 次的记录：%+v", rs)
	}
	if rs[0].Text != "没执行：服务没在运行，从 10-29 09:00 起错过了 3 次，没有补跑" {
		t.Fatalf("文字：%s", rs[0].Text)
	}
	f.tick(t)
	if rs := f.runs(t, sc.ID); len(rs) != 1 {
		t.Fatalf("再看一遍不该多记：%+v", rs)
	}

	// 停了一天多、回来时刚好在准时窗口里：错过的记一条，这次照常执行
	f.clk.set(f.at(9, 1, 0).AddDate(0, 0, 4))
	f.tick(t)
	rs = f.runs(t, sc.ID)
	if len(rs) != 3 || rs[0].Status != schedule.RunOK || rs[1].Status != schedule.RunMissed || rs[1].Missed != 1 {
		t.Fatalf("应为 ok + missed(1) + missed(3)：%+v", rs)
	}
	if n := len(f.scheduleTasks(t)); n != 1 {
		t.Fatalf("准时的这次应建 1 条：%d", n)
	}
}

func TestRunnerDisabledAndUnsupported(t *testing.T) {
	f := newFixture(t)
	off := false
	in := dailyTask("停用的")
	in.Enabled = &off
	disabled := f.create(t, in)
	sop := f.create(t, schedule.Input{Name: "周会纪要", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionSOP, SOPID: "sop_x"}})
	agent := f.create(t, schedule.Input{Name: "写周报", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionAgent, AgentID: "ag_x", Prompt: "写"}})

	// 停用期间错过的不记，到点那次记「已停用」
	f.clk.set(f.at(9, 0, 5).AddDate(0, 0, 1))
	f.tick(t)
	if rs := f.runs(t, disabled.ID); len(rs) != 1 || rs[0].Status != schedule.RunSkipped || rs[0].Text != "没执行：已停用" {
		t.Fatalf("停用：%+v", rs)
	}
	for _, id := range []string{sop.ID, agent.ID} {
		rs := f.runs(t, id)
		if len(rs) != 2 || rs[0].Status != schedule.RunUnsupported || rs[0].OK || rs[1].Status != schedule.RunMissed {
			t.Fatalf("SOP、Agent 应记暂不支持：%+v", rs)
		}
	}
	if n := len(f.scheduleTasks(t)); n != 0 {
		t.Fatalf("都不该建任务：%d", n)
	}
}

// 手动执行：停用的也能跑，不受唯一索引限制，不动游标。
func TestRunNowAndOwner(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	sh, err := f.st.CreateStakeholder(ctx, &domain.Stakeholder{Name: "小王"})
	if err != nil {
		t.Fatal(err)
	}
	off := false
	in := dailyTask("手动")
	in.Enabled = &off
	in.Action.Assignee = sh.ID
	sc := f.create(t, in)
	for i := 0; i < 2; i++ {
		run, err := f.r.RunNow(ctx, sc.ID)
		if err != nil || run == nil || !run.Manual || run.Status != schedule.RunOK {
			t.Fatalf("手动执行：%+v %v", run, err)
		}
	}
	tasks := f.scheduleTasks(t)
	if len(tasks) != 2 || tasks[0].OwnerID == nil || *tasks[0].OwnerID != sh.ID {
		t.Fatalf("手动执行两次应建两条、负责人是小王：%+v", tasks)
	}

	// 负责人删了：照样建，不设负责人
	gone := "stk_gone"
	act := in.Action
	act.Assignee = gone
	if _, err := f.ss.Update(ctx, sc.ID, schedule.Patch{Action: &act}); err != nil {
		t.Fatal(err)
	}
	run, err := f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunOK || run.Text != "建了任务 "+*run.Ref+"（负责人已删除，没设负责人）" {
		t.Fatalf("负责人已删：%+v %v", run, err)
	}
	if _, err := f.r.RunNow(ctx, "sch_nope"); err == nil {
		t.Fatal("不存在的定时任务应报错")
	}

	// 删定时任务：执行记录一起删，任务保留
	if err := f.ss.Delete(ctx, sc.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.st.DB().R.QueryRow(`SELECT COUNT(*) FROM schedule_runs WHERE schedule_id = ?`, sc.ID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("执行记录应级联删除：%d %v", n, err)
	}
	if got := len(f.scheduleTasks(t)); got != 3 {
		t.Fatalf("建出来的任务应保留：%d", got)
	}
}

// 后台循环真的会跑：Interval 调小，用真时钟附近的一次性规则不现实，这里只看 Start/Stop 不卡住。
func TestRunnerStartStop(t *testing.T) {
	f := newFixture(t)
	f.r.Interval = time.Millisecond
	if err := f.r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	f.r.Stop()
	schedule.NewRunner(f.ss, f.st, nil).Stop()
}

var _ schedule.TaskCreator = store.Store(nil)
