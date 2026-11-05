package agent

import (
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0460：交给 Agent 执行任务用的模型客户端（TaskChat）和 Complete 同一套熔断、重试、失败改用。
func TestTaskChatFallbackAndBreaker(t *testing.T) {
	ctx := t.Context()
	down := newFakeModel(t, "down", "")
	up := newFakeModel(t, "ok", "备用回的")
	s, st, _ := realService(t)
	fb := addOllama(t, st, "备用", up.srv.URL, false, nil)
	p := addOllama(t, st, "NewAPI", down.srv.URL, true, map[string]any{FallbackKey: fb.ID})

	c, model, got, err := s.TaskChat(ctx, "", "主模型")
	if err != nil || got.ID != p.ID || model != "主模型" {
		t.Fatalf("TaskChat = %v %q %v", got, model, err)
	}
	for i := range 4 {
		var b strings.Builder
		err := c.Stream(ctx, Request{Model: model, Messages: []Message{{Role: "user", Content: "x"}}}, func(ev Event) {
			if ev.Kind == EventDelta {
				b.WriteString(ev.Text)
			}
		})
		if err != nil || b.String() != "备用回的" {
			t.Fatalf("第 %d 次应当改用备用服务商：%q %v", i+1, b.String(), err)
		}
	}
	if n := down.hits.Load(); n > 5 {
		t.Fatalf("熔断后原服务商不该再打出去：%d 次", n)
	}

	// 备用也挂了：回不可用，不无限重试
	up.set("down")
	before := up.hits.Load()
	err = c.Stream(ctx, Request{Model: model, Messages: []Message{{Role: "user", Content: "x"}}}, func(Event) {})
	if ue, ok := AsUnavailable(err); !ok || ue.Fallback != "备用" {
		t.Fatalf("都挂了应当回不可用：%v", err)
	}
	if n := up.hits.Load() - before; n != 3 {
		t.Fatalf("备用服务商一次调用最多打 1+重试次数（3）次：%d", n)
	}

	// 停用的服务商直接报错
	off := addOllama(t, st, "停了的", up.srv.URL, false, nil)
	no := false
	if _, err := st.UpdateProvider(ctx, off.ID, domain.AgentProviderInput{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.TaskChat(ctx, off.ID, ""); err == nil || !strings.Contains(err.Error(), "已停用") {
		t.Fatalf("停用的服务商：%v", err)
	}
}

// 只读的授权：写能力去掉、会改对方数据的连接器工具关掉，原来那份不动。
func TestPolicyReadOnly(t *testing.T) {
	p := &Policy{
		Grants: map[string]string{"read_tasks": store.GrantAuto, "write_tasks": store.GrantAuto, "write_content": store.GrantConfirm},
		Conn: []ConnTool{
			{Name: "fake__list", Mode: store.GrantAuto},
			{Name: "fake__create", Write: true, Mode: store.GrantAuto},
		},
	}
	ro := p.ReadOnly()
	for _, n := range []string{"update_object", "create_object", toolProgress, "write_file", "fake__create"} {
		if m, _ := ro.ModeOf(n); m != store.GrantOff {
			t.Fatalf("只读后 %s = %s", n, m)
		}
	}
	for _, n := range []string{"get_object", "search_objects", "fake__list"} {
		if m, _ := ro.ModeOf(n); m != store.GrantAuto {
			t.Fatalf("只读后 %s = %s", n, m)
		}
	}
	if m, _ := p.ModeOf("update_object"); m != store.GrantAuto {
		t.Fatal("原来的授权被改了")
	}
}

// 步数预算：用完了回 BudgetError，nil 不限。
func TestBudgetTake(t *testing.T) {
	var nb *Budget
	if nb.take() != nil {
		t.Fatal("nil 预算不限")
	}
	b := &Budget{MaxSteps: 2}
	if b.take() != nil || b.take() != nil {
		t.Fatal("前两步应当放行")
	}
	err := b.take()
	if be, ok := err.(*BudgetError); !ok || be.MaxSteps != 2 || !strings.Contains(err.Error(), "步数上限（2 步）") {
		t.Fatalf("第三步 = %v", err)
	}
}
