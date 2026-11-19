// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"fmt"
	"math"
)

// 内置策略的回测（TRD-09）：取「回测根数 + 预热」根入场周期 K 线，算出每根收盘时的买卖信号（builtinSignals），
// 再按 posman.go 的口径逐根模拟。成交走同一个账本（book），手续费、滑点、最小下单量同条件规则。
// 最后一根不再看信号，有持仓按收盘价平掉（同条件规则「回测结束平仓」）。

func (c *btCtx) runBuiltinLeg(symbol string, cash float64, ns *notes) leg {
	b, ok := builtinOf(c.st.Builtin)
	if !ok {
		ns.add("内置策略不认识：" + c.st.Builtin)
		return leg{trades: []BacktestTrade{}}
	}
	bs := c.load(symbol, c.cfg.Bars+b.WarmBars)
	from := max(len(bs)-c.cfg.Bars, 0)
	return c.builtinLeg(b, symbol, bs, from, cash, ns, "")
}

// builtinLeg 从下标 from 开始模拟（from 之前只算指标）。mode 为空用策略自己的趋势口径，对拍测试会传 lookahead。
func (c *btCtx) builtinLeg(b *BuiltinStrategy, symbol string, bs []Bar, from int, cash float64, ns *notes, mode string) leg {
	cfg, st := c.cfg, c.st
	prm := st.Params.Merge(cfg.Params)
	sig := builtinSignals(b, prm, bs, mode)
	pm := pmCfgOf(b, st, prm)
	in, ok := c.data.Instrument(symbol)
	bk := newBook(cash, symbol, in, ok, cfg)
	p0 := 1.0
	if from < len(bs) {
		p0 = bs[from].C
	}
	var lg leg
	var pos pmPos
	entryIdx := -1
	reserve := 0.0 // 斥候仓之后补满要用的资金
	flat := func() { pos, entryIdx, reserve = pmPos{}, -1, 0 }
	for i := from; i < len(bs); i++ {
		bar := bs[i]
		last := i == len(bs)-1
		if bk.qty > 0 && entryIdx >= 0 && i > entryIdx {
			pos.Avg = bk.avg
			ex, addPx := pm.intrabar(pos, bar, i-entryIdx)
			if ex != nil {
				bk.trade(-bk.qty, ex.Px, bar.T, ex.Reason)
				flat()
			} else if addPx > 0 {
				c.pyramidAdd(bk, &pos, &reserve, addPx, bar.T, symbol, ns, "浮盈到 "+toFixed(pm.AddTrig*100, 2)+"% 加仓")
			}
			if bk.qty > 0 {
				pos.Peak = math.Max(pos.Peak, bar.H)
			}
		}
		if !last {
			if bk.qty > 0 {
				pos.Avg = bk.avg
				if pm.sellAtClose(pos, bar.C, sig.sell[i]) {
					bk.trade(-bk.qty, bar.C, bar.T, "出场信号")
					flat()
				} else if pm.addAtClose(pos, bar.C, sig.buy[i]) {
					c.pyramidAdd(bk, &pos, &reserve, bar.C, bar.T, symbol, ns, "买入信号加仓")
				}
			}
			if bk.qty == 0 && sig.buy[i] {
				alloc := bk.equity(bar.C) * pm.Pct
				first := alloc * pm.First
				q := c.sizeOf(first, bar.C, symbol, ns)
				reason := "入场信号"
				if pm.First < 1 {
					reason = fmt.Sprintf("入场信号，首笔 %s%%", numStr(roundTo(pm.First*100, 2)))
				}
				bk.trade(q, bar.C, bar.T, reason)
				if bk.qty > 0 {
					entryIdx = i
					pos = pmPos{Avg: bk.avg, First: bar.C, Peak: bar.C, Armed: pm.First < 1}
					reserve = alloc - first
				}
			}
		}
		if last && bk.qty != 0 {
			bk.trade(-bk.qty, bar.C, bar.T, "回测结束平仓")
		}
		lg.t = append(lg.t, bar.T)
		lg.equity = append(lg.equity, bk.equity(bar.C))
		lg.bench = append(lg.bench, (cash*bar.C)/p0)
	}
	lg.trades = bk.trades
	return lg
}

// pyramidAdd 用留着的资金补满斥候仓。
func (c *btCtx) pyramidAdd(bk *book, pos *pmPos, reserve *float64, px float64, t int64, symbol string, ns *notes, reason string) {
	pos.Armed = false
	if *reserve <= 0 {
		return
	}
	q := c.sizeOf(math.Min(*reserve, bk.cash), px, symbol, ns)
	*reserve = 0
	if q > 0 {
		bk.trade(q, px, t, reason)
	}
}
