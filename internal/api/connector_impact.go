// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// --- 删除连接器前的影响检查（CONN-03）。只读，不拦删除；策略同原型 PR-01 的 connPlan ---

// connectorImpactItem 是一项影响。Source 是 core 或插件 id，Effect 见 plugin.ImpactEffects。
type connectorImpactItem struct {
	Source string `json:"source"`
	Key    string `json:"key"`
	Count  int    `json:"count"`
	Text   string `json:"text"`
	Effect string `json:"effect"`
}

type connectorImpactRef struct {
	Source string `json:"source"`
	Key    string `json:"key"`
}

type connectorImpact struct {
	ConnectorID string                `json:"connector_id"`
	Items       []connectorImpactItem `json:"items"`
	// Incomplete 是没查完（超时、出错）的提供者，非空时前端要提示影响可能不全
	Incomplete []connectorImpactRef `json:"incomplete"`
}

// coreConnectorImpact 是内核自己的影响：开着的工具授权随实例一起删掉。
func coreConnectorImpact(c *connector.Connector) []connectorImpactItem {
	var names []string
	for _, t := range c.Tools {
		if t.Mode != connector.ModeOff {
			names = append(names, t.Name)
		}
	}
	if len(names) == 0 {
		return nil
	}
	return []connectorImpactItem{{Source: "core", Key: "tool_grants", Count: len(names), Effect: plugin.ImpactRevoke,
		Text: fmt.Sprintf("%d 个 Agent 工具授权会一并撤销：%s", len(names), strings.Join(names, "、"))}}
}

func (s *Server) handleConnectorImpact(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	c, err := s.opt.Connectors.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := connectorImpact{ConnectorID: c.ID, Items: []connectorImpactItem{}, Incomplete: []connectorImpactRef{}}
	out.Items = append(out.Items, coreConnectorImpact(c)...)
	mounts, err := s.agentMountImpact(r.Context(), c)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out.Items = append(out.Items, mounts...)
	if s.opt.Plugins != nil {
		for _, x := range s.opt.Plugins.ConnectorImpacts(r.Context(), plugin.ConnectorRef{ID: c.ID, Tool: c.Tool}) {
			if x.Failed {
				out.Incomplete = append(out.Incomplete, connectorImpactRef{Source: x.Plugin, Key: x.Key})
				continue
			}
			out.Items = append(out.Items, connectorImpactItem{Source: x.Plugin, Key: x.Key, Count: x.Count, Text: x.Text, Effect: x.Effect})
		}
	}
	respondData(w, http.StatusOK, out)
}
