// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugins/trade/ta"
)

// 技术指标接入交易插件（TRD-10），指标库在 ta 包（口径对齐通达信，与 MyTT 数值对照验证，未使用其源码）：
//  1. K 线接口按参数附带指标序列：GET /api/trade/klines?indicators=MACD,RSI(14),BOLL(20,2)；
//     指标目录 GET /api/trade/indicators。
//  2. 策略规则的操作数多了一批通达信口径的指标（taIndicators），写法同原有的 {kind:"ind", ind, params}；
//     原有的 price、ma、ema、rsi、macd、boll_up、boll_low、volume、atr 保持回测原型的口径不变。
//  3. 盯盘提醒多了四个指标条件（ind_above、ind_below、ind_cross_up、ind_cross_down），指标同样用策略的操作数写法，
//     见 alerts.go。

// taIndicator 是策略、提醒可引用的一个通达信口径指标：对应 ta 里的哪个指标、取第几条线。
type taIndicator struct {
	Key   string `json:"key"`
	Def   string `json:"def"`
	Line  int    `json:"line"`
	Label string `json:"label"`
}

// taIndicators 是追加到策略指标（Indicators）后面的那一批，参数顺序、默认值、范围同 ta 里对应的指标。
var taIndicators = []taIndicator{
	{"macd_dif", "MACD", 0, "MACD DIF"},
	{"macd_dea", "MACD", 1, "MACD DEA"},
	{"macd_bar", "MACD", 2, "MACD 柱（通达信）"},
	{"kdj_k", "KDJ", 0, "KDJ K"},
	{"kdj_d", "KDJ", 1, "KDJ D"},
	{"kdj_j", "KDJ", 2, "KDJ J"},
	{"wr", "WR", 0, "威廉 WR"},
	{"cci", "CCI", 0, "CCI"},
	{"bias", "BIAS", 0, "乖离率 BIAS"},
	{"boll_mid", "BOLL", 0, "布林中轨"},
	{"bbi", "BBI", 0, "BBI"},
	{"psy", "PSY", 0, "心理线 PSY"},
	{"roc", "ROC", 0, "变动率 ROC"},
	{"mtm", "MTM", 0, "动量 MTM"},
	{"trix", "TRIX", 0, "TRIX"},
	{"obv", "OBV", 0, "OBV"},
	{"mfi", "MFI", 0, "MFI"},
	{"vr", "VR", 0, "VR"},
	{"cr", "CR", 0, "CR"},
	{"pdi", "DMI", 0, "DMI +DI"},
	{"mdi", "DMI", 1, "DMI -DI"},
	{"adx", "DMI", 2, "DMI ADX"},
}

func init() {
	for _, x := range taIndicators {
		if slices.Contains(Indicators, x.Key) {
			panic("策略指标重名：" + x.Key)
		}
		if _, ok := ta.Lookup(x.Def); !ok {
			panic("ta 里没有指标 " + x.Def)
		}
		Indicators = append(Indicators, x.Key)
	}
}

func taIndicatorOf(key string) (taIndicator, ta.Def, bool) {
	for _, x := range taIndicators {
		if x.Key == key {
			d, _ := ta.Lookup(x.Def)
			return x, d, true
		}
	}
	return taIndicator{}, ta.Def{}, false
}

// checkTAParams 校验通达信口径指标的参数（个数、范围、整数）；原有的九个不在这里校验（保持原来的宽松）。
func checkTAParams(o Operand) error {
	_, d, ok := taIndicatorOf(o.Ind)
	if !ok {
		return nil
	}
	return d.Check(o.Params)
}

func ohlcvOf(bs []Bar) ta.OHLCV {
	n := len(bs)
	b := ta.OHLCV{O: make([]float64, n), H: make([]float64, n), L: make([]float64, n), C: make([]float64, n), V: make([]float64, n)}
	for i, x := range bs {
		b.O[i], b.H[i], b.L[i], b.C[i], b.V[i] = x.O, x.H, x.L, x.C, x.V
	}
	return b
}

// taSeries 算通达信口径指标的序列；参数不合法时（如扫参换出来的值）按 Normalize 兜底，不报错。不是这一批的回 false。
func taSeries(op Operand, bs []Bar) ([]float64, bool) {
	x, d, ok := taIndicatorOf(op.Ind)
	if !ok {
		return nil, false
	}
	return d.Calc(ohlcvOf(bs), op.Params)[x.Line], true
}

