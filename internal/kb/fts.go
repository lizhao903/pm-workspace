// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package kb

import (
	"regexp"
	"strings"
)

// FTS5 只做候选预筛，打分仍走 Score，所以预筛必须是「正文含某个检索词」的超集，不能漏：
//   - 中文检索词是两个汉字，正文里出现它当且仅当它是正文某个汉字串的相邻两字，索引全部相邻两字；
//   - 英文检索词只由 [a-z0-9.-] 组成，出现在正文里就一定落在某个 [a-z0-9.-] 连续串里，
//     是这个串某个后缀的前缀，所以索引每个串的全部后缀，查询用前缀匹配；
//   - 太长的串（链接、哈希）不展开后缀，记一个 LongToken，查询有英文词时总带上它。
// 建表用 unicode61 加 tokenchars '.-'，让「object.export」这样的词不被点号拆开。

// FTSTokenize 是 kb_chunks_fts 的分词设置。
const FTSTokenize = `unicode61 tokenchars '.-'`

// LongToken 标记这一段里有超长的英文串。
const LongToken = "kbxlongrun"

const maxRun = 128

var runRe = regexp.MustCompile(`[a-z0-9.-]+`)

// IndexTokens 是一段正文写进 FTS 的词，空格分隔。
func IndexTokens(body string) string {
	low := strings.ToLower(body)
	seen := map[string]bool{}
	var b strings.Builder
	add := func(t string) {
		if t == "" || seen[t] {
			return
		}
		seen[t] = true
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(t)
	}
	for _, run := range hanRe.FindAllString(low, -1) {
		rs := []rune(run)
		for i := 0; i+1 < len(rs); i++ {
			add(string(rs[i : i+2]))
		}
	}
	for _, run := range runRe.FindAllString(low, -1) {
		if len(run) > maxRun {
			add(LongToken)
			continue
		}
		for i := range len(run) {
			if c := run[i]; c != '.' && c != '-' {
				add(run[i:])
			}
		}
	}
	return b.String()
}

// MatchQuery 是 terms 的 FTS5 查询：任何一个词命中即可。terms 为空回空串。
func MatchQuery(terms []string) string {
	parts := []string{}
	english := false
	for _, t := range terms {
		if hanRe.MatchString(t) {
			parts = append(parts, `"`+t+`"`)
			continue
		}
		english = true
		parts = append(parts, `"`+t+`"*`)
	}
	if english {
		parts = append(parts, LongToken)
	}
	return strings.Join(parts, " OR ")
}
