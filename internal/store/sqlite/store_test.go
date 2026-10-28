package sqlite

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

func newStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "workspace.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	// 服务商密钥要进保险箱：和 store 共用连接，主密钥随机生成。
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	v, err := vault.New(s.db, key)
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	if _, err := s.AttachVault(ctx, v); err != nil {
		t.Fatalf("attach vault: %v", err)
	}
	return s, ctx
}

func mustCreate(t *testing.T, s *Store, ctx context.Context, o *domain.Object) *domain.Object {
	t.Helper()
	out, err := s.CreateObject(ctx, o, store.DefaultActor)
	if err != nil {
		t.Fatalf("create object %q: %v", o.Title, err)
	}
	return out
}

func pstr(s string) *string { return &s }

// ppstr 构造 ObjectPatch 的双指针：传 nil 表示置空，传值表示改成该值。
func ppstr(p *string) **string { return &p }

func TestOpenRunsMigrationsAndSeedsBuiltins(t *testing.T) {
	s, ctx := newStore(t)

	types, err := s.ListObjectTypes(ctx)
	if err != nil {
		t.Fatalf("list types: %v", err)
	}
	if len(types) != 6 {
		t.Fatalf("want 6 builtin types, got %d", len(types))
	}
	want := map[string]string{
		"requirement": "REQ", "task": "TSK", "project": "PRJ",
		"doc": "DOC", "resource": "RES", "note": "NOTE",
	}
	for _, ty := range types {
		prefix, ok := want[ty.ID]
		if !ok {
			t.Fatalf("unexpected type %s", ty.ID)
		}
		if ty.RefPrefix != prefix {
			t.Errorf("type %s: ref_prefix = %q, want %q", ty.ID, ty.RefPrefix, prefix)
		}
		if !ty.Builtin {
			t.Errorf("type %s should be builtin", ty.ID)
		}
		if len(ty.Statuses) == 0 {
			t.Errorf("type %s has no statuses", ty.ID)
		}
	}

	cats, err := s.ListCategories(ctx, "requirement", false)
	if err != nil {
		t.Fatalf("list categories: %v", err)
	}
	if len(cats) != 8 {
		t.Fatalf("want 8 requirement categories, got %d", len(cats))
	}
	if _, err := s.GetCategory(ctx, "cat_req_prod_cloud"); err != nil {
		t.Fatalf("seeded child category missing: %v", err)
	}

	tree, err := s.CategoryTree(ctx, "requirement", true)
	if err != nil {
		t.Fatalf("category tree: %v", err)
	}
	if len(tree) != 4 {
		t.Fatalf("want 4 root categories, got %d", len(tree))
	}
	if tree[0].ID != "cat_req_prod" || len(tree[0].Children) != 2 {
		t.Fatalf("unexpected first root %+v", tree[0])
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "workspace.db")

	s1, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	s2, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer func() { _ = s2.Close() }()

	types, err := s2.ListObjectTypes(ctx)
	if err != nil {
		t.Fatalf("list types: %v", err)
	}
	if len(types) != 6 {
		t.Fatalf("migrations re-applied: got %d types", len(types))
	}
}

func TestCreateObjectAssignsRefAndWritesRevision(t *testing.T) {
	s, ctx := newStore(t)

	first := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "多租户组织架构"})
	second := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "用量计费"})
	task := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写权限矩阵"})

	if first.Ref != "REQ-0001" {
		t.Errorf("first ref = %q, want REQ-0001", first.Ref)
	}
	if second.Ref != "REQ-0002" {
		t.Errorf("second ref = %q, want REQ-0002", second.Ref)
	}
	if task.Ref != "TSK-0001" {
		t.Errorf("task ref = %q, want TSK-0001", task.Ref)
	}
	// 状态缺省取该类型的第一个状态。
	if first.Status != "inbox" {
		t.Errorf("default status = %q, want inbox", first.Status)
	}

	revs, err := s.ListRevisions(ctx, first.ID, 0)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	if len(revs) != 1 || revs[0].Field != "created" {
		t.Fatalf("want one 'created' revision, got %+v", revs)
	}
	if revs[0].NewValue != "多租户组织架构" {
		t.Errorf("created revision new_value = %q", revs[0].NewValue)
	}
}

func TestUpdateObjectRecordsOnlyChangedFields(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "多租户", Priority: "P1", Status: "backlog",
	})

	updated, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{
		Title:    pstr("多租户组织架构"),
		Priority: pstr("P1"), // 没变，不该进修订
		Status:   pstr("doing"),
	}, store.DefaultActor)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Title != "多租户组织架构" || updated.Status != "doing" {
		t.Fatalf("update not applied: %+v", updated)
	}
	if updated.StartedAt == nil {
		t.Error("started_at should be set when leaving the initial status")
	}

	revs, err := s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	fields := map[string]bool{}
	for _, r := range revs {
		fields[r.Field] = true
	}
	if !fields["title"] || !fields["status"] || !fields["created"] {
		t.Errorf("missing expected revisions: %v", fields)
	}
	if fields["priority"] {
		t.Error("unchanged priority must not produce a revision")
	}
	if len(revs) != 3 {
		t.Errorf("want 3 revisions (created/title/status), got %d", len(revs))
	}

	// 进终态自动补完成时间。
	done, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Status: pstr("done")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("update to terminal: %v", err)
	}
	if done.CompletedAt == nil {
		t.Error("completed_at should be set on terminal status")
	}
}

func TestUpdateObjectRejectsUnknownStatus(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "写周报"})

	_, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Status: pstr("published")}, store.DefaultActor)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("want ErrValidation, got %v", err)
	}
	if _, err := s.CreateObject(ctx, &domain.Object{
		TypeID: "task", Title: "非法状态", Status: "nope",
	}, store.DefaultActor); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("create with bad status: want ErrValidation, got %v", err)
	}
}

func TestObjectPatchClearsNullableFields(t *testing.T) {
	s, ctx := newStore(t)
	due := time.Now().Add(48 * time.Hour)
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "离线草稿",
		CategoryID: pstr("cat_req_prod_local"), DueAt: &due,
	})
	if o.CategoryID == nil || o.DueAt == nil {
		t.Fatalf("setup failed: %+v", o)
	}

	// 双指针指向 nil：置空；nil 本身：不改。
	cleared, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{
		CategoryID: ppstr(nil),
		DueAt:      new(*time.Time),
	}, store.DefaultActor)
	if err != nil {
		t.Fatalf("clear fields: %v", err)
	}
	if cleared.CategoryID != nil {
		t.Errorf("category_id = %v, want nil", *cleared.CategoryID)
	}
	if cleared.DueAt != nil {
		t.Errorf("due_at = %v, want nil", *cleared.DueAt)
	}

	untouched, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: pstr("离线草稿与冲突合并")}, store.DefaultActor)
	if err != nil {
		t.Fatalf("update title: %v", err)
	}
	if untouched.CategoryID != nil {
		t.Error("nil patch field must not resurrect a cleared value")
	}

	back, err := s.UpdateObject(ctx, o.ID, domain.ObjectPatch{
		CategoryID: ppstr(pstr("cat_req_prod_cloud")),
	}, store.DefaultActor)
	if err != nil {
		t.Fatalf("reassign category: %v", err)
	}
	if back.CategoryID == nil || *back.CategoryID != "cat_req_prod_cloud" {
		t.Fatalf("category not reassigned: %+v", back.CategoryID)
	}
	if back.CategoryName != "云端平台" {
		t.Errorf("category_name = %q, want 云端平台", back.CategoryName)
	}
	if back.CategoryPath != "/product/cloud/" {
		t.Errorf("category_path = %q", back.CategoryPath)
	}
}

