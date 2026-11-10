// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func cardKeys(cs []plugin.TodayCard) []string {
	out := []string{}
	for _, c := range cs {
		out = append(out, c.Key)
	}
	return out
}

// cardManifest 是只声明了今日卡片的清单。
func cardManifest(t *testing.T, id string, keys ...string) plugin.Manifest {
	t.Helper()
	js := `{"id":"` + id + `","name":"` + id + `","version":"0.1.0","core":">=1.0.0 <2.0.0",` +
		`"provides":{"today_cards":["` + strings.Join(keys, `","`) + `"]},"permissions":[]}`
	m, err := plugin.Parse([]byte(js))
	if err != nil {
		t.Fatalf("manifest %s: %v", id, err)
	}
	return *m
}

// TestTodayCardsSkipBadOnes：超时、出错、panic、返回 nil 的卡都跳过，不影响别的卡；按 order 排，0 取默认 100。
func TestTodayCardsSkipBadOnes(t *testing.T) {
	data := func(n int) func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
		return func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
			return &plugin.TodayCardData{Total: n}, nil
		}
	}
	p := &fakePlugin{
		m: cardManifest(t, "alpha", "alpha_a", "alpha_b", "alpha_slow", "alpha_err", "alpha_panic", "alpha_nil"),
		reg: func(r plugin.Registrar) error {
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_a", Title: "A", Load: data(1)})
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_b", Title: "B", Order: 60, Load: data(2)})
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_slow", Title: "慢", Load: func(ctx context.Context, _ plugin.Core) (*plugin.TodayCardData, error) {
				time.Sleep(3 * plugin.TodayCardTimeout)
				return &plugin.TodayCardData{}, nil
			}})
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_err", Title: "错", Load: func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
				return nil, errors.New("boom")
			}})
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_panic", Title: "崩", Load: func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
				panic("boom")
			}})
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_nil", Title: "空", Load: func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
				return nil, nil
			}})
			return nil
		},
	}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	installEnable(t, r, "alpha")

	start := time.Now()
	cs := r.TodayCards(context.Background())
	if d := time.Since(start); d > 2*plugin.TodayCardTimeout {
		t.Fatalf("慢卡片拖住了整次聚合：%v", d)
	}
	if got := cardKeys(cs); !slices.Equal(got, []string{"alpha_b", "alpha_a"}) {
		t.Fatalf("cards = %v", got)
	}
	if cs[1].Order != plugin.DefaultTodayCardOrder || cs[1].Plugin != "alpha" || cs[1].Total != 1 {
		t.Fatalf("默认 order 或字段不对：%+v", cs[1])
	}
	if items, ok := cs[1].Items.([]any); !ok || len(items) != 0 {
		t.Fatalf("Items 为 nil 时要给空列表：%#v", cs[1].Items)
	}
}

// TestTodayCardsFollowEnabledState：没装、停用的插件没有卡片，重新启用后回来。
func TestTodayCardsFollowEnabledState(t *testing.T) {
	ctx := context.Background()
	p := &fakePlugin{
		m: cardManifest(t, "alpha", "alpha_a"),
		reg: func(r plugin.Registrar) error {
			r.TodayCard(plugin.TodayCardDef{Key: "alpha_a", Title: "A", Load: func(context.Context, plugin.Core) (*plugin.TodayCardData, error) {
				return &plugin.TodayCardData{Total: 1, Items: []string{"x"}}, nil
			}})
			return nil
		},
	}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	if cs := r.TodayCards(ctx); len(cs) != 0 {
		t.Fatalf("没装就有卡片：%v", cardKeys(cs))
	}
	installEnable(t, r, "alpha")
	if got := cardKeys(r.TodayCards(ctx)); !slices.Equal(got, []string{"alpha_a"}) {
		t.Fatalf("启用后 cards = %v", got)
	}
	if err := r.Disable(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if cs := r.TodayCards(ctx); len(cs) != 0 {
		t.Fatalf("停用后还有卡片：%v", cardKeys(cs))
	}
	if err := r.Enable(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if got := cardKeys(r.TodayCards(ctx)); !slices.Equal(got, []string{"alpha_a"}) {
		t.Fatalf("重新启用后 cards = %v", got)
	}
}

func TestTodayCardChecksManifest(t *testing.T) {
	load := func(context.Context, plugin.Core) (*plugin.TodayCardData, error) { return nil, nil }
	cases := []struct {
		name string
		def  []plugin.TodayCardDef
		want string
	}{
		{"没声明", []plugin.TodayCardDef{{Key: "bad_other", Title: "X", Load: load}}, "provides.today_cards"},
		{"没有 Load", []plugin.TodayCardDef{{Key: "bad_a", Title: "X"}}, "没有 Load"},
		{"没有标题", []plugin.TodayCardDef{{Key: "bad_a", Load: load}}, "没有标题"},
		{"重复", []plugin.TodayCardDef{{Key: "bad_a", Title: "X", Load: load}, {Key: "bad_a", Title: "X", Load: load}}, "今日卡片重复"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePlugin{m: cardManifest(t, "bad", "bad_a"), reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.TodayCard(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
}
