// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package ta

import "math"

// 技术指标（TRD-10），公式按通达信的系统指标公式，参数默认值同通达信。
// 每个指标回若干条线，顺序同通达信的输出顺序；说明里写了和 MyTT 的口径差异（如有）。

// OHLCV 是指标的输入，五列等长、按时间正序。
type OHLCV struct {
	O, H, L, C, V []float64
}

// MACD(SHORT=12, LONG=26, M=9)：DIF = EMA(C,SHORT) - EMA(C,LONG)，DEA = EMA(DIF,M)，MACD = (DIF-DEA)*2。
func MACD(c []float64, short, long, m int) (dif, dea, bar []float64) {
	dif = sub(EMA(c, short), EMA(c, long))
	dea = EMA(dif, m)
	bar = scale(sub(dif, dea), 2)
	return
}

// KDJ(N=9, M1=3, M2=3)：RSV = (C - LLV(L,N)) / (HHV(H,N) - LLV(L,N)) * 100，K = SMA(RSV,M1,1)，D = SMA(K,M2,1)，J = 3K - 2D。
// 最高等于最低（RSV 除以 0）的那根 RSV 无效，K、D 在那根是 NaN、递推沿用上一根。
func KDJ(c, h, l []float64, n, m1, m2 int) (k, d, j []float64) {
	ll := LLV(l, n)
	rsv := scale(div(sub(c, ll), sub(HHV(h, n), ll)), 100)
	k = SMA(rsv, m1, 1)
	d = SMA(k, m2, 1)
	j = sub(scale(k, 3), scale(d, 2))
	return
}

// RSI(N=6)：LC = REF(C,1)，RSI = SMA(MAX(C-LC,0),N,1) / SMA(ABS(C-LC),N,1) * 100。
// 注意这是通达信口径（中国式 SMA，初值取第一个差值）；策略里原有的 rsi 是回测原型的口径（Wilder 平滑、前 N 个均值做初值），两者预热后趋同。
func RSI(c []float64, n int) []float64 {
	d := DIFF(c, 1)
	up := mapf(d, func(x float64) float64 { return math.Max(x, 0) })
	return scale(div(SMA(up, n, 1), SMA(absf(d), n, 1)), 100)
}

// WR(N=10)：100 * (HHV(H,N) - C) / (HHV(H,N) - LLV(L,N))。通达信 WR 指标出两条线，N=10 和 N1=6。
func WR(c, h, l []float64, n int) []float64 {
	hh := HHV(h, n)
	return scale(div(sub(hh, c), sub(hh, LLV(l, n))), 100)
}

// BIAS(N)：(C - MA(C,N)) / MA(C,N) * 100。通达信 BIAS 出三条线，N 默认 6、12、24。
func BIAS(c []float64, n int) []float64 {
	m := MA(c, n)
	return scale(div(sub(c, m), m), 100)
}

// BOLL(N=20, P=2)：MID = MA(C,N)，UPPER = MID + P*STDP(C,N)，LOWER = MID - P*STDP(C,N)。
// 标准差用总体标准差（STDP，除以 N）：和布林带的原始定义、同花顺、MyTT、回测原型一致。
// 通达信的 BOLL 系统公式写的是 STD（估算标准差，除以 N-1），带宽比这里宽 sqrt(N/(N-1)) 倍（N=20 时约 2.6%）。
func BOLL(c []float64, n int, p float64) (mid, upper, lower []float64) {
	mid = MA(c, n)
	sd := STDP(c, n)
	upper = zip(mid, sd, func(m, s float64) float64 { return m + p*s })
	lower = zip(mid, sd, func(m, s float64) float64 { return m - p*s })
	return
}

// PSY(N=12, M=6)：PSY = COUNT(C > REF(C,1), N) / N * 100，PSYMA = MA(PSY,M)。
func PSY(c []float64, n, m int) (psy, psyma []float64) {
	psy = scale(COUNT(gt(c, REF(c, 1)), n), 100/float64(n))
	psyma = MA(psy, m)
	return
}

// CCI(N=14)：TYP = (H+L+C)/3，CCI = (TYP - MA(TYP,N)) / (0.015 * AVEDEV(TYP,N))。
func CCI(c, h, l []float64, n int) []float64 {
	typ := typical(c, h, l)
	return div(sub(typ, MA(typ, n)), scale(AVEDEV(typ, n), 0.015))
}