func TestListObjectsCategorySubtree(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "多租户", CategoryID: pstr("cat_req_prod_cloud"),
	})

	sub, total, err := s.ListObjects(ctx, domain.ObjectFilter{
		CategoryID: "cat_req_prod", CategorySubtree: true,
	})
	if err != nil {
		t.Fatalf("subtree query: %v", err)
	}
	if total != 1 || len(sub) != 1 {
		t.Fatalf("subtree query: got %d items / total %d, want 1", len(sub), total)
	}
	if sub[0].CategoryPath != "/product/cloud/" {
		t.Errorf("category_path = %q", sub[0].CategoryPath)
	}

	direct, total, err := s.ListObjects(ctx, domain.ObjectFilter{CategoryID: "cat_req_prod"})
	if err != nil {
		t.Fatalf("direct query: %v", err)
	}
	if total != 0 || len(direct) != 0 {
		t.Fatalf("direct query should not match child category, got %d", len(direct))
	}
}

func TestMoveCategoryCascadesAndRejectsCycle(t *testing.T) {
	s, ctx := newStore(t)

	grand, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", ParentID: pstr("cat_req_prod_cloud"), Name: "计费", Slug: "billing",
	})
	if err != nil {
		t.Fatalf("create child category: %v", err)
	}
	if grand.Path != "/product/cloud/billing/" || grand.Depth != 2 {
		t.Fatalf("child path/depth wrong: %q %d", grand.Path, grand.Depth)
	}

	// 把 /product/cloud/ 整棵挪到 /tech/ 下面。
	moved, err := s.MoveCategory(ctx, "cat_req_prod_cloud", pstr("cat_req_tech"), 5)
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if moved.Path != "/tech/cloud/" || moved.Depth != 1 {
		t.Fatalf("moved path/depth wrong: %q %d", moved.Path, moved.Depth)
	}
	after, err := s.GetCategory(ctx, grand.ID)
	if err != nil {
		t.Fatalf("get child: %v", err)
	}
	if after.Path != "/tech/cloud/billing/" {
		t.Errorf("descendant path not cascaded: %q", after.Path)
	}
	if after.Depth != 2 {
		t.Errorf("descendant depth = %d, want 2", after.Depth)
	}

	if _, err := s.MoveCategory(ctx, "cat_req_tech", pstr(grand.ID), 0); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("moving into own subtree: want ErrConflict, got %v", err)
	}
	if _, err := s.MoveCategory(ctx, "cat_req_tech", pstr("cat_req_tech"), 0); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("moving into itself: want ErrConflict, got %v", err)
	}

	// 移到根。
	root, err := s.MoveCategory(ctx, "cat_req_prod_cloud", nil, 0)
	if err != nil {
		t.Fatalf("move to root: %v", err)
	}
	if root.Path != "/cloud/" || root.Depth != 0 || root.ParentID != nil {
		t.Fatalf("move to root wrong: %+v", root)
	}
}

func TestCreateCategoryConflictOnDuplicateSlug(t *testing.T) {
	s, ctx := newStore(t)
	_, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", ParentID: pstr("cat_req_prod"), Name: "云端平台", Slug: "cloud",
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}

	// 中文名原样进 slug，不该和别的分类撞。
	c, err := s.CreateCategory(ctx, &domain.Category{TypeID: "requirement", Name: "增长实验"})
	if err != nil {
		t.Fatalf("create chinese-named category: %v", err)
	}
	if c.Slug != "增长实验" || c.Path != "/增长实验/" {
		t.Fatalf("chinese slug wrong: slug=%q path=%q", c.Slug, c.Path)
	}

	// 清洗后真的空了（纯标点/空白）才回落随机短串。
	blank, err := s.CreateCategory(ctx, &domain.Category{TypeID: "requirement", Name: "///"})
	if err != nil {
		t.Fatalf("create punctuation-only category: %v", err)
	}
	if blank.Slug == "" || blank.Path != "/"+blank.Slug+"/" {
		t.Fatalf("fallback slug wrong: %+v", blank)
	}
}

func TestChineseSlugKeepsSubtreeQueryWorking(t *testing.T) {
	s, ctx := newStore(t)

	parent, err := s.CreateCategory(ctx, &domain.Category{TypeID: "requirement", Name: "增长 实验"})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	if parent.Slug != "增长-实验" || parent.Path != "/增长-实验/" {
		t.Fatalf("parent slug/path wrong: slug=%q path=%q", parent.Slug, parent.Path)
	}

	child, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", ParentID: &parent.ID, Name: "拉新渠道",
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if child.Path != "/增长-实验/拉新渠道/" || child.Depth != 1 {
		t.Fatalf("child path/depth wrong: %q %d", child.Path, child.Depth)
	}

	// 同层同 slug 的唯一索引对中文照样生效。
	if _, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", ParentID: &parent.ID, Name: "拉新渠道",
	}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate chinese slug: want ErrConflict, got %v", err)
	}

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "邀请裂变", CategoryID: &child.ID,
	})

	sub, total, err := s.ListObjects(ctx, domain.ObjectFilter{
		CategoryID: parent.ID, CategorySubtree: true,
	})
	if err != nil {
		t.Fatalf("subtree query: %v", err)
	}
	if total != 1 || len(sub) != 1 {
		t.Fatalf("chinese-path subtree query: got %d, want 1", total)
	}
	if sub[0].CategoryPath != "/增长-实验/拉新渠道/" {
		t.Errorf("category_path = %q", sub[0].CategoryPath)
	}

	// 中文 path 的级联平移也要正常。
	if _, err := s.MoveCategory(ctx, parent.ID, pstr("cat_req_prod"), 0); err != nil {
		t.Fatalf("move chinese category: %v", err)
	}
	moved, err := s.GetCategory(ctx, child.ID)
	if err != nil {
		t.Fatalf("get child: %v", err)
	}
	if moved.Path != "/product/增长-实验/拉新渠道/" || moved.Depth != 2 {
		t.Fatalf("cascade over chinese path wrong: %q %d", moved.Path, moved.Depth)
	}
}

