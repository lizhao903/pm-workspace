// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

/* ---------- 定点数和账本（纯函数） ---------- */

func TestFixedPoint(t *testing.T) {
	cases := map[string]fx{"0": 0, "1": fxScale, "0.1": 10_000_000, "-2.5": -250_000_000, "0.000000015": 2, "123456.12345678": 12345612345678, ".5": 50_000_000}
	for s, want := range cases {
		got, err := parseFx(s)
		if err != nil || got != want {
			t.Errorf("parseFx(%q) = %d %v，要 %d", s, got, err, want)
		}
	}
	if v, ok := fxFromFloat(0.1); !ok || v != 10_000_000 {
		t.Fatalf("0.1 = %d", v)
	}
	if v, ok := fxFromFloat(64200.3); !ok || v.String() != "64200.3" {
		t.Fatalf("64200.3 = %s", v)
	}
	// 数量 × 价格 × 乘数只在最后舍入一次，正好一半远离零
	n, err := fxMul3(fx(1), fx(50_000_000), fxScale) // 1e-8 × 0.5 = 5e-9 → 1e-8
	if err != nil || n != 1 {
		t.Fatalf("舍入 = %d %v", n, err)
	}
	n, _ = fxMul3(-1, 50_000_000, fxScale)
	if n != -1 {
		t.Fatalf("负数舍入 = %d", n)
	}
	if _, err := fxMul3(fxInt(1e9), fxInt(1e9), fxScale); !errors.Is(err, errFxRange) {
		t.Fatalf("溢出要报错：%v", err)
	}
	if floorLot(fxInt(1)+12345, 10_000) != fxInt(1)+10_000 {
		t.Fatal("按最小下单量向下取整")
	}
	if usdText(fxInt(50000)) != "$50,000" || usdText(-fxInt(1234)) != "-$1,234" {
		t.Fatal("usdText")
	}
}

// 随机成交序列：账本口径和现金流口径的权益分毫不差，和浮点算的也在误差内。
func TestLedgerIdentityRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	in := ledgerInst{Symbol: "X", Kind: "perp", Lot: 1000, Mult: fxScale / 100, Digits: 2}
	ids := 0
	newID := func() string { ids++; return fmt.Sprintf("ps%d", ids) }
	for round := range 200 {
		var pos posState
		var realized, fees, cash fx
		var fills []Fill
		var fq, fcash float64 // 浮点对照
		initial := fxInt(100000)
		for k := range 1 + rng.Intn(40) {
			qty := fx(1+rng.Intn(5000)) * in.Lot
			px := fx(rng.Intn(9_000_000)+100_000) * 1000 // 1 到 90 左右，三位小数
			d, side := qty, "buy"
			if rng.Intn(2) == 0 {
				d, side = -qty, "sell"
			}
			n, err := fxMul3(qty, px, in.Mult)
			if err != nil {
				t.Fatal(err)
			}
			if side == "sell" {
				n = -n
			}
			fee, _ := fxMul(n.abs(), 50000)
			np, r, err := applyFill(pos, d, n, 5, "", fmt.Sprint(k), newID)
			if err != nil {
				t.Fatal(err)
			}
			pos = np
			realized += r
			fees += fee
			cash += n
			fq += d.Float()
			fcash += n.Float()
			fills = append(fills, Fill{ID: fmt.Sprint(k), Symbol: "X", Side: side, Qty: qty, Price: px, Mult: in.Mult, Notional: n, Fee: fee, Realized: r, Pos: np})
		}
		mark := fx(rng.Intn(9_000_000)+100_000) * 1000
		mv, _ := fxMul3(pos.Qty, mark, in.Mult)
		equity := initial + realized + (mv - pos.Cost) - fees
		replay := initial - cash - fees + mv
		if equity != replay {
			t.Fatalf("第 %d 轮：账本权益 %s ≠ 现金流 %s", round, equity, replay)
		}
		if math.Abs(fq-pos.Qty.Float()) > 1e-6 {
			t.Fatalf("持仓数量 %s，浮点累计 %v", pos.Qty, fq)
		}
		if f := 100000 - fcash - fees.Float() + fq*mark.Float()*in.Mult.Float(); math.Abs(f-equity.Float()) > 1e-4 {
			t.Fatalf("和浮点差太多：%v vs %s", f, equity)
		}
		held := []heldPosition{}
		if pos.Qty != 0 {
			held = append(held, heldPosition{AccountID: "a", Symbol: "X", posState: pos})
		}
		chk, err := reconcile(initial, fills, held, func(string) (ledgerInst, bool) { return in, true }, func(string) (fx, bool) { return mark, true })
		if err != nil || !chk.OK {
			t.Fatalf("第 %d 轮对账不通过：%v %v", round, err, chk.Problems)
		}
	}
}

func TestApplyFillFlip(t *testing.T) {
	id := func() string { return "new" }
	// 多 2 @ 100（成本 200），卖 3 @ 110：平 2 赚 20，反手空 1 @ 110
	p, r, err := applyFill(posState{ID: "old", Qty: fxInt(2), Cost: fxInt(200), Lev: 1}, -fxInt(3), -fxInt(330), 1, "", "t", id)
	if err != nil || r != fxInt(20) || p.Qty != -fxInt(1) || p.Cost != -fxInt(110) || p.ID != "new" {
		t.Fatalf("反手 = %+v 已实现 %s %v", p, r, err)
	}
	// 平一半：成本按比例结转
	p, r, _ = applyFill(posState{ID: "a", Qty: fxInt(2), Cost: fxInt(200)}, -fxInt(1), -fxInt(90), 1, "", "t", id)
	if r != -fxInt(10) || p.Qty != fxInt(1) || p.Cost != fxInt(100) || p.ID != "a" {
		t.Fatalf("减仓 = %+v %s", p, r)
	}
	// 强平价同原型：多 5 倍均价 100 → 100 × (1 − 0.2 + 0.005) = 80.5
	in := ledgerInst{Kind: "perp", Mult: fxScale}
	if liq := (posState{Qty: fxInt(1), Cost: fxInt(100), Lev: 5}).liqPrice(in); liq.String() != "80.5" {
		t.Fatalf("强平价 = %s", liq)
	}
	if liq := (posState{Qty: -fxInt(1), Cost: -fxInt(100), Lev: 5}).liqPrice(in); liq.String() != "119.5" {
		t.Fatalf("空单强平价 = %s", liq)
	}
}

