// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"
)

// 内置策略部署到模拟盘（TRD-09）：每根入场周期（3m）K 线收盘后，取最近「预热 + 错过」根入场周期 K 线（趋势周期由它聚合），
// 算出信号（builtinSignals，和回测同一套），再按 posman.go 的口径对这根收盘的 K 线下单：
//   - 有持仓：按这根的最高最低价看止损、止盈、加仓（盘中触发的按市价成交，不是触发价），再看收盘的卖出信号和信号加仓；
//   - 空仓：有买入信号按「分到的资金 × 仓位 × 首笔占比」市价买。
// 持仓的成本、首笔价、开仓时间、加没加过仓都从部署自己的成交重放出来（episode），最高价取开仓以来的 K 线，不另存状态，
// 后端重启后照样接得上。只能部署到模拟盘账户（runs.go createRun 拦实盘）。下单都走 rn.order → paper.place，风控逐笔检查。

// episode 是部署在一个标的上这一轮持仓（上次清仓之后）的开仓信息。
type episode struct {
	first float64   // 首笔成交价
	at    time.Time // 首笔成交时间
	buys  int       // 这一轮买了几笔
}

func (rn *runner) episode(ctx context.Context, runID, sym string) (episode, error) {
	fills, err := queryFills(ctx, rn.c, `WHERE run_id = ? AND symbol = ? ORDER BY seq`, runID, sym)
	if err != nil {
		return episode{}, err
	}
	var ep episode
	var q fx
	for _, f := range fills {
		d := f.Qty
		if f.Side == "sell" {
			d = -d
		}
		if f.Side == "buy" {
			if q <= 0 {
				t, _ := time.Parse(time.RFC3339Nano, f.At)
				ep = episode{first: f.Price.Float(), at: t, buys: 0}
			}
			ep.buys++
		}
		q += d
		if q <= 0 {
			ep, q = episode{}, 0
		}
	}
	return ep, nil
}

// recentBars 取截至 latest（含）的最近 want 根，一次 1000 根往前翻；最后一根不是 latest 时回原因。
func (rn *runner) recentBars(ctx context.Context, sym, iv string, want int, latest int64) ([]Bar, string) {
	step := Intervals[iv]
	end := time.UnixMilli(latest).UTC()
	var got []Kline
	for len(got) < want {
		n := min(1000, want-len(got))
		ks, meta, err := rn.p.mkt.klines(ctx, sym, iv, n, end)
		if err != nil {
			return nil, err.Error()
		}
		if len(ks) == 0 {
			if len(got) == 0 {
				if meta.Error != "" {
					return nil, meta.Error
				}
				return nil, "K 线还没取到"
			}
			break
		}
		got = append(ks, got...)
		if len(ks) < n {
			break
		}
		end = ks[0].Time.Add(-step)
	}
	if len(got) == 0 || got[len(got)-1].Time.UnixMilli() != latest {
		return nil, "K 线还没取到"
	}
	return BarsOf(got), ""
}

func (rn *runner) evalBuiltin(ctx context.Context, x Run, st Strategy, in ledgerInst, sym string, lb, latest int64, step time.Duration, now time.Time) (int64, error) {
	b, ok := builtinOf(st.Builtin)
	if !ok {
		rn.noteErr(ctx, x.ID, sym, "内置策略不认识："+st.Builtin+"，不下单")
		return lb, nil
	}
	missed := int((latest - lb) / step.Milliseconds())
	if lb == 0 {
		missed = 1
	}
	missed = min(missed, 1000)
	bs, why := rn.recentBars(ctx, sym, st.Interval, b.WarmBars+missed, latest)
	if why != "" {
		rn.noteErr(ctx, x.ID, sym, "取 "+sym+" 的 K 线失败，等下一轮："+why)
		return lb, nil
	}
	rn.noteErr(ctx, x.ID, sym, "")
	sig := builtinSignals(b, x.Params, bs, "")
	var catchup []string
	firstMissed, lastMissed, nMissed := int64(0), int64(0), 0
	for i, bar := range bs {
		if bar.T <= lb {
			continue
		}
		closeAt := time.UnixMilli(bar.T).Add(step)
		if bar.T != latest || now.Sub(closeAt) > runGrace(st.Interval) {
			if nMissed == 0 {
				firstMissed = bar.T
			}
			lastMissed = bar.T
			nMissed++
			var s []string
			if sig.buy[i] {
				s = append(s, "买入")
			}
			if sig.sell[i] {
				s = append(s, "卖出")
			}
			if len(s) > 0 && len(catchup) < 20 {
				catchup = append(catchup, barText(bar.T, st.Interval)+" "+strings.Join(s, "、")+"信号")
			}
			continue
		}
		if err := rn.actBuiltin(ctx, x, st, b, in, sym, bs, i, sig); err != nil {
			return lb, err
		}
	}
	if nMissed > 0 {
		text := fmt.Sprintf("补算 %s %d 根 K 线（%s 到 %s）：", in.Name, nMissed, barText(firstMissed, st.Interval), barText(lastMissed, st.Interval))
		if len(catchup) == 0 {
			text += "没有信号"
		} else {
			text += strings.Join(catchup, "；")
		}
		text += "。后端没在跑时错过的 K 线只补算、不补下单"
		rn.log(ctx, x.ID, "info", text)
	}
	return latest, nil
}