// slug 允许中文后也就允许了 % 和 _，物化路径的 LIKE 前缀匹配必须转义，否则级联会误伤旁支。
func TestSlugWithLikeWildcardsDoesNotLeakAcrossBranches(t *testing.T) {
	s, ctx := newStore(t)

	wild, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", Name: "折扣", Slug: "a_b",
	})
	if err != nil {
		t.Fatalf("create wildcard slug category: %v", err)
	}
	// axb 会被没转义的 'a_b%' 匹配上。
	sibling, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", Name: "旁支", Slug: "axb",
	})
	if err != nil {
		t.Fatalf("create sibling: %v", err)
	}

	if _, err := s.MoveCategory(ctx, wild.ID, pstr("cat_req_prod"), 0); err != nil {
		t.Fatalf("move: %v", err)
	}
	after, err := s.GetCategory(ctx, sibling.ID)
	if err != nil {
		t.Fatalf("get sibling: %v", err)
	}
	if after.Path != "/axb/" || after.Depth != 0 {
		t.Fatalf("sibling was dragged along by an unescaped LIKE: %q depth=%d", after.Path, after.Depth)
	}

	if err := s.DeleteCategory(ctx, wild.ID, nil); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetCategory(ctx, sibling.ID); err != nil {
		t.Fatalf("sibling must survive deletion of a wildcard-slug branch: %v", err)
	}
}

func TestDeleteCategoryReassignsObjects(t *testing.T) {
	s, ctx := newStore(t)
	child, err := s.CreateCategory(ctx, &domain.Category{
		TypeID: "requirement", ParentID: pstr("cat_req_prod_cloud"), Name: "计费", Slug: "billing",
	})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	onParent := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "多租户", CategoryID: pstr("cat_req_prod_cloud"),
	})
	onChild := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "账单导出", CategoryID: pstr(child.ID),
	})

	if err := s.DeleteCategory(ctx, "cat_req_prod_cloud", pstr("cat_req_tech")); err != nil {
		t.Fatalf("delete with reassign: %v", err)
	}
	if _, err := s.GetCategory(ctx, child.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("descendant category should be gone, got %v", err)
	}
	for _, id := range []string{onParent.ID, onChild.ID} {
		got, err := s.GetObject(ctx, id)
		if err != nil {
			t.Fatalf("get object: %v", err)
		}
		if got.CategoryID == nil || *got.CategoryID != "cat_req_tech" {
			t.Errorf("object %s not reassigned: %v", got.Ref, got.CategoryID)
		}
	}

	// 不给 reassignTo 时置为未分类。
	orphan := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "性能优化", CategoryID: pstr("cat_req_tech_perf"),
	})
	if err := s.DeleteCategory(ctx, "cat_req_tech_perf", nil); err != nil {
		t.Fatalf("delete without reassign: %v", err)
	}
	got, err := s.GetObject(ctx, orphan.ID)
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	if got.CategoryID != nil {
		t.Errorf("object should be uncategorized, got %v", *got.CategoryID)
	}
}

func TestListObjectsTagsUseAndSemantics(t *testing.T) {
	s, ctx := newStore(t)
	both := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "多租户", Tags: []string{"云端平台", "P0 冲刺"},
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "离线草稿", Tags: []string{"本地客户端", "P0 冲刺"},
	})

	one, total, err := s.ListObjects(ctx, domain.ObjectFilter{Tags: []string{"P0 冲刺"}})
	if err != nil {
		t.Fatalf("single tag: %v", err)
	}
	if total != 2 || len(one) != 2 {
		t.Fatalf("single tag: got %d, want 2", total)
	}

	andQuery, total, err := s.ListObjects(ctx, domain.ObjectFilter{Tags: []string{"P0 冲刺", "云端平台"}})
	if err != nil {
		t.Fatalf("tag AND: %v", err)
	}
	if total != 1 || len(andQuery) != 1 || andQuery[0].ID != both.ID {
		t.Fatalf("tag AND should match only the object carrying both, got %d", total)
	}
	if len(andQuery[0].Tags) != 2 {
		t.Errorf("tags not filled: %v", andQuery[0].Tags)
	}

	none, total, err := s.ListObjects(ctx, domain.ObjectFilter{Tags: []string{"云端平台", "本地客户端"}})
	if err != nil {
		t.Fatalf("tag AND miss: %v", err)
	}
	if total != 0 || len(none) != 0 {
		t.Fatalf("disjoint tags should match nothing, got %d", total)
	}
}

func TestCountsOverdueAndStalled(t *testing.T) {
	s, ctx := newStore(t)
	now := time.Now()
	past := now.Add(-48 * time.Hour)
	future := now.Add(48 * time.Hour)

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "逾期待办", Status: "todo", DueAt: &past,
	})
	// 已完成的逾期项不该计入，终态从 statuses 的 JSON 里读。
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "逾期但已完成", Status: "done", DueAt: &past,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "未来待办", Status: "todo", DueAt: &future,
	})
	stale := now.Add(-20 * 24 * time.Hour)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "长期无进展", Status: "backlog",
		CreatedAt: stale, UpdatedAt: stale,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "note", Title: "随手记", Source: "inbox",
	})

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Overdue != 1 {
		t.Errorf("overdue = %d, want 1", c.Overdue)
	}
	if c.Stalled != 1 {
		t.Errorf("stalled = %d, want 1", c.Stalled)
	}
	if c.Week != 1 {
		t.Errorf("week = %d, want 1", c.Week)
	}
	if c.Total != 5 {
		t.Errorf("total = %d, want 5", c.Total)
	}
	if c.ByType["task"] != 3 {
		t.Errorf("by_type[task] = %d, want 3", c.ByType["task"])
	}
	// by_status 的 key 是 "<type_id>:<status>"：需求和待办都有 doing，裸 key 会把两者加在一起。
	if c.ByStatus["task:todo"] != 2 {
		t.Errorf("by_status[task:todo] = %d, want 2", c.ByStatus["task:todo"])
	}
	if c.ByStatus["requirement:backlog"] != 1 {
		t.Errorf("by_status[requirement:backlog] = %d, want 1", c.ByStatus["requirement:backlog"])
	}
	if _, ok := c.ByStatus["todo"]; ok {
		t.Error("by_status must not contain bare status keys")
	}
	// 未分类的对象一律进收件箱。
	if c.Inbox != 5 {
		t.Errorf("inbox = %d, want 5", c.Inbox)
	}
}

func TestSoftDeleteRestoreAndFilters(t *testing.T) {
	s, ctx := newStore(t)
	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "临时事项"})

	if err := s.DeleteObject(ctx, o.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if _, total, _ := s.ListObjects(ctx, domain.ObjectFilter{}); total != 0 {
		t.Errorf("deleted object must be hidden by default, total = %d", total)
	}
	if _, total, _ := s.ListObjects(ctx, domain.ObjectFilter{IncludeDeleted: true}); total != 1 {
		t.Errorf("IncludeDeleted should surface it, total = %d", total)
	}

	if _, err := s.RestoreObject(ctx, o.ID, store.DefaultActor); err != nil {
		t.Fatalf("restore: %v", err)
	}
	revs, err := s.ListRevisions(ctx, o.ID, 0)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	fields := map[string]bool{}
	for _, r := range revs {
		fields[r.Field] = true
	}
	if !fields["deleted"] || !fields["restored"] {
		t.Errorf("want deleted+restored revisions, got %v", fields)
	}

	if err := s.DeleteObject(ctx, o.ID, true, store.DefaultActor); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	if _, err := s.GetObject(ctx, o.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("want ErrNotFound after hard delete, got %v", err)
	}
}

