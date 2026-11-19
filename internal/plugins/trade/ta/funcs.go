// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package ta

import "math"

// 工具函数（TRD-10），名字和参数同通达信的公式函数。n 是周期，除特别说明外要 >= 1，小于 1 时整列 NaN。

// REF 向前引用：REF(X, n) 是 n 根之前的值，前 n 根是 NaN。
func REF(x []float64, n int) []float64 {
	out := nans(len(x))
	if n < 0 {
		return out
	}
	for i := n; i < len(x); i++ {
		out[i] = x[i-n]
	}
	return out
}

// DIFF 是 X - REF(X, n)。
func DIFF(x []float64, n int) []float64 { return sub(x, REF(x, n)) }

// rolling 对每个位置取最近 n 根（必须都有效）交给 f；不够 n 根或窗口里有 NaN 的位置是 NaN。
func rolling(x []float64, n int, f func(w []float64) float64) []float64 {
	out := nans(len(x))
	if n < 1 {
		return out
	}
	valid := 0 // 到 i 为止连续有效的根数
	for i, v := range x {
		if isNaN(v) {
			valid = 0
			continue
		}
		valid++
		if valid >= n {
			out[i] = f(x[i-n+1 : i+1])
		}
	}
	return out
}

// MA 简单移动平均：最近 n 根的算术平均。
// 用滚动和（遇到 NaN 从头再累），和回测引擎原来的 sma 逐位一致，回测对拍原型靠它，别改成每个窗口重新求和。
func MA(xs []float64, n int) []float64 {
	out := nans(len(xs))
	if n < 1 {
		return out
	}
	sum, cnt := 0.0, 0
	for i, x := range xs {
		if math.IsNaN(x) {
			sum, cnt = 0, 0
			continue
		}
		sum += x
		cnt++
		if cnt > n {
			sum -= xs[i-n]
			cnt = n
		}
		if cnt == n {
			out[i] = sum / float64(n)
		}
	}
	return out
}

// SUM 最近 n 根求和；n = 0 时从第一根累加到当前（通达信 SUM(X,0)），中间的 NaN 位置是 NaN、不打断累加。
func SUM(x []float64, n int) []float64 {
	if n == 0 {
		out := nans(len(x))
		s := 0.0
		for i, v := range x {
			if isNaN(v) {
				continue
			}
			s += v
			out[i] = s
		}
		return out
	}
	out := nans(len(x))
	if n < 1 {
		return out
	}
	sum, cnt := 0.0, 0
	for i, v := range x {
		if isNaN(v) {
			sum, cnt = 0, 0
			continue
		}
		sum += v
		cnt++
		if cnt > n {
			sum -= x[i-n]
			cnt = n
		}
		if cnt == n {
			out[i] = sum
		}
	}
	return out
}

// STD 估算标准差（样本标准差，除以 n-1），同通达信 STD。
func STD(x []float64, n int) []float64 {
	if n < 2 {
		return nans(len(x))
	}
	return stdWith(x, n, float64(n-1))
}

// STDP 总体标准差（除以 n），同通达信 STDP。
// 写法（先求滚动均值，再对窗口求离差平方和）和回测引擎原来的 stdev 逐位一致。
// MyTT 的 STD 是总体标准差（ddof=0），对照时对的是这个。
func STDP(x []float64, n int) []float64 { return stdWith(x, n, float64(n)) }

func stdWith(xs []float64, n int, den float64) []float64 {
	m := MA(xs, n)
	out := make([]float64, len(xs))
	for i := range xs {
		if math.IsNaN(m[i]) {
			out[i] = math.NaN()
			continue
		}
		s := 0.0
		for j := i - n + 1; j <= i; j++ {
			d := xs[j] - m[i]
			s += d * d
		}
		out[i] = math.Sqrt(s / den)
	}
	return out
}

// HHV 最近 n 根的最高值；n = 0 时从第一根算起。
func HHV(x []float64, n int) []float64 { return extreme(x, n, true) }

// LLV 最近 n 根的最低值；n = 0 时从第一根算起。
func LLV(x []float64, n int) []float64 { return extreme(x, n, false) }