func TestRiskBlocksText(t *testing.T) {
	r := defaultRisk
	r.Halted = true
	got := riskBlocks(riskInput{Rules: r, Equity: fxInt(100000), Held: fxInt(30000), Value: fxInt(60000), Leverage: 20, Contract: true, Opening: true, Name: "BTC 永续"})
	want := []string{"熔断中：只能平仓或减仓，禁止新开仓", "单笔金额 $60,000 超过上限 $50,000", "下单后 BTC 永续 占该账户权益 90.0%，超过单标的上限 35%", "杠杆 20x 超过上限 10x"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("原因 =\n%v\n要\n%v", got, want)
	}
	// 平仓只查杠杆
	if got := riskBlocks(riskInput{Rules: r, Equity: fxInt(1), Value: fxInt(1e6), Leverage: 3, Contract: true}); len(got) != 0 {
		t.Fatalf("平仓不该被拦：%v", got)
	}
}

/* ---------- 后端接口 ---------- */

// paperSrc 是价格、K 线收盘价都由测试定的行情源（场所 FAKE）：现货 BTCUSDT、永续 BTCUSDT.P。
type paperSrc struct {
	mu     sync.Mutex
	price  map[string]float64
	fail   bool
	closes func(sym string, open time.Time) float64
	clock  *testClock
}

var paperInsts = []Instrument{
	{Symbol: "FAKE:BTCUSDT", Name: "BTC/USDT", Market: "crypto", Kind: "spot", Venue: "Fake", Digits: 1, Lot: 0.0001, Multiplier: 1},
	{Symbol: "FAKE:BTCUSDT.P", Name: "BTC 永续", Market: "crypto", Kind: "perp", Venue: "Fake", Digits: 1, Lot: 0.001, Multiplier: 1},
}

func (s *paperSrc) ID() string   { return "fake" }
func (s *paperSrc) Name() string { return "测试行情源" }
func (s *paperSrc) Coverage() []Coverage {
	return []Coverage{{Market: "crypto", Kinds: []string{"spot", "perp"}}}
}
func (s *paperSrc) Instruments(_ context.Context, market, kind string) ([]Instrument, error) {
	out := []Instrument{}
	for _, in := range paperInsts {
		if in.Market == market && in.Kind == kind {
			out = append(out, in)
		}
	}
	return out, nil
}

func (s *paperSrc) set(sym string, p float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.price[sym] = p
}

func (s *paperSrc) setFail(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fail = v
}

func (s *paperSrc) Ticker(_ context.Context, sym string) (Ticker, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return Ticker{}, errors.New("断网了")
	}
	p, ok := s.price[sym]
	if !ok {
		return Ticker{}, ErrUnknownSymbol
	}
	return Ticker{Symbol: sym, Last: p, Bid: p, Ask: p, Open24h: p, High24h: p, Low24h: p, At: s.clock.now()}, nil
}

func (s *paperSrc) Klines(_ context.Context, q KlineQuery) ([]Kline, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	step := Intervals[q.Interval]
	end := q.End
	if end.IsZero() {
		end = s.clock.now()
	}
	start := alignOpen(end, q.Interval).Add(-time.Duration(q.Limit-1) * step)
	out := []Kline{}
	for i := range q.Limit {
		t := start.Add(time.Duration(i) * step)
		c := s.price[q.Symbol]
		if s.closes != nil {
			c = s.closes(q.Symbol, t)
		}
		out = append(out, Kline{Time: t, Open: c, High: c, Low: c, Close: c, Volume: 1})
	}
	return out, nil
}

func (s *paperSrc) OrderBook(context.Context, string, int) (OrderBook, error) {
	return OrderBook{}, ErrUnsupported
}
func (s *paperSrc) Funding(context.Context, string) (Funding, error) {
	return Funding{}, ErrUnsupported
}

type paperEnv struct {
	h     http.Handler
	reg   *plugin.Registry
	d     *db.DB
	src   *paperSrc
	clock *testClock
	n     *alertNotifier
	ev    *alertRecorder
	p     *Plugin
}

func fastPaper(t *testing.T) {
	t.Helper()
	oldP, oldR := paperEvery, runEvery
	paperEvery, runEvery = 30*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { paperEvery, runEvery = oldP, oldR })
}

// setupPaperAt 在指定库上起插件；fresh 为真时安装、启用并同步标的，否则当成重启只 Start。
func setupPaperAt(t *testing.T, path string, fresh bool, src *paperSrc) paperEnv {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	p := New(src)
	p.now, p.tick, p.push = src.clock.now, 30*time.Millisecond, 50*time.Millisecond
	n, ev := &alertNotifier{}, &alertRecorder{}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.Events = ev
	r.SetNotifier(n)
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if fresh {
		if err := r.Install(ctx, "trade", tradePerms); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, "trade"); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	e := paperEnv{h: mux, reg: r, d: d, src: src, clock: src.clock, n: n, ev: ev, p: p}
	if fresh {
		data(t, mux, "POST", "/api/trade/sources/fake/sync", "")
	}
	return e
}