func TestObjectTypeReadOnlyRules(t *testing.T) {
	s, ctx := newStore(t)

	if err := s.DeleteObjectType(ctx, "requirement"); !errors.Is(err, domain.ErrReadOnly) {
		t.Fatalf("delete builtin: want ErrReadOnly, got %v", err)
	}
	if _, err := s.UpdateObjectType(ctx, "requirement", domain.ObjectTypePatch{
		Name: pstr("需求单"),
	}); !errors.Is(err, domain.ErrReadOnly) {
		t.Fatalf("rename builtin: want ErrReadOnly, got %v", err)
	}
	if _, err := s.UpdateObjectType(ctx, "requirement", domain.ObjectTypePatch{
		Icon: pstr("flag"),
	}); err != nil {
		t.Fatalf("icon on builtin should be allowed: %v", err)
	}

	custom, err := s.CreateObjectType(ctx, &domain.ObjectType{
		ID: "okr", Name: "目标", Plural: "目标", RefPrefix: "okr", SortOrder: 70,
		Statuses: []domain.Status{{Key: "open", Label: "进行中"}, {Key: "closed", Label: "已结束", Terminal: true}},
	})
	if err != nil {
		t.Fatalf("create custom type: %v", err)
	}
	if custom.RefPrefix != "OKR" || custom.Builtin {
		t.Fatalf("custom type wrong: %+v", custom)
	}

	o := mustCreate(t, s, ctx, &domain.Object{TypeID: "okr", Title: "Q4 北极星指标"})
	if o.Ref != "OKR-0001" {
		t.Errorf("ref = %q, want OKR-0001", o.Ref)
	}
	if err := s.DeleteObjectType(ctx, "okr"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete type with objects: want ErrConflict, got %v", err)
	}
	if err := s.DeleteObject(ctx, o.ID, true, store.DefaultActor); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	if err := s.DeleteObjectType(ctx, "okr"); err != nil {
		t.Fatalf("delete empty custom type: %v", err)
	}
}

func TestListObjectsSortAndQuery(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "无优先级"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "次要事项", Priority: "P2"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "紧急事项", Priority: "P0"})

	items, _, err := s.ListObjects(ctx, domain.ObjectFilter{Sort: "priority"})
	if err != nil {
		t.Fatalf("sort by priority: %v", err)
	}
	if len(items) != 3 || items[0].Priority != "P0" || items[1].Priority != "P2" || items[2].Priority != "" {
		t.Fatalf("priority order wrong: %v %v %v", items[0].Priority, items[1].Priority, items[2].Priority)
	}

	// 非法排序键回落到 -updated_at，不该报错。
	if _, _, err := s.ListObjects(ctx, domain.ObjectFilter{Sort: "title; DROP TABLE objects"}); err != nil {
		t.Fatalf("illegal sort should fall back: %v", err)
	}

	// LIKE 通配符要当普通字符处理。
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "折扣 100% 复核"})
	hits, total, err := s.ListObjects(ctx, domain.ObjectFilter{Query: "100%"})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if total != 1 || len(hits) != 1 {
		t.Fatalf("escaped like: got %d, want 1", total)
	}
	if _, total, _ = s.ListObjects(ctx, domain.ObjectFilter{Query: "%"}); total != 1 {
		t.Errorf("bare %% should be literal, matched %d", total)
	}
}

func TestSeedDemoIsIdempotent(t *testing.T) {
	s, ctx := newStore(t)

	if err := s.SeedDemo(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, total, err := s.ListObjects(ctx, domain.ObjectFilter{Limit: maxLimit})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 20 {
		t.Fatalf("seeded %d objects, want 20", total)
	}

	if err := s.SeedDemo(ctx); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	if _, again, _ := s.ListObjects(ctx, domain.ObjectFilter{Limit: maxLimit}); again != total {
		t.Fatalf("second seed changed the count: %d -> %d", total, again)
	}

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Overdue < 2 {
		t.Errorf("seed should contain at least 2 overdue items, got %d", c.Overdue)
	}
	if c.Today < 2 {
		t.Errorf("seed should contain at least 2 items due today, got %d", c.Today)
	}
	if c.Stalled < 2 {
		t.Errorf("seed should contain at least 2 stalled items, got %d", c.Stalled)
	}

	// 快捷访问要保持空态引导，种子不该预置假链接。
	if sc, err := s.ListShortcuts(ctx); err != nil || len(sc) != 0 {
		t.Fatalf("SeedDemo must not seed shortcuts: got %d (err %v)", len(sc), err)
	}

	tags, err := s.ListTags(ctx)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(tags) != 4 {
		t.Fatalf("want 4 seeded tags, got %d", len(tags))
	}

	reqs, _, err := s.ListObjects(ctx, domain.ObjectFilter{
		TypeIDs: []string{"requirement"}, Query: "多租户组织架构",
	})
	if err != nil || len(reqs) == 0 {
		t.Fatalf("seeded requirement missing: %v", err)
	}
	links, err := s.ListLinks(ctx, reqs[0].ID)
	if err != nil {
		t.Fatalf("list links: %v", err)
	}
	if len(links) < 4 {
		t.Fatalf("want at least 4 links on the flagship requirement, got %d", len(links))
	}
	var sawIn, sawOut bool
	for _, l := range links {
		if l.Peer == nil {
			t.Fatalf("link %s has no peer", l.ID)
		}
		if l.Direction == "in" {
			sawIn = true
		} else {
			sawOut = true
		}
	}
	if !sawIn || !sawOut {
		t.Errorf("want both link directions, in=%v out=%v", sawIn, sawOut)
	}
}

func TestStatsReportsPathAndSize(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{TypeID: "note", Title: "随手记"})

	st, err := s.Stats(ctx)
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st["db_path"] == "" {
		t.Error("db_path is empty")
	}
	if size, _ := st["db_size"].(int64); size <= 0 {
		t.Errorf("db_size = %v, want > 0", st["db_size"])
	}
	if st["objects"] != 1 {
		t.Errorf("objects = %v, want 1", st["objects"])
	}
	if st["version"] != Version {
		t.Errorf("version = %v, want %s", st["version"], Version)
	}
	if st["last_write"] == nil {
		t.Error("last_write should be set after a write")
	}
}

// 需求和待办都有 doing，复合 key 必须把两者分开计。
func TestCountsByStatusSeparatesTypesWithSharedStatusKeys(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "需求在做", Status: "doing"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "待办在做一", Status: "doing"})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "待办在做二", Status: "doing"})

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.ByStatus["requirement:doing"] != 1 {
		t.Errorf("by_status[requirement:doing] = %d, want 1", c.ByStatus["requirement:doing"])
	}
	if c.ByStatus["task:doing"] != 2 {
		t.Errorf("by_status[task:doing] = %d, want 2", c.ByStatus["task:doing"])
	}
	if _, ok := c.ByStatus["doing"]; ok {
		t.Error("by_status must be keyed by <type_id>:<status>")
	}
}

