package incident_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }

// events 收下发出的事件。
type events struct {
	mu  sync.Mutex
	got []incident.Event
}

func (e *events) Publish(_ context.Context, typ string, payload any) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if typ == incident.EventType {
		e.got = append(e.got, payload.(incident.Event))
	}
	return nil
}

func (e *events) actions() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, len(e.got))
	for i, ev := range e.got {
		out[i] = ev.Action
	}
	return out
}

type fixture struct {
	st  *sqlite.Store
	is  *incident.Store
	clk *clock
	ev  *events
	au  *audit.Log
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, clk: &clock{time.Date(2026, 10, 30, 9, 0, 0, 0, time.UTC)}, ev: &events{}}
	f.au = audit.New(st.DB(), nil)
	f.is = incident.New(st.DB(), nil)
	f.is.SetClock(f.clk.now)
	f.is.SetLocation(time.UTC)
	f.is.Events, f.is.Audit, f.is.Tasks = f.ev, f.au, st
	return f
}

func (f *fixture) record(t *testing.T, r incident.Report) *incident.Incident {
	t.Helper()
	x, err := f.is.Record(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

func report(fp string) incident.Report {
	return incident.Report{Fingerprint: fp, Level: "error", Module: "前端", Title: "页面出错了",
		Message: "Cannot read properties of undefined (reading 'label')", Stack: "TypeError: x\n    at Page (index.js:1:2)",
		Context: map[string]any{"页面": "设置"}, Source: incident.SourceFrontend}
}

var user = store.Actor{Name: "me", Source: "user"}

func TestRecordMergesByFingerprint(t *testing.T) {
	f := newFixture(t)
	first := f.record(t, report("front:a"))
	if first.Status != incident.StatusOpen || first.Count != 1 || len(first.Occurrences) != 1 || !strings.HasPrefix(first.ID, "inc_") {
		t.Fatalf("新记的一条不对：%+v", first)
	}
	// 同一指纹一分钟内再来：只加次数、更新最近时间，时间线不加、内容不覆盖
	f.clk.add(10 * time.Second)
	r := report("front:a")
	r.Message = "第二次的内容"
	x := f.record(t, r)
	if x.ID != first.ID || x.Count != 2 || len(x.Occurrences) != 1 || x.Message != first.Message || !x.LastAt.Equal(f.clk.t) {
		t.Fatalf("一分钟内合并不对：%+v", x)
	}
	// 过了一分钟：追加时间线、用新内容
	f.clk.add(time.Minute)
	x = f.record(t, r)
	if x.Count != 3 || len(x.Occurrences) != 2 || x.Message != "第二次的内容" || !x.Occurrences[0].Equal(f.clk.t) {
		t.Fatalf("过了一分钟合并不对：%+v", x)
	}
	// 时间线最多 20 个，新的在前
	for range 30 {
		f.clk.add(2 * time.Minute)
		x = f.record(t, r)
	}
	if len(x.Occurrences) != incident.MaxOccurrences || !x.Occurrences[0].Equal(f.clk.t) || x.Count != 33 {
		t.Fatalf("时间线没截到 20 个：%d 个，次数 %d", len(x.Occurrences), x.Count)
	}
	if !x.FirstAt.Equal(first.FirstAt) {
		t.Fatalf("首次时间变了：%v", x.FirstAt)
	}
	// 别的指纹另记一条
	if y := f.record(t, report("front:b")); y.ID == first.ID {
		t.Fatal("不同指纹合并到了一起")
	}
	if got := f.ev.actions(); got[0] != "created" || got[1] != "merged" {
		t.Fatalf("事件不对：%v", got)
	}
}

func TestRecordValidates(t *testing.T) {
	f := newFixture(t)
	for name, mut := range map[string]func(*incident.Report){
		"没有指纹": func(r *incident.Report) { r.Fingerprint = " " },
		"级别不对": func(r *incident.Report) { r.Level = "fatal" },
		"没有模块": func(r *incident.Report) { r.Module = "" },
		"没有标题": func(r *incident.Report) { r.Title = "" },
	} {
		r := report("front:x")
		mut(&r)
		if _, err := f.is.Record(context.Background(), r); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%s：要 validation，得到 %v", name, err)
		}
	}
}

func TestReappearReopens(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	x := f.record(t, report("front:a"))
	if _, err := f.is.SetStatus(ctx, x.ID, incident.StatusResolved, user); err != nil {
		t.Fatal(err)
	}
	f.clk.add(5 * time.Minute)
	got := f.record(t, report("front:a"))
	if got.Status != incident.StatusOpen || got.Note != "标为已解决后又出现了" {
		t.Fatalf("已解决的再出现没重新打开：%+v", got)
	}
	if _, err := f.is.SetStatus(ctx, x.ID, incident.StatusIgnored, user); err != nil {
		t.Fatal(err)
	}
	// 一分钟内再出现（只加次数的那条路）也要重新打开
	f.clk.add(10 * time.Second)
	got = f.record(t, report("front:a"))
	if got.Status != incident.StatusOpen || got.Note != "忽略后又出现了" {
		t.Fatalf("已忽略的再出现没重新打开：%+v", got)
	}
	// 有任务的再出现回到已转任务
	if _, err := f.is.ToTask(ctx, x.ID, incident.TaskInput{}, user); err != nil {
		t.Fatal(err)
	}
	if _, err := f.is.SetStatus(ctx, x.ID, incident.StatusResolved, user); err != nil {
		t.Fatal(err)
	}
	f.clk.add(5 * time.Minute)
	got = f.record(t, report("front:a"))
	if got.Status != incident.StatusTasked || got.TaskID == nil {
		t.Fatalf("有任务的再出现应回到 tasked：%+v", got)
	}
	// 手动重新打开：有任务的回 tasked
	if _, err := f.is.SetStatus(ctx, x.ID, incident.StatusIgnored, user); err != nil {
		t.Fatal(err)
	}
	if got, _ = f.is.SetStatus(ctx, x.ID, incident.StatusOpen, user); got.Status != incident.StatusTasked || got.Note != "" {
		t.Fatalf("重新打开不对：%+v", got)
	}
	if _, err := f.is.SetStatus(ctx, x.ID, "done", user); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("不认的状态要 400：%v", err)
	}
	if !strings.Contains(strings.Join(f.ev.actions(), ","), "reopened") {
		t.Fatalf("没发 reopened 事件：%v", f.ev.actions())
	}
}