func setupPaper(t *testing.T) paperEnv {
	t.Helper()
	fastPaper(t)
	src := &paperSrc{price: map[string]float64{"FAKE:BTCUSDT": 100, "FAKE:BTCUSDT.P": 100}, clock: newTestClock(time.Now())}
	e := setupPaperAt(t, filepath.Join(t.TempDir(), "pm.db"), true, src)
	t.Cleanup(func() { e.reg.Close(); _ = e.d.Close() })
	return e
}

func (e paperEnv) account(t *testing.T, body string) string {
	t.Helper()
	return data(t, e.h, "POST", "/api/trade/accounts", body)["id"].(string)
}

func (e paperEnv) order(t *testing.T, body string) map[string]any {
	t.Helper()
	return data(t, e.h, "POST", "/api/trade/orders", body)
}

func (e paperEnv) waitOrder(t *testing.T, id, status string) map[string]any {
	t.Helper()
	var o map[string]any
	waitFor(t, "委托 "+id+" 变成 "+status, func() bool {
		o = data(t, e.h, "GET", "/api/trade/orders/"+id, "")
		return o["status"] == status
	})
	return o
}

func (e paperEnv) check(t *testing.T, aid string) map[string]any {
	t.Helper()
	c := data(t, e.h, "GET", "/api/trade/accounts/"+aid+"/reconcile", "")
	if c["ok"] != true {
		t.Fatalf("对账不通过：%v", c)
	}
	return c
}

