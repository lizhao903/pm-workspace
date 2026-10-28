// Package projects 是「项目」插件的后端（PJ-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 项目本身仍是内核 type=project 的对象，字段约定见 docs/api-contract.md「项目插件」；
// 插件自己的表放项目干系人（PJ-01b）、绑定的 IM 会话（PJ-02a）、项目资料（PJ-03a）、原型定义和崩溃记录（PJ-04a）。
package projects

import (
	"context"
	"embed"
	"io/fs"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是项目插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct{ m plugin.Manifest }

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON)} }

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

func (p *Plugin) Register(r plugin.Registrar) error {
	h := &stakeholders{c: r.Core()}
	pm := newManager(r.Core()) // 每次启用一个，只建结构不起进程
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/projects/{id}/stakeholders", h.list)
		m.HandleFunc("POST /api/projects/{id}/stakeholders", h.add)
		m.HandleFunc("PATCH /api/projects/{id}/stakeholders/{stakeholder_id}", h.update)
		m.HandleFunc("DELETE /api/projects/{id}/stakeholders/{stakeholder_id}", h.remove)
		ch := &chats{h}
		m.HandleFunc("GET /api/projects/{id}/conversations", ch.list)
		m.HandleFunc("POST /api/projects/{id}/conversations", ch.bind)
		m.HandleFunc("DELETE /api/projects/{id}/conversations/{conversation_id}", ch.unbind)
		mt := &materials{h}
		m.HandleFunc("GET /api/projects/{id}/materials", mt.list)
		m.HandleFunc("POST /api/projects/{id}/materials", mt.add)
		m.HandleFunc("GET /api/projects/{id}/materials/{material_id}", mt.show)
		m.HandleFunc("PATCH /api/projects/{id}/materials/{material_id}", mt.update)
		m.HandleFunc("DELETE /api/projects/{id}/materials/{material_id}", mt.remove)
		pt := &prototypes{h, pm}
		m.HandleFunc("GET /api/projects/{id}/prototypes", pt.list)
		m.HandleFunc("POST /api/projects/{id}/prototypes", pt.add)
		m.HandleFunc("GET /api/projects/{id}/prototypes/{prototype_id}", pt.show)
		m.HandleFunc("PATCH /api/projects/{id}/prototypes/{prototype_id}", pt.update)
		m.HandleFunc("DELETE /api/projects/{id}/prototypes/{prototype_id}", pt.remove)
		m.HandleFunc("POST /api/projects/{id}/prototypes/{prototype_id}/start", pt.start)
		m.HandleFunc("POST /api/projects/{id}/prototypes/{prototype_id}/stop", pt.stop)
		m.HandleFunc("GET /api/projects/{id}/prototypes/{prototype_id}/logs", pt.logs)
		m.HandleFunc("GET /api/projects/{id}/prototypes/{prototype_id}/crashes", pt.crashes)
	})
	// 常驻任务只等取消：插件停用、服务关闭时停掉这次启用起的全部原型进程
	r.Job(plugin.Job{Name: "prototypes", Run: func(ctx context.Context, _ plugin.Core) error {
		<-ctx.Done()
		pm.closeAll()
		return nil
	}})
	return nil
}
