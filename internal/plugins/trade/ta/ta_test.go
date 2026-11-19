// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package ta

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"testing"
)

// 和 MyTT 的数值对照（TRD-10）：../testdata/mytt_golden.json 由 ../testdata/gen-mytt-golden.py 在仓库外的独立环境里
// 加载 MyTT 算出，这里只有数值。按小数点后 4 位比（|差| <= 1e-4；量级很大的累计值再放宽到相对 1e-10）。
// 两边定义不同的位置（见各函数注释）跳过，跳过的规则写在 skip 里。

type goldenCase struct {
	Input string            `json:"input"`
	Fn    string            `json:"fn"`
	Args  []json.RawMessage `json:"args"`
	Out   []Floats          `json:"out"`
}

type goldenFile struct {
	Inputs map[string]map[string]Floats `json:"inputs"`
	Cases  []goldenCase                 `json:"cases"`
}

func loadMyTT(t *testing.T) goldenFile {
	t.Helper()
	b, err := os.ReadFile("../testdata/mytt_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("对照文件里没有用例")
	}
	return g
}

func near4(got, want float64) bool {
	if math.IsNaN(want) || math.IsNaN(got) {
		return math.IsNaN(want) && math.IsNaN(got)
	}
	d := math.Abs(got - want)
	return d <= 1e-4 || d <= 1e-10*math.Abs(want)
}

