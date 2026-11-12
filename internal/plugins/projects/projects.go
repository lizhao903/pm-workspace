// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package projects 是「项目」插件的后端（PJ-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 项目本身仍是内核 type=project 的对象，字段约定见 docs/api-contract.md「项目插件」；
// 插件自己的表放项目干系人（PJ-01b）、绑定的 IM 会话（PJ-02a）、项目资料（PJ-03a）、原型定义和崩溃记录（PJ-04a）、项目档案（AUTO-04）、需求工作区（AUTO-07）、测试记录（AUTO-08）、发布记录（AUTO-10）、原型同步记录（AUTO-11）、项目绑定的知识库（TSK-0721）。
package projects

import (
	"context"
	"embed"
	"io/fs"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是项目插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m plugin.Manifest
	// publicURL 是浏览器访问工作台的地址（--public-url），「跑测试」输出里的报告链接拼在它后面（AUTO-09）
	publicURL string
	// tests 是最近一次启用登记的测试服务，只给测试用
	tests *testService
	// releases 是最近一次启用登记的发布服务，只给测试用
	releases *releaseService
	// protoSyncs 是最近一次启用登记的原型同步服务，只给测试用
	protoSyncs *protoSyncService
}

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON)} }

// WithPublicURL 设浏览器访问工作台的地址（cmd/pmw 传 --public-url）。
func (p *Plugin) WithPublicURL(u string) *Plugin {
	p.publicURL = strings.TrimRight(strings.TrimSpace(u), "/")
	return p
}

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
		sm := &summary{h, pm}
		m.HandleFunc("GET /api/projects/summary", sm.list)
		pf := &profiles{h}
		m.HandleFunc("GET /api/projects/profiles", pf.list)
		m.HandleFunc("GET /api/projects/{id}/profile", pf.show)
		m.HandleFunc("PATCH /api/projects/{id}/profile", pf.update)
	})
	// SOP 节点：列项目档案、读项目档案（AUTO-06，sopnodes.go）；登记时按 kind 补上节点声明（TSK-0490，sopspec.go）
	r = plugin.WithSOPSpecs(r, sopSpecs)
	registerSOPNodes(r)
	// 需求级 git worktree：接口、SOP 节点「准备工作区」、任务完成或上线后自动清理（AUTO-07，worktrees.go）
	ws := newWorktreeService(r.Core())
	ws.register(r, h)
	// 测试环境与测试报告：接口、SOP 节点「跑测试」（AUTO-08，testenv.go）
	ts := newTestService(r.Core(), ws, p.publicURL)
	ts.register(r, h)
	p.tests = ts
	// 发布：接口、SOP 节点「准备发布」「上线」，审批前只跑版本号和打包，上线后冒烟没过自动回滚（AUTO-10，release.go）
	rs := newReleaseService(r.Core(), ws, p.publicURL)
	rs.register(r, h)
	p.releases = rs
	// 原型回写旁路：同步点、三种触发（发布成功、生产分支合并、每日巡检）和原型同步的几个 SOP 节点（AUTO-11，protosync.go）
	ps := newProtoSyncService(r.Core())
	ps.register(r, h)
	rs.onReleased = ps.onReleased
	p.protoSyncs = ps
	// 项目知识库：绑定接口、SOP 节点「项目资料同步到知识库」、内置流程「每周一 10:00 整理项目知识库」（TSK-0721，kb.go）
	newKBService(r.Core(), h).register(r)
	// 交给 Claude Code 时内核经这个入口取项目登记的原型目录
	r.ProjectPrototypes(prototypeDirs(r.Core()))
	// 常驻任务只等取消：插件停用、服务关闭时停掉这次启用起的全部原型进程
	r.Job(plugin.Job{Name: "prototypes", Run: func(ctx context.Context, _ plugin.Core) error {
		<-ctx.Done()
		pm.closeAll()
		return nil
	}})
	return nil
}
