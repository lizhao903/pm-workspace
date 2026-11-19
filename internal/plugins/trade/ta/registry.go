// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package ta

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// 指标登记表（TRD-10）：K 线接口按名字和参数算指标（GET /api/trade/klines?indicators=MACD,RSI(14),BOLL(20,2)），
// 策略、盯盘提醒的指标也从这里取默认参数和取值范围。

// Param 是指标的一个参数：Int 为真时只能是整数；取值范围 [Min, Max]。
type Param struct {
	Key     string  `json:"key"`
	Default float64 `json:"default"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Int     bool    `json:"int"`
}

// Def 是一个指标：名字（大写）、中文名、参数、输出的线（顺序同通达信）、是否叠在主图（和价格同一坐标）。
type Def struct {
	Name    string   `json:"name"`
	Title   string   `json:"title"`
	Params  []Param  `json:"params"`
	Lines   []string `json:"lines"`
	Overlay bool     `json:"overlay"`
	warm    func(p []float64) int
	calc    func(b OHLCV, p []float64) [][]float64
}

// MaxPeriod 是周期类参数的上限。
const MaxPeriod = 500

func per(key string, d float64) Param {
	return Param{Key: key, Default: d, Min: 1, Max: MaxPeriod, Int: true}
}

func ip(p []float64, i int) int { return int(p[i]) }

func lines(xs ...[]float64) [][]float64 { return xs }

// 预热：递推类的初值误差衰减到 1e-4 以内要的根数，EMA(N) 约 5N，SMA(N,1) 约 9N；窗口类是窗口长度。
func emaWarm(n float64) int    { return int(5 * n) }
func wilderWarm(n float64) int { return int(9 * n) }
func sumWarm(xs ...float64) int {
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return int(s)
}

var defs = []Def{
	{Name: "MA", Title: "均线", Params: []Param{per("N", 5)}, Lines: []string{"MA"}, Overlay: true,
		warm: func(p []float64) int { return int(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(MA(b.C, ip(p, 0))) }},
	{Name: "EMA", Title: "指数均线", Params: []Param{per("N", 12)}, Lines: []string{"EMA"}, Overlay: true,
		warm: func(p []float64) int { return emaWarm(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(EMA(b.C, ip(p, 0))) }},
	{Name: "EXPMA", Title: "指数平均数", Params: []Param{per("N1", 12), per("N2", 50)}, Lines: []string{"EXP1", "EXP2"}, Overlay: true,
		warm: func(p []float64) int { return emaWarm(math.Max(p[0], p[1])) },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(EMA(b.C, ip(p, 0)), EMA(b.C, ip(p, 1))) }},
	{Name: "BOLL", Title: "布林带", Params: []Param{per("N", 20), {Key: "P", Default: 2, Min: 0.1, Max: 10}}, Lines: []string{"MID", "UPPER", "LOWER"}, Overlay: true,
		warm: func(p []float64) int { return int(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { m, u, l := BOLL(b.C, ip(p, 0), p[1]); return lines(m, u, l) }},
	{Name: "BBI", Title: "多空指标", Params: []Param{per("M1", 3), per("M2", 6), per("M3", 12), per("M4", 24)}, Lines: []string{"BBI"}, Overlay: true,
		warm: func(p []float64) int { return int(math.Max(math.Max(p[0], p[1]), math.Max(p[2], p[3]))) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			return lines(BBI(b.C, ip(p, 0), ip(p, 1), ip(p, 2), ip(p, 3)))
		}},
	{Name: "TAQ", Title: "唐奇安通道", Params: []Param{per("N", 20)}, Lines: []string{"UP", "MID", "DOWN"}, Overlay: true,
		warm: func(p []float64) int { return int(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { u, m, d := TAQ(b.H, b.L, ip(p, 0)); return lines(u, m, d) }},
	{Name: "KTN", Title: "肯特纳通道", Params: []Param{per("N", 20), per("M", 10)}, Lines: []string{"UPPER", "MID", "LOWER"}, Overlay: true,
		warm: func(p []float64) int { return max(emaWarm(p[0]), int(p[1])+1) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			u, m, l := KTN(b.C, b.H, b.L, ip(p, 0), ip(p, 1))
			return lines(u, m, l)
		}},
	{Name: "XSII", Title: "薛斯通道 II", Params: []Param{{Key: "N", Default: 102, Min: 1, Max: 199, Int: true}, {Key: "M", Default: 7, Min: 0, Max: 100}}, Lines: []string{"TD1", "TD2", "TD3", "TD4"}, Overlay: true,
		warm: func(p []float64) int { return 300 },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c, d, e := XSII(b.C, b.H, b.L, p[0], p[1])
			return lines(a, c, d, e)
		}},
	{Name: "MACD", Title: "平滑异同平均", Params: []Param{per("SHORT", 12), per("LONG", 26), per("M", 9)}, Lines: []string{"DIF", "DEA", "MACD"},
		warm: func(p []float64) int { return emaWarm(math.Max(p[0], p[1]) + p[2]) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			d, e, m := MACD(b.C, ip(p, 0), ip(p, 1), ip(p, 2))
			return lines(d, e, m)
		}},
	{Name: "KDJ", Title: "随机指标", Params: []Param{per("N", 9), per("M1", 3), per("M2", 3)}, Lines: []string{"K", "D", "J"},
		warm: func(p []float64) int { return int(p[0]) + wilderWarm(p[1]+p[2]) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			k, d, j := KDJ(b.C, b.H, b.L, ip(p, 0), ip(p, 1), ip(p, 2))
			return lines(k, d, j)
		}},
	{Name: "RSI", Title: "相对强弱", Params: []Param{per("N", 6)}, Lines: []string{"RSI"},
		warm: func(p []float64) int { return wilderWarm(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(RSI(b.C, ip(p, 0))) }},
	{Name: "WR", Title: "威廉指标", Params: []Param{per("N", 10), per("N1", 6)}, Lines: []string{"WR1", "WR2"},
		warm: func(p []float64) int { return int(math.Max(p[0], p[1])) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			return lines(WR(b.C, b.H, b.L, ip(p, 0)), WR(b.C, b.H, b.L, ip(p, 1)))
		}},
	{Name: "BIAS", Title: "乖离率", Params: []Param{per("L1", 6), per("L2", 12), per("L3", 24)}, Lines: []string{"BIAS1", "BIAS2", "BIAS3"},
		warm: func(p []float64) int { return int(math.Max(p[0], math.Max(p[1], p[2]))) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			return lines(BIAS(b.C, ip(p, 0)), BIAS(b.C, ip(p, 1)), BIAS(b.C, ip(p, 2)))
		}},
	{Name: "CCI", Title: "顺势指标", Params: []Param{per("N", 14)}, Lines: []string{"CCI"},
		warm: func(p []float64) int { return int(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(CCI(b.C, b.H, b.L, ip(p, 0))) }},
	{Name: "ATR", Title: "真实波幅均值", Params: []Param{per("N", 14)}, Lines: []string{"ATR"},
		warm: func(p []float64) int { return int(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(ATR(b.C, b.H, b.L, ip(p, 0))) }},
	{Name: "DMI", Title: "趋向指标", Params: []Param{per("M1", 14), per("M2", 6)}, Lines: []string{"PDI", "MDI", "ADX", "ADXR"},
		warm: func(p []float64) int { return sumWarm(p[0], 2*p[1], 1) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c, d, e := DMI(b.C, b.H, b.L, ip(p, 0), ip(p, 1))
			return lines(a, c, d, e)
		}},
	{Name: "PSY", Title: "心理线", Params: []Param{per("N", 12), per("M", 6)}, Lines: []string{"PSY", "PSYMA"},
		warm: func(p []float64) int { return sumWarm(p[0], p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := PSY(b.C, ip(p, 0), ip(p, 1)); return lines(a, c) }},
	{Name: "TRIX", Title: "三重指数平滑", Params: []Param{per("N", 12), per("M", 9)}, Lines: []string{"TRIX", "MATRIX"},
		warm: func(p []float64) int { return 3*emaWarm(p[0]) + int(p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := TRIX(b.C, ip(p, 0), ip(p, 1)); return lines(a, c) }},
	{Name: "VR", Title: "成交量变异率", Params: []Param{per("N", 26)}, Lines: []string{"VR"},
		warm: func(p []float64) int { return int(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(VR(b.C, b.V, ip(p, 0))) }},
	{Name: "CR", Title: "能量指标", Params: []Param{per("N", 26)}, Lines: []string{"CR"},
		warm: func(p []float64) int { return int(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(CR(b.C, b.H, b.L, ip(p, 0))) }},
	{Name: "EMV", Title: "简易波动", Params: []Param{per("N", 14), per("M", 9)}, Lines: []string{"EMV", "MAEMV"},
		warm: func(p []float64) int { return sumWarm(3*p[0], p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c := EMV(b.H, b.L, b.V, ip(p, 0), ip(p, 1))
			return lines(a, c)
		}},
	{Name: "DPO", Title: "区间震荡线", Params: []Param{per("N", 20), per("M", 6)}, Lines: []string{"DPO", "MADPO"},
		warm: func(p []float64) int { return sumWarm(p[0], p[0]/2+1, p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := DPO(b.C, ip(p, 0), ip(p, 1)); return lines(a, c) }},
	{Name: "BRAR", Title: "情绪指标", Params: []Param{per("N", 26)}, Lines: []string{"BR", "AR"},
		warm: func(p []float64) int { return int(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := BRAR(b.O, b.C, b.H, b.L, ip(p, 0)); return lines(a, c) }},
	{Name: "DFMA", Title: "平行线差", Params: []Param{per("N1", 10), per("N2", 50), per("M", 10)}, Lines: []string{"DIF", "DIFMA"},
		warm: func(p []float64) int { return sumWarm(math.Max(p[0], p[1]), p[2]) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c := DFMA(b.C, ip(p, 0), ip(p, 1), ip(p, 2))
			return lines(a, c)
		}},
	{Name: "MTM", Title: "动量", Params: []Param{per("N", 12), per("M", 6)}, Lines: []string{"MTM", "MTMMA"},
		warm: func(p []float64) int { return sumWarm(p[0], p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := MTM(b.C, ip(p, 0), ip(p, 1)); return lines(a, c) }},
	{Name: "MASS", Title: "梅斯线", Params: []Param{per("N1", 9), per("N2", 25), per("M", 6)}, Lines: []string{"MASS", "MAMASS"},
		warm: func(p []float64) int { return sumWarm(2*p[0], p[1], p[2]) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c := MASS(b.H, b.L, ip(p, 0), ip(p, 1), ip(p, 2))
			return lines(a, c)
		}},
	{Name: "ROC", Title: "变动率", Params: []Param{per("N", 12), per("M", 6)}, Lines: []string{"ROC", "MAROC"},
		warm: func(p []float64) int { return sumWarm(p[0], p[1]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := ROC(b.C, ip(p, 0), ip(p, 1)); return lines(a, c) }},
	{Name: "OBV", Title: "能量潮", Params: []Param{per("M", 30)}, Lines: []string{"OBV", "MAOBV"},
		warm: func(p []float64) int { return int(p[0]) },
		calc: func(b OHLCV, p []float64) [][]float64 { a, c := OBV(b.C, b.V, ip(p, 0)); return lines(a, c) }},
	{Name: "MFI", Title: "资金流量", Params: []Param{per("N", 14)}, Lines: []string{"MFI"},
		warm: func(p []float64) int { return int(p[0]) + 1 },
		calc: func(b OHLCV, p []float64) [][]float64 { return lines(MFI(b.C, b.H, b.L, b.V, ip(p, 0))) }},
	{Name: "ASI", Title: "振动升降", Params: []Param{per("M1", 26), per("M2", 10)}, Lines: []string{"ASI", "ASIT"},
		warm: func(p []float64) int { return sumWarm(p[0], p[1], 1) },
		calc: func(b OHLCV, p []float64) [][]float64 {
			a, c := ASI(b.O, b.C, b.H, b.L, ip(p, 0), ip(p, 1))
			return lines(a, c)
		}},
}

// Defs 回全部指标（只读，别改）。
func Defs() []Def { return defs }

// Lookup 按名字找指标，不分大小写。
func Lookup(name string) (Def, bool) {
	name = strings.ToUpper(strings.TrimSpace(name))
	for _, d := range defs {
		if d.Name == name {
			return d, true
		}
	}
	return Def{}, false
}

// Check 校验参数：个数不超过定义的、每个在范围内、整数参数是整数。
func (d Def) Check(ps []float64) error {
	if len(ps) > len(d.Params) {
		return fmt.Errorf("%s 最多 %d 个参数", d.Name, len(d.Params))
	}
	for i, v := range ps {
		p := d.Params[i]
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("%s 的参数 %s 要是数字", d.Name, p.Key)
		}
		if p.Int && v != math.Trunc(v) {
			return fmt.Errorf("%s 的参数 %s 要是整数", d.Name, p.Key)
		}
		if v < p.Min || v > p.Max {
			return fmt.Errorf("%s 的参数 %s 要在 %s 到 %s 之间", d.Name, p.Key, fmtNum(p.Min), fmtNum(p.Max))
		}
	}
	return nil
}

// Normalize 补齐默认值、整数参数四舍五入、夹到范围内；回测扫参换出来的值不合法时用它兜底，不报错。
func (d Def) Normalize(ps []float64) []float64 {
	out := make([]float64, len(d.Params))
	for i, p := range d.Params {
		v := p.Default
		if i < len(ps) && !math.IsNaN(ps[i]) && !math.IsInf(ps[i], 0) {
			v = ps[i]
		}
		if p.Int {
			v = math.Floor(v + 0.5)
		}
		out[i] = math.Min(p.Max, math.Max(p.Min, v))
	}
	return out
}

// Warm 是按这组参数算到稳定要多给的 K 线根数（参数先 Normalize）。
func (d Def) Warm(ps []float64) int { return d.warm(d.Normalize(ps)) }

// Calc 按这组参数算各条线（参数先 Normalize），顺序同 Lines。
func (d Def) Calc(b OHLCV, ps []float64) [][]float64 { return d.calc(b, d.Normalize(ps)) }

// Call 是一次指标调用：指标和补齐了默认值的参数。
type Call struct {
	Def    Def
	Params []float64
}

// Spec 是规范写法，如 MACD(12,26,9)。
func (c Call) Spec() string {
	ps := make([]string, len(c.Params))
	for i, v := range c.Params {
		ps[i] = fmtNum(v)
	}
	return c.Def.Name + "(" + strings.Join(ps, ",") + ")"
}

func fmtNum(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// MaxCalls 是一次最多算几个指标。
const MaxCalls = 8

// Parse 解析指标列表，如 "MACD,RSI(14),BOLL(20,2)"：逗号分隔，名字不分大小写，括号里是参数（逗号分隔，可省略、可少给，
// 少给的用默认值）；同一个规范写法出现两次只算一次。空串回空列表。最多 MaxCalls 个。
func Parse(s string) ([]Call, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return []Call{}, nil
	}
	if len(s) > 512 {
		return nil, fmt.Errorf("指标参数太长")
	}
	var items []string
	depth, start := 0, 0
	for i, r := range s {
		switch r {
		case '(':
			depth++
			if depth > 1 {
				return nil, fmt.Errorf("指标写法不对：括号不能嵌套")
			}
		case ')':
			depth--
			if depth < 0 {
				return nil, fmt.Errorf("指标写法不对：多了右括号")
			}
		case ',':
			if depth == 0 {
				items = append(items, s[start:i])
				start = i + 1
			}
		}
	}
	if depth != 0 {
		return nil, fmt.Errorf("指标写法不对：括号没配对")
	}
	items = append(items, s[start:])
	out := []Call{}
	seen := map[string]bool{}
	for _, it := range items {
		c, err := parseOne(strings.TrimSpace(it))
		if err != nil {
			return nil, err
		}
		if seen[c.Spec()] {
			continue
		}
		seen[c.Spec()] = true
		out = append(out, c)
	}
	if len(out) > MaxCalls {
		return nil, fmt.Errorf("一次最多 %d 个指标", MaxCalls)
	}
	return out, nil
}

func parseOne(it string) (Call, error) {
	if it == "" {
		return Call{}, fmt.Errorf("指标写法不对：有空项")
	}
	name, args, hasArgs := strings.Cut(it, "(")
	d, ok := Lookup(name)
	if !ok {
		return Call{}, fmt.Errorf("不认识的指标 %s，可选：%s", strings.TrimSpace(name), Names())
	}
	var ps []float64
	if hasArgs {
		if !strings.HasSuffix(args, ")") {
			return Call{}, fmt.Errorf("指标写法不对：%s", it)
		}
		args = strings.TrimSpace(strings.TrimSuffix(args, ")"))
		if args != "" {
			for _, a := range strings.Split(args, ",") {
				v, err := strconv.ParseFloat(strings.TrimSpace(a), 64)
				if err != nil {
					return Call{}, fmt.Errorf("%s 的参数要是数字：%s", d.Name, strings.TrimSpace(a))
				}
				ps = append(ps, v)
			}
		}
	}
	if err := d.Check(ps); err != nil {
		return Call{}, err
	}
	return Call{Def: d, Params: d.Normalize(ps)}, nil
}

// Names 是全部指标名，逗号分隔。
func Names() string {
	ns := make([]string, len(defs))
	for i, d := range defs {
		ns[i] = d.Name
	}
	return strings.Join(ns, "、")
}

// Floats 是序列的 JSON 形式：NaN、无穷写成 null。
type Floats []float64

func (fs Floats) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('[')
	for i, v := range fs {
		if i > 0 {
			b.WriteByte(',')
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			b.WriteString("null")
			continue
		}
		b.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	}
	b.WriteByte(']')
	return b.Bytes(), nil
}

// UnmarshalJSON 把 null 读回 NaN。
func (fs *Floats) UnmarshalJSON(b []byte) error {
	var raw []*float64
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	out := make(Floats, len(raw))
	for i, p := range raw {
		if p == nil {
			out[i] = math.NaN()
		} else {
			out[i] = *p
		}
	}
	*fs = out
	return nil
}
