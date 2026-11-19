// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

// 内置策略（TRD-09）：信号逻辑用 Go 写死在插件里、参数可调的策略，策略 mode 为 builtin，builtin 字段是下面注册表的 id。
// 第一批从 autotrader（Python 量化脚本集）移植：
//   - kdj-short-1h3m：KDJ 1h 定趋势 + 3m 定买卖点（autotrader 主策略，script/strategy/strategy_kdj_short_1h3m.py 的 compute_signals，
//     出场同 script/run/run_kdj_short_1h3m.py 的 decide_exit、信号出场浮盈门槛、斥候仓 + 加仓）；
//   - supertrend-adx-1h3m：SuperTrend 1h 定方向 + 3m SuperTrend 翻多且 ADX 走强入场、翻空出场（同 run_supertrend_hl_1h3m.py 的参数）。
// 多周期：趋势周期的 K 线由入场周期的 K 线聚合（3m 聚成 1h），回测和部署都只取入场周期一种 K 线。
// 回测（backtest.go runBuiltinLeg）和模拟盘部署（runs.go actBuiltin）用同一套信号（builtinSignals）和持仓管理（posman.go）。
// 只能部署到模拟盘账户：内置策略还没过实盘评审，实盘部署回 400。

// BuiltinParam 是内置策略的一个可调参数。
type BuiltinParam struct {
	Key     string  `json:"key"`
	Label   string  `json:"label"`
	Default float64 `json:"default"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Step    float64 `json:"step"`
	Unit    string  `json:"unit"`
	Help    string  `json:"help"`
}

// BuiltinStrategy 是内置策略的说明，GET /api/trade/strategy-builtins 原样给前端。
type BuiltinStrategy struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Desc          string         `json:"desc"`
	Source        string         `json:"source"`
	TrendInterval string         `json:"trend_interval"`
	EntryInterval string         `json:"entry_interval"`
	TrendMode     string         `json:"trend_mode"`
	Direction     string         `json:"direction"`
	Symbols       []string       `json:"symbols"`
	StopLoss      float64        `json:"stop_loss"`
	TakeProfit    float64        `json:"take_profit"`
	PositionPct   float64        `json:"position_pct"`
	Params        []BuiltinParam `json:"params"`
	// WarmBars 是要多取的入场周期 K 线（指标预热），回测、部署都用
	WarmBars int `json:"warm_bars"`

	signals func(b *BuiltinStrategy, p Params, bs []Bar, mode string) builtinSig
}

// builtinSig 是每根入场 K 线收盘时的买、卖信号。
type builtinSig struct{ buy, sell []bool }

// 公共的出场参数（posman）。值为 0 表示不用。
func exitParams(early, minBars, be, arm, give, gate, first, trig float64) []BuiltinParam {
	return []BuiltinParam{
		{Key: "early_stop", Label: "应急止损", Default: early, Min: 0, Max: 50, Step: 0.1, Unit: "%", Help: "开仓后前「普通止损生效根数」根里，跌到成本以下这么多就走；0 不用"},
		{Key: "min_bars_before_stop", Label: "普通止损生效根数", Default: minBars, Min: 0, Max: 1000, Step: 1, Unit: "根", Help: "开仓后多少根入场周期 K 线之后普通止损才生效；之前只认应急止损和移动止盈"},
		{Key: "breakeven_trigger", Label: "保本触发", Default: be, Min: 0, Max: 100, Step: 0.1, Unit: "%", Help: "持仓最高浮盈达到这么多后，止损抬到成本价；0 不用"},
		{Key: "trail_arm", Label: "移动止盈启动", Default: arm, Min: 0, Max: 100, Step: 0.1, Unit: "%", Help: "持仓最高浮盈达到这么多后，止损跟着最高价走；0 不用"},
		{Key: "trail_giveback", Label: "移动止盈回撤", Default: give, Min: 0, Max: 100, Step: 0.1, Unit: "%", Help: "移动止盈启动后，从最高价回撤这么多就走"},
		{Key: "sell_gate", Label: "信号出场浮盈门槛", Default: gate, Min: -100, Max: 100, Step: 0.05, Unit: "%", Help: "卖出信号出现时，浮盈不到这么多就不理（止损止盈照常）；-100 表示有卖出信号就走"},
		{Key: "pyramid_first_pct", Label: "首笔仓位", Default: first, Min: 1, Max: 100, Step: 1, Unit: "%", Help: "开仓时先买分配资金的这么多（斥候仓），剩下的等浮盈到「加仓触发」或再有买入信号时补满；100 表示一次买满"},
		{Key: "pyramid_add_trigger", Label: "加仓触发", Default: trig, Min: 0, Max: 20, Step: 0.1, Unit: "%", Help: "斥候仓浮盈（相对首笔成交价）达到这么多就补满"},
	}
}

var builtinStrategies = []*BuiltinStrategy{
	{
		ID:   "kdj-short-1h3m",
		Name: "KDJ 1h 定趋势 + 3m 定买卖点",
		Desc: "1h KDJ 的 J 在超卖区且拐头向上定做多趋势；3m KDJ 超卖后 J 上穿 D（或 K≥D）、J 拐头、3m 收阳时买入。" +
			"3m KDJ 超买后 J 下穿 D（或 K≤D）、或近 7 根超买过且 K≤D、J>42 时出卖出信号，浮盈达到门槛才按信号卖。" +
			"出场另有固定止损止盈、开仓后前 20 根的应急止损、保本、移动止盈；开仓分斥候仓和加仓两笔。只做多，现货。",
		Source:        "autotrader script/strategy/strategy_kdj_short_1h3m.py + script/run/run_kdj_short_1h3m.py",
		TrendInterval: "1h", EntryInterval: "3m", TrendMode: trendPartial, Direction: "long",
		Symbols:  []string{"BINANCE:SOLUSDT", "BINANCE:ETHUSDT", "BINANCE:BTCUSDT"},
		StopLoss: 4.5, TakeProfit: 6.5, PositionPct: 100,
		Params: append([]BuiltinParam{
			{Key: "oversold", Label: "超卖线（J）", Default: 20, Min: 1, Max: 99, Step: 1, Help: "J 低于它算超卖，1h 和 3m 共用"},
			{Key: "overbought", Label: "超买线（J）", Default: 78, Min: 1, Max: 99, Step: 1, Help: "J 高于它算超买，1h 和 3m 共用"},
			{Key: "buy_need_j3_turn", Label: "3m 买点要 J 拐头", Default: 1, Min: 0, Max: 1, Step: 1, Help: "1：3m 的 J 比上一根高才买（同 autotrader 实盘）；0：不要求（同 autotrader 回测引擎的适配器）"},
			{Key: "sell_need_trend", Label: "卖出信号要 1h 超买", Default: 0, Min: 0, Max: 1, Step: 1, Help: "1：3m 卖出信号还要 1h J 超买且拐头向下；0：不要求（autotrader 扫参结论，实盘用 0）"},
			{Key: "kdj_n", Label: "KDJ 周期 N", Default: 9, Min: 2, Max: 100, Step: 1},
			{Key: "kdj_m1", Label: "KDJ 平滑 M1", Default: 3, Min: 1, Max: 50, Step: 1},
			{Key: "kdj_m2", Label: "KDJ 平滑 M2", Default: 3, Min: 1, Max: 50, Step: 1},
		}, exitParams(2.5, 20, 2, 2, 1, 2.25, 40, 0.5)...),
		WarmBars: 2000,
		signals:  kdjSignals,
	},
	{
		ID:   "supertrend-adx-1h3m",
		Name: "SuperTrend + ADX 1h 定方向 + 3m 翻多入场",
		Desc: "1h SuperTrend 向上时，3m SuperTrend 由空翻多且 3m ADX 高于阈值买入；3m SuperTrend 由多翻空卖出。" +
			"不设止盈，只留固定止损（开仓 20 根后生效）；开仓分斥候仓和加仓两笔。只做多。",
		Source:        "autotrader script/strategy/strategy_supertrend_adx_1h3m.py + script/run/run_supertrend_hl_1h3m.py",
		TrendInterval: "1h", EntryInterval: "3m", TrendMode: trendClosed, Direction: "long",
		Symbols:  []string{"BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT"},
		StopLoss: 4.5, TakeProfit: 0, PositionPct: 100,
		Params: append([]BuiltinParam{
			{Key: "st_period", Label: "SuperTrend 周期", Default: 14, Min: 2, Max: 100, Step: 1, Help: "1h 和 3m 共用"},
			{Key: "st_mult", Label: "SuperTrend 倍数", Default: 3.5, Min: 0.5, Max: 10, Step: 0.1, Help: "ATR 的倍数，1h 和 3m 共用"},
			{Key: "adx_n", Label: "ADX 周期", Default: 14, Min: 2, Max: 100, Step: 1},
			{Key: "adx_threshold", Label: "ADX 阈值", Default: 20, Min: 0, Max: 100, Step: 1, Help: "3m ADX 高于它才算趋势够强（autotrader 实盘 20，回测稳健档 25）"},
		}, exitParams(0, 20, 0, 0, 0, -100, 40, 0.5)...),
		WarmBars: 2000,
		signals:  supertrendSignals,
	},
}

// builtinOf 按 id 找内置策略。
func builtinOf(id string) (*BuiltinStrategy, bool) {
	for _, b := range builtinStrategies {
		if b.ID == id {
			return b, true
		}
	}
	return nil, false
}

// defaults 是参数默认值，顺序同 Params。
func (b *BuiltinStrategy) defaults() Params {
	out := Params{}
	for _, p := range b.Params {
		out = append(out, Param{p.Key, p.Default})
	}
	return out
}

// fill 按参数表的顺序补默认值；不认识的键、越界的值报错。
func (b *BuiltinStrategy) fill(ps Params) (Params, error) {
	var errs []string
	for _, p := range ps {
		if !b.has(p.Key) && !isReserved(p.Key) {
			errs = append(errs, "参数 "+p.Key+" 不是「"+b.Name+"」的参数")
		}
	}
	out := Params{}
	for _, d := range b.Params {
		v, ok := ps.Get(d.Key)
		if !ok {
			v = d.Default
		}
		if !finite(v) || v < d.Min || v > d.Max {
			errs = append(errs, fmt.Sprintf("参数 %s（%s）要在 %s 到 %s 之间", d.Key, d.Label, numStr(d.Min), numStr(d.Max)))
		}
		out = append(out, Param{d.Key, v})
	}
	if len(errs) > 0 {
		return nil, errors.New(strings.Join(errs, "；"))
	}
	return out, nil
}

// check 只查范围（回测配置、部署覆盖用）：键要认识，值在范围内。
func (b *BuiltinStrategy) check(ps Params) error {
	var errs []string
	for _, p := range ps {
		if isReserved(p.Key) {
			continue
		}
		d, ok := b.param(p.Key)
		if !ok {
			errs = append(errs, "参数 "+p.Key+" 不是「"+b.Name+"」的参数")
			continue
		}
		if !finite(p.Value) || p.Value < d.Min || p.Value > d.Max {
			errs = append(errs, fmt.Sprintf("参数 %s（%s）要在 %s 到 %s 之间", d.Key, d.Label, numStr(d.Min), numStr(d.Max)))
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "；"))
	}
	return nil
}

func (b *BuiltinStrategy) has(k string) bool { _, ok := b.param(k); return ok }

func (b *BuiltinStrategy) param(k string) (BuiltinParam, bool) {
	for _, p := range b.Params {
		if p.Key == k {
			return p, true
		}
	}
	return BuiltinParam{}, false
}

func isReserved(k string) bool {
	for _, r := range ReservedParams {
		if r == k {
			return true
		}
	}
	return false
}

// pget 取参数，没有用内置默认。
func (b *BuiltinStrategy) pget(ps Params, k string) float64 {
	if v, ok := ps.Get(k); ok && finite(v) {
		return v
	}
	d, _ := b.param(k)
	return d.Default
}

func timeMs(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func ipar(v float64, lo int) int { return max(lo, int(jsRound(v))) }

// builtinSignals 算 bs 每一根收盘时的买卖信号；mode 为空时用策略自己的趋势口径。
func builtinSignals(b *BuiltinStrategy, ps Params, bs []Bar, mode string) builtinSig {
	if mode == "" {
		mode = b.TrendMode
	}
	return b.signals(b, ps, bs, mode)
}

// ---------- KDJ 1h + 3m ----------

// kdjSignals 逐行对照 strategy_kdj_short_1h3m.compute_signals：每根 3m 收盘时，3m 用截至这一根的 K 线，
// 1h 用聚合出来的 1h（口径见 mode），两边都要至少 20 根才出信号（同 klines_to_kdj 的门槛）。
func kdjSignals(b *BuiltinStrategy, ps Params, bs []Bar, mode string) builtinSig {
	n, m1, m2 := ipar(b.pget(ps, "kdj_n"), 2), ipar(b.pget(ps, "kdj_m1"), 1), ipar(b.pget(ps, "kdj_m2"), 1)
	os, ob := b.pget(ps, "oversold"), b.pget(ps, "overbought")
	needTurn, needTrend := b.pget(ps, "buy_need_j3_turn") >= 0.5, b.pget(ps, "sell_need_trend") >= 0.5
	sig := builtinSig{buy: make([]bool, len(bs)), sell: make([]bool, len(bs))}
	if len(bs) == 0 {
		return sig
	}
	k3 := kdjSeries(bs, n, m1, m2)
	m := newMTF(bs, b.TrendInterval)
	gh, gl, gc := hlc(m.groups)
	gk, gd := kdjRaw(gh, gl, gc, n, m1, m2)
	a1, a2 := 2/float64(2*m1), 2/float64(2*m2)
	nan := math.IsNaN
	for i := range bs {
		g := m.gi[i]
		// 1h：cur 是「最后一根」、prev 是倒数第二根，cnt 是 1h 的根数
		var cur, prev kdjVals
		cnt := 0
		switch mode {
		case trendLookahead:
			cnt = g + 1
			cur = kdjOf(gk[g], gd[g])
			if g > 0 {
				prev = kdjOf(gk[g-1], gd[g-1])
			}
		case trendClosed:
			c := m.lastClosed(bs, i, Intervals[b.EntryInterval].Milliseconds())
			cnt = c + 1
			if c >= 0 {
				cur = kdjOf(gk[c], gd[c])
			}
			if c > 0 {
				prev = kdjOf(gk[c-1], gd[c-1])
			}
		default: // partial：前面整根 + 当前这根截至 i
			cnt = g + 1
			p := m.partial(bs, i)
			hh, ll := p.H, p.L
			rsv := math.NaN()
			if g+1 >= n {
				for k := g - n + 1; k < g; k++ {
					hh, ll = math.Max(hh, gh[k]), math.Min(ll, gl[k])
				}
				if hh != ll {
					rsv = (p.C - ll) / (hh - ll) * 100
				}
			}
			pk, pd := math.NaN(), math.NaN()
			if g > 0 {
				pk, pd = gk[g-1], gd[g-1]
				prev = kdjOf(pk, pd)
			}
			kk := ewmStep(pk, rsv, a1)
			cur = kdjOf(kk, ewmStep(pd, kk, a2))
		}
		if i+1 < 20 || cnt < 20 || i < 1 {
			continue
		}
		x := k3[i]
		if nan(x.J) || nan(cur.J) {
			continue
		}
		hasPrev := cnt >= 2
		turnedUp := !hasPrev || (!nan(prev.J) && !nan(cur.J) && (cur.J >= prev.J || cur.J < 15))
		turnedDown := !hasPrev || (!nan(prev.J) && !nan(cur.J) && (cur.J <= prev.J || cur.J > 85))
		trendBuy := cur.J < os && turnedUp
		trendSell := cur.J > ob && turnedDown

		y := k3[i-1]
		crossUp := !nan(y.J) && !nan(y.D) && !nan(x.D) && y.J <= y.D && x.J > x.D
		crossDown := !nan(y.J) && !nan(y.D) && !nan(x.D) && y.J >= y.D && x.J < x.D
		recent := func(f func(float64) bool) bool {
			for k := max(0, i-6); k <= i; k++ {
				if v := k3[k].J; !nan(v) && f(v) {
					return true
				}
			}
			return false
		}
		kOK := !nan(x.K) && x.K >= x.D
		jTurn := !nan(y.J) && x.J > y.J
		buy3 := (x.J < os && (crossUp || kOK)) ||
			(recent(func(v float64) bool { return v < os }) && kOK && x.J < 58 && crossUp)
		if needTurn {
			buy3 = buy3 && jTurn
		}
		kSell := !nan(x.K) && x.K <= x.D
		sell3 := (x.J > ob && (crossDown || kSell)) ||
			(recent(func(v float64) bool { return v > ob }) && kSell && x.J > 42)
		candleUp := bs[i].C > bs[i-1].C
		sig.buy[i] = trendBuy && buy3 && candleUp
		// 买卖各算各的（同 compute_signals）：持仓时先看卖，空仓时才看买。sell_need_trend=1 时两者互斥（1h 超卖、超买不会同时成立），
		// 这时和 autotrader 适配器「先判买、再判卖」的结果一样
		sig.sell[i] = sell3 && (!needTrend || trendSell)
	}
	return sig
}

// ---------- SuperTrend + ADX 1h + 3m ----------

// supertrendSignals 同 backtest_supertrend_adx_1h3m._compute_signals：1h 用已收盘的那根（mode 可改）。
func supertrendSignals(b *BuiltinStrategy, ps Params, bs []Bar, mode string) builtinSig {
	period, mult := ipar(b.pget(ps, "st_period"), 2), b.pget(ps, "st_mult")
	adxN, thr := ipar(b.pget(ps, "adx_n"), 2), b.pget(ps, "adx_threshold")
	sig := builtinSig{buy: make([]bool, len(bs)), sell: make([]bool, len(bs))}
	if len(bs) == 0 {
		return sig
	}
	d3 := supertrendDir(bs, period, mult)
	adx := adxWilder(bs, adxN)
	m := newMTF(bs, b.TrendInterval)
	d1 := supertrendDir(m.groups, period, mult)
	entryMs := Intervals[b.EntryInterval].Milliseconds()
	start := max(36, 2*adxN+2, period+2)
	for i := start; i < len(bs); i++ {
		var up bool
		switch mode {
		case trendLookahead:
			up = d1[m.gi[i]] == 1
		case trendPartial:
			// 未收盘的那根：方向按截至 i 的部分重算一根
			g := m.gi[i]
			gs := append(append([]Bar{}, m.groups[:g]...), m.partial(bs, i))
			dd := supertrendDir(gs, period, mult)
			up = dd[len(dd)-1] == 1
		default:
			c := m.lastClosed(bs, i, entryMs)
			up = c >= 0 && d1[c] == 1
		}
		flipUp := d3[i] == 1 && d3[i-1] == -1
		flipDown := d3[i] == -1 && d3[i-1] == 1
		sig.buy[i] = up && flipUp && finite(adx[i]) && adx[i] > thr
		sig.sell[i] = flipDown
	}
	return sig
}

// GET /api/trade/strategy-builtins：内置策略目录。
func (h *handlers) listBuiltins(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": builtinStrategies, "meta": map[string]int{"total": len(builtinStrategies)}})
}