// run 按用例算出 Go 这边的结果（顺序已对齐 MyTT 的输出顺序）和每条线从哪一根开始比。
func run(t *testing.T, in map[string]Floats, c goldenCase) ([][]float64, int) {
	t.Helper()
	ser := func(i int) []float64 {
		var name string
		if err := json.Unmarshal(c.Args[i], &name); err != nil {
			t.Fatalf("%s 第 %d 个参数不是序列名", c.Fn, i)
		}
		s, ok := in[name]
		if !ok {
			t.Fatalf("输入里没有 %s", name)
		}
		return s
	}
	num := func(i int) float64 {
		var v float64
		if err := json.Unmarshal(c.Args[i], &v); err != nil {
			t.Fatalf("%s 第 %d 个参数不是数字", c.Fn, i)
		}
		return v
	}
	n := func(i int) int { return int(num(i)) }
	O, H, L, C, V := in["O"], in["H"], in["L"], in["C"], in["V"]
	one := func(x []float64) [][]float64 { return [][]float64{x} }
	switch c.Fn {
	case "REF":
		return one(REF(ser(0), n(1))), 0
	case "DIFF":
		return one(DIFF(ser(0), n(1))), 0
	case "STDP":
		return one(STDP(ser(0), n(1))), 0
	case "SUM":
		return one(SUM(ser(0), n(1))), 0
	case "HHV":
		return one(HHV(ser(0), n(1))), 0
	case "LLV":
		return one(LLV(ser(0), n(1))), 0
	case "HHVBARS":
		return one(HHVBARS(ser(0), n(1))), 0
	case "LLVBARS":
		return one(LLVBARS(ser(0), n(1))), 0
	case "MA":
		return one(MA(ser(0), n(1))), 0
	case "EMA":
		return one(EMA(ser(0), n(1))), 0
	case "SMA":
		return one(SMA(ser(0), n(1), n(2))), 0
	case "WMA":
		return one(WMA(ser(0), n(1))), 0
	case "DMA":
		var name string
		if json.Unmarshal(c.Args[1], &name) == nil {
			return one(DMAS(ser(0), ser(1))), 0
		}
		return one(DMA(ser(0), num(1))), 0
	case "AVEDEV":
		return one(AVEDEV(ser(0), n(1))), 0
	case "SLOPE":
		return one(SLOPE(ser(0), n(1))), 0
	case "FORCAST":
		return one(FORCAST(ser(0), n(1))), 0
	case "LAST":
		return one(LAST(ser(0), n(1), n(2))), n(1) // MyTT 前 A 根窗口不满时回真
	case "COUNT":
		return one(COUNT(ser(0), n(1))), 0
	case "EVERY":
		return one(EVERY(ser(0), n(1))), 0
	case "EXIST":
		return one(EXIST(ser(0), n(1))), 0
	case "FILTER":
		return one(FILTER(ser(0), n(1))), 0
	case "BARSLAST":
		return one(BARSLAST(ser(0))), 0 // 之前没成立过的位置这边是 NaN，比较时跳过
	case "BARSLASTCOUNT":
		return one(BARSLASTCOUNT(ser(0))), 0
	case "BARSSINCEN":
		return one(BARSSINCEN(ser(0), n(1))), n(1) - 1 // MyTT 窗口不满时回 0
	case "CROSS":
		return one(CROSS(ser(0), ser(1))), 0
	case "LONGCROSS":
		return one(LONGCROSS(ser(0), ser(1), n(2))), 0
	case "VALUEWHEN":
		return one(VALUEWHEN(ser(0), ser(1))), 0
	case "BETWEEN":
		return one(BETWEEN(ser(0), ser(1), ser(2))), 0
	case "TOPRANGE":
		return one(TOPRANGE(ser(0))), 0
	case "LOWRANGE":
		return one(LOWRANGE(ser(0))), 0

	case "MACD":
		a, b, d := MACD(C, n(0), n(1), n(2))
		return [][]float64{a, b, d}, 0
	case "KDJ":
		a, b, d := KDJ(C, H, L, n(0), n(1), n(2))
		return [][]float64{a, b, d}, 0
	case "RSI":
		return one(RSI(C, n(0))), 0
	case "WR":
		return [][]float64{WR(C, H, L, n(0)), WR(C, H, L, n(1))}, 0
	case "BIAS":
		return [][]float64{BIAS(C, n(0)), BIAS(C, n(1)), BIAS(C, n(2))}, 0
	case "BOLL":
		m, u, l := BOLL(C, n(0), num(1))
		return [][]float64{u, m, l}, 0 // MyTT 顺序 UPPER、MID、LOWER
	case "PSY":
		a, b := PSY(C, n(0), n(1))
		return [][]float64{a, b}, 0
	case "CCI":
		return one(CCI(C, H, L, n(0))), 0
	case "ATR":
		return one(ATR(C, H, L, n(0))), 0
	case "BBI":
		return one(BBI(C, n(0), n(1), n(2), n(3))), 0
	case "DMI":
		a, b, d, e := DMI(C, H, L, n(0), n(1))
		return [][]float64{a, b, d, e}, 0
	case "TAQ":
		a, b, d := TAQ(H, L, n(0))
		return [][]float64{a, b, d}, 0
	case "KTN":
		a, b, d := KTN(C, H, L, n(0), n(1))
		return [][]float64{a, b, d}, 0
	case "TRIX":
		a, b := TRIX(C, n(0), n(1))
		return [][]float64{a, b}, 0
	case "VR":
		return one(VR(C, V, n(0))), 0
	case "CR_HLC3":
		mid := scale(REF(add(add(H, L), C), 1), 1.0/3)
		return one(crWith(H, L, mid, n(0))), 0
	case "EMV":
		a, b := EMV(H, L, V, n(0), n(1))
		return [][]float64{a, b}, 0
	case "DPO":
		a, b := DPO(C, n(0), n(1))
		return [][]float64{a, b}, 0
	case "BRAR":
		br, ar := BRAR(O, C, H, L, n(0))
		return [][]float64{ar, br}, 0 // MyTT 顺序 AR、BR
	case "DFMA":
		a, b := DFMA(C, n(0), n(1), n(2))
		return [][]float64{a, b}, 0
	case "MTM":
		a, b := MTM(C, n(0), n(1))
		return [][]float64{a, b}, 0
	case "MASS":
		a, b := MASS(H, L, n(0), n(1), n(2))
		return [][]float64{a, b}, 0
	case "ROC":
		a, b := ROC(C, n(0), n(1))
		return [][]float64{a, b}, 0
	case "EXPMA":
		return [][]float64{EMA(C, n(0)), EMA(C, n(1))}, 0
	case "OBV":
		obv, _ := OBV(C, V, 30)
		return one(scale(obv, 1.0/10000)), 0 // MyTT 除了 10000
	case "MFI":
		return one(MFI(C, H, L, V, n(0))), 0
	case "ASI":
		a, b := ASI(O, C, H, L, n(0), n(1))
		return [][]float64{a, b}, 0
	case "XSII":
		a, b, d, e := XSII(C, H, L, num(0), num(1))
		return [][]float64{a, b, d, e}, 0
	}
	t.Fatalf("对照文件里有没处理的函数 %s", c.Fn)
	return nil, 0
}

