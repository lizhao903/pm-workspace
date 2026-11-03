package sqlite

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func agentActor(session string) store.Actor {
	return store.Actor{Name: "claude-code", Source: "agent", Session: session}
}

// 两个会话同时追加，一条都不能丢。这是进展必须走服务端追加、不能「读正文拼一段写回」的原因。
func TestAppendProgressConcurrentAppendsAllLand(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "并发追加"})

	const perSession = 40
	var wg sync.WaitGroup
	errs := make(chan error, 2*perSession)
	for _, sess := range []string{"sess-a", "sess-b"} {
		wg.Add(1)
		go func(sess string) {
			defer wg.Done()
			for i := 0; i < perSession; i++ {
				_, err := s.AppendProgress(ctx, o.ID, domain.ProgressInput{Text: fmt.Sprintf("%s #%d", sess, i)}, agentActor(sess))
				if err != nil {
					errs <- err
				}
			}
		}(sess)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("append: %v", err)
	}

	items, err := s.ListProgress(ctx, o.ID, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2*perSession {
		t.Fatalf("应有 %d 条进展，实际 %d 条", 2*perSession, len(items))
	}
	bySession := map[string]int{}
	for _, p := range items {
		bySession[p.SessionID]++
		if p.ActorName != "claude-code" || p.Source != "agent" || p.Kind != domain.ProgressNote {
			t.Fatalf("actor/source/kind 不对: %+v", p)
		}
	}
	if bySession["sess-a"] != perSession || bySession["sess-b"] != perSession {
		t.Fatalf("按会话分组的条数不对: %v", bySession)
	}
}

func TestAppendProgressKeepsMetaAndOrdersNewestFirst(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "元数据"})

	if _, err := s.AppendProgress(ctx, o.ID, domain.ProgressInput{Text: "第一条"}, agentActor("s1")); err != nil {
		t.Fatal(err)
	}
	p, err := s.AppendProgress(ctx, o.ID, domain.ProgressInput{
		Text: "  第二条  ", Commits: []string{"abc123", " abc123 ", ""}, Files: []string{"a.go", "b.go"},
	}, agentActor("s1"))
	if err != nil {
		t.Fatal(err)
	}
	if p.Text != "第二条" || len(p.Commits) != 1 || p.Commits[0] != "abc123" || len(p.Files) != 2 {
		t.Fatalf("返回值没清洗: %+v", p)
	}

	items, err := s.ListProgress(ctx, o.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Text != "第二条" || items[1].Text != "第一条" {
		t.Fatalf("应最近的在前: %+v", items)
	}
	if items[0].ID != p.ID || items[0].Commits[0] != "abc123" || items[1].Commits == nil {
		t.Fatalf("读回的元数据不对: %+v / %+v", items[0], items[1])
	}

	// 进展同时出现在修订历史里，带拆好的会话标识。
	revs, err := s.ListRevisions(ctx, o.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if revs[0].Field != domain.FieldProgress || revs[0].SessionID != "s1" || revs[0].ActorName != "claude-code" {
		t.Fatalf("修订历史里的进展不对: %+v", revs[0])
	}
}

func TestAppendProgressValidation(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "校验"})

	cases := []domain.ProgressInput{
		{Text: ""},
		{Text: "x", Kind: "claim"}, // claim 只能经由领取接口写
		{Text: "x", Kind: "bogus"},
		{Text: "x", Status: "no-such-status"},
	}
	for _, in := range cases {
		if _, err := s.AppendProgress(ctx, o.ID, in, agentActor("s")); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("%+v 应报 validation，实际 %v", in, err)
		}
	}
	if _, err := s.AppendProgress(ctx, "obj_missing", domain.ProgressInput{Text: "x"}, agentActor("s")); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在的对象应 404，实际 %v", err)
	}
	if _, err := s.ListProgress(ctx, "obj_missing", 0); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在的对象应 404，实际 %v", err)
	}
	// 校验失败不能留下半截：状态没变、也没有进展。
	items, _ := s.ListProgress(ctx, o.ID, 0)
	if len(items) != 0 {
		t.Fatalf("校验失败不应写入: %+v", items)
	}
}

