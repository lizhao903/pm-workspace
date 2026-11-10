// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package trade

import (
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// 模拟盘账本的定点数（TRD-05a）：金额、数量、价格、手续费都是按 1e8 放大的 int64，库里存 INTEGER（列名带 _e8）。
// 记账只做整数加减；乘除走 big.Int，最后一步四舍五入（正好一半时远离零）。浮点只出现在两处：
// 行情给的价格进账本时换一次（fxFromFloat），接口回给前端时转成 JSON 数字（Float）。
// 量级：int64 上限约 9.2e18，放大后能表示到 9.2e10，单个价格、数量、金额都要在这以内，乘出来超了回 errFxRange。

type fx int64

const fxScale = 100_000_000

var (
	fxScaleBig = big.NewInt(fxScale)
	errFxRange = errors.New("数值超出账本能表示的范围")
)

// fxMax 是接口收进来的单个数（价格、数量、资金）的上限：1e10。
const fxMax = fx(1e10 * fxScale)

func fxInt(n int64) fx { return fx(n * fxScale) }

// fxFromFloat 把浮点数换成定点，四舍五入到 1e-8；非有限数或超范围回 false。
func fxFromFloat(f float64) (fx, bool) {
	if !finite(f) || math.Abs(f) >= 9e10 {
		return 0, false
	}
	// 先按十进制最短表示转字符串再解析，避免 0.1*1e8 这类二进制误差
	v, err := parseFx(strconv.FormatFloat(f, 'f', -1, 64))
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseFx 解析十进制字符串（可带负号），小数超过 8 位时四舍五入。
func parseFx(s string) (fx, error) {
	s = strings.TrimSpace(s)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	ip, fp, _ := strings.Cut(s, ".")
	if ip == "" {
		ip = "0"
	}
	if !isDigits(ip) || (fp != "" && !isDigits(fp)) {
		return 0, errors.New("不是十进制数：" + s)
	}
	round := false
	if len(fp) > 8 {
		round = fp[8] >= '5'
		fp = fp[:8]
	}
	fp += strings.Repeat("0", 8-len(fp))
	n, ok := new(big.Int).SetString(strings.TrimLeft(ip+fp, "0")+"0", 10)
	if !ok {
		return 0, errors.New("不是十进制数：" + s)
	}
	n.Quo(n, big.NewInt(10))
	if round {
		n.Add(n, big.NewInt(1))
	}
	if neg {
		n.Neg(n)
	}
	if !n.IsInt64() {
		return 0, errFxRange
	}
	return fx(n.Int64()), nil
}

// Float 转成浮点，只给接口输出用。
func (a fx) Float() float64 { return float64(a) / fxScale }

// String 是精确的十进制表示，去掉末尾的 0（对账接口用）。
func (a fx) String() string {
	neg := a < 0
	u := new(big.Int).Abs(big.NewInt(int64(a)))
	q, r := new(big.Int).QuoRem(u, fxScaleBig, new(big.Int))
	s := q.String()
	if r.Sign() != 0 {
		fs := r.String()
		fs = strings.Repeat("0", 8-len(fs)) + fs
		s += "." + strings.TrimRight(fs, "0")
	}
	if neg {
		s = "-" + s
	}
	return s
}

func (a fx) abs() fx {
	if a < 0 {
		return -a
	}
	return a
}

func (a fx) sign() int64 {
	switch {
	case a > 0:
		return 1
	case a < 0:
		return -1
	}
	return 0
}

// divRound 是 n / d 四舍五入（正好一半远离零），d 不为 0。
func divRound(n, d *big.Int) *big.Int {
	q, r := new(big.Int).QuoRem(n, d, new(big.Int))
	// |r| * 2 >= |d| 时远离零进一
	r2 := new(big.Int).Abs(r)
	r2.Lsh(r2, 1)
	if r2.Cmp(new(big.Int).Abs(d)) >= 0 {
		if (n.Sign() < 0) != (d.Sign() < 0) {
			q.Sub(q, big.NewInt(1))
		} else {
			q.Add(q, big.NewInt(1))
		}
	}
	return q
}

func toFx(n *big.Int) (fx, error) {
	if !n.IsInt64() {
		return 0, errFxRange
	}
	return fx(n.Int64()), nil
}

// fxMul 是 a × b（两个定点相乘）。
func fxMul(a, b fx) (fx, error) {
	n := new(big.Int).Mul(big.NewInt(int64(a)), big.NewInt(int64(b)))
	return toFx(divRound(n, fxScaleBig))
}

// fxMul3 是 a × b × c，只在最后舍入一次（数量 × 价格 × 乘数）。
func fxMul3(a, b, c fx) (fx, error) {
	n := new(big.Int).Mul(big.NewInt(int64(a)), big.NewInt(int64(b)))
	n.Mul(n, big.NewInt(int64(c)))
	return toFx(divRound(n, new(big.Int).Mul(fxScaleBig, fxScaleBig)))
}

// fxMulDiv 是 a × b / c（c 不为 0），只在最后舍入一次。
func fxMulDiv(a, b, c fx) (fx, error) {
	if c == 0 {
		return 0, errors.New("除数为 0")
	}
	n := new(big.Int).Mul(big.NewInt(int64(a)), big.NewInt(int64(b)))
	return toFx(divRound(n, big.NewInt(int64(c))))
}

// fxDiv 是 a / b（两个定点相除）。
func fxDiv(a, b fx) (fx, error) {
	if b == 0 {
		return 0, errors.New("除数为 0")
	}
	n := new(big.Int).Mul(big.NewInt(int64(a)), fxScaleBig)
	return toFx(divRound(n, big.NewInt(int64(b))))
}

// floorLot 把数量按最小下单量向下取整（lot 大于 0）。
func floorLot(q, lot fx) fx {
	if lot <= 0 {
		return q
	}
	return q / lot * lot
}

// pow10fx 是 10^-d 的定点（一跳），d 超过 8 位按 8 位。
func pow10fx(d int) fx {
	d = max(0, min(8, d))
	v := fx(fxScale)
	for range d {
		v /= 10
	}
	return v
}