// skip 是两边定义不同、不比的位置。
func skip(c goldenCase, in map[string]Floats, got []float64, i int) bool {
	switch c.Fn {
	case "BARSLAST":
		return math.IsNaN(got[i]) // 之前没成立过：这边 NaN，MyTT 从第一根数起
	case "CROSS", "LONGCROSS":
		// 前一根还没有值时 MyTT 也可能报穿越，这边不报
		a, b := in["MA5"], in["MA10"]
		return i == 0 || math.IsNaN(a[i-1]) || math.IsNaN(b[i-1]) || (c.Fn == "LONGCROSS" && i < 10+3) ||
			tie(a[i], b[i]) || tie(a[i-1], b[i-1]) // 两条均线几乎相等，同 BETWEEN
	case "BETWEEN":
		// 输入的均线在对照文件里存到 12 位有效数字，和当根价格几乎相等时比较结果取决于末位，不比
		return tie(in["C"][i], in["MA5"][i]) || tie(in["C"][i], in["MA10"][i])
	case "VR":
		// 窗口里有平盘时通达信口径（平盘量两边各算一半）和 MyTT（平盘量全算下跌）本来就不同
		cl := in["C"]
		for j := max(1, i-c.argN(0)+1); j <= i; j++ {
			if cl[j] == cl[j-1] {
				return true
			}
		}
		return false
	case "TOPRANGE", "LOWRANGE":
		// 前面全都不高于（不低于）时这边是序号、MyTT 是 0；往前数遇到相等的值 MyTT 停下、这边继续
		x := in["H"]
		if c.Fn == "LOWRANGE" {
			x = in["L"]
		}
		k := int(got[i])
		return k == i || slices.Contains(x[i-k:i], x[i])
	}
	return false
}

func tie(a, b float64) bool { return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(b)) }

func (c goldenCase) argN(i int) int {
	var v float64
	_ = json.Unmarshal(c.Args[i], &v)
	return int(v)
}

func TestMatchesMyTT(t *testing.T) {
	g := loadMyTT(t)
	seen := map[string]bool{}
	for _, c := range g.Cases {
		in := g.Inputs[c.Input]
		args, _ := json.Marshal(c.Args)
		name := fmt.Sprintf("%s/%s%s", c.Input, c.Fn, args)
		seen[c.Fn] = true
		t.Run(name, func(t *testing.T) {
			got, from := run(t, in, c)
			if len(got) != len(c.Out) {
				t.Fatalf("线数 %d，MyTT %d", len(got), len(c.Out))
			}
			for k, want := range c.Out {
				if len(got[k]) != len(want) {
					t.Fatalf("第 %d 条线长度 %d，MyTT %d", k, len(got[k]), len(want))
				}
				compared := 0
				for i := from; i < len(want); i++ {
					if skip(c, in, got[k], i) {
						continue
					}
					if !near4(got[k][i], want[i]) {
						t.Fatalf("第 %d 条线第 %d 根：go %v，MyTT %v", k, i, got[k][i], want[i])
					}
					if !math.IsNaN(want[i]) {
						compared++
					}
				}
				if compared < len(want)/2 && !(c.Fn == "VR" && c.Input == "SSE:510300|1h") { // 这段平盘多，VR 只比没平盘的窗口
					t.Fatalf("第 %d 条线只比了 %d 个有效值，对照不充分", k, compared)
				}
			}
		})
	}
	if len(seen) < 58 {
		t.Errorf("对照只覆盖了 %d 个函数", len(seen))
	}
}

