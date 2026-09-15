package api

import (
	"context"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// fakeStore 是 API 测试的公共底座，它和 sqlite 实现一旦在被测性质上分叉，
// 上层测试就会绿着骗人。这里把 ListAgentMessages 的 limit 语义钉死，
// 口径以 store.Store 的接口注释为准：最近 N 条、按时间正序、limit<=0 取全部。
func TestFakeStoreAgentMessageLimitSemantics(t *testing.T) {
	f := newFakeStore()
	ctx := context.Background()

	sess, err := f.CreateAgentSession(ctx, &domain.AgentSession{Title: "会话"})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"1", "2", "3", "4", "5"} {
		if _, err := f.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: sess.ID, Role: "user", Content: c,
		}); err != nil {
			t.Fatal(err)
		}
	}

	contents := func(ms []*domain.AgentMessage) []string {
		out := make([]string, len(ms))
		for i, m := range ms {
			out[i] = m.Content
		}
		return out
	}
	eq := func(got, want []string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}

	// 取最近 2 条，但仍按时间正序——前端拿到就能从上往下渲染。
	got, err := f.ListAgentMessages(ctx, sess.ID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !eq(contents(got), []string{"4", "5"}) {
		t.Fatalf("limit=2 得到 %v, 期望 [4 5]（最近两条、正序）", contents(got))
	}

	for _, limit := range []int{0, -1} {
		got, err := f.ListAgentMessages(ctx, sess.ID, limit)
		if err != nil {
			t.Fatal(err)
		}
		if !eq(contents(got), []string{"1", "2", "3", "4", "5"}) {
			t.Fatalf("limit=%d 得到 %v, 期望全部", limit, contents(got))
		}
	}

	// limit 超过总数不截断。
	if got, _ := f.ListAgentMessages(ctx, sess.ID, 99); len(got) != 5 {
		t.Fatalf("limit=99 得到 %d 条, 期望 5", len(got))
	}

	// 会话不存在回空列表而不是报错，与 sqlite 一致。
	got, err = f.ListAgentMessages(ctx, "ses_nope", 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("不存在的会话应回空列表, got %v err=%v", contents(got), err)
	}
	arts, err := f.ListAgentArtifacts(ctx, "ses_nope")
	if err != nil || len(arts) != 0 {
		t.Fatalf("不存在的会话产物应回空列表, got %d err=%v", len(arts), err)
	}
}
