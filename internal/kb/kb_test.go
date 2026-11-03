package kb

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

// testdata/proto.json 是直接跑原型 web-next/src/kbdata.ts 得到的：三个种子知识库的文档、切分设置，
// 每个库几条问题（含原型 SAMPLE_Q）的 searchKb 结果，几段正文在不同设置下的 splitChunks，几条 queryTerms。
// 生成方法：把 kbdata.ts 和它引的 data.ts、ids.ts、modeldata.ts 拷出来，react 换成空实现，
// 导出模块里的 state，用 node 跑 splitChunks、searchKb、queryTerms 后 JSON.stringify。

type protoHit struct {
	Title string   `json:"title"`
	Index int      `json:"index"`
	Start int      `json:"start"`
	End   int      `json:"end"`
	Score float64  `json:"score"`
	Terms []string `json:"terms"`
}

type protoDoc struct {
	Title    string `json:"title"`
	Source   string `json:"source"`
	Text     string `json:"text"`
	Status   string `json:"status"`
	Excluded bool   `json:"excluded"`
}

type protoFixture struct {
	KBs []struct {
		ID        string     `json:"id"`
		ChunkSize int        `json:"chunk_size"`
		Overlap   int        `json:"overlap"`
		Docs      []protoDoc `json:"docs"`
		Cases     []struct {
			Q    string     `json:"q"`
			Hits []protoHit `json:"hits"`
		} `json:"cases"`
	} `json:"kbs"`
	Splits []struct {
		Size    int     `json:"size"`
		Overlap int     `json:"overlap"`
		Text    string  `json:"text"`
		Chunks  []Chunk `json:"chunks"`
	} `json:"splits"`
	Terms []struct {
		Q     string   `json:"q"`
		Terms []string `json:"terms"`
	} `json:"terms"`
}

func loadProto(t *testing.T) protoFixture {
	t.Helper()
	b, err := os.ReadFile("testdata/proto.json")
	if err != nil {
		t.Fatal(err)
	}
	var f protoFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.KBs) == 0 || len(f.Splits) == 0 || len(f.Terms) == 0 {
		t.Fatal("样例是空的")
	}
	return f
}

func TestSplitMatchesPrototype(t *testing.T) {
	for i, c := range loadProto(t).Splits {
		got := Split(c.Text, c.Size, c.Overlap)
		if !reflect.DeepEqual(got, c.Chunks) {
			t.Errorf("#%d size=%d overlap=%d\n got %v\nwant %v", i, c.Size, c.Overlap, got, c.Chunks)
		}
	}
	if got := Split("  \n ", 200, 30); len(got) != 0 {
		t.Errorf("空白正文 = %v", got)
	}
}

func TestTermsMatchPrototype(t *testing.T) {
	for _, c := range loadProto(t).Terms {
		if got := Terms(c.Q); !reflect.DeepEqual(got, c.Terms) {
			t.Errorf("Terms(%q) = %v, want %v", c.Q, got, c.Terms)
		}
	}
}

// 不经过存储，按原型的做法现切现打分，和 searchKb 的结果逐条对上。
func TestRankMatchesPrototype(t *testing.T) {
	for _, k := range loadProto(t).KBs {
		var cands []Candidate
		for _, d := range k.Docs {
			if d.Excluded || d.Status != "indexed" {
				continue
			}
			for i, c := range Split(d.Text, k.ChunkSize, k.Overlap) {
				cands = append(cands, Candidate{DocID: d.Title, Title: d.Title, Index: i, Chunk: c, Text: Slice(d.Text, c)})
			}
		}
		for _, c := range k.Cases {
			got := Rank(cands, Terms(c.Q), DefaultTop)
			if err := SameHits(got, c.Hits); err != "" {
				t.Errorf("%s「%s」%s", k.ID, c.Q, err)
			}
		}
	}
}

// SameHits 比较命中和原型的结果，不一致时回说明。
func SameHits(got []Hit, want []protoHit) string {
	if len(got) != len(want) {
		return describe(got, want)
	}
	for i := range got {
		g, w := got[i], want[i]
		if g.Title != w.Title || g.Index != w.Index || g.Chunk.Start != w.Start || g.Chunk.End != w.End ||
			math.Abs(g.Score-w.Score) > 1e-9 || !reflect.DeepEqual(g.Terms, w.Terms) {
			return describe(got, want)
		}
	}
	return ""
}

func describe(got []Hit, want []protoHit) string {
	var b strings.Builder
	b.WriteString("\n got:")
	for _, h := range got {
		b.WriteString("\n  " + h.Title)
		_, _ = b.WriteString(" " + strings.Join(h.Terms, ","))
	}
	b.WriteString("\nwant:")
	for _, h := range want {
		b.WriteString("\n  " + h.Title + " " + strings.Join(h.Terms, ","))
	}
	return b.String()
}

// FTS 的词必须覆盖正文里所有可能被检索到的词：每个 Terms 拆出的词，只要正文含它，前缀匹配就能命中。
func TestIndexTokensCoverTerms(t *testing.T) {
	body := "导出要校验 object.export 权限点；POST /api/exports 返回 job_id，v1.2-beta 起支持。" + strings.Repeat("x", 200)
	toks := strings.Fields(IndexTokens(body))
	has := func(term string) bool {
		for _, tk := range toks {
			if strings.HasPrefix(tk, term) || tk == LongToken {
				return true
			}
		}
		return false
	}
	for _, q := range []string{"object.export 权限", "export", "api", "exports", "port", "v1.2", "job", "校验", "POST", "xxxx"} {
		for _, term := range Terms(q) {
			if strings.Contains(strings.ToLower(body), term) && !has(term) {
				t.Errorf("正文含 %q，索引词里没有能前缀匹配它的", term)
			}
		}
	}
	if q := MatchQuery([]string{"权限", "api"}); q != `"权限" OR "api"* OR `+LongToken {
		t.Errorf("MatchQuery = %s", q)
	}
}
