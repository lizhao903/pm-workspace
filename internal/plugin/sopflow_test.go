package plugin_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// flowEngine 是不支持内置流程的假 SOP 引擎，flowInstaller 在它上面加写入、撤下并记下请求。
type flowEngine struct {
	got []string
}

func (e *flowEngine) Resume(context.Context, string, string, string, map[string]any) error {
	return nil
}
func (e *flowEngine) Fail(context.Context, string, string, string, string) error { return nil }

type flowInstaller struct{ flowEngine }

func (e *flowInstaller) InstallFlow(_ context.Context, caller string, t plugin.SOPFlowTemplate) (bool, error) {
	e.got = append(e.got, "install "+caller+" "+t.ID)
	return true, nil
}

func (e *flowInstaller) RemoveFlow(_ context.Context, caller, id string) (bool, string, error) {
	e.got = append(e.got, "remove "+caller+" "+id)
	return true, "", nil
}

// TestSOPInstallFlow：内置流程只转给实现了 SOPFlowInstaller 的引擎，id 必须是 sop_<插件 id>_ 开头（VID-03d）。
func TestSOPInstallFlow(t *testing.T) {
	ctx := context.Background()
	var cv atomic.Value
	in := &flowInstaller{}
	sop := &fakePlugin{m: manifest(t, plugin.SOPPluginID, ""), reg: func(r plugin.Registrar) error {
		r.SOPEngine(in)
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), sop, sopProbe(t, "probe", &cv))
	c := cv.Load().(plugin.Core)
	if _, err := c.SOP().InstallFlow(ctx, plugin.SOPFlowTemplate{ID: "sop_probe_weekly"}); !errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		t.Fatalf("SOP 插件没启用：%v", err)
	}
	installEnable(t, r, plugin.SOPPluginID)
	for _, id := range []string{"sop_weekly", "sop_probe_", "sop_other_weekly", "sop_probe_X"} {
		if _, err := c.SOP().InstallFlow(ctx, plugin.SOPFlowTemplate{ID: id}); err == nil || !strings.Contains(err.Error(), "sop_probe_ 开头") {
			t.Fatalf("id %s 应当拒绝：%v", id, err)
		}
		if _, _, err := c.SOP().RemoveFlow(ctx, id); err == nil {
			t.Fatalf("撤下 %s 应当拒绝", id)
		}
	}
	if ok, err := c.SOP().InstallFlow(ctx, plugin.SOPFlowTemplate{ID: "sop_probe_weekly"}); !ok || err != nil {
		t.Fatalf("写入：%v %v", ok, err)
	}
	if ok, _, err := c.SOP().RemoveFlow(ctx, "sop_probe_weekly"); !ok || err != nil {
		t.Fatalf("撤下：%v %v", ok, err)
	}
	if strings.Join(in.got, "；") != "install probe sop_probe_weekly；remove probe sop_probe_weekly" {
		t.Fatalf("转给引擎的：%v", in.got)
	}
}

// TestSOPInstallFlowUnsupported：引擎没实现 SOPFlowInstaller 时回 ErrNoSOPFlowInstaller。
func TestSOPInstallFlowUnsupported(t *testing.T) {
	var cv atomic.Value
	sop := &fakePlugin{m: manifest(t, plugin.SOPPluginID, ""), reg: func(r plugin.Registrar) error {
		r.SOPEngine(&flowEngine{})
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), sop, sopProbe(t, "probe", &cv))
	installEnable(t, r, plugin.SOPPluginID)
	c := cv.Load().(plugin.Core)
	if _, err := c.SOP().InstallFlow(context.Background(), plugin.SOPFlowTemplate{ID: "sop_probe_weekly"}); !errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		t.Fatalf("不支持时：%v", err)
	}
}
