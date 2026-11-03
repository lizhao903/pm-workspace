// Package kb 是知识库（AG-01b3）的切块、拆词、打分和来源同步。
//
// 切块和打分逐行照搬原型 web-next/src/kbdata.ts 的 splitChunks、queryTerms、searchKb，
// 位置按字符（rune）算；原型按 UTF-16 码元算，两边只在 BMP 以外的字符（如 emoji）上有差别。
// 检索只做关键词，不做向量：嵌入模型的设置照存不用。
package kb

import "strings"

// Chunk 是正文里的一段，[Start, End) 是字符位置。
type Chunk struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Split 按段长切；尽量在段长 60% 之后的换行、句号、分号处断开，相邻两段重叠 overlap 字（不超过段长一半）。
func Split(text string, size, overlap int) []Chunk {
	out := []Chunk{}
	if strings.TrimSpace(text) == "" || size <= 0 {
		return out
	}
	rs := []rune(text)
	n := len(rs)
	ov := max(0, min(overlap, size/2))
	head := size * 6 / 10
	start := 0
	for start < n {
		end := min(start+size, n)
		if end < n && start+head < end {
			cut := lastCut(rs[start+head : end])
			if cut >= 0 {
				end = start + head + cut + 1
			}
		}
		out = append(out, Chunk{Start: start, End: end})
		if end >= n {
			break
		}
		start = max(end-ov, start+1)
	}
	return out
}

// lastCut 是窗口里最后一个换行、句号或分号的位置，没有回 -1。
func lastCut(win []rune) int {
	for i := len(win) - 1; i >= 0; i-- {
		switch win[i] {
		case '\n', '。', '；':
			return i
		}
	}
	return -1
}

// Slice 取 [c.Start, c.End) 这一段。
func Slice(text string, c Chunk) string {
	rs := []rune(text)
	return string(rs[min(c.Start, len(rs)):min(c.End, len(rs))])
}
