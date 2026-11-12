// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- 模块前缀复用与缓存用量（0058） ---

// 迁移 0058 之后 task_runs 有模块/用量列，module_prefixes 表存在。
func TestMigration0058ColumnsExist(t *testing.T) {
	s, ctx := newStore(t)
	for _, col := range []string{"module_key", "prefix_version", "cache_read_tokens", "uncached_input_tokens", "output_tokens"} {
		var n int
		if err := s.db.R.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM pragma_table_info('task_runs') WHERE name = ?`, col).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("task_runs 缺列 %s", col)
		}
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'module_prefixes'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("module_prefixes 表不存在")
	}
}

// 执行记录能存/读模块归属与用量；跨对象读法（运行中心）也要带出来。
func TestTaskRunModuleAndUsageRoundTrip(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "带模块的任务"})

	run, err := s.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/demo", Status: domain.RunRunning,
		Harness: domain.RunHarnessDeepSeek, ModuleKey: "project:obj_1", PrefixVersion: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.ModuleKey != "project:obj_1" || run.PrefixVersion != 3 {
		t.Fatalf("CreateTaskRun 没带上模块：%+v", run)
	}
	got, err := s.GetTaskRun(ctx, run.ID)
	if err != nil || got.ModuleKey != "project:obj_1" || got.PrefixVersion != 3 {
		t.Fatalf("读回模块 = %+v，%v", got, err)
	}

	if err := s.SetTaskRunUsage(ctx, run.ID, 1200, 300, 50); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTaskRunModule(ctx, run.ID, "workdir:/tmp/demo", 4); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetTaskRun(ctx, run.ID)
	if got.CacheReadTokens != 1200 || got.UncachedInputTokens != 300 || got.OutputTokens != 50 {
		t.Fatalf("用量 = %+v", got)
	}
	if got.ModuleKey != "workdir:/tmp/demo" || got.PrefixVersion != 4 {
		t.Fatalf("模块 = %+v", got)
	}

	// 列表两条读法都带新列（scanTaskRun / scanRunCenterTaskRun 各一份手写 Scan）
	runs, err := s.ListTaskRuns(ctx, obj.ID, 10)
	if err != nil || len(runs) != 1 || runs[0].CacheReadTokens != 1200 || runs[0].ModuleKey != "workdir:/tmp/demo" {
		t.Fatalf("ListTaskRuns = %+v，%v", runs, err)
	}
	all, total, err := s.ListAllTaskRuns(ctx, nil, 10, 0)
	if err != nil || total != 1 || len(all) != 1 {
		t.Fatalf("ListAllTaskRuns = %+v，%d，%v", all, total, err)
	}
	if all[0].Run.OutputTokens != 50 || all[0].Run.ModuleKey != "workdir:/tmp/demo" || all[0].Run.PrefixVersion != 4 {
		t.Fatalf("运行中心读回 = %+v", all[0].Run)
	}

	// 不存在的记录
	if err := s.SetTaskRunUsage(ctx, "run_nope", 1, 2, 3); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("SetTaskRunUsage 不存在 = %v", err)
	}
	if err := s.SetTaskRunModule(ctx, "run_nope", "m", 1); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("SetTaskRunModule 不存在 = %v", err)
	}
}

// 模块简报：不存在回 (nil, nil)；Save 是 upsert，再存一次是更新不是插一条。
func TestModulePrefixGetSaveUpsert(t *testing.T) {
	s, ctx := newStore(t)
	if p, err := s.GetModulePrefix(ctx, "project:p1"); err != nil || p != nil {
		t.Fatalf("不存在的模块 = %+v，%v，想要 nil, nil", p, err)
	}
	if p, err := s.GetModulePrefix(ctx, "  "); err != nil || p != nil {
		t.Fatalf("空 key = %+v，%v", p, err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	in := &domain.ModulePrefix{ModuleKey: "project:p1", Briefing: "第一版\n", Version: 1, UpdatedAt: now}
	if err := s.SaveModulePrefix(ctx, in); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetModulePrefix(ctx, "project:p1")
	if err != nil || got == nil {
		t.Fatalf("读回: %+v，%v", got, err)
	}
	if got.Briefing != "第一版\n" || got.Version != 1 || !got.UpdatedAt.Equal(now) {
		t.Fatalf("读回 = %+v", got)
	}

	// 同一 key 再存一次：更新，不是新行
	if err := s.SaveModulePrefix(ctx, &domain.ModulePrefix{ModuleKey: "project:p1", Briefing: "第一版\n第二行\n", Version: 2, UpdatedAt: now.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetModulePrefix(ctx, "project:p1")
	if got.Version != 2 || got.Briefing != "第一版\n第二行\n" {
		t.Fatalf("upsert 后 = %+v", got)
	}
	var n int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM module_prefixes`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("行数 = %d，%v，想要 1", n, err)
	}
}
