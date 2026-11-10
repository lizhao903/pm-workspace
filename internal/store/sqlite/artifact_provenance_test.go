// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 0031 的溯源列：产出者、种类、状态、非对象归属。

// TestArtifactActorDefaultsToSource 守「没声明产出者时按登记途径补」，口径和 0031 回填老数据一致。
func TestArtifactActorDefaultsToSource(t *testing.T) {
	s, ctx := newStore(t)

	a := mustArtifact(t, s, ctx, domain.ArtifactInput{URL: "https://x/1"})
	// kind 没给时按推断补（TSK-0497）：认不出平台的链接是 other
	if a.ActorType != domain.ActorUser || a.Kind != "other" || a.Status != "" || a.Props == nil {
		t.Fatalf("手工登记默认值不对: actor=%q kind=%q status=%q props=%v", a.ActorType, a.Kind, a.Status, a.Props)
	}
	b, err := s.RecordArtifact(ctx, domain.ArtifactInput{Path: "/tmp/r.md", Source: domain.ArtifactSourceRun})
	if err != nil {
		t.Fatal(err)
	}
	if b.ActorType != domain.ActorRun {
		t.Errorf("run 来源的产出者应是 run，得到 %q", b.ActorType)
	}
	// 声明了就照存，source 不受影响。
	c := mustArtifact(t, s, ctx, domain.ArtifactInput{
		URL: "https://x/2", Source: domain.ArtifactSourceMCP,
		ActorType: domain.ActorSkill, ActorID: "prd-visualizer", ActorLabel: "PRD 可视化",
	})
	if c.Source != domain.ArtifactSourceMCP || c.ActorType != domain.ActorSkill || c.ActorID != "prd-visualizer" || c.ActorLabel != "PRD 可视化" {
		t.Errorf("声明的产出者没存对: %+v", c)
	}
}

