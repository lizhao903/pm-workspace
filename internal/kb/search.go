package kb

import (
	"regexp"
	"sort"
	"strings"
)

// 打分口径和原型 searchKb 一致：命中的检索词占比，标题也命中再加 0.08，封顶 1，低于 0.15 不算。
const (
	titleBonus = 0.08
	minScore   = 0.15
	// DefaultTop 是不给条数时返回几段（SPEC-settings-12.2「列前 5 段」）。
	DefaultTop = 5
)

// stop 是两字一组拆出来没有检索意义的组合，和原型 STOP 一致。
var stop = map[string]bool{}

func init() {
	for _, w := range strings.Fields("什么 怎么 哪些 哪个 是不 不是 能不 不能 可以 一下 我们 这个 那个 有没 没有 多久 要不 的时 时候 一个 现在 还是 了吗 是什 么时 要做 做到 到哪 哪一 一步") {
		stop[w] = true
	}
}

var (
	wordRe = regexp.MustCompile(`[a-z0-9][a-z0-9.-]+`)
	hanRe  = regexp.MustCompile(`[\x{4e00}-\x{9fff}]+`)
)

// Terms 把问题拆成检索词：英文按词，中文按两字一组，去掉停用的组合；按出现顺序去重。
func Terms(q string) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for _, w := range wordRe.FindAllString(strings.ToLower(q), -1) {
		add(w)
	}
	for _, run := range hanRe.FindAllString(q, -1) {
		rs := []rune(run)
		for i := 0; i+1 < len(rs); i++ {
			if b := string(rs[i : i+2]); !stop[b] {
				add(b)
			}
		}
	}
	return out
}

// Score 给一段打分：terms 里在正文出现的占比，标题也命中任何一个检索词加 0.08。
// got 是在正文里命中的词，按 terms 的顺序；ok 为 false 表示这段不算命中。
func Score(terms []string, title, body string) (score float64, got []string, ok bool) {
	if len(terms) == 0 {
		return 0, nil, false
	}
	body = strings.ToLower(body)
	for _, t := range terms {
		if strings.Contains(body, t) {
			got = append(got, t)
		}
	}
	if len(got) == 0 {
		return 0, nil, false
	}
	title = strings.ToLower(title)
	bonus := 0.0
	for _, t := range terms {
		if strings.Contains(title, t) {
			bonus = titleBonus
			break
		}
	}
	score = min(1, float64(len(got))/float64(len(terms))+bonus)
	return score, got, score >= minScore
}

// Candidate 是一段可能命中的切块，按「文档的排列顺序、段序号」给进来。
type Candidate struct {
	DocID string
	Title string
	Index int
	Chunk Chunk
	Text  string
}

// Hit 是一段命中。
type Hit struct {
	Candidate
	Score float64
	Terms []string
}

// Rank 给候选打分，按分数从高到低取前 top 段；分数相同保持候选的原顺序（原型的 sort 是稳定的）。
func Rank(cands []Candidate, terms []string, top int) []Hit {
	if top <= 0 {
		top = DefaultTop
	}
	hits := []Hit{}
	for _, c := range cands {
		if s, got, ok := Score(terms, c.Title, c.Text); ok {
			hits = append(hits, Hit{Candidate: c, Score: s, Terms: got})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > top {
		hits = hits[:top]
	}
	return hits
}
