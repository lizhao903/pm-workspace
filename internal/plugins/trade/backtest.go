// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 回测引擎（TRD-04a）：纯函数，逐行移植原型 web-next/src/backtest.ts，结果和原型对拍（testdata/backtest_golden.json）。
// 约定同原型：
// 1. 信号在 K 线收盘时评估，按收盘价加减滑点成交；止损止盈在下一根 K 线内按最高最低价触发
// 2. 参数覆盖：规则里某个指标的第一个参数或某个数值，等于 strategy.params 里某个键的值时，回测用 cfg.params 的同名值替换；
//    多个键值相同时取先出现的那个
// 3. cfg.params 里的 stop_loss、take_profit、position_pct 三个保留键覆盖策略同名字段，扫参时可以直接扫
// 4. 年化按自然时间算：一年 = 365 天 / K 线周期
// 代码模式不执行源码，只按 CodeKindOf 认成网格、期现基差、双均线三类内置近似。
// 浮点运算的先后顺序和原型一致，改的时候别顺手合并或调换。

// ReservedParams 是三个覆盖策略字段的保留参数键。
var ReservedParams = []string{"stop_loss", "take_profit", "position_pct"}

const yearMs = 365 * 86400000.0

// Bar 是回测用的 K 线，T 是开盘时刻的毫秒时间戳。
type Bar struct {
	T int64   `json:"t"`
	O float64 `json:"o"`
	H float64 `json:"h"`
	L float64 `json:"l"`
	C float64 `json:"c"`
	V float64 `json:"v"`
}

// BarsOf 把行情源的 K 线转成回测用的。
func BarsOf(ks []Kline) []Bar {
	out := make([]Bar, len(ks))
	for i, k := range ks {
		out[i] = Bar{T: k.Time.UnixMilli(), O: k.Open, H: k.High, L: k.Low, C: k.Close, V: k.Volume}
	}
	return out
}

// BacktestData 是回测要的外部数据，由调用方给：
// Instrument 查标的（乘数、最小下单量、精度、品种、对应现货），Bars 取截至回测截止时刻的最近 count 根 K 线（按时间升序，
// 不够就有多少给多少）。同一次回测或扫参里同样的参数只会取一次。
type BacktestData struct {
	Instrument func(symbol string) (Instrument, bool)
	Bars       func(symbol, interval string, count int) []Bar
}

/* ---------- JS 数值语义 ---------- */