func (e paperEnv) audits(t *testing.T, action string) int {
	t.Helper()
	var n int
	if err := e.d.R.QueryRow(`SELECT COUNT(*) FROM audits WHERE action = ? AND actor LIKE 'trade%'`, action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPaperAccountsOnly(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	a := data(t, h, "POST", "/api/trade/accounts", `{"name":"模拟盘 A","initial":50000,"fee_bp":2}`)
	if a["paper"] != true || a["equity"] != 50000.0 || a["available"] != 50000.0 || a["broker"] != "模拟" || a["fee_bp"] != 2.0 ||
		a["status"] != "connected" || !strings.HasPrefix(a["id"].(string), "ac_") {
		t.Fatalf("新建 = %v", a)
	}
	id := a["id"].(string)
	for name, body := range map[string]string{
		"建实盘":     `{"paper":false}`,
		"币种不认识":   `{"currency":"CNY"}`,
		"初始资金为 0": `{"initial":0}`,
		"不认识的字段":  `{"api_key":"x"}`,
	} {
		if code, out := call(t, h, "POST", "/api/trade/accounts", body); code != 400 {
			t.Errorf("%s = %d %v", name, code, out)
		}
	}
	for _, body := range []string{`{"paper":true}`, `{"paper":false}`, `{"initial":1}`, `{"currency":"USDT"}`} {
		if code, _ := call(t, h, "PATCH", "/api/trade/accounts/"+id, body); code != 400 {
			t.Errorf("PATCH %s 应当 400，得到 %d", body, code)
		}
	}
	if p := data(t, h, "PATCH", "/api/trade/accounts/"+id, `{"name":"改名","slippage_ticks":3}`); p["name"] != "改名" || p["slippage_ticks"] != 3.0 || p["paper"] != true {
		t.Fatalf("PATCH = %v", p)
	}
	// 不存在的账户 400；实盘账户（TRD-08d）：不是用户本人在界面上提交的手动单 403 not_user，什么都不记
	if _, err := e.d.W.Exec(`INSERT INTO trade_accounts (id, name, broker, paper, initial_e8, created_at, updated_at) VALUES ('ac_live', 'Binance 主账户', 'Binance', 0, 1, 'x', 'x')`); err != nil {
		t.Fatal(err)
	}
	for aid, want := range map[string]int{"ac_nope": 400, "ac_live": 403, "": 400} {
		code, out := call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":0.1}`)
		if code != want {
			t.Errorf("账户 %q 下单 = %d %v，应当 %d", aid, code, out, want)
		}
		if want == 403 {
			e := out["error"].(map[string]any)
			if e["code"] != "forbidden" || e["reason"] != "not_user" || !strings.Contains(e["message"].(string), "实盘下单") {
				t.Errorf("实盘账户下单的错误 = %v", e)
			}
		}
	}
	var n int
	_ = e.d.R.QueryRow(`SELECT COUNT(*) FROM trade_orders`).Scan(&n)
	if n != 0 {
		t.Fatalf("被拒的请求不该留委托：%d", n)
	}
	if e.audits(t, "create") != 1 {
		t.Fatal("建账户要记审计")
	}
}

func TestPaperMatching(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	aid := e.account(t, `{"initial":100000,"fee_bp":5,"slippage_ticks":2}`)
	// 限价买 99 挂着：价格 100 不成交
	lim := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","qty":10,"price":99}`)
	if lim["status"] != "open" || lim["price"] != 99.0 {
		t.Fatalf("限价单 = %v", lim)
	}
	time.Sleep(200 * time.Millisecond)
	if o := data(t, h, "GET", "/api/trade/orders/"+lim["id"].(string), ""); o["status"] != "open" {
		t.Fatalf("价格没到不该成交：%v", o)
	}
	a := data(t, h, "GET", "/api/trade/accounts/"+aid, "")
	if a["order_hold"] != 990.0 || a["available"] != 100000-990.0 {
		t.Fatalf("挂单占用 = %v / %v", a["order_hold"], a["available"])
	}
	// 价格跌到 98.5：按委托价 99 成交，手续费 10 × 99 × 0.0005
	e.src.set("FAKE:BTCUSDT", 98.5)
	o := e.waitOrder(t, lim["id"].(string), "filled")
	if o["avg_fill"] != 99.0 || o["filled"] != 10.0 || math.Abs(o["fee"].(float64)-0.495) > 1e-12 {
		t.Fatalf("限价成交 = %v", o)
	}
	// 市价卖 4：最新价 98.5 减 2 跳（0.2）= 98.3
	mk := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"sell","type":"market","qty":4}`)
	o = e.waitOrder(t, mk["id"].(string), "filled")
	if o["avg_fill"] != 98.3 {
		t.Fatalf("市价成交价 = %v", o["avg_fill"])
	}
	fills := list(t, h, "/api/trade/fills?account_id="+aid)
	if len(fills) != 2 {
		t.Fatalf("成交 = %v", fills)
	}
	sell := fills[0].(map[string]any)
	// 平 4：已实现 (98.3 − 99) × 4 = −2.8
	if math.Abs(sell["realized_pnl"].(float64)+2.8) > 1e-9 || sell["kind"] != "trade" {
		t.Fatalf("卖出成交 = %v", sell)
	}
	ps := list(t, h, "/api/trade/positions?account_id="+aid)
	if len(ps) != 1 {
		t.Fatalf("持仓 = %v", ps)
	}
	p := ps[0].(map[string]any)
	if p["qty"] != 6.0 || p["avg_price"] != 99.0 || p["side"] != "long" || p["last"] != 98.5 || math.Abs(p["pnl"].(float64)+3) > 1e-9 {
		t.Fatalf("持仓 = %v", p)
	}
	// 对账：权益 = 初始 + 已实现 + 未实现 − 手续费
	c := e.check(t, aid)
	fee := 0.495 + 4*98.3*0.0005
	want := 100000 - 2.8 - 3 - fee
	if eq, _ := parseFx(c["equity"].(string)); math.Abs(eq.Float()-want) > 1e-8 {
		t.Fatalf("权益 %v，要 %v", c["equity"], want)
	}
	a = data(t, h, "GET", "/api/trade/accounts/"+aid, "")
	if math.Abs(a["equity"].(float64)-want) > 1e-8 || math.Abs(a["realized_pnl"].(float64)+2.8) > 1e-9 || math.Abs(a["fees"].(float64)-fee) > 1e-9 {
		t.Fatalf("账户 = %v", a)
	}
	// 现货卖超了：被拒（模拟交易所拒单），委托记成被拒绝
	over := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"sell","type":"market","qty":7}`)
	if over["status"] != "rejected" || over["reject_reason"] != "可卖数量不足：持有 6" {
		t.Fatalf("卖超 = %v", over)
	}
	// 止损卖：跌到 97 触发，按最新价减滑点
	stop := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"sell","type":"stop","qty":1,"stop_price":97}`)
	time.Sleep(150 * time.Millisecond)
	if o := data(t, h, "GET", "/api/trade/orders/"+stop["id"].(string), ""); o["status"] != "open" {
		t.Fatalf("没到触发价：%v", o)
	}
	// 止损限价卖：触发 96、限价 96.5——触发时最新价 95.9 低于限价不成交，涨回 96.5 再成交
	sl := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"sell","type":"stop_limit","qty":1,"stop_price":96,"price":96.5}`)
	e.src.set("FAKE:BTCUSDT", 95.9)
	o = e.waitOrder(t, stop["id"].(string), "filled")
	if o["avg_fill"] != 95.7 {
		t.Fatalf("止损成交价 = %v", o["avg_fill"])
	}
	waitFor(t, "止损限价触发", func() bool { return data(t, h, "GET", "/api/trade/orders/"+sl["id"].(string), "")["triggered"] == true })
	if o := data(t, h, "GET", "/api/trade/orders/"+sl["id"].(string), ""); o["status"] != "open" {
		t.Fatalf("触发了但限价不满足：%v", o)
	}
	e.src.set("FAKE:BTCUSDT", 96.6)
	if o := e.waitOrder(t, sl["id"].(string), "filled"); o["avg_fill"] != 96.5 {
		t.Fatalf("止损限价成交价 = %v", o["avg_fill"])
	}
	// 行情不是实时：不撮合
	e.src.setFail(true)
	waitFor(t, "最新价降级", func() bool {
		qs := list(t, h, "/api/trade/quotes?symbols=FAKE:BTCUSDT")
		return qs[0].(map[string]any)["status"] != "live"
	})
	mk2 := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":1}`)
	time.Sleep(200 * time.Millisecond)
	if o := data(t, h, "GET", "/api/trade/orders/"+mk2["id"].(string), ""); o["status"] != "open" {
		t.Fatalf("行情不是实时时不该成交：%v", o)
	}
	e.src.setFail(false)
	e.waitOrder(t, mk2["id"].(string), "filled")
	// 撤单、改价
	lim2 := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","qty":1,"price":50}`)
	if p := data(t, h, "PATCH", "/api/trade/orders/"+lim2["id"].(string), `{"price":51}`); p["price"] != 51.0 {
		t.Fatalf("改价 = %v", p)
	}
	if c := data(t, h, "POST", "/api/trade/orders/"+lim2["id"].(string)+"/cancel", ""); c["status"] != "canceled" {
		t.Fatalf("撤单 = %v", c)
	}
	if code, _ := call(t, h, "POST", "/api/trade/orders/"+lim2["id"].(string)+"/cancel", ""); code != 409 {
		t.Fatalf("撤已撤的单 = %d", code)
	}
	e.check(t, aid)
	if e.audits(t, "fill") != 5 || e.audits(t, "place") < 6 || e.audits(t, "cancel") != 1 || e.audits(t, "reject") != 1 {
		t.Fatalf("审计：fill %d place %d cancel %d reject %d", e.audits(t, "fill"), e.audits(t, "place"), e.audits(t, "cancel"), e.audits(t, "reject"))
	}
}

