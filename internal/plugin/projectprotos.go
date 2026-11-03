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

// ProjectPrototype 是项目登记的一个原型：名字和目录（绝对路径）。
type ProjectPrototype struct {
	Name string
	Dir  string
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