// jsRound 同 Math.round：0.5 向正无穷进位。
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// roundTo 同原型 tradedata 的 round。
func roundTo(x float64, d int) float64 {
	p := math.Pow(10, float64(d))
	return jsRound(x*p) / p
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

func sign(x float64) float64 {
	switch {
	case x > 0:
		return 1
	case x < 0:
		return -1
	}
	return 0
}

// toFixed 同 Number.prototype.toFixed：负数先记符号取绝对值，按精确十进制值取最近，正好一半时进位。
func toFixed(x float64, d int) string {
	if !finite(x) {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	neg := x < 0
	s := new(big.Float).SetFloat64(math.Abs(x)).Text('f', 1100)
	ip, fp, _ := strings.Cut(s, ".")
	fp += strings.Repeat("0", d+1)
	n, _ := new(big.Int).SetString(ip+fp[:d], 10)
	if fp[d] >= '5' {
		n.Add(n, big.NewInt(1))
	}
	t := n.String()
	if len(t) <= d {
		t = strings.Repeat("0", d-len(t)+1) + t
	}
	if d > 0 {
		t = t[:len(t)-d] + "." + t[len(t)-d:]
	}
	if neg {
		t = "-" + t
	}
	return t
}

// numStr 同 JS 把数字转字符串（整数不带小数点）。
func numStr(x float64) string { return strconv.FormatFloat(x, 'f', -1, 64) }

/* ---------- 指标 ---------- */

func nans(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = math.NaN()
	}
	return out
}

func sma(xs []float64, n int) []float64 {
	out := nans(len(xs))
	if n < 1 {
		return out
	}
	sum, cnt := 0.0, 0
	for i, x := range xs {
		if math.IsNaN(x) {
			sum, cnt = 0, 0
			continue
		}
		sum += x
		cnt++
		if cnt > n {
			sum -= xs[i-n]
			cnt = n
		}
		if cnt == n {
			out[i] = sum / float64(n)
		}
	}
	return out
}

// ema 跳过前面的 NaN，用前 n 个值的均值做种子。
func ema(xs []float64, n int) []float64 {
	out := nans(len(xs))
	if n < 1 {
		return out
	}
	k := 2 / float64(n+1)
	start := -1
	for i, x := range xs {
		if !math.IsNaN(x) {
			start = i
			break
		}
	}
	if start < 0 || start+n > len(xs) {
		return out
	}
	v := 0.0
	for i := start; i < start+n; i++ {
		v += xs[i]
	}
	v /= float64(n)
	start += n - 1
	out[start] = v
	for i := start + 1; i < len(xs); i++ {
		v = xs[i]*k + v*(1-k)
		out[i] = v
	}
	return out
}

// wilder 是 Wilder 平滑，RSI、ATR 用。
func wilder(xs []float64, n, from int) []float64 {
	out := nans(len(xs))
	if n < 1 || from+n > len(xs) {
		return out
	}
	v := 0.0
	for i := from; i < from+n; i++ {
		v += xs[i]
	}
	v /= float64(n)
	out[from+n-1] = v
	for i := from + n; i < len(xs); i++ {
		v = (v*float64(n-1) + xs[i]) / float64(n)
		out[i] = v
	}
	return out
}

func stdev(xs []float64, n int) []float64 {
	m := sma(xs, n)
	out := make([]float64, len(xs))
	for i := range xs {
		if math.IsNaN(m[i]) {
			out[i] = math.NaN()
			continue
		}
		s := 0.0
		for j := i - n + 1; j <= i; j++ {
			d := xs[j] - m[i]
			s += d * d
		}
		out[i] = math.Sqrt(s / float64(n))
	}
	return out
}

// period 取指标第 i 个参数，取整、至少 1，没有用默认值。
func period(ps []float64, i int, d float64) int {
	x := d
	if i < len(ps) && finite(ps[i]) {
		x = ps[i]
	}
	return int(math.Max(1, jsRound(x)))
}

// Series 按操作数对 K 线算出与 bars 等长的序列，前面不够周期的是 NaN。
func Series(op Operand, bs []Bar) []float64 {
	if op.Kind == "num" {
		out := make([]float64, len(bs))
		for i := range out {
			out[i] = op.Value
		}
		return out
	}
	c := make([]float64, len(bs))
	for i, b := range bs {
		c[i] = b.C
	}
	ps := op.Params
	switch op.Ind {
	case "price":
		return c
	case "volume":
		out := make([]float64, len(bs))
		for i, b := range bs {
			out[i] = b.V
		}
		return out
	case "ma":
		return sma(c, period(ps, 0, 20))
	case "ema":
		return ema(c, period(ps, 0, 20))
	case "rsi":
		n := period(ps, 0, 14)
		up, dn := make([]float64, len(c)), make([]float64, len(c))
		for i := 1; i < len(c); i++ {
			up[i] = math.Max(c[i]-c[i-1], 0)
			dn[i] = math.Max(c[i-1]-c[i], 0)
		}
		au, ad := wilder(up, n, 1), wilder(dn, n, 1)
		out := make([]float64, len(c))
		for i := range c {
			switch {
			case math.IsNaN(au[i]):
				out[i] = math.NaN()
			case ad[i] == 0:
				out[i] = 100
			default:
				out[i] = 100 - 100/(1+au[i]/ad[i])
			}
		}
		return out
	case "macd":
		f, s := ema(c, period(ps, 0, 12)), ema(c, period(ps, 1, 26))
		line := make([]float64, len(c))
		for i := range c {
			line[i] = f[i] - s[i]
		}
		sig := ema(line, period(ps, 2, 9))
		out := make([]float64, len(c))
		for i := range line {
			out[i] = line[i] - sig[i]
		}
		return out
	case "boll_up", "boll_low":
		n := period(ps, 0, 20)
		k := 2.0
		if len(ps) > 1 && finite(ps[1]) {
			k = ps[1]
		}
		m, sd := sma(c, n), stdev(c, n)
		out := make([]float64, len(c))
		for i := range m {
			if op.Ind == "boll_up" {
				out[i] = m[i] + k*sd[i]
			} else {
				out[i] = m[i] - k*sd[i]
			}
		}
		return out
	case "atr":
		tr := make([]float64, len(bs))
		for i, b := range bs {
			if i == 0 {
				tr[i] = b.H - b.L
				continue
			}
			tr[i] = math.Max(b.H-b.L, math.Max(math.Abs(b.H-bs[i-1].C), math.Abs(b.L-bs[i-1].C)))
		}
		return wilder(tr, period(ps, 0, 14), 0)
	}
	return nans(len(bs))
}

// warmOf 是指标需要多少根 K 线预热。
func warmOf(op Operand) int {
	if op.Kind == "num" {
		return 0
	}
	ps := op.Params
	switch op.Ind {
	case "ema":
		return period(ps, 0, 20) * 3
	case "macd":
		return (period(ps, 1, 26) + period(ps, 2, 9)) * 3
	case "rsi", "atr":
		return period(ps, 0, 14) * 3
	case "ma", "boll_up", "boll_low":
		return period(ps, 0, 20)
	}
	return 0
}

/* ---------- 参数替换 ---------- */

// ApplyParams 按约定 2 把规则里的周期、数值换成 over 里的值，返回新的入场、出场规则组。
func ApplyParams(st Strategy, over Params) (RuleGroup, RuleGroup) {
	swap := func(v float64) float64 {
		for _, p := range st.Params {
			if p.Value == v {
				if o, ok := over.Get(p.Key); ok && finite(o) {
					return o
				}
				return v
			}
		}
		return v
	}
	opnd := func(o Operand) Operand {
		if o.Kind == "num" {
			return Num(swap(o.Value))
		}
		if len(o.Params) == 0 {
			return o
		}
		ps := append([]float64{swap(o.Params[0])}, o.Params[1:]...)
		return Operand{Kind: o.Kind, Ind: o.Ind, Params: ps}
	}
	grp := func(g RuleGroup) RuleGroup {
		rs := make([]Rule, len(g.Rules))
		for i, r := range g.Rules {
			rs[i] = Rule{ID: r.ID, Left: opnd(r.Left), Op: r.Op, Right: opnd(r.Right)}
		}
		return RuleGroup{Logic: g.Logic, Rules: rs}
	}
	return grp(st.Entry), grp(st.Exit)
}

/* ---------- 说明：按出现顺序去重 ---------- */

type notes struct{ xs []string }

func (n *notes) add(s string) {
	for _, x := range n.xs {
		if x == s {
			return
		}
	}
	n.xs = append(n.xs, s)
}

/* ---------- 账本：按均价记持仓，减仓时结算盈亏 ---------- */

type book struct {
	cash    float64
	qty     float64
	avg     float64
	openFee float64 // 这一笔持仓累计的开仓手续费，平仓时并进盈亏
	trades  []BacktestTrade
	symbol  string
	mult    float64
	feeRate float64
	slip    float64
	digits  int
}

func newBook(cash float64, symbol string, in Instrument, ok bool, cfg BacktestConfig) *book {
	mult, digits := 1.0, 2
	if ok {
		mult, digits = in.Multiplier, in.Digits
	}
	return &book{cash: cash, symbol: symbol, mult: mult, feeRate: cfg.FeeBp / 10000, slip: cfg.SlippageTicks * math.Pow(10, -float64(digits)), digits: digits, trades: []BacktestTrade{}}
}

func (b *book) equity(px float64) float64 { return b.cash + b.qty*px*b.mult }

// trade：dq 带符号，正买负卖；px 是未加滑点的参考价。
func (b *book) trade(dq, px float64, t int64, reason string) {
	if dq == 0 || !finite(dq) {
		return
	}
	slip := -b.slip
	if dq > 0 {
		slip = b.slip
	}
	fill := math.Max(px+slip, 0)
	fee := math.Abs(dq) * fill * b.mult * b.feeRate
	b.cash -= dq*fill*b.mult + fee
	reducing := b.qty != 0 && sign(dq) != sign(b.qty)
	var pnl *float64
	if reducing {
		closed := math.Min(math.Abs(dq), math.Abs(b.qty))
		share := closed / math.Abs(b.qty)
		feePart := b.openFee * share
		v := (fill-b.avg)*closed*sign(b.qty)*b.mult - fee*(closed/math.Abs(dq)) - feePart
		pnl = &v
		b.openFee -= feePart
		rest := math.Abs(dq) - closed
		nq := b.qty + dq
		if math.Abs(nq) < 1e-12 {
			b.qty, b.avg, b.openFee = 0, 0, 0
		} else if rest > 0 {
			b.qty, b.avg, b.openFee = nq, fill, fee*(rest/math.Abs(dq))
		} else {
			b.qty = nq
		}
	} else {
		b.avg = (b.avg*math.Abs(b.qty) + fill*math.Abs(dq)) / (math.Abs(b.qty) + math.Abs(dq))
		b.qty += dq
		b.openFee += fee
	}
	side := "sell"
	if dq > 0 {
		side = "buy"
	}
	tr := BacktestTrade{T: t, Symbol: b.symbol, Side: side, Price: roundTo(fill, b.digits+2), Qty: roundTo(math.Abs(dq), 8), Reason: reason}
	if pnl != nil {
		r := roundTo(*pnl, 2)
		tr.PnL = &r
	}
	b.trades = append(b.trades, tr)
}

/* ---------- 单标的模拟 ---------- */

type btCtx struct {
	cfg  BacktestConfig
	st   Strategy
	data BacktestData
	load func(symbol string, count int) []Bar
}

type leg struct {
	equity, bench []float64
	t             []int64
	trades        []BacktestTrade
}

func numOf(ps Params, k string, d float64) float64 {
	if v, ok := ps.Get(k); ok && finite(v) {
		return v
	}
	return d
}

// sizeOf 是下单数量：按最小下单量向下取整；不够一手时按可分割数量模拟，并记一条说明。
func (c *btCtx) sizeOf(value, px float64, symbol string, ns *notes) float64 {
	in, ok := c.data.Instrument(symbol)
	mult, lot, name := 1.0, 1.0, symbol
	if ok {
		mult, lot, name = in.Multiplier, in.Lot, in.Name
	}
	raw := value / (px * mult)
	q := math.Floor(raw/lot+1e-9) * lot
	if q > 0 {
		return roundTo(q, 10)
	}
	if raw > 0 {
		ns.add(name + " 资金不足一手，按可分割数量模拟")
	}
	return raw
}

func evalGroup(g RuleGroup, sv [][2][]float64, i int) bool {
	if len(g.Rules) == 0 {
		return false
	}
	one := func(k int) bool {
		a, b := sv[k][0], sv[k][1]
		x, y := a[i], b[i]
		if math.IsNaN(x) || math.IsNaN(y) {
			return false
		}
		switch g.Rules[k].Op {
		case "gt":
			return x > y
		case "lt":
			return x < y
		}
		if i < 1 || math.IsNaN(a[i-1]) || math.IsNaN(b[i-1]) {
			return false
		}
		x0, y0 := a[i-1], b[i-1]
		if g.Rules[k].Op == "cross_up" {
			return x0 <= y0 && x > y
		}
		return x0 >= y0 && x < y
	}
	for k := range g.Rules {
		hit := one(k)
		if g.Logic == "all" && !hit {
			return false
		}
		if g.Logic != "all" && hit {
			return true
		}
	}
	return g.Logic == "all"
}

func (c *btCtx) runRulesLeg(symbol string, cash float64, ns *notes) leg {
	cfg, st := c.cfg, c.st
	entry, exit := ApplyParams(st, cfg.Params)
	warm := 0
	for _, r := range append(append([]Rule{}, entry.Rules...), exit.Rules...) {
		warm = max(warm, warmOf(r.Left), warmOf(r.Right))
	}
	warm = min(600, warm)
	bs := c.load(symbol, cfg.Bars+warm)
	series := func(g RuleGroup) [][2][]float64 {
		out := make([][2][]float64, len(g.Rules))
		for i, r := range g.Rules {
			out[i] = [2][]float64{Series(r.Left, bs), Series(r.Right, bs)}
		}
		return out
	}
	sve, svx := series(entry), series(exit)
	in, ok := c.data.Instrument(symbol)
	bk := newBook(cash, symbol, in, ok, cfg)
	sl := numOf(cfg.Params, "stop_loss", st.StopLoss) / 100
	tp := numOf(cfg.Params, "take_profit", st.TakeProfit) / 100
	pct := numOf(cfg.Params, "position_pct", st.PositionPct) / 100
	first := len(bs) - cfg.Bars
	from := max(first, 0)
	p0 := 1.0
	if from < len(bs) {
		p0 = bs[from].C
	}
	open := func(side float64, b Bar, reason string) {
		bk.trade(side*c.sizeOf(bk.equity(b.C)*pct, b.C, symbol, ns), b.C, b.T, reason)
	}
	var lg leg
	for i := from; i < len(bs); i++ {
		b := bs[i]
		last := i == len(bs)-1
		if i > first {
			// 止损止盈：按本根 K 线最高最低价判断
			if bk.qty != 0 && (sl > 0 || tp > 0) {
				dir := sign(bk.qty)
				stopPx := bk.avg * (1 - dir*sl)
				takePx := bk.avg * (1 + dir*tp)
				if sl > 0 && ((dir > 0 && b.L <= stopPx) || (dir < 0 && b.H >= stopPx)) {
					px := math.Max(stopPx, b.O)
					if dir > 0 {
						px = math.Min(stopPx, b.O)
					}
					bk.trade(-bk.qty, px, b.T, "止损 "+toFixed(sl*100, 1)+"%")
				} else if tp > 0 && ((dir > 0 && b.H >= takePx) || (dir < 0 && b.L <= takePx)) {
					px := math.Min(takePx, b.O)
					if dir > 0 {
						px = math.Max(takePx, b.O)
					}
					bk.trade(-bk.qty, px, b.T, "止盈 "+toFixed(tp*100, 1)+"%")
				}
			}
			if !last {
				en := evalGroup(entry, sve, i)
				ex := evalGroup(exit, svx, i)
				switch st.Direction {
				case "long":
					if bk.qty > 0 && ex {
						bk.trade(-bk.qty, b.C, b.T, "出场信号")
					} else if bk.qty == 0 && en {
						open(1, b, "入场信号")
					}
				case "short":
					if bk.qty < 0 && ex {
						bk.trade(-bk.qty, b.C, b.T, "出场信号")
					} else if bk.qty == 0 && en {
						open(-1, b, "入场信号")
					}
				default:
					// 多空双向：入场信号做多（有空单先平），出场信号做空（有多单先平）
					if en && bk.qty <= 0 {
						if bk.qty < 0 {
							bk.trade(-bk.qty, b.C, b.T, "反手平空")
						}
						open(1, b, "入场信号做多")
					} else if ex && bk.qty >= 0 {
						if bk.qty > 0 {
							bk.trade(-bk.qty, b.C, b.T, "反手平多")
						}
						open(-1, b, "出场信号做空")
					}
				}
			}
		}
		if last && bk.qty != 0 {
			bk.trade(-bk.qty, b.C, b.T, "回测结束平仓")
		}
		lg.t = append(lg.t, b.T)
		lg.equity = append(lg.equity, bk.equity(b.C))
		lg.bench = append(lg.bench, (cash*b.C)/p0)
	}
	lg.trades = bk.trades
	return lg
}

// runGridLeg 是网格近似：区间等分，目标仓位 = (格数/2 - 当前格) × 每格数量。
func (c *btCtx) runGridLeg(symbol string, cash float64, ns *notes) leg {
	cfg, st := c.cfg, c.st
	prm := st.Params.Merge(cfg.Params)
	bs := c.load(symbol, cfg.Bars)
	in, ok := c.data.Instrument(symbol)
	bk := newBook(cash, symbol, in, ok, cfg)
	mult := 1.0
	if ok {
		mult = in.Multiplier
	}
	p0 := 1.0
	if len(bs) > 0 {
		p0 = bs[0].C
	}
	lower, upper := numOf(prm, "lower", p0*0.92), numOf(prm, "upper", p0*1.08)
	if !(upper > lower) || p0 < lower || p0 > upper {
		ns.add("首根价格不在网格区间内，近似按首根价格上下 8% 重设区间")
		lower, upper = p0*0.92, p0*1.08
	}
	grids := math.Max(2, jsRound(numOf(prm, "grids", 20)))
	step := (upper - lower) / grids
	pct := numOf(cfg.Params, "position_pct", st.PositionPct) / 100
	// 每格数量：有 qty 用 qty，但不让满仓超过分配资金 × 仓位比例
	cp := (cash * pct) / (grids / 2) / (p0 * mult)
	unit := math.Min(numOf(prm, "qty", cp), cp)
	sl := numOf(cfg.Params, "stop_loss", st.StopLoss) / 100
	var lg leg
	halted := false
	for i, b := range bs {
		last := i == len(bs)-1
		if !halted && !last {
			level := math.Max(0, math.Min(grids, math.Floor((b.C-lower)/step)))
			target := (grids/2 - level) * unit
			if st.Direction == "long" {
				target = math.Max(target, 0)
			}
			if st.Direction == "short" {
				target = math.Min(target, 0)
			}
			dq := target - bk.qty
			if math.Abs(dq) > unit*0.5 {
				bk.trade(dq, b.C, b.T, "网格第 "+numStr(level)+" 格")
			}
			if sl > 0 && bk.equity(b.C) < cash*(1-sl) {
				bk.trade(-bk.qty, b.C, b.T, "亏损超过 "+toFixed(sl*100, 0)+"% 停止网格")
				halted = true
			}
		}
		if last && bk.qty != 0 {
			bk.trade(-bk.qty, b.C, b.T, "回测结束平仓")
		}
		lg.t = append(lg.t, b.T)
		lg.equity = append(lg.equity, bk.equity(b.C))
		lg.bench = append(lg.bench, (cash*b.C)/p0)
	}
	lg.trades = bk.trades
	return lg
}

// runBasis 是期现基差近似：用「期货折算价相对现货 60 根均值的偏离」代替基差；
// 低于 -open_bp 买期货卖现货，回到 -close_bp 以上平仓。
func (c *btCtx) runBasis(fut, spot string, cash float64, ns *notes) leg {
	cfg, st := c.cfg, c.st
	prm := st.Params.Merge(cfg.Params)
	fb, sb := c.load(fut, cfg.Bars), c.load(spot, cfg.Bars)
	n := min(len(fb), len(sb))
	fi, fok := c.data.Instrument(fut)
	si, sok := c.data.Instrument(spot)
	fBook := newBook(cash/2, fut, fi, fok, cfg)
	sBook := newBook(cash/2, spot, si, sok, cfg)
	var lg leg
	if n == 0 {
		lg.trades = []BacktestTrade{}
		return lg
	}
	// 期货价 / 现货价的初始比例，IF 对 300ETF 约 1000
	ratio := fb[0].C / sb[0].C
	sc := make([]float64, len(sb))
	for i, b := range sb {
		sc[i] = b.C
	}
	fair := sma(sc, 60)
	openBp, closeBp := numOf(prm, "open_bp", 40), numOf(prm, "close_bp", 10)
	pct := numOf(cfg.Params, "position_pct", st.PositionPct) / 100
	ns.add("模拟行情里期货与现货同源，基差近似为期货折算价相对现货 60 根均值的偏离")
	for i := 0; i < n; i++ {
		f, s := fb[i], sb[i]
		last := i == n-1
		basis := math.NaN()
		if !math.IsNaN(fair[i]) {
			basis = ((f.C/ratio - fair[i]) / fair[i]) * 10000
		}
		holding := fBook.qty != 0
		if !last && !math.IsNaN(basis) {
			if !holding && basis < -openBp {
				value := cash * pct / 2
				fBook.trade(c.sizeOf(value, f.C, fut, ns), f.C, f.T, "基差 "+toFixed(basis, 0)+"bp 开仓买期货")
				sBook.trade(-c.sizeOf(value, s.C, spot, ns), s.C, s.T, "基差 "+toFixed(basis, 0)+"bp 卖现货对冲")
			} else if holding && basis > -closeBp {
				fBook.trade(-fBook.qty, f.C, f.T, "基差回到 "+toFixed(basis, 0)+"bp 平仓")
				sBook.trade(-sBook.qty, s.C, s.T, "基差回到 "+toFixed(basis, 0)+"bp 平仓")
			}
		}
		if last && holding {
			fBook.trade(-fBook.qty, f.C, f.T, "回测结束平仓")
			sBook.trade(-sBook.qty, s.C, s.T, "回测结束平仓")
		}
		lg.t = append(lg.t, f.T)
		lg.equity = append(lg.equity, fBook.equity(f.C)+sBook.equity(s.C))
		lg.bench = append(lg.bench, (cash/2)*(f.C/fb[0].C)+(cash/2)*(s.C/sb[0].C))
	}
	lg.trades = sortTrades(append(append([]BacktestTrade{}, fBook.trades...), sBook.trades...))
	return lg
}

func sortTrades(ts []BacktestTrade) []BacktestTrade {
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].T < ts[j].T })
	return ts
}