func TestPaperContractsAndLiquidation(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	aid := e.account(t, `{"fee_bp":0,"slippage_ticks":0}`)
	data(t, h, "PATCH", "/api/trade/risk", `{"max_leverage":20}`)
	// 开空 100 张 @ 100，10 倍：保证金 1000；强平价 100 × (1 + 0.1 − 0.005) = 109.5
	o := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT.P","side":"sell","type":"market","qty":100,"leverage":10}`)
	e.waitOrder(t, o["id"].(string), "filled")
	p := list(t, h, "/api/trade/positions?account_id="+aid)[0].(map[string]any)
	if p["side"] != "short" || p["leverage"] != 10.0 || p["liq_price"] != 109.5 || p["margin"] != 1000.0 {
		t.Fatalf("合约持仓 = %v", p)
	}
	// 仅减仓：买 150 只成交 100
	ro := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT.P","side":"buy","type":"limit","qty":150,"price":90,"reduce_only":true,"confirmed":true}`)
	if ro["status"] != "open" {
		t.Fatalf("仅减仓 = %v", ro)
	}
	if code, _ := call(t, h, "POST", "/api/trade/orders/"+ro["id"].(string)+"/cancel", ""); code != 200 {
		t.Fatal("撤仅减仓")
	}
	// 涨到 110：强平
	e.src.set("FAKE:BTCUSDT.P", 110)
	waitFor(t, "强平", func() bool { return len(list(t, h, "/api/trade/positions?account_id="+aid)) == 0 })
	fs := list(t, h, "/api/trade/fills?account_id="+aid)
	liq := fs[0].(map[string]any)
	if liq["kind"] != "liquidation" || liq["price"] != 110.0 || liq["realized_pnl"] != -1000.0 {
		t.Fatalf("强平成交 = %v", liq)
	}
	if ns := e.n.list(); len(ns) == 0 || !strings.Contains(ns[len(ns)-1].Title, "强平") {
		t.Fatalf("强平要发通知：%v", ns)
	}
	e.check(t, aid)
}

func TestRiskEnforcedOnBackend(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	aid := e.account(t, `{"initial":1000000,"fee_bp":0}`)
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":5000,"max_position_pct":50,"max_leverage":5,"confirm_above":2000}`)
	if code, _ := call(t, h, "PATCH", "/api/trade/risk", `{"max_leverage":0}`); code != 400 {
		t.Fatal("规则要大于 0")
	}
	// 超单笔上限：409，委托记成被拒绝，原因同原型
	code, out := call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":60,"confirmed":true}`)
	er := out["error"].(map[string]any)
	if code != 409 || er["reason"] != "risk" || er["message"] != "风控未通过：单笔金额 $6,000 超过上限 $5,000" || er["order"].(map[string]any)["status"] != "rejected" {
		t.Fatalf("超单笔 = %d %v", code, out)
	}
	// 超杠杆
	code, out = call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT.P","side":"buy","type":"market","qty":1,"leverage":6}`)
	if code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "杠杆 6x 超过上限 5x") {
		t.Fatalf("超杠杆 = %d %v", code, out)
	}
	// 超二次确认阈值没带确认：409 confirm，不记委托；带上就过
	code, out = call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":30}`)
	if code != 409 || out["error"].(map[string]any)["reason"] != "confirm" || out["error"].(map[string]any)["confirm_above"] != 2000.0 {
		t.Fatalf("二次确认 = %d %v", code, out)
	}
	o := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":30,"confirmed":true}`)
	e.waitOrder(t, o["id"].(string), "filled")
	// 一键全停：撤挂单、进入熔断、记审计、发事件和通知
	lim := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","qty":1,"price":50}`)
	k := data(t, h, "POST", "/api/trade/risk/kill", `{"reason":"测试全停"}`)
	if k["halted"] != true || k["orders_canceled"] != 1.0 || k["reason"] != "测试全停" || len(k["remaining_orders"].([]any)) != 0 {
		t.Fatalf("全停 = %v", k)
	}
	if o := data(t, h, "GET", "/api/trade/orders/"+lim["id"].(string), ""); o["status"] != "canceled" {
		t.Fatalf("挂单要撤掉：%v", o)
	}
	r := data(t, h, "GET", "/api/trade/risk", "")
	if r["halted"] != true || r["halted_reason"] != "测试全停" {
		t.Fatalf("熔断 = %v", r)
	}
	// 熔断中开新仓被拒，平仓照常（平仓金额超过确认线也要确认）
	code, out = call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":1}`)
	if code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "熔断中：只能平仓或减仓，禁止新开仓") {
		t.Fatalf("熔断中开仓 = %d %v", code, out)
	}
	pid := list(t, h, "/api/trade/positions?account_id="+aid)[0].(map[string]any)["id"].(string)
	cl := data(t, h, "POST", "/api/trade/positions/"+pid+"/close", `{"confirmed":true}`)
	if cl["status"] != "open" || cl["source"] != "close" {
		t.Fatalf("熔断中平仓 = %v", cl)
	}
	e.waitOrder(t, cl["id"].(string), "filled")
	// 解除要写原因
	if code, _ := call(t, h, "POST", "/api/trade/risk/release", `{}`); code != 400 {
		t.Fatal("解除不写原因应当 400")
	}
	rel := data(t, h, "POST", "/api/trade/risk/release", `{"reason":"演练完毕"}`)
	if rel["halted"] != false {
		t.Fatalf("解除 = %v", rel)
	}
	if code, _ := call(t, h, "POST", "/api/trade/risk/release", `{"reason":"再来"}`); code != 409 {
		t.Fatal("没熔断时解除应当 409")
	}
	halts := list(t, h, "/api/trade/risk/halts")
	if len(halts) != 1 || halts[0].(map[string]any)["release_reason"] != "演练完毕" || halts[0].(map[string]any)["kind"] != "manual" {
		t.Fatalf("熔断记录 = %v", halts)
	}
	if e.audits(t, "risk_block") != 3 || e.audits(t, "kill") != 1 || e.audits(t, "release") != 1 {
		t.Fatalf("审计：risk_block %d kill %d release %d", e.audits(t, "risk_block"), e.audits(t, "kill"), e.audits(t, "release"))
	}
	types := map[string]int{}
	for _, ev := range e.ev.list() {
		types[ev["type"].(string)]++
	}
	if types[haltedEvent] != 1 || types[releasedEvent] != 1 {
		t.Fatalf("事件 = %v", types)
	}
	e.check(t, aid)
}

