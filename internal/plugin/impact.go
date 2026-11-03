package plugin

import (
	"context"
	"errors"
	"regexp"
	"runtime/debug"
	"slices"
	"sync"
	"time"
)

// 删除连接器前的影响检查（CONN-03），见 docs/api-contract.md「连接器 connectors」。
// 插件登记影响提供者，接口层在删除前并发问一遍，汇总给人看；删除本身不经过插件，
// 删除后插件的数据怎么处理（保留、置空）由插件自己的表结构定，提供者只负责如实说出来。

// ConnectorRef 是要删的连接器实例。以后要给更多字段时只加不改。
type ConnectorRef struct {
	ID   string
	Tool string
}

// ConnectorImpactDef 是插件登记的一项影响。
type ConnectorImpactDef struct {
	Key string // 本插件内唯一，小写字母、数字、下划线，例 "messages"
	// Load 在影响检查接口里并发调用，超时（ConnectorImpactTimeout）、出错、panic 都记为没查完，不当成没有影响。
	// 返回 nil 或 Count 为 0 表示没有影响。
	Load func(ctx context.Context, c Core, cn ConnectorRef) (*ConnectorImpactData, error)
}

// ConnectorImpactData 是 Load 的结果。Text 是给人看的一句话（例「3 条 IM 消息会变成『渠道已删除』，只能查看」）。
type ConnectorImpactData struct {
	Count  int
	Text   string
	Effect string // ImpactKeep / ImpactRevoke / ImpactDetach / ImpactFallback
}

// 删除后这项数据的去向。
const (
	ImpactKeep     = "keep"     // 保留，只能查看
	ImpactRevoke   = "revoke"   // 一并删掉或撤销
	ImpactDetach   = "detach"   // 保留，关联置空
	ImpactFallback = "fallback" // 保留，改用别的方式（例提醒改为只在应用内）
)

// ImpactEffects 是 Effect 的合法取值。
var ImpactEffects = []string{ImpactKeep, ImpactRevoke, ImpactDetach, ImpactFallback}

// ConnectorImpact 是一项算好的影响。Failed 为 true 时这项没查完，Count、Text 为空。
type ConnectorImpact struct {
	Plugin string
	Key    string
	Count  int
	Text   string
	Effect string
	Failed bool
}

// ConnectorImpactTimeout 是单个提供者 Load 的上限。
const ConnectorImpactTimeout = 2 * time.Second

var impactKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// ConnectorImpacts 并发问在跑的插件登记的提供者，按插件登记顺序、登记顺序返回。
// 没有影响的不在里面；没查完的 Failed 为 true。停用的插件不问。不拿 r.mu，理由同 Subscribers。
func (r *Registry) ConnectorImpacts(ctx context.Context, cn ConnectorRef) []ConnectorImpact {
	type job struct {
		e   *entry
		def ConnectorImpactDef
	}
	var jobs []job
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil {
			continue
		}
		for _, def := range a.impacts {
			jobs = append(jobs, job{e, def})
		}
	}
	results := make([]*ConnectorImpact, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = r.loadImpact(ctx, j.e, j.def, cn)
		}()
	}
	wg.Wait()
	out := []ConnectorImpact{}
	for _, x := range results {
		if x != nil {
			out = append(out, *x)
		}
	}
	return out
}

func (r *Registry) loadImpact(ctx context.Context, e *entry, def ConnectorImpactDef, cn ConnectorRef) *ConnectorImpact {
	ctx, cancel := context.WithTimeout(ctx, ConnectorImpactTimeout)
	defer cancel()
	type res struct {
		d   *ConnectorImpactData
		err error
	}
	ch := make(chan res, 1)
	go func() {
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin connector impact panic", "impact", def.Key, "panic", v, "stack", string(debug.Stack()))
				ch <- res{err: errors.New("panic")}
			}
		}()
		d, err := def.Load(ctx, e.core, cn)
		ch <- res{d, err}
	}()
	failed := &ConnectorImpact{Plugin: e.m.ID, Key: def.Key, Failed: true}
	var got res
	select {
	case got = <-ch:
	case <-ctx.Done():
		e.core.log.Warn("plugin connector impact timed out", "impact", def.Key, "err", ctx.Err())
		return failed
	}
	switch {
	case got.err != nil:
		e.core.log.Warn("plugin connector impact failed", "impact", def.Key, "err", got.err)
		return failed
	case got.d == nil || got.d.Count <= 0:
		return nil
	case got.d.Text == "" || !slices.Contains(ImpactEffects, got.d.Effect):
		e.core.log.Warn("plugin connector impact malformed", "impact", def.Key, "effect", got.d.Effect)
		return failed
	}
	return &ConnectorImpact{Plugin: e.m.ID, Key: def.Key, Count: got.d.Count, Text: got.d.Text, Effect: got.d.Effect}
}

func (c *collector) ConnectorImpact(def ConnectorImpactDef) {
	switch {
	case !impactKeyRe.MatchString(def.Key):
		c.add("连接器影响的 key 只能是小写字母、数字、下划线：%q", def.Key)
	case def.Load == nil:
		c.add("连接器影响 %s 没有 Load", def.Key)
	case slices.ContainsFunc(c.a.impacts, func(o ConnectorImpactDef) bool { return o.Key == def.Key }):
		c.add("连接器影响重复：%s", def.Key)
	default:
		c.a.impacts = append(c.a.impacts, def)
	}
}
