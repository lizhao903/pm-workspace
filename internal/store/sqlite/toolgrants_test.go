// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func TestAgentGrantsAndDetachConnector(t *testing.T) {
	s, ctx := newStore(t)
	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	mcps := []string{"cn_1", "cn_2"}
	a, err := s.CreateAgent(ctx, domain.AgentInput{Name: sp("分诊"), ProviderID: &p.ID, MCPs: &mcps})
	if err != nil {
		t.Fatal(err)
	}
	// 新建按原型 newAgent：只开查任务、查联系人
	g, err := s.AgentGrants(ctx, a.ID)
	if err != nil || !maps.Equal(g, map[string]string{"read_tasks": "auto", "read_contacts": "auto"}) {
		t.Fatalf("默认授权 = %v，%v", g, err)
	}

	// 整组换掉，off 不存
	if err := s.SetAgentGrants(ctx, a.ID, map[string]string{
		"write_tasks": "confirm", "read_tasks": "off", "conn:cn_1:create_item": "auto", "conn:cnX1:list_items": "auto",
		"conn:cn_2:list_items": "auto",
	}); err != nil {
		t.Fatal(err)
	}
	g, _ = s.AgentGrants(ctx, a.ID)
	if len(g) != 4 || g["write_tasks"] != "confirm" || g["read_tasks"] != "" {
		t.Fatalf("换掉之后 = %v", g)
	}
	if err := s.SetAgentGrants(ctx, "ag_nope", map[string]string{}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("Agent 不存在应 404：%v", err)
	}

	ids, err := s.DetachConnector(ctx, "cn_1")
	if err != nil || !slices.Equal(ids, []string{a.ID}) {
		t.Fatalf("DetachConnector = %v，%v", ids, err)
	}
	g, _ = s.AgentGrants(ctx, a.ID)
	// cn_1 的下划线不能当通配符：cnX1 的授权要留着
	if g["conn:cn_1:create_item"] != "" || g["conn:cnX1:list_items"] != "auto" || g["conn:cn_2:list_items"] != "auto" {
		t.Fatalf("摘掉之后 = %v", g)
	}
	got, _ := s.GetAgent(ctx, a.ID)
	if !slices.Equal(got.MCPs, []string{"cn_2"}) {
		t.Fatalf("mcps = %v", got.MCPs)
	}
	if ids, _ := s.DetachConnector(ctx, "cn_9"); len(ids) != 0 {
		t.Errorf("没挂的连接器不该摘到 Agent：%v", ids)
	}

	if _, err := s.DeleteAgent(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if g, _ := s.AgentGrants(ctx, a.ID); len(g) != 0 {
		t.Errorf("删 Agent 后授权还在：%v", g)
	}
}

func TestAgentToolCallDecideOnce(t *testing.T) {
	s, ctx := newStore(t)
	sid := "ags_1"
	c, err := s.CreateAgentToolCall(ctx, &store.AgentToolCall{AgentID: "ag_1", SessionID: &sid, CallID: "c1",
		Tool: "create_object", GrantKey: "write_tasks", Args: `{"title":"x"}`})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(c.ID, "atc_") || c.State != store.ToolCallPending || c.DecidedAt != nil || *c.SessionID != sid || c.RunID != nil {
		t.Fatalf("新建 = %+v", c)
	}
	if n, _ := s.CountPendingToolCalls(ctx, "ag_1"); n != 1 {
		t.Errorf("待确认 = %d", n)
	}
	if _, err := s.DecideAgentToolCall(ctx, c.ID, "pending"); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("只能改成 confirmed / rejected：%v", err)
	}
	d, err := s.DecideAgentToolCall(ctx, c.ID, store.ToolCallConfirmed)
	if err != nil || d.State != store.ToolCallConfirmed || d.DecidedAt == nil {
		t.Fatalf("确认 = %+v，%v", d, err)
	}
	if _, err := s.DecideAgentToolCall(ctx, c.ID, store.ToolCallRejected); !errors.Is(err, domain.ErrConflict) {
		t.Errorf("第二次决定应 409：%v", err)
	}
	if err := s.SetAgentToolCallResult(ctx, c.ID, "已创建 TSK-0001"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetAgentToolCall(ctx, c.ID); got.Result != "已创建 TSK-0001" {
		t.Errorf("result = %q", got.Result)
	}
	if n, _ := s.CountPendingToolCalls(ctx, "ag_1"); n != 0 {
		t.Errorf("确认后待确认 = %d", n)
	}
	if _, err := s.GetAgentToolCall(ctx, "atc_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("不存在应 404：%v", err)
	}
}

// 等确认聚合接口（P0-O3）的列表：只看 pending、先记的在前、可按会话筛、空回空切片。
func TestListPendingToolCalls(t *testing.T) {
	s, ctx := newStore(t)
	sa, sb := "ags_a", "ags_b"
	mk := func(session *string, tool string) *store.AgentToolCall {
		t.Helper()
		c, err := s.CreateAgentToolCall(ctx, &store.AgentToolCall{
			AgentID: "ag_1", SessionID: session, CallID: "call_" + tool,
			Tool: tool, GrantKey: "write_tasks", Args: `{"ref":"TSK-1"}`,
		})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	c1 := mk(&sa, "update_object")
	c2 := mk(&sa, "create_object")
	c3 := mk(&sb, "write_file")
	decided := mk(nil, "append_progress")
	if _, err := s.DecideAgentToolCall(ctx, decided.ID, store.ToolCallRejected); err != nil {
		t.Fatal(err)
	}

	all, err := s.ListPendingToolCalls(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, c := range all {
		ids = append(ids, c.ID)
	}
	// 已决定的不出现；同一毫秒里先记的靠 rowid 在前
	if want := []string{c1.ID, c2.ID, c3.ID}; !slices.Equal(ids, want) {
		t.Fatalf("全部待确认 = %v，期望 %v", ids, want)
	}

	gotA, err := s.ListPendingToolCalls(ctx, sa)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotA) != 2 || *gotA[0].SessionID != sa || *gotA[1].SessionID != sa {
		t.Fatalf("会话 %s 的待确认 = %+v", sa, gotA)
	}
	gotB, _ := s.ListPendingToolCalls(ctx, sb)
	if len(gotB) != 1 || gotB[0].ID != c3.ID {
		t.Fatalf("会话 %s 的待确认 = %+v", sb, gotB)
	}

	none, err := s.ListPendingToolCalls(ctx, "ags_none")
	if err != nil {
		t.Fatal(err)
	}
	if none == nil || len(none) != 0 {
		t.Fatalf("没有待确认时应回空切片，得到 %#v", none)
	}
}
