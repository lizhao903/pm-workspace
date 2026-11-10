// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func TestAgentRunsDedupeAndList(t *testing.T) {
	s, ctx := newStore(t)
	mk := func(agentID, key string) *store.AgentRun {
		t.Helper()
		r, err := s.CreateAgentRun(ctx, &store.AgentRun{AgentID: agentID, TriggerKind: "im", Trigger: "收到 slack 消息", EventKey: key})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	a := mk("ag_1", "im:m1")
	if a == nil || a.Status != store.AgentRunRunning || a.FinishedAt != nil || !strings.HasPrefix(a.ID, "ar_") {
		t.Fatalf("新建 = %+v", a)
	}
	// 同一 Agent 同一事件键不插；别的 Agent、空键照插
	if r := mk("ag_1", "im:m1"); r != nil {
		t.Fatalf("重复的键插进去了：%+v", r)
	}
	if mk("ag_2", "im:m1") == nil || mk("ag_1", "") == nil || mk("ag_1", "") == nil {
		t.Fatal("不同 Agent 或空键应能插")
	}

	b := mk("ag_1", "im:m2")
	if _, err := s.FinishAgentRun(ctx, a.ID, store.AgentRunDone, "处理完了"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishAgentRun(ctx, b.ID, store.AgentRunWaiting, "等你确认"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishAgentRun(ctx, b.ID, "bogus", ""); err == nil {
		t.Fatal("不认识的状态应报错")
	}
	sid := "ss_x"
	if _, err := s.CreateAgentToolCall(ctx, &store.AgentToolCall{AgentID: "ag_1", SessionID: &sid, RunID: &b.ID, Tool: "create_object", GrantKey: "write_tasks"}); err != nil {
		t.Fatal(err)
	}

	all, total, err := s.ListAgentRuns(ctx, store.AgentRunFilter{AgentID: "ag_1"})
	if err != nil || total != 4 || len(all) != 4 || all[0].ID != b.ID || all[0].Pending != 1 {
		t.Fatalf("列表 = %d %d，%v，第一条 %+v", total, len(all), err, all[0])
	}
	done, total, _ := s.ListAgentRuns(ctx, store.AgentRunFilter{Statuses: []string{store.AgentRunDone}})
	if total != 1 || done[0].ID != a.ID || done[0].Summary != "处理完了" || done[0].FinishedAt == nil {
		t.Fatalf("按状态 = %+v", done)
	}
	future := time.Now().Add(time.Hour)
	if _, total, _ := s.ListAgentRuns(ctx, store.AgentRunFilter{Since: &future}); total != 0 {
		t.Fatalf("按时间：%d", total)
	}
	page, total, _ := s.ListAgentRuns(ctx, store.AgentRunFilter{Limit: 2, Offset: 1})
	if total != 5 || len(page) != 2 {
		t.Fatalf("分页 = %d %d", total, len(page))
	}
	calls, err := s.ListRunToolCalls(ctx, b.ID)
	if err != nil || len(calls) != 1 || *calls[0].RunID != b.ID {
		t.Fatalf("调用 = %+v，%v", calls, err)
	}
	if _, err := s.GetAgentRun(ctx, "ar_none"); err == nil {
		t.Fatal("不存在应报错")
	}
	if n, err := s.FailInterruptedAgentRuns(ctx, "服务退出"); err != nil || n != 3 {
		t.Fatalf("记失败 %d，%v", n, err)
	}
}

func TestAgentTriggerMatch(t *testing.T) {
	s, ctx := newStore(t)
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	ts := []domain.AgentTrigger{
		{Kind: domain.TriggerTask, Match: &domain.TriggerMatch{Assigned: true, Tags: []string{" Agent ", "Agent", ""}, Channel: "slack"}},
		{Kind: domain.TriggerIM, Match: &domain.TriggerMatch{Channel: " slack ", OnlyMe: true, Tags: []string{"x"}}},
		{Kind: domain.TriggerSchedule, Match: &domain.TriggerMatch{Assigned: true}},
		{Kind: domain.TriggerTask},
	}
	a, err := s.CreateAgent(ctx, domain.AgentInput{Name: sp("分诊"), ProviderID: &p.ID, Triggers: &ts})
	if err != nil {
		t.Fatal(err)
	}
	got := a.Triggers
	if m := got[0].Match; m == nil || !m.Assigned || !slices.Equal(m.Tags, []string{"Agent"}) || m.Channel != "" {
		t.Fatalf("task 条件 = %+v", m)
	}
	if m := got[1].Match; m == nil || m.Channel != "slack" || !m.OnlyMe || len(m.Tags) != 0 {
		t.Fatalf("im 条件 = %+v", m)
	}
	if got[2].Match != nil || got[3].Match != nil {
		t.Fatalf("schedule 不该有条件、没给的保持 nil：%+v %+v", got[2].Match, got[3].Match)
	}
	bad := []domain.AgentTrigger{{Kind: domain.TriggerTask, Match: &domain.TriggerMatch{}}}
	if _, err := s.UpdateAgent(ctx, a.ID, domain.AgentInput{Triggers: &bad}); err == nil || !strings.Contains(err.Error(), "分配给它") {
		t.Fatalf("空的任务条件应报错：%v", err)
	}
}