func TestReportLimit(t *testing.T) {
	f := newFixture(t)
	for i := range incident.ReportLimit {
		if !f.is.AllowReport() {
			t.Fatalf("第 %d 条就被限了", i+1)
		}
	}
	if f.is.AllowReport() {
		t.Fatal("一分钟里第 61 条应当被限")
	}
	f.clk.add(61 * time.Second)
	if !f.is.AllowReport() {
		t.Fatal("过了一分钟应当放行")
	}
}

func TestFrontendFingerprint(t *testing.T) {
	a := incident.FrontendFingerprint("前端", "出错了", "TypeError: x\n    at Page (a.js:1:2)\n    at b (b.js:3:4)")
	b := incident.FrontendFingerprint("前端", "出错了", "TypeError: y\n    at Page (a.js:1:2)\n    at c (c.js:9:9)")
	c := incident.FrontendFingerprint("前端", "出错了", "TypeError: x\n    at Other (a.js:1:2)")
	if a != b || a == c || !strings.HasPrefix(a, "front:") {
		t.Fatalf("指纹只该看模块、标题、第一帧：%s %s %s", a, b, c)
	}
	if got := incident.FirstFrame("Error\nrender@http://x/a.js:1:2"); got != "render@http://x/a.js:1:2" {
		t.Fatalf("Safari 的帧没认出来：%q", got)
	}
}

