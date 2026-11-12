// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0500：发起执行时负责人设为执行者在名册里的 AI 成员，原来是人的覆盖并记进展；
// 已经是它的不重复记；已完成、已取消的不动。
func TestMarkDoingSetsRunOwner(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	allTaskStatuses(f)
	ctx := t.Context()
	req := httptest.NewRequest("POST", "/", nil)

	zhang, err := f.CreateStakeholder(ctx, &domain.Stakeholder{Name: "张三"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.UpdateObject(ctx, task.ID, domain.ObjectPatch{OwnerID: &zhang.ID}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	o, _ := f.GetObject(ctx, task.ID)
	s.markDoing(ctx, req, o, cliExecutor(domain.RunHarnessDeepSeek))
	o, _ = f.GetObject(ctx, task.ID)
	if o.Status != "doing" || o.OwnerName != "DeepSeek" || o.OwnerAIKind != domain.AIKindCLI || o.OwnerAIRef != "deepseek" {
		t.Fatalf("应改成进行中、负责人 DeepSeek，得到 %s / %s / %s", o.Status, o.OwnerName, o.OwnerAIKind)
	}
	notes, _ := f.ListProgress(ctx, task.ID, 10)
	if len(notes) != 1 || notes[0].Text != "负责人由「张三」改为「DeepSeek」（交给 DeepSeek 执行）" {
		t.Fatalf("进展没记覆盖：%d %q", len(notes), notes[0].Text)
	}

	// 同一个执行者再交一次：不重复记
	s.markDoing(ctx, req, o, cliExecutor(domain.RunHarnessDeepSeek))
	if notes, _ = f.ListProgress(ctx, task.ID, 10); len(notes) != 1 {
		t.Fatalf("负责人没变不该再记：%d 条", len(notes))
	}

	// 交给工作台 Agent
	name := "平台助手"
	ag, _ := f.CreateAgent(ctx, domain.AgentInput{Name: &name})
	o, _ = f.GetObject(ctx, task.ID)
	s.markDoing(ctx, req, o, agentExecutor(ag))
	o, _ = f.GetObject(ctx, task.ID)
	if o.OwnerName != "平台助手" || o.OwnerAIKind != domain.AIKindAgent || o.OwnerAIRef != ag.ID {
		t.Fatalf("负责人应是 Agent，得到 %s / %s", o.OwnerName, o.OwnerAIKind)
	}
	if notes, _ = f.ListProgress(ctx, task.ID, 10); !strings.Contains(notes[0].Text, "改为「平台助手」（交给 平台助手 执行）") {
		t.Fatalf("进展：%q", notes[0].Text)
	}

	// 已完成的不动负责人
	done := "done"
	if _, err := f.UpdateObject(ctx, task.ID, domain.ObjectPatch{Status: &done}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	o, _ = f.GetObject(ctx, task.ID)
	s.markDoing(ctx, req, o, cliExecutor(domain.RunHarnessClaude))
	if o, _ = f.GetObject(ctx, task.ID); o.OwnerName != "平台助手" || o.Status != "done" {
		t.Fatalf("已完成的不该动：%s / %s", o.Status, o.OwnerName)
	}
}

// Agent 改名、删除时名册跟着走（经 HTTP，和设置页同一条路）。
func TestAgentCRUDSyncsAIMembers(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)
	ctx := t.Context()
	name := "研发助手"
	ag, _ := f.CreateAgent(ctx, domain.AgentInput{Name: &name})
	if w := do(s, "PATCH", "/api/agents/"+ag.ID, `{"name":"测试助手"}`); w.Code != 200 {
		t.Fatalf("PATCH %d %s", w.Code, w.Body)
	}
	m, err := f.GetAIMember(ctx, domain.AIKindAgent, ag.ID)
	if err != nil || m.Name != "测试助手" {
		t.Fatalf("改名没同步：%v %+v", err, m)
	}
	if _, err := f.GetAIMember(ctx, domain.AIKindCLI, domain.RunHarnessClaude); err != nil {
		t.Fatalf("CLI 成员应一起建：%v", err)
	}
	if w := do(s, "DELETE", "/api/agents/"+ag.ID, ""); w.Code != 200 {
		t.Fatalf("DELETE %d %s", w.Code, w.Body)
	}
	if m, _ = f.GetAIMember(ctx, domain.AIKindAgent, ag.ID); m.ArchivedAt == nil {
		t.Fatal("删掉 Agent 后应归档")
	}
}
