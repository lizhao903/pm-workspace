package plugin

import (
	"io/fs"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 技能扩展点（AG-01b2），见 docs/plugin-api.md 2.6。
// 插件技能和内置技能一样只读；停用插件后不在 GET /api/skills 里，挂了它的 Agent 对话时跳过。

// SkillDef 是插件登记的一个技能，字段对齐原型 Skill。
type SkillDef struct {
	ID   string // = 清单 provides.skills 里的一项，以 sk_ 开头
	Name string
	Desc string // 一句话说明
	When string // 什么时候用
	// Instructions 是怎么做；为空时读 Prompt 里的 SKILL.md（embed 进来的，登记时读一次）
	Instructions string
	Prompt       fs.FS
	Tools        []string // 用到的工具，对应原型 uses
}

// Skills 返回在跑的插件登记的技能，按插件登记顺序，Source 为插件 id。不拿 r.mu，理由同 Subscribers。
func (r *Registry) Skills() []store.Skill {
	out := []store.Skill{}
	for _, id := range r.order {
		a := r.entries[id].active.Load()
		if a == nil {
			continue
		}
		for _, d := range a.skills {
			out = append(out, store.Skill{ID: d.ID, Name: d.Name, Desc: d.Desc, Source: id,
				Uses: slices.Clone(d.Tools), Instructions: d.Instructions, When: d.When})
		}
	}
	return out
}

func (c *collector) Skill(d SkillDef) {
	if strings.TrimSpace(d.Instructions) == "" && d.Prompt != nil {
		if b, err := fs.ReadFile(d.Prompt, "SKILL.md"); err == nil {
			d.Instructions = string(b)
		}
	}
	d.Name, d.Instructions = strings.TrimSpace(d.Name), strings.TrimSpace(d.Instructions)
	if d.Tools == nil {
		d.Tools = []string{}
	}
	_, builtin := agent.BuiltinSkill(d.ID)
	switch {
	case !slices.Contains(c.e.m.Provides.Skills, d.ID):
		c.add("技能不在清单 provides.skills 里：%s", d.ID)
	case builtin:
		c.add("技能 id 和内置技能重复：%s", d.ID)
	case d.Name == "":
		c.add("技能 %s 没有名称", d.ID)
	case d.Instructions == "":
		c.add("技能 %s 没有说明（Instructions 或 Prompt 里的 SKILL.md）", d.ID)
	case slices.ContainsFunc(c.a.skills, func(o SkillDef) bool { return o.ID == d.ID }):
		c.add("技能重复：%s", d.ID)
	default:
		c.a.skills = append(c.a.skills, d)
	}
}
