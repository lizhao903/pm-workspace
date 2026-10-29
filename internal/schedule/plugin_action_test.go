package schedule_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// fakeActions 只认 demo_note：参数 text 必填；off 为 true 时当插件停用，runErr 非空时执行回它。
type fakeActions struct {
	off    bool
	runErr error
	got    []schedule.PluginActionRequest
}

func (f *fakeActions) ValidateScheduleAction(_ context.Context, kind string, params map[string]any) (map[string]any, error) {
	if kind != "demo_note" {
		return nil, fmt.Errorf("%w：%s", schedule.ErrActionUnknown, kind)
	}
	if f.off {
		return nil, fmt.Errorf("%w：示例插件（demo）", schedule.ErrActionUnavailable)
	}
	text, _ := params["text"].(string)
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("text 必填")
	}
	params["text"] = strings.TrimSpace(text)
	return params, nil
}

func (f *fakeActions) RunScheduleAction(_ context.Context, q schedule.PluginActionRequest) (*schedule.PluginActionResult, error) {
	if q.Kind != "demo_note" {
		return nil, fmt.Errorf("%w：%s", schedule.ErrActionUnknown, q.Kind)
	}
	if f.off {
		return nil, fmt.Errorf("%w：示例插件（demo）", schedule.ErrActionUnavailable)
	}
	f.got = append(f.got, q)
	if f.runErr != nil {
		return nil, f.runErr
	}
	return &schedule.PluginActionResult{Text: "记了一条：" + q.Params["text"].(string), ObjectID: "obj_1", Ref: "N-1"}, nil
}

func noteInput(text string) schedule.Input {
	return schedule.Input{Name: "每天记一笔", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: "demo_note", Params: map[string]any{"text": text}}}
}

// 插件动作的参数和 kind 平铺；内核三种动作照旧只输出自己的字段。
func TestPluginActionJSON(t *testing.T) {
	var a schedule.Action
	if err := json.Unmarshal([]byte(`{"kind":"demo_note","text":"你好","n":2,"title":"不是任务"}`), &a); err != nil {
		t.Fatal(err)
	}
	if a.Kind != "demo_note" || a.Title != "" || a.Params["text"] != "你好" || a.Params["title"] != "不是任务" || a.Params["kind"] != nil {
		t.Fatalf("解析 = %+v", a)
	}
	b, err := json.Marshal(a)
	if err != nil || string(b) != `{"kind":"demo_note","n":2,"text":"你好","title":"不是任务"}` {
		t.Fatalf("输出 = %s %v", b, err)
	}
	var task schedule.Action
	if err := json.Unmarshal([]byte(`{"kind":"task","title":"周报","due_days":2,"extra":1}`), &task); err != nil {
		t.Fatal(err)
	}
	if task.Title != "周报" || task.DueDays != 2 || task.Params != nil {
		t.Fatalf("task = %+v", task)
	}
}

// 保存时交给插件校验：插件改过的参数存下来；没人认、插件停用、参数不对都回 400。
func TestPluginActionValidate(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// 没接插件时和以前一样只认三种
	if _, err := f.ss.Create(ctx, noteInput("x")); !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), "action.kind must be task / sop / agent") {
		t.Fatalf("没接插件：%v", err)
	}
	acts := &fakeActions{}
	f.ss.SetPluginActions(acts)
	sc := f.create(t, noteInput("  早上好  "))
	if sc.Action.Kind != "demo_note" || sc.Action.Params["text"] != "早上好" {
		t.Fatalf("存的动作 = %+v", sc.Action)
	}
	got, err := f.ss.Get(ctx, sc.ID)
	if err != nil || got.Action.Params["text"] != "早上好" {
		t.Fatalf("读回 = %+v %v", got, err)
	}
	cases := []struct {
		in   schedule.Input
		want string
	}{
		{noteInput(" "), "action: text 必填"},
		{schedule.Input{Name: "x", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"}, Action: schedule.Action{Kind: "ghost_x"}},
			`action.kind must be task / sop / agent or a plugin action, got "ghost_x"`},
		{schedule.Input{Name: "x", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"}, Action: schedule.Action{Kind: ""}},
			"action.kind must be task / sop / agent"},
	}
	for _, tc := range cases {
		if _, err := f.ss.Create(ctx, tc.in); !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%+v：%v，要包含 %q", tc.in.Action, err, tc.want)
		}
	}
	// 插件停用时不能新建、不能改动作，只改名字照常
	acts.off = true
	if _, err := f.ss.Create(ctx, noteInput("x")); !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), "提供这个动作的插件没启用：示例插件（demo）") {
		t.Fatalf("停用时新建：%v", err)
	}
	name := "改个名"
	if _, err := f.ss.Update(ctx, sc.ID, schedule.Patch{Name: &name}); err != nil {
		t.Fatalf("停用时改名：%v", err)
	}
	act := schedule.Action{Kind: "demo_note", Params: map[string]any{"text": "y"}}
	if _, err := f.ss.Update(ctx, sc.ID, schedule.Patch{Action: &act}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("停用时改动作：%v", err)
	}
}

// 到点交给插件执行并记执行记录；插件停用记 failed 写明原因，启用后下次照常；插件报错记 failed。
func TestRunnerPluginAction(t *testing.T) {
	f := newFixture(t)
	acts := &fakeActions{}
	f.ss.SetPluginActions(acts)
	sc := f.create(t, noteInput("早上好"))

	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || rs[0].Text != "记了一条：早上好" || rs[0].Ref == nil || *rs[0].Ref != "N-1" {
		t.Fatalf("到点应执行：%+v", rs)
	}
	if len(acts.got) != 1 {
		t.Fatalf("应执行一次：%+v", acts.got)
	}
	q := acts.got[0]
	if q.ScheduleID != sc.ID || q.ScheduleName != "每天记一笔" || q.RunID != rs[0].ID || !q.At.Equal(f.at(9, 0, 0)) || q.Manual || q.Params["text"] != "早上好" {
		t.Fatalf("请求 = %+v", q)
	}
	f.tick(t)
	if len(acts.got) != 1 {
		t.Fatalf("同一时刻重复执行了：%d", len(acts.got))
	}

	// 第二天插件停用：记失败、写明原因，定义不动
	acts.off = true
	f.clk.add(24 * time.Hour)
	f.tick(t)
	rs = f.runs(t, sc.ID)
	if rs[0].Status != schedule.RunFailed || rs[0].Text != "没执行：提供这个动作的插件没启用：示例插件（demo）" {
		t.Fatalf("停用时：%+v", rs[0])
	}
	if got, err := f.ss.Get(context.Background(), sc.ID); err != nil || !got.Enabled || got.Action.Params["text"] != "早上好" {
		t.Fatalf("定义被动了：%+v %v", got, err)
	}
	// 第三天启用回来：照常
	acts.off = false
	f.clk.add(24 * time.Hour)
	f.tick(t)
	if rs = f.runs(t, sc.ID); rs[0].Status != schedule.RunOK || len(rs) != 3 {
		t.Fatalf("启用后：%+v", rs)
	}

	// 手动执行带 manual；插件报错记失败
	acts.runErr = errors.New("平台没登录")
	run, err := f.r.RunNow(context.Background(), sc.ID)
	if err != nil || run.Status != schedule.RunFailed || run.Text != "没执行：平台没登录" || !acts.got[len(acts.got)-1].Manual {
		t.Fatalf("手动：%+v %v", run, err)
	}
}
