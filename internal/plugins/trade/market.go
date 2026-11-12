// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 行情缓存和刷新（TRD-02a）。
//
// 上游用 REST 轮询，不接交易所 WebSocket：插件出网只能走 Core.HTTP("market-data") 拿到的 *http.Client，
// 域名白名单在每一跳上检查；WebSocket 要自己拨号，绕过这层检查，等内核给出受控的 WebSocket 句柄再换，换时接口不变。
//
// 最新价、盘口、资金费率放内存：
//   - 被 SSE 订阅的标的和最近 30 秒被 /quotes 轮询过的标的，每秒刷一次最新价；
//   - 自选里其余的标的 30 秒刷一次；
//   - 盘口只刷「正在看」的标的（SSE 的 focus、最近 30 秒被 /book 查过的），每秒一次；资金费率 30 秒一次。
// 最新价每 30 秒落一次 trade_quotes，重启后交易所连不上时还有带数据时间的缓存可看。
// K 线落 trade_klines，按 trade_kline_spans 记的已取区间按需补齐（klines.go）。
//
// 限频：每个源一个令牌桶（Binance 每秒 10 次，权重远低于现货 6000/分、合约 2400/分的上限；OKX 每秒 8 次，
// 低于行情接口 20 次/2 秒的单接口上限）。令牌不够的刷新顺延到下一轮。
// 退避：被限频（429、418、交易所限频错误码）立刻进入退避并把源标为异常；网络错误、5xx 连续两次才标异常。
// 退避 1、2、4 … 60 秒封顶，有 Retry-After 时取较大者；退避期间不发请求，数据降级为缓存（status=stale）。
// 源的状态变化同步到它登记的连接器实例（binance_market、okx_market）：异常时置为异常并记原因，恢复后回到已连接。

const (
	hotEvery      = time.Second      // 订阅中的最新价、盘口
	watchEvery    = 30 * time.Second // 只在自选里的最新价
	fundingEvery  = 30 * time.Second
	pollKeep      = 30 * time.Second // 轮询过的标的保持热刷新多久
	watchReload   = time.Minute      // 多久重读一次自选
	persistEvery  = 30 * time.Second // 最新价落库间隔
	staleAfter    = 90 * time.Second // 超过这么久没刷到算过期
	maxBackoff    = 60 * time.Second
	failThreshold = 2 // 网络错误连续几次标异常
	bookDepth     = 20
)

// sourceRates 是每个源每秒最多发几次请求；没写的按 5。
var sourceRates = map[string]float64{"binance": 10, "okx": 8}

// Quote 是一个标的的最新价快照，接口和推送里的形状（TradeQuote）。
// status：live 实时；stale 交易所暂时取不到、给的是缓存；loading 还没取到；error 取失败且没有缓存；no_source 没有行情源覆盖它。
// change、change_pct 相对 24 小时前的开盘价，change_pct 是小数（0.0123 即 1.23%）。at 是交易所给的数据时间，fetched_at 是本机取到的时间。
type Quote struct {
	Symbol    string  `json:"symbol"`
	Source    string  `json:"source"`
	Status    string  `json:"status"`
	Error     string  `json:"error"`
	Last      float64 `json:"last"`
	Bid       float64 `json:"bid"`
	Ask       float64 `json:"ask"`
	Open24h   float64 `json:"open_24h"`
	High24h   float64 `json:"high_24h"`
	Low24h    float64 `json:"low_24h"`
	Volume24h float64 `json:"volume_24h"`
	Change    float64 `json:"change"`
	ChangePct float64 `json:"change_pct"`
	At        string  `json:"at"`
	FetchedAt string  `json:"fetched_at"`
}

// Book 是盘口快照（TradeBook），status 同 Quote。数量是标的币数量。
type Book struct {
	Symbol    string  `json:"symbol"`
	Source    string  `json:"source"`
	Status    string  `json:"status"`
	Error     string  `json:"error"`
	Bids      []Level `json:"bids"`
	Asks      []Level `json:"asks"`
	At        string  `json:"at"`
	FetchedAt string  `json:"fetched_at"`
}

