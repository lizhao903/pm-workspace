// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func mustRun(t *testing.T, s *Store, ctx context.Context, objectID string) *domain.TaskRun {
	t.Helper()
	r, err := s.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: objectID,
		Workdir:  "/tmp/demo",
		Prompt:   "请完成这个任务",
		Status:   domain.RunRunning,
	})
	if err != nil {
		t.Fatalf("建执行记录: %v", err)
	}
	return r
}

func TestCreateTaskRun(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写个脚本"})

	r := mustRun(t, s, ctx, obj.ID)
	if r.ID == "" {
		t.Error("应当生成 id")
	}
	if r.StartedAt.IsZero() {
		t.Error("started_at 没填")
	}
	// finished_at 可空就是「还在跑」的唯一权威标志，新建时必须是空的。
	if r.FinishedAt != nil {
		t.Error("刚建的记录不该有 finished_at")
	}
	if r.Status != domain.RunRunning {
		t.Errorf("status = %q", r.Status)
	}

	got, err := s.GetTaskRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("取执行记录: %v", err)
	}
	if got.Prompt != "请完成这个任务" || got.Workdir != "/tmp/demo" {
		t.Errorf("prompt/workdir 没存住: %+v", got)
	}
}

// TestCreateTaskRunRequiresWorkdir 守着这条链路最要紧的一道校验。
// 空 workdir 落库意味着 claude 会跑在工作台自己的源码目录里。
func TestCreateTaskRunRequiresWorkdir(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写个脚本"})

	for _, wd := range []string{"", "   "} {
		_, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: wd})
		if !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("workdir=%q 应当被拒绝，got %v", wd, err)
		}
	}
}

// 对象不存在时要回 404，而不是让外键失败冒成一条 500。
func TestCreateTaskRunUnknownObject(t *testing.T) {
	s, ctx := newStore(t)
	_, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: "obj_nope", Workdir: "/tmp"})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestFinishTaskRun(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写个脚本"})
	r := mustRun(t, s, ctx, obj.ID)

	out, err := s.FinishTaskRun(ctx, r.ID, domain.RunDone, 0, "跑完了，改了 2 个文件", "")
	if err != nil {
		t.Fatalf("收尾: %v", err)
	}
	if out.Status != domain.RunDone || out.ExitCode != 0 {
		t.Errorf("status/exit = %s/%d", out.Status, out.ExitCode)
	}
	if out.FinishedAt == nil {
		t.Fatal("finished_at 必须填上，否则界面会一直转圈")
	}
	if out.Output != "跑完了，改了 2 个文件" {
		t.Errorf("output 没存住: %q", out.Output)
	}

	got, _ := s.GetTaskRun(ctx, r.ID)
	if got.FinishedAt == nil || got.Output != out.Output {
		t.Error("收尾结果没落到库里")
	}
}

// 取消和「进程自己退出」可能同时触发收尾，先到的那个才是真相。
func TestFinishTaskRunIsOnceOnly(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写个脚本"})
	r := mustRun(t, s, ctx, obj.ID)

	if _, err := s.FinishTaskRun(ctx, r.ID, domain.RunCanceled, -1, "", "已取消"); err != nil {
		t.Fatalf("第一次收尾: %v", err)
	}
	_, err := s.FinishTaskRun(ctx, r.ID, domain.RunDone, 0, "其实跑完了", "")
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("重复收尾应当冲突，got %v", err)
	}

	got, _ := s.GetTaskRun(ctx, r.ID)
	if got.Status != domain.RunCanceled {
		t.Errorf("status = %q，应当保留先到的那个结局", got.Status)
	}
}

func TestFinishTaskRunRejectsNonTerminalStatus(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写个脚本"})
	r := mustRun(t, s, ctx, obj.ID)

	for _, st := range []string{domain.RunPending, domain.RunRunning, "whatever"} {
		if _, err := s.FinishTaskRun(ctx, r.ID, st, 0, "", ""); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("status=%q 不是终态，应当被拒绝，got %v", st, err)
		}
	}
}

