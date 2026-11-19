// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// 策略与回测的数据结构（TRD-04a），对照原型 web-next/src/tradedata.ts 的 Strategy、Rule、RuleGroup、Operand、
// BacktestConfig、BacktestResult，JSON 形状和原型一致。落库和接口在 TRD-04b、TRD-04c。

// 指标、比较方式，同原型 Indicator、Compare
var (
	Indicators = []string{"price", "ma", "ema", "rsi", "macd", "boll_up", "boll_low", "volume", "atr"}
	Compares   = []string{"cross_up", "cross_down", "gt", "lt"}
)

// Operand 是规则的一边：指标（Kind=ind，Ind 加 Params）或数值（Kind=num，Value）。
type Operand struct {
	Kind   string
	Ind    string
	Params []float64
	Value  float64
}

// Ind、Num 拼操作数，测试和以后的模板用。
func Ind(ind string, params ...float64) Operand {
	if params == nil {
		params = []float64{}
	}
	return Operand{Kind: "ind", Ind: ind, Params: params}
}
func Num(v float64) Operand { return Operand{Kind: "num", Value: v} }

func (o Operand) MarshalJSON() ([]byte, error) {
	if o.Kind == "num" {
		return json.Marshal(struct {
			Kind  string  `json:"kind"`
			Value float64 `json:"value"`
		}{o.Kind, o.Value})
	}
	ps := o.Params
	if ps == nil {
		ps = []float64{}
	}
	return json.Marshal(struct {
		Kind   string    `json:"kind"`
		Ind    string    `json:"ind"`
		Params []float64 `json:"params"`
	}{o.Kind, o.Ind, ps})
}

func (o *Operand) UnmarshalJSON(b []byte) error {
	var x struct {
		Kind   string    `json:"kind"`
		Ind    string    `json:"ind"`
		Params []float64 `json:"params"`
		Value  float64   `json:"value"`
	}
	if err := json.Unmarshal(b, &x); err != nil {
		return err
	}
	*o = Operand{Kind: x.Kind, Ind: x.Ind, Params: x.Params, Value: x.Value}
	return nil
}

type Rule struct {
	ID    string  `json:"id"`
	Left  Operand `json:"left"`
	Op    string  `json:"op"`
	Right Operand `json:"right"`
}

// RuleGroup：Logic 是 all（全部满足）或 any（任一满足）；没有规则时永远不触发。
type RuleGroup struct {
	Logic string `json:"logic"`
	Rules []Rule `json:"rules"`
}

// Param 是一个可调参数。
type Param struct {
	Key   string
	Value float64
}

// Params 是有序的参数表，JSON 是对象，键的顺序保留：参数替换时值相同的键取先出现的那个（同原型约定 2）。
type Params []Param

func (ps Params) Get(k string) (float64, bool) {
	for _, p := range ps {
		if p.Key == k {
			return p.Value, true
		}
	}
	return 0, false
}

func (ps Params) Has(k string) bool { _, ok := ps.Get(k); return ok }

// Set 有就改、没有追加到最后，同 JS 对象赋值。
func (ps Params) Set(k string, v float64) Params {
	out := slices.Clone(ps)
	for i := range out {
		if out[i].Key == k {
			out[i].Value = v
			return out
		}
	}
	return append(out, Param{k, v})
}

// Merge 同 JS 的 { ...ps, ...over }。
func (ps Params) Merge(over Params) Params {
	out := slices.Clone(ps)
	for _, p := range over {
		out = out.Set(p.Key, p.Value)
	}
	return out
}

func (ps Params) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, p := range ps {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(p.Key)
		v, err := json.Marshal(p.Value)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (ps *Params) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	t, err := dec.Token()
	if err != nil {
		return err
	}
	if t == nil {
		*ps = nil
		return nil
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return errors.New("参数要是对象")
	}
	out := Params{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return err
		}
		var v float64
		if err := dec.Decode(&v); err != nil {
			return fmt.Errorf("参数 %v 要是数值", kt)
		}
		out = out.Set(kt.(string), v)
	}
	*ps = out
	return nil
}