// fallbackMa：认不出的代码策略退回双均线，参数取 fast、slow，没有就 12、48。
func fallbackMa(st Strategy, cfg BacktestConfig) Strategy {
	prm := st.Params.Merge(cfg.Params)
	f, s := jsRound(numOf(prm, "fast", 12)), jsRound(numOf(prm, "slow", 48))
	out := st
	out.Mode, out.Params = "rules", Params{}
	out.Entry = RuleGroup{Logic: "all", Rules: []Rule{{ID: "fa", Left: Ind("ema", f), Op: "cross_up", Right: Ind("ema", s)}}}
	out.Exit = RuleGroup{Logic: "any", Rules: []Rule{{ID: "fb", Left: Ind("ema", f), Op: "cross_down", Right: Ind("ema", s)}}}
	return out
}

// 代码策略的三类内置近似
const (
	CodeGrid  = "grid"
	CodeBasis = "basis"
	CodeMa    = "ma"
)

// CodeKindLabel 是三类近似的显示名，同原型 CODE_KIND_LABEL。
var CodeKindLabel = map[string]string{CodeGrid: "网格", CodeBasis: "期现基差", CodeMa: "未识别，按双均线"}

var (
	gridRe  = regexp.MustCompile(`(?i)网格|grid`)
	basisRe = regexp.MustCompile(`(?i)基差|期现|basis`)
)