// actBuiltin 是内置策略在刚收盘的第 i 根上的动作。
func (rn *runner) actBuiltin(ctx context.Context, x Run, st Strategy, b *BuiltinStrategy, in ledgerInst, sym string, bs []Bar, i int, sig builtinSig) error {
	bar := bs[i]
	pm := pmCfgOf(b, st, x.Params)
	alloc := allocFor(x, st, sym) * pm.Pct
	mult := in.Mult.Float()
	qtyOf := func(value, px float64) fx {
		q, ok := fxFromFloat(value / (px * mult))
		if !ok {
			return 0
		}
		return floorLot(q, in.Lot)
	}
	bt := barText(bar.T, st.Interval) + " 收盘 " + numStr(bar.C)
	pos, err := rn.holding(ctx, x, sym)
	if err != nil {
		return err
	}
	if pos.Qty > 0 {
		ep, err := rn.episode(ctx, x.ID, sym)
		if err != nil {
			return err
		}
		step := Intervals[st.Interval].Milliseconds()
		avg := pos.avgPrice(in.Mult).Float()
		first := ep.first
		if first <= 0 {
			first = avg
		}
		// 开仓那根：成交时刻所在那根的前一根（信号在它收盘时出）
		entryBar := bar.T - step
		if !ep.at.IsZero() {
			entryBar = alignOpen(ep.at, st.Interval).UnixMilli() - step
		}
		held := int((bar.T - entryBar) / step)
		peak := math.Max(first, avg)
		for k := 0; k < i; k++ {
			if bs[k].T > entryBar {
				peak = math.Max(peak, bs[k].H)
			}
		}
		p := pmPos{Avg: avg, First: first, Peak: peak, Armed: ep.buys == 1 && pm.First < 1}
		ex, addPx := pm.intrabar(p, bar, held)
		if ex != nil {
			return rn.order(ctx, x, in, sym, "sell", pos.Qty, true, bar.T, "exit", fmt.Sprintf("%s：%s（触发价 %s），平多", bt, ex.Reason, numStr(roundTo(ex.Px, in.Digits+2))))
		}
		added := false
		if addPx > 0 {
			added = true
			q := qtyOf(alloc*(1-pm.First), bar.C)
			if err := rn.order(ctx, x, in, sym, "buy", q, false, bar.T, "add", fmt.Sprintf("%s：浮盈到 %s%%，补满仓位", bt, toFixed(pm.AddTrig*100, 2))); err != nil {
				return err
			}
		}
		if pm.sellAtClose(p, bar.C, sig.sell[i]) {
			return rn.order(ctx, x, in, sym, "sell", pos.Qty, true, bar.T, "exit", bt+"：出场信号，平多")
		}
		if !added && pm.addAtClose(p, bar.C, sig.buy[i]) {
			q := qtyOf(alloc*(1-pm.First), bar.C)
			return rn.order(ctx, x, in, sym, "buy", q, false, bar.T, "add", bt+"：买入信号，补满仓位")
		}
		return nil
	}
	if !sig.buy[i] {
		return nil
	}
	q := qtyOf(alloc*pm.First, bar.C)
	if q <= 0 {
		rn.log(ctx, x.ID, "warn", bt+"：买入信号，但分到的资金不足一手，没开仓")
		return nil
	}
	why := bt + "：买入信号，开多"
	if pm.First < 1 {
		why += "（首笔 " + numStr(roundTo(pm.First*100, 2)) + "%）"
	}
	return rn.order(ctx, x, in, sym, "buy", q, false, bar.T, "entry", why)
}
