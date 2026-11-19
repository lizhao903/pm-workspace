// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// 内置策略（TRD-09）和 autotrader 对拍。testdata/autotrader_golden.json 由 testdata/gen-autotrader-golden.py
// 用 autotrader 自己的指标函数和逐行转写的信号条件生成（BTCUSDT 3m，2024-06-01 到 06-07）。

type atSigs struct{ Buy, Sell []int }

type atGolden struct {
	Tail                            []map[string]float64
	KdjAdapter, KdjLive, Supertrend atSigs
}

func loadATGolden(t *testing.T) ([]Bar, atGolden) {
	t.Helper()
	b, err := os.ReadFile("testdata/autotrader_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Bars       [][6]float64         `json:"bars"`
		Tail       []map[string]float64 `json:"kdj_tail"`
		KdjAdapter atSigs               `json:"kdj_adapter"`
		KdjLive    atSigs               `json:"kdj_live"`
		Supertrend atSigs               `json:"supertrend"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	g := atGolden{Tail: raw.Tail, KdjAdapter: raw.KdjAdapter, KdjLive: raw.KdjLive, Supertrend: raw.Supertrend}
	bs := make([]Bar, len(raw.Bars))
	for i, r := range raw.Bars {
		bs[i] = Bar{T: int64(r[0]), O: r[1], H: r[2], L: r[3], C: r[4], V: r[5]}
	}
	return bs, g
}

func sigIdx(xs []bool) []int {
	out := []int{}
	for i, x := range xs {
		if x {
			out = append(out, i)
		}
	}
	return out
}

// adapterParams 是 autotrader 回测引擎适配器的口径：买点不要 J 拐头、卖点要 1h 超买拐头，出场只认信号、一次全仓。
func adapterParams(b *BuiltinStrategy) Params {
	return b.defaults().Merge(Params{{"buy_need_j3_turn", 0}, {"sell_need_trend", 1}, {"early_stop", 0}, {"breakeven_trigger", 0},
		{"trail_arm", 0}, {"sell_gate", -100}, {"pyramid_first_pct", 100}, {"stop_loss", 0}, {"take_profit", 0}})
}

func TestBuiltinSignalsMatchAutotrader(t *testing.T) {
	bs, g := loadATGolden(t)
	kdj, _ := builtinOf("kdj-short-1h3m")
	st, _ := builtinOf("supertrend-adx-1h3m")
	cases := []struct {
		name      string
		b         *BuiltinStrategy
		ps        Params
		mode      string
		buy, sell []int
	}{
		{"KDJ 回测引擎口径（1h 整根）", kdj, adapterParams(kdj), trendLookahead, g.KdjAdapter.Buy, g.KdjAdapter.Sell},
		{"KDJ 实盘口径（1h 当前未收盘）", kdj, kdj.defaults(), "", g.KdjLive.Buy, g.KdjLive.Sell},
		{"SuperTrend（1h 已收盘）", st, st.defaults(), "", g.Supertrend.Buy, g.Supertrend.Sell},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := builtinSignals(c.b, c.ps, bs, c.mode)
			if got := sigIdx(s.buy); !slices.Equal(got, c.buy) {
				t.Errorf("买入信号\n  go：%v\nautotrader：%v", got, c.buy)
			}
			if got := sigIdx(s.sell); !slices.Equal(got, c.sell) {
				t.Errorf("卖出信号\n  go：%v\nautotrader：%v", got, c.sell)
			}
			if len(c.buy) == 0 || len(c.sell) == 0 {
				t.Errorf("对照里没有信号，测不出东西")
			}
		})
	}
	k := kdjSeries(bs, 9, 3, 3)
	for _, x := range g.Tail {
		i := int(x["i"])
		if k[i].K != x["k"] || k[i].D != x["d"] || k[i].J != x["j"] {
			t.Errorf("第 %d 根 KDJ = %+v，MyTT %v", i, k[i], x)
		}
	}
}

// 3m 聚成 1h：整点对齐，最后一根 3m 收盘时那根 1h 才算收盘。
func TestMTFAggregate(t *testing.T) {
	base := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	var bs []Bar
	for i := 0; i < 40; i++ {
		p := float64(100 + i)
		bs = append(bs, Bar{T: base + int64(i)*180000, O: p, H: p + 1, L: p - 1, C: p + 0.5, V: 1})
	}
	m := newMTF(bs, "1h")
	if len(m.groups) != 2 || m.groups[0].O != 100 || m.groups[0].H != 120 || m.groups[0].L != 99 || m.groups[0].C != 119.5 || m.groups[0].V != 20 {
		t.Fatalf("聚合不对：%+v", m.groups)
	}
	if c := m.lastClosed(bs, 18, 180000); c != -1 {
		t.Fatalf("第 19 根收盘时 1h 还没收盘，得到 %d", c)
	}
	if c := m.lastClosed(bs, 19, 180000); c != 0 {
		t.Fatalf("第 20 根收盘时第一根 1h 收盘，得到 %d", c)
	}
	if p := m.partial(bs, 22); p.O != 120 || p.H != 123 || p.C != 122.5 {
		t.Fatalf("未收盘的那根不对：%+v", p)
	}
}

// 持仓管理：应急止损、普通止损、保本、移动止盈、止盈、加仓、信号出场门槛。
func TestPosman(t *testing.T) {
	c := pmCfg{SL: 0.045, TP: 0.065, Early: 0.025, MinBars: 20, BE: 0.02, Arm: 0.02, Give: 0.01, Gate: 0.0225, First: 0.4, AddTrig: 0.005, Pct: 1}
	p := pmPos{Avg: 100, First: 100, Peak: 100, Armed: true}
	bar := func(o, h, l, cl float64) Bar { return Bar{O: o, H: h, L: l, C: cl} }
	cases := []struct {
		name   string
		p      pmPos
		b      Bar
		held   int
		reason string
		px     float64
		add    float64
	}{
		{"前 20 根只认应急止损", p, bar(99, 99.5, 97.4, 98), 3, "应急止损 2.5%", 97.5, 0},
		{"前 20 根跌 2% 不走", p, bar(99, 99.5, 98, 98.5), 3, "", 0, 0},
		{"20 根后普通止损", p, bar(99, 99, 95.4, 96), 20, "止损 4.5%", 95.5, 0},
		{"跳空低开按开盘价", p, bar(94, 95, 93, 94), 25, "止损 4.5%", 94, 0},
		{"保本 + 移动止盈", pmPos{Avg: 100, First: 100, Peak: 103}, bar(102.5, 102.6, 101.9, 102), 30, "移动止盈", 101.97, 0},
		{"前 20 根移动止盈也认", pmPos{Avg: 100, First: 100, Peak: 103}, bar(102.5, 102.6, 101.9, 102), 5, "移动止盈", 101.97, 0},
		{"止盈", p, bar(105, 106.6, 104.9, 106), 30, "止盈 6.5%", 106.5, 0},
		{"浮盈 0.5% 加仓", p, bar(100.1, 100.6, 100, 100.4), 2, "", 0, 100.5},
		{"已补满不再加", pmPos{Avg: 100, First: 100, Peak: 100}, bar(100.1, 100.6, 100, 100.4), 2, "", 0, 0},
	}
	for _, x := range cases {
		ex, add := c.intrabar(x.p, x.b, x.held)
		reason, px := "", 0.0
		if ex != nil {
			reason, px = ex.Reason, ex.Px
		}
		if reason != x.reason || math.Abs(px-x.px) > 1e-9 || math.Abs(add-x.add) > 1e-9 {
			t.Errorf("%s：得到 %q %v 加仓 %v，要 %q %v 加仓 %v", x.name, reason, px, add, x.reason, x.px, x.add)
		}
	}
	if c.sellAtClose(p, 102, true) || !c.sellAtClose(p, 102.25, true) || c.sellAtClose(p, 110, false) {
		t.Errorf("信号出场门槛 2.25%% 不对")
	}
	if !c.addAtClose(p, 100, true) || c.addAtClose(p, 99.9, true) {
		t.Errorf("信号加仓要收盘价不低于首笔价")
	}
}

// 回测：内置策略走 RunBacktest，按币种权重分资金，结果带每个标的的统计。
func TestBuiltinBacktest(t *testing.T) {
	bs, _ := loadATGolden(t)
	b, _ := builtinOf("kdj-short-1h3m")
	st := Strategy{Name: "kdj", Mode: "builtin", Builtin: b.ID, Symbols: []string{"FAKE:AUSDT", "FAKE:BUSDT"}, Interval: "3m", Direction: "long",
		StopLoss: b.StopLoss, TakeProfit: b.TakeProfit, PositionPct: b.PositionPct, Params: b.defaults(),
		SymbolWeights: map[string]float64{"FAKE:AUSDT": 3}}
	if err := st.Validate(); err != nil {
		t.Fatal(err)
	}
	inst := Instrument{Multiplier: 1, Lot: 1e-8, Digits: 2, Kind: "spot"}
	data := BacktestData{
		Instrument: func(string) (Instrument, bool) { return inst, true },
		Bars: func(_, iv string, n int) []Bar {
			if iv != "3m" {
				t.Fatalf("只该取 3m，取了 %s", iv)
			}
			return bs[max(0, len(bs)-n):]
		},
	}
	cfg := BacktestConfig{Symbols: st.Symbols, Interval: "3m", Bars: 1000, Capital: 4000, Params: st.Params}
	res := RunBacktest(cfg, st, data)
	if len(res.PerSymbol) != 2 || res.PerSymbol[0].Capital != 3000 || res.PerSymbol[1].Capital != 1000 {
		t.Fatalf("按权重 3:1 分资金不对：%+v", res.PerSymbol)
	}
	if res.Stats.Trades == 0 || res.PerSymbol[0].Stats.Trades != res.Stats.Trades/2 {
		t.Fatalf("成交笔数不对：合计 %d，单个 %+v", res.Stats.Trades, res.PerSymbol[0].Stats)
	}
	if len(res.Equity) != 1000 {
		t.Fatalf("资金曲线 %d 点，要 1000", len(res.Equity))
	}
	reasons := map[string]bool{}
	for _, tr := range res.Trades {
		reasons[strings.Fields(tr.Reason)[0]] = true
	}
	if !reasons["入场信号，首笔"] {
		t.Errorf("没有分批开仓：%v", reasons)
	}
	// 网格扫描：每组都有参数和胜率
	pts := SweepGrid(cfg, st, []GridAxis{{"oversold", []float64{15, 20}}, {"stop_loss", []float64{3, 4.5}}}, data)
	if len(pts) != 4 || pts[3].Params.Has("oversold") == false || pts[3].Value != 20 {
		t.Fatalf("网格扫描不对：%+v", pts)
	}
}

func TestThinEquity(t *testing.T) {
	var eq []EquityPoint
	for i := 0; i < 12345; i++ {
		eq = append(eq, EquityPoint{T: int64(i)})
	}
	out := thinEquity(eq, 5000)
	if len(out) > 5000 || out[0].T != 0 || out[len(out)-1].T != 12344 {
		t.Fatalf("抽样不对：%d 点，首 %d 尾 %d", len(out), out[0].T, out[len(out)-1].T)
	}
}

// 和 autotrader 回测引擎的结果整段对拍：要本机有 autotrader（PMW_AUTOTRADER_DIR 指向它的根目录），没有就跳过。
// 只读：klines.db 按 immutable 打开，backtest_results 只读 JSON。
func TestBuiltinParityAutotraderEngine(t *testing.T) {
	dir := os.Getenv("PMW_AUTOTRADER_DIR")
	if dir == "" {
		t.Skip("没设 PMW_AUTOTRADER_DIR，跳过和 autotrader 的整段对拍")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "backtest_results", "*_kdj-short-1h3m_*.json"))
	if len(files) == 0 {
		t.Skip("autotrader 没有 kdj-short-1h3m 的回测结果")
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "klines.db")+"?mode=ro&immutable=1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	b, _ := builtinOf("kdj-short-1h3m")
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var want struct {
			Symbol    string    `json:"symbol"`
			DateRange [2]string `json:"date_range"`
			Initial   float64   `json:"initial_usdt"`
			Metrics   struct {
				Return  float64 `json:"total_return_pct"`
				WinRate float64 `json:"win_rate"`
				Trades  int     `json:"trade_count"`
			} `json:"metrics"`
		}
		if err := json.Unmarshal(raw, &want); err != nil {
			t.Fatal(err)
		}
		day := func(s string) int64 { d, _ := time.Parse("2006-01-02", s); return d.UnixMilli() }
		rows, err := db.Query(`SELECT open_time, open, high, low, close, volume FROM kline WHERE symbol = ? AND interval = '3m' AND open_time >= ? AND open_time < ? ORDER BY open_time`,
			want.Symbol, day(want.DateRange[0]), day(want.DateRange[1]))
		if err != nil {
			t.Fatal(err)
		}
		var bs []Bar
		for rows.Next() {
			var x Bar
			if err := rows.Scan(&x.T, &x.O, &x.H, &x.L, &x.C, &x.V); err != nil {
				t.Fatal(err)
			}
			bs = append(bs, x)
		}
		_ = rows.Close()
		ps := adapterParams(b)
		st := Strategy{Mode: "builtin", Builtin: b.ID, Interval: "3m", Direction: "long", PositionPct: 100, Params: ps}
		inst := Instrument{Multiplier: 1, Lot: 1e-12, Digits: 2, Kind: "spot"}
		c := &btCtx{cfg: BacktestConfig{Interval: "3m", Bars: len(bs), Capital: want.Initial, Params: ps},
			st: st, data: BacktestData{Instrument: func(string) (Instrument, bool) { return inst, true }}}
		lg := c.builtinLeg(b, want.Symbol, bs, 50, want.Initial, &notes{}, trendLookahead)
		s := statsOf(lg.equity, lg.bench, lg.trades, want.Initial, 180000)
		t.Logf("%s %s~%s：工作台 %d 笔 胜率 %.4f 收益 %.4f%%；autotrader %d 笔 胜率 %.4f 收益 %.4f%%", want.Symbol, want.DateRange[0], want.DateRange[1],
			s.Trades, s.WinRate, s.TotalReturn*100, want.Metrics.Trades, want.Metrics.WinRate, want.Metrics.Return)
		if s.Trades != want.Metrics.Trades || math.Abs(s.WinRate-want.Metrics.WinRate) > 0.02 || math.Abs(s.TotalReturn*100-want.Metrics.Return) > 0.5 {
			t.Errorf("%s 和 autotrader 对不上", filepath.Base(f))
		}
	}
}