// FundingView 是资金费率快照（TradeFunding），status 同 Quote；不是永续的标的 status 为 unsupported。
// rate 是小数（0.0001 即 0.01%），next_time 是这一期结算时间。
type FundingView struct {
	Symbol    string  `json:"symbol"`
	Source    string  `json:"source"`
	Status    string  `json:"status"`
	Error     string  `json:"error"`
	Rate      float64 `json:"rate"`
	NextTime  string  `json:"next_time"`
	At        string  `json:"at"`
	FetchedAt string  `json:"fetched_at"`
}

// SourceHealth 是行情源的连接状态：ok 正常，error 异常（retry_at 前不再请求），idle 还没发过请求。
type SourceHealth struct {
	Status   string `json:"status"`
	Error    string `json:"error"`
	Since    string `json:"since"`
	LastOKAt string `json:"last_ok_at"`
	RetryAt  string `json:"retry_at"`
}

type snap[T any] struct {
	v         T
	ok        bool // 有过数据
	fetchedAt time.Time
	err       string // 最近一次失败的原因，成功后清空
	triedAt   time.Time
	cached    bool // 从 trade_quotes 读回来的
}

type health struct {
	status        string
	err           string
	since, lastOK time.Time
	retryAt       time.Time
	fails         int
	syncedAt      time.Time // 最近一次同步连接器
	tokens        float64
	tokAt         time.Time
}

type market struct {
	p   *Plugin
	c   plugin.Core
	now func() time.Time

	mu      sync.Mutex
	quotes  map[string]*snap[Ticker]
	books   map[string]*snap[OrderBook]
	funding map[string]*snap[Funding]
	subs    map[string]int       // symbol -> SSE 订阅数
	focus   map[string]int       // 看盘口的 symbol -> SSE 订阅数
	polled  map[string]time.Time // /quotes 最近查过
	bookAt  map[string]time.Time // /book、/funding 最近查过
	watch   []string
	watchAt time.Time
	health  map[string]*health
	saved   map[string]time.Time // trade_quotes 最近落库时间
	loaded  map[string]bool      // 已尝试从 trade_quotes 读过

	klMu    sync.Mutex // K 线取数串行，同一区间并发查只请求一次
	forming map[string]snap[Kline]
}

func newMarket(p *Plugin, c plugin.Core) *market {
	now := p.now
	if now == nil {
		now = time.Now
	}
	m := &market{p: p, c: c, now: func() time.Time { return now().UTC() },
		quotes: map[string]*snap[Ticker]{}, books: map[string]*snap[OrderBook]{}, funding: map[string]*snap[Funding]{},
		subs: map[string]int{}, focus: map[string]int{}, polled: map[string]time.Time{}, bookAt: map[string]time.Time{},
		health: map[string]*health{}, saved: map[string]time.Time{}, loaded: map[string]bool{}, forming: map[string]snap[Kline]{}}
	for _, s := range p.sources {
		m.health[s.ID()] = &health{status: "idle", tokens: rateOf(s.ID())}
	}
	return m
}

func rateOf(id string) float64 {
	if r, ok := sourceRates[id]; ok {
		return r
	}
	return 5
}

// sourceFor 按 symbol 的交易场所找源：BINANCE: -> binance，OKX: -> okx，FAKE: -> fake。
func (p *Plugin) sourceFor(symbol string) Source {
	venue, _ := codeOf(symbol)
	for _, s := range p.sources {
		if strings.EqualFold(s.ID(), venue) {
			return s
		}
	}
	return nil
}