func TestFinishTaskRunNotFound(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.FinishTaskRun(ctx, "run_nope", domain.RunDone, 0, "", ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestGetTaskRunNotFound(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.GetTaskRun(ctx, "run_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestListTaskRunsNewestFirst(t *testing.T) {
	s, ctx := newStore(t)
	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务 A"})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务 B"})

	var ids []string
	for i := 0; i < 3; i++ {
		ids = append(ids, mustRun(t, s, ctx, a.ID).ID)
	}
	other := mustRun(t, s, ctx, b.ID)

	got, err := s.ListTaskRuns(ctx, a.ID, 0)
	if err != nil {
		t.Fatalf("列执行记录: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 runs of A, got %d", len(got))
	}
	// 详情面板只有一种读法：最近一次在最前。
	for i, want := range []string{ids[2], ids[1], ids[0]} {
		if got[i].ID != want {
			t.Errorf("第 %d 条 = %s，want %s（应当按时间倒序）", i, got[i].ID, want)
		}
	}
	for _, r := range got {
		if r.ID == other.ID {
			t.Error("串到别的对象的记录了")
		}
	}

	if got, _ = s.ListTaskRuns(ctx, a.ID, 2); len(got) != 2 {
		t.Errorf("limit=2 时返回 %d 条", len(got))
	}
	// 没有记录时要回空切片而不是 nil，API 层的 [] 契约靠它。
	if got, _ = s.ListTaskRuns(ctx, "obj_nope", 0); got == nil || len(got) != 0 {
		t.Errorf("未知对象应回空列表，got %v", got)
	}
}

// TestDeleteObjectCascadesRuns 守着 0009 迁移里的 ON DELETE CASCADE。
// 执行记录脱离了工作对象没有任何意义，留着只会在库里堆成查不到的孤儿。
func TestDeleteObjectCascadesRuns(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "会被删掉"})
	r := mustRun(t, s, ctx, obj.ID)

	// 软删不该动执行记录：对象还在回收站里，历史得留着。
	if err := s.DeleteObject(ctx, obj.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("软删: %v", err)
	}
	if _, err := s.GetTaskRun(ctx, r.ID); err != nil {
		t.Fatalf("软删之后执行记录应当还在: %v", err)
	}

	if err := s.DeleteObject(ctx, obj.ID, true, store.DefaultActor); err != nil {
		t.Fatalf("硬删: %v", err)
	}
	if _, err := s.GetTaskRun(ctx, r.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("硬删对象后执行记录应当一起没，got %v", err)
	}
}

// 输出可能很大。截断是 runner 的职责，库这层要能原样吞下 1MB 并原样吐回来——
// 中途被截掉的话，「事后复查它做了什么」就是假的。
func TestLargeOutputRoundTrips(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "话很多"})
	r := mustRun(t, s, ctx, obj.ID)

	big := strings.Repeat("一二三四五六七八九十", 40000) // ~1.2 MB
	if _, err := s.FinishTaskRun(ctx, r.ID, domain.RunDone, 0, big, ""); err != nil {
		t.Fatalf("收尾: %v", err)
	}
	got, err := s.GetTaskRun(ctx, r.ID)
	if err != nil {
		t.Fatalf("取执行记录: %v", err)
	}
	if got.Output != big {
		t.Fatalf("大输出没能原样存取：存 %d 字节，取回 %d 字节", len(big), len(got.Output))
	}
}