func typical(c, h, l []float64) []float64 { return scale(add(add(h, l), c), 1.0/3) }

// TR 真实波幅：MAX(MAX(H-L, ABS(REF(C,1)-H)), ABS(REF(C,1)-L))，第一根没有昨收是 NaN。
func TR(c, h, l []float64) []float64 {
	lc := REF(c, 1)
	return maxf(maxf(sub(h, l), absf(sub(lc, h))), absf(sub(lc, l)))
}

// ATR(N=14)：MA(TR,N)，通达信口径是简单平均。策略里原有的 atr 是 Wilder 平滑（回测原型口径），不是这个。
func ATR(c, h, l []float64, n int) []float64 { return MA(TR(c, h, l), n) }

// BBI(3,6,12,24)：四条均线的平均。
func BBI(c []float64, m1, m2, m3, m4 int) []float64 {
	s := add(add(MA(c, m1), MA(c, m2)), add(MA(c, m3), MA(c, m4)))
	return scale(s, 0.25)
}

// DMI(M1=14, M2=6)：
// MTR = SUM(TR, M1)；HD = H - REF(H,1)，LD = REF(L,1) - L；
// DMP = SUM(IF(HD>0 AND HD>LD, HD, 0), M1)，DMM = SUM(IF(LD>0 AND LD>HD, LD, 0), M1)；
// PDI = DMP*100/MTR，MDI = DMM*100/MTR，ADX = MA(ABS(MDI-PDI)/(MDI+PDI)*100, M2)，ADXR = (ADX + REF(ADX,M2)) / 2。
func DMI(c, h, l []float64, m1, m2 int) (pdi, mdi, adx, adxr []float64) {
	mtr := SUM(TR(c, h, l), m1)
	hd := sub(h, REF(h, 1))
	ld := sub(REF(l, 1), l)
	n := len(c)
	zero := konst(n, 0)
	dmp := SUM(iff(andf(gt(hd, zero), gt(hd, ld)), hd, zero), m1)
	dmm := SUM(iff(andf(gt(ld, zero), gt(ld, hd)), ld, zero), m1)
	pdi = div(scale(dmp, 100), mtr)
	mdi = div(scale(dmm, 100), mtr)
	adx = MA(scale(div(absf(sub(mdi, pdi)), add(mdi, pdi)), 100), m2)
	adxr = scale(add(adx, REF(adx, m2)), 0.5)
	return
}

func andf(a, b []float64) []float64 {
	out := make([]float64, len(a))
	for i := range a {
		out[i] = b2f(truthy(a[i]) && truthy(b[i]))
	}
	return out
}

// TAQ(N=20) 唐奇安通道：UP = HHV(H,N)，DOWN = LLV(L,N)，MID = (UP+DOWN)/2。
func TAQ(h, l []float64, n int) (up, mid, down []float64) {
	up, down = HHV(h, n), LLV(l, n)
	mid = scale(add(up, down), 0.5)
	return
}

// KTN(N=20, M=10) 肯特纳通道：MID = EMA((H+L+C)/3, N)，ATRN = ATR(M)，UPPER = MID + 2*ATRN，LOWER = MID - 2*ATRN。
func KTN(c, h, l []float64, n, m int) (upper, mid, lower []float64) {
	mid = EMA(typical(c, h, l), n)
	atr := ATR(c, h, l, m)
	upper = add(mid, scale(atr, 2))
	lower = sub(mid, scale(atr, 2))
	return
}

// TRIX(N=12, M=20)：TR = EMA(EMA(EMA(C,N),N),N)，TRIX = (TR - REF(TR,1)) / REF(TR,1) * 100，MATRIX = MA(TRIX,M)。
func TRIX(c []float64, n, m int) (trix, matrix []float64) {
	tr := EMA(EMA(EMA(c, n), n), n)
	prev := REF(tr, 1)
	trix = scale(div(sub(tr, prev), prev), 100)
	matrix = MA(trix, m)
	return
}

// VR(N=26) 成交量变异率，通达信口径：TH、TL、TQ 是 N 根内收涨、收跌、平盘的成交量之和，VR = 100*(2*TH + TQ) / (2*TL + TQ)。
// MyTT 的 VR 是 100*TH/(TL+TQ)（平盘量全算到下跌一边），没有平盘时两者相同。
func VR(c, v []float64, n int) []float64 {
	lc := REF(c, 1)
	zero := konst(len(c), 0)
	eq := make([]float64, len(c))
	for i := range c {
		eq[i] = b2f(c[i] == lc[i])
	}
	th := SUM(iff(gt(c, lc), v, zero), n)
	tl := SUM(iff(lt(c, lc), v, zero), n)
	tq := SUM(iff(eq, v, zero), n)
	num := add(scale(th, 2), tq)
	den := add(scale(tl, 2), tq)
	return scale(div(num, den), 100)
}

