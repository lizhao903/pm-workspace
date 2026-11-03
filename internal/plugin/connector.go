package plugin

import (
	"slices"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// 连接器扩展点（CONN-02），见 docs/plugin-api.md 2.5。
// 定义的形状就是内核连接器框架的 connector.Def：认证、配置表单、凭证、工具授权都由内核管，
// 插件只给定义和 Test、ListTools 两个适配函数。实例存在内核 connectors 表里，插件停用时不动。

// ConnectorDef 是插件登记的连接器定义。Source 由内核填成插件 id，插件写了也会被覆盖。
type ConnectorDef = connector.Def

// ConnectorDefs 返回在跑的插件登记的连接器定义，按插件登记顺序。
// 接到 connector.Registry.SetPluginDefs：停用的插件不在里面，它的实例 available 为 false；重新启用后恢复。
// 不拿 r.mu，理由同 Subscribers。
func (r *Registry) ConnectorDefs() []connector.Def {
	var out []connector.Def
	for _, id := range r.order {
		if a := r.entries[id].active.Load(); a != nil {
			out = append(out, a.conns...)
		}
	}
	return out
}

func (c *collector) Connector(d ConnectorDef) {
	d.Source = c.e.m.ID
	switch {
	case !slices.Contains(c.e.m.Provides.Connectors, d.Tool):
		c.add("连接器不在清单 provides.connectors 里：%s", d.Tool)
	case slices.ContainsFunc(c.a.conns, func(o ConnectorDef) bool { return o.Tool == d.Tool }):
		c.add("连接器重复：%s", d.Tool)
	default:
		p, err := connector.Prepare(d)
		if err != nil {
			c.add("连接器 %s 不合法：%v", d.Tool, err)
			return
		}
		c.a.conns = append(c.a.conns, p)
	}
}
