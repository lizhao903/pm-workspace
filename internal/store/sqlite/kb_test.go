package sqlite

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func ip(n int) *int { return &n }

// 原型三个种子知识库按原样入库、索引，检索结果和原型 searchKb 逐条一致；有 FTS5 和逐块匹配两条路都要对。
// 样例的来历见 internal/kb/kb_test.go。
func TestKbSearchMatchesPrototype(t *testing.T) {
	raw, err := os.ReadFile("../../kb/testdata/proto.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		KBs []struct {
			ID        string `json:"id"`
			ChunkSize int    `json:"chunk_size"`
			Overlap   int    `json:"overlap"`
			Docs      []struct {
				Title    string `json:"title"`
				Text     string `json:"text"`
				Status   string `json:"status"`
				Excluded bool   `json:"excluded"`
			} `json:"docs"`
			Cases []struct {
				Q    string `json:"q"`
				Hits []struct {
					Title string   `json:"title"`
					Index int      `json:"index"`
					Start int      `json:"start"`
					End   int      `json:"end"`
					Score float64  `json:"score"`
					Terms []string `json:"terms"`
				} `json:"hits"`
			} `json:"cases"`
		} `json:"kbs"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	cases := 0
	for _, mode := range []string{"fts", "scan"} {
		t.Run(mode, func(t *testing.T) {
			kbFTSOff = mode == "scan"
			defer func() { kbFTSOff = false }()
			s, ctx := newStore(t)
			sv := &kb.Service{St: s}
			for _, k := range fx.KBs {
				base, err := s.CreateKnowledgeBase(ctx, store.KbInput{Name: sp(k.ID),
					Settings: &store.KbSettingsInput{ChunkSize: ip(k.ChunkSize), Overlap: ip(k.Overlap)}})
				if err != nil {
					t.Fatal(err)
				}
				// 原型的文档顺序就是检索时的先后，库里新加的在前，所以倒着加
				for i := len(k.Docs) - 1; i >= 0; i-- {
					d := k.Docs[i]
					made, err := s.CreateKbDoc(ctx, &store.KbDoc{KbID: base.ID, Title: d.Title, Text: d.Text,
						Source: store.KbSource{Type: store.KbSrcNote}})
					if err != nil {
						t.Fatal(err)
					}
					switch d.Status {
					case store.KbIndexed:
						if made, err = sv.Index(ctx, base, made); err != nil || made.Status != store.KbIndexed {
							t.Fatalf("索引 %s = %+v, %v", d.Title, made, err)
						}
					case store.KbFailed:
						if _, err := s.IndexKbDoc(ctx, made.ID, store.KbFailed, "原型里就是失败的", nil); err != nil {
							t.Fatal(err)
						}
					}
					if d.Excluded {
						made.Excluded = true
						if _, err := s.UpdateKbDoc(ctx, made); err != nil {
							t.Fatal(err)
						}
					}
				}
				for _, c := range k.Cases {
					cases++
					_, got, err := kb.Search(ctx, s, []string{base.ID}, c.Q, kb.DefaultTop)
					if err != nil {
						t.Fatal(err)
					}
					same := len(got) == len(c.Hits)
					for i := 0; same && i < len(got); i++ {
						g, w := got[i], c.Hits[i]
						same = g.Title == w.Title && g.Index == w.Index && g.Start == w.Start && g.End == w.End &&
							math.Abs(g.Score-w.Score) < 1e-9 && slices.Equal(g.Terms, w.Terms)
					}
					if !same {
						t.Errorf("%s「%s」\n got %+v\nwant %+v", k.ID, c.Q, got, c.Hits)
					}
				}
			}
			var n int
			_ = s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'kb_chunks_fts'`).Scan(&n)
			if (n == 1) != (mode == "fts") {
				t.Errorf("%s 模式下 FTS 表数 = %d", mode, n)
			}
		})
	}
	if cases < 10 {
		t.Fatalf("样例太少：%d", cases)
	}
}

// 先在没有 FTS 的库里建好切块，之后第一次用到 FTS 时把已有切块补进索引，检索照样命中。
func TestKbFTSBackfill(t *testing.T) {
	s, ctx := newStore(t)
	sv := &kb.Service{St: s}
	k, err := s.CreateKnowledgeBase(ctx, store.KbInput{Name: sp("库")})
	if err != nil {
		t.Fatal(err)
	}
	kbFTSOff = true
	d, err := sv.Add(ctx, k, kb.AddInput{Type: store.KbSrcNote, Title: "备忘", Text: "审计日志至少保留 180 天"})
	kbFTSOff = false
	if err != nil || d.Status != store.KbIndexed || d.Chunks != 1 {
		t.Fatalf("加笔记 = %+v, %v", d, err)
	}
	_, hits, err := kb.Search(ctx, s, []string{k.ID}, "审计日志保留多久", 5)
	if err != nil || len(hits) != 1 || hits[0].DocID != d.ID {
		t.Fatalf("补索引后检索 = %+v, %v", hits, err)
	}
}

