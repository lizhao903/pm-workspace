// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0500：名册里的 AI 成员按 (kind, ref) 对齐；收编 pmw-mcp 自建的「Claude Code」，
// 和人撞名时加区分不抢名字，Agent 改名跟着改、删掉归档、负责人还显示得出来。
func TestSyncAIMembers(t *testing.T) {
	s, ctx := newStore(t)

	legacy, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "Claude Code", Role: "AI Agent"})
	if err != nil {
		t.Fatal(err)
	}
	human := mustStakeholder(t, s, ctx, "平台助手")

	want := []domain.AIMember{
		{Kind: domain.AIKindCLI, Ref: "claude", Name: "Claude Code"},
		{Kind: domain.AIKindCLI, Ref: "deepseek", Name: "DeepSeek"},
		{Kind: domain.AIKindAgent, Ref: "ag_1", Name: "平台助手"},
	}
	if err := s.SyncAIMembers(ctx, want); err != nil {
		t.Fatal(err)
	}
	cc, err := s.GetAIMember(ctx, domain.AIKindCLI, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if cc.ID != legacy.ID {
		t.Fatalf("应收编已有的 Claude Code（%s），得到 %s", legacy.ID, cc.ID)
	}
	ag, err := s.GetAIMember(ctx, domain.AIKindAgent, "ag_1")
	if err != nil {
		t.Fatal(err)
	}
	if ag.Name != "平台助手（Agent）" || ag.Group != AIMemberGroup {
		t.Fatalf("和人撞名应加区分并归到 AI 成员，得到 %q / %q", ag.Name, ag.Group)
	}
	if h, _ := s.GetStakeholder(ctx, human.ID); h.Name != "平台助手" || h.AIKind != "" {
		t.Fatalf("人的名字不能被动：%+v", h)
	}

	// 负责人是 AI 成员时对象带出类型和引用
	task, err := s.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "x", OwnerID: &ag.ID}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	if task.OwnerAIKind != domain.AIKindAgent || task.OwnerAIRef != "ag_1" {
		t.Fatalf("owner_ai_* 没带出：%q %q", task.OwnerAIKind, task.OwnerAIRef)
	}

	// Agent 改名跟着改；删掉归档，负责人保留
	want[2].Name = "研发助手"
	if err := s.SyncAIMembers(ctx, want); err != nil {
		t.Fatal(err)
	}
	if ag, _ = s.GetAIMember(ctx, domain.AIKindAgent, "ag_1"); ag.Name != "研发助手" {
		t.Fatalf("改名没跟上：%q", ag.Name)
	}
	if err := s.SyncAIMembers(ctx, want[:2]); err != nil {
		t.Fatal(err)
	}
	if ag, _ = s.GetAIMember(ctx, domain.AIKindAgent, "ag_1"); ag.ArchivedAt == nil {
		t.Fatal("Agent 删掉后应归档")
	}
	if o, _ := s.GetObject(ctx, task.ID); o.OwnerID == nil || *o.OwnerID != ag.ID || o.OwnerName != "研发助手" {
		t.Fatalf("归档后负责人应保留：%+v", o.OwnerID)
	}
	// CLI 不因为 want 里没有就归档
	if err := s.SyncAIMembers(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if cc, _ = s.GetAIMember(ctx, domain.AIKindCLI, "claude"); cc.ArchivedAt != nil {
		t.Fatal("CLI 成员不该被归档")
	}
	// 又出现了就复岗
	if err := s.SyncAIMembers(ctx, want); err != nil {
		t.Fatal(err)
	}
	if ag, _ = s.GetAIMember(ctx, domain.AIKindAgent, "ag_1"); ag.ArchivedAt != nil {
		t.Fatal("应复岗")
	}
	// 同步两次不多出行
	all, _ := s.ListStakeholders(ctx, true)
	if len(all) != 4 {
		t.Fatalf("名册应是 4 条（1 人 + 3 AI），得到 %v", namesOf(all))
	}
}

// AI 成员的名字、在岗状态由工作台维护：手工改名、归档、删除都回 409，改别的字段照常。
func TestAIMemberGuarded(t *testing.T) {
	s, ctx := newStore(t)
	if err := s.SyncAIMembers(ctx, []domain.AIMember{{Kind: domain.AIKindCLI, Ref: "claude", Name: "Claude Code"}}); err != nil {
		t.Fatal(err)
	}
	cc, _ := s.GetAIMember(ctx, domain.AIKindCLI, "claude")
	name, yes := "CC", true
	if _, err := s.UpdateStakeholder(ctx, cc.ID, domain.StakeholderPatch{Name: &name}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("改名应 409，得到 %v", err)
	}
	if _, err := s.UpdateStakeholder(ctx, cc.ID, domain.StakeholderPatch{Archived: &yes}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("归档应 409，得到 %v", err)
	}
	if err := s.DeleteStakeholder(ctx, cc.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("删除应 409，得到 %v", err)
	}
	note := "备注"
	if _, err := s.UpdateStakeholder(ctx, cc.ID, domain.StakeholderPatch{Note: &note, Name: &cc.Name}); err != nil {
		t.Fatalf("改备注（名字原样带上）应放行：%v", err)
	}
}
