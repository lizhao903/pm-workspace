package trade

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// 假交易所：按路径回 testdata 里录好的响应（2026-11-04 从 Binance、OKX 公开接口录的，裁掉了大部分标的），记下每个请求。
type fakeExchange struct {
	*httptest.Server
	mu     sync.Mutex
	routes map[string]string // 路径 -> testdata 文件；文件名以 ! 开头时回 400
	hits   []string          // 路径?查询
	status map[string]int    // 路径 -> 强制状态码（限频、断网演练）
}

func newFakeExchange(t *testing.T, routes map[string]string) *fakeExchange {
	t.Helper()
	f := &fakeExchange{routes: routes, status: map[string]int{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.hits = append(f.hits, r.URL.Path+"?"+r.URL.RawQuery)
		file, ok := f.routes[r.URL.Path]
		code := f.status[r.URL.Path]
		if c, ok := f.status["*"]; ok && code == 0 {
			code = c
		}
		f.mu.Unlock()
		if code != 0 {
			if code == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "1")
			}
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"code":-1003,"msg":"Too many requests"}`))
			return
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		st := http.StatusOK
		if strings.HasPrefix(file, "!") {
			st, file = http.StatusBadRequest, file[1:]
		}
		b, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Errorf("读 %s：%v", file, err)
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		_, _ = w.Write(b)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeExchange) doer() HTTPDoer {
	return func(context.Context) (*http.Client, error) { return f.Client(), nil }
}

func (f *fakeExchange) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, h := range f.hits {
		if strings.HasPrefix(h, prefix) {
			n++
		}
	}
	return n
}

func (f *fakeExchange) last(prefix string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.hits) - 1; i >= 0; i-- {
		if strings.HasPrefix(f.hits[i], prefix) {
			return f.hits[i]
		}
	}
	return ""
}

func (f *fakeExchange) setRoute(path, file string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[path] = file
}

func (f *fakeExchange) setStatus(path string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if code == 0 {
		delete(f.status, path)
		return
	}
	f.status[path] = code
}

var binanceRoutes = map[string]string{
	"/api/v3/ping":               "binance/err_invalid_symbol.json", // 内容不看
	"/fapi/v1/ping":              "binance/err_invalid_symbol.json",
	"/api/v3/exchangeInfo":       "binance/spot_exchange_info.json",
	"/fapi/v1/exchangeInfo":      "binance/perp_exchange_info.json",
	"/api/v3/ticker/24hr":        "binance/spot_ticker_24hr.json",
	"/fapi/v1/ticker/24hr":       "binance/perp_ticker_24hr.json",
	"/fapi/v1/ticker/bookTicker": "binance/perp_book_ticker.json",
	"/api/v3/klines":             "binance/spot_klines.json",
	"/fapi/v1/klines":            "binance/perp_klines.json",
	"/api/v3/depth":              "binance/spot_depth.json",
	"/fapi/v1/depth":             "binance/perp_depth.json",
	"/fapi/v1/premiumIndex":      "binance/perp_premium_index.json",
}

func newTestBinance(t *testing.T) (*Binance, *fakeExchange) {
	f := newFakeExchange(t, binanceRoutes)
	b := NewBinance()
	b.SpotBase, b.PerpBase = f.URL, f.URL
	b.BindHTTP(f.doer())
	return b, f
}

var okxRoutes = map[string]string{
	"/api/v5/public/time":            "okx/funding_rate.json",
	"/api/v5/public/instruments":     "okx/instruments_spot.json",
	"/api/v5/market/ticker":          "okx/ticker_spot.json",
	"/api/v5/market/candles":         "okx/candles_spot.json",
	"/api/v5/market/books":           "okx/books_spot.json",
	"/api/v5/public/funding-rate":    "okx/funding_rate.json",
	"/api/v5/market/history-candles": "okx/candles_spot.json",
}

func newTestOKX(t *testing.T, routes map[string]string) (*OKX, *fakeExchange) {
	r := map[string]string{}
	for k, v := range okxRoutes {
		r[k] = v
	}
	for k, v := range routes {
		r[k] = v
	}
	f := newFakeExchange(t, r)
	o := NewOKX()
	o.Base = f.URL
	o.BindHTTP(f.doer())
	return o, f
}

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9*math.Max(1, math.Abs(b)) }

func TestBinanceAdapter(t *testing.T) {
	b, f := newTestBinance(t)
	ctx := context.Background()
	if err := checkSource(b); err != nil {
		t.Fatal(err)
	}

	spot, err := b.Instruments(ctx, "crypto", "spot")
	if err != nil {
		t.Fatal(err)
	}
	// 只要 USDT 计价：ETHBTC 不要；中文名的那个格式不合格，由 checkInstrument 在同步时跳过
	got := map[string]Instrument{}
	for _, in := range spot {
		got[in.Symbol] = in
	}
	if _, ok := got["BINANCE:ETHBTC"]; ok || len(spot) != 3 {
		t.Fatalf("现货标的 = %v", spot)
	}
	if in := got["BINANCE:BTCUSDT"]; in.Name != "BTC/USDT" || in.Digits != 2 || in.Lot != 0.00001 || in.Kind != "spot" || in.Venue != "Binance" {
		t.Fatalf("BTCUSDT = %+v", in)
	}
	if err := checkInstrument(b, got["BINANCE:币安人生USDT"]); err == nil {
		t.Fatal("非 ASCII 代码应当校验不过")
	}
	perp, err := b.Instruments(ctx, "crypto", "perp")
	if err != nil {
		t.Fatal(err)
	}
	if len(perp) != 2 || perp[0].Symbol != "BINANCE:BTCUSDT.P" || perp[0].Name != "BTC 永续" || perp[0].Digits != 1 ||
		perp[0].Underlying != "BINANCE:BTCUSDT" || perp[0].Lot != 0.001 {
		t.Fatalf("永续只要 USDT 本位 PERPETUAL：%+v", perp)
	}
	for _, in := range perp {
		if err := checkInstrument(b, in); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.Instruments(ctx, "crypto", "option"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("期权 = %v", err)
	}

	tk, err := b.Ticker(ctx, "BINANCE:BTCUSDT")
	if err != nil {
		t.Fatal(err)
	}
	if tk.Last != 78129.31 || tk.Bid != 78129.31 || tk.Ask != 78129.32 || tk.Open24h != 77104.01 || tk.High24h != 78718 || tk.At.IsZero() {
		t.Fatalf("现货 ticker = %+v", tk)
	}
	if q := f.last("/api/v3/ticker/24hr"); q != "/api/v3/ticker/24hr?symbol=BTCUSDT" {
		t.Fatalf("请求 = %s", q)
	}
	pt, err := b.Ticker(ctx, "BINANCE:BTCUSDT.P")
	if err != nil {
		t.Fatal(err)
	}
	if pt.Last != 78111.7 || pt.Bid != 78115.6 || pt.Ask != 78115.7 || pt.Volume24h != 176918 || !pt.At.Equal(time.UnixMilli(1793794310011)) {
		t.Fatalf("永续 ticker 要合并 bookTicker 的买一卖一：%+v", pt)
	}

	ks, err := b.Klines(ctx, KlineQuery{Symbol: "BINANCE:BTCUSDT", Interval: "1h", Limit: 3, End: time.UnixMilli(1793797199999)})
	if err != nil {
		t.Fatal(err)
	}
	if len(ks) != 3 || !ks[0].Time.Equal(time.UnixMilli(1793786400000)) || ks[0].Open != 78400 || ks[0].High != 78705 || ks[0].Low != 78376.34 ||
		ks[0].Close != 78608.86 || ks[0].Volume != 450.43107 {
		t.Fatalf("K 线 = %+v", ks)
	}
	if q := f.last("/api/v3/klines"); q != "/api/v3/klines?endTime=1793797199999&interval=1h&limit=3&symbol=BTCUSDT" {
		t.Fatalf("K 线请求 = %s", q)
	}
	if _, err := b.Klines(ctx, KlineQuery{Symbol: "BINANCE:BTCUSDT.P", Interval: "1d", Limit: 3}); err != nil || !strings.Contains(f.last("/fapi/v1/klines"), "interval=1d") {
		t.Fatalf("永续 K 线走 fapi：%v %s", err, f.last("/fapi"))
	}

	ob, err := b.OrderBook(ctx, "BINANCE:BTCUSDT", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(ob.Bids) != 3 || ob.Bids[0] != (Level{78129.31, 8.41352}) || ob.Asks[0] != (Level{78129.32, 1.87906}) || ob.Asks[2].Price != 78130.57 {
		t.Fatalf("盘口 = %+v", ob)
	}
	if _, err := b.OrderBook(ctx, "BINANCE:BTCUSDT.P", 7); err != nil || !strings.Contains(f.last("/fapi/v1/depth"), "limit=10") {
		t.Fatalf("永续盘口档数取允许值里够用的最小一档：%v %s", err, f.last("/fapi/v1/depth"))
	}

	fr, err := b.Funding(ctx, "BINANCE:BTCUSDT.P")
	if err != nil {
		t.Fatal(err)
	}
	if fr.Rate != 0.0001 || !fr.NextTime.Equal(time.UnixMilli(1793808000000)) || !fr.At.Equal(time.UnixMilli(1793794316000)) {
		t.Fatalf("资金费率 = %+v", fr)
	}
	if _, err := b.Funding(ctx, "BINANCE:BTCUSDT"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("现货没有资金费率：%v", err)
	}
	if _, err := b.Ticker(ctx, "OKX:BTC-USDT"); !errors.Is(err, ErrUnknownSymbol) {
		t.Fatalf("别的交易场所：%v", err)
	}

	// 交易所回 -1121 认成标的不存在；429 认成限频并带上 Retry-After
	f.setRoute("/api/v3/ticker/24hr", "!binance/err_invalid_symbol.json")
	if _, err := b.Ticker(ctx, "BINANCE:NOPEUSDT"); !errors.Is(err, ErrUnknownSymbol) {
		t.Fatalf("-1121 = %v", err)
	}
	f.setStatus("/api/v3/ticker/24hr", http.StatusTooManyRequests)
	_, err = b.Ticker(ctx, "BINANCE:BTCUSDT")
	var ue *UpstreamError
	if !errors.As(err, &ue) || !ue.RateLimited || ue.RetryAfter != time.Second {
		t.Fatalf("429 = %v", err)
	}
}

func TestOKXAdapter(t *testing.T) {
	o, f := newTestOKX(t, nil)
	ctx := context.Background()
	if id, ok := OKXInstID("OKX:BTC-USDT-SWAP"); !ok || id != "BTC-USDT-SWAP" || OKXSymbol(id) != "OKX:BTC-USDT-SWAP" {
		t.Fatal("symbol 和 instId 互转不对")
	}
	if _, ok := OKXInstID("BINANCE:BTCUSDT"); ok {
		t.Fatal("别的交易场所不该认")
	}

	spot, err := o.Instruments(ctx, "crypto", "spot")
	if err != nil {
		t.Fatal(err)
	}
	if len(spot) != 2 || spot[0].Symbol != "OKX:BTC-USDT" || spot[0].Name != "BTC/USDT" || spot[0].Digits != 1 || spot[0].Lot != 0.00001 {
		t.Fatalf("现货只要 USDT 计价：%+v", spot)
	}
	if q := f.last("/api/v5/public/instruments"); q != "/api/v5/public/instruments?instType=SPOT" {
		t.Fatalf("请求 = %s", q)
	}
	f.setRoute("/api/v5/public/instruments", "okx/instruments_swap.json")
	perp, err := o.Instruments(ctx, "crypto", "perp")
	if err != nil {
		t.Fatal(err)
	}
	if len(perp) != 2 || perp[0].Symbol != "OKX:BTC-USDT-SWAP" || perp[0].Name != "BTC 永续" || perp[0].Multiplier != 0.01 ||
		perp[0].Underlying != "OKX:BTC-USDT" || perp[0].Digits != 1 || perp[1].Multiplier != 0.1 {
		t.Fatalf("永续只要 USDT 本位 linear：%+v", perp)
	}
	for _, in := range append(spot, perp...) {
		if err := checkInstrument(o, in); err != nil {
			t.Fatal(err)
		}
	}

	tk, err := o.Ticker(ctx, "OKX:BTC-USDT")
	if err != nil {
		t.Fatal(err)
	}
	if tk.Last != 78282.1 || tk.Bid != 78282.1 || tk.Ask != 78282.2 || tk.Open24h != 77221.2 || tk.Volume24h != 9239.0753354 || !tk.At.Equal(time.UnixMilli(1793794835862)) {
		t.Fatalf("现货 ticker = %+v", tk)
	}
	f.setRoute("/api/v5/market/ticker", "okx/ticker_swap.json")
	pt, err := o.Ticker(ctx, "OKX:BTC-USDT-SWAP")
	if err != nil {
		t.Fatal(err)
	}
	if pt.Volume24h != 104488.9073 {
		t.Fatalf("永续的 24h 量取 volCcy24h（标的币）：%+v", pt)
	}

	ks, err := o.Klines(ctx, KlineQuery{Symbol: "OKX:BTC-USDT", Interval: "1h", Limit: 3, End: time.UnixMilli(1793797199999)})
	if err != nil {
		t.Fatal(err)
	}
	if len(ks) != 3 || !ks[0].Time.Equal(time.UnixMilli(1793786400000)) || ks[2].Close != 78138.2 || ks[0].Volume != 312.81528508 {
		t.Fatalf("K 线要按时间正序：%+v", ks)
	}
	if q := f.last("/api/v5/market/candles"); q != "/api/v5/market/candles?after=1793797200000&bar=1H&instId=BTC-USDT&limit=3" {
		t.Fatalf("K 线请求 = %s", q)
	}
	if _, err := o.Klines(ctx, KlineQuery{Symbol: "OKX:BTC-USDT", Interval: "1d", Limit: 2}); err != nil || !strings.Contains(f.last("/api/v5/market/candles"), "bar=1Dutc") {
		t.Fatalf("日线用 1Dutc：%v %s", err, f.last("/api/v5"))
	}
	f.setRoute("/api/v5/market/candles", "okx/candles_swap.json")
	sk, err := o.Klines(ctx, KlineQuery{Symbol: "OKX:BTC-USDT-SWAP", Interval: "1h", Limit: 3})
	if err != nil || sk[2].Volume != 3625.2974 {
		t.Fatalf("永续 K 线量取 volCcy（标的币）：%v %+v", err, sk)
	}

	ob, err := o.OrderBook(ctx, "OKX:BTC-USDT", 5)
	if err != nil {
		t.Fatal(err)
	}
	if ob.Bids[0] != (Level{78160.7, 0.77191871}) || ob.Asks[0] != (Level{78160.8, 0.71921483}) || !strings.Contains(f.last("/api/v5/market/books"), "sz=5") {
		t.Fatalf("盘口 = %+v", ob)
	}
	f.setRoute("/api/v5/market/books", "okx/books_swap.json")
	sb, err := o.OrderBook(ctx, "OKX:BTC-USDT-SWAP", 5)
	if err != nil {
		t.Fatal(err)
	}
	// 张数乘面值 0.01 换成 BTC
	if !approx(sb.Asks[0].Size, 12.1467) || !approx(sb.Bids[0].Size, 0.1436) {
		t.Fatalf("永续盘口的量要换成标的币：%+v", sb)
	}

	fr, err := o.Funding(ctx, "OKX:BTC-USDT-SWAP")
	if err != nil {
		t.Fatal(err)
	}
	if fr.Rate != 0.0000707374112192 || !fr.NextTime.Equal(time.UnixMilli(1793808000000)) {
		t.Fatalf("资金费率取当期 fundingRate、结算时间 fundingTime：%+v", fr)
	}
	if _, err := o.Funding(ctx, "OKX:BTC-USDT"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("现货没有资金费率：%v", err)
	}
	if _, err := o.Ticker(ctx, "OKX:BTC-USD-261225"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("交割合约还没接：%v", err)
	}

	f.setRoute("/api/v5/market/ticker", "okx/err_instrument.json")
	if _, err := o.Ticker(ctx, "OKX:NOPE-USDT"); !errors.Is(err, ErrUnknownSymbol) {
		t.Fatalf("51001（HTTP 200 里的业务错误码）= %v", err)
	}
}

func TestDigitsOf(t *testing.T) {
	for s, want := range map[string]int{"0.01000000": 2, "1": 0, "0.1": 1, "0.00001": 5, "10": 0, "1e-4": 4, "": 0} {
		if got := digitsOf(s); got != want {
			t.Errorf("digitsOf(%q) = %d，应当 %d", s, got, want)
		}
	}
}

func TestAlignOpen(t *testing.T) {
	at := time.Date(2026, 11, 4, 13, 37, 21, 0, time.UTC) // 周三
	for iv, want := range map[string]time.Time{
		"1m":  time.Date(2026, 11, 4, 13, 37, 0, 0, time.UTC),
		"15m": time.Date(2026, 11, 4, 13, 30, 0, 0, time.UTC),
		"4h":  time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC),
		"1d":  time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC),
		"1w":  time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), // 周一
	} {
		if got := alignOpen(at, iv); !got.Equal(want) {
			t.Errorf("%s = %v，应当 %v", iv, got, want)
		}
	}
}

// 对照测试：直连交易所，比对适配器解析出来的数和交易所原始接口一致。默认跳过，TRADE_LIVE=1 打开。
// 只读公开接口，不带任何 Key。
func TestLiveExchanges(t *testing.T) {
	if os.Getenv("TRADE_LIVE") != "1" {
		t.Skip("设 TRADE_LIVE=1 才直连交易所")
	}
	ctx := context.Background()
	direct := func(context.Context) (*http.Client, error) { return &http.Client{Timeout: 15 * time.Second}, nil }
	b := NewBinance()
	b.BindHTTP(direct)
	o := NewOKX()
	o.BindHTTP(direct)
	for _, c := range []struct {
		src Source
		sym string
	}{{b, "BINANCE:BTCUSDT"}, {b, "BINANCE:ETHUSDT"}, {b, "BINANCE:BTCUSDT.P"}, {b, "BINANCE:ETHUSDT.P"}, {o, "OKX:BTC-USDT"}, {o, "OKX:BTC-USDT-SWAP"}} {
		tk, err := c.src.Ticker(ctx, c.sym)
		if err != nil {
			t.Fatalf("%s ticker：%v", c.sym, err)
		}
		t.Logf("%s 最新 %.2f 买一 %.2f 卖一 %.2f 24h 开 %.2f 高 %.2f 低 %.2f 量 %.4f @%s", c.sym, tk.Last, tk.Bid, tk.Ask, tk.Open24h, tk.High24h, tk.Low24h, tk.Volume24h, tk.At.Format(time.RFC3339))
		for _, iv := range []string{"1m", "1h", "1d"} {
			ks, err := c.src.Klines(ctx, KlineQuery{Symbol: c.sym, Interval: iv, Limit: 3})
			if err != nil || len(ks) != 3 {
				t.Fatalf("%s %s K 线：%v %d", c.sym, iv, err, len(ks))
			}
			k := ks[1]
			t.Logf("  %s %s 开 %.2f 高 %.2f 低 %.2f 收 %.2f 量 %.4f", iv, k.Time.Format(time.RFC3339), k.Open, k.High, k.Low, k.Close, k.Volume)
			// 已收盘的那根（倒数第二根）和交易所原始接口逐字段比对
			raw := rawKline(t, c.sym, iv, k.Time)
			if raw != k {
				t.Fatalf("%s %s 和交易所原始接口不一致：适配器 %+v，原始 %+v", c.sym, iv, k, raw)
			}
		}
		ob, err := c.src.OrderBook(ctx, c.sym, 10)
		if err != nil || len(ob.Bids) != 10 || len(ob.Asks) != 10 || ob.Bids[0].Price >= ob.Asks[0].Price {
			t.Fatalf("%s 盘口：%v %+v", c.sym, err, ob)
		}
		t.Logf("  盘口 买一 %.2f x %.4f 卖一 %.2f x %.4f 买十 %.2f 卖十 %.2f", ob.Bids[0].Price, ob.Bids[0].Size, ob.Asks[0].Price, ob.Asks[0].Size, ob.Bids[9].Price, ob.Asks[9].Price)
		if isPerp(c.sym) {
			fr, err := c.src.Funding(ctx, c.sym)
			if err != nil {
				t.Fatalf("%s 资金费率：%v", c.sym, err)
			}
			t.Logf("  资金费率 %.6f%% 结算 %s", fr.Rate*100, fr.NextTime.Format(time.RFC3339))
		}
	}
}

// rawKline 直接按交易所文档请求开盘时间为 open 的那一根，自己解析，用来对照适配器。
func rawKline(t *testing.T, sym, iv string, open time.Time) Kline {
	t.Helper()
	ms := strconv.FormatInt(open.UnixMilli(), 10)
	var u string
	venue, code := codeOf(sym)
	switch {
	case venue == "BINANCE" && strings.HasSuffix(code, ".P"):
		u = "https://fapi.binance.com/fapi/v1/klines?symbol=" + strings.TrimSuffix(code, ".P") + "&interval=" + iv + "&startTime=" + ms + "&limit=1"
	case venue == "BINANCE":
		u = "https://data-api.binance.vision/api/v3/klines?symbol=" + code + "&interval=" + iv + "&startTime=" + ms + "&limit=1"
	default:
		after := strconv.FormatInt(open.UnixMilli()+1, 10)
		u = "https://www.okx.com/api/v5/market/candles?instId=" + code + "&bar=" + okxBars[iv] + "&after=" + after + "&limit=1"
	}
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	var rows [][]any
	if venue == "BINANCE" {
		_ = json.Unmarshal(body, &rows)
	} else {
		var env struct{ Data [][]any }
		_ = json.Unmarshal(body, &env)
		rows = env.Data
	}
	if len(rows) != 1 {
		t.Fatalf("%s 原始接口 = %s", u, body)
	}
	r := rows[0]
	f := func(i int) float64 { s, _ := r[i].(string); return num(s) }
	vol := f(5)
	if venue == "OKX" && strings.HasSuffix(code, "-SWAP") {
		vol = f(6)
	}
	return Kline{Time: open, Open: f(1), High: f(2), Low: f(3), Close: f(4), Volume: vol}
}
