package video

import (
	"errors"
	"fmt"
	"strings"
)

// 扫码登录用的二维码（TSK-0455）：把 B 站给的登录地址编成 QR 码，出 SVG 给前端直接显示。
// 不加第三方依赖，按 ISO/IEC 18004 只做用得到的部分：字节模式、纠错级别 M、版本 1 到 10（最多约 210 个字节，
// 登录地址一百来个字符，落在版本 7、8）。掩码按四条罚分规则挑最低的。

// qrECM 是纠错级别 M 下各版本的分块：每块纠错码字数、第一组块数和每块数据码字、第二组块数和每块数据码字。
var qrECM = [11][5]int{
	{}, // 版本从 1 开始
	{10, 1, 16, 0, 0},
	{16, 1, 28, 0, 0},
	{26, 1, 44, 0, 0},
	{18, 2, 32, 0, 0},
	{24, 2, 43, 0, 0},
	{16, 4, 27, 0, 0},
	{18, 4, 31, 0, 0},
	{22, 2, 38, 2, 39},
	{22, 3, 36, 2, 37},
	{26, 4, 43, 1, 44},
}

// qrAlign 是各版本对齐图形的中心坐标。
var qrAlign = [11][]int{
	{}, {}, {6, 18}, {6, 22}, {6, 26}, {6, 30}, {6, 34}, {6, 22, 38}, {6, 24, 42}, {6, 26, 46}, {6, 28, 50},
}

var errQRTooLong = errors.New("二维码内容太长")

type qrMatrix struct {
	size int
	dark [][]bool
	fn   [][]bool // 功能图形，不放数据、不加掩码
}

// qrEncode 编码 text，回黑白矩阵（true 为黑）。
func qrEncode(text string) ([][]bool, error) {
	data := []byte(text)
	ver := 0
	for v := 1; v <= 10; v++ {
		b := qrECM[v]
		capBits := (b[1]*b[2] + b[3]*b[4]) * 8
		cc := 8
		if v >= 10 {
			cc = 16
		}
		if 4+cc+8*len(data) <= capBits {
			ver = v
			break
		}
	}
	if ver == 0 {
		return nil, errQRTooLong
	}
	cws := qrCodewords(ver, data)
	m := newQRMatrix(ver)
	m.drawFunctions(ver)
	m.drawCodewords(cws)
	best, bestScore := -1, 0
	var bestDark [][]bool
	for mask := 0; mask < 8; mask++ {
		c := m.clone()
		c.applyMask(mask)
		c.drawFormat(mask)
		if s := c.penalty(); best < 0 || s < bestScore {
			best, bestScore, bestDark = mask, s, c.dark
		}
	}
	return bestDark, nil
}

// qrCodewords 是加了纠错码、交织好的全部码字。
func qrCodewords(ver int, data []byte) []byte {
	b := qrECM[ver]
	total := b[1]*b[2] + b[3]*b[4]
	var bits []bool
	put := func(v, n int) {
		for i := n - 1; i >= 0; i-- {
			bits = append(bits, v>>i&1 == 1)
		}
	}
	put(0b0100, 4)
	if ver >= 10 {
		put(len(data), 16)
	} else {
		put(len(data), 8)
	}
	for _, c := range data {
		put(int(c), 8)
	}
	put(0, min(4, total*8-len(bits)))
	for len(bits)%8 != 0 {
		bits = append(bits, false)
	}
	out := make([]byte, 0, total)
	for i := 0; i < len(bits); i += 8 {
		var c byte
		for j := 0; j < 8; j++ {
			if bits[i+j] {
				c |= 1 << (7 - j)
			}
		}
		out = append(out, c)
	}
	for pad := byte(0xEC); len(out) < total; pad ^= 0xEC ^ 0x11 {
		out = append(out, pad)
	}
	// 分块、算纠错码
	var blocks, ecs [][]byte
	gen := rsGenerator(b[0])
	off := 0
	for g := 0; g < 2; g++ {
		for i := 0; i < b[1+2*g]; i++ {
			n := b[2+2*g]
			blk := out[off : off+n]
			off += n
			blocks = append(blocks, blk)
			ecs = append(ecs, rsRemainder(blk, gen))
		}
	}
	var res []byte
	for i := 0; i < max(b[2], b[4]); i++ {
		for _, blk := range blocks {
			if i < len(blk) {
				res = append(res, blk[i])
			}
		}
	}
	for i := 0; i < b[0]; i++ {
		for _, e := range ecs {
			res = append(res, e[i])
		}
	}
	return res
}