// taWarm 是通达信口径指标要多取的预热根数。
func taWarm(op Operand) (int, bool) {
	_, d, ok := taIndicatorOf(op.Ind)
	if !ok {
		return 0, false
	}
	return d.Warm(op.Params), true
}

/* ---------- K 线接口附带指标 ---------- */

// maxIndicatorWarm 是 K 线接口为指标多取的预热根数上限。
const maxIndicatorWarm = 500

// IndicatorLine 是指标的一条线，values 与 K 线逐根对齐，算不出的是 null。
type IndicatorLine struct {
	Key    string    `json:"key"`
	Values ta.Floats `json:"values"`
}

// KlineIndicator 是 /api/trade/klines 的 indicators 里的一项（TradeKlineIndicator）。
// warmup 是这次为了算稳在返回的 K 线前面多用了几根（取不到更早的就少于想要的，前面的值初值影响大）。
type KlineIndicator struct {
	Spec    string          `json:"spec"`
	Name    string          `json:"name"`
	Params  []float64       `json:"params"`
	Overlay bool            `json:"overlay"`
	Warmup  int             `json:"warmup"`
	Lines   []IndicatorLine `json:"lines"`
}

// klineMetaInd 是带了 indicators 参数时的 meta：TradeKlineMeta 加 indicators。
type klineMetaInd struct {
	KlineMeta
	Indicators []KlineIndicator `json:"indicators"`
}

// indicatorsFor 给已取到的 K 线算指标：不够预热时再往前取一段（只读行情缓存、缺的找交易所补，和取 K 线同一条路），
// 取不到更早的不算错，warmup 如实写。
func (m *market) indicatorsFor(ctx context.Context, sym, iv string, ks []Kline, calls []ta.Call) []KlineIndicator {
	out := []KlineIndicator{}
	if len(calls) == 0 {
		return out
	}
	want := 0
	for _, c := range calls {
		want = max(want, c.Def.Warm(c.Params))
	}
	want = min(want, maxIndicatorWarm)
	var pre []Kline
	if want > 0 && len(ks) > 0 {
		end := ks[0].Time.Add(-time.Millisecond)
		older, _, err := m.klines(ctx, sym, iv, want, end)
		if err == nil {
			for _, k := range older {
				if k.Time.Before(ks[0].Time) {
					pre = append(pre, k)
				}
			}
		}
	}
	all := BarsOf(append(slices.Clone(pre), ks...))
	b := ohlcvOf(all)
	for _, c := range calls {
		res := c.Def.Calc(b, c.Params)
		ki := KlineIndicator{Spec: c.Spec(), Name: c.Def.Name, Params: c.Params, Overlay: c.Def.Overlay, Warmup: len(pre), Lines: []IndicatorLine{}}
		for k, key := range c.Def.Lines {
			ki.Lines = append(ki.Lines, IndicatorLine{Key: key, Values: ta.Floats(res[k][len(pre):])})
		}
		out = append(out, ki)
	}
	return out
}

/* ---------- 指标目录 ---------- */

// GET /api/trade/indicators：K 线接口能算的指标（名字、中文名、参数、线、是否叠主图），
// 和策略、提醒能引用的指标键（原有九个 + 通达信口径的这一批）。
func (h *handlers) listIndicators(w http.ResponseWriter, r *http.Request) {
	type operand struct {
		Key    string     `json:"key"`
		Label  string     `json:"label"`
		Basis  string     `json:"basis"`
		Def    string     `json:"def"`
		Line   string     `json:"line"`
		Params []ta.Param `json:"params"`
	}
	ops := []operand{}
	for _, k := range Indicators {
		if x, d, ok := taIndicatorOf(k); ok {
			ops = append(ops, operand{Key: k, Label: x.Label, Basis: "tdx", Def: d.Name, Line: d.Lines[x.Line], Params: d.Params})
			continue
		}
		ops = append(ops, operand{Key: k, Label: protoIndicatorLabel[k], Basis: "prototype", Params: protoIndicatorParams[k]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"indicators": ta.Defs(), "operands": ops, "max_per_request": ta.MaxCalls, "max_warmup": maxIndicatorWarm,
	}})
}

