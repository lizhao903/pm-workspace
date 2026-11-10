// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0491：Agent 的 test_sop、explain_im_trigger 是只读工具，归「查 SOP 流程」；建完流程的结果提示先调试。

type fakeDebugCatalog struct {
	fakeCatalog
	tests    []schedule.SOPTest
	explains []string
}

func (f *fakeDebugCatalog) TestSOP(_ context.Context, q schedule.SOPTest) (string, error) {
	f.tests = append(f.tests, q)
	return "调试「周会」：「标记为忽略」将把消息 msg_1 标为「忽略」（没真做）", nil
}

func (f *fakeDebugCatalog) ExplainIMTrigger(_ context.Context, id string) (string, error) {
	f.explains = append(f.explains, id)
	return "模拟消息 " + id + " 触发 IM 流程：会发起「周会」", nil
}

func TestSOPDebugTools(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){
		grantCall(toolCreateSOP, `{"name":"群消息忽略","steps":[{"key":"a","kind":"im_mark_message","config":{"state":"ignore"}}]}`),
		grantCall(toolTestSOP, `{"flow_id":"sop_new","message_id":"msg_1","skip_models":true}`),
		grantCall(toolExplainIM, `{"message_id":"msg_1"}`),
		grantSay("建好了，调试结论：会把消息标为忽略。"),
	}}
	cat := &fakeDebugCatalog{fakeCatalog: fakeCatalog{flows: []schedule.SOPFlowBrief{{ID: "sop_weekly", Name: "周会", Trigger: "manual", Steps: 3, Version: 2}}}}
	useSOPStarter(t, cat)
	r, _, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "SOP 编排助手"}
	r.Policy = &Policy{Grants: map[string]string{ReadSOPAbility: store.GrantAuto, WriteSOPAbility: store.GrantAuto}}
	if _, err := r.Run(ctx, "建一个流程", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	names := grantToolNames(chat.reqs[0].Tools)
	for _, n := range []string{toolTestSOP, toolExplainIM} {
		if !slices.Contains(names, n) {
			t.Errorf("开了 read_sop 应当给模型 %s：%v", n, names)
		}
	}
	if ToolAbility[toolTestSOP] != ReadSOPAbility || ToolAbility[toolExplainIM] != ReadSOPAbility {
		t.Fatal("两个调试工具归 read_sop")
	}
	if got := lastToolContent(chat.reqs[1]); !strings.Contains(got, "test_sop（flow_id=sop_new）") {
		t.Errorf("建完的结果要提示先调试：%q", got)
	}
	if len(cat.tests) != 1 || cat.tests[0].FlowID != "sop_new" || cat.tests[0].MessageID != "msg_1" || !cat.tests[0].SkipModels {
		t.Fatalf("test_sop 参数：%+v", cat.tests)
	}
	if got := lastToolContent(chat.reqs[2]); !strings.Contains(got, "没真做") {
		t.Errorf("test_sop 结果原样给模型：%q", got)
	}
	if len(cat.explains) != 1 || cat.explains[0] != "msg_1" {
		t.Fatalf("explain_im_trigger 参数：%v", cat.explains)
	}
}

// 只开 read_sop 不开 write_sop：调试工具照给（只读），建改不给。
func TestSOPDebugToolsReadOnly(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){grantSay("好")}}
	cat := &fakeDebugCatalog{}
	useSOPStarter(t, cat)
	r, _, ctx := newRunner(t, chat)
	r.Agent = &domain.Agent{ID: "ag_sop", Name: "SOP 编排助手"}
	r.Policy = &Policy{Grants: map[string]string{ReadSOPAbility: store.GrantAuto}}
	if _, err := r.Run(ctx, "看看", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	names := grantToolNames(chat.reqs[0].Tools)
	if !slices.Contains(names, toolTestSOP) || slices.Contains(names, toolCreateSOP) {
		t.Fatalf("只读授权：%v", names)
	}
}
