// Package projects 是「项目」插件的后端（PJ-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 项目本身仍是内核 type=project 的对象，字段约定见 docs/api-contract.md「项目插件」；
// 插件自己的表放项目干系人（PJ-01b）、绑定的 IM 会话（PJ-02a），项目资料、原型启停随 PJ-03 起补。
package projects

import (
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
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/projects/{id}/stakeholders", h.list)
		m.HandleFunc("POST /api/projects/{id}/stakeholders", h.add)
		m.HandleFunc("PATCH /api/projects/{id}/stakeholders/{stakeholder_id}", h.update)
		m.HandleFunc("DELETE /api/projects/{id}/stakeholders/{stakeholder_id}", h.remove)
		ch := &chats{h}
		m.HandleFunc("GET /api/projects/{id}/conversations", ch.list)
		m.HandleFunc("POST /api/projects/{id}/conversations", ch.bind)
		m.HandleFunc("DELETE /api/projects/{id}/conversations/{conversation_id}", ch.unbind)
	})
	return nil
}
