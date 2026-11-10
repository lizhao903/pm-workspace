// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"runtime/debug"
	"slices"
	"sync"
	"time"
)

// 今日卡片扩展点（TODAY-01b），见 docs/plugin-api.md 2.8。
// 形状和内核卡片一致：{key, title, order, total, items}，接口层合进 GET /api/today。

// TodayCardDef 是插件登记的一张今日卡片。
type TodayCardDef struct {
	Key   string // = 清单 provides.today_cards 里的一项，以 <id>_ 开头
	Title string
	Order int // 越小越靠前，0 表示默认 100；内核卡片占 10 到 40
	// Load 在今日聚合接口里并发调用，超时（TodayCardTimeout）就跳过这张卡，不拖慢整页。
	// 返回 nil 表示今天没有内容，卡片不显示。出错、panic 只记日志，同样跳过。
	Load func(ctx context.Context, c Core) (*TodayCardData, error)
}

// TodayCardData 是 Load 的结果。Total 是全量条数，Items 是要显示的那几条（建议不超过 50）。
// Items 为 nil 时按空列表返回。
type TodayCardData struct {
	Total int
	Items any
}

// TodayCard 是一张算好的插件卡片，接口层转成 domain.TodayCard。
type TodayCard struct {
	Plugin string
	Key    string
	Title  string
	Order  int
	Total  int
	Items  any
}

// TodayCardTimeout 是单张插件卡片 Load 的上限。
const TodayCardTimeout = 800 * time.Millisecond

// DefaultTodayCardOrder 是没写 Order 时的位置，排在内核卡片后面。
const DefaultTodayCardOrder = 100

// TodayCards 并发调在跑的插件登记的卡片，按 Order 排好（同 Order 按插件登记顺序、登记顺序）。
// 停用的插件不在里面；超时、出错、返回 nil 的卡片跳过。不拿 r.mu，理由同 Subscribers。
func (r *Registry) TodayCards(ctx context.Context) []TodayCard {
	type job struct {
		e   *entry
		def TodayCardDef
	}
	var jobs []job
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil {
			continue
		}
		for _, def := range a.cards {
			jobs = append(jobs, job{e, def})
		}
	}
	results := make([]*TodayCard, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = r.loadCard(ctx, j.e, j.def)
		}()
	}
	wg.Wait()
	out := []TodayCard{}
	for _, c := range results {
		if c != nil {
			out = append(out, *c)
		}
	}
	slices.SortStableFunc(out, func(x, y TodayCard) int { return x.Order - y.Order })
	return out
}

// loadCard 在超时内跑一次 Load。超时后不等 Load 返回，它的结果直接丢掉。
func (r *Registry) loadCard(ctx context.Context, e *entry, def TodayCardDef) *TodayCard {
	ctx, cancel := context.WithTimeout(ctx, TodayCardTimeout)
	defer cancel()
	type res struct {
		d   *TodayCardData
		err error
	}
	ch := make(chan res, 1)
	go func() {
		defer func() {
			if v := recover(); v != nil {
				e.core.log.Error("plugin today card panic", "card", def.Key, "panic", v, "stack", string(debug.Stack()))
				ch <- res{err: errors.New("panic")}
			}
		}()
		d, err := def.Load(ctx, e.core)
		ch <- res{d, err}
	}()
	var got res
	select {
	case got = <-ch:
	case <-ctx.Done():
		e.core.log.Warn("plugin today card skipped", "card", def.Key, "err", ctx.Err())
		return nil
	}
	if got.err != nil {
		e.core.log.Warn("plugin today card failed", "card", def.Key, "err", got.err)
		return nil
	}
	if got.d == nil {
		return nil
	}
	order := def.Order
	if order == 0 {
		order = DefaultTodayCardOrder
	}
	items := got.d.Items
	if items == nil {
		items = []any{}
	}
	return &TodayCard{Plugin: e.m.ID, Key: def.Key, Title: def.Title, Order: order, Total: got.d.Total, Items: items}
}

func (c *collector) TodayCard(def TodayCardDef) {
	switch {
	case !slices.Contains(c.e.m.Provides.TodayCards, def.Key):
		c.add("今日卡片不在清单 provides.today_cards 里：%s", def.Key)
	case def.Load == nil:
		c.add("今日卡片 %s 没有 Load", def.Key)
	case def.Title == "":
		c.add("今日卡片 %s 没有标题", def.Key)
	case slices.ContainsFunc(c.a.cards, func(o TodayCardDef) bool { return o.Key == def.Key }):
		c.add("今日卡片重复：%s", def.Key)
	default:
		c.a.cards = append(c.a.cards, def)
	}
}