// 分类色跟着对象一起带出来，列表行的色点不用前端再去分类树里查。
func TestObjectCarriesCategoryColor(t *testing.T) {
	s, ctx := newStore(t)
	cat, err := s.GetCategory(ctx, "cat_req_prod")
	if err != nil {
		t.Fatalf("get category: %v", err)
	}
	if cat.Color == "" {
		t.Fatal("seeded category should have a color")
	}
	o := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "多租户", CategoryID: pstr("cat_req_prod"),
	})
	if o.CategoryColor != cat.Color {
		t.Errorf("CreateObject: category_color = %q, want %q", o.CategoryColor, cat.Color)
	}

	got, err := s.GetObject(ctx, o.ID)
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	if got.CategoryColor != cat.Color {
		t.Errorf("GetObject: category_color = %q, want %q", got.CategoryColor, cat.Color)
	}

	items, _, err := s.ListObjects(ctx, domain.ObjectFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 || items[0].CategoryColor != cat.Color {
		t.Errorf("ListObjects: category_color not filled: %+v", items)
	}

	// 未分类对象不该凭空冒出颜色。
	loose := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "未分类"})
	if loose.CategoryColor != "" {
		t.Errorf("uncategorized object has color %q", loose.CategoryColor)
	}
}

// 分类计数要和 by_type 一个口径：回收站和已归档都不算。
func TestCategoryCountsExcludeArchivedAndDeleted(t *testing.T) {
	s, ctx := newStore(t)
	live := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "在架", CategoryID: pstr("cat_req_prod_cloud"),
	})
	archived := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "已归档", CategoryID: pstr("cat_req_prod_cloud"),
	})
	deleted := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "已删除", CategoryID: pstr("cat_req_prod_cloud"),
	})

	countOf := func(id string) (int, int) {
		t.Helper()
		cats, err := s.ListCategories(ctx, "requirement", true)
		if err != nil {
			t.Fatalf("list categories: %v", err)
		}
		for _, c := range cats {
			if c.ID == id {
				return c.Count, c.TotalCount
			}
		}
		t.Fatalf("category %s not found", id)
		return 0, 0
	}

	if direct, total := countOf("cat_req_prod_cloud"); direct != 3 || total != 3 {
		t.Fatalf("before: count=%d total=%d, want 3/3", direct, total)
	}
	if _, total := countOf("cat_req_prod"); total != 3 {
		t.Fatalf("parent total = %d, want 3", total)
	}

	yes := true
	if _, err := s.UpdateObject(ctx, archived.ID, domain.ObjectPatch{Archived: &yes}, store.DefaultActor); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := s.DeleteObject(ctx, deleted.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("delete: %v", err)
	}

	direct, total := countOf("cat_req_prod_cloud")
	if direct != 1 || total != 1 {
		t.Errorf("after: count=%d total=%d, want 1/1", direct, total)
	}
	if _, parentTotal := countOf("cat_req_prod"); parentTotal != 1 {
		t.Errorf("parent total = %d, want 1", parentTotal)
	}

	// 与 by_type 对账，两个口径必须给出同一个数。
	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.ByType["requirement"] != direct {
		t.Errorf("by_type[requirement] = %d but category count = %d", c.ByType["requirement"], direct)
	}
	_ = live
}

// 侧栏「未分类」入口的语义：只看 category_id IS NULL 的对象，
// 且 total 与 items 必须一致（COUNT 和列表走的是同一份 WHERE）。
func TestListObjectsUncategorized(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "挂云端分类", CategoryID: pstr("cat_req_prod_cloud"),
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "挂产品分类", CategoryID: pstr("cat_req_prod"),
	})
	loose := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "没分类"})

	items, total, err := s.ListObjects(ctx, domain.ObjectFilter{Uncategorized: true})
	if err != nil {
		t.Fatalf("uncategorized query: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("uncategorized: got %d items / total %d, want 1/1", len(items), total)
	}
	if items[0].ID != loose.ID {
		t.Errorf("uncategorized 命中了 %q，期望 %q", items[0].Title, loose.Title)
	}
}

// Uncategorized 与 CategoryID 同时给时以前者为准，不留未定义语义。
func TestListObjectsUncategorizedOverridesCategory(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "挂云端分类", CategoryID: pstr("cat_req_prod_cloud"),
	})
	loose := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "没分类"})

	for _, f := range []domain.ObjectFilter{
		{CategoryID: "cat_req_prod_cloud", Uncategorized: true},
		// 子树也要短路，未分类没有子树可言。
		{CategoryID: "cat_req_prod", CategorySubtree: true, Uncategorized: true},
	} {
		items, total, err := s.ListObjects(ctx, f)
		if err != nil {
			t.Fatalf("%+v: %v", f, err)
		}
		if total != 1 || len(items) != 1 || items[0].ID != loose.ID {
			t.Fatalf("%+v: got %d items / total %d，期望只命中未分类那条", f, len(items), total)
		}
	}
}

// 侧栏「未分类」行的徽标：口径要和 by_type 一致（排除软删与已归档），
// 否则分类行有数字、未分类行对不上，看起来像数据错了。
func TestCountsUncategorizedByType(t *testing.T) {
	s, ctx := newStore(t)

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "挂了分类一", CategoryID: pstr("cat_req_prod_cloud"),
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "挂了分类二", CategoryID: pstr("cat_req_tech_perf"),
	})
	loose := mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "没挂分类"})
	// 别的类型不该串进来。
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "未分类待办"})

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.UncategorizedByType["requirement"] != 1 {
		t.Errorf("uncategorized[requirement] = %d, want 1", c.UncategorizedByType["requirement"])
	}
	if c.UncategorizedByType["task"] != 1 {
		t.Errorf("uncategorized[task] = %d, want 1", c.UncategorizedByType["task"])
	}
	if c.ByType["requirement"] != 3 {
		t.Errorf("by_type[requirement] = %d, want 3", c.ByType["requirement"])
	}

	// 归档后要跟着掉，和 by_type 同步。
	yes := true
	if _, err := s.UpdateObject(ctx, loose.ID, domain.ObjectPatch{Archived: &yes}, store.DefaultActor); err != nil {
		t.Fatalf("archive: %v", err)
	}
	c, err = s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts after archive: %v", err)
	}
	if c.UncategorizedByType["requirement"] != 0 {
		t.Errorf("archived: uncategorized[requirement] = %d, want 0", c.UncategorizedByType["requirement"])
	}
	if c.ByType["requirement"] != 2 {
		t.Errorf("archived: by_type[requirement] = %d, want 2", c.ByType["requirement"])
	}

	// 软删同理。
	if err := s.DeleteObject(ctx, loose.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("delete: %v", err)
	}
	c, err = s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts after delete: %v", err)
	}
	if c.UncategorizedByType["requirement"] != 0 {
		t.Errorf("deleted: uncategorized[requirement] = %d, want 0", c.UncategorizedByType["requirement"])
	}

	// 没有未分类对象的类型不该出现在 map 里（GROUP BY 不产生空行）。
	if _, ok := c.UncategorizedByType["doc"]; ok {
		t.Error("types without uncategorized objects should be absent from the map")
	}
}