func extreme(x []float64, n int, hi bool) []float64 {
	pick := func(w []float64) float64 {
		m := w[0]
		for _, v := range w[1:] {
			if (hi && v > m) || (!hi && v < m) {
				m = v
			}
		}
		return m
	}
	if n == 0 {
		out := nans(len(x))
		m := math.NaN()
		for i, v := range x {
			if isNaN(v) {
				continue
			}
			if isNaN(m) || (hi && v > m) || (!hi && v < m) {
				m = v
			}
			out[i] = m
		}
		return out
	}
	return rolling(x, n, pick)
}

// HHVBARS 最近 n 根里最高值到当前的根数（当前是最高为 0，并列取最近的那根）。
func HHVBARS(x []float64, n int) []float64 { return extremeBars(x, n, true) }

// LLVBARS 最近 n 根里最低值到当前的根数（并列取最近的那根）。
func LLVBARS(x []float64, n int) []float64 { return extremeBars(x, n, false) }

func extremeBars(x []float64, n int, hi bool) []float64 {
	return rolling(x, n, func(w []float64) float64 {
		best, at := w[len(w)-1], 0
		for k := 1; k < len(w); k++ {
			v := w[len(w)-1-k]
			if (hi && v > best) || (!hi && v < best) {
				best, at = v, k
			}
		}
		return float64(at)
	})
}

// smooth 是递推平滑 Y = a*X + (1-a)*Y'，以第一个有效值为初值；X 是 NaN 的位置输出 NaN、状态不变。
// a(i) 给出第 i 根的平滑因子。
func smooth(x []float64, a func(i int) float64) []float64 {
	out := nans(len(x))
	y := math.NaN()
	for i, v := range x {
		if isNaN(v) {
			continue
		}
		if isNaN(y) {
			y = v
		} else {
			k := a(i)
			y = k*v + (1-k)*y
		}
		out[i] = y
	}
	return out
}

// EMA 指数移动平均，同通达信 EMA(X,N)：Y = (2*X + (N-1)*Y') / (N+1)，即平滑因子 2/(N+1)；
// 初值是第一个有效值（不是前 N 根的均值，那是 TA-Lib 的口径，见 EMASeeded）。
// 初值的误差每根衰减 (N-1)/(N+1)，要稳定到小数点后 4 位一般要多给 4N 根以上。
func EMA(x []float64, n int) []float64 {
	if n < 1 {
		return nans(len(x))
	}
	k := 2 / float64(n+1)
	return smooth(x, func(int) float64 { return k })
}

// SMA 中国式移动平均（通达信 SMA(X,N,M)）：Y = (M*X + (N-M)*Y') / N，平滑因子 M/N，要求 0 < M <= N；初值是第一个有效值。
// 和 EMA 的区别只在平滑因子：EMA(X,N) 等于 SMA(X,N+1,2)；SMA(X,N,1) 就是 Wilder 平滑（RSI、KDJ 用）。
// 和西方的简单移动平均（这里的 MA）不是一回事。初值误差每根衰减 (N-M)/N，SMA(X,N,1) 预热要 5N 根以上。
func SMA(x []float64, n, m int) []float64 {
	if n < 1 || m < 1 || m > n {
		return nans(len(x))
	}
	k := float64(m) / float64(n)
	return smooth(x, func(int) float64 { return k })
}

// EMASeeded 是 TA-Lib 口径的 EMA：跳过前面的 NaN，用前 n 个值的均值做初值，从第 n 根开始有值，之后不再跳过 NaN。
// 回测引擎（原型 backtest.ts 的 ema）用的就是这个，策略里原有的 ema、macd 指标保持这个口径，回测结果才和原型一致。
// 写法和原来的 ema 逐位一致，别调换运算顺序。
func EMASeeded(xs []float64, n int) []float64 {
	out := nans(len(xs))
	if n < 1 {
		return out
	}
	k := 2 / float64(n+1)
	start := -1
	for i, x := range xs {
		if !math.IsNaN(x) {
			start = i
			break
		}
	}
	if start < 0 || start+n > len(xs) {
		return out
	}
	v := 0.0
	for i := start; i < start+n; i++ {
		v += xs[i]
	}
	v /= float64(n)
	start += n - 1
	out[start] = v
	for i := start + 1; i < len(xs); i++ {
		v = xs[i]*k + v*(1-k)
		out[i] = v
	}
	return out
}