// 原有九个指标的显示名和参数（回测原型口径，参数不做范围校验，非法值回测时按 period 兜底）。
var protoIndicatorLabel = map[string]string{
	"price": "收盘价", "ma": "MA", "ema": "EMA", "rsi": "RSI", "macd": "MACD 柱", "boll_up": "布林上轨", "boll_low": "布林下轨", "volume": "成交量", "atr": "ATR",
}

var protoIndicatorParams = map[string][]ta.Param{
	"price": {}, "volume": {},
	"ma":       {{Key: "N", Default: 20, Min: 1, Max: ta.MaxPeriod, Int: true}},
	"ema":      {{Key: "N", Default: 20, Min: 1, Max: ta.MaxPeriod, Int: true}},
	"rsi":      {{Key: "N", Default: 14, Min: 1, Max: ta.MaxPeriod, Int: true}},
	"atr":      {{Key: "N", Default: 14, Min: 1, Max: ta.MaxPeriod, Int: true}},
	"macd":     {{Key: "SHORT", Default: 12, Min: 1, Max: ta.MaxPeriod, Int: true}, {Key: "LONG", Default: 26, Min: 1, Max: ta.MaxPeriod, Int: true}, {Key: "M", Default: 9, Min: 1, Max: ta.MaxPeriod, Int: true}},
	"boll_up":  {{Key: "N", Default: 20, Min: 1, Max: ta.MaxPeriod, Int: true}, {Key: "P", Default: 2, Min: 0.1, Max: 10}},
	"boll_low": {{Key: "N", Default: 20, Min: 1, Max: ta.MaxPeriod, Int: true}, {Key: "P", Default: 2, Min: 0.1, Max: 10}},
}

/* ---------- 提醒用的指标值 ---------- */

// indLabel 是操作数的显示写法，如 RSI(14)、KDJ K(9,3,3)。
func indLabel(o Operand) string {
	name := protoIndicatorLabel[o.Ind]
	ps := o.Params
	if x, d, ok := taIndicatorOf(o.Ind); ok {
		name = x.Label
		ps = d.Normalize(o.Params)
	}
	if name == "" {
		name = o.Ind
	}
	if len(ps) == 0 {
		return name
	}
	ss := make([]string, len(ps))
	for i, p := range ps {
		ss[i] = numStr(p)
	}
	return fmt.Sprintf("%s(%s)", name, strings.Join(ss, ","))
}

// priceScaleInd：和价格同一量纲的指标，提醒里按标的精度显示。
func priceScaleInd(ind string) bool {
	return slices.Contains([]string{"price", "ma", "ema", "boll_up", "boll_low", "boll_mid", "bbi"}, ind)
}

// indSnap 是提醒取的一段 K 线（含还没收盘的那根），同一标的同一周期 alertVolumeTTL 内只取一次。
type indSnap struct {
	bars   []Bar
	want   int // 取的根数；同一标的周期上有更长的指标时重取
	ok     bool
	err    string
	tookAt time.Time
}

// indicatorNow 算提醒的指标在最新一根（还没收盘的那根）和上一根的值。
func (a *alerter) indicatorNow(ctx context.Context, sym, iv string, op Operand) (cur, prev float64, err error) {
	warm, ok := taWarm(op)
	if !ok {
		warm = warmOf(op)
	}
	n := min(1000, max(60, warm+2))
	key := sym + "|" + iv
	now := a.now()
	a.mu.Lock()
	s, have := a.inds[key]
	a.mu.Unlock()
	if !have || now.Sub(s.tookAt) >= alertVolumeTTL || s.want < n {
		ks, meta, kerr := a.p.mkt.klines(ctx, sym, iv, n, time.Time{})
		s = indSnap{tookAt: now, want: n}
		switch {
		case kerr != nil:
			s.err = kerr.Error()
		case meta.Status != "live":
			s.err = meta.Error
			if s.err == "" {
				s.err = "K 线不是实时的"
			}
		case len(ks) < 2:
			s.err = "K 线不够"
		default:
			s.ok, s.bars = true, BarsOf(ks)
		}
		a.mu.Lock()
		a.inds[key] = s
		a.mu.Unlock()
	}
	if !s.ok {
		return 0, 0, errors.New(s.err)
	}
	xs := Series(op, s.bars)
	cur, prev = xs[len(xs)-1], xs[len(xs)-2]
	if !finite(cur) {
		return 0, 0, errors.New("这个指标现在算不出来（K 线不够，或最高等于最低之类的除以 0）")
	}
	return cur, prev, nil
}
