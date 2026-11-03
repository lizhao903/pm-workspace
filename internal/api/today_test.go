package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// TestTodayEndpointMatchesCounts 走真库和真路由：/api/today 的逾期、今天到期条数
// 等于同一个 type 下 /api/counts 的 overdue / today，review 任务出现在等确认卡片里。
func TestTodayEndpointMatchesCounts(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s := New(st, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})

	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	past, today := dayStart.Add(-30*time.Hour), dayStart.Add(12*time.Hour)
	mk := func(o *domain.Object) *domain.Object {
		out, err := st.CreateObject(ctx, o, store.DefaultActor)
		if err != nil {
			t.Fatalf("create %s: %v", o.Title, err)
		}
		return out
	}
	mk(&domain.Object{TypeID: "task", Title: "逾期", Status: "todo", DueAt: &past})
	mk(&domain.Object{TypeID: "task", Title: "今天", Status: "todo", DueAt: &today})
	mk(&domain.Object{TypeID: "requirement", Title: "需求今天", DueAt: &today})
	rv := mk(&domain.Object{TypeID: "task", Title: "待验收", Status: "review", DueAt: &today})

	type card struct {
		Key   string            `json:"key"`
		Total int               `json:"total"`
		Items []json.RawMessage `json:"items"`
	}
	for _, typ := range []string{"", "task"} {
		q := ""
		if typ != "" {
			q = "?type=" + typ
		}
		w := do(s, http.MethodGet, "/api/counts"+q, "")
		var counts struct{ Data domain.Counts }
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &counts) != nil {
			t.Fatalf("counts%s: %d %s", q, w.Code, w.Body.String())
		}
		w = do(s, http.MethodGet, "/api/today"+q, "")
		var body struct {
			Data struct{ Cards []card }
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatalf("today%s: %d %s", q, w.Code, w.Body.String())
		}
		cards := map[string]card{}
		for _, c := range body.Data.Cards {
			cards[c.Key] = c
		}
		if c := cards["overdue"]; c.Total != counts.Data.Overdue || len(c.Items) != counts.Data.Overdue {
			t.Errorf("type=%q 逾期 total=%d items=%d，counts.overdue=%d", typ, c.Total, len(c.Items), counts.Data.Overdue)
		}
		if c := cards["due_today"]; c.Total != counts.Data.Today || len(c.Items) != counts.Data.Today {
			t.Errorf("type=%q 今天到期 total=%d items=%d，counts.today=%d", typ, c.Total, len(c.Items), counts.Data.Today)
		}
		review := cards["review"]
		if review.Total != 1 || len(review.Items) != 1 {
			t.Fatalf("type=%q 等确认 = %+v", typ, review)
		}
		var o domain.Object
		if err := json.Unmarshal(review.Items[0], &o); err != nil || o.ID != rv.ID {
			t.Errorf("type=%q 等确认里应当是 %s，got %s (%v)", typ, rv.ID, o.ID, err)
		}
		// 运行中没有数据时是空数组不是 null，前端不用兜底。
		if c, ok := cards["running"]; !ok || c.Items == nil {
			t.Errorf("type=%q 运行中卡片缺失或 items 为 null", typ)
		}
	}
}
