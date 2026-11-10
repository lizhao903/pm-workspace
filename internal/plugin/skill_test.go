// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// TestSkillsFollowEnabledState：示例插件登记的技能只在它在跑时出现，Source 是插件 id。
func TestSkillsFollowEnabledState(t *testing.T) {
	ctx := context.Background()
	r := newRegistry(t, plugin.NewMemStateStore(), plugintest.NewDemo(time.Hour))
	if got := r.Skills(); len(got) != 0 {
		t.Fatalf("没装就有技能：%v", got)
	}
	installEnable(t, r, "demo")
	got := r.Skills()
	if len(got) != 1 || got[0].ID != plugintest.SkillID || got[0].Source != "demo" || got[0].Instructions == "" || len(got[0].Uses) != 1 {
		t.Fatalf("启用后 skills = %+v", got)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if got := r.Skills(); len(got) != 0 {
		t.Fatalf("停用后还有技能：%v", got)
	}
	if err := r.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if len(r.Skills()) != 1 {
		t.Fatal("重新启用后没有技能")
	}
}

func TestSkillChecksManifest(t *testing.T) {
	ok := func(id string) plugin.SkillDef {
		return plugin.SkillDef{ID: id, Name: "技能", Instructions: "这样做"}
	}
	noName := ok("sk_bad_a")
	noName.Name = " "
	noBody := ok("sk_bad_a")
	noBody.Instructions = ""
	cases := []struct {
		name string
		def  []plugin.SkillDef
		want string
	}{
		{"没声明", []plugin.SkillDef{ok("sk_bad_other")}, "provides.skills"},
		{"撞内置", []plugin.SkillDef{ok("sk_weekly")}, "内置技能重复"},
		{"没名称", []plugin.SkillDef{noName}, "没有名称"},
		{"没说明", []plugin.SkillDef{noBody}, "没有说明"},
		{"重复", []plugin.SkillDef{ok("sk_bad_a"), ok("sk_bad_a")}, "技能重复"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePlugin{m: manifestJSON(t, `{"id":"bad","name":"bad","version":"0.1.0","core":">=1.0.0 <2.0.0",`+
				`"provides":{"skills":["sk_bad_a","sk_weekly"]},"permissions":[]}`), reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.Skill(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
}

// TestSkillReadsPromptFS：Instructions 为空时读 Prompt 里的 SKILL.md。
func TestSkillReadsPromptFS(t *testing.T) {
	p := &fakePlugin{m: manifestJSON(t, `{"id":"good","name":"good","version":"0.1.0","core":">=1.0.0 <2.0.0",`+
		`"provides":{"skills":["sk_good"]},"permissions":[]}`), reg: func(r plugin.Registrar) error {
		r.Skill(plugin.SkillDef{ID: "sk_good", Name: "好技能", Prompt: fstest.MapFS{"SKILL.md": {Data: []byte("  先看再写。\n")}}})
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "good")
	if got := r.Skills(); len(got) != 1 || got[0].Instructions != "先看再写。" || got[0].Uses == nil {
		t.Fatalf("skills = %+v", got)
	}
}
