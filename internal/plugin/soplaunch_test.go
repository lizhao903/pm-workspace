package plugin_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

type fakeStarter struct{ id string }

func (s fakeStarter) StartSOP(_ context.Context, q plugin.SOPStartRequest) (*plugin.SOPStarted, error) {
	if q.FlowID == "boom" {
		panic("boom")
	}
	return &plugin.SOPStarted{RunID: "spr_" + s.id, FlowID: q.FlowID, FlowName: "周会", Status: "running"}, nil
}

func starterPlugin(t *testing.T, id, extra string) *fakePlugin {
	return &fakePlugin{m: manifest(t, id, extra), reg: func(r plugin.Registrar) error {
		r.SOPStarter(fakeStarter{id})
		return nil
	}}
}

// TestSOPStarterHook：没登记时 ErrNoSOPStarter；启用后经注册表发起，panic 转成错误；停用后又回 ErrNoSOPStarter。
func TestSOPStarterHook(t *testing.T) {
	ctx := context.Background()
	r := newRegistry(t, plugin.NewMemStateStore(), starterPlugin(t, "flow", `,"provides":{"modules":["sop"]}`))
	if _, err := r.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "sop_a"}); !errors.Is(err, plugin.ErrNoSOPStarter) || err.Error() != "SOP 编排插件没启用" {
		t.Fatalf("没启用：%v", err)
	}
	installEnable(t, r, "flow")
	got, err := r.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "sop_a", Source: "schedule"})
	if err != nil || got.RunID != "spr_flow" || got.FlowID != "sop_a" {
		t.Fatalf("启用后：%+v %v", got, err)
	}
	if _, err := r.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "boom"}); err == nil || err.Error() != "发起 SOP 出错" {
		t.Fatalf("panic 应转成错误：%v", err)
	}
	if err := r.Disable(ctx, "flow"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "sop_a"}); !errors.Is(err, plugin.ErrNoSOPStarter) {
		t.Fatalf("停用后：%v", err)
	}
}

// TestSOPStarterOnlyFromSOPModule：清单 provides.modules 不含 sop 的插件不能登记。
func TestSOPStarterOnlyFromSOPModule(t *testing.T) {
	err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(starterPlugin(t, "imposter", ""))
	if err == nil || !strings.Contains(err.Error(), "只有 provides.modules 含 sop 的插件能登记发起 SOP 的入口") {
		t.Fatalf("err = %v", err)
	}
}

// TestSOPStarterOnlyOne：两个插件都声明了 sop 模块，同一时间只有先启用的那个能登记，另一个启用失败。
func TestSOPStarterOnlyOne(t *testing.T) {
	ctx := context.Background()
	r := newRegistry(t, plugin.NewMemStateStore(),
		starterPlugin(t, "one", `,"provides":{"modules":["sop"]}`), starterPlugin(t, "two", `,"provides":{"modules":["sop"]}`))
	installEnable(t, r, "one")
	if err := r.Install(ctx, "two", nil); err != nil {
		t.Fatal(err)
	}
	err := r.Enable(ctx, "two")
	if err == nil || !strings.Contains(err.Error(), "发起 SOP 的入口已由插件 one 登记") {
		t.Fatalf("第二个应启用失败：%v", err)
	}
	// 先停掉 one，two 就能启用
	if err := r.Disable(ctx, "one"); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "two"); err != nil {
		t.Fatal(err)
	}
	if got, err := r.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "x"}); err != nil || got.RunID != "spr_two" {
		t.Fatalf("%+v %v", got, err)
	}
}

// TestSOPSchedulesHandle：没接定时任务时是空切片；接上后按流程 id 查。
func TestSOPSchedulesHandle(t *testing.T) {
	ctx := context.Background()
	var cv atomic.Value
	r := newRegistry(t, plugin.NewMemStateStore(), sopProbe(t, "probe", &cv))
	c := cv.Load().(plugin.Core)
	if got, err := c.SOP().Schedules(ctx, "sop_a"); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("没接：%v %v", got, err)
	}
	r.SetSOPRefs(func(_ context.Context, id string) ([]plugin.SOPScheduleRef, error) {
		return []plugin.SOPScheduleRef{{ID: "sch_1", Name: "周会 " + id}}, nil
	})
	if got, err := c.SOP().Schedules(ctx, "sop_a"); err != nil || len(got) != 1 || got[0].Name != "周会 sop_a" {
		t.Fatalf("接上后：%v %v", got, err)
	}
}