// TestListTaskRunsTiebreakIsInsertionOrder 直接造出「时间戳完全相同」这一种情况。
//
// 正常路径下 started_at 是纳秒级的，撞车概率极低——低到跑几百次也复现不出来。
// 但「没复现」只说明概率低，不说明不存在。所以这里绕过 CreateTaskRun 直接写库，
// 把那一种情况钉死：三条记录时间戳一模一样，顺序只能由 rowid（插入顺序）决定。
//
// id 是故意挑的：按 id 倒序会得到 c/b/a，按插入倒序会得到 b/a/c，两者区分得开。
// 之前的实现用 id 兜底，这条测试会红。
func TestListTaskRunsTiebreakIsInsertionOrder(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "同一时刻"})

	same := nowRun()
	for _, id := range []string{"run_c", "run_a", "run_b"} {
		if _, err := s.db.W.ExecContext(ctx,
			`INSERT INTO task_runs (`+taskRunCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, obj.ID, "/tmp/demo", "", domain.RunRunning, 0, "", "", same, nil, domain.RunModeStream,
			domain.RunHarnessClaude, ""); err != nil {
			t.Fatalf("插入 %s: %v", id, err)
		}
	}

	got, err := s.ListTaskRuns(ctx, obj.ID, 0)
	if err != nil {
		t.Fatalf("列执行记录: %v", err)
	}
	var ids []string
	for _, r := range got {
		ids = append(ids, r.ID)
	}
	want := []string{"run_b", "run_a", "run_c"} // 插入顺序的倒序
	if len(ids) != len(want) {
		t.Fatalf("got %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("时间戳相同时的顺序 = %v，want %v（应当按插入顺序倒序，不是按 id）", ids, want)
		}
	}
}

// TestListTaskRunsZeroLimitCapsAtDefault 守着 store.ListTaskRuns 的契约里
// 最容易被当成「全部」的那一条：limit <= 0 不是不限，是取 store.DefaultRunLimit。
//
// 别的用例也传 0，但它们只造了三条记录——上限根本没被碰到，把兜底整个删掉
// 那些用例照样绿。这里必须造到超过默认值，断言才验证得到东西。
func TestListTaskRunsZeroLimitCapsAtDefault(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "话痨任务"})

	const extra = 5
	for i := 0; i < store.DefaultRunLimit+extra; i++ {
		mustRun(t, s, ctx, obj.ID)
	}

	for _, limit := range []int{0, -1} {
		got, err := s.ListTaskRuns(ctx, obj.ID, limit)
		if err != nil {
			t.Fatalf("limit=%d: %v", limit, err)
		}
		if len(got) != store.DefaultRunLimit {
			t.Errorf("limit=%d 返回 %d 条，want %d（<=0 应当取默认条数，不是全部）",
				limit, len(got), store.DefaultRunLimit)
		}
	}

	// 取的是「最近」的那一批，不是最早的：截断发生在排序之后。
	all, err := s.ListTaskRuns(ctx, obj.ID, store.DefaultRunLimit+extra*2)
	if err != nil {
		t.Fatalf("全量: %v", err)
	}
	if len(all) != store.DefaultRunLimit+extra {
		t.Fatalf("显式大 limit 应返回全部 %d 条，got %d", store.DefaultRunLimit+extra, len(all))
	}
	capped, _ := s.ListTaskRuns(ctx, obj.ID, 0)
	if capped[0].ID != all[0].ID {
		t.Errorf("默认条数取到的首条是 %s，全量的首条是 %s——截断把最近的切掉了",
			capped[0].ID, all[0].ID)
	}
}

// 执行方式（0048）：不给是 stream，terminal 原样存，别的值拒绝；提示词能在收尾前补写。
func TestTaskRunMode(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "方式"})
	r1, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning})
	if err != nil || r1.Mode != domain.RunModeStream {
		t.Fatalf("默认方式：%+v %v", r1, err)
	}
	r2, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning, Mode: domain.RunModeTerminal})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetTaskRun(ctx, r2.ID); got.Mode != domain.RunModeTerminal {
		t.Fatalf("读回：%+v", got)
	}
	if _, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/x", Mode: "x"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("非法方式应拒绝：%v", err)
	}
	if err := s.SetTaskRunPrompt(ctx, r2.ID, "带 id 的提示词"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetTaskRun(ctx, r2.ID); got.Prompt != "带 id 的提示词" {
		t.Fatalf("补写提示词：%q", got.Prompt)
	}
	if _, err := s.FinishTaskRun(ctx, r2.ID, domain.RunDone, 0, "结论", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTaskRunPrompt(ctx, r2.ID, "x"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("收尾后不能再改：%v", err)
	}
	if err := s.SetTaskRunPrompt(ctx, "run_nope", "x"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在：%v", err)
	}
}