func fmtT(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// ---- 限频和健康 ----

// take 取一个令牌，取不到回 false（本轮不发这个请求）。
func (m *market) take(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.takeLocked(id)
}

func (m *market) takeLocked(id string) bool {
	h := m.health[id]
	if h == nil {
		return false
	}
	now := m.now()
	if now.Before(h.retryAt) {
		return false
	}
	rate := rateOf(id)
	if !h.tokAt.IsZero() {
		h.tokens = math.Min(rate, h.tokens+now.Sub(h.tokAt).Seconds()*rate)
	}
	h.tokAt = now
	if h.tokens < 1 {
		return false
	}
	h.tokens--
	return true
}

// wait 等一个令牌，最多等到 ctx 结束或 3 秒；在退避期回 false。用户发起的请求（K 线、冷启动的报价）用。
func (m *market) wait(ctx context.Context, id string) bool {
	deadline := time.Now().Add(3 * time.Second)
	for {
		m.mu.Lock()
		h := m.health[id]
		backoff := h == nil || m.now().Before(h.retryAt)
		ok := !backoff && m.takeLocked(id)
		m.mu.Unlock()
		if ok {
			return true
		}
		if backoff || time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// healthy 是源不在退避期。
func (m *market) healthy(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.health[id]
	return h != nil && !m.now().Before(h.retryAt)
}

// symbolErr 是这个标的自己的问题（没有、不支持、参数），不算源异常。
func symbolErr(err error) bool {
	return errors.Is(err, ErrUnknownSymbol) || errors.Is(err, ErrUnsupported) || errors.Is(err, errValidation)
}

// report 记一次请求的结果，回源状态是否变了；变了的话同步连接器。
func (m *market) report(ctx context.Context, id string, err error) {
	if err != nil && (symbolErr(err) || errors.Is(err, context.Canceled)) {
		return
	}
	m.mu.Lock()
	h := m.health[id]
	if h == nil {
		m.mu.Unlock()
		return
	}
	now := m.now()
	changed := false
	if err == nil {
		h.fails, h.retryAt, h.lastOK = 0, time.Time{}, now
		if h.status != "ok" {
			h.status, h.err, h.since, changed = "ok", "", now, true
		}
	} else {
		h.fails++
		wait := min(maxBackoff, time.Second<<min(h.fails-1, 6))
		var ue *UpstreamError
		limited := errors.As(err, &ue) && ue.RateLimited
		if limited && ue.RetryAfter > wait {
			wait = min(ue.RetryAfter, 10*time.Minute)
		}
		h.retryAt = now.Add(wait)
		if (limited || h.fails >= failThreshold) && (h.status != "error" || h.err != err.Error()) {
			changed = h.status != "error"
			h.status, h.err = "error", err.Error()
			if changed {
				h.since = now
			}
		}
	}
	tool := ""
	if cs, ok := m.p.source(id).(connectorSource); ok {
		tool = cs.ConnectorTool()
	}
	status, msg := h.status, h.err
	// 状态变了立刻同步连接器；正常时每分钟再记一次同步时间（新建的实例也就此变成已连接）
	doSync := changed || (err == nil && now.Sub(h.syncedAt) >= time.Minute)
	if doSync {
		h.syncedAt = now
	}
	m.mu.Unlock()
	if changed && status == "error" {
		m.c.Log().Warn("market source unhealthy", "source", id, "err", msg)
	} else if changed {
		m.c.Log().Info("market source recovered", "source", id)
	}
	if doSync && tool != "" {
		m.syncConnectors(ctx, tool, err)
	}
}

// syncConnectors 把源状态记到这个连接器 tool 的所有实例上；没有实例、没接连接器时什么都不做。
func (m *market) syncConnectors(ctx context.Context, tool string, err error) {
	list, lerr := m.c.Connectors().List(ctx, tool)
	if lerr != nil {
		return
	}
	for _, ci := range list {
		if _, e := m.c.Connectors().RecordSync(ctx, ci.ID, err); e != nil {
			m.c.Log().Warn("record connector sync failed", "connector", ci.ID, "err", e)
		}
	}
}

func (m *market) sourceHealth(id string) SourceHealth {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.health[id]
	if h == nil {
		return SourceHealth{Status: "idle"}
	}
	out := SourceHealth{Status: h.status, Error: h.err, Since: fmtT(h.since), LastOKAt: fmtT(h.lastOK)}
	if m.now().Before(h.retryAt) {
		out.RetryAt = fmtT(h.retryAt)
	}
	return out
}

// ---- 订阅 ----

func (m *market) subscribe(symbols []string, focus string) func() {
	m.mu.Lock()
	for _, s := range symbols {
		m.subs[s]++
	}
	if focus != "" {
		m.focus[focus]++
	}
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, s := range symbols {
			if m.subs[s]--; m.subs[s] <= 0 {
				delete(m.subs, s)
			}
		}
		if focus != "" {
			if m.focus[focus]--; m.focus[focus] <= 0 {
				delete(m.focus, focus)
			}
		}
	}
}

// ---- 刷新 ----

type job struct {
	kind   string // ticker / book / funding
	symbol string
	src    Source
	age    time.Duration
}

// due 列出这一轮到期的刷新，按源分组、最久没刷的在前。
func (m *market) due(ctx context.Context) map[string][]job {
	now := m.now()
	if now.Sub(m.watchAt) >= watchReload {
		m.watchAt = now
		m.watch = m.loadWatchSymbols(ctx)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	hot := map[string]bool{}
	for s := range m.subs {
		hot[s] = true
	}
	for s, at := range m.polled {
		if now.Sub(at) > pollKeep {
			delete(m.polled, s)
			continue
		}
		hot[s] = true
	}
	looking := map[string]bool{}
	for s := range m.focus {
		looking[s] = true
	}
	for s, at := range m.bookAt {
		if now.Sub(at) > pollKeep {
			delete(m.bookAt, s)
			continue
		}
		looking[s] = true
	}
	out := map[string][]job{}
	add := func(kind, sym string, every time.Duration, tried time.Time) {
		src := m.p.sourceFor(sym)
		if src == nil {
			return
		}
		age := now.Sub(tried)
		if !tried.IsZero() && age < every-50*time.Millisecond {
			return
		}
		out[src.ID()] = append(out[src.ID()], job{kind: kind, symbol: sym, src: src, age: age})
	}
	seen := map[string]bool{}
	for s := range hot {
		seen[s] = true
		add("ticker", s, hotEvery, triedAt(m.quotes[s]))
	}
	for _, s := range m.watch {
		if !seen[s] {
			seen[s] = true
			add("ticker", s, watchEvery, triedAt(m.quotes[s]))
		}
	}
	for s := range looking {
		add("book", s, hotEvery, triedAt(m.books[s]))
		if strings.HasSuffix(s, ".P") || strings.HasSuffix(s, "-SWAP") {
			add("funding", s, fundingEvery, triedAt(m.funding[s]))
		}
	}
	for id := range out {
		js := out[id]
		// 没取过的（age 很大）在前；同龄的盘口在前，最新价次之
		sort.SliceStable(js, func(i, j int) bool { return js[i].age > js[j].age })
	}
	return out
}

func triedAt[T any](s *snap[T]) time.Time {
	if s == nil {
		return time.Time{}
	}
	return s.triedAt
}

func (m *market) loadWatchSymbols(ctx context.Context) []string {
	rows, err := m.c.Store().Query(ctx, `SELECT symbols FROM trade_watchlists`)
	if err != nil {
		return m.watch
	}
	defer func() { _ = rows.Close() }()
	seen := map[string]bool{}
	var out []string
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		var syms []string
		_ = json.Unmarshal([]byte(raw), &syms)
		for _, s := range syms {
			if !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}

// tick 跑一轮刷新：每个源一个协程，按令牌发请求，拿不到令牌的留到下一轮。
func (m *market) tick(ctx context.Context) {
	groups := m.due(ctx)
	var wg sync.WaitGroup
	for id, js := range groups {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, j := range js {
				if ctx.Err() != nil || !m.take(id) {
					return
				}
				m.refresh(ctx, j)
			}
		}()
	}
	wg.Wait()
	m.persist(ctx)
}

// run 是常驻任务：每 tick 一轮，直到插件停用。
func (m *market) run(ctx context.Context) error {
	every := m.p.tick
	if every <= 0 {
		every = hotEvery
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		m.tick(rctx)
		cancel()
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// refresh 发一个请求并写进缓存。
func (m *market) refresh(ctx context.Context, j job) {
	rctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	now := m.now()
	switch j.kind {
	case "ticker":
		v, err := j.src.Ticker(rctx, j.symbol)
		put(m, m.quotes, j.symbol, v, err, now)
		m.report(ctx, j.src.ID(), err)
	case "book":
		v, err := j.src.OrderBook(rctx, j.symbol, bookDepth)
		put(m, m.books, j.symbol, v, err, now)
		m.report(ctx, j.src.ID(), err)
	case "funding":
		v, err := j.src.Funding(rctx, j.symbol)
		put(m, m.funding, j.symbol, v, err, now)
		m.report(ctx, j.src.ID(), err)
	}
}

func put[T any](m *market, store map[string]*snap[T], sym string, v T, err error, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := store[sym]
	if s == nil {
		s = &snap[T]{}
		store[sym] = s
	}
	s.triedAt = now
	if err != nil {
		s.err = err.Error()
		return
	}
	s.v, s.ok, s.err, s.fetchedAt, s.cached = v, true, "", now, false
}

// ---- 读快照 ----

// status 按有没有数据、最近一次有没有失败、源是否在退避、数据多旧给出 live / stale / loading / error。
func (m *market) statusOf(ok bool, err string, fetchedAt time.Time, cached bool, srcID string) string {
	switch {
	case !ok && err != "":
		return "error"
	case !ok:
		return "loading"
	}
	h := m.health[srcID]
	if cached || err != "" || (h != nil && h.status == "error") || m.now().Sub(fetchedAt) > staleAfter {
		return "stale"
	}
	return "live"
}

func (m *market) quote(ctx context.Context, sym string) Quote {
	src := m.p.sourceFor(sym)
	if src == nil {
		return Quote{Symbol: sym, Status: "no_source", Error: "这个市场的行情源还没接"}
	}
	m.loadCached(ctx, sym)
	m.mu.Lock()
	defer m.mu.Unlock()
	q := Quote{Symbol: sym, Source: src.ID()}
	s := m.quotes[sym]
	if s == nil {
		q.Status = "loading"
		return q
	}
	q.Status, q.Error = m.statusOf(s.ok, s.err, s.fetchedAt, s.cached, src.ID()), s.err
	if q.Status == "stale" && q.Error == "" {
		if h := m.health[src.ID()]; h != nil && h.status == "error" {
			q.Error = h.err
		}
	}
	if s.ok {
		t := s.v
		q.Last, q.Bid, q.Ask, q.Open24h, q.High24h, q.Low24h, q.Volume24h = t.Last, t.Bid, t.Ask, t.Open24h, t.High24h, t.Low24h, t.Volume24h
		if t.Open24h > 0 {
			q.Change = t.Last - t.Open24h
			q.ChangePct = q.Change / t.Open24h
		}
		q.At, q.FetchedAt = fmtT(t.At), fmtT(s.fetchedAt)
	}
	return q
}

func (m *market) book(sym string, depth int) Book {
	src := m.p.sourceFor(sym)
	if src == nil {
		return Book{Symbol: sym, Status: "no_source", Error: "这个市场的行情源还没接", Bids: []Level{}, Asks: []Level{}}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b := Book{Symbol: sym, Source: src.ID(), Status: "loading", Bids: []Level{}, Asks: []Level{}}
	s := m.books[sym]
	if s == nil {
		return b
	}
	b.Status, b.Error = m.statusOf(s.ok, s.err, s.fetchedAt, false, src.ID()), s.err
	if s.ok {
		b.Bids, b.Asks = s.v.Bids[:min(depth, len(s.v.Bids))], s.v.Asks[:min(depth, len(s.v.Asks))]
		if b.Bids == nil {
			b.Bids = []Level{}
		}
		if b.Asks == nil {
			b.Asks = []Level{}
		}
		b.At, b.FetchedAt = fmtT(s.v.At), fmtT(s.fetchedAt)
	}
	return b
}

func isPerp(sym string) bool { return strings.HasSuffix(sym, ".P") || strings.HasSuffix(sym, "-SWAP") }

func (m *market) fundingOf(sym string) FundingView {
	src := m.p.sourceFor(sym)
	if src == nil {
		return FundingView{Symbol: sym, Status: "no_source", Error: "这个市场的行情源还没接"}
	}
	if !isPerp(sym) {
		return FundingView{Symbol: sym, Source: src.ID(), Status: "unsupported", Error: "不是永续合约，没有资金费率"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	f := FundingView{Symbol: sym, Source: src.ID(), Status: "loading"}
	s := m.funding[sym]
	if s == nil {
		return f
	}
	f.Status, f.Error = m.statusOf(s.ok, s.err, s.fetchedAt, false, src.ID()), s.err
	if s.ok && m.now().Sub(s.fetchedAt) <= 5*time.Minute && f.Status == "stale" && s.err == "" {
		// 资金费率 30 秒才刷一次，源正常时 5 分钟内都算实时
		if h := m.health[src.ID()]; h == nil || h.status != "error" {
			f.Status = "live"
		}
	}
	if s.ok {
		f.Rate, f.NextTime, f.At, f.FetchedAt = s.v.Rate, fmtT(s.v.NextTime), fmtT(s.v.At), fmtT(s.fetchedAt)
	}
	return f
}

// ensure 在缓存里还没有时同步取一次（接口直接查时用），源在退避期就不取。
func (m *market) ensure(ctx context.Context, kind, sym string) {
	src := m.p.sourceFor(sym)
	if src == nil {
		return
	}
	m.mu.Lock()
	var have bool
	switch kind {
	case "ticker":
		s := m.quotes[sym]
		have = s != nil && (s.ok && !s.cached || m.now().Sub(s.triedAt) < hotEvery)
	case "book":
		s := m.books[sym]
		have = s != nil && m.now().Sub(s.triedAt) < hotEvery
	case "funding":
		s := m.funding[sym]
		have = !isPerp(sym) || s != nil && m.now().Sub(s.triedAt) < fundingEvery
	}
	m.mu.Unlock()
	if have || !m.wait(ctx, src.ID()) {
		return
	}
	m.refresh(ctx, job{kind: kind, symbol: sym, src: src})
}

// ---- trade_quotes ----

// persist 把超过 persistEvery 没落库的最新价写进 trade_quotes。
func (m *market) persist(ctx context.Context) {
	now := m.now()
	type row struct {
		sym, src string
		t        Ticker
		at       time.Time
	}
	var rows []row
	m.mu.Lock()
	for sym, s := range m.quotes {
		if !s.ok || s.cached || now.Sub(m.saved[sym]) < persistEvery {
			continue
		}
		src := m.p.sourceFor(sym)
		if src == nil {
			continue
		}
		m.saved[sym] = now
		rows = append(rows, row{sym, src.ID(), s.v, s.fetchedAt})
	}
	m.mu.Unlock()
	for _, r := range rows {
		_, err := m.c.Store().Exec(ctx, `INSERT INTO trade_quotes (symbol, source, last, bid, ask, open_24h, high_24h, low_24h, volume_24h, at, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(symbol) DO UPDATE SET source = excluded.source, last = excluded.last, bid = excluded.bid, ask = excluded.ask,
			open_24h = excluded.open_24h, high_24h = excluded.high_24h, low_24h = excluded.low_24h, volume_24h = excluded.volume_24h,
			at = excluded.at, fetched_at = excluded.fetched_at`,
			r.sym, r.src, r.t.Last, r.t.Bid, r.t.Ask, r.t.Open24h, r.t.High24h, r.t.Low24h, r.t.Volume24h, fmtT(r.t.At), fmtT(r.at))
		if err != nil {
			m.c.Log().Warn("persist quote failed", "symbol", r.sym, "err", err)
		}
	}
}

// loadCached 在内存里还没有这个标的时从 trade_quotes 读一次上次落库的值，标为缓存。
func (m *market) loadCached(ctx context.Context, sym string) {
	m.mu.Lock()
	if m.loaded[sym] || m.quotes[sym] != nil {
		m.mu.Unlock()
		return
	}
	m.loaded[sym] = true
	m.mu.Unlock()
	var t Ticker
	var at, fetched string
	err := m.c.Store().QueryRow(ctx, `SELECT last, bid, ask, open_24h, high_24h, low_24h, volume_24h, at, fetched_at FROM trade_quotes WHERE symbol = ?`, sym).
		Scan(&t.Last, &t.Bid, &t.Ask, &t.Open24h, &t.High24h, &t.Low24h, &t.Volume24h, &at, &fetched)
	if err != nil {
		return
	}
	t.Symbol = sym
	t.At, _ = time.Parse(time.RFC3339Nano, at)
	f, _ := time.Parse(time.RFC3339Nano, fetched)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.quotes[sym] == nil {
		m.quotes[sym] = &snap[Ticker]{v: t, ok: true, fetchedAt: f, cached: true}
	}
}

// symbolsParam 解析逗号分隔的 symbol 列表：去空白、去重、保序，格式不对或超过 max 个回错。
func symbolsParam(raw string, maxN int) ([]string, error) {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s == "" || slices.Contains(out, s) {
			continue
		}
		if !ValidSymbol(s) {
			return nil, apiErr(errValidation, "标的 %q 格式不对，要写成 交易场所:代码，如 BINANCE:BTCUSDT", s)
		}
		out = append(out, s)
	}
	if len(out) > maxN {
		return nil, apiErr(errValidation, "一次最多 %d 个标的", maxN)
	}
	return out, nil
}
