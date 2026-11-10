// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"slices"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// handleToday 是今日页的聚合接口：一次请求拿全内核卡片和在跑插件的卡片。
// type 的语义和 /api/counts 一样，前端拿同一个 type 去比对徽标。
func (s *Server) handleToday(w http.ResponseWriter, r *http.Request) {
	typ := newParams(r).str("type")
	t, err := s.st.Today(r.Context(), typ)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 插件卡片收不窄到某个类型，只在全局（不传 type）时合进来
	if s.opt.Plugins != nil && typ == "" {
		for _, c := range s.opt.Plugins.TodayCards(r.Context()) {
			t.Cards = append(t.Cards, &domain.TodayCard{Key: c.Key, Title: c.Title, Order: c.Order, Total: c.Total, Items: c.Items})
		}
		slices.SortStableFunc(t.Cards, func(x, y *domain.TodayCard) int { return x.Order - y.Order })
	}
	respondData(w, http.StatusOK, t)
}