// Counts 的 typeID 收窄只作用于聚焦类计数器，ByType/Total 这些恒为全局。
// 混合口径是有意的：侧栏要跨类型的总量，工具条 chip 要和按类型过滤的列表对得上。
func TestCountsScopedByType(t *testing.T) {
	s, ctx := newStore(t)
	past := time.Now().Add(-48 * time.Hour)

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "逾期待办", Status: "todo", DueAt: &past,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "逾期需求", Status: "backlog", DueAt: &past,
	})

	global, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if global.Overdue != 2 {
		t.Fatalf("global overdue = %d, want 2", global.Overdue)
	}

	scoped, err := s.Counts(ctx, "task")
	if err != nil {
		t.Fatalf("scoped counts: %v", err)
	}
	if scoped.Overdue != 1 {
		t.Errorf("scoped overdue = %d, want 1", scoped.Overdue)
	}
	// 全局口径的那几个不许跟着收窄。
	if scoped.Total != global.Total {
		t.Errorf("Total must stay global: scoped %d vs global %d", scoped.Total, global.Total)
	}
	if scoped.ByType["requirement"] != 1 {
		t.Errorf("ByType must stay global, got %v", scoped.ByType)
	}
	if scoped.ByStatus["requirement:backlog"] != 1 {
		t.Errorf("ByStatus must stay global, got %v", scoped.ByStatus)
	}

	// 收窄到一个没有逾期项的类型应得 0，而不是漏掉过滤退回全局。
	docs, err := s.Counts(ctx, "doc")
	if err != nil {
		t.Fatalf("doc counts: %v", err)
	}
	if docs.Overdue != 0 {
		t.Errorf("doc overdue = %d, want 0", docs.Overdue)
	}
}

// DueAfter/DueBefore 成对使用表达「当天到期」的窗口。只有上界时「今日」会把逾期的
// 也扫进来，列表和 Counts.Today 的徽标就对不上了。
func TestListObjectsDueWindow(t *testing.T) {
	s, ctx := newStore(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	dayEnd := dayStart.AddDate(0, 0, 1)

	overdue := dayStart.Add(-36 * time.Hour)
	todayAM := dayStart.Add(9 * time.Hour)
	todayPM := dayStart.Add(20 * time.Hour)
	future := dayStart.Add(72 * time.Hour)

	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "逾期", Status: "todo", DueAt: &overdue})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "今天上午", Status: "todo", DueAt: &todayAM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "今天晚上", Status: "todo", DueAt: &todayPM})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "将来", Status: "todo", DueAt: &future})
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "没有截止日", Status: "todo"})

	// 只给上界：会把逾期的一起扫进来，这正是徽标对不上的成因。
	_, upperOnly, err := s.ListObjects(ctx, domain.ObjectFilter{DueBefore: &dayEnd})
	if err != nil {
		t.Fatalf("upper bound only: %v", err)
	}
	if upperOnly != 3 {
		t.Fatalf("due_before only = %d, want 3 (逾期+今天两条)", upperOnly)
	}

	// 成对给窗口：只剩今天到期的两条，和 Counts.Today 对上。
	items, total, err := s.ListObjects(ctx, domain.ObjectFilter{
		DueAfter: &dayStart, DueBefore: &dayEnd,
	})
	if err != nil {
		t.Fatalf("due window: %v", err)
	}
	if total != 2 {
		t.Fatalf("due window total = %d, want 2", total)
	}
	for _, o := range items {
		if o.DueAt == nil || o.DueAt.Before(dayStart) || !o.DueAt.Before(dayEnd) {
			t.Errorf("%s due_at %v outside the window", o.Title, o.DueAt)
		}
	}

	c, err := s.Counts(ctx, "task")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Today != total {
		t.Errorf("Counts.Today = %d but due-window list = %d; 两者口径必须一致", c.Today, total)
	}

	// 只给下界也要能用（比如「今天及以后」）。
	_, lowerOnly, err := s.ListObjects(ctx, domain.ObjectFilter{DueAfter: &dayStart})
	if err != nil {
		t.Fatalf("lower bound only: %v", err)
	}
	if lowerOnly != 3 {
		t.Errorf("due_after only = %d, want 3 (今天两条+将来一条)", lowerOnly)
	}
}

// 这次修复的核心：昨天到期算 overdue、今天到期算 today，两者互不重叠。
//
// 注意「今天早些时候已过到期时刻」的对象**仍然算今日、不算逾期**，这是有意的：
// 到期日虽然带时分，业务粒度却是「天」。今天 10:00 到期的任务，下午 3 点仍是今天的活，
// 过完今天才算逾期（Todoist / Things / Linear 都是这个口径）。若按「早于此刻」判逾期，
// 同一条数据上午在「今日」、下午会自己跳进「逾期」，制造虚假紧迫感，看板上像数据乱了。
// 所以下面的断言必须与运行时刻无关——这条测试之前就是因为取了 dayStart+15h 这个
// 「过了中午才越界」的值，上午跑绿、下午跑红。
func TestCountsTodayAndOverdueDoNotOverlap(t *testing.T) {
	s, ctx := newStore(t)
	dayStart := startOfDay(time.Now())
	yesterday := dayStart.Add(-6 * time.Hour)
	earlyToday := dayStart.Add(1 * time.Hour) // 无论几点跑，这个时刻都已过去
	lateToday := dayStart.Add(23 * time.Hour) // 无论几点跑，这个时刻都还没到

	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "昨天到期", Status: "todo", DueAt: &yesterday,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "今天很早到期", Status: "todo", DueAt: &earlyToday,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "今天很晚到期", Status: "todo", DueAt: &lateToday,
	})

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Today != 2 {
		t.Errorf("today = %d, want 2（今天到期的两条都算今日，与当前时刻无关）", c.Today)
	}
	if c.Overdue != 1 {
		t.Errorf("overdue = %d, want 1（只有昨天那条）", c.Overdue)
	}
	// 加总断言：漏算和重复计数会在单个数字上互相抵消，加起来才看得出来。
	if c.Today+c.Overdue != 3 {
		t.Errorf("today+overdue = %d, want 3（不重叠也不遗漏）", c.Today+c.Overdue)
	}
	// 本周含今天但不含逾期，和 overdue 同样以今天零点为界。
	if c.Week != 2 {
		t.Errorf("week = %d, want 2（含今天两条、不含昨天）", c.Week)
	}

	// 列表侧用同一个窗口查，必须和徽标一致。
	dayEnd := dayStart.AddDate(0, 0, 1)
	_, todayTotal, err := s.ListObjects(ctx, domain.ObjectFilter{
		DueAfter: &dayStart, DueBefore: &dayEnd, NotTerminal: true,
	})
	if err != nil {
		t.Fatalf("today window: %v", err)
	}
	if todayTotal != c.Today {
		t.Errorf("今日列表 %d 条 vs 徽标 %d，两者必须一致", todayTotal, c.Today)
	}
	_, overdueTotal, err := s.ListObjects(ctx, domain.ObjectFilter{Overdue: true})
	if err != nil {
		t.Fatalf("overdue list: %v", err)
	}
	if overdueTotal != c.Overdue {
		t.Errorf("逾期列表 %d 条 vs 徽标 %d，两者必须一致", overdueTotal, c.Overdue)
	}
}