// WMA 加权移动平均（通达信 WMA）：最近 n 根按 1..n 加权，越近权越大，除以 1+2+...+n。
func WMA(x []float64, n int) []float64 {
	den := float64(n*(n+1)) / 2
	return rolling(x, n, func(w []float64) float64 {
		s := 0.0
		for k, v := range w {
			s += float64(k+1) * v
		}
		return s / den
	})
}

// DMA 动态移动平均（通达信 DMA(X,A)）：Y = A*X + (1-A)*Y'，A 是常数，要求 0 < A <= 1，初值是第一个有效值。
func DMA(x []float64, a float64) []float64 {
	if !(a > 0 && a <= 1) {
		return nans(len(x))
	}
	return smooth(x, func(int) float64 { return a })
}

// DMAS 是平滑因子逐根变化的 DMA（A 是序列）。A 无效（NaN）或不在 (0,1] 的那根按 1 处理，即 Y 取当根的 X。
func DMAS(x, a []float64) []float64 {
	return smooth(x, func(i int) float64 {
		k := a[i]
		if !(k > 0 && k <= 1) {
			return 1
		}
		return k
	})
}

// AVEDEV 平均绝对偏差：最近 n 根与其均值之差的绝对值的平均。
func AVEDEV(x []float64, n int) []float64 {
	return rolling(x, n, func(w []float64) float64 {
		m := 0.0
		for _, v := range w {
			m += v
		}
		m /= float64(len(w))
		s := 0.0
		for _, v := range w {
			s += math.Abs(v - m)
		}
		return s / float64(len(w))
	})
}

// linreg 对窗口做最小二乘直线拟合（横坐标 0..n-1），回斜率和截距。
func linreg(w []float64) (slope, icpt float64) {
	n := float64(len(w))
	var sx, sy, sxx, sxy float64
	for k, v := range w {
		x := float64(k)
		sx += x
		sy += v
		sxx += x * x
		sxy += x * v
	}
	d := n*sxx - sx*sx
	if d == 0 {
		return 0, sy / n
	}
	slope = (n*sxy - sx*sy) / d
	return slope, (sy - slope*sx) / n
}

// SLOPE 最近 n 根线性回归的斜率（n >= 2）。
func SLOPE(x []float64, n int) []float64 {
	if n < 2 {
		return nans(len(x))
	}
	return rolling(x, n, func(w []float64) float64 { s, _ := linreg(w); return s })
}

// FORCAST 最近 n 根线性回归在当前这根的估计值（n >= 2）。
func FORCAST(x []float64, n int) []float64 {
	if n < 2 {
		return nans(len(x))
	}
	return rolling(x, n, func(w []float64) float64 { s, b := linreg(w); return s*float64(len(w)-1) + b })
}

// COUNT 最近 n 根里条件成立的根数；不够 n 根是 NaN；n = 0 从第一根数起。
func COUNT(cond []float64, n int) []float64 {
	c := make([]float64, len(cond))
	for i, v := range cond {
		c[i] = b2f(truthy(v))
	}
	return SUM(c, n)
}

// EVERY 最近 n 根条件都成立（1 / 0）；不够 n 根为 0。
func EVERY(cond []float64, n int) []float64 {
	cnt := COUNT(cond, n)
	return mapNaNZero(cnt, func(v float64) bool { return v == float64(n) })
}

// EXIST 最近 n 根条件至少成立一次（1 / 0）；不够 n 根为 0。
func EXIST(cond []float64, n int) []float64 {
	cnt := COUNT(cond, n)
	return mapNaNZero(cnt, func(v float64) bool { return v > 0 })
}

func mapNaNZero(x []float64, f func(float64) bool) []float64 {
	out := make([]float64, len(x))
	for i, v := range x {
		out[i] = b2f(!isNaN(v) && f(v))
	}
	return out
}

// LAST 从前 a 根到前 b 根条件一直成立（通达信 LAST(X,A,B)，要求 a >= b >= 0、a >= 1），1 / 0；不够 a 根为 0。
func LAST(cond []float64, a, b int) []float64 {
	out := make([]float64, len(cond))
	if a < 1 || b < 0 || b > a {
		return out
	}
	for i := a; i < len(cond); i++ {
		ok := true
		for k := b; k <= a; k++ {
			if !truthy(cond[i-k]) {
				ok = false
				break
			}
		}
		out[i] = b2f(ok)
	}
	return out
}

