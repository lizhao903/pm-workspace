// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内核钩子发起（SOP-01d）：按 id 或名称找流程、补默认值，人工检查点照常停下；必填空着、流程不存在回给人看的错误；
// 停用后回 ErrNoSOPStarter。
func TestStartSOPViaRegistry(t *testing.T) {
	ctx := context.Background()
	reg, h := setup(t, New())
	id := newFlow(t, h, `{"name":"周会","fields":[{"key":"topic","label":"议题","type":"text","default":"例会"}],"steps":[
		{"key":"draft","name":"起草","kind":"template","after":[],"config":{"template":"{{topic}}","output":"text"}},
		{"key":"check","name":"检查","kind":"review"}]}`)

	got, err := reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: id, Source: "schedule", SourceID: "sch_1"})
	if err != nil || got.FlowID != id || got.FlowName != "周会" || !strings.HasPrefix(got.RunID, "spr") {
		t.Fatalf("发起：%+v %v", got, err)
	}
	run := waitStatus(t, h, got.RunID, "waiting")
	if run["input"].(map[string]any)["topic"] != "例会" || run["step_through"] != false || step(run, "check")["status"] != "review" {
		t.Fatalf("应补默认值、停在人工检查：%v", run)
	}
	// 也认流程名，带输入
	got, err = reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "周会", Input: map[string]any{"topic": "复盘"}, Source: "agent"})
	if err != nil {
		t.Fatal(err)
	}
	if run := waitStatus(t, h, got.RunID, "waiting"); step(run, "check")["output"].(map[string]any)["text"] != "复盘" {
		t.Fatalf("输入没用上：%v", step(run, "check")["output"])
	}

	if _, err := reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: "sop_none"}); err == nil || err.Error() != "流程 sop_none 不存在" {
		t.Fatalf("不存在：%v", err)
	}
	req := newFlow(t, h, `{"name":"要客户","fields":[{"key":"customer","label":"客户","type":"text","required":true}],
		"steps":[{"key":"a","name":"甲","kind":"auto"}]}`)
	if _, err := reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: req}); err == nil || err.Error() != "「客户」必填" {
		t.Fatalf("必填：%v", err)
	}

	if err := reg.Disable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: id}); !errors.Is(err, plugin.ErrNoSOPStarter) {
		t.Fatalf("停用后：%v", err)
	}
}

// 删除被定时任务引用的流程：409，message 列出定时任务，error.schedules 带 {id, name}；和进行中的执行用「；」连。
func TestDeleteBlockedBySchedules(t *testing.T) {
	reg, h := setup(t, New())
	id := newFlow(t, h, `{"name":"周会","steps":[{"key":"check","name":"检查","kind":"review"}]}`)
	refs := map[string][]plugin.SOPScheduleRef{id: {{ID: "sch_1", Name: "周一例会"}, {ID: "sch_2", Name: "周五复盘"}}}
	reg.SetSOPRefs(func(_ context.Context, flowID string) ([]plugin.SOPScheduleRef, error) {
		if r := refs[flowID]; r != nil {
			return r, nil
		}
		return []plugin.SOPScheduleRef{}, nil
	})

	code, out := call(t, h, "DELETE", "/api/sop/flows/"+id, "")
	if code != 409 || errMsg(out) != "定时任务「周一例会」、「周五复盘」会发起它，先改掉或删掉这些定时任务" {
		t.Fatalf("应拦下：%d %s", code, errMsg(out))
	}
	sch := out["error"].(map[string]any)["schedules"].([]any)
	if len(sch) != 2 || sch[0].(map[string]any)["id"] != "sch_1" || sch[1].(map[string]any)["name"] != "周五复盘" {
		t.Fatalf("schedules = %v", sch)
	}

	rid := startRun(t, h, id, `{}`)["id"].(string)
	waitStatus(t, h, rid, "waiting")
	code, out = call(t, h, "DELETE", "/api/sop/flows/"+id, "")
	if code != 409 || errMsg(out) != "这个流程有 1 个进行中的执行，等它们结束或终止后再删；定时任务「周一例会」、「周五复盘」会发起它，先改掉或删掉这些定时任务" {
		t.Fatalf("两条一起：%d %s", code, errMsg(out))
	}

	// 只有进行中的执行时 schedules 是空数组
	refs[id] = nil
	code, out = call(t, h, "DELETE", "/api/sop/flows/"+id, "")
	if code != 409 || len(out["error"].(map[string]any)["schedules"].([]any)) != 0 {
		t.Fatalf("只有执行：%d %v", code, out)
	}
	if code, _ := act(t, h, rid, `{"kind":"stop"}`); code != 200 {
		t.Fatalf("终止 %d", code)
	}
	if code, out := call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 200 {
		t.Fatalf("都清掉后应能删：%d %s", code, errMsg(out))
	}
}