// Strategy 同原型 Strategy。Mode 是 rules（规则）、code（代码，不执行源码，只按 CodeKindOf 认成内置近似）
// 或 builtin（内置策略，TRD-09：Builtin 是 builtin.go 注册表里的 id，信号由 Go 实现，Params 是它的参数）。
// SymbolWeights 是按币种的资金权重（TRD-09）：回测分资金、部署算下单量都按它分，没写的标的按 1 算，空表示平均分。
type Strategy struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Desc        string    `json:"desc"`
	Mode        string    `json:"mode"`
	Symbols     []string  `json:"symbols"`
	Interval    string    `json:"interval"`
	Direction   string    `json:"direction"`
	Entry       RuleGroup `json:"entry"`
	Exit        RuleGroup `json:"exit"`
	StopLoss    float64   `json:"stop_loss"`
	TakeProfit  float64   `json:"take_profit"`
	PositionPct float64   `json:"position_pct"`
	Code        string    `json:"code"`
	Builtin     string    `json:"builtin"`
	Params      Params    `json:"params"`
	// 按币种的资金权重
	SymbolWeights map[string]float64 `json:"symbol_weights"`
	Tags          []string           `json:"tags"`
	UpdatedAt     string             `json:"updated_at"`
	CreatedAt     string             `json:"created_at"`
}

