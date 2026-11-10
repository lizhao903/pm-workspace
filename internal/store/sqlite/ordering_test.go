// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"fmt"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// idgen 的前 10 个字符编码毫秒时间戳，后面是 4 字节随机尾巴。同一毫秒生成的两个 id
// 前缀完全相同，大小关系由随机位决定——所以 id 不能当「写入先后」的 tiebreak 用。
// 而 created_at 存的是秒级 RFC3339，同一秒内的记录在它上面本来就是平的。
//
// 修订历史是日报周报和周期时间这类度量的唯一数据源，顺序错了算出来的东西全错，
// 但每个数字看起来都合理，不会有人发现。所以这里的 tiebreak 必须是 rowid：
// 它按插入顺序单调递增，表达的正是「谁先写进去」。

// 一次多字段更新会为每个变化的字段各写一条修订，且共用同一个 created_at 字符串——
// 这不是低概率竞态，是每次多字段更新都必然发生的平局。
func TestRevisionOrderWithinOneUpdate(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "原标题", Status: "todo", Priority: "P2",
	})
	sh, err := s.CreateStakeholder(ctx, &domain.Stakeholder{Name: "张三"})
	if err != nil {
		t.Fatalf("create stakeholder: %v", err)
	}

	due := time.Now().Add(72 * time.Hour)
	if _, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{
		Title:    pstr("新标题"),
		Body:     pstr("新正文"),
		Priority: pstr("P0"),
		OwnerID:  pstr(sh.ID),
		Source:   pstr("ui"),
		Status:   pstr("doing"),
		DueAt:    ppTime(&due),
		Props:    &map[string]any{"k": "v"},
	}, store.DefaultActor); err != nil {
		t.Fatalf("update: %v", err)
	}

	revs, err := s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	// created 那条最早，其余 8 条来自这次更新。
	if len(revs) != 9 {
		t.Fatalf("revisions = %d, want 9", len(revs))
	}

	// 这次更新写入的字段顺序（见 UpdateObject 里 revs 的收集顺序）。
	writeOrder := []string{"title", "body", "priority", "owner_id", "source", "status", "due_at", "props"}
	// 读回来是倒序，所以期望是写入顺序的反转，最后再跟上 created。
	want := make([]string, 0, len(revs))
	for i := len(writeOrder) - 1; i >= 0; i-- {
		want = append(want, writeOrder[i])
	}
	want = append(want, "created")

	got := make([]string, 0, len(revs))
	for _, r := range revs {
		got = append(got, r.Field)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("修订顺序错乱\n got = %v\nwant = %v\n"+
				"（同一次更新的多条修订 created_at 完全相同，"+
				"tiebreak 用 id 的话顺序由随机位决定）", got, want)
		}
	}

	// 同一次更新里所有修订的 created_at 必须真的相等，否则这条测试没测到平局。
	for i := 0; i < len(revs)-1; i++ {
		if revs[i].Field == "created" || revs[i+1].Field == "created" {
			continue
		}
		if !revs[i].CreatedAt.Equal(revs[i+1].CreatedAt) {
			t.Fatalf("前提不成立：%s 与 %s 的 created_at 不同，本测试没有制造出平局",
				revs[i].Field, revs[i+1].Field)
		}
	}
}