// CodeKindOf 按名字、源码、参数认代码策略是哪种内置近似；源码只做文本匹配，不执行。
func CodeKindOf(st Strategy) string {
	txt := st.Name + " " + st.Code
	if st.Params.Has("grids") || gridRe.MatchString(txt) {
		return CodeGrid
	}
	if st.Params.Has("open_bp") || basisRe.MatchString(txt) {
		return CodeBasis
	}
	return CodeMa
}

/* ---------- 统计 ---------- */

func statsOf(equity, bench []float64, trades []BacktestTrade, capital, ms float64) BacktestStats {
	n := len(equity)
	last := capital
	if n > 0 {
		last = equity[n-1]
	}
	total := 0.0
	if capital != 0 {
		total = last/capital - 1
	}
	years := math.Max(float64(n-1)*ms, ms) / yearMs
	annual := -1.0
	if total > -1 {
		annual = math.Min(math.Pow(1+total, 1/years)-1, 100)
	}
	peak, dd := math.Inf(-1), 0.0
	for _, v := range equity {
		peak = math.Max(peak, v)
		if peak > 0 {
			dd = math.Max(dd, 1-v/peak)
		}
	}
	var rets []float64
	for i := 1; i < n; i++ {
		if equity[i-1] > 0 {
			rets = append(rets, equity[i]/equity[i-1]-1)
		}
	}
	cnt := float64(max(len(rets), 1))
	mean := 0.0
	for _, x := range rets {
		mean += x
	}
	mean /= cnt
	vr := 0.0
	for _, x := range rets {
		d := x - mean
		vr += d * d
	}
	sd := math.Sqrt(vr / cnt)
	sharpe := 0.0
	if sd > 1e-12 {
		sharpe = (mean / sd) * math.Sqrt(yearMs/ms)
	}
	closed, wins := 0, 0
	gain, loss := 0.0, 0.0
	for _, t := range trades {
		if t.PnL == nil {
			continue
		}
		closed++
		if *t.PnL > 0 {
			wins++
			gain += *t.PnL
		}
	}
	for _, t := range trades {
		if t.PnL != nil && *t.PnL < 0 {
			loss += *t.PnL
		}
	}
	loss = -loss
	s := BacktestStats{TotalReturn: total, Annual: annual, MaxDD: dd, Sharpe: sharpe, Trades: closed}
	if closed > 0 {
		s.WinRate = float64(wins) / float64(closed)
	}
	switch {
	case loss > 0:
		s.ProfitFactor = gain / loss
	case gain > 0:
		s.ProfitFactor = 99
	}
	if capital != 0 && len(bench) > 0 {
		s.BenchReturn = bench[len(bench)-1]/capital - 1
	}
	return s
}

