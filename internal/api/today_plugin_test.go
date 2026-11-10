// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
)

// TestTodayIncludesPluginCards：示例插件启用后 /api/today 多出它的卡片，按 order 排在内核卡片之间；
// 传了 type 时不合进来；停用后卡片消失，内核卡片不受影响。
func TestTodayIncludesPluginCards(t *testing.T) {
	s, reg, _ := newPluginServer(t)
	ctx := context.Background()
	type card struct {
		Key   string            `json:"key"`
		Title string            `json:"title"`
		Order int               `json:"order"`
		Total int               `json:"total"`
		Items []json.RawMessage `json:"items"`
	}
	get := func(q string) []card {
		t.Helper()
		w := do(s, http.MethodGet, "/api/today"+q, "")
		var body struct{ Data struct{ Cards []card } }
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatalf("today%s: %d %s", q, w.Code, w.Body.String())
		}
		return body.Data.Cards
	}
	keys := func(cs []card) []string {
		out := []string{}
		for _, c := range cs {
			out = append(out, c.Key)
		}
		return out
	}
	kernel := []string{"review", "overdue", "due_today", "running"}

	if got := keys(get("")); !slices.Equal(got, kernel) {
		t.Fatalf("未安装时 cards = %v", got)
	}
	if err := reg.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	cs := get("")
	if got := keys(cs); !slices.Equal(got, append(slices.Clone(kernel), "demo_inbox")) {
		t.Fatalf("启用后 cards = %v", got)
	}
	if c := cs[4]; c.Title != "示例收件箱" || c.Order != 50 || c.Total != 3 || len(c.Items) != 2 {
		t.Fatalf("示例卡片 = %+v", c)
	}
	if got := keys(get("?type=task")); !slices.Equal(got, kernel) {
		t.Fatalf("type=task 时 cards = %v", got)
	}

	if err := reg.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if got := keys(get("")); !slices.Equal(got, kernel) {
		t.Fatalf("停用后 cards = %v", got)
	}
}