func TestToTask(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	x := f.record(t, report("conn:cn_x:auth"))
	res, err := f.is.ToTask(ctx, x.ID, incident.TaskInput{}, user)
	if err != nil {
		t.Fatal(err)
	}
	task := res.Task
	if task.Source != domain.TaskSourceIncident || task.Title != "[异常] 前端：页面出错了" || task.Priority != "P1" {
		t.Fatalf("任务不对：%+v", task)
	}
	ref, _ := task.Props[domain.PropSourceRef].(map[string]any)
	if ref["incident_id"] != x.ID {
		t.Fatalf("source_ref 没指向异常：%v", task.Props)
	}
	for _, want := range []string{"【运行异常】前端 · 错误", "现象：Cannot read", "频率：共 1 次", "- 页面：设置", "报错：\nTypeError", "期望："} {
		if !strings.Contains(task.Body, want) {
			t.Errorf("描述里没有 %q：\n%s", want, task.Body)
		}
	}
	if got := res.Incident; got.Status != incident.StatusTasked || got.TaskID == nil || *got.TaskID != task.ID || got.TaskRef != task.Ref {
		t.Fatalf("异常没变已转任务：%+v", got)
	}
	// 已经有任务的再转 409
	if _, err := f.is.ToTask(ctx, x.ID, incident.TaskInput{}, user); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("重复转任务要 409：%v", err)
	}
	// 审计
	items, _, err := f.au.List(ctx, audit.Filter{TargetType: "incident", TargetID: x.ID})
	if err != nil || len(items) != 1 || items[0].Action != "create_task" {
		t.Fatalf("转任务没记审计：%+v %v", items, err)
	}
	// 任务完成后 task_done 为真
	done := "done"
	if _, err := f.st.UpdateObject(ctx, task.ID, domain.ObjectPatch{Status: &done}, user); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.is.Get(ctx, x.ID); !got.TaskDone || got.TaskStatus != "done" {
		t.Fatalf("任务完成了 task_done 应为真：%+v", got)
	}
	// 任务删了：异常退回未处理，可以重新转
	if err := f.st.DeleteObject(ctx, task.ID, false, user); err != nil {
		t.Fatal(err)
	}
	got, err := f.is.Get(ctx, x.ID)
	if err != nil || got.Status != incident.StatusOpen || got.TaskID != nil || got.Note != "关联的任务已删除" {
		t.Fatalf("任务删了异常没退回：%+v %v", got, err)
	}
	// 自定义标题、优先级；负责人不存在 400
	title, prio, who := "自己写的标题", "P3", "stk_nope"
	if _, err := f.is.ToTask(ctx, x.ID, incident.TaskInput{AssigneeID: &who}, user); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("负责人不存在要 400：%v", err)
	}
	res, err = f.is.ToTask(ctx, x.ID, incident.TaskInput{Title: &title, Priority: &prio}, user)
	if err != nil || res.Task.Title != title || res.Task.Priority != prio {
		t.Fatalf("自定义字段没生效：%+v %v", res, err)
	}
	// 已解决的不能转
	y := f.record(t, report("front:y"))
	if _, err := f.is.SetStatus(ctx, y.ID, incident.StatusResolved, user); err != nil {
		t.Fatal(err)
	}
	if _, err := f.is.ToTask(ctx, y.ID, incident.TaskInput{}, user); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("已解决的转任务要 409：%v", err)
	}
}

