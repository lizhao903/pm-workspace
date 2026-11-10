// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// sopProbe 是一个只为拿到 Core 的插件，清单里不提供任何东西。
func sopProbe(t *testing.T, id string, got *atomic.Value) *fakePlugin {
	return &fakePlugin{m: manifest(t, id, ""), reg: func(r plugin.Registrar) error {
		got.Store(r.Core())
		return nil
	}}
}

// TestSOPNodesFollowEnabledState：示例插件登记的节点只在它在跑时出现，Source 是插件 id；停用后执行回 ErrNodeUnavailable。
func TestSOPNodesFollowEnabledState(t *testing.T) {
	ctx := context.Background()
	var cv atomic.Value
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo, sopProbe(t, "probe", &cv))
	c := cv.Load().(plugin.Core)
	if got := c.SOP().Nodes(); len(got) != 0 {
		t.Fatalf("没装就有节点：%v", got)
	}
	if id, ok := c.SOP().Provider(plugintest.SOPNodeKind); !ok || id != "demo" {
		t.Fatalf("Provider = %q %v", id, ok)
	}
	installEnable(t, r, "demo")
	got := c.SOP().Nodes()
	if len(got) != 1 || got[0].Kind != plugintest.SOPNodeKind || got[0].Source != "demo" || got[0].Group != "示例" || len(got[0].Required) != 1 {
		t.Fatalf("启用后 nodes = %+v", got)
	}
	out, err := c.SOP().RunNode(ctx, plugintest.SOPNodeKind, plugin.SOPNodeInput{Config: map[string]string{"to": "甲"}, Input: map[string]any{"a": 1}})
	if err != nil || out["to"] != "甲" {
		t.Fatalf("RunNode = %v %v", out, err)
	}
	_, err = c.SOP().RunNode(ctx, plugintest.SOPNodeKind, plugin.SOPNodeInput{Config: map[string]string{"mode": "wait", "to": "甲"}})
	if !errors.Is(err, plugin.ErrWaiting) || !strings.Contains(err.Error(), "等 甲 回复") {
		t.Fatalf("挂起应当回 ErrWaiting：%v", err)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if got := c.SOP().Nodes(); len(got) != 0 {
		t.Fatalf("停用后还有节点：%v", got)
	}
	if _, err := c.SOP().RunNode(ctx, plugintest.SOPNodeKind, plugin.SOPNodeInput{}); !errors.Is(err, plugin.ErrNodeUnavailable) || err.Error() != "提供这个节点的插件已停用" {
		t.Fatalf("停用后执行：%v", err)
	}
	// 没装 SOP 插件时唤醒没人接
	if err := demo.Resume(ctx, "r1", "a", nil); !errors.Is(err, plugin.ErrNoSOPEngine) {
		t.Fatalf("Resume = %v", err)
	}
}

func TestSOPNodeChecksManifest(t *testing.T) {
	run := func(context.Context, plugin.Core, plugin.SOPNodeInput) (map[string]any, error) { return nil, nil }
	ok := func(kind string) plugin.SOPNodeDef { return plugin.SOPNodeDef{Kind: kind, Run: run} }
	noRun := ok("bad_a")
	noRun.Run = nil
	badField := ok("bad_a")
	badField.Required = []plugin.SOPNodeField{{Key: "to"}}
	cases := []struct {
		name  string
		def   []plugin.SOPNodeDef
		extra string // 硬塞进清单的项，绕过清单校验，模拟前缀不对
		want  string
	}{
		{"没声明", []plugin.SOPNodeDef{ok("bad_other")}, "", "不在清单 provides.sop_nodes 里：bad_other"},
		{"前缀不对", []plugin.SOPNodeDef{ok("other_x")}, "other_x", "SOP 节点 other_x 必须以 bad_ 开头"},
		{"没有 Run", []plugin.SOPNodeDef{noRun}, "", "没有 Run"},
		{"必填项缺 label", []plugin.SOPNodeDef{badField}, "", "要有 key 和 label"},
		{"重复", []plugin.SOPNodeDef{ok("bad_a"), ok("bad_a")}, "", "SOP 节点重复：bad_a"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := manifest(t, "bad", `,"provides":{"sop_nodes":["bad_a"]}`)
			if tc.extra != "" {
				m.Provides.SOPNodes = append(m.Provides.SOPNodes, tc.extra)
			}
			p := &fakePlugin{m: m, reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.SOPNode(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
}

// TestSOPNodeBadOnEnable：启动时登记得对、启用时登记不对，启用失败并写明原因。
func TestSOPNodeBadOnEnable(t *testing.T) {
	var calls atomic.Int64
	run := func(context.Context, plugin.Core, plugin.SOPNodeInput) (map[string]any, error) { return nil, nil }
	p := &fakePlugin{m: manifest(t, "flaky", `,"provides":{"sop_nodes":["flaky_a"]}`), reg: func(r plugin.Registrar) error {
		kind := "flaky_a"
		if calls.Add(1) > 1 {
			kind = "flaky_b"
		}
		r.SOPNode(plugin.SOPNodeDef{Kind: kind, Run: run})
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	ctx := context.Background()
	if err := r.Install(ctx, "flaky", nil); err != nil {
		t.Fatal(err)
	}
	err := r.Enable(ctx, "flaky")
	if err == nil || !strings.Contains(err.Error(), "SOP 节点不在清单 provides.sop_nodes 里：flaky_b") {
		t.Fatalf("启用应当失败并写明原因：%v", err)
	}
}

// TestSOPEngineOnlyFromSOP：别的插件不能登记 SOP 执行引擎。
func TestSOPEngineOnlyFromSOP(t *testing.T) {
	p := &fakePlugin{m: manifest(t, "imposter", ""), reg: func(r plugin.Registrar) error {
		r.SOPEngine(nopEngine{})
		return nil
	}}
	err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
	if err == nil || !strings.Contains(err.Error(), "只有 SOP 编排插件能登记执行引擎") {
		t.Fatalf("err = %v", err)
	}
}

type nopEngine struct{}

func (nopEngine) Resume(context.Context, string, string, string, map[string]any) error { return nil }
func (nopEngine) Fail(context.Context, string, string, string, string) error           { return nil }
