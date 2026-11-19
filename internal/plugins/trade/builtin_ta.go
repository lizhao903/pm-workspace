// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import "math"

// 内置策略（TRD-09）用到的指标：KDJ、SuperTrend、ADX，和多周期的 K 线聚合。
//
// TODO(TRD-09)：交易插件的技术指标包（另一个任务在写，口径对齐通达信）落地后，把 kdjRaw、supertrendDir、adxWilder
// 换成调指标包；换之前要先跑 builtin_test.go 的对拍（TestKDJParityAutotrader 等），口径不一致就不能换。
// 这里的口径刻意对齐 autotrader（script/utils/MyTT.py 与 script/strategy/strategy_supertrend_adx_1h3m.py），不是通达信：
//   - KDJ：RSV = (C - LLV(L, N)) / (HHV(H, N) - LLV(L, N)) × 100；K = EMA(RSV, 2×M1-1)、D = EMA(K, 2×M2-1)，
//     EMA 同 pandas ewm(span, adjust=False)：从第一个有值的数起算，alpha = 2 / (span + 1)；J = 3K - 2D；
//     用于比较的值保留两位小数（同 MyTT 的 RD，四舍六入五成双）。
//   - SuperTrend：Pine 标准写法，ATR 用 Wilder 平滑（前 N 根均值做种子）。
//   - ADX：Wilder，前 2N-1 根不出值。

// rd2 同 numpy 的 round(x, 2)。
func rd2(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	return math.RoundToEven(x*100) / 100
}

// ewmStep 是 pandas ewm(adjust=False) 的一步：prev 为 NaN 时用 x 起算；x 为 NaN 时沿用 prev。
func ewmStep(prev, x, alpha float64) float64 {
	switch {
	case math.IsNaN(x):
		return prev
	case math.IsNaN(prev):
		return x
	}
	return alpha*x + (1-alpha)*prev
}

// rsvAt 是第 i 根的 RSV：hs、ls、cs 的第 i 根往前 n 根（含）；不够 n 根或最高等于最低时为 NaN。
func rsvAt(hs, ls []float64, c float64, i, n int) float64 {
	if i+1 < n {
		return math.NaN()
	}
	hh, ll := math.Inf(-1), math.Inf(1)
	for k := i - n + 1; k <= i; k++ {
		hh = math.Max(hh, hs[k])
		ll = math.Min(ll, ls[k])
	}
	if hh == ll {
		return math.NaN()
	}
	return (c - ll) / (hh - ll) * 100
}

// kdjRaw 算 K、D（没取整），J 由调用方按 3K-2D 算再取整。
func kdjRaw(hs, ls, cs []float64, n, m1, m2 int) (k, d []float64) {
	k, d = nans(len(cs)), nans(len(cs))
	a1, a2 := 2/float64(2*m1), 2/float64(2*m2)
	pk, pd := math.NaN(), math.NaN()
	for i := range cs {
		pk = ewmStep(pk, rsvAt(hs, ls, cs[i], i, n), a1)
		pd = ewmStep(pd, pk, a2)
		k[i], d[i] = pk, pd
	}
	return k, d
}

// kdjVals 是一组取整后的 K、D、J。
type kdjVals struct{ K, D, J float64 }

func kdjOf(k, d float64) kdjVals {
	return kdjVals{K: rd2(k), D: rd2(d), J: rd2(3*k - 2*d)}
}

// kdjSeries 是整段的取整 KDJ。
func kdjSeries(bs []Bar, n, m1, m2 int) []kdjVals {
	hs, ls, cs := hlc(bs)
	k, d := kdjRaw(hs, ls, cs, n, m1, m2)
	out := make([]kdjVals, len(bs))
	for i := range bs {
		out[i] = kdjOf(k[i], d[i])
	}
	return out
}

func hlc(bs []Bar) (hs, ls, cs []float64) {
	hs, ls, cs = make([]float64, len(bs)), make([]float64, len(bs)), make([]float64, len(bs))
	for i, b := range bs {
		hs[i], ls[i], cs[i] = b.H, b.L, b.C
	}
	return
}

// wilderRMA 同 autotrader 的 _wilder_rma：前 n 根均值做种子放在第 n-1 根，之后 (prev×(n-1)+x)/n；x 不是有限数时沿用 prev。
func wilderRMA(xs []float64, n int) []float64 {
	out := nans(len(xs))
	if n < 1 || len(xs) < n {
		return out
	}
	s := 0.0
	for i := 0; i < n; i++ {
		s += xs[i]
	}
	out[n-1] = s / float64(n)
	for i := n; i < len(xs); i++ {
		if !finite(xs[i]) {
			out[i] = out[i-1]
			continue
		}
		out[i] = (out[i-1]*float64(n-1) + xs[i]) / float64(n)
	}
	return out
}

func trueRange(bs []Bar) []float64 {
	tr := make([]float64, len(bs))
	for i, b := range bs {
		if i == 0 {
			tr[i] = b.H - b.L
			continue
		}
		pc := bs[i-1].C
		tr[i] = math.Max(b.H-b.L, math.Max(math.Abs(b.H-pc), math.Abs(b.L-pc)))
	}
	return tr
}