// GF(256)，本原多项式 0x11D。
func gfMul(x, y byte) byte {
	var z byte
	for i := 7; i >= 0; i-- {
		hi := z >> 7
		z = z<<1 ^ hi*0x1D
		z ^= (y >> i & 1) * x
	}
	return z
}

func rsGenerator(degree int) []byte {
	res := make([]byte, degree)
	res[degree-1] = 1
	root := byte(1)
	for i := 0; i < degree; i++ {
		for j := range res {
			res[j] = gfMul(res[j], root)
			if j+1 < len(res) {
				res[j] ^= res[j+1]
			}
		}
		root = gfMul(root, 0x02)
	}
	return res
}

func rsRemainder(data, gen []byte) []byte {
	res := make([]byte, len(gen))
	for _, d := range data {
		f := d ^ res[0]
		copy(res, res[1:])
		res[len(res)-1] = 0
		for i := range res {
			res[i] ^= gfMul(gen[i], f)
		}
	}
	return res
}

func newQRMatrix(ver int) *qrMatrix {
	size := ver*4 + 17
	m := &qrMatrix{size: size, dark: make([][]bool, size), fn: make([][]bool, size)}
	for i := range m.dark {
		m.dark[i] = make([]bool, size)
		m.fn[i] = make([]bool, size)
	}
	return m
}

func (m *qrMatrix) clone() *qrMatrix {
	c := newQRMatrix((m.size - 17) / 4)
	for y := range m.dark {
		copy(c.dark[y], m.dark[y])
		copy(c.fn[y], m.fn[y])
	}
	return c
}

func (m *qrMatrix) set(x, y int, dark bool) {
	m.dark[y][x] = dark
	m.fn[y][x] = true
}

func (m *qrMatrix) drawFunctions(ver int) {
	n := m.size
	for i := 0; i < n; i++ {
		m.set(6, i, i%2 == 0)
		m.set(i, 6, i%2 == 0)
	}
	for _, c := range [][2]int{{3, 3}, {n - 4, 3}, {3, n - 4}} {
		for dy := -4; dy <= 4; dy++ {
			for dx := -4; dx <= 4; dx++ {
				x, y := c[0]+dx, c[1]+dy
				if x < 0 || y < 0 || x >= n || y >= n {
					continue
				}
				d := max(abs(dx), abs(dy))
				m.set(x, y, d != 2 && d != 4)
			}
		}
	}
	al := qrAlign[ver]
	for i, ax := range al {
		for j, ay := range al {
			last := len(al) - 1
			if i == 0 && j == 0 || i == 0 && j == last || i == last && j == 0 {
				continue
			}
			for dy := -2; dy <= 2; dy++ {
				for dx := -2; dx <= 2; dx++ {
					m.set(ax+dx, ay+dy, max(abs(dx), abs(dy)) != 1)
				}
			}
		}
	}
	// 先占住格式信息的位置，挑完掩码再写
	m.drawFormat(0)
	if ver >= 7 {
		rem := ver
		for i := 0; i < 12; i++ {
			rem = rem<<1 ^ (rem>>11)*0x1F25
		}
		bits := ver<<12 | rem
		for i := 0; i < 18; i++ {
			bit := bits>>i&1 == 1
			a, b := n-11+i%3, i/3
			m.set(a, b, bit)
			m.set(b, a, bit)
		}
	}
}

