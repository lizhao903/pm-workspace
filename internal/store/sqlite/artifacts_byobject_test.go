package sqlite

import (
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TestArtifactsByObject 守按对象汇总的口径（TSK-0497）：
//   - kind 按 display_kind 比，历史上 kind 为空的（执行扫目录登记的那批）照样能按类型筛到；
//   - 手工登记的计入；未归属的、对象进了回收站的不计；
//   - by_kind 不受 kind 条件影响，by_source 不受 source 条件影响；
//   - 项目、对象类型、时间区间在 SQL 里过滤。
func TestArtifactsByObject(t *testing.T) {
	s, ctx := newStore(t)
	proj := mustCreate(t, s, ctx, &domain.Object{TypeID: "project", Title: "项目甲"})
	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "有提交和文档", ProjectID: &proj.ID})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "只有执行扫出来的文件"})
	gone := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "进了回收站"})

	mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &a.ID, Path: "/repo", Note: "[commit] sha=a1b2c3d", Source: domain.ArtifactSourceMCP})
	mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &a.ID, Path: "/repo", Note: "[commit] sha=b2c3d4e", Source: domain.ArtifactSourceMCP})
	// 手工登记的 Confluence 页面：平台认出 confluence，种类补成 doc
	mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &a.ID, URL: "https://x.atlassian.net/wiki/9"})
	mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &gone.ID, Path: "/tmp/g.md"})
	mustArtifact(t, s, ctx, domain.ArtifactInput{Path: "/tmp/未归属.md"})
	if err := s.DeleteObject(ctx, gone.ID, false, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	// 模拟 TSK-0497 之前执行扫目录登记的历史数据：kind 为空
	for _, p := range []string{"/repo/internal/x.go", "/repo/docs/y.md"} {
		if _, err := s.db.W.ExecContext(ctx, `INSERT INTO artifacts (id, object_id, title, path, platform, source, actor_type, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'local', 'run', 'run', ?, ?)`, "art_old"+p[len(p)-4:], b.ID, p, p,
			"2026-10-01T00:00:00.000000000Z", "2026-10-01T00:00:00.000000000Z"); err != nil {
			t.Fatal(err)
		}
	}

	all, err := s.ArtifactsByObject(ctx, domain.ArtifactFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Objects) != 2 || all.Total != 5 {
		t.Fatalf("应有 2 个对象 5 件（未归属、回收站里的不算），得到 %d 个 %d 件：%+v", len(all.Objects), all.Total, all.Objects)
	}
	// 最近有产出的在前
	first, second := all.Objects[0], all.Objects[1]
	if first.ObjectID != a.ID || second.ObjectID != b.ID {
		t.Fatalf("顺序应是 %s、%s，得到 %s、%s", a.Ref, b.Ref, first.ObjectRef, second.ObjectRef)
	}
	if first.Total != 3 || first.ByKind["commit"] != 2 || first.ByKind["doc"] != 1 || first.BySource["manual"] != 1 {
		t.Errorf("任务甲汇总不对：%+v", first)
	}
	if first.ProjectID == nil || *first.ProjectID != proj.ID || first.ProjectTitle != "项目甲" || first.ObjectType != "task" {
		t.Errorf("任务甲的项目、类型不对：%+v", first)
	}
	if second.ByKind["code"] != 1 || second.ByKind["doc"] != 1 || second.ByKind[""] != 0 {
		t.Errorf("历史未分类的应按扩展名显示成 code、doc，得到 %v", second.ByKind)
	}
	if second.ProjectID != nil || !second.LastAt.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("任务乙不属于项目、最近一次登记是 10-01，得到 %+v", second)
	}

	cases := []struct {
		name    string
		f       domain.ArtifactFilter
		objects int
		total   int
	}{
		{"按显示种类筛到历史未分类的", domain.ArtifactFilter{Kind: "code"}, 1, 1},
		{"doc 两个对象各一件", domain.ArtifactFilter{Kind: "doc"}, 2, 2},
		{"手工登记", domain.ArtifactFilter{Source: domain.ArtifactSourceManual}, 1, 1},
		{"项目", domain.ArtifactFilter{ProjectID: proj.ID}, 1, 3},
		{"不属于项目", domain.ArtifactFilter{ProjectID: "-"}, 1, 2},
		{"对象类型", domain.ArtifactFilter{ObjectType: "project"}, 0, 0},
		{"时间下界", domain.ArtifactFilter{Since: ptrTime(time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC))}, 1, 3},
		{"时间上界", domain.ArtifactFilter{Until: ptrTime(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))}, 1, 2},
		{"关键词", domain.ArtifactFilter{Q: "x.go"}, 1, 1},
	}
	for _, c := range cases {
		got, err := s.ArtifactsByObject(ctx, c.f)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(got.Objects) != c.objects || got.Total != c.total {
			t.Errorf("%s: 得到 %d 个对象 %d 件，期望 %d 个 %d 件", c.name, len(got.Objects), got.Total, c.objects, c.total)
		}
	}

	// 分面：by_kind 不受 kind 影响，by_source 不受 source 影响
	f, err := s.ArtifactsByObject(ctx, domain.ArtifactFilter{Kind: "commit", Source: domain.ArtifactSourceRun})
	if err != nil {
		t.Fatal(err)
	}
	if f.Total != 0 || f.ByKind["code"] != 1 || f.ByKind["doc"] != 1 || f.ByKind["commit"] != 0 {
		t.Errorf("by_kind 应是 source=run 下的全部种类，得到 total=%d %v", f.Total, f.ByKind)
	}
	if f.BySource["mcp"] != 2 || f.BySource["run"] != 0 {
		t.Errorf("by_source 应是 kind=commit 下的全部来源，得到 %v", f.BySource)
	}
}

// TestArtifactKindSettledOnRegister：没给 kind 的登记按推断补上；推出来的种类被停用了就留空、不拒；
// 给了不认识的 kind 照旧 400（TSK-0497）。
func TestArtifactKindSettledOnRegister(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务"})
	run := mustRun(t, s, ctx, obj.ID)

	// 执行扫目录那条路：以前从来不带 kind
	r, err := s.RecordArtifact(ctx, domain.ArtifactInput{ObjectID: &obj.ID, RunID: &run.ID, Path: "/tmp/demo/a.go", Source: domain.ArtifactSourceRun})
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != "code" || r.DisplayKind != "code" {
		t.Errorf("扫出来的 .go 应登记成 code，得到 kind=%q display=%q", r.Kind, r.DisplayKind)
	}
	m := mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &obj.ID, Path: "/repo", Note: "[branch] branch=feat/x"})
	if m.Kind != "branch" {
		t.Errorf("手工登记带 [branch] 前缀应补成 branch，得到 %q", m.Kind)
	}

	if _, err := s.db.W.ExecContext(ctx, `UPDATE dict_items SET archived_at = ? WHERE dict_id = ? AND key = 'doc'`,
		"2026-11-06T00:00:00Z", domain.DictArtifactKind); err != nil {
		t.Fatal(err)
	}
	d := mustArtifact(t, s, ctx, domain.ArtifactInput{ObjectID: &obj.ID, Path: "/tmp/a.md"})
	if d.Kind != "" || d.DisplayKind != "doc" {
		t.Errorf("doc 停用后推断出的 doc 不入库、只用于显示，得到 kind=%q display=%q", d.Kind, d.DisplayKind)
	}
	if _, err := s.CreateArtifact(ctx, domain.ArtifactInput{Path: "/tmp/b.md", Kind: "nope"}); err == nil {
		t.Error("明确给了不认识的 kind 应报错")
	}
}
