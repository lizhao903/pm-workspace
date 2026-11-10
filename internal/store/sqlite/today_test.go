// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"sort"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func todayCard(t *testing.T, td *domain.Today, key string) *domain.TodayCard {
	t.Helper()
	for _, c := range td.Cards {
		if c.Key == key {
			return c
		}
	}
	t.Fatalf("今日聚合里没有 %s 卡片", key)
	return nil
}

func cardObjectIDs(t *testing.T, c *domain.TodayCard) []string {
	t.Helper()
	items, ok := c.Items.([]*domain.Object)
	if !ok {
		t.Fatalf("%s 卡片的 items 应当是 []*Object，got %T", c.Key, c.Items)
	}
	ids := make([]string, 0, len(items))
	for _, o := range items {
		ids = append(ids, o.ID)
	}
	sort.Strings(ids)
	return ids
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestTodayMatchesCounts 守着今日页和侧栏徽标的口径：逾期、今天到期的条数
// 必须等于 counts.overdue / counts.today，全局和按类型收窄都一样；行本身也要和
// 列表接口按契约参数筛出来的一致。
func TestTodayMatchesCounts(t *testing.T) {
	s, ctx := newStore(t)
	now := time.Now()
	dayStart := startOfDay(now)
	dayEnd := dayStart.AddDate(0, 0, 1)
	past := dayStart.Add(-36 * time.Hour)
	todayAM := dayStart.Add(1 * time.Hour)
	todayPM := dayStart.Add(23 * time.Hour)
	future := dayStart.Add(72 * time.Hour)

	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "逾期", Status: "todo", DueAt: &past})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "逾期但已完成", Status: "done", DueAt: &past})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "今天凌晨", Status: "todo", DueAt: &todayAM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "今天深夜", Status: "doing", DueAt: &todayPM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "今天但已完成", Status: "done", DueAt: &todayAM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "将来", Status: "todo", DueAt: &future})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "没有截止日", Status: "todo"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "需求今天到期", DueAt: &todayPM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "需求逾期", DueAt: &past})
	// 归档、回收站里的不算，和 counts 的 liveCond 一致。
	arch := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "归档的逾期", Status: "todo", DueAt: &past})
	yes := true
	if _, err := s.UpdateObject(ctx, arch.ID, domain.ObjectPatch{Archived: &yes}, store.DefaultActor); err != nil {
		t.Fatalf("archive: %v", err)
	}
	del := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "删掉的今天", Status: "todo", DueAt: &todayAM})
	if err := s.DeleteObject(ctx, del.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("delete: %v", err)
	}

	for _, typeID := range []string{"", "task", "requirement", "doc"} {
		c, err := s.Counts(ctx, typeID)
		if err != nil {
			t.Fatalf("counts(%q): %v", typeID, err)
		}
		td, err := s.Today(ctx, typeID)
		if err != nil {
			t.Fatalf("today(%q): %v", typeID, err)
		}
		over := todayCard(t, td, domain.TodayCardOverdue)
		due := todayCard(t, td, domain.TodayCardDueToday)
		if over.Total != c.Overdue || len(cardObjectIDs(t, over)) != c.Overdue {
			t.Errorf("type=%q 逾期 total=%d items=%d，counts.overdue=%d", typeID, over.Total, len(cardObjectIDs(t, over)), c.Overdue)
		}
		if due.Total != c.Today || len(cardObjectIDs(t, due)) != c.Today {
			t.Errorf("type=%q 今天到期 total=%d items=%d，counts.today=%d", typeID, due.Total, len(cardObjectIDs(t, due)), c.Today)
		}

		// 行和契约里的列表参数筛出来的是同一批。
		var types []string
		if typeID != "" {
			types = []string{typeID}
		}
		want := func(f domain.ObjectFilter) []string {
			f.TypeIDs, f.Limit = types, 200
			items, _, err := s.ListObjects(ctx, f)
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			ids := []string{}
			for _, o := range items {
				ids = append(ids, o.ID)
			}
			sort.Strings(ids)
			return ids
		}
		if w := want(domain.ObjectFilter{Overdue: true}); !sameIDs(cardObjectIDs(t, over), w) {
			t.Errorf("type=%q 逾期卡片 %v，列表 overdue=true %v", typeID, cardObjectIDs(t, over), w)
		}
		if w := want(domain.ObjectFilter{DueAfter: &dayStart, DueBefore: &dayEnd, NotTerminal: true}); !sameIDs(cardObjectIDs(t, due), w) {
			t.Errorf("type=%q 今天到期卡片 %v，列表今日窗口 %v", typeID, cardObjectIDs(t, due), w)
		}
	}

	// 全局：逾期是待办一条加需求一条，今天到期是待办两条加需求一条。
	c, _ := s.Counts(ctx, "")
	if c.Overdue != 2 || c.Today != 3 {
		t.Errorf("夹具不对：overdue=%d today=%d，want 2 / 3", c.Overdue, c.Today)
	}
}

