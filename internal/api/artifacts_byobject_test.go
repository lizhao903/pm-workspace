// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// TestArtifactsByObjectPassesFilters 守 /api/artifacts/by-object 的参数一路传到 store（TSK-0497）。
// 参数在 HTTP 层被静默丢掉的话，「已完成但无产出」「只看这个项目」这类筛选点了没反应，
// 而列表照样有数，看起来完全正常。
func TestArtifactsByObjectPassesFilters(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)
	ctx := context.Background()
	proj, _ := f.CreateObject(ctx, &domain.Object{TypeID: "project", Title: "项目"}, store.DefaultActor)
	a, _ := f.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "甲", ProjectID: &proj.ID}, store.DefaultActor)
	b, _ := f.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "乙"}, store.DefaultActor)

	mk := func(body string) {
		if w := do(s, http.MethodPost, "/api/artifacts", body); w.Code != http.StatusCreated {
			t.Fatalf("建产物失败: %s", w.Body.String())
		}
	}
	mk(`{"object_id":"` + a.ID + `","path":"/repo","note":"[commit] sha=a1b2c3d"}`)
	mk(`{"object_id":"` + a.ID + `","path":"/tmp/方案.md"}`)
	mk(`{"object_id":"` + b.ID + `","path":"/repo/x.go"}`)
	mk(`{"path":"/tmp/未归属.md"}`)

	cases := []struct {
		name    string
		query   string
		objects int
		total   int
	}{
		{"不过滤，未归属的不算", "", 2, 3},
		{"按显示种类", "?kind=code", 1, 1},
		{"按项目", "?project_id=" + proj.ID, 1, 2},
		{"不属于项目", "?project_id=-", 1, 1},
		{"按对象类型", "?object_type=project", 0, 0},
		{"关键词", "?q=方案", 1, 1},
		{"时间上界在很久以前", "?until=2000-01-01", 0, 0},
		{"limit 不影响汇总", "?limit=1", 2, 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(s, http.MethodGet, "/api/artifacts/by-object"+c.query, "")
			if w.Code != http.StatusOK {
				t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
			}
			d := artifactData(t, w)
			objs, _ := d["objects"].([]any)
			if len(objs) != c.objects || int(d["total"].(float64)) != c.total {
				t.Errorf("得到 %d 个对象 total=%v，期望 %d 个 %d 件", len(objs), d["total"], c.objects, c.total)
			}
		})
	}

	// 未归属的不属于任何一行，unscoped=true 必然是空，报错而不是静默回空
	assertError(t, do(s, http.MethodGet, "/api/artifacts/by-object?unscoped=true", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, http.MethodGet, "/api/artifacts/by-object?since=昨天", ""), http.StatusBadRequest, "validation")
}

// TestArtifactResponseCarriesDisplayKind：响应带 display_kind，登记时没给 kind 的也补上了。
func TestArtifactResponseCarriesDisplayKind(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodPost, "/api/artifacts", `{"path":"/repo/internal/x.go"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	d := artifactData(t, w)
	if d["display_kind"] != "code" || d["kind"] != "code" {
		t.Errorf("kind=%v display_kind=%v，期望都是 code", d["kind"], d["display_kind"])
	}
}
