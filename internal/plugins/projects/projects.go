// Package projects 是「项目」插件的后端（PJ-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 现在只是壳：登记插件、没有路由和后台任务；真实功能在 PJ-01b 起补，清单的 provides 随之扩充。
package projects

import (
	_ "embed"
	"io/fs"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

// Plugin 是项目插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct{ m plugin.Manifest }

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON)} }

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 先返回 nil：migrations/ 里还只有 .gitkeep，embed 不了空目录。
// 加第一条迁移时改成 embed migrations/*.sql，TestMigrationsEmbedded 会提醒。
func (p *Plugin) Migrations() fs.FS { return nil }

func (p *Plugin) Register(plugin.Registrar) error { return nil }