// 连续快速更新：不加 sleep，循环里连写，正是撞同一毫秒/同一秒的方式。
func TestRevisionOrderAcrossRapidUpdates(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "v0"})

	const n = 30
	for i := 1; i <= n; i++ {
		if _, err := s.UpdateObject(ctx, o.ID,
			domain.ObjectPatch{Title: pstr(fmt.Sprintf("v%d", i))}, store.DefaultActor); err != nil {
			t.Fatalf("update %d: %v", i, err)
		}
	}

	revs, err := s.ListRevisions(ctx, o.ID, revisionLimitMax)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	if len(revs) != n+1 {
		t.Fatalf("revisions = %d, want %d", len(revs), n+1)
	}

	// 倒序读回：第 i 条应当是 v(n-i) -> v(n-i+1) 这次改动。
	for i := 0; i < n; i++ {
		wantNew := fmt.Sprintf("v%d", n-i)
		if revs[i].Field != "title" {
			t.Fatalf("第 %d 条 field = %s, want title", i, revs[i].Field)
		}
		if revs[i].NewValue != wantNew {
			t.Fatalf("第 %d 条 new_value = %s, want %s\n"+
				"（连续更新落在同一秒，created_at 相同，顺序全靠 tiebreak）",
				i, revs[i].NewValue, wantNew)
		}
	}
	if revs[n].Field != "created" {
		t.Errorf("最后一条应是 created, got %s", revs[n].Field)
	}
}

// 全局最近变更是日报的数据源，跨对象也要保证同刻写入的先后。
func TestRecentRevisionsOrder(t *testing.T) {
	s, ctx := newStore(t)

	const n = 25
	titles := make([]string, 0, n)
	for i := 0; i < n; i++ {
		title := fmt.Sprintf("对象-%02d", i)
		mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: title})
		titles = append(titles, title)
	}

	revs, err := s.RecentRevisions(ctx, revisionLimitMax)
	if err != nil {
		t.Fatalf("recent revisions: %v", err)
	}
	if len(revs) != n {
		t.Fatalf("revisions = %d, want %d", len(revs), n)
	}
	for i, r := range revs {
		want := titles[n-1-i]
		if r.NewValue != want {
			t.Fatalf("第 %d 条 = %s, want %s（同刻创建的多个对象，顺序全靠 tiebreak）",
				i, r.NewValue, want)
		}
	}
}

// 备份导出的关联顺序要可重现：同一秒建的多条 link 不能每次导出都换个次序，
// 否则两次备份文件的 diff 会出现纯噪音。
func TestBackupLinkOrderIsInsertionOrder(t *testing.T) {
	s, ctx := newStore(t)
	hub := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "主需求"})

	const n = 20
	wantTo := make([]string, 0, n)
	for i := 0; i < n; i++ {
		peer := mustCreate(t, s, ctx, &domain.Object{
			TypeID: "task", Title: fmt.Sprintf("任务-%02d", i)})
		if _, err := s.CreateLink(ctx, hub.ID, peer.ID, domain.RelRelates, ""); err != nil {
			t.Fatalf("create link %d: %v", i, err)
		}
		wantTo = append(wantTo, peer.ID)
	}

	links, err := s.allLinks(ctx)
	if err != nil {
		t.Fatalf("all links: %v", err)
	}
	if len(links) != n {
		t.Fatalf("links = %d, want %d", len(links), n)
	}
	for i, l := range links {
		if l.ToID != wantTo[i] {
			t.Fatalf("第 %d 条关联顺序不是写入顺序（同一秒创建，created_at 相同）", i)
		}
	}

	// 详情面板读的是 ListLinks，同样要按写入顺序稳定返回。
	views, err := s.ListLinks(ctx, hub.ID)
	if err != nil {
		t.Fatalf("list links: %v", err)
	}
	if len(views) != n {
		t.Fatalf("link views = %d, want %d", len(views), n)
	}
	for i, v := range views {
		if v.ToID != wantTo[i] {
			t.Fatalf("ListLinks 第 %d 条不是写入顺序（原来只按 created_at 排，平局时无任何保证）", i)
		}
	}

	// 连续导出两次必须完全一致，备份 diff 里不该出现顺序噪音。
	again, err := s.allLinks(ctx)
	if err != nil {
		t.Fatalf("all links again: %v", err)
	}
	for i := range links {
		if links[i].ID != again[i].ID {
			t.Fatalf("两次导出顺序不一致，第 %d 条不同", i)
		}
	}
}

// ppTime 构造 ObjectPatch 的双指针时间字段。
func ppTime(t *time.Time) **time.Time { return &t }