// 提交验收：状态和总结在同一个事务里落库。
func TestAppendProgressSwitchesStatusAtomically(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "验收"})

	p, err := s.AppendProgress(ctx, o.ID, domain.ProgressInput{
		Kind: domain.ProgressReview, Text: "做完了", Status: "doing",
	}, agentActor("s"))
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind != domain.ProgressReview || p.Status != "doing" {
		t.Fatalf("进展不对: %+v", p)
	}
	got, _ := s.GetObject(ctx, o.ID)
	if got.Status != "doing" || got.StartedAt == nil {
		t.Fatalf("状态应切到 doing 并记 started_at: %+v", got)
	}
	revs, _ := s.ListRevisions(ctx, o.ID, 10)
	var sawStatus bool
	for _, r := range revs {
		if r.Field == "status" && r.NewValue == "doing" && r.SessionID == "s" {
			sawStatus = true
		}
	}
	if !sawStatus {
		t.Fatalf("应有一条带会话标识的 status 修订: %+v", revs)
	}
}

func TestClaimObject(t *testing.T) {
	s, ctx := newStore(t)
	cc := mustStakeholder(t, s, ctx, "Claude Code")
	other := mustStakeholder(t, s, ctx, "李钊")
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "领取"})

	res, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s1"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Already || res.Object.Status != "doing" || res.Object.OwnerName != "Claude Code" {
		t.Fatalf("领取结果不对: %+v", res.Object)
	}
	if res.Progress.Kind != domain.ProgressClaim || res.Progress.SessionID != "s1" || res.Progress.Text == "" {
		t.Fatalf("领取进展不对: %+v", res.Progress)
	}

	// 同一会话再领：幂等，不多写一条。
	res2, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s1"))
	if err != nil || !res2.Already {
		t.Fatalf("同会话重复领取应幂等: %+v %v", res2, err)
	}
	items, _ := s.ListProgress(ctx, o.ID, 0)
	if len(items) != 1 {
		t.Fatalf("重复领取不应多写进展: %d 条", len(items))
	}

	// 另一个会话来领：拒绝，并说出是哪个会话。
	_, err = s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s2"))
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("别的会话领取应 409，实际 %v", err)
	}
	if want := "s1"; !strings.Contains(err.Error(), want) {
		t.Fatalf("冲突信息应带上占用的会话 %q: %v", want, err)
	}
	// 明确接手可以。
	if _, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID, Takeover: true}, agentActor("s2")); err != nil {
		t.Fatalf("takeover 应放行: %v", err)
	}

	// 负责人是别人：拒绝。
	o2 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "别人的", OwnerID: &other.ID})
	_, err = s.ClaimObject(ctx, o2.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s1"))
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "李钊") {
		t.Fatalf("负责人是别人时应 409 并说出是谁，实际 %v", err)
	}
	got, _ := s.GetObject(ctx, o2.ID)
	if got.Status != "todo" || *got.OwnerID != other.ID {
		t.Fatalf("被拒的领取不应改动任何字段: %+v", got)
	}

	// 任务被退回 todo 之后，别的会话可以再领。
	if _, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Status: pstr("todo")}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s3")); err != nil {
		t.Fatalf("退回后应能再领: %v", err)
	}

	// 终态不能领；领到终态也不行。
	o3 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "已完成", Status: "done"})
	if _, err := s.ClaimObject(ctx, o3.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor("s1")); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("终态应 409，实际 %v", err)
	}
	if _, err := s.ClaimObject(ctx, o2.ID, domain.ClaimInput{OwnerID: cc.ID, Status: "done", Takeover: true}, agentActor("s1")); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("领到终态应 400，实际 %v", err)
	}
	if _, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{}, agentActor("s1")); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("缺 owner_id 应 400，实际 %v", err)
	}
}

// 并发领取同一条任务：只能有一个会话领到。
func TestClaimObjectConcurrentOnlyOneWins(t *testing.T) {
	s, ctx := newStore(t)
	cc := mustStakeholder(t, s, ctx, "Claude Code")
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "抢"})

	const n = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, conflicts := 0, 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: cc.ID}, agentActor(fmt.Sprintf("s%d", i)))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, domain.ErrConflict):
				conflicts++
			default:
				t.Errorf("意外错误: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 || conflicts != n-1 {
		t.Fatalf("应恰好一个会话领到: wins=%d conflicts=%d", wins, conflicts)
	}
}

func TestRevisionActorWithoutSessionIsUnchanged(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "老形状"})
	revs, _ := s.ListRevisions(ctx, o.ID, 10)
	if revs[0].Actor != "me" || revs[0].ActorName != "me" || revs[0].SessionID != "" {
		t.Fatalf("不带会话时 actor 应保持老形状: %+v", revs[0])
	}
}