func TestDailyLossAutoHalt(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	aid := e.account(t, `{"initial":10000,"fee_bp":0,"slippage_ticks":0}`)
	data(t, h, "PATCH", "/api/trade/risk", `{"daily_loss_pct":2,"max_position_pct":100,"confirm_above":1000000}`)
	o := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":30}`)
	e.waitOrder(t, o["id"].(string), "filled")
	lim := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"limit","qty":1,"price":10}`)
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	rid := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":1000}`)["id"].(string)
	// 跌到 93：亏 210，超过 10000 的 2%
	e.src.set("FAKE:BTCUSDT", 93)
	waitFor(t, "自动熔断", func() bool { return data(t, h, "GET", "/api/trade/risk", "")["halted"] == true })
	r := data(t, h, "GET", "/api/trade/risk", "")
	if r["halted_reason"] != "单日亏损 $210，达到上限 2%，自动熔断" {
		t.Fatalf("熔断原因 = %v", r["halted_reason"])
	}
	day := r["day"].(map[string]any)
	if day["loss_used"] != 210.0 || day["loss_limit"] != 200.0 || day["start_equity"] != 10000.0 {
		t.Fatalf("当日 = %v", day)
	}
	e.waitOrder(t, lim["id"].(string), "canceled")
	if run := data(t, h, "GET", "/api/trade/runs/"+rid, ""); run["status"] != "stopped" || !strings.HasPrefix(run["stop_reason"].(string), "一键全停：单日亏损") {
		t.Fatalf("自动熔断后部署要停：%v", run)
	}
	// 解除后还在上限外：同一天不再自动熔断
	data(t, h, "POST", "/api/trade/risk/release", `{"reason":"人工确认继续"}`)
	time.Sleep(200 * time.Millisecond)
	if data(t, h, "GET", "/api/trade/risk", "")["halted"] != false {
		t.Fatal("同一天解除后不该重复自动熔断")
	}
	halts := list(t, h, "/api/trade/risk/halts")
	if len(halts) != 1 || halts[0].(map[string]any)["kind"] != "auto" || e.audits(t, "halt") != 1 {
		t.Fatalf("熔断记录 = %v", halts)
	}
}

/* ---------- 部署 ---------- */

// crossStrategy：价格上穿 100 开多、下穿 100 平仓，1 分钟线。
const crossStrategy = `{"name":"上穿 100","symbols":["FAKE:BTCUSDT"],"interval":"1m","direction":"long","position_pct":50,
	"entry":{"logic":"all","rules":[{"id":"r1","left":{"kind":"ind","ind":"price","params":[]},"op":"cross_up","right":{"kind":"num","value":100}}]},
	"exit":{"logic":"any","rules":[{"id":"r2","left":{"kind":"ind","ind":"price","params":[]},"op":"cross_down","right":{"kind":"num","value":100}}]}}`

func runLogs(r map[string]any) string {
	var b strings.Builder
	for _, l := range r["logs"].([]any) {
		b.WriteString(l.(map[string]any)["text"].(string) + "\n")
	}
	return b.String()
}