func TestKbCRUDAndDetach(t *testing.T) {
	s, ctx := newStore(t)
	for name, in := range map[string]store.KbInput{
		"名称为空":    {Name: sp("  ")},
		"段长不在可选值": {Name: sp("库"), Settings: &store.KbSettingsInput{ChunkSize: ip(250)}},
		"重叠不在可选值": {Name: sp("库"), Settings: &store.KbSettingsInput{Overlap: ip(40)}},
		"返回条数越界":  {Name: sp("库"), Settings: &store.KbSettingsInput{Top: ip(0)}},
		"分类不存在":   {Name: sp("库"), Sources: &[]string{"cat_nope"}},
		"目录重复":    {Name: sp("库"), Settings: &store.KbSettingsInput{Dirs: &[]store.KbDir{{Path: "/tmp/a"}, {Path: "/tmp/a"}}}},
	} {
		if _, err := s.CreateKnowledgeBase(ctx, in); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%s：err = %v，期望校验错误", name, err)
		}
	}
	k, err := s.CreateKnowledgeBase(ctx, store.KbInput{Name: sp(" 产品文档库 "), Desc: sp("PRD")})
	if err != nil {
		t.Fatal(err)
	}
	st := k.Settings
	if !strings.HasPrefix(k.ID, "kb_") || k.Name != "产品文档库" || !st.AutoSync || st.ChunkSize != 300 || st.Overlap != 50 ||
		st.Top != 5 || len(st.Dirs) != 0 || len(k.Sources) != 0 {
		t.Fatalf("默认设置 = %+v", k)
	}
	k, err = s.UpdateKnowledgeBase(ctx, k.ID, store.KbInput{Settings: &store.KbSettingsInput{ChunkSize: ip(200), Overlap: ip(30),
		Dirs: &[]store.KbDir{{Path: "/tmp/docs", AutoSync: true}}, Embed: &store.KbEmbed{ProviderID: "apv_x", Model: "bge-m3"}}})
	if err != nil || k.Settings.ChunkSize != 200 || k.Settings.Embed.Model != "bge-m3" || len(k.Settings.Dirs) != 1 {
		t.Fatalf("改设置 = %+v, %v", k, err)
	}

	sv := &kb.Service{St: s}
	d, err := sv.Add(ctx, k, kb.AddInput{Type: store.KbSrcNote, Title: "笔记", Text: strings.Repeat("字", 450)})
	if err != nil || d.Status != store.KbIndexed || d.Chunks != len(kb.Split(d.Text, 200, 30)) {
		t.Fatalf("加笔记 = %+v, %v", d, err)
	}

	p, err := s.CreateProvider(ctx, &domain.AgentProvider{Name: "本机", Kind: domain.ProviderOllama, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(name string, kbs ...string) *domain.Agent {
		a, err := s.CreateAgent(ctx, domain.AgentInput{Name: sp(name), ProviderID: &p.ID, KBs: &kbs})
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	a1 := mk("甲", "kb_other", k.ID)
	a2 := mk("乙", "kb_other")

	gone, detached, err := s.DeleteKnowledgeBase(ctx, k.ID)
	if err != nil || gone.ID != k.ID || !slices.Equal(detached, []string{a1.ID}) {
		t.Fatalf("删除 = %v %v %v", gone, detached, err)
	}
	for _, c := range []struct {
		a    *domain.Agent
		want []string
	}{{a1, []string{"kb_other"}}, {a2, []string{"kb_other"}}} {
		if got, err := s.GetAgent(ctx, c.a.ID); err != nil || !slices.Equal(got.KBs, c.want) {
			t.Errorf("%s 的知识库 = %v，期望 %v（%v）", c.a.Name, got.KBs, c.want, err)
		}
	}
	var docs, chunks, fts int
	_ = s.db.R.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM kb_docs), (SELECT COUNT(*) FROM kb_chunks), (SELECT COUNT(*) FROM kb_chunks_fts)`).Scan(&docs, &chunks, &fts)
	if docs != 0 || chunks != 0 || fts != 0 {
		t.Errorf("删除后还剩 文档 %d 切块 %d 索引 %d", docs, chunks, fts)
	}
	if _, _, err := s.DeleteKnowledgeBase(ctx, k.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("再删应当 404：%v", err)
	}
}