// drawFormat 写格式信息：纠错级别 M（00）加掩码号，BCH 后异或 0x5412。
func (m *qrMatrix) drawFormat(mask int) {
	data := 0<<3 | mask
	rem := data
	for i := 0; i < 10; i++ {
		rem = rem<<1 ^ (rem>>9)*0x537
	}
	bits := (data<<10 | rem) ^ 0x5412
	bit := func(i int) bool { return bits>>i&1 == 1 }
	n := m.size
	for i := 0; i <= 5; i++ {
		m.set(8, i, bit(i))
	}
	m.set(8, 7, bit(6))
	m.set(8, 8, bit(7))
	m.set(7, 8, bit(8))
	for i := 9; i < 15; i++ {
		m.set(14-i, 8, bit(i))
	}
	for i := 0; i < 8; i++ {
		m.set(n-1-i, 8, bit(i))
	}
	for i := 8; i < 15; i++ {
		m.set(8, n-15+i, bit(i))
	}
	m.set(8, n-8, true)
}

func (m *qrMatrix) drawCodewords(data []byte) {
	n := m.size
	i := 0
	for right := n - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for vert := 0; vert < n; vert++ {
			for j := 0; j < 2; j++ {
				x := right - j
				y := vert
				if (right+1)&2 == 0 {
					y = n - 1 - vert
				}
				if !m.fn[y][x] && i < len(data)*8 {
					m.dark[y][x] = data[i>>3]>>(7-i&7)&1 == 1
					i++
				}
			}
		}
	}
}

func (m *qrMatrix) applyMask(mask int) {
	for y := 0; y < m.size; y++ {
		for x := 0; x < m.size; x++ {
			if m.fn[y][x] {
				continue
			}
			var inv bool
			switch mask {
			case 0:
				inv = (x+y)%2 == 0
			case 1:
				inv = y%2 == 0
			case 2:
				inv = x%3 == 0
			case 3:
				inv = (x+y)%3 == 0
			case 4:
				inv = (x/3+y/2)%2 == 0
			case 5:
				inv = x*y%2+x*y%3 == 0
			case 6:
				inv = (x*y%2+x*y%3)%2 == 0
			default:
				inv = ((x+y)%2+x*y%3)%2 == 0
			}
			if inv {
				m.dark[y][x] = !m.dark[y][x]
			}
		}
	}
}

// penalty 是四条罚分之和：同色连续 5 个以上、2x2 同色块、类似定位图形的 1:1:3:1:1、黑白比例偏离一半。
func (m *qrMatrix) penalty() int {
	n := m.size
	score := 0
	at := func(x, y int, row bool) bool {
		if row {
			return m.dark[y][x]
		}
		return m.dark[x][y]
	}
	for _, row := range []bool{true, false} {
		for y := 0; y < n; y++ {
			run := 1
			for x := 1; x <= n; x++ {
				if x < n && at(x, y, row) == at(x-1, y, row) {
					run++
					continue
				}
				if run >= 5 {
					score += 3 + run - 5
				}
				run = 1
			}
			for x := 0; x+10 < n; x++ {
				p := [11]bool{}
				for k := range p {
					p[k] = at(x+k, y, row)
				}
				core := p[0] && !p[1] && p[2] && p[3] && p[4] && !p[5] && p[6]
				if core && !p[7] && !p[8] && !p[9] && !p[10] {
					score += 40
				}
				core2 := p[4] && !p[5] && p[6] && p[7] && p[8] && !p[9] && p[10]
				if core2 && !p[0] && !p[1] && !p[2] && !p[3] {
					score += 40
				}
			}
		}
	}
	darkN := 0
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			if m.dark[y][x] {
				darkN++
			}
			if x+1 < n && y+1 < n {
				c := m.dark[y][x]
				if m.dark[y][x+1] == c && m.dark[y+1][x] == c && m.dark[y+1][x+1] == c {
					score += 3
				}
			}
		}
	}
	total := n * n
	k := (abs(darkN*20-total*10) + total - 1) / total
	return score + max(0, k-1)*10
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// qrSVG 把 text 编成二维码，回 SVG 文本（四格静区，白底黑块）。
func qrSVG(text string) (string, error) {
	mat, err := qrEncode(text)
	if err != nil {
		return "", err
	}
	n := len(mat) + 8
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`, n, n)
	fmt.Fprintf(&b, `<rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n, n)
	for y, row := range mat {
		for x, d := range row {
			if d {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x+4, y+4)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}
