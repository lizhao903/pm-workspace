package plugin_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// TestScheduleActionFromDemo：示例插件登记的动作能被定时任务调起并记执行记录；停用时到点记失败写明原因，启用后下次照常。
func TestScheduleActionFromDemo(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)

	loc := time.UTC
	now := time.Date(2026, 10, 29, 8, 0, 0, 0, loc)
	ss := schedule.New(st.DB(), loc)
	ss.SetClock(func() time.Time { return now })
	ss.SetPluginActions(r)
	runner := schedule.NewRunner(ss, st, quiet)
	in := schedule.Input{Name: "每天记一笔", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: plugintest.ScheduleActionKind, Params: map[string]any{"text": " 早上好 "}}}

	// 装了没启用：校验没人接，回 400
	if _, err := ss.Create(ctx, in); !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), "提供这个动作的插件没启用：示例插件（demo）") {
		t.Fatalf("没启用时新建：%v", err)
	}
	installEnable(t, r, "demo")
	bad := in
	bad.Action = schedule.Action{Kind: plugintest.ScheduleActionKind, Params: map[string]any{}}
	if _, err := ss.Create(ctx, bad); !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), "text 必填") {
		t.Fatalf("参数不对：%v", err)
	}
	sc, err := ss.Create(ctx, in)
	if err != nil || sc.Action.Params["text"] != "早上好" {
		t.Fatalf("新建：%+v %v", sc, err)
	}

	tick := func(at time.Time) schedule.Run {
		t.Helper()
		now = at
		if err := runner.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		rs, err := ss.ListRuns(ctx, sc.ID, 0)
		if err != nil || len(rs) == 0 {
			t.Fatalf("执行记录：%v %v", rs, err)
		}
		return rs[0]
	}
	day := func(d int) time.Time { return time.Date(2026, 10, 29+d, 9, 0, 5, 0, loc) }
	if run := tick(day(0)); run.Status != schedule.RunOK || run.Text != "示例动作「每天记一笔」：早上好" || demo.Actions.Load() != 1 {
		t.Fatalf("到点执行：%+v，次数 %d", run, demo.Actions.Load())
	}

	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if run := tick(day(1)); run.Status != schedule.RunFailed || run.Text != "没执行：提供这个动作的插件没启用：示例插件（demo）" || demo.Actions.Load() != 1 {
		t.Fatalf("停用时：%+v", run)
	}
	if got, err := ss.Get(ctx, sc.ID); err != nil || !got.Enabled || got.Action.Kind != plugintest.ScheduleActionKind {
		t.Fatalf("定义被动了：%+v %v", got, err)
	}

	if err := r.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if run := tick(day(2)); run.Status != schedule.RunOK || demo.Actions.Load() != 2 {
		t.Fatalf("启用后：%+v", run)
	}
	// 插件报错记失败
	text := "fail"
	act := schedule.Action{Kind: plugintest.ScheduleActionKind, Params: map[string]any{"text": text}}
	if _, err := ss.Update(ctx, sc.ID, schedule.Patch{Action: &act}); err != nil {
		t.Fatal(err)
	}
	if run, err := runner.RunNow(ctx, sc.ID); err != nil || run.Status != schedule.RunFailed || run.Text != "没执行：示例动作按要求失败" {
		t.Fatalf("插件报错：%+v %v", run, err)
	}
}

func TestScheduleActionChecksManifest(t *testing.T) {
	run := func(context.Context, plugin.Core, plugin.ScheduleActionInput) (*plugin.ScheduleActionResult, error) {
		return nil, nil
	}
	ok := func(kind string) plugin.ScheduleActionDef { return plugin.ScheduleActionDef{Kind: kind, Run: run} }
	noRun := ok("bad_a")
	noRun.Run = nil
	cases := []struct {
		name  string
		def   []plugin.ScheduleActionDef
		extra string
		want  string
	}{
		{"没声明", []plugin.ScheduleActionDef{ok("bad_other")}, "", "定时任务动作不在清单 provides.schedule_actions 里：bad_other"},
		{"前缀不对", []plugin.ScheduleActionDef{ok("other_x")}, "other_x", "定时任务动作 other_x 必须以 bad_ 开头"},
		{"没有 Run", []plugin.ScheduleActionDef{noRun}, "", "没有 Run"},
		{"重复", []plugin.ScheduleActionDef{ok("bad_a"), ok("bad_a")}, "", "定时任务动作重复：bad_a"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := manifest(t, "bad", `,"provides":{"schedule_actions":["bad_a"]}`)
			if tc.extra != "" {
				m.Provides.ScheduleActions = append(m.Provides.ScheduleActions, tc.extra)
			}
			p := &fakePlugin{m: m, reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.ScheduleAction(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
	if _, err := plugin.Parse([]byte(`{"id":"bad","name":"b","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{"schedule_actions":["video_publish"]},"permissions":[]}`)); err == nil ||
		!strings.Contains(err.Error(), "provides.schedule_actions[0] 必须以 bad_ 开头") {
		t.Fatalf("清单前缀：%v", err)
	}
}

// TestScheduleActionPanic：插件的 Validate、Run panic 时转成错误，不带垮调度器。
func TestScheduleActionPanic(t *testing.T) {
	ctx := context.Background()
	p := &fakePlugin{m: manifest(t, "boom", `,"provides":{"schedule_actions":["boom_x"]}`), reg: func(r plugin.Registrar) error {
		r.ScheduleAction(plugin.ScheduleActionDef{Kind: "boom_x",
			Validate: func(context.Context, plugin.Core, map[string]any) (map[string]any, error) { panic("v") },
			Run: func(context.Context, plugin.Core, plugin.ScheduleActionInput) (*plugin.ScheduleActionResult, error) {
				panic("r")
			}})
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "boom")
	if _, err := r.ValidateScheduleAction(ctx, "boom_x", nil); err == nil || err.Error() != "校验动作 boom_x 出错" {
		t.Fatalf("Validate panic：%v", err)
	}
	if _, err := r.RunScheduleAction(ctx, plugin.ScheduleActionInput{Kind: "boom_x"}); err == nil || err.Error() != "动作 boom_x 执行出错" {
		t.Fatalf("Run panic：%v", err)
	}
	if _, err := r.RunScheduleAction(ctx, plugin.ScheduleActionInput{Kind: "nobody_x"}); !errors.Is(err, plugin.ErrScheduleActionUnknown) {
		t.Fatalf("没人声明：%v", err)
	}
}
