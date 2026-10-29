package schedule_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// fakeSOPs 记下收到的请求，err 非空时回它。
type fakeSOPs struct {
	got []schedule.SOPRequest
	err error
}

func (s *fakeSOPs) StartSOP(_ context.Context, q schedule.SOPRequest) (*schedule.SOPStarted, error) {
	s.got = append(s.got, q)
	if s.err != nil {
		return nil, s.err
	}
	return &schedule.SOPStarted{RunID: "spr_1", FlowID: q.FlowID, FlowName: "周会纪要", Status: "waiting"}, nil
}

// 动作 sop（SOP-01d）：到点经钩子起一条运行，执行记录写运行 id；插件没启用记 unsupported。
func TestRunnerSOPAction(t *testing.T) {
	f := newFixture(t)
	sops := &fakeSOPs{}
	f.r.SOPs = sops
	sc := f.create(t, schedule.Input{Name: "周会", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionSOP, SOPID: "sop_weekly"}})

	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || rs[0].Text != "发起了 SOP「周会纪要」，执行记录 spr_1" {
		t.Fatalf("到点应发起 SOP：%+v", rs)
	}
	if len(sops.got) != 1 {
		t.Fatalf("应发起一次：%+v", sops.got)
	}
	q := sops.got[0]
	if q.FlowID != "sop_weekly" || q.Source != "schedule" || q.SourceID != sc.ID || q.SourceName != "周会" || q.Input == nil {
		t.Fatalf("请求 = %+v", q)
	}
	f.tick(t)
	if len(sops.got) != 1 {
		t.Fatalf("同一时刻重复发起了：%d", len(sops.got))
	}

	ctx := context.Background()
	// 插件停用：记 unsupported 并写明原因
	sops.err = schedule.ErrSOPUnavailable
	run, err := f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunUnsupported || run.Text != "没执行：SOP 编排插件没启用" {
		t.Fatalf("停用：%+v，%v", run, err)
	}
	// 流程删了之类：记失败
	sops.err = errors.New("流程 sop_weekly 不存在")
	run, err = f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunFailed || run.Text != "没执行：流程 sop_weekly 不存在" {
		t.Fatalf("失败：%+v，%v", run, err)
	}
	// 没接钩子：同样是 unsupported
	f.r.SOPs = nil
	run, err = f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunUnsupported || run.Text != "没执行：SOP 编排插件没启用" {
		t.Fatalf("没接：%+v，%v", run, err)
	}
}

func TestSOPRefs(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	off := false
	a := f.create(t, schedule.Input{Name: "甲", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionSOP, SOPID: "sop_a"}})
	b := f.create(t, schedule.Input{Name: "乙", Enabled: &off, Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "10:00"},
		Action: schedule.Action{Kind: schedule.ActionSOP, SOPID: "sop_a"}})
	f.create(t, schedule.Input{Name: "丙", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionSOP, SOPID: "sop_b"}})
	f.create(t, dailyTask("建任务"))

	refs, err := f.ss.SOPRefs(ctx, "sop_a")
	if err != nil || len(refs) != 2 || refs[0].ID != b.ID || refs[0].Name != "乙" || refs[1].ID != a.ID {
		t.Fatalf("SOPRefs = %+v，%v", refs, err)
	}
	if refs, err := f.ss.SOPRefs(ctx, "sop_none"); err != nil || refs == nil || len(refs) != 0 {
		t.Fatalf("没有时应为空切片：%+v，%v", refs, err)
	}
}