func TestArtifactProvenanceValidation(t *testing.T) {
	s, ctx := newStore(t)
	for name, in := range map[string]domain.ArtifactInput{
		"未知种类":          {URL: "https://x/1", Kind: "video"},
		"未知状态":          {URL: "https://x/1", Status: "done"},
		"未知产出者":         {URL: "https://x/1", ActorType: "robot"},
		"只有 scope_type": {URL: "https://x/1", ScopeType: "kb"},
		"只有 scope_id":   {URL: "https://x/1", ScopeID: "kb_1"},
	} {
		if _, err := s.CreateArtifact(ctx, in); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%s 应报 ErrValidation，得到 %v", name, err)
		}
	}
	// 停用的种类不再接受新写入。
	if _, err := s.db.W.ExecContext(ctx,
		`UPDATE dict_items SET archived_at = datetime('now') WHERE dict_id = 'artifact_kind' AND key = 'data'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateArtifact(ctx, domain.ArtifactInput{URL: "https://x/1", Kind: "data"}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("停用的种类应报 ErrValidation，得到 %v", err)
	}
}

// TestArtifactFilterByProvenance 守按会话、执行、对象和新加的溯源列查询，
// 并且列表和统计说同一件事。
func TestArtifactFilterByProvenance(t *testing.T) {
	s, ctx := newStore(t)

	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "任务"})
	sess, err := s.CreateAgentSession(ctx, &domain.AgentSession{Title: "会话"})
	if err != nil {
		t.Fatal(err)
	}
	run := mustRun(t, s, ctx, obj.ID)

	mustArtifact(t, s, ctx, domain.ArtifactInput{
		URL: "https://x/a", ObjectID: &obj.ID, Kind: "doc", Status: "draft", Title: "方案",
	})
	mustArtifact(t, s, ctx, domain.ArtifactInput{
		URL: "https://x/b", ObjectID: &obj.ID, Kind: "commit", Source: domain.ArtifactSourceMCP,
		ActorType: domain.ActorSkill, ActorID: "task",
	})
	if _, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		Path: "/tmp/s.md", SessionID: &sess.ID, Source: domain.ArtifactSourceAgent,
		ScopeType: "kb", ScopeID: "kb_1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordArtifact(ctx, domain.ArtifactInput{
		Path: "/tmp/r.md", RunID: &run.ID, ObjectID: &obj.ID, Source: domain.ArtifactSourceRun,
	}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		f    domain.ArtifactFilter
		want int
	}{
		{"按对象", domain.ArtifactFilter{ObjectID: obj.ID}, 3},
		{"按会话", domain.ArtifactFilter{SessionID: sess.ID}, 1},
		{"按执行", domain.ArtifactFilter{RunID: run.ID}, 1},
		{"按种类", domain.ArtifactFilter{Kind: "commit"}, 1},
		{"按状态", domain.ArtifactFilter{Status: "draft"}, 1},
		{"按产出者类型", domain.ArtifactFilter{ActorType: domain.ActorSkill}, 1},
		{"按产出者", domain.ArtifactFilter{ActorType: domain.ActorSkill, ActorID: "task"}, 1},
		{"按产出者 id 没命中", domain.ArtifactFilter{ActorType: domain.ActorSkill, ActorID: "x"}, 0},
		{"按归属", domain.ArtifactFilter{ScopeType: "kb", ScopeID: "kb_1"}, 1},
		{"按归属类型", domain.ArtifactFilter{ScopeType: "kb"}, 1},
		// /tmp/r.md 登记时没给 kind，按扩展名补成 doc（TSK-0497）
		{"对象加种类", domain.ArtifactFilter{ObjectID: obj.ID, Kind: "doc"}, 2},
		// 关键词和别的条件一起用：以前的 ?1 会对到第一个参数上。
		{"对象加关键词", domain.ArtifactFilter{ObjectID: obj.ID, Q: "方案"}, 1},
	}
	for _, c := range cases {
		items, total, err := s.ListArtifacts(ctx, c.f)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(items) != c.want || total != c.want {
			t.Errorf("%s: 列表 %d 条 total %d，期望 %d", c.name, len(items), total, c.want)
		}
		st, err := s.ArtifactStats(ctx, c.f)
		if err != nil {
			t.Fatalf("%s 统计: %v", c.name, err)
		}
		if st.Total != c.want {
			t.Errorf("%s: 统计 total %d，期望 %d", c.name, st.Total, c.want)
		}
	}

	st, err := s.ArtifactStats(ctx, domain.ArtifactFilter{})
	if err != nil {
		t.Fatal(err)
	}
	// 没给 kind 的两条 .md 登记时补成 doc（TSK-0497），不再有未分类
	if st.ByKind["doc"] != 3 || st.ByKind["commit"] != 1 || st.ByKind[""] != 0 {
		t.Errorf("by_kind = %v", st.ByKind)
	}
}

func TestUpdateArtifactProvenance(t *testing.T) {
	s, ctx := newStore(t)
	a := mustArtifact(t, s, ctx, domain.ArtifactInput{URL: "https://x/1"})

	props := map[string]any{"version": float64(2), "picked": true}
	got, err := s.UpdateArtifact(ctx, a.ID, domain.ArtifactPatch{
		Kind: strp("prototype"), Status: strp("review"),
		ScopeType: strp("video"), ScopeID: strp("vid_1"), Props: &props,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != "prototype" || got.Status != "review" || got.ScopeType != "video" || got.ScopeID != "vid_1" ||
		got.Props["version"] != float64(2) || got.Props["picked"] != true {
		t.Fatalf("改完不对: %+v", got)
	}
	// 只改 scope_id 也要过「成对」校验；两个一起清空是解除归属。
	if _, err := s.UpdateArtifact(ctx, a.ID, domain.ArtifactPatch{ScopeType: strp("")}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("只清 scope_type 应报 ErrValidation，得到 %v", err)
	}
	got, err = s.UpdateArtifact(ctx, a.ID, domain.ArtifactPatch{ScopeType: strp(""), ScopeID: strp(""), Kind: strp("")})
	if err != nil || got.ScopeType != "" || got.ScopeID != "" || got.Kind != "" {
		t.Fatalf("清空归属和种类失败: %+v %v", got, err)
	}
	for name, p := range map[string]domain.ArtifactPatch{
		"未知种类": {Kind: strp("nope")},
		"未知状态": {Status: strp("nope")},
	} {
		if _, err := s.UpdateArtifact(ctx, a.ID, p); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%s 应报 ErrValidation，得到 %v", name, err)
		}
	}
	// 产出者不经 PATCH 改，原样保留。
	if got.ActorType != domain.ActorUser {
		t.Errorf("actor_type = %q", got.ActorType)
	}
}