// 巡检：按级别和次数建任务，标签 claude-code，不重复建；结果写进定时任务的执行记录。
func TestSweepAction(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	errOnce := f.record(t, report("front:err1"))
	warn := report("front:warn")
	warn.Level = "warn"
	warnX := f.record(t, warn)
	hot := report("front:hot")
	for range 5 {
		f.clk.add(2 * time.Minute)
		f.record(t, hot)
	}
	ignored := f.record(t, report("front:ignored"))
	if _, err := f.is.SetStatus(ctx, ignored.ID, incident.StatusIgnored, user); err != nil {
		t.Fatal(err)
	}

	ss := schedule.New(f.st.DB(), time.UTC)
	ss.SetClock(f.clk.now)
	r := schedule.NewRunner(ss, f.st, nil)
	r.Incidents = f.is
	sc, err := ss.Create(ctx, schedule.Input{Name: "运行异常巡检", Rule: schedule.Rule{Freq: "daily", Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionIncidentSweep, MinCount: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if sc.Action.MinLevel != "error" || sc.Action.MinCount != 2 {
		t.Fatalf("默认值不对：%+v", sc.Action)
	}
	run, err := r.RunNow(ctx, sc.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 只有 hot（错误、5 次）够格；err1 次数不够、warn 级别不够，算跳过；ignored 不看
	if run.Status != schedule.RunOK || !strings.Contains(run.Text, "建了 1 条修复任务") || !strings.Contains(run.Text, "跳过 2 条") || run.Ref == nil {
		t.Fatalf("执行记录不对：%+v", run)
	}
	task, err := f.st.GetObject(ctx, *run.ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Priority != "P0" || len(task.Tags) != 1 || task.Tags[0] != "claude-code" || task.Source != domain.TaskSourceIncident {
		t.Fatalf("巡检建的任务不对：%+v", task)
	}
	for _, want := range []string{"现象：", "频率：共 5 次", "期望：", "怎么复现：", "改完怎么验收："} {
		if !strings.Contains(task.Body, want) {
			t.Errorf("正文里没有 %q", want)
		}
	}
	if acc, _ := task.Props[domain.PropAcceptance].(string); !strings.Contains(acc, "- [ ]") {
		t.Fatalf("props.acceptance 没写：%v", task.Props)
	}
	// 再跑一次：已经建过的不再建
	run, err = r.RunNow(ctx, sc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(run.Text, "没有要处理的运行异常") || run.ObjectID != nil {
		t.Fatalf("第二次不该再建：%+v", run)
	}
	// 放宽到警告、1 次：剩下两条都建
	if _, err := ss.Update(ctx, sc.ID, schedule.Patch{Action: &schedule.Action{Kind: schedule.ActionIncidentSweep, MinLevel: "warn"}}); err != nil {
		t.Fatal(err)
	}
	run, err = r.RunNow(ctx, sc.ID)
	if err != nil || !strings.Contains(run.Text, "建了 2 条修复任务") {
		t.Fatalf("放宽后应建两条：%+v %v", run, err)
	}
	for _, id := range []string{errOnce.ID, warnX.ID} {
		if x, _ := f.is.Get(ctx, id); x.Status != incident.StatusTasked {
			t.Fatalf("%s 没变已转任务：%+v", id, x)
		}
	}
	if x, _ := f.is.Get(ctx, ignored.ID); x.Status != incident.StatusIgnored || x.TaskID != nil {
		t.Fatalf("已忽略的不该建任务：%+v", x)
	}
	// 巡检建任务记审计，操作者是定时任务
	items, _, err := f.au.List(ctx, audit.Filter{TargetType: "incident", Action: "create_task"})
	if err != nil || len(items) != 3 || items[0].Actor != "schedule#"+sc.ID || items[0].Source != "schedule" {
		t.Fatalf("巡检审计不对：%+v %v", items, err)
	}
	// 校验
	for _, a := range []schedule.Action{
		{Kind: schedule.ActionIncidentSweep, MinLevel: "info"},
		{Kind: schedule.ActionIncidentSweep, MinCount: -1},
	} {
		if _, err := ss.Create(ctx, schedule.Input{Name: "x", Rule: schedule.Rule{Freq: "daily", Time: "09:00"}, Action: a}); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%+v 应当 400：%v", a, err)
		}
	}
}

// 没接运行异常时巡检记 unsupported。
func TestSweepUnavailable(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	ss := schedule.New(f.st.DB(), time.UTC)
	r := schedule.NewRunner(ss, f.st, nil)
	sc, err := ss.Create(ctx, schedule.Input{Name: "巡检", Rule: schedule.Rule{Freq: "daily", Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionIncidentSweep}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunUnsupported {
		t.Fatalf("没接时应记 unsupported：%+v %v", run, err)
	}
}

// 巡检跳过两类，留给用户：修复任务被删过的（再出现后重新算）、Claude Code 执行失败的。
func TestSweepHolds(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	gone := f.record(t, report("front:gone"))
	claude := f.record(t, report(incident.ClaudeFingerprintPrefix+"obj_x:failed"))
	ss := schedule.New(f.st.DB(), time.UTC)
	ss.SetClock(f.clk.now)
	r := schedule.NewRunner(ss, f.st, nil)
	r.Incidents = f.is
	sc, err := ss.Create(ctx, schedule.Input{Name: "运行异常巡检", Rule: schedule.Rule{Freq: "daily", Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionIncidentSweep}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := r.RunNow(ctx, sc.ID)
	if err != nil || !strings.Contains(run.Text, "建了 1 条修复任务") || !strings.Contains(run.Text, "1 条留给你处理") {
		t.Fatalf("第一次巡检：%+v %v", run, err)
	}
	if x, _ := f.is.Get(ctx, claude.ID); x.Status != incident.StatusOpen || x.TaskID != nil {
		t.Fatalf("Claude Code 执行失败不该自动建任务：%+v", x)
	}
	// 修复任务删掉：异常退回未处理，巡检不再建
	if err := f.st.DeleteObject(ctx, *run.ObjectID, false, user); err != nil {
		t.Fatal(err)
	}
	run, err = r.RunNow(ctx, sc.ID)
	if err != nil || run.ObjectID != nil || !strings.Contains(run.Text, "2 条留给你处理") {
		t.Fatalf("任务删过的不该再建：%+v %v", run, err)
	}
	// 再出现：标记清掉，下次巡检重新建
	f.clk.add(2 * time.Minute)
	f.record(t, report("front:gone"))
	run, err = r.RunNow(ctx, sc.ID)
	if err != nil || !strings.Contains(run.Text, "建了 1 条修复任务") {
		t.Fatalf("再出现后应重新建：%+v %v", run, err)
	}
	if x, _ := f.is.Get(ctx, gone.ID); x.Status != incident.StatusTasked {
		t.Fatalf("再出现后应已转任务：%+v", x)
	}
}