// Validate 检查枚举值和数值范围；标的认不认识交给回测时的标的表。
func (s Strategy) Validate() error {
	var errs []string
	if strings.TrimSpace(s.Name) == "" {
		errs = append(errs, "名称不能为空")
	}
	if s.Mode != "rules" && s.Mode != "code" && s.Mode != "builtin" {
		errs = append(errs, "模式只能是 rules、code 或 builtin")
	}
	if s.Mode == "builtin" {
		if b, ok := builtinOf(s.Builtin); !ok {
			errs = append(errs, "内置策略不认识："+s.Builtin)
		} else {
			if s.Interval != b.EntryInterval {
				errs = append(errs, "内置策略「"+b.Name+"」的周期只能是 "+b.EntryInterval)
			}
			if s.Direction != b.Direction {
				errs = append(errs, "内置策略「"+b.Name+"」只做多")
			}
			if err := b.check(s.Params); err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	for sym, w := range s.SymbolWeights {
		if !slices.Contains(s.Symbols, sym) {
			errs = append(errs, "资金权重里的 "+sym+" 不在标的里")
		}
		if !finite(w) || w <= 0 || w > 1e6 {
			errs = append(errs, "资金权重要大于 0、不超过 1000000："+sym)
		}
	}
	if _, ok := Intervals[s.Interval]; !ok {
		errs = append(errs, "周期不认识："+s.Interval)
	}
	if !slices.Contains([]string{"long", "short", "both"}, s.Direction) {
		errs = append(errs, "方向只能是 long、short、both")
	}
	for _, sym := range s.Symbols {
		if !ValidSymbol(sym) {
			errs = append(errs, "标的格式不对："+sym)
		}
	}
	groups := []struct {
		name string
		g    RuleGroup
	}{{"入场", s.Entry}, {"出场", s.Exit}}
	if s.Mode == "builtin" {
		groups = nil // 内置策略没有条件规则
	}
	for _, g := range groups {
		if g.g.Logic != "all" && g.g.Logic != "any" {
			errs = append(errs, g.name+"规则组的逻辑只能是 all 或 any")
		}
		for _, r := range g.g.Rules {
			if !slices.Contains(Compares, r.Op) {
				errs = append(errs, fmt.Sprintf("%s规则 %s 的比较方式不认识：%s", g.name, r.ID, r.Op))
			}
			for _, o := range []Operand{r.Left, r.Right} {
				if err := o.validate(); err != nil {
					errs = append(errs, fmt.Sprintf("%s规则 %s：%v", g.name, r.ID, err))
				}
			}
		}
	}
	for _, x := range []struct {
		name string
		v    float64
	}{{"止损", s.StopLoss}, {"止盈", s.TakeProfit}, {"仓位", s.PositionPct}} {
		if x.v < 0 || x.v > 100 {
			errs = append(errs, x.name+"要在 0 到 100 之间")
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "；"))
	}
	return nil
}

func (o Operand) validate() error {
	switch o.Kind {
	case "num":
		return nil
	case "ind":
		if !slices.Contains(Indicators, o.Ind) {
			return fmt.Errorf("指标不认识：%s", o.Ind)
		}
		return checkTAParams(o) // 通达信口径的那一批校验参数（TRD-10）
	}
	return fmt.Errorf("操作数类型只能是 ind 或 num：%s", o.Kind)
}

// BacktestConfig 同原型：Bars 是回测最近多少根 K 线，FeeBp 万分之几，SlippageTicks 几跳；
// Params 覆盖策略参数，stop_loss、take_profit、position_pct 三个保留键覆盖策略同名字段。
// Start、End（TRD-09）是 UTC 日期 YYYY-MM-DD，左闭右开；给了 End 就回测到 End 之前最后一根，再给 Start 时 Bars 按区间算。
type BacktestConfig struct {
	StrategyID    string   `json:"strategy_id"`
	Symbols       []string `json:"symbols"`
	Interval      string   `json:"interval"`
	Bars          int      `json:"bars"`
	Capital       float64  `json:"capital"`
	FeeBp         float64  `json:"fee_bp"`
	SlippageTicks float64  `json:"slippage_ticks"`
	Params        Params   `json:"params"`
	Start         string   `json:"start,omitempty"`
	End           string   `json:"end,omitempty"`
}

// BacktestTrade：PnL 只有减仓的成交才有。T 是毫秒时间戳。
type BacktestTrade struct {
	T      int64    `json:"t"`
	Symbol string   `json:"symbol"`
	Side   string   `json:"side"`
	Price  float64  `json:"price"`
	Qty    float64  `json:"qty"`
	PnL    *float64 `json:"pnl,omitempty"`
	Reason string   `json:"reason"`
}

// EquityPoint 是资金曲线的一点，Bench 是买入持有的基准。
type EquityPoint struct {
	T     int64   `json:"t"`
	V     float64 `json:"v"`
	Bench float64 `json:"bench"`
}

// BacktestStats：收益、回撤、胜率都是小数（0.05 即 5%）；Trades 是有盈亏的成交笔数。
type BacktestStats struct {
	TotalReturn  float64 `json:"total_return"`
	Annual       float64 `json:"annual"`
	MaxDD        float64 `json:"max_dd"`
	Sharpe       float64 `json:"sharpe"`
	WinRate      float64 `json:"win_rate"`
	Trades       int     `json:"trades"`
	ProfitFactor float64 `json:"profit_factor"`
	BenchReturn  float64 `json:"bench_return"`
}

// BacktestResult 同原型，Note 是给人看的说明（近似方式、资金不足一手等），没有为空。
// PerSymbol（TRD-09）是每个标的单独的统计，多标的或内置策略才有。
type BacktestResult struct {
	Equity    []EquityPoint   `json:"equity"`
	Trades    []BacktestTrade `json:"trades"`
	Stats     BacktestStats   `json:"stats"`
	PerSymbol []SymbolStats   `json:"per_symbol,omitempty"`
	Note      string          `json:"note,omitempty"`
}

// SymbolStats 是一个标的按它分到的资金单独算的统计。
type SymbolStats struct {
	Symbol  string        `json:"symbol"`
	Capital float64       `json:"capital"`
	Stats   BacktestStats `json:"stats"`
}

// SweepPoint 是扫参的一个取值的结果。网格扫描（TRD-09）时 Params 是这一组的取值，Value 是第一个参数的取值。
type SweepPoint struct {
	Value       float64 `json:"value"`
	Params      Params  `json:"params,omitempty"`
	TotalReturn float64 `json:"total_return"`
	MaxDD       float64 `json:"max_dd"`
	Sharpe      float64 `json:"sharpe"`
	WinRate     float64 `json:"win_rate"`
	Trades      int     `json:"trades"`
}
