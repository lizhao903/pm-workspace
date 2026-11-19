// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"slices"
)

// 「项目原型目录」钩子（交给 Claude Code 带项目上下文），见 docs/plugin-api.md 2.13。
// 项目原型登记在项目插件的表里，内核读不到：项目插件用 Registrar.ProjectPrototypes 登记查询入口，
// 内核拼任务提示词时经 Registry.ProjectPrototypes 取某个项目登记的原型目录。
// 没有在跑的插件登记时回 ErrNoProjectPrototypes，调用方按「没有登记原型目录」处理。

// ProjectsModule 是能登记原型查询入口的功能模块：清单 provides.modules 里要有它。
const ProjectsModule = "projects"

// ErrNoProjectPrototypes：没有在跑的插件登记原型查询入口（项目插件没装或停用）。
var ErrNoProjectPrototypes = errors.New("no project prototype provider")

// ProjectPrototype 是项目的一个原型：名字、目录（绝对路径）和规则（多行纯文本，可空）。
// 规则是在这个原型上改时要守的约定（在哪个分支改、以哪份设计为准、改完在哪提交），原样写进提示词。
type ProjectPrototype struct {
	Name  string
	Dir   string
	Rules string
}

// ProjectPrototypeLister 列出一个项目登记的原型，按登记先后；项目没有原型回空切片。
type ProjectPrototypeLister func(ctx context.Context, projectID string) ([]ProjectPrototype, error)

func (c *collector) ProjectPrototypes(fn ProjectPrototypeLister) {
	switch {
	case !slices.Contains(c.e.m.Provides.Modules, ProjectsModule):
		c.add("只有 provides.modules 含 %s 的插件能登记项目原型的查询入口", ProjectsModule)
	case fn == nil:
		c.add("项目原型的查询入口是 nil")
	case c.a.projectPrototypes != nil:
		c.add("项目原型的查询入口重复登记")
	default:
		c.a.projectPrototypes = fn
	}
}

// ProjectPrototypes 交给登记了查询入口、正在跑的插件（按登记顺序第一个）列出项目的原型；
// 没有时回 ErrNoProjectPrototypes，插件 panic 转成错误。
func (r *Registry) ProjectPrototypes(ctx context.Context, projectID string) (out []ProjectPrototype, err error) {
	if r == nil {
		return nil, ErrNoProjectPrototypes
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.projectPrototypes == nil {
			continue
		}
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin project prototypes panic", "panic", v, "stack", string(debug.Stack()))
				out, err = nil, fmt.Errorf("查项目原型出错")
			}
		}()
		return a.projectPrototypes(ctx, projectID)
	}
	return nil, ErrNoProjectPrototypes
}

// 「项目执行白名单」钩子（TSK-0837）：项目档案里录的 Claude Code 权限规则（run_allow），
// 任务属于这个项目时由内核合进后台执行的 --allowedTools。档案在项目插件的表里，同原型目录走钩子取。

// ErrNoProjectRunAllow：没有在跑的插件登记执行白名单的查询入口（项目插件没装、停用或还没升到 0.20.0）。
var ErrNoProjectRunAllow = errors.New("no project run-allow provider")

// ProjectRunAllowLister 回一个项目档案里的执行白名单（已按 runner.CheckRule 校验过的规则）；没建档案、没录回空切片。
type ProjectRunAllowLister func(ctx context.Context, projectID string) ([]string, error)

func (c *collector) ProjectRunAllow(fn ProjectRunAllowLister) {
	switch {
	case !slices.Contains(c.e.m.Provides.Modules, ProjectsModule):
		c.add("只有 provides.modules 含 %s 的插件能登记项目执行白名单的查询入口", ProjectsModule)
	case fn == nil:
		c.add("项目执行白名单的查询入口是 nil")
	case c.a.projectRunAllow != nil:
		c.add("项目执行白名单的查询入口重复登记")
	default:
		c.a.projectRunAllow = fn
	}
}

// ProjectRunAllow 交给登记了查询入口、正在跑的插件（按登记顺序第一个）列出项目的执行白名单；
// 没有时回 ErrNoProjectRunAllow，插件 panic 转成错误。
func (r *Registry) ProjectRunAllow(ctx context.Context, projectID string) (out []string, err error) {
	if r == nil {
		return nil, ErrNoProjectRunAllow
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.projectRunAllow == nil {
			continue
		}
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin project run-allow panic", "panic", v, "stack", string(debug.Stack()))
				out, err = nil, fmt.Errorf("查项目执行白名单出错")
			}
		}()
		return a.projectRunAllow(ctx, projectID)
	}
	return nil, ErrNoProjectRunAllow
}

// 「项目目录」钩子（TSK-0841 复盘）：任务没挂项目、但交给 Claude Code 时的工作目录落在某个项目的目录里，
// 内核要按那个项目处理（提示词带「所属项目」、合项目执行白名单）。项目工作目录是对象的 workdir 列，内核自己读；
// 项目档案的代码库、原型库、需求文档目录在项目插件的表里，经这个钩子取。

// ErrNoProjectDirs：没有在跑的插件登记项目目录的查询入口（项目插件没装、停用或还没升到 0.21.0）。
var ErrNoProjectDirs = errors.New("no project dirs provider")

// 项目档案目录的种类，ProjectDir.Kind 取值。
const (
	ProjectDirCode      = "code_dir"
	ProjectDirPrototype = "proto_dir"
	ProjectDirPRD       = "prd_dir"
)

// ProjectDir 是某个项目档案里设的一个目录（原样，未解析软链）。
type ProjectDir struct {
	ProjectID string
	Kind      string
	Dir       string
}

// ProjectDirLister 列出所有项目档案里设了的目录（空的不回）；项目已删的由调用方过滤。
type ProjectDirLister func(ctx context.Context) ([]ProjectDir, error)

func (c *collector) ProjectDirs(fn ProjectDirLister) {
	switch {
	case !slices.Contains(c.e.m.Provides.Modules, ProjectsModule):
		c.add("只有 provides.modules 含 %s 的插件能登记项目目录的查询入口", ProjectsModule)
	case fn == nil:
		c.add("项目目录的查询入口是 nil")
	case c.a.projectDirs != nil:
		c.add("项目目录的查询入口重复登记")
	default:
		c.a.projectDirs = fn
	}
}

// ProjectDirs 交给登记了查询入口、正在跑的插件（按登记顺序第一个）列出项目档案目录；
// 没有时回 ErrNoProjectDirs，插件 panic 转成错误。
func (r *Registry) ProjectDirs(ctx context.Context) (out []ProjectDir, err error) {
	if r == nil {
		return nil, ErrNoProjectDirs
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.projectDirs == nil {
			continue
		}
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin project dirs panic", "panic", v, "stack", string(debug.Stack()))
				out, err = nil, fmt.Errorf("查项目目录出错")
			}
		}()
		return a.projectDirs(ctx)
	}
	return nil, ErrNoProjectDirs
}
