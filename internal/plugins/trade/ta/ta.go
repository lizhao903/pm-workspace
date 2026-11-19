// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package ta 是交易插件的技术指标库（TRD-10）：序列进、序列出。
//
// 约定：
//  1. 输入输出都是 []float64，输出与输入等长；前面不够周期、或窗口里有无效值（NaN）的位置是 NaN。
//  2. 条件序列（CROSS、COUNT 的输入等）用 1 / 0 表示真假，NaN 当假。
//  3. 口径对齐通达信的公开公式（函数说明、系统指标公式）；数值和 MyTT（https://github.com/mpquant/MyTT）
//     在仓库外算出的结果对照验证（testdata/mytt_golden.json，按 1e-4 比），未使用其源码。
//     和 MyTT 有出入的地方在各函数注释里写明。
//  4. 递推类（EMA、中国式 SMA、DMA）以第一个有效值为初值，和通达信一致；初值的影响随长度衰减，
//     要和行情软件对齐到小数点后几位，序列前面至少要多给 4 倍周期左右的 K 线（预热）。
//  5. EMASeeded、STDP 的写法和回测引擎原来的 ema、stdev 逐位一致（回测对拍原型，口径不能动），见各自注释。
package ta

import "math"

// NaN 序列。
func nans(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = math.NaN()
	}
	return out
}

func isNaN(x float64) bool { return math.IsNaN(x) }

// truthy：条件为真（非零、非 NaN）。
func truthy(x float64) bool { return !math.IsNaN(x) && x != 0 }

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// zip 逐位算 f(a[i], b[i])，任一是 NaN 结果就是 NaN（f 自己不用管）。
func zip(a, b []float64, f func(x, y float64) float64) []float64 {
	out := make([]float64, len(a))
	for i := range a {
		if isNaN(a[i]) || isNaN(b[i]) {
			out[i] = math.NaN()
			continue
		}
		out[i] = f(a[i], b[i])
	}
	return out
}

func mapf(a []float64, f func(x float64) float64) []float64 {
	out := make([]float64, len(a))
	for i, x := range a {
		if isNaN(x) {
			out[i] = math.NaN()
			continue
		}
		out[i] = f(x)
	}
	return out
}

func add(a, b []float64) []float64 { return zip(a, b, func(x, y float64) float64 { return x + y }) }
func sub(a, b []float64) []float64 { return zip(a, b, func(x, y float64) float64 { return x - y }) }
func mul(a, b []float64) []float64 { return zip(a, b, func(x, y float64) float64 { return x * y }) }

// div 除以 0 得 NaN（通达信除零是无效值）。
func div(a, b []float64) []float64 {
	return zip(a, b, func(x, y float64) float64 {
		if y == 0 {
			return math.NaN()
		}
		return x / y
	})
}

func scale(a []float64, k float64) []float64 {
	return mapf(a, func(x float64) float64 { return x * k })
}

// gt 是 a > b 的条件序列，有 NaN 为假。
func gt(a, b []float64) []float64 {
	out := make([]float64, len(a))
	for i := range a {
		out[i] = b2f(a[i] > b[i]) // NaN 比较恒为假
	}
	return out
}

func lt(a, b []float64) []float64 { return gt(b, a) }

// iff 是 IF(cond, a, b)：cond 为真取 a，否则取 b。
func iff(cond, a, b []float64) []float64 {
	out := make([]float64, len(cond))
	for i := range cond {
		if truthy(cond[i]) {
			out[i] = a[i]
		} else {
			out[i] = b[i]
		}
	}
	return out
}

func konst(n int, v float64) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = v
	}
	return out
}

// maxf 是逐位 MAX，有 NaN 为 NaN。
func maxf(a, b []float64) []float64 { return zip(a, b, math.Max) }
func absf(a []float64) []float64    { return mapf(a, math.Abs) }