// CR(N=26) 能量指标，通达信口径：MID = REF(H+L, 1) / 2，CR = SUM(MAX(0, H-MID), N) / SUM(MAX(0, MID-L), N) * 100。
// MyTT 的 CR 中间价用 REF(H+L+C, 1) / 3，数值不同；对照时对的是 crWith 换成那个中间价的结果。
func CR(c, h, l []float64, n int) []float64 {
	return crWith(h, l, scale(REF(add(h, l), 1), 0.5), n)
}

func crWith(h, l, mid []float64, n int) []float64 {
	zero := konst(len(h), 0)
	up := SUM(maxf(zero, sub(h, mid)), n)
	dn := SUM(maxf(zero, sub(mid, l)), n)
	return scale(div(up, dn), 100)
}

// EMV(N=14, M=9) 简易波动指标：VOLUME = MA(V,N)/V，MID = 100*(H+L-REF(H+L,1))/(H+L)，
// EMV = MA(MID*VOLUME*(H-L)/MA(H-L,N), N)，MAEMV = MA(EMV,M)。
func EMV(h, l, v []float64, n, m int) (emv, maemv []float64) {
	vol := div(MA(v, n), v)
	hl := add(h, l)
	mid := div(scale(sub(hl, REF(hl, 1)), 100), hl)
	rng := sub(h, l)
	emv = MA(div(mul(mul(mid, vol), rng), MA(rng, n)), n)
	maemv = MA(emv, m)
	return
}

// DPO(N=20, M=6) 区间震荡线：DPO = C - REF(MA(C,N), N/2+1)（N/2 取整），MADPO = MA(DPO,M)。
// MyTT 的 DPO 把往前错的根数做成单独参数（默认 10），对照时传 N/2+1。
func DPO(c []float64, n, m int) (dpo, madpo []float64) {
	dpo = sub(c, REF(MA(c, n), n/2+1))
	madpo = MA(dpo, m)
	return
}

// BRAR(N=26) 情绪指标：BR = SUM(MAX(0, H-REF(C,1)), N) / SUM(MAX(0, REF(C,1)-L), N) * 100，
// AR = SUM(H-O, N) / SUM(O-L, N) * 100。输出顺序 BR、AR。
func BRAR(o, c, h, l []float64, n int) (br, ar []float64) {
	lc := REF(c, 1)
	zero := konst(len(c), 0)
	br = scale(div(SUM(maxf(zero, sub(h, lc)), n), SUM(maxf(zero, sub(lc, l)), n)), 100)
	ar = scale(div(SUM(sub(h, o), n), SUM(sub(o, l), n)), 100)
	return
}

// DFMA(N1=10, N2=50, M=10) 平行线差（通达信系统指标叫 DMA，和 DMA 函数同名，这里改叫 DFMA）：
// DIF = MA(C,N1) - MA(C,N2)，DIFMA = MA(DIF,M)。
func DFMA(c []float64, n1, n2, m int) (dif, difma []float64) {
	dif = sub(MA(c, n1), MA(c, n2))
	difma = MA(dif, m)
	return
}

// MTM(N=12, M=6) 动量：MTM = C - REF(C,N)，MTMMA = MA(MTM,M)。
func MTM(c []float64, n, m int) (mtm, mtmma []float64) {
	mtm = sub(c, REF(c, n))
	mtmma = MA(mtm, m)
	return
}

// MASS(N1=9, N2=25, M=6) 梅斯线：MASS = SUM(MA(H-L,N1) / MA(MA(H-L,N1),N1), N2)，MAMASS = MA(MASS,M)。
func MASS(h, l []float64, n1, n2, m int) (mass, mamass []float64) {
	a := MA(sub(h, l), n1)
	mass = SUM(div(a, MA(a, n1)), n2)
	mamass = MA(mass, m)
	return
}