// review 状态的任务进等确认卡片，其他状态的不进；卡片按类型收窄时只有 task 有内容。
func TestTodayReviewCard(t *testing.T) {
	s, ctx := newStore(t)
	// updated_at 只到秒，排序断言靠显式给的时间，不靠先后创建。
	older, newer := time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour)
	r1 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "待验收一", Status: "review",
		CreatedAt: older, UpdatedAt: older})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "待验收三", Status: "review",
		CreatedAt: newer, UpdatedAt: newer})
	r2 := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "待验收二", Status: "todo"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "进行中", Status: "doing"})
	// 提交验收走的是改状态，改完要出现在卡片里。
	st := "review"
	if _, err := s.UpdateObject(ctx, r2.ID, domain.ObjectPatch{Status: &st}, store.DefaultActor); err != nil {
		t.Fatalf("submit review: %v", err)
	}
	gone := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "删掉的待验收", Status: "review"})
	if err := s.DeleteObject(ctx, gone.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("delete: %v", err)
	}

	td, err := s.Today(ctx, "")
	if err != nil {
		t.Fatalf("today: %v", err)
	}
	rv := todayCard(t, td, domain.TodayCardReview)
	items := rv.Items.([]*domain.Object)
	titles := []string{}
	for _, o := range items {
		titles = append(titles, o.Title)
	}
	// 待验收二刚改成 review，updated_at 是此刻，排第一；其余按 updated_at 倒序。
	if rv.Total != 3 || len(items) != 3 || items[0].ID != r2.ID || items[2].ID != r1.ID {
		t.Errorf("等确认 = %v (total %d)，want [待验收二 待验收三 待验收一]", titles, rv.Total)
	}

	td, err = s.Today(ctx, "requirement")
	if err != nil {
		t.Fatalf("today requirement: %v", err)
	}
	if rv := todayCard(t, td, domain.TodayCardReview); rv.Total != 0 {
		t.Errorf("按需求收窄时等确认应当为空，got %d", rv.Total)
	}

	// 卡片顺序：等确认、逾期、今天到期、运行中。
	keys := []string{}
	for _, c := range td.Cards {
		keys = append(keys, c.Key)
	}
	wantKeys := []string{domain.TodayCardReview, domain.TodayCardOverdue, domain.TodayCardDueToday, domain.TodayCardRunning}
	if !sameIDs(keys, wantKeys) {
		t.Errorf("卡片顺序 %v，want %v", keys, wantKeys)
	}
}

// 运行中只取没结束的执行，带上对象摘要。
func TestTodayRunningCard(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "跑脚本"})
	live, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/a", Status: domain.RunRunning})
	if err != nil {
		t.Fatal(err)
	}
	done, err := s.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/a", Status: domain.RunRunning})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishTaskRun(ctx, done.ID, domain.RunDone, 0, "ok", ""); err != nil {
		t.Fatal(err)
	}

	td, err := s.Today(ctx, "")
	if err != nil {
		t.Fatalf("today: %v", err)
	}
	rc := todayCard(t, td, domain.TodayCardRunning)
	runs, ok := rc.Items.([]*domain.TodayRun)
	if !ok {
		t.Fatalf("running items 应当是 []*TodayRun，got %T", rc.Items)
	}
	if rc.Total != 1 || len(runs) != 1 || runs[0].ID != live.ID {
		t.Fatalf("运行中 = %+v (total %d)，want 只有 %s", runs, rc.Total, live.ID)
	}
	if runs[0].ObjectRef != obj.Ref || runs[0].ObjectTitle != "跑脚本" || runs[0].ObjectType != "task" {
		t.Errorf("对象摘要没带上: %+v", runs[0])
	}

	td, err = s.Today(ctx, "requirement")
	if err != nil {
		t.Fatal(err)
	}
	if rc := todayCard(t, td, domain.TodayCardRunning); rc.Total != 0 {
		t.Errorf("按需求收窄时运行中应当为空，got %d", rc.Total)
	}
}

// 条数超过上限时 items 截断，total 仍是全量，和 counts 相等。
func TestTodayCardLimit(t *testing.T) {
	s, ctx := newStore(t)
	past := startOfDay(time.Now()).Add(-24 * time.Hour)
	for i := 0; i < domain.TodayCardLimit+3; i++ {
		mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "逾期", Status: "todo", DueAt: &past})
	}
	td, err := s.Today(ctx, "task")
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Counts(ctx, "task")
	if err != nil {
		t.Fatal(err)
	}
	over := todayCard(t, td, domain.TodayCardOverdue)
	if over.Total != c.Overdue || over.Total != domain.TodayCardLimit+3 {
		t.Errorf("total = %d，counts.overdue = %d", over.Total, c.Overdue)
	}
	if n := len(over.Items.([]*domain.Object)); n != domain.TodayCardLimit {
		t.Errorf("items = %d，want %d", n, domain.TodayCardLimit)
	}
}
