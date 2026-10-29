package store

import "time"

// 技能（AG-01b2），字段对齐原型 web-next/src/agentdata.ts 的 Skill（SPEC-settings-16 数据）。
// 三种来源：内置写在 internal/agent，自定义存在 skills 表（0033），插件在 Register 里登记（plugin-api 2.6）。

// Skill 的来源：内置、自定义，其余是插件 id。
const (
	SkillBuiltin = "builtin"
	SkillCustom  = "custom"
)

// Skill 是一个技能。内置和插件技能没有时间戳，JSON 里不出现。
type Skill struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Desc         string    `json:"desc"`
	Source       string    `json:"source"`
	Uses         []string  `json:"uses"`
	Instructions string    `json:"instructions"`
	When         string    `json:"when"`
	CreatedAt    time.Time `json:"created_at,omitzero"`
	UpdatedAt    time.Time `json:"updated_at,omitzero"`
}

// SkillInput 是新建、修改自定义技能的字段，nil 表示没给。
type SkillInput struct {
	Name         *string   `json:"name"`
	Desc         *string   `json:"desc"`
	Instructions *string   `json:"instructions"`
	When         *string   `json:"when"`
	Uses         *[]string `json:"uses"`
}