// FILTER 条件成立后，之后 n 根内的信号都去掉（通达信 FILTER(X,N)），1 / 0。
func FILTER(cond []float64, n int) []float64 {
	out := make([]float64, len(cond))
	until := -1
	for i, v := range cond {
		if i <= until || !truthy(v) {
			continue
		}
		out[i] = 1
		until = i + n
	}
	return out
}

// BARSLAST 上一次条件成立到当前的根数（当根成立为 0）；之前从没成立过的是 NaN。
func BARSLAST(cond []float64) []float64 {
	out := nans(len(cond))
	last := -1
	for i, v := range cond {
		if truthy(v) {
			last = i
		}
		if last >= 0 {
			out[i] = float64(i - last)
		}
	}
	return out
}

// BARSLASTCOUNT 条件连续成立的根数（当根不成立为 0）。
func BARSLASTCOUNT(cond []float64) []float64 {
	out := make([]float64, len(cond))
	for i, v := range cond {
		if truthy(v) {
			out[i] = 1
			if i > 0 {
				out[i] += out[i-1]
			}
		}
	}
	return out
}

// BARSSINCEN 最近 n 根里条件第一次成立到当前的根数；最近 n 根里没成立过为 0。前面不够 n 根时按已有的根数算。
func BARSSINCEN(cond []float64, n int) []float64 {
	out := make([]float64, len(cond))
	if n < 1 {
		return out
	}
	for i := range cond {
		for j := max(0, i-n+1); j <= i; j++ {
			if truthy(cond[j]) {
				out[i] = float64(i - j)
				break
			}
		}
	}
	return out
}

// CROSS 上穿：a 从下方（含相等）穿到 b 上方的那一根为 1。前一根任一是 NaN 不算穿越。
// MyTT 的 CROSS 在前一根无效时也可能报穿越（NaN 比较当假），对照时跳过两边都刚开始有值的那一根。
func CROSS(a, b []float64) []float64 {
	out := make([]float64, len(a))
	for i := 1; i < len(a); i++ {
		if isNaN(a[i-1]) || isNaN(b[i-1]) {
			continue
		}
		out[i] = b2f(a[i] > b[i] && !(a[i-1] > b[i-1]))
	}
	return out
}

// LONGCROSS 前 n 根 a 都在 b 下方、当根 a 上穿到 b 上方为 1（通达信 LONGCROSS(A,B,N)）。
func LONGCROSS(a, b []float64, n int) []float64 {
	below := LAST(lt(a, b), n, 1)
	out := make([]float64, len(a))
	for i := range a {
		out[i] = b2f(truthy(below[i]) && a[i] > b[i])
	}
	return out
}

// VALUEWHEN 条件成立时取 x 的当根值，否则沿用上一次成立时的值；之前从没成立过是 NaN。
func VALUEWHEN(cond, x []float64) []float64 {
	out := nans(len(cond))
	v := math.NaN()
	for i, c := range cond {
		if truthy(c) {
			v = x[i]
		}
		out[i] = v
	}
	return out
}

// BETWEEN x 在 a、b 之间（不含两端，a、b 谁大都行），1 / 0。
func BETWEEN(x, a, b []float64) []float64 {
	out := make([]float64, len(x))
	for i := range x {
		out[i] = b2f((a[i] < x[i] && x[i] < b[i]) || (a[i] > x[i] && x[i] > b[i]))
	}
	return out
}

// TOPRANGE 当前值是最近多少根里的最高（往前数连续不高于当前值的根数；前面全都不高于时是当前序号）。
// MyTT 在「前面全都低于」时回 0、并列时停下，对照只比两边定义一致的位置。
func TOPRANGE(x []float64) []float64 { return rangeOf(x, true) }

// LOWRANGE 当前值是最近多少根里的最低。
func LOWRANGE(x []float64) []float64 { return rangeOf(x, false) }

func rangeOf(x []float64, top bool) []float64 {
	out := make([]float64, len(x))
	for i := range x {
		k := 0
		for j := i - 1; j >= 0; j-- {
			if (top && x[j] > x[i]) || (!top && x[j] < x[i]) || isNaN(x[j]) {
				break
			}
			k++
		}
		out[i] = float64(k)
	}
	return out
}