/* ---------- 入口 ---------- */

func pickParams(ps Params, keys []string) Params {
	out := Params{}
	for _, k := range keys {
		if v, ok := ps.Get(k); ok {
			out = append(out, Param{k, v})
		}
	}
	return out
}

func run(cfg BacktestConfig, st Strategy, data BacktestData, load func(string, int) []Bar) BacktestResult {
	ns := &notes{}
	var syms []string
	for _, s := range cfg.Symbols {
		if _, ok := data.Instrument(s); ok {
			syms = append(syms, s)
		}
	}
	iv, ok := Intervals[cfg.Interval]
	if len(syms) == 0 || cfg.Bars < 2 || !(cfg.Capital > 0) || !ok {
		return BacktestResult{Equity: []EquityPoint{}, Trades: []BacktestTrade{}, Note: "没有可回测的标的或区间"}
	}
	ms := float64(iv.Milliseconds())
	c := &btCtx{cfg: cfg, st: st, data: data, load: load}
	share := cfg.Capital / float64(len(syms))
	each := func(c *btCtx, f func(*btCtx, string, float64, *notes) leg) []leg {
		out := make([]leg, len(syms))
		for i, s := range syms {
			out[i] = f(c, s, share, ns)
		}
		return out
	}
	fallback := func() []leg {
		fc := *c
		fc.st = fallbackMa(st, cfg)
		fc.cfg.Params = pickParams(cfg.Params, ReservedParams)
		return each(&fc, (*btCtx).runRulesLeg)
	}
	var legs []leg
	if st.Mode == "code" {
		kind := CodeKindOf(st)
		ns.add("代码策略用内置近似模拟（" + CodeKindLabel[kind] + "），不执行源码")
		switch kind {
		case CodeGrid:
			legs = each(c, (*btCtx).runGridLeg)
		case CodeBasis:
			fut, spot := "", ""
			for _, s := range syms {
				if in, _ := data.Instrument(s); in.Kind == "future" || in.Kind == "perp" {
					fut = s
					break
				}
			}
			if fut != "" {
				for _, s := range syms {
					if in, _ := data.Instrument(s); s != fut && in.Kind == "spot" {
						spot = s
						break
					}
				}
				if spot == "" {
					in, _ := data.Instrument(fut)
					spot = in.Underlying
				}
			}
			if _, ok := data.Instrument(spot); fut != "" && spot != "" && ok {
				legs = []leg{c.runBasis(fut, spot, cfg.Capital, ns)}
			} else {
				ns.add("没找到期货和对应现货，退回双均线")
				legs = fallback()
			}
		default:
			legs = fallback()
		}
	} else {
		if len(st.Entry.Rules) == 0 {
			ns.add("入场规则为空，不会开仓")
		}
		legs = each(c, (*btCtx).runRulesLeg)
	}
	// 合并：各标的 K 线按同一周期对齐，按下标相加；长度不一时按最短的对齐到末尾
	n := len(legs[0].t)
	for _, l := range legs {
		n = min(n, len(l.t))
	}
	equity := make([]EquityPoint, n)
	vs, bs := make([]float64, n), make([]float64, n)
	for i := 0; i < n; i++ {
		v, b := 0.0, 0.0
		for _, l := range legs {
			off := len(l.t) - n
			v += l.equity[off+i]
			b += l.bench[off+i]
		}
		l0 := legs[0]
		equity[i] = EquityPoint{T: l0.t[len(l0.t)-n+i], V: v, Bench: b}
		vs[i], bs[i] = v, b
	}
	trades := []BacktestTrade{}
	for _, l := range legs {
		trades = append(trades, l.trades...)
	}
	sortTrades(trades)
	res := BacktestResult{Equity: equity, Trades: trades, Stats: statsOf(vs, bs, trades, cfg.Capital, ms)}
	if len(trades) == 0 {
		ns.add("区间内没有触发入场条件，可以放宽阈值、换周期或拉长区间")
	}
	res.Note = strings.Join(ns.xs, "；")
	return res
}

