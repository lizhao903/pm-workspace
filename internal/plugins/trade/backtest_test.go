// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
)

// 和原型对拍：testdata/backtest_golden.json 由 testdata/gen-backtest-golden.mjs 用原型 backtest.ts 跑出，
// 原型回测逻辑改了就重跑生成脚本。

// 容差：浮点运算顺序和原型一致，差异只来自 arm64 上的乘加融合和 pow 的末位，
// 曲线和统计按相对误差 1e-9 比；成交价、数量、盈亏原型已舍入，按舍入单位的一半以内比。
const (
	relTol = 1e-9
	absTol = 1e-9
)

type golden struct {
	End   int64            `json:"end"`
	Bars  map[string][]Bar `json:"bars"`
	Cases []struct {
		Name        string                `json:"name"`
		Strategy    Strategy              `json:"strategy"`
		Config      BacktestConfig        `json:"config"`
		CodeKind    string                `json:"code_kind"`
		Instruments map[string]Instrument `json:"instruments"`
		Result      BacktestResult        `json:"result"`
		Sweeps      []struct {
			Param  string       `json:"param"`
			Values []float64    `json:"values"`
			Points []SweepPoint `json:"points"`
		} `json:"sweeps"`
	} `json:"cases"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	b, err := os.ReadFile("testdata/backtest_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("黄金文件里没有用例")
	}
	return g
}

// goldenData 用黄金文件里的 K 线和标的；要的根数超过存的说明 Go 预热算得和原型不同，直接报错。
func goldenData(t *testing.T, g golden, insts map[string]Instrument) BacktestData {
	return BacktestData{
		Instrument: func(s string) (Instrument, bool) { in, ok := insts[s]; return in, ok },
		Bars: func(symbol, interval string, count int) []Bar {
			all, ok := g.Bars[symbol+"|"+interval]
			if !ok {
				t.Errorf("黄金文件里没有 %s %s 的 K 线", symbol, interval)
				return nil
			}
			if count > len(all) {
				t.Errorf("%s %s 要 %d 根 K 线，原型只取过 %d 根", symbol, interval, count, len(all))
				return all
			}
			return all[len(all)-count:]
		},
	}
}

func near(a, b, rel, abs float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.IsNaN(a) && math.IsNaN(b)
	}
	d := math.Abs(a - b)
	return d <= abs || d <= rel*math.Max(math.Abs(a), math.Abs(b))
}

func checkStats(t *testing.T, where string, got, want BacktestStats) {
	t.Helper()
	for _, f := range []struct {
		name      string
		got, want float64
	}{
		{"total_return", got.TotalReturn, want.TotalReturn},
		{"annual", got.Annual, want.Annual},
		{"max_dd", got.MaxDD, want.MaxDD},
		{"sharpe", got.Sharpe, want.Sharpe},
		{"win_rate", got.WinRate, want.WinRate},
		{"profit_factor", got.ProfitFactor, want.ProfitFactor},
		{"bench_return", got.BenchReturn, want.BenchReturn},
	} {
		if !near(f.got, f.want, relTol, absTol) {
			t.Errorf("%s %s = %.17g，原型 %.17g", where, f.name, f.got, f.want)
		}
	}
	if got.Trades != want.Trades {
		t.Errorf("%s trades = %d，原型 %d", where, got.Trades, want.Trades)
	}
}

func TestBacktestMatchesPrototype(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Cases {
		t.Run(c.Name, func(t *testing.T) {
			data := goldenData(t, g, c.Instruments)
			got := RunBacktest(c.Config, c.Strategy, data)
			want := c.Result
			if c.Strategy.Mode == "code" && CodeKindOf(c.Strategy) != c.CodeKind {
				t.Errorf("代码策略认成 %s，原型 %s", CodeKindOf(c.Strategy), c.CodeKind)
			}
			if got.Note != want.Note {
				t.Errorf("说明不一致\n  go：%s\n原型：%s", got.Note, want.Note)
			}
			checkStats(t, "统计", got.Stats, want.Stats)
			if len(got.Equity) != len(want.Equity) {
				t.Fatalf("资金曲线 %d 点，原型 %d 点", len(got.Equity), len(want.Equity))
			}
			for i, e := range want.Equity {
				x := got.Equity[i]
				if x.T != e.T || !near(x.V, e.V, relTol, absTol) || !near(x.Bench, e.Bench, relTol, absTol) {
					t.Fatalf("资金曲线第 %d 点 %+v，原型 %+v", i, x, e)
				}
			}
			if len(got.Trades) != len(want.Trades) {
				t.Fatalf("成交 %d 笔，原型 %d 笔", len(got.Trades), len(want.Trades))
			}
			for i, w := range want.Trades {
				x := got.Trades[i]
				in := c.Instruments[w.Symbol]
				priceUnit := math.Pow(10, -float64(in.Digits+2))
				ok := x.T == w.T && x.Symbol == w.Symbol && x.Side == w.Side && x.Reason == w.Reason &&
					near(x.Price, w.Price, relTol, priceUnit/2) && near(x.Qty, w.Qty, relTol, 0.5e-8) &&
					(x.PnL == nil) == (w.PnL == nil)
				if ok && w.PnL != nil {
					ok = near(*x.PnL, *w.PnL, relTol, 0.005)
				}
				if !ok {
					t.Fatalf("第 %d 笔成交不一致\n  go：%s\n原型：%s", i, tradeStr(x), tradeStr(w))
				}
			}
		})
	}
}

func TestSweepMatchesPrototype(t *testing.T) {
	g := loadGolden(t)
	n := 0
	for _, c := range g.Cases {
		for _, sw := range c.Sweeps {
			n++
			t.Run(c.Name+"/"+sw.Param, func(t *testing.T) {
				got := Sweep(c.Config, c.Strategy, sw.Param, sw.Values, goldenData(t, g, c.Instruments))
				if len(got) != len(sw.Points) {
					t.Fatalf("扫参 %d 个点，原型 %d 个", len(got), len(sw.Points))
				}
				for i, w := range sw.Points {
					x := got[i]
					if x.Value != w.Value || !near(x.TotalReturn, w.TotalReturn, relTol, absTol) ||
						!near(x.MaxDD, w.MaxDD, relTol, absTol) || !near(x.Sharpe, w.Sharpe, relTol, absTol) {
						t.Errorf("%s=%v：go %+v，原型 %+v", sw.Param, w.Value, x, w)
					}
				}
			})
		}
	}
	if n < 5 {
		t.Fatalf("黄金文件里只有 %d 组扫参", n)
	}
}

func tradeStr(x BacktestTrade) string {
	b, _ := json.Marshal(x)
	return string(b)
}

// 策略的 JSON 往返：参数键的顺序要保住，操作数按原型的两种形状输出。
func TestStrategyJSONRoundTrip(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Cases {
		b, err := json.Marshal(c.Strategy)
		if err != nil {
			t.Fatal(err)
		}
		var back Strategy
		if err := json.Unmarshal(b, &back); err != nil {
			t.Fatal(err)
		}
		b2, _ := json.Marshal(back)
		if string(b) != string(b2) {
			t.Fatalf("%s 往返不一致\n%s\n%s", c.Name, b, b2)
		}
	}
	var ps Params
	if err := json.Unmarshal([]byte(`{"slow":48,"fast":12,"x":12}`), &ps); err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal(ps); string(b) != `{"slow":48,"fast":12,"x":12}` {
		t.Fatalf("参数顺序没保住：%s", b)
	}
	if b, _ := json.Marshal(Ind("price")); string(b) != `{"kind":"ind","ind":"price","params":[]}` {
		t.Fatalf("指标操作数：%s", b)
	}
	if b, _ := json.Marshal(Num(30)); string(b) != `{"kind":"num","value":30}` {
		t.Fatalf("数值操作数：%s", b)
	}
}

// 值相同的参数键取先出现的那个（原型约定 2）。
func TestApplyParamsFirstKeyWins(t *testing.T) {
	st := Strategy{
		Params: Params{{"a", 12}, {"b", 12}},
		Entry:  RuleGroup{Logic: "all", Rules: []Rule{{ID: "r", Left: Ind("ema", 12), Op: "gt", Right: Num(12)}}},
	}
	en, _ := ApplyParams(st, Params{{"b", 99}})
	if en.Rules[0].Left.Params[0] != 12 || en.Rules[0].Right.Value != 12 {
		t.Fatalf("b 不该生效：%+v", en.Rules[0])
	}
	en, _ = ApplyParams(st, Params{{"a", 20}})
	if en.Rules[0].Left.Params[0] != 20 || en.Rules[0].Right.Value != 20 {
		t.Fatalf("a 该生效：%+v", en.Rules[0])
	}
	if st.Entry.Rules[0].Left.Params[0] != 12 {
		t.Fatal("ApplyParams 改了原策略")
	}
}

func TestToFixedLikeJS(t *testing.T) {
	for _, c := range []struct {
		x    float64
		d    int
		want string
	}{
		{6, 1, "6.0"}, {2.5, 0, "3"}, {-2.5, 0, "-3"}, {-0.3, 0, "-0"}, {0, 0, "0"}, {1.005, 2, "1.00"},
		{10.000000000000002, 0, "10"}, {-45.6, 0, "-46"}, {0.05, 1, "0.1"},
	} {
		if got := toFixed(c.x, c.d); got != c.want {
			t.Errorf("toFixed(%v, %d) = %s，要 %s", c.x, c.d, got, c.want)
		}
	}
}

func TestStrategyValidate(t *testing.T) {
	g := loadGolden(t)
	for _, c := range g.Cases {
		if err := c.Strategy.Validate(); err != nil {
			t.Errorf("%s 应该合法：%v", c.Name, err)
		}
	}
	bad := g.Cases[0].Strategy
	bad.Mode, bad.Direction, bad.Interval = "py", "up", "2h"
	bad.Entry.Rules = append([]Rule{}, Rule{ID: "x", Left: Operand{Kind: "ind", Ind: "kdj"}, Op: "eq", Right: Num(1)})
	err := bad.Validate()
	if err == nil {
		t.Fatal("不合法的策略过了校验")
	}
	for _, want := range []string{"模式", "方向", "周期", "kdj", "eq"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误里没提 %s：%v", want, err)
		}
	}
}