// supertrendDir 是 SuperTrend 方向：+1 多、-1 空、0 还没出值。
func supertrendDir(bs []Bar, period int, mult float64) []int {
	n := len(bs)
	dir := make([]int, n)
	if period < 1 || n <= period {
		return dir
	}
	atr := wilderRMA(trueRange(bs), period)
	hl2 := func(i int) float64 { return (bs[i].H + bs[i].L) / 2 }
	seed := period - 1
	up, lo := hl2(seed)+mult*atr[seed], hl2(seed)-mult*atr[seed]
	switch {
	case bs[seed].C < lo:
		dir[seed] = -1
	default:
		dir[seed] = 1
	}
	for i := seed + 1; i < n; i++ {
		if !finite(atr[i]) {
			dir[i] = dir[i-1]
			continue
		}
		u, l := hl2(i)+mult*atr[i], hl2(i)-mult*atr[i]
		switch {
		case bs[i].C > up:
			dir[i] = 1
		case bs[i].C < lo:
			dir[i] = -1
		default:
			dir[i] = dir[i-1]
		}
		up, lo = u, l
	}
	return dir
}

// adxWilder 是 Wilder ADX，前 2n-1 根为 NaN。
func adxWilder(bs []Bar, n int) []float64 {
	m := len(bs)
	out := nans(m)
	if n < 1 || m < 2 {
		return out
	}
	pdm, mdm := make([]float64, m), make([]float64, m)
	for i := 1; i < m; i++ {
		up, dn := bs[i].H-bs[i-1].H, bs[i-1].L-bs[i].L
		if up > dn && up > 0 {
			pdm[i] = up
		}
		if dn > up && dn > 0 {
			mdm[i] = dn
		}
	}
	atr, pn, mn := wilderRMA(trueRange(bs), n), wilderRMA(pdm, n), wilderRMA(mdm, n)
	dx := make([]float64, m)
	for i := range dx {
		if !(atr[i] > 0) {
			continue // NaN 或 0：同 autotrader，DX 记 0 进平滑
		}
		p, q := 100*pn[i]/atr[i], 100*mn[i]/atr[i]
		if p+q > 0 {
			dx[i] = 100 * math.Abs(p-q) / (p + q)
		}
	}
	adx := wilderRMA(dx, n)
	for i := range adx {
		if i >= 2*n-1 {
			out[i] = adx[i]
		}
	}
	return out
}

// ---------- 多周期：由入场周期的 K 线聚合出趋势周期 ----------

// 趋势周期在某一根入场 K 线收盘时取哪一根：
//   - trendPartial：当前这根趋势 K 线还没收盘，用截至这根入场 K 线的部分（同 autotrader 实盘，交易所给的最后一根是未收盘的）；
//   - trendClosed：只用已经收盘的趋势 K 线（同 autotrader 的 SuperTrend 回测 get_1h_index_from_3m）；
//   - trendLookahead：用入场 K 线所在的整根趋势 K 线（含之后的数据）。只给对拍 autotrader engine.py 用，产品里不开放。
const (
	trendPartial   = "partial"
	trendClosed    = "closed"
	trendLookahead = "lookahead"
)

// mtf 是入场 K 线和聚合出来的趋势 K 线的对应关系。
type mtf struct {
	groups  []Bar // 每根趋势 K 线（聚合的整根）
	gi      []int // 入场 K 线 i 落在哪一根趋势 K 线
	gStart  []int // 趋势 K 线 g 的第一根入场 K 线下标
	trendMs int64
}

func newMTF(bs []Bar, trendIv string) mtf {
	step := Intervals[trendIv].Milliseconds()
	m := mtf{gi: make([]int, len(bs)), trendMs: step}
	for i, b := range bs {
		open := alignOpen(timeMs(b.T), trendIv).UnixMilli()
		if n := len(m.groups); n > 0 && m.groups[n-1].T == open {
			g := &m.groups[n-1]
			g.H, g.L, g.C, g.V = math.Max(g.H, b.H), math.Min(g.L, b.L), b.C, g.V+b.V
		} else {
			m.groups = append(m.groups, Bar{T: open, O: b.O, H: b.H, L: b.L, C: b.C, V: b.V})
			m.gStart = append(m.gStart, i)
		}
		m.gi[i] = len(m.groups) - 1
	}
	return m
}

// partial 是入场 K 线 i 收盘时它所在那根趋势 K 线的样子（从这根趋势 K 线开头聚合到 i）。
func (m mtf) partial(bs []Bar, i int) Bar {
	g := m.gi[i]
	s := m.gStart[g]
	out := Bar{T: m.groups[g].T, O: bs[s].O, H: bs[s].H, L: bs[s].L, C: bs[i].C}
	for k := s; k <= i; k++ {
		out.H, out.L, out.V = math.Max(out.H, bs[k].H), math.Min(out.L, bs[k].L), out.V+bs[k].V
	}
	return out
}

// lastClosed 是入场 K 线 i 收盘时最后一根已经收盘的趋势 K 线下标，没有为 -1。
func (m mtf) lastClosed(bs []Bar, i int, entryMs int64) int {
	g := m.gi[i]
	if bs[i].T+entryMs >= m.groups[g].T+m.trendMs {
		return g
	}
	return g - 1
}
