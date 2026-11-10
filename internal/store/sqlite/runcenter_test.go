// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 统一运行中心（P0-O1）：task 执行的跨对象读法 ---

// mustRunWithStatus 建一条执行记录、把它推到想要的状态，再把 started_at 改成确定值。
// CreateTaskRun 只会写当前时间，而排序/分页测试需要可控的时间线。
func mustRunWithStatus(t *testing.T, s *Store, ctx context.Context, objectID, status string, started time.Time) *domain.TaskRun {
	t.Helper()
	r, err := s.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: objectID,
		Workdir:  "/tmp/demo",
		Status:   domain.RunRunning,
	})
	if err != nil {
		t.Fatalf("建执行记录: %v", err)
	}
	switch status {
	case domain.RunRunning:
	case domain.RunWaiting:
		if err := s.SetTaskRunStatus(ctx, r.ID, status); err != nil {
			t.Fatalf("改状态 %s: %v", status, err)
		}
	default:
		out, err := s.FinishTaskRun(ctx, r.ID, status, 0, "", "")
		if err != nil {
			t.Fatalf("收尾成 %s: %v", status, err)
		}
		r = out
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE task_runs SET started_at = ? WHERE id = ?`,
		started.UTC().Format(agentTimeLayout), r.ID); err != nil {
		t.Fatalf("改 started_at: %v", err)
	}
	r.StartedAt = started
	return r
}

// 空库回空切片 + total 0，不能回 nil（API 层靠它回 []）。
func TestListAllTaskRunsEmpty(t *testing.T) {
	s, ctx := newStore(t)
	runs, total, err := s.ListAllTaskRuns(ctx, nil, 50, 0)
	if err != nil {
		t.Fatalf("列执行记录: %v", err)
	}
	if runs == nil || len(runs) != 0 {
		t.Fatalf("空库应回空切片，got %v", runs)
	}
	if total != 0 {
		t.Fatalf("total = %d，想要 0", total)
	}
}

// 跨对象读：不按对象筛，按 started_at 倒序，并带出归属对象的 ref/title。
func TestListAllTaskRunsJoinObjectAndOrder(t *testing.T) {
	s, ctx := newStore(t)
	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务 A"})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务 B"})

	now := time.Now()
	r1 := mustRunWithStatus(t, s, ctx, a.ID, domain.RunDone, now.Add(-3*time.Hour))
	r2 := mustRunWithStatus(t, s, ctx, b.ID, domain.RunRunning, now.Add(-2*time.Hour))
	r3 := mustRunWithStatus(t, s, ctx, a.ID, domain.RunFailed, now.Add(-time.Hour))

	runs, total, err := s.ListAllTaskRuns(ctx, nil, 10, 0)
	if err != nil {
		t.Fatalf("列执行记录: %v", err)
	}
	if total != 3 || len(runs) != 3 {
		t.Fatalf("total=%d len=%d，想要 3", total, len(runs))
	}
	want := []string{r3.ID, r2.ID, r1.ID}
	for i, w := range want {
		if runs[i].Run.ID != w {
			t.Fatalf("第 %d 条 = %s，想要 %s（应当按 started_at 倒序）", i, runs[i].Run.ID, w)
		}
	}
	if runs[2].ObjectRef != a.Ref || runs[2].ObjectTitle != "任务 A" {
		t.Fatalf("join 出的对象字段 = %q/%q，想要 %q/任务 A", runs[2].ObjectRef, runs[2].ObjectTitle, a.Ref)
	}
	if runs[1].ObjectRef != b.Ref || runs[1].ObjectTitle != "任务 B" {
		t.Fatalf("join 出的对象字段 = %q/%q", runs[1].ObjectRef, runs[1].ObjectTitle)
	}
}

// 状态过滤：空表不过滤，给定状态只要这些；total 是过滤后的命中数。
func TestListAllTaskRunsStatusFilter(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "各种状态"})
	now := time.Now()
	mustRunWithStatus(t, s, ctx, obj.ID, domain.RunRunning, now.Add(-time.Hour))
	mustRunWithStatus(t, s, ctx, obj.ID, domain.RunWaiting, now.Add(-2*time.Hour))
	mustRunWithStatus(t, s, ctx, obj.ID, domain.RunDone, now.Add(-3*time.Hour))
	mustRunWithStatus(t, s, ctx, obj.ID, domain.RunFailed, now.Add(-4*time.Hour))
	mustRunWithStatus(t, s, ctx, obj.ID, domain.RunCanceled, now.Add(-5*time.Hour))

	cases := []struct {
		statuses []string
		want     int
	}{
		{nil, 5},
		{[]string{domain.RunRunning, domain.RunWaiting}, 2},
		{[]string{domain.RunDone}, 1},
		{[]string{domain.RunFailed, domain.RunCanceled}, 2},
		{[]string{store.AgentRunRejected}, 0},
	}
	for _, tc := range cases {
		runs, total, err := s.ListAllTaskRuns(ctx, tc.statuses, 50, 0)
		if err != nil {
			t.Fatalf("statuses=%v: %v", tc.statuses, err)
		}
		if total != tc.want || len(runs) != tc.want {
			t.Fatalf("statuses=%v: total=%d len=%d，想要 %d", tc.statuses, total, len(runs), tc.want)
		}
		if runs == nil {
			t.Fatalf("statuses=%v: 应回空切片而不是 nil", tc.statuses)
		}
	}
}

// 分页：limit/offset 切的是排序后的结果，total 始终是过滤后的总数。
func TestListAllTaskRunsPagination(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "分页"})
	now := time.Now()
	var ids []string
	for i := 0; i < 5; i++ {
		r := mustRunWithStatus(t, s, ctx, obj.ID, domain.RunDone, now.Add(-time.Duration(5-i)*time.Hour))
		ids = append(ids, r.ID)
	}
	newestFirst := []string{ids[4], ids[3], ids[2], ids[1], ids[0]}

	runs, total, err := s.ListAllTaskRuns(ctx, nil, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(runs) != 2 || runs[0].Run.ID != newestFirst[0] || runs[1].Run.ID != newestFirst[1] {
		t.Fatalf("第一页: total=%d ids=%v", total, runIDs(runs))
	}

	// 第二页必须接着第一页，从 offset 处开始——两侧各取一页再切的那套分页靠这个性质。
	runs, total, err = s.ListAllTaskRuns(ctx, nil, 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(runs) != 2 || runs[0].Run.ID != newestFirst[2] || runs[1].Run.ID != newestFirst[3] {
		t.Fatalf("第二页: total=%d ids=%v", total, runIDs(runs))
	}

	runs, total, err = s.ListAllTaskRuns(ctx, nil, 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || runs == nil || len(runs) != 0 {
		t.Fatalf("越界页应回空切片 + total 5: total=%d runs=%v", total, runs)
	}
}

// limit <= 0 取 DefaultRunLimit，不是「全部」；total 仍然是全部命中数。
func TestListAllTaskRunsDefaultLimit(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "话多"})
	now := time.Now()
	for i := 0; i < store.DefaultRunLimit+3; i++ {
		mustRunWithStatus(t, s, ctx, obj.ID, domain.RunDone, now.Add(-time.Duration(i)*time.Minute))
	}
	runs, total, err := s.ListAllTaskRuns(ctx, nil, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != store.DefaultRunLimit+3 {
		t.Fatalf("total = %d，想要 %d", total, store.DefaultRunLimit+3)
	}
	if len(runs) != store.DefaultRunLimit {
		t.Fatalf("limit<=0 返回 %d 条，想要 %d", len(runs), store.DefaultRunLimit)
	}
}

// 时间戳撞车时按 rowid（插入顺序）倒序，和 ListTaskRuns 同一口径。
func TestListAllTaskRunsTiebreakIsInsertionOrder(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "同一时刻"})

	same := nowRun()
	for _, id := range []string{"run_c", "run_a", "run_b"} {
		if _, err := s.db.W.ExecContext(ctx,
			`INSERT INTO task_runs (`+taskRunCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, obj.ID, "/tmp/demo", "", domain.RunRunning, 0, "", "", same, nil,
			domain.RunModeStream, domain.RunHarnessClaude, ""); err != nil {
			t.Fatalf("插入 %s: %v", id, err)
		}
	}

	runs, total, err := s.ListAllTaskRuns(ctx, nil, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Fatalf("total = %d", total)
	}
	want := []string{"run_b", "run_a", "run_c"}
	for i := range want {
		if runs[i].Run.ID != want[i] {
			t.Fatalf("时间戳相同时的顺序 = %v，want %v", runIDs(runs), want)
		}
	}
}

func runIDs(runs []*store.RunCenterTaskRun) []string {
	out := make([]string, 0, len(runs))
	for _, r := range runs {
		out = append(out, r.Run.ID)
	}
	return out
}
