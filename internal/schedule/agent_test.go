// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// fakeAgents 记下收到的请求；fail 非空时回错误，broken 时回「没跑起来」。
type fakeAgents struct {
	got    []schedule.AgentRequest
	fail   string
	broken bool
}

func (a *fakeAgents) StartAgent(_ context.Context, q schedule.AgentRequest) (*schedule.AgentStarted, error) {
	a.got = append(a.got, q)
	if a.fail != "" {
		return nil, errors.New(a.fail)
	}
	return &schedule.AgentStarted{RunID: "ar_1", AgentName: "周报助手", Failed: a.broken, Reason: "服务商不存在"}, nil
}

// 动作 agent（AG-01b4）：接了 Agents 后到点交给它，执行记录指到 Agent 执行记录，不再是 unsupported。
func TestRunnerAgentAction(t *testing.T) {
	f := newFixture(t)
	agents := &fakeAgents{}
	f.r.Agents = agents
	sc := f.create(t, schedule.Input{Name: "写周报", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionAgent, AgentID: "ag_x", Prompt: "写本周周报"}})

	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || !strings.Contains(rs[0].Text, "ar_1") || !strings.Contains(rs[0].Text, "周报助手") {
		t.Fatalf("到点应交给 Agent：%+v", rs)
	}
	if len(agents.got) != 1 {
		t.Fatalf("应发起一次：%+v", agents.got)
	}
	q := agents.got[0]
	if q.AgentID != "ag_x" || q.ScheduleID != sc.ID || q.ScheduleName != "写周报" || q.Prompt != "写本周周报" || q.RunID != rs[0].ID {
		t.Fatalf("请求 = %+v", q)
	}
	// 同一时刻再看一遍不重复发起
	f.tick(t)
	if len(agents.got) != 1 {
		t.Fatalf("重复发起了：%d", len(agents.got))
	}

	// Agent 停用之类回错误：记失败
	agents.fail = "Agent「周报助手」已停用"
	run, err := f.r.RunNow(context.Background(), sc.ID)
	if err != nil || run.Status != schedule.RunFailed || run.Text != "没执行：Agent「周报助手」已停用" {
		t.Fatalf("停用：%+v，%v", run, err)
	}
	// 建了执行记录但没跑起来：记失败，文字带原因和记录 id
	agents.fail, agents.broken = "", true
	run, err = f.r.RunNow(context.Background(), sc.ID)
	if err != nil || run.Status != schedule.RunFailed || !strings.Contains(run.Text, "服务商不存在") || !strings.Contains(run.Text, "ar_1") {
		t.Fatalf("没跑起来：%+v，%v", run, err)
	}
}