// ROC(N=12, M=6) 变动率：ROC = 100 * (C - REF(C,N)) / REF(C,N)，MAROC = MA(ROC,M)。
func ROC(c []float64, n, m int) (roc, maroc []float64) {
	prev := REF(c, n)
	roc = scale(div(sub(c, prev), prev), 100)
	maroc = MA(roc, m)
	return
}

// OBV(M=30) 能量潮：收涨加当根成交量、收跌减、平盘不变，从第一根累加（第一根没有昨收记 0）；MAOBV = MA(OBV,M)。
// 单位是成交量本身；MyTT 的 OBV 除了 10000（按万手显示），对照时乘回。
func OBV(c, v []float64, m int) (obv, maobv []float64) {
	lc := REF(c, 1)
	step := make([]float64, len(c))
	for i := range c {
		switch {
		case c[i] > lc[i]:
			step[i] = v[i]
		case c[i] < lc[i]:
			step[i] = -v[i]
		}
	}
	obv = SUM(step, 0)
	maobv = MA(obv, m)
	return
}

// MFI(N=14) 资金流量指标：TYP = (H+L+C)/3，V1 = SUM(IF(TYP>REF(TYP,1), TYP*V, 0), N) / SUM(IF(TYP<REF(TYP,1), TYP*V, 0), N)，
// MFI = 100 - 100/(1+V1)。
func MFI(c, h, l, v []float64, n int) []float64 {
	typ := typical(c, h, l)
	prev := REF(typ, 1)
	zero := konst(len(c), 0)
	tv := mul(typ, v)
	v1 := div(SUM(iff(gt(typ, prev), tv, zero), n), SUM(iff(lt(typ, prev), tv, zero), n))
	return mapf(v1, func(x float64) float64 { return 100 - 100/(1+x) })
}

// ASI(M1=26, M2=10) 振动升降指标，通达信系统公式：
// LC = REF(C,1)，AA = ABS(H-LC)，BB = ABS(L-LC)，CC = ABS(H-REF(L,1))，DD = ABS(LC-REF(O,1))；
// R = IF(AA>BB AND AA>CC, AA+BB/2+DD/4, IF(BB>CC AND BB>AA, BB+AA/2+DD/4, CC+DD/4))；
// X = C-LC + (C-O)/2 + LC-REF(O,1)；SI = 16*X/R*MAX(AA,BB)；ASI = SUM(SI,M1)，ASIT = MA(ASI,M2)。
func ASI(o, c, h, l []float64, m1, m2 int) (asi, asit []float64) {
	lc := REF(c, 1)
	po := REF(o, 1)
	aa := absf(sub(h, lc))
	bb := absf(sub(l, lc))
	cc := absf(sub(h, REF(l, 1)))
	dd := absf(sub(lc, po))
	n := len(c)
	r := make([]float64, n)
	for i := range r {
		switch {
		case aa[i] > bb[i] && aa[i] > cc[i]:
			r[i] = aa[i] + bb[i]/2 + dd[i]/4
		case bb[i] > cc[i] && bb[i] > aa[i]:
			r[i] = bb[i] + aa[i]/2 + dd[i]/4
		default:
			r[i] = cc[i] + dd[i]/4
		}
	}
	x := add(add(sub(c, lc), scale(sub(c, o), 0.5)), sub(lc, po))
	si := mul(div(scale(x, 16), r), maxf(aa, bb))
	asi = SUM(si, m1)
	asit = MA(asi, m2)
	return
}

// XSII(N=102, M=7) 薛斯通道 II，通达信系统公式：
// AA = MA((2C+H+L)/4, 5)，TD1 = AA*N/100，TD2 = AA*(200-N)/100；
// CC = ABS((2C+H+L)/4 - MA(C,20)) / MA(C,20)，DD = DMA(C, CC)，TD3 = (1+M/100)*DD，TD4 = (1-M/100)*DD。
// DD 的平滑因子 CC 在前 19 根无效，按 DMAS 的约定那几根 DD 取当根收盘价。
func XSII(c, h, l []float64, n, m float64) (td1, td2, td3, td4 []float64) {
	p := scale(add(scale(c, 2), add(h, l)), 0.25)
	aa := MA(p, 5)
	td1 = scale(aa, n/100)
	td2 = scale(aa, (200-n)/100)
	ma20 := MA(c, 20)
	cc := div(absf(sub(p, ma20)), ma20)
	dd := DMAS(c, cc)
	td3 = scale(dd, 1+m/100)
	td4 = scale(dd, 1-m/100)
	return
}
