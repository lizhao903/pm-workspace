// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func seedShortcuts(f *fakeStore) {
	f.sgroups["g1"] = &domain.ShortcutGroup{ID: "g1", Name: "常用系统", SortOrder: 10}
	f.sgroups["g2"] = &domain.ShortcutGroup{ID: "g2", Name: "文档与设计", SortOrder: 20}
	g1, g2 := "g1", "g2"
	f.shortcuts["s1"] = &domain.Shortcut{ID: "s1", Label: "Jira", GroupID: &g1, SortOrder: 10}
	f.shortcuts["s2"] = &domain.Shortcut{ID: "s2", Label: "Figma", GroupID: &g2, SortOrder: 20}
	f.shortcuts["s3"] = &domain.Shortcut{ID: "s3", Label: "散装入口", SortOrder: 30}
}

// dataList 把信封里的 data 取成 []any，列表接口共用。
func dataList(t *testing.T, w *httptest.ResponseRecorder) []any {
	t.Helper()
	m := decodeEnvelope(t, w)
	arr, ok := m["data"].([]any)
	if !ok {
		t.Fatalf("data 不是数组: %s", w.Body.String())
	}
	return arr
}

func TestListShortcutsFlat(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	w := do(newTestServer(f), http.MethodGet, "/api/shortcuts", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	arr := dataList(t, w)
	if len(arr) != 3 {
		t.Fatalf("扁平列表应有 3 条, got %d", len(arr))
	}
	// 扁平模式下不该冒出 items 字段。
	first := arr[0].(map[string]any)
	if _, ok := first["items"]; ok {
		t.Fatalf("扁平条目不应带 items: %v", first)
	}
	if first["label"] != "Jira" {
		t.Fatalf("应按 sort_order 排序, 首条 = %v", first["label"])
	}
}

func TestListShortcutsGrouped(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	w := do(newTestServer(f), http.MethodGet, "/api/shortcuts?grouped=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	arr := dataList(t, w)
	if len(arr) != 3 {
		t.Fatalf("应为 2 个真实分组 + 1 个未分组伪组, got %d", len(arr))
	}

	g1 := arr[0].(map[string]any)
	if g1["id"] != "g1" || g1["name"] != "常用系统" {
		t.Fatalf("首组 = %v", g1)
	}
	items := g1["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["label"] != "Jira" {
		t.Fatalf("g1.items = %v", items)
	}

	// 未分组固定排在所有分组之后，id 用空串。
	last := arr[2].(map[string]any)
	if last["id"] != "" || last["name"] != ungroupedName {
		t.Fatalf("末组应为未分组伪组, got %v", last)
	}
	loose := last["items"].([]any)
	if len(loose) != 1 || loose[0].(map[string]any)["label"] != "散装入口" {
		t.Fatalf("未分组 items = %v", loose)
	}

	// meta.total 统计的是条目数，不是分组数。
	meta := decodeEnvelope(t, w)["meta"].(map[string]any)
	if meta["total"] != float64(3) {
		t.Fatalf("meta.total = %v, 期望 3（条目数）", meta["total"])
	}
}

// 没有未分组条目时不造空的伪组，否则页面会多出一个空区块。
func TestListShortcutsGroupedWithoutUngrouped(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	delete(f.shortcuts, "s3")
	arr := dataList(t, do(newTestServer(f), http.MethodGet, "/api/shortcuts?grouped=true", ""))
	if len(arr) != 2 {
		t.Fatalf("不应出现空的未分组伪组, got %d 组", len(arr))
	}
}

// 空组的 items 会被 domain.ShortcutGroup 的 omitempty 整个省掉（那个 tag 不归我改）。
// 关键是绝不能序列化成 null——前端 items 声明为可选，缺字段能处理，null 会炸。
func TestListShortcutsGroupedEmptyGroupNeverNull(t *testing.T) {
	f := newFakeStore()
	f.sgroups["g1"] = &domain.ShortcutGroup{ID: "g1", Name: "空组"}
	w := do(newTestServer(f), http.MethodGet, "/api/shortcuts?grouped=true", "")
	arr := dataList(t, w)
	g := arr[0].(map[string]any)
	v, present := g["items"]
	if present && v == nil {
		t.Fatalf("items 不能是 null: %s", w.Body.String())
	}
	if present {
		if _, ok := v.([]any); !ok {
			t.Fatalf("items 必须是数组, got %T", v)
		}
	}
}

// 指向已删除分组的孤儿条目要回落到未分组，而不是凭空消失。
func TestListShortcutsGroupedOrphanFallsBack(t *testing.T) {
	f := newFakeStore()
	ghost := "g_gone"
	f.shortcuts["s1"] = &domain.Shortcut{ID: "s1", Label: "孤儿", GroupID: &ghost}
	arr := dataList(t, do(newTestServer(f), http.MethodGet, "/api/shortcuts?grouped=true", ""))
	if len(arr) != 1 || arr[0].(map[string]any)["id"] != "" {
		t.Fatalf("孤儿条目应落进未分组伪组, got %v", arr)
	}
}

func TestListShortcutsGroupedBadParam(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/api/shortcuts?grouped=maybe", "")
	assertError(t, w, http.StatusBadRequest, "validation")
}

// /api/shortcuts/reorder 不能被 /api/shortcuts/{id} 吃掉。
func TestReorderRouteNotSwallowedByID(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	w := do(newTestServer(f), http.MethodPost, "/api/shortcuts/reorder", `{"group_id":"g1","ids":["s1"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastReorderIDs == nil {
		t.Fatal("reorder 没有被调用，路由被 {id} 吃掉了")
	}
	if _, ok := f.shortcuts["reorder"]; ok {
		t.Fatal("不该把 reorder 当成一个 id")
	}
}

func TestReorderRequestBody(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantGroup  *string
		wantIDs    []string
		wantStatus int
	}{
		{"指定分组", `{"group_id":"g1","ids":["s1","s2"]}`, ptr("g1"), []string{"s1", "s2"}, http.StatusOK},
		{"group_id 为 null 表示未分组区", `{"group_id":null,"ids":["s3"]}`, nil, []string{"s3"}, http.StatusOK},
		{"缺省 group_id 同样按未分组处理", `{"ids":["s3"]}`, nil, []string{"s3"}, http.StatusOK},
		{"ids 类型错误", `{"group_id":"g1","ids":"s1,s2"}`, nil, nil, http.StatusBadRequest},
		{"空 body", ``, nil, nil, http.StatusBadRequest},
		{"非法 JSON", `{`, nil, nil, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeStore()
			seedShortcuts(f)
			w := do(newTestServer(f), http.MethodPost, "/api/shortcuts/reorder", tc.body)
			if w.Code != tc.wantStatus {
				t.Fatalf("状态码 = %d, 期望 %d (%s)", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}
			switch {
			case tc.wantGroup == nil && f.lastReorderGroup != nil:
				t.Fatalf("group_id = %q, 期望 nil", *f.lastReorderGroup)
			case tc.wantGroup != nil && (f.lastReorderGroup == nil || *f.lastReorderGroup != *tc.wantGroup):
				t.Fatalf("group_id = %v, 期望 %q", f.lastReorderGroup, *tc.wantGroup)
			}
			if len(f.lastReorderIDs) != len(tc.wantIDs) {
				t.Fatalf("ids = %v, 期望 %v", f.lastReorderIDs, tc.wantIDs)
			}
			for i, id := range tc.wantIDs {
				if f.lastReorderIDs[i] != id {
					t.Fatalf("ids = %v, 期望 %v", f.lastReorderIDs, tc.wantIDs)
				}
			}
		})
	}
}

// group_id 的三态与 parseObjectPatch 一致：缺失=不改，有值=改，null=移出分组。
func TestParseShortcutPatchThreeStates(t *testing.T) {
	t.Run("字段缺失", func(t *testing.T) {
		p, err := parseShortcutPatch([]byte(`{"label":"只改名"}`))
		if err != nil {
			t.Fatal(err)
		}
		if p.GroupID != nil {
			t.Fatal("group_id 缺失时应为 nil")
		}
		if p.Label == nil || *p.Label != "只改名" {
			t.Fatalf("label = %v", p.Label)
		}
		if p.Pinned != nil || p.SortOrder != nil || p.TargetKind != nil {
			t.Fatal("未出现的字段都应为 nil")
		}
	})

	t.Run("字段有值", func(t *testing.T) {
		p, err := parseShortcutPatch([]byte(`{"group_id":"g1","pinned":true,"sort_order":40}`))
		if err != nil {
			t.Fatal(err)
		}
		if p.GroupID == nil || *p.GroupID == nil || **p.GroupID != "g1" {
			t.Fatalf("group_id = %v", p.GroupID)
		}
		if p.Pinned == nil || !*p.Pinned {
			t.Fatalf("pinned = %v", p.Pinned)
		}
		if p.SortOrder == nil || *p.SortOrder != 40 {
			t.Fatalf("sort_order = %v", p.SortOrder)
		}
	})

	t.Run("字段为 null 表示移出分组", func(t *testing.T) {
		p, err := parseShortcutPatch([]byte(`{"group_id":null}`))
		if err != nil {
			t.Fatal(err)
		}
		if p.GroupID == nil || *p.GroupID != nil {
			t.Fatalf("group_id 置空失败: %v", p.GroupID)
		}
	})
}

func TestParseShortcutPatchErrors(t *testing.T) {
	for _, body := range []string{
		``, `{`, `[1]`,
		`{"label":null}`,      // 普通字段不支持置空
		`{"pinned":"yes"}`,    // 类型错误
		`{"sort_order":"40"}`, //
		`{"group_id":42}`,
	} {
		if _, err := parseShortcutPatch([]byte(body)); err == nil {
			t.Fatalf("body %q 应报错", body)
		} else if !isValidation(err) {
			t.Fatalf("body %q 应为 validation 错误, got %v", body, err)
		}
	}
}

func TestShortcutPatchReachesStore(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	w := do(newTestServer(f), http.MethodPatch, "/api/shortcuts/s1", `{"group_id":null,"label":"改名"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastShortcutPatch.GroupID == nil || *f.lastShortcutPatch.GroupID != nil {
		t.Fatalf("group_id 未按置空传给 store: %v", f.lastShortcutPatch.GroupID)
	}
	if f.shortcuts["s1"].GroupID != nil {
		t.Fatal("条目应已移出分组")
	}
}

func TestVisitShortcutEnvelope(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	w := do(newTestServer(f), http.MethodPost, "/api/shortcuts/s1/visit", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["use_count"] != float64(1) {
		t.Fatalf("use_count = %v", data["use_count"])
	}
	if data["last_used_at"] == nil {
		t.Fatal("last_used_at 应被填上")
	}
	// visit 不带 body，不能因为空 body 就 400。
	if w2 := do(newTestServer(f), http.MethodPost, "/api/shortcuts/nope/visit", ""); w2.Code != http.StatusNotFound {
		t.Fatalf("不存在的条目应 404, got %d", w2.Code)
	}
}

func TestCreateShortcutEnvelope(t *testing.T) {
	f := newFakeStore()
	body := `{"label":"Jira 看板","target_kind":"url","url":"https://jira.test","group_id":null,"pinned":true}`
	w := do(newTestServer(f), http.MethodPost, "/api/shortcuts", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["label"] != "Jira 看板" || data["pinned"] != true {
		t.Fatalf("data = %v", data)
	}
	// 字段名必须和 web/src/lib/types.ts 的 Shortcut 对得上。
	for _, k := range []string{"id", "group_id", "label", "target_kind", "url", "nav", "command",
		"icon", "color", "description", "open_in", "pinned", "sort_order",
		"last_used_at", "use_count", "created_at", "updated_at"} {
		if _, ok := data[k]; !ok {
			t.Fatalf("返回体缺字段 %q: %v", k, data)
		}
	}
}

// store 的校验错误要原样透到 400 validation，不能被 API 层吞成 500。
func TestCreateShortcutValidationPassthrough(t *testing.T) {
	f := newFakeStore()
	f.errCreateShortcut = domain.ErrValidation
	w := do(newTestServer(f), http.MethodPost, "/api/shortcuts", `{"label":"x","url":"javascript:alert(1)"}`)
	assertError(t, w, http.StatusBadRequest, "validation")
}

func TestShortcutGroupRoutes(t *testing.T) {
	f := newFakeStore()
	seedShortcuts(f)
	s := newTestServer(f)

	if arr := dataList(t, do(s, http.MethodGet, "/api/shortcut-groups", "")); len(arr) != 2 {
		t.Fatalf("分组列表应有 2 条, got %d", len(arr))
	}

	w := do(s, http.MethodPost, "/api/shortcut-groups", `{"name":"新分组","color":"#3b5bdb"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("建组状态码 = %d (%s)", w.Code, w.Body.String())
	}

	if w := do(s, http.MethodPatch, "/api/shortcut-groups/g1", `{"collapsed":true}`); w.Code != http.StatusOK {
		t.Fatalf("改组状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if !f.sgroups["g1"].Collapsed {
		t.Fatal("collapsed 未透传给 store")
	}

	if w := do(s, http.MethodDelete, "/api/shortcut-groups/g1", ""); w.Code != http.StatusOK {
		t.Fatalf("删组状态码 = %d (%s)", w.Code, w.Body.String())
	}
	// 删组不删条目：s1 应变成未分组。
	if f.shortcuts["s1"].GroupID != nil {
		t.Fatal("删组后条目应变为未分组")
	}
	if _, ok := f.shortcuts["s1"]; !ok {
		t.Fatal("删组不应级联删条目")
	}

	if w := do(s, http.MethodDelete, "/api/shortcut-groups/nope", ""); w.Code != http.StatusNotFound {
		t.Fatalf("不存在的分组应 404, got %d", w.Code)
	}
}

// 空库要回 []，让前端能直接判空态。
func TestShortcutsEmptyState(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, path := range []string{"/api/shortcuts", "/api/shortcuts?grouped=true", "/api/shortcut-groups"} {
		w := do(s, http.MethodGet, path, "")
		var m map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		if string(m["data"]) != "[]" {
			t.Fatalf("%s 空态应回 [], got %s", path, m["data"])
		}
	}
}
