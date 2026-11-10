// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 挂两个技能时按挂载顺序各成一段「技能：<名称>」，每段带说明、什么时候用、工具和怎么做。
func TestSkillSectionKeepsOrder(t *testing.T) {
	weekly, _ := BuiltinSkill("sk_weekly")
	custom := store.Skill{ID: "sk_x", Name: "业务数据查询", When: "要查数时", Instructions: "只写 SELECT。", Source: store.SkillCustom}
	got := skillSection([]store.Skill{custom, weekly})
	i := strings.Index(got, "### 技能：业务数据查询")
	j := strings.Index(got, "### 技能：写周报")
	if i < 0 || j < 0 || i > j {
		t.Fatalf("两段技能应当按挂载顺序出现：\n%s", got)
	}
	for _, want := range []string{"什么时候用：要查数时", "只写 SELECT。", "用到的工具：查任务、写文档", weekly.Instructions} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少 %q：\n%s", want, got)
		}
	}
	if strings.Count(got, "### 技能：") != 2 {
		t.Errorf("应当正好两段：\n%s", got)
	}
	if skillSection(nil) != "" {
		t.Error("没挂技能时不该有这一节")
	}
}

// 内置技能对齐原型 SKILLS 里来源为「内置」的 10 条，拿到的是副本。
func TestBuiltinSkills(t *testing.T) {
	list := BuiltinSkills()
	if len(list) != 10 {
		t.Fatalf("内置技能 %d 条，期望 10", len(list))
	}
	seen := map[string]bool{}
	for _, k := range list {
		if !strings.HasPrefix(k.ID, "sk_") || k.Source != store.SkillBuiltin || k.Name == "" || k.Instructions == "" || seen[k.ID] {
			t.Errorf("内置技能不对：%+v", k)
		}
		seen[k.ID] = true
	}
	list[0].Uses[0] = "被改了"
	if BuiltinSkills()[0].Uses[0] == "被改了" {
		t.Error("BuiltinSkills 应当回副本")
	}
	if _, ok := BuiltinSkill("sk_sql"); ok {
		t.Error("业务数据查询是原型里的自定义技能，不该在内置里")
	}
}
