package trade

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// testClock 是真实时间加一个偏移：令牌桶照常回填，又能把「现在」挪到录样例的那个时刻。
type testClock struct {
	mu  sync.Mutex
	off time.Duration
}

func newTestClock(at time.Time) *testClock { return &testClock{off: time.Until(at)} }

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.off)
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.off += d
}

type marketEnv struct {
	h     http.Handler
	p     *Plugin
	f     *fakeExchange
	conns *connector.Store
	clock *testClock
}

// setupMarket 装好带 Binance、OKX 两个源的插件，出网全部指到同一个假交易所（两家的路径不重叠），接上真的连接器 store。
func setupMarket(t *testing.T, at time.Time) marketEnv {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := connector.NewRegistry()
	conns := connector.New(d, v, defs)

	routes := map[string]string{}
	for k, x := range binanceRoutes {
		routes[k] = x
	}
	for k, x := range okxRoutes {
		routes[k] = x
	}
	f := newFakeExchange(t, routes)
	b := NewBinance()
	b.SpotBase, b.PerpBase = f.URL, f.URL
	o := NewOKX()
	o.Base = f.URL
	p := New(b, o)
	clock := newTestClock(at)
	p.now, p.tick, p.push, p.doer = clock.now, 100*time.Millisecond, 100*time.Millisecond, f.doer()

	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.SetConnectors(conns)
	defs.SetPluginDefs(r.ConnectorDefs)
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "trade", []string{"network:market-data"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "trade"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return marketEnv{h: mux, p: p, f: f, conns: conns, clock: clock}
}

func meta(t *testing.T, h http.Handler, path string) (map[string]any, []any) {
	t.Helper()
	code, out := call(t, h, "GET", path, "")
	if code != 200 {
		t.Fatalf("GET %s = %d %v", path, code, out)
	}
	m, _ := out["meta"].(map[string]any)
	a, _ := out["data"].([]any)
	return m, a
}

// 录的 1 小时 K 线是 1793786400000、1793790000000、1793793600000 三根；把「现在」放在第三根里，它就是还没收盘的那根。
const (
	bar1 = int64(1793786400000)
	bar2 = int64(1793790000000)
	bar3 = int64(1793793600000)
)

func TestKlineCache(t *testing.T) {
	e := setupMarket(t, time.UnixMilli(bar3+10*60*1000))
	n := func() int { return e.f.count("/api/v3/klines") }
	base := "/api/trade/klines?symbol=BINANCE:BTCUSDT&interval=1h"

	m, bars := meta(t, e.h, base+"&limit=3")
	if len(bars) != 3 || m["cached"] != false || m["status"] != "live" || m["source"] != "binance" || n() != 1 {
		t.Fatalf("第一次 = %v %d 根，请求 %d 次", m, len(bars), n())
	}
	if q := e.f.last("/api/v3/klines"); strings.Contains(q, "endTime") || !strings.Contains(q, "limit=3") {
		t.Fatalf("截至现在不带 endTime：%s", q)
	}
	last := bars[2].(map[string]any)
	if last["close"] != 78129.32 || last["time"] != "2026-11-04T12:00:00Z" {
		t.Fatalf("最后一根是还没收盘的：%v", last)
	}

	// 同一区间第二次：不再请求交易所
	m, bars = meta(t, e.h, base+"&limit=3")
	if len(bars) != 3 || m["cached"] != true || n() != 1 {
		t.Fatalf("第二次 = %v %d 根，请求 %d 次", m, len(bars), n())
	}
	// 子区间、历史区间（end 落在已取过的范围里）也不请求
	end := url.QueryEscape(time.UnixMilli(bar2).UTC().Format(time.RFC3339))
	m, bars = meta(t, e.h, base+"&limit=2&end="+end)
	if len(bars) != 2 || m["cached"] != true || n() != 1 || bars[1].(map[string]any)["time"] != "2026-11-04T11:00:00Z" {
		t.Fatalf("历史子区间 = %v %v，请求 %d 次", m, bars, n())
	}
	// 往前多要：缺的那段去补，带 endTime；补过之后再查也不请求
	m, bars = meta(t, e.h, base+"&limit=5&end="+end)
	if m["cached"] != false || n() != 2 || !strings.Contains(e.f.last("/api/v3/klines"), "endTime=1793793599999") {
		t.Fatalf("往前补 = %v，请求 %d 次 %s", m, n(), e.f.last("/api/v3/klines"))
	}
	if len(bars) != 2 {
		t.Fatalf("交易所只有这两根收盘的：%v", bars)
	}
	if m, _ := meta(t, e.h, base+"&limit=5&end="+end); m["cached"] != true || n() != 2 {
		t.Fatalf("补过之后 = %v，请求 %d 次", m, n())
	}
	// 还没收盘的那根 3 秒后过期，只补这一根
	e.clock.advance(4 * time.Second)
	if m, bars := meta(t, e.h, base+"&limit=3"); m["cached"] != false || n() != 3 || len(bars) != 3 || !strings.Contains(e.f.last("/api/v3/klines"), "limit=1&") {
		t.Fatalf("过期后 = %v，请求 %d 次 %s", m, n(), e.f.last("/api/v3/klines"))
	}

	// 没有源的市场：明确的未接状态，不造数
	if m, bars := meta(t, e.h, "/api/trade/klines?symbol=NASDAQ:AAPL&interval=1d"); m["status"] != "no_source" || len(bars) != 0 {
		t.Fatalf("美股 = %v %v", m, bars)
	}
	for _, q := range []string{"symbol=btc", "symbol=BINANCE:BTCUSDT&interval=2h", "symbol=BINANCE:BTCUSDT&limit=0", "symbol=BINANCE:BTCUSDT&end=yesterday"} {
		if code, out := call(t, e.h, "GET", "/api/trade/klines?"+q, ""); code != 400 {
			t.Errorf("%s = %d %v，应当 400", q, code, out)
		}
	}
}

func quoteOf(t *testing.T, h http.Handler, syms string) map[string]map[string]any {
	t.Helper()
	_, list := meta(t, h, "/api/trade/quotes?symbols="+syms)
	out := map[string]map[string]any{}
	for _, x := range list {
		q := x.(map[string]any)
		out[q["symbol"].(string)] = q
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("等不到：%s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestQuotesHealthAndConnector(t *testing.T) {
	e := setupMarket(t, time.Now())
	ctx := context.Background()
	inst, err := e.conns.Create(ctx, connector.Input{Tool: "binance_market", Name: "Binance 行情"})
	if err != nil {
		t.Fatal(err)
	}

	qs := quoteOf(t, e.h, "BINANCE:BTCUSDT,OKX:BTC-USDT,NASDAQ:AAPL")
	b, o, a := qs["BINANCE:BTCUSDT"], qs["OKX:BTC-USDT"], qs["NASDAQ:AAPL"]
	if b["status"] != "live" || b["last"] != 78129.31 || b["source"] != "binance" || b["at"] == "" || b["fetched_at"] == "" {
		t.Fatalf("Binance = %v", b)
	}
	if pct := b["change_pct"].(float64); !approx(pct, (78129.31-77104.01)/77104.01) {
		t.Fatalf("涨跌幅相对 24 小时前开盘：%v", pct)
	}
	if o["status"] != "live" || o["last"] != 78282.1 || o["source"] != "okx" {
		t.Fatalf("OKX = %v", o)
	}
	if a["status"] != "no_source" || a["last"] != 0.0 {
		t.Fatalf("美股要明确未接，不给价格：%v", a)
	}
	if code, _ := call(t, e.h, "GET", "/api/trade/quotes", ""); code != 400 {
		t.Fatalf("不带 symbols = %d", code)
	}
	book := data(t, e.h, "GET", "/api/trade/book?symbol=BINANCE:BTCUSDT&depth=3", "")
	if book["status"] != "live" || len(book["bids"].([]any)) != 3 {
		t.Fatalf("盘口 = %v", book)
	}
	fund := data(t, e.h, "GET", "/api/trade/funding?symbol=BINANCE:BTCUSDT.P", "")
	if fund["status"] != "live" || fund["rate"] != 0.0001 || fund["next_time"] != "2026-11-04T16:00:00Z" {
		t.Fatalf("资金费率 = %v", fund)
	}
	if f := data(t, e.h, "GET", "/api/trade/funding?symbol=BINANCE:BTCUSDT", ""); f["status"] != "unsupported" {
		t.Fatalf("现货资金费率 = %v", f)
	}

	sourceStatus := func(id string) string {
		for _, x := range list(t, e.h, "/api/trade/sources") {
			s := x.(map[string]any)
			if s["id"] == id {
				return s["health"].(map[string]any)["status"].(string)
			}
		}
		return ""
	}
	connStatus := func() string {
		c, err := e.conns.Get(ctx, inst.ID)
		if err != nil {
			t.Fatal(err)
		}
		return string(c.Status)
	}
	waitFor(t, "Binance 正常", func() bool { return sourceStatus("binance") == "ok" })

	// 限频：源标异常、连接器置为异常；报价降级为缓存，价格停在最后一次取到的值
	e.f.setStatus("*", http.StatusTooManyRequests)
	waitFor(t, "Binance 异常", func() bool { return sourceStatus("binance") == "error" })
	waitFor(t, "连接器异常", func() bool { return connStatus() == "error" })
	q := quoteOf(t, e.h, "BINANCE:BTCUSDT")["BINANCE:BTCUSDT"]
	if q["status"] != "stale" || q["last"] != 78129.31 || !strings.Contains(q["error"].(string), "限频") {
		t.Fatalf("限频时 = %v", q)
	}
	if c, _ := e.conns.Get(ctx, inst.ID); !strings.Contains(c.Error, "限频") {
		t.Fatalf("连接器的错误原因 = %q", c.Error)
	}
	// 恢复：退避过后自动回到正常
	e.f.setStatus("*", 0)
	waitFor(t, "Binance 恢复", func() bool { return sourceStatus("binance") == "ok" })
	waitFor(t, "连接器恢复", func() bool { return connStatus() == "connected" })
	waitFor(t, "报价回到实时", func() bool { return quoteOf(t, e.h, "BINANCE:BTCUSDT")["BINANCE:BTCUSDT"]["status"] == "live" })
}

func TestStream(t *testing.T) {
	e := setupMarket(t, time.Now())
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 3500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/trade/stream?symbols=BINANCE:BTCUSDT,OKX:BTC-USDT-SWAP,SSE:600519&focus=BINANCE:BTCUSDT.P", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var events []StreamEvent
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ev StreamEvent
		if err := json.Unmarshal([]byte(line[6:]), &ev); err != nil {
			t.Fatalf("不是 JSON：%s", line)
		}
		events = append(events, ev)
	}
	if len(events) == 0 || events[0].Type != "ready" {
		t.Fatalf("第一条要是 ready：%v", events)
	}
	live := map[string]int{}
	var noSource, book, funding, source bool
	for _, ev := range events {
		switch ev.Type {
		case "quote":
			if ev.Quote.Status == "live" {
				live[ev.Quote.Symbol]++
			}
			if ev.Quote.Symbol == "SSE:600519" && ev.Quote.Status == "no_source" {
				noSource = true
			}
		case "book":
			book = book || ev.Book.Status == "live" && len(ev.Book.Bids) == 5
		case "funding":
			funding = funding || ev.Funding.Status == "live" && ev.Funding.Rate == 0.0001
		case "source":
			source = true
		}
	}
	// 3.5 秒里每秒刷一次：两个标的各推了至少 3 次实时价
	if live["BINANCE:BTCUSDT"] < 3 || live["OKX:BTC-USDT-SWAP"] < 3 || !noSource || !book || !funding || !source {
		t.Fatalf("推送 = live %v no_source %v book %v funding %v source %v", live, noSource, book, funding, source)
	}
	// 断开后取消订阅
	cancel()
	waitFor(t, "取消订阅", func() bool {
		e.p.mkt.mu.Lock()
		defer e.p.mkt.mu.Unlock()
		return len(e.p.mkt.subs) == 0 && len(e.p.mkt.focus) == 0
	})
}

// 重启后交易所连不上：从 trade_quotes 读上次落库的价，标为缓存并带数据时间
func TestQuotePersistFallback(t *testing.T) {
	e := setupMarket(t, time.Now())
	ctx := context.Background()
	if q := quoteOf(t, e.h, "BINANCE:ETHUSDT")["BINANCE:ETHUSDT"]; q["status"] != "live" {
		t.Fatalf("先取到实时价：%v", q)
	}
	m := e.p.mkt
	// 先断网、让源进退避，再等后台循环把在途的刷新和落库跑完，免得它在下面清内存之后又写回实时价，
	// 或者它刚占了落库时间、行还没写进去，这里的 persist 就跳过了
	e.f.setStatus("*", http.StatusServiceUnavailable)
	m.mu.Lock()
	m.health["binance"].retryAt = m.now().Add(time.Minute)
	m.mu.Unlock()
	time.Sleep(3 * e.p.tick)
	m.mu.Lock()
	m.saved = map[string]time.Time{}
	m.mu.Unlock()
	m.persist(ctx)
	// 模拟重启：内存清空
	m.mu.Lock()
	m.quotes, m.loaded, m.polled = map[string]*snap[Ticker]{}, map[string]bool{}, map[string]time.Time{}
	m.mu.Unlock()
	q := quoteOf(t, e.h, "BINANCE:ETHUSDT")["BINANCE:ETHUSDT"]
	if q["status"] != "stale" || q["last"] != 78129.31 || q["at"] == "" || q["fetched_at"] == "" {
		t.Fatalf("重启后降级为缓存 = %v", q)
	}
}
