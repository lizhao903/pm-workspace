// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import "math"

// 内置策略的持仓管理（TRD-09），回测（runBuiltinLeg）和模拟盘部署（actBuiltin）共用，只做多。
// 口径对照 autotrader script/run/run_kdj_short_1h3m.py 的 decide_exit、attempt_pyramid_add 和 SELL_GATE：
//   1. 盘中（按这根入场 K 线的最高最低价，先看止损再看止盈，偏保守）：
//      - 止损线 = 成本 ×(1 - 止损)；最高浮盈到「保本触发」后抬到成本；到「移动止盈启动」后抬到 最高价 ×(1 - 回撤)。
//        最高价用这根之前的（这根里先到最高还是先到最低不知道）。
//      - 开仓后不满「普通止损生效根数」时：只认应急止损（成本 ×(1 - 应急止损)）和已启动的移动止盈；满了以后认上面的止损线。
//      - 止盈：最高价到 成本 ×(1 + 止盈)。
//      - 加仓（斥候仓还没补满时）：最高价到 首笔价 ×(1 + 加仓触发)，按触发价补满。
//      触发价被跳空越过时按开盘价成交。
//   2. 收盘：有卖出信号且浮盈（按收盘价相对成本）≥ 门槛就卖；斥候仓有买入信号且收盘价不低于首笔价就补满；
//      空仓有买入信号就按收盘价开首笔（分配资金 × 仓位 × 首笔占比）。同一根先出场再开仓是允许的（同 autotrader 实盘）。
// 成本是加仓后的均价。

type pmCfg struct {
	SL, TP, Early float64 // 小数
	MinBars       int
	BE, Arm, Give float64
	Gate          float64 // 小数，可以为负
	First         float64 // 首笔占比 0-1
	AddTrig       float64
	Pct           float64 // 每次开仓占分配资金
}

// pmCfgOf 从策略字段、参数（含覆盖）取持仓管理的配置。
func pmCfgOf(b *BuiltinStrategy, st Strategy, ps Params) pmCfg {
	g := func(k string) float64 { return b.pget(ps, k) / 100 }
	return pmCfg{
		SL: numOf(ps, "stop_loss", st.StopLoss) / 100, TP: numOf(ps, "take_profit", st.TakeProfit) / 100,
		Early: g("early_stop"), MinBars: int(jsRound(b.pget(ps, "min_bars_before_stop"))),
		BE: g("breakeven_trigger"), Arm: g("trail_arm"), Give: g("trail_giveback"), Gate: g("sell_gate"),
		First: math.Min(1, math.Max(0.01, g("pyramid_first_pct"))), AddTrig: g("pyramid_add_trigger"),
		Pct: numOf(ps, "position_pct", st.PositionPct) / 100,
	}
}

// pmPos 是持仓的状态：成本（均价）、首笔价、开仓以来的最高价（不含当前这根）、斥候仓还能不能加。
type pmPos struct {
	Avg, First, Peak float64
	Armed            bool
}

// pmExit 是一次出场：价、原因。
type pmExit struct {
	Px     float64
	Reason string
}

// intrabar 看这根 K 线里有没有止损、止盈（exit 非空）或加仓（addPx > 0）。held 是开仓后第几根（开仓那根收盘后的下一根是 1）。
func (c pmCfg) intrabar(p pmPos, b Bar, held int) (*pmExit, float64) {
	avg := p.Avg
	if avg <= 0 {
		return nil, 0
	}
	peakGain := p.Peak/avg - 1
	slBase := 0.0
	if c.SL > 0 {
		slBase = avg * (1 - c.SL)
	}
	sl := slBase
	trail := c.Arm > 0 && peakGain >= c.Arm
	if c.BE > 0 && peakGain >= c.BE {
		sl = math.Max(sl, avg)
	}
	if trail {
		sl = math.Max(sl, p.Peak*(1-c.Give))
	}
	down := func(level float64, reason string) *pmExit {
		return &pmExit{Px: math.Min(level, b.O), Reason: reason}
	}
	if held < c.MinBars {
		if c.Early > 0 {
			if early := avg * (1 - c.Early); b.L <= early {
				return down(early, "应急止损 "+toFixed(c.Early*100, 1)+"%"), 0
			}
		}
		if trail && sl > 0 && b.L <= sl {
			return down(sl, "移动止盈"), 0
		}
	} else if sl > 0 && b.L <= sl {
		switch {
		case trail && sl > slBase && sl > avg:
			return down(sl, "移动止盈"), 0
		case sl > slBase:
			return down(sl, "保本"), 0
		}
		return down(sl, "止损 "+toFixed(c.SL*100, 1)+"%"), 0
	}
	if c.TP > 0 {
		if tp := avg * (1 + c.TP); b.H >= tp {
			return &pmExit{Px: math.Max(tp, b.O), Reason: "止盈 " + toFixed(c.TP*100, 1) + "%"}, 0
		}
	}
	if p.Armed && p.First > 0 {
		if trig := p.First * (1 + c.AddTrig); b.H >= trig {
			return nil, math.Max(trig, b.O)
		}
	}
	return nil, 0
}

// sellAtClose：有卖出信号且收盘价相对成本的浮盈到门槛。
func (c pmCfg) sellAtClose(p pmPos, close float64, sell bool) bool {
	return sell && p.Avg > 0 && close/p.Avg-1 >= c.Gate-1e-12
}

// addAtClose：斥候仓有买入信号、收盘价不低于首笔价。
func (c pmCfg) addAtClose(p pmPos, close float64, buy bool) bool {
	return p.Armed && buy && close >= p.First
}