// 当天任意时刻到期的对象都该算「今日」。把到期时刻参数化跑一遍，
// 结果必须一致——这才是「与运行时刻无关」的正面证明，而不是碰巧当时跑绿。
func TestCountsTodayIsIndependentOfTimeOfDay(t *testing.T) {
	for _, hour := range []int{0, 1, 12, 23} {
		t.Run(fmt.Sprintf("due_at=dayStart+%dh", hour), func(t *testing.T) {
			s, ctx := newStore(t)
			dayStart := startOfDay(time.Now())
			due := dayStart.Add(time.Duration(hour) * time.Hour)
			yesterday := dayStart.Add(-2 * time.Hour)

			mustCreate(t, s, ctx, &domain.Object{
				TypeID: "task", Title: "今天到期", Status: "todo", DueAt: &due,
			})
			mustCreate(t, s, ctx, &domain.Object{
				TypeID: "task", Title: "昨天到期", Status: "todo", DueAt: &yesterday,
			})

			c, err := s.Counts(ctx, "")
			if err != nil {
				t.Fatalf("counts: %v", err)
			}
			if c.Today != 1 {
				t.Errorf("today = %d, want 1（到期时刻 %d 点，不该影响归属）", c.Today, hour)
			}
			if c.Overdue != 1 {
				t.Errorf("overdue = %d, want 1（只有昨天那条）", c.Overdue)
			}
			if c.Today+c.Overdue != 2 {
				t.Errorf("today+overdue = %d, want 2", c.Today+c.Overdue)
			}
		})
	}
}
func TestListObjectsStalled(t *testing.T) {
	s, ctx := newStore(t)
	old := time.Now().AddDate(0, 0, -20)

	want := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "二十天没动", Status: "todo",
		CreatedAt: old, UpdatedAt: old,
	})
	// 同样很久没动，但已经完成了——不算停滞。
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "二十天没动但已完成", Status: "done",
		CreatedAt: old, UpdatedAt: old,
	})
	// 今天刚更新过。
	mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "刚更新", Status: "todo"})

	items, total, err := s.ListObjects(ctx, domain.ObjectFilter{Stalled: true})
	if err != nil {
		t.Fatalf("stalled: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("stalled total = %d, want 1", total)
	}
	if items[0].ID != want.ID {
		t.Errorf("stalled returned %q, want %q", items[0].Title, want.Title)
	}

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Stalled != total {
		t.Errorf("Counts.Stalled = %d but list total = %d; 两者必须同口径", c.Stalled, total)
	}

	// 刚好卡在阈值边界内侧的不算停滞，确认两边用的是同一个 stalledDays。
	justInside := time.Now().AddDate(0, 0, -(stalledDays - 1))
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "差一天到阈值", Status: "todo",
		CreatedAt: justInside, UpdatedAt: justInside,
	})
	_, total2, err := s.ListObjects(ctx, domain.ObjectFilter{Stalled: true})
	if err != nil {
		t.Fatalf("stalled again: %v", err)
	}
	if total2 != 1 {
		t.Errorf("阈值内侧不该算停滞: total = %d, want 1", total2)
	}
	c2, _ := s.Counts(ctx, "")
	if c2.Stalled != total2 {
		t.Errorf("边界处徽标 %d 与列表 %d 不一致", c2.Stalled, total2)
	}
}

// NotTerminal 让「今日」「本周」这类待办视图和 Counts 对齐：今天到期但已完成的不该出现。
func TestListObjectsNotTerminal(t *testing.T) {
	s, ctx := newStore(t)
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	dayEnd := dayStart.AddDate(0, 0, 1)
	due := dayStart.Add(14 * time.Hour)

	open := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "今天到期未完成", Status: "todo", DueAt: &due,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "task", Title: "今天到期已完成", Status: "done", DueAt: &due,
	})

	// 不带 NotTerminal：两条都在，这正是徽标对不上的成因。
	_, both, err := s.ListObjects(ctx, domain.ObjectFilter{DueAfter: &dayStart, DueBefore: &dayEnd})
	if err != nil {
		t.Fatalf("window: %v", err)
	}
	if both != 2 {
		t.Fatalf("窗口内应有 2 条, got %d", both)
	}

	items, total, err := s.ListObjects(ctx, domain.ObjectFilter{
		DueAfter: &dayStart, DueBefore: &dayEnd, NotTerminal: true,
	})
	if err != nil {
		t.Fatalf("not terminal: %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("not_terminal total = %d, want 1", total)
	}
	if items[0].ID != open.ID {
		t.Errorf("returned %q, want %q", items[0].Title, open.Title)
	}

	c, err := s.Counts(ctx, "")
	if err != nil {
		t.Fatalf("counts: %v", err)
	}
	if c.Today != total {
		t.Errorf("Counts.Today = %d but list total = %d; 两者必须一致", c.Today, total)
	}

	// 终态判断是按类型读 statuses JSON 的，换个类型也要成立（doc 的终态是 published/archived）。
	dueDoc := due
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "doc", Title: "今天到期的已发布文档", Status: "published", DueAt: &dueDoc,
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "doc", Title: "今天到期的草稿", Status: "draft", DueAt: &dueDoc,
	})
	_, docTotal, err := s.ListObjects(ctx, domain.ObjectFilter{
		TypeIDs: []string{"doc"}, DueAfter: &dayStart, DueBefore: &dayEnd, NotTerminal: true,
	})
	if err != nil {
		t.Fatalf("doc not terminal: %v", err)
	}
	if docTotal != 1 {
		t.Errorf("doc not_terminal = %d, want 1（published 是终态）", docTotal)
	}
}

// --- 标签维护 ---

// tagByName 从 ListTags 里按名字捞一个，标签 id 是生成的，测试只能靠名字定位。
func tagByName(t *testing.T, s *Store, ctx context.Context, name string) *domain.Tag {
	t.Helper()
	tags, err := s.ListTags(ctx)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	for _, tg := range tags {
		if tg.Name == name {
			return tg
		}
	}
	t.Fatalf("标签 %q 不存在，现有 %v", name, tags)
	return nil
}

