// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TestResolveWorkdirOwn 自身设了就用自身的，不看项目。
func TestResolveWorkdirOwn(t *testing.T) {
	s, ctx := newStore(t)

	proj := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "project", Title: "工作台", Workdir: "/tmp/项目产出",
	})
	task := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "写目录浏览", ProjectID: &proj.ID, Workdir: "/tmp/任务产出",
	})

	got, err := s.ResolveWorkdir(ctx, task.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "/tmp/任务产出" {
		t.Fatalf("自身设了就该用自身的，实际 %q", got)
	}
}

// TestResolveWorkdirFallsBackToProject 自身没设时回退到所属项目的。
func TestResolveWorkdirFallsBackToProject(t *testing.T) {
	s, ctx := newStore(t)

	proj := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "project", Title: "工作台", Workdir: "/tmp/项目产出",
	})
	task := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "写目录浏览", ProjectID: &proj.ID,
	})

	got, err := s.ResolveWorkdir(ctx, task.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "/tmp/项目产出" {
		t.Fatalf("自身没设该回退到项目的，实际 %q", got)
	}
}

// TestResolveWorkdirEmpty 都没设返回空串，而不是错误——大多数对象本来就不需要工作区。
func TestResolveWorkdirEmpty(t *testing.T) {
	s, ctx := newStore(t)

	proj := mustCreate(t, s, ctx, &domain.Object{TypeID: "project", Title: "没配工作区的项目"})
	withProj := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "挂在项目下", ProjectID: &proj.ID,
	})
	orphan := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "不挂项目"})

	for _, id := range []string{withProj.ID, orphan.ID, proj.ID} {
		got, err := s.ResolveWorkdir(ctx, id)
		if err != nil {
			t.Fatalf("resolve %s: %v", id, err)
		}
		if got != "" {
			t.Fatalf("都没设该返回空串，实际 %q", got)
		}
	}
}

// TestResolveWorkdirStopsAtOneLevel 只向上找一层：项目的项目不参与。
// 递归查找除了把「看一眼 project_id」变成「会不会成环」之外没有收益。
func TestResolveWorkdirStopsAtOneLevel(t *testing.T) {
	s, ctx := newStore(t)

	top := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "project", Title: "上层", Workdir: "/tmp/上层",
	})
	mid := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "project", Title: "中层", ProjectID: &top.ID,
	})
	leaf := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "叶子", ProjectID: &mid.ID,
	})

	got, err := s.ResolveWorkdir(ctx, leaf.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != "" {
		t.Fatalf("只向上找一层，中层没设就该返回空串，实际 %q", got)
	}
}

func TestResolveWorkdirNotFound(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.ResolveWorkdir(ctx, "obj_does_not_exist"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在的对象应报 ErrNotFound，实际 %v", err)
	}
}

// TestWorkdirRoundTrip workdir 要能存进去、读出来、改掉、清空，并留下修订记录。
func TestWorkdirRoundTrip(t *testing.T) {
	s, ctx := newStore(t)

	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "project", Title: "工作台", Workdir: "/tmp/一开始",
	})
	if o.Workdir != "/tmp/一开始" {
		t.Fatalf("创建时的 workdir 没落库，实际 %q", o.Workdir)
	}
	got, err := s.GetObject(ctx, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Workdir != "/tmp/一开始" {
		t.Fatalf("GetObject 应带出 workdir，实际 %q", got.Workdir)
	}

	// 顺手校验前后空白被吃掉：用户从访达拷路径经常带一个尾随空格。
	up, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Workdir: pstr("  /tmp/改过了  ")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if up.Workdir != "/tmp/改过了" {
		t.Fatalf("改 workdir 没生效或没去空白，实际 %q", up.Workdir)
	}

	cleared, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Workdir: pstr("")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if cleared.Workdir != "" {
		t.Fatalf("空串应能清空 workdir，实际 %q", cleared.Workdir)
	}

	revs, err := s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("revisions: %v", err)
	}
	n := 0
	for _, r := range revs {
		if r.Field == "workdir" {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("改了两次 workdir，该有两条修订，实际 %d", n)
	}

	// ListObjects 也要带出来，列表页才能显示「这个项目的产出落在哪」。
	items, _, err := s.ListObjects(ctx, domain.ObjectFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) == 0 {
		t.Fatal("列表为空")
	}
}

// TestListObjectsCarriesWorkdir 单独盯一下列表口径：objectCols 少一列，
// scanObject 的参数顺序就会整体错位，那种错在别的字段上才暴露，极难查。
func TestListObjectsCarriesWorkdir(t *testing.T) {
	s, ctx := newStore(t)

	mustCreate(t, s, ctx, &domain.Object{TypeID: "project", Title: "带工作区", Workdir: "/tmp/w"})

	items, _, err := s.ListObjects(ctx, domain.ObjectFilter{Query: "带工作区"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	if items[0].Workdir != "/tmp/w" {
		t.Fatalf("ListObjects 应带出 workdir，实际 %q", items[0].Workdir)
	}
	if items[0].Title != "带工作区" {
		t.Fatalf("字段错位了：Title = %q", items[0].Title)
	}
}
