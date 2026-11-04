package plugin_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 插件登记产物（AUTO-08）：来源固定 run、产出者记本插件，挂到给的对象上；没接 store 时回 ErrNoObjectWriter
func TestPluginRecordsArtifact(t *testing.T) {
	var c plugin.Core
	p := &fakePlugin{m: manifest(t, "demo", ""), reg: func(r plugin.Registrar) error { c = r.Core(); return nil }}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "demo")
	ctx := context.Background()
	if _, err := c.Artifacts().Record(ctx, plugin.NewArtifact{Path: "/tmp/x.md"}); !errors.Is(err, plugin.ErrNoObjectWriter) {
		t.Fatalf("没接 store：%v", err)
	}
	arts := &artifactStore{}
	r.SetObjectCreator(arts)
	id, err := c.Artifacts().Record(ctx, plugin.NewArtifact{ObjectID: "obj_t1", Title: "报告", Path: "report.md", BaseDir: "/data/r",
		Kind: "doc", Props: map[string]any{"k": "v"}})
	if err != nil || id != "art_1" {
		t.Fatalf("登记：%q %v", id, err)
	}
	got := arts.got[0]
	if got.Source != domain.ArtifactSourceRun || got.ActorType != domain.ActorRun || got.ActorID != "demo" || got.ObjectID == nil ||
		*got.ObjectID != "obj_t1" || got.Kind != "doc" || got.Platform != "local" || got.BaseDir != "/data/r" || got.Props["k"] != "v" {
		t.Fatalf("登记的内容：%+v", got)
	}
	if _, err := c.Artifacts().Record(ctx, plugin.NewArtifact{Path: "/tmp/y.md"}); err != nil || arts.got[1].ObjectID != nil {
		t.Fatalf("不挂对象：%v %+v", err, arts.got[1])
	}
}