func TestUpdateTagRenameAndRecolor(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "带标签的需求", Tags: []string{"云端"},
	})
	tag := tagByName(t, s, ctx, "云端")

	got, err := s.UpdateTag(ctx, tag.ID, pstr("云端平台"), pstr("#3b5bdb"))
	if err != nil {
		t.Fatalf("update tag: %v", err)
	}
	if got.Name != "云端平台" || got.Color != "#3b5bdb" {
		t.Fatalf("改名改色没生效：%+v", got)
	}
	if got.Count != 1 {
		t.Errorf("Count = %d, 期望 1（改名不该动对象关系）", got.Count)
	}

	// 只传 color 时 name 保持不变，指针语义不能把没传的字段清空。
	got, err = s.UpdateTag(ctx, tag.ID, nil, pstr("#c92a2a"))
	if err != nil {
		t.Fatalf("update color only: %v", err)
	}
	if got.Name != "云端平台" {
		t.Errorf("只改色却把名字改成了 %q", got.Name)
	}

	if _, err := s.UpdateTag(ctx, "tag_nope", pstr("x"), nil); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("改不存在的标签 err = %v, 期望 ErrNotFound", err)
	}
	if _, err := s.UpdateTag(ctx, tag.ID, pstr("   "), nil); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("改成空名 err = %v, 期望 ErrValidation", err)
	}
}

// 改名撞上已有标签名必须报冲突，不能静默合并：
// 用户以为只是在改个错别字，结果两个标签的对象被并到一起且不可逆。
func TestUpdateTagRenameConflictDoesNotMerge(t *testing.T) {
	s, ctx := newStore(t)
	a := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "A", Tags: []string{"云端"},
	})
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "B", Tags: []string{"云端平台"},
	})
	src := tagByName(t, s, ctx, "云端")

	_, err := s.UpdateTag(ctx, src.ID, pstr("云端平台"), nil)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("重名改名 err = %v, 期望 ErrConflict", err)
	}

	// 两个标签都还在，各自的对象也没动。
	if got := tagByName(t, s, ctx, "云端"); got.Count != 1 {
		t.Errorf("冲突后「云端」Count = %d, 期望 1", got.Count)
	}
	if got := tagByName(t, s, ctx, "云端平台"); got.Count != 1 {
		t.Errorf("冲突后「云端平台」Count = %d, 期望 1", got.Count)
	}
	obj, err := s.GetObject(ctx, a.ID)
	if err != nil {
		t.Fatalf("get object: %v", err)
	}
	if len(obj.Tags) != 1 || obj.Tags[0] != "云端" {
		t.Errorf("对象 A 的标签被改动了：%v", obj.Tags)
	}
}

func TestMergeTags(t *testing.T) {
	s, ctx := newStore(t)
	onlySrc := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "只挂 src", Tags: []string{"云端"},
	})
	onlyDst := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "只挂 dst", Tags: []string{"云端平台"},
	})
	// 同时挂着两个标签的对象是最容易写错的一条：直接 UPDATE tag_id 会撞
	// (object_id, tag_id) 主键，整个合并连带回滚。
	both := mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "两个都挂", Tags: []string{"云端", "云端平台"},
	})

	src := tagByName(t, s, ctx, "云端")
	dst := tagByName(t, s, ctx, "云端平台")

	got, err := s.MergeTags(ctx, src.ID, dst.ID)
	if err != nil {
		t.Fatalf("merge tags: %v", err)
	}
	if got.ID != dst.ID || got.Name != "云端平台" {
		t.Fatalf("返回的不是 dst：%+v", got)
	}
	if got.Count != 3 {
		t.Errorf("合并后 Count = %d, 期望 3（三个对象各算一次，不重复计数）", got.Count)
	}

	// src 已经不在了。
	tags, err := s.ListTags(ctx)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	if len(tags) != 1 {
		t.Fatalf("合并后还剩 %d 个标签，期望 1：%+v", len(tags), tags)
	}

	// 三个对象都只挂着 dst，没有重复行。
	for _, o := range []*domain.Object{onlySrc, onlyDst, both} {
		cur, err := s.GetObject(ctx, o.ID)
		if err != nil {
			t.Fatalf("get object %s: %v", o.Title, err)
		}
		if len(cur.Tags) != 1 || cur.Tags[0] != "云端平台" {
			t.Errorf("对象 %q 的标签 = %v, 期望恰好 [云端平台]", o.Title, cur.Tags)
		}
	}

	// 直接查中间表，确认没有留下重复的 object_tags 行。
	var rows int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM object_tags`).Scan(&rows); err != nil {
		t.Fatalf("count object_tags: %v", err)
	}
	if rows != 3 {
		t.Errorf("object_tags 剩 %d 行, 期望 3", rows)
	}
}

func TestMergeTagsRejectsBadArgs(t *testing.T) {
	s, ctx := newStore(t)
	mustCreate(t, s, ctx, &domain.Object{
		TypeID: "requirement", Title: "A", Tags: []string{"云端"},
	})
	tag := tagByName(t, s, ctx, "云端")

	if _, err := s.MergeTags(ctx, tag.ID, tag.ID); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("自己并自己 err = %v, 期望 ErrValidation", err)
	}
	if _, err := s.MergeTags(ctx, tag.ID, "tag_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("目标不存在 err = %v, 期望 ErrNotFound", err)
	}
	if _, err := s.MergeTags(ctx, "tag_nope", tag.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("源不存在 err = %v, 期望 ErrNotFound", err)
	}
	// 失败的合并不能留下痕迹。
	if got := tagByName(t, s, ctx, "云端"); got.Count != 1 {
		t.Errorf("失败后 Count = %d, 期望 1", got.Count)
	}
}

// overdueBefore/startOfDay 是纯函数，可以直接喂任意「此刻」验证跨时刻稳定性，
// 不用去动系统时钟。同一天内不论几点，逾期分界都必须是同一个值。
func TestOverdueBoundaryStableAcrossTimeOfDay(t *testing.T) {
	loc := time.Now().Location()
	day := time.Date(2026, 9, 15, 0, 0, 0, 0, loc)
	want := timeStr(day)

	for _, hm := range []struct{ h, m int }{{0, 0}, {0, 1}, {9, 30}, {12, 0}, {15, 14}, {23, 59}} {
		now := time.Date(2026, 9, 15, hm.h, hm.m, 0, 0, loc)
		if got := overdueBefore(now); got != want {
			t.Errorf("overdueBefore(%02d:%02d) = %s, want %s（同一天内分界不该随时刻变）",
				hm.h, hm.m, got, want)
		}
	}

	// 跨到第二天，分界必须跟着前进一天。
	next := time.Date(2026, 9, 16, 0, 0, 0, 0, loc)
	if got, wantNext := overdueBefore(next), timeStr(next); got != wantNext {
		t.Errorf("跨天后 overdueBefore = %s, want %s", got, wantNext)
	}

	// 昨天 23:59 到期的，今天任意时刻都算逾期；今天 00:00 到期的，今天任意时刻都不算。
	if !(timeStr(day.Add(-time.Minute)) < want) {
		t.Error("昨天到期的应当早于分界")
	}
	if timeStr(day) < want {
		t.Error("今天零点到期的不该早于分界")
	}
}