func TestDeployRunSignalsOrdersAndRestart(t *testing.T) {
	fastPaper(t)
	// 从某分钟的第 10 秒开始；T0 那根以前收 90，从 T0 起收 110
	base := time.Now().UTC().Truncate(time.Minute).Add(-time.Hour)
	clock := newTestClock(base.Add(10 * time.Second))
	t0 := base
	var mu sync.Mutex
	down := map[int64]bool{} // 收 90 的 K 线
	src := &paperSrc{price: map[string]float64{"FAKE:BTCUSDT": 110, "FAKE:BTCUSDT.P": 110}, clock: clock}
	src.closes = func(_ string, open time.Time) float64 {
		mu.Lock()
		defer mu.Unlock()
		if open.Before(t0) || down[open.UnixMilli()] {
			return 90
		}
		return 110
	}
	path := filepath.Join(t.TempDir(), "pm.db")
	e := setupPaperAt(t, path, true, src)
	h := e.h
	aid := e.account(t, `{"initial":100000,"fee_bp":0,"slippage_ticks":0}`)
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	// 部署到实盘 403（TRD-07a）；不存在的账户 400；不认识的参数 400
	if _, err := e.d.W.Exec(`INSERT INTO trade_accounts (id, name, paper, initial_e8, created_at, updated_at) VALUES ('ac_live', '实盘', 0, 1, 'x', 'x')`); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"ac_live","capital":20000}`); code != 403 {
		t.Errorf("部署到实盘账户 = %d %v，应当 403", code, out)
	}
	for _, body := range []string{
		`{"strategy_id":"` + sid + `","account_id":"ac_nope","capital":20000}`,
		`{"strategy_id":"` + sid + `","account_id":"` + aid + `","capital":20000,"params":{"nope":1}}`,
		`{"strategy_id":"` + sid + `","account_id":"` + aid + `","capital":2000000}`,
	} {
		if code, out := call(t, h, "POST", "/api/trade/runs", body); code != 400 {
			t.Errorf("%s = %d %v，应当 400", body, code, out)
		}
	}
	run := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":20000}`)
	rid := run["id"].(string)
	if run["status"] != "running" || run["capital"] != 20000.0 || run["strategy_name"] != "上穿 100" || !strings.Contains(runLogs(run), "模拟盘启动：BTC/USDT，分配 20,000.00 USD") {
		t.Fatalf("部署 = %v", run)
	}
	// T0 那根收盘（时钟走到 T0 + 1 分 10 秒）：上穿 100，开多 20000 × 50% / 110 = 90.9090
	clock.advance(time.Minute)
	var r map[string]any
	waitFor(t, "部署下单并成交", func() bool {
		r = data(t, h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Contains(runLogs(r), "成交：")
	})
	logs := runLogs(r)
	if !strings.Contains(logs, "入场信号，开多，市价买入 90.909") || !strings.Contains(logs, "成交：买入 90.909 BTC/USDT @ 110.0") {
		t.Fatalf("日志 = %s", logs)
	}
	os := list(t, h, "/api/trade/orders?run_id="+rid)
	if len(os) != 1 || os[0].(map[string]any)["source"] != "run" || os[0].(map[string]any)["qty"] != 90.909 {
		t.Fatalf("部署的委托 = %v", os)
	}
	if hs := r["holdings"].([]any); len(hs) != 1 || hs[0].(map[string]any)["qty"] != 90.909 {
		t.Fatalf("部署持仓 = %v", r["holdings"])
	}
	fs := list(t, h, "/api/trade/fills?run_id="+rid)
	if len(fs) != 1 || fs[0].(map[string]any)["run_id"] != rid {
		t.Fatalf("部署的成交 = %v", fs)
	}
	// 同一根 K 线再算一次不重复下单
	e.p.runs.tick(context.Background())
	if n := len(list(t, h, "/api/trade/orders?run_id="+rid)); n != 1 {
		t.Fatalf("重算同一根下了 %d 单", n)
	}

	// 停进程；停着的时候 T0+2 那根下穿（收 90），T0+3 起又收 110
	e.reg.Close()
	_ = e.d.Close()
	mu.Lock()
	down[t0.Add(2*time.Minute).UnixMilli()] = true
	mu.Unlock()
	clock.advance(5 * time.Minute) // 现在 T0 + 6 分 10 秒，最近收盘的是 T0+5

	e2 := setupPaperAt(t, path, false, src)
	t.Cleanup(func() { e2.reg.Close(); _ = e2.d.Close() })
	waitFor(t, "重启后补算", func() bool {
		r = data(t, e2.h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Contains(runLogs(r), "补算")
	})
	logs = runLogs(r)
	if r["status"] != "running" || !strings.Contains(logs, "后端重启，部署继续运行") || !strings.Contains(logs, "出场信号") || !strings.Contains(logs, "不补下单") {
		t.Fatalf("重启后日志 = %s", logs)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(list(t, e2.h, "/api/trade/orders?run_id="+rid)); n != 1 {
		t.Fatalf("错过的 K 线不该补下单，委托 %d 笔", n)
	}
	// 之后照常：T0+6 那根下穿 → 平多
	mu.Lock()
	down[t0.Add(6*time.Minute).UnixMilli()] = true
	mu.Unlock()
	e.src.set("FAKE:BTCUSDT", 90)
	clock.advance(time.Minute)
	waitFor(t, "出场平仓", func() bool {
		r = data(t, e2.h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Count(runLogs(r), "成交：") == 2
	})
	if !strings.Contains(runLogs(r), "出场信号，平多") || len(r["holdings"].([]any)) != 0 {
		t.Fatalf("平仓后 = %v", r)
	}
	// 盈亏：(90 − 110) × 90.909
	if math.Abs(r["pnl"].(float64)+20*90.909) > 1e-6 {
		t.Fatalf("部署盈亏 = %v", r["pnl"])
	}
	data(t, e2.h, "GET", "/api/trade/accounts/"+aid+"/reconcile", "")

	// 一键全停：部署停掉，日志有原因；熔断中不能启动
	k := data(t, e2.h, "POST", "/api/trade/risk/kill", "")
	if k["runs_stopped"] != 1.0 || k["reason"] != "手动一键全停" {
		t.Fatalf("全停 = %v", k)
	}
	r = data(t, e2.h, "GET", "/api/trade/runs/"+rid, "")
	if r["status"] != "stopped" || r["stop_reason"] != "一键全停：手动一键全停" {
		t.Fatalf("全停后部署 = %v", r)
	}
	if code, out := call(t, e2.h, "POST", "/api/trade/runs/"+rid+"/resume", ""); code != 409 || out["error"].(map[string]any)["reason"] != "halted" {
		t.Fatalf("熔断中启动 = %d %v", code, out)
	}
	if code, _ := call(t, e2.h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`"}`); code != 409 {
		t.Fatal("熔断中新建部署应当 409")
	}
	data(t, e2.h, "POST", "/api/trade/risk/release", `{"reason":"继续"}`)
	if r = data(t, e2.h, "POST", "/api/trade/runs/"+rid+"/resume", ""); r["status"] != "running" || !strings.Contains(runLogs(r), "重新启动") {
		t.Fatalf("重新启动 = %v", r)
	}
	// 删策略：部署停止，原因「策略已删除」
	data(t, e2.h, "DELETE", "/api/trade/strategies/"+sid, "")
	if r = data(t, e2.h, "GET", "/api/trade/runs/"+rid, ""); r["status"] != "stopped" || r["stop_reason"] != "策略已删除" {
		t.Fatalf("删策略后 = %v", r)
	}
	if rs := list(t, e2.h, "/api/trade/runs?strategy_id="+sid); len(rs) != 1 {
		t.Fatalf("按策略筛 = %v", rs)
	}
}

func TestDeployRiskBlockLogged(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	base := time.Now().UTC().Truncate(time.Minute)
	e.src.closes = func(_ string, open time.Time) float64 {
		if open.Before(base) {
			return 90
		}
		return 110
	}
	aid := e.account(t, `{"initial":100000}`)
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":1000}`)
	sid := data(t, h, "POST", "/api/trade/strategies", crossStrategy)["id"].(string)
	rid := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":20000}`)["id"].(string)
	// 时钟挪到 base 那根刚收盘
	e.clock.advance(base.Add(time.Minute + 5*time.Second).Sub(e.clock.now()))
	var r map[string]any
	waitFor(t, "风控拦截写日志", func() bool {
		r = data(t, h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Contains(runLogs(r), "风控拦截")
	})
	if !strings.Contains(runLogs(r), "单笔金额 $9,091 超过上限 $1,000") {
		t.Fatalf("日志 = %s", runLogs(r))
	}
	os := list(t, h, "/api/trade/orders?run_id="+rid)
	if len(os) != 1 || os[0].(map[string]any)["status"] != "rejected" {
		t.Fatalf("被拦的委托 = %v", os)
	}
}

// 并发下单、撮合、全停：-race 下跑，账本对得上。
func TestPaperConcurrent(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	aid := e.account(t, `{"initial":1000000}`)
	data(t, h, "PATCH", "/api/trade/risk", `{"confirm_above":1000000,"max_position_pct":100}`)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 5 {
				side := []string{"buy", "sell"}[(i+j)%2]
				code, out := call(t, h, "POST", "/api/trade/orders", fmt.Sprintf(`{"account_id":"%s","symbol":"FAKE:BTCUSDT.P","side":"%s","type":"market","qty":%d}`, aid, side, 1+j))
				if code != 201 {
					t.Errorf("下单 = %d %v", code, out)
				}
			}
		}()
	}
	wg.Wait()
	waitFor(t, "全部成交", func() bool { return len(list(t, h, "/api/trade/orders?account_id="+aid+"&status=active")) == 0 })
	e.check(t, aid)
}

// 网格近似的代码策略：收盘价 95 在 [90, 110] 10 格的第 2 格，目标仓位 (5 − 2) × 1 = 3。
func TestDeployGrid(t *testing.T) {
	e := setupPaper(t)
	h := e.h
	e.src.closes = func(string, time.Time) float64 { return 95 }
	e.src.set("FAKE:BTCUSDT.P", 95)
	aid := e.account(t, `{"initial":100000}`)
	sid := data(t, h, "POST", "/api/trade/strategies", `{"name":"永续网格","mode":"code","code":"grid","symbols":["FAKE:BTCUSDT.P"],"interval":"1m",
		"direction":"both","position_pct":50,"params":{"lower":90,"upper":110,"grids":10,"qty":1}}`)["id"].(string)
	// 期现基差不能部署
	bid := data(t, h, "POST", "/api/trade/strategies", `{"name":"期现基差","mode":"code","symbols":["FAKE:BTCUSDT.P"],"interval":"1m","params":{"open_bp":40}}`)["id"].(string)
	if code, out := call(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+bid+`","account_id":"`+aid+`"}`); code != 400 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "期现基差") {
		t.Fatalf("基差部署 = %d %v", code, out)
	}
	rid := data(t, h, "POST", "/api/trade/runs", `{"strategy_id":"`+sid+`","account_id":"`+aid+`","capital":20000}`)["id"].(string)
	e.clock.advance(time.Minute)
	var r map[string]any
	waitFor(t, "网格下单成交", func() bool {
		r = data(t, h, "GET", "/api/trade/runs/"+rid, "")
		return strings.Contains(runLogs(r), "成交：")
	})
	if !strings.Contains(runLogs(r), "网格第 2 格，市价买入 3") || r["holdings"].([]any)[0].(map[string]any)["qty"] != 3.0 {
		t.Fatalf("网格 = %v", r)
	}
	// 暂停、恢复、停止
	if r = data(t, h, "POST", "/api/trade/runs/"+rid+"/pause", ""); r["status"] != "paused" {
		t.Fatalf("暂停 = %v", r)
	}
	if code, _ := call(t, h, "POST", "/api/trade/runs/"+rid+"/pause", ""); code != 409 {
		t.Fatal("暂停的再暂停应当 409")
	}
	if r = data(t, h, "POST", "/api/trade/runs/"+rid+"/resume", ""); r["status"] != "running" || !strings.Contains(runLogs(r), "手动恢复") {
		t.Fatalf("恢复 = %v", r)
	}
	if r = data(t, h, "POST", "/api/trade/runs/"+rid+"/stop", `{"reason":"换参数"}`); r["status"] != "stopped" || r["stop_reason"] != "换参数" {
		t.Fatalf("停止 = %v", r)
	}
	if code, _ := call(t, h, "POST", "/api/trade/runs/"+rid+"/stop", ""); code != 409 {
		t.Fatal("停了再停应当 409")
	}
	// 持仓保留
	if ps := list(t, h, "/api/trade/positions?account_id="+aid); len(ps) != 1 {
		t.Fatalf("停止不平仓：%v", ps)
	}
}
