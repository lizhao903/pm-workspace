// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"testing"
)

// TestListArtifactsPassesProvenanceFilters 守 0031 新加的过滤参数一路传到 store。
// 任何一层漏传，结果都是「返回全部产物」，不报错。
func TestListArtifactsPassesProvenanceFilters(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, body := range []string{
		`{"url":"https://x/1","kind":"doc","status":"draft"}`,
		`{"url":"https://x/2","kind":"commit","actor_type":"skill","actor_id":"task","actor_label":"开发任务"}`,
		`{"url":"https://x/3","scope_type":"kb","scope_id":"kb_1","props":{"version":2}}`,
	} {
		if w := do(s, http.MethodPost, "/api/artifacts", body); w.Code != http.StatusCreated {
			t.Fatalf("建产物失败: %s", w.Body.String())
		}
	}
	cases := []struct {
		query string
		want  int
	}{
		{"", 3},
		{"?kind=doc", 1},
		{"?status=draft", 1},
		{"?actor_type=skill", 1},
		{"?actor_type=skill&actor_id=task", 1},
		{"?actor_type=user", 2}, // 没声明的按 source=manual 补成 user
		{"?scope_type=kb&scope_id=kb_1", 1},
		{"?scope_type=kb&scope_id=kb_2", 0},
	}
	for _, c := range cases {
		w := do(s, http.MethodGet, "/api/artifacts"+c.query, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s: 状态码 %d (body=%s)", c.query, w.Code, w.Body.String())
		}
		items, _ := decodeEnvelope(t, w)["data"].([]any)
		if len(items) != c.want {
			t.Errorf("%s: 列表 %d 条，期望 %d", c.query, len(items), c.want)
		}
		ws := do(s, http.MethodGet, "/api/artifacts/stats"+c.query, "")
		if got := artifactData(t, ws)["total"]; int(got.(float64)) != c.want {
			t.Errorf("%s: 统计 total %v，期望 %d", c.query, got, c.want)
		}
	}
	// 单给 scope_id 要报错，不能静默忽略。
	assertError(t, do(s, http.MethodGet, "/api/artifacts?scope_id=kb_1", ""),
		http.StatusBadRequest, "validation")
}

func TestPatchArtifactProvenance(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodPost, "/api/artifacts", `{"url":"https://x/1"}`)
	id, _ := artifactData(t, w)["id"].(string)

	w = do(s, http.MethodPatch, "/api/artifacts/"+id,
		`{"kind":"prototype","status":"review","scope_type":"video","scope_id":"vid_1","props":{"picked":true}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 %d (body=%s)", w.Code, w.Body.String())
	}
	d := artifactData(t, w)
	props, _ := d["props"].(map[string]any)
	if d["kind"] != "prototype" || d["status"] != "review" || d["scope_type"] != "video" ||
		d["scope_id"] != "vid_1" || props["picked"] != true {
		t.Errorf("改完不对: %v", d)
	}
}