// 递推类以第一个有效值为初值：前面的 NaN 跳过，中间的 NaN 那根输出 NaN、状态沿用。
func TestRecursiveSeedAndGap(t *testing.T) {
	x := []float64{math.NaN(), 10, 20, math.NaN(), 30}
	got := EMA(x, 3) // k = 0.5
	want := []float64{math.NaN(), 10, 15, math.NaN(), 22.5}
	for i := range want {
		if !near4(got[i], want[i]) {
			t.Fatalf("EMA 第 %d 根 %v，要 %v", i, got[i], want[i])
		}
	}
	// EMA(X,N) 等于 SMA(X,N+1,2)
	c := []float64{3, 5, 4, 8, 7, 9, 6}
	a, b := EMA(c, 5), SMA(c, 6, 2)
	for i := range a {
		if math.Abs(a[i]-b[i]) > 1e-12 {
			t.Fatalf("EMA(5) 和 SMA(6,2) 第 %d 根不同：%v %v", i, a[i], b[i])
		}
	}
	// TA-Lib 口径：前 n 个均值做初值
	s := EMASeeded(c, 3)
	if !math.IsNaN(s[1]) || s[2] != 4 || s[3] != 8*0.5+4*0.5 {
		t.Fatalf("EMASeeded = %v", s)
	}
}

func TestParse(t *testing.T) {
	cs, err := Parse("macd, RSI(14),BOLL(20,2.5),ma(5),MA(5)")
	if err != nil {
		t.Fatal(err)
	}
	var specs []string
	for _, c := range cs {
		specs = append(specs, c.Spec())
	}
	want := []string{"MACD(12,26,9)", "RSI(14)", "BOLL(20,2.5)", "MA(5)"}
	if !slices.Equal(specs, want) {
		t.Fatalf("specs = %v，要 %v", specs, want)
	}
	if cs, err := Parse(""); err != nil || len(cs) != 0 {
		t.Fatalf("空串 = %v %v", cs, err)
	}
	for _, bad := range []string{
		"FOO", "MA(0)", "MA(501)", "MA(5.5)", "MA(x)", "MA(5", "MA5)", "MA((5))", "MA,,RSI", "BOLL(20,2,3)",
		"BOLL(20,0)", "MA(1),MA(2),MA(3),MA(4),MA(5),MA(6),MA(7),MA(8),MA(9)", "MA(NaN)", "MA(Inf)",
	} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q 应当报错", bad)
		}
	}
}

func TestRegistryCalcShape(t *testing.T) {
	g := loadMyTT(t)
	in := g.Inputs["BINANCE:ETHUSDT|1h"]
	b := OHLCV{O: in["O"], H: in["H"], L: in["L"], C: in["C"], V: in["V"]}
	for _, d := range Defs() {
		out := d.Calc(b, nil)
		if len(out) != len(d.Lines) {
			t.Fatalf("%s 回 %d 条线，登记 %d 条", d.Name, len(out), len(d.Lines))
		}
		w := d.Warm(nil)
		if w < 1 || w > 600 {
			t.Errorf("%s 预热 %d 根不合理", d.Name, w)
		}
		for k, xs := range out {
			if len(xs) != len(b.C) {
				t.Fatalf("%s 第 %d 条线长度 %d", d.Name, k, len(xs))
			}
			if math.IsNaN(xs[len(xs)-1]) {
				t.Errorf("%s 第 %d 条线最后一根是 NaN", d.Name, k)
			}
		}
	}
	bs, _ := json.Marshal(Floats{1, math.NaN(), 2.5, math.Inf(1)})
	if string(bs) != "[1,null,2.5,null]" {
		t.Fatalf("Floats JSON = %s", bs)
	}
}

// VR 有平盘时按通达信口径：100*(2*TH+TQ)/(2*TL+TQ)。
func TestVRFlat(t *testing.T) {
	c := []float64{10, 11, 11, 10, 12}
	v := []float64{1, 2, 3, 4, 5}
	got := VR(c, v, 4)
	// 后 4 根：涨 2+5=7，跌 4，平 3 → 100*(14+3)/(8+3)
	if want := 100 * 17.0 / 11; math.Abs(got[4]-want) > 1e-12 {
		t.Fatalf("VR = %v，最后一根要 %v", got, want)
	}
}