// loader 给一次回测或扫参缓存 K 线：同一标的同样根数只取一次。
func loader(cfg BacktestConfig, data BacktestData) func(string, int) []Bar {
	cache := map[string][]Bar{}
	return func(symbol string, count int) []Bar {
		k := fmt.Sprintf("%s|%d", symbol, count)
		if bs, ok := cache[k]; ok {
			return bs
		}
		bs := data.Bars(symbol, cfg.Interval, count)
		cache[k] = bs
		return bs
	}
}

// RunBacktest 同步跑完一次回测。
func RunBacktest(cfg BacktestConfig, st Strategy, data BacktestData) BacktestResult {
	return run(cfg, st, data, loader(cfg, data))
}

// Sweep 对一个参数取一组值各跑一次，K 线只取一次。
func Sweep(cfg BacktestConfig, st Strategy, param string, values []float64, data BacktestData) []SweepPoint {
	load := loader(cfg, data)
	out := make([]SweepPoint, len(values))
	for i, v := range values {
		c := cfg
		c.Params = cfg.Params.Set(param, v)
		r := run(c, st, data, load)
		out[i] = SweepPoint{Value: v, TotalReturn: r.Stats.TotalReturn, MaxDD: r.Stats.MaxDD, Sharpe: r.Stats.Sharpe}
	}
	return out
}

// SweepableParams 是能扫的参数：策略参数加三个保留键。
func SweepableParams(st Strategy) Params {
	out := append(Params{}, st.Params...)
	return append(out, Param{"stop_loss", st.StopLoss}, Param{"take_profit", st.TakeProfit}, Param{"position_pct", st.PositionPct})
}
