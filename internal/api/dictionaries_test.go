// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func seedDicts(f *fakeStore) {
	f.dicts[domain.DictPriority] = &domain.Dictionary{
		ID: domain.DictPriority, Name: "优先级", Scope: domain.ScopeGlobal, Builtin: true, SortOrder: 10,
	}
	f.dicts[domain.DictLinkRelation] = &domain.Dictionary{
		ID: domain.DictLinkRelation, Name: "关联关系", Scope: domain.ScopeGlobal, Builtin: true, SortOrder: 20,
	}
	f.dictItems["p0"] = &domain.DictItem{
		ID: "p0", DictID: domain.DictPriority, Key: "P0", Label: "最高",
		Color: "#c92a2a", SortOrder: 10, Meta: map[string]any{}, Usage: 12,
	}
	f.dictItems["p1"] = &domain.DictItem{
		ID: "p1", DictID: domain.DictPriority, Key: "P1", Label: "高",
		Color: "#e8590c", SortOrder: 20, Meta: map[string]any{},
	}
	gone := time.Now()
	f.dictItems["p9"] = &domain.DictItem{
		ID: "p9", DictID: domain.DictPriority, Key: "P9", Label: "废弃档",
		SortOrder: 90, Meta: map[string]any{}, ArchivedAt: &gone,
	}
	f.dictItems["blocks"] = &domain.DictItem{
		ID: "blocks", DictID: domain.DictLinkRelation, Key: "blocks", Label: "阻塞",
		SortOrder: 20, Meta: map[string]any{"inverse": "被阻塞于"},
	}
}

func TestListDictionariesWithItems(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	w := do(newTestServer(f), http.MethodGet, "/api/dictionaries?with_items=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if !f.lastDictWithItems {
		t.Error("with_items=true 没传到 store")
	}
	arr := dataList(t, w)
	if len(arr) != 2 {
		t.Fatalf("字典数 = %d, 期望 2", len(arr))
	}
	// 字段名要和 web 的 Dictionary 对上，前端直接吃这个结构。
	first := arr[0].(map[string]any)
	if first["id"] != domain.DictLinkRelation || first["builtin"] != true || first["scope"] != "global" {
		t.Fatalf("首个字典 = %v", first)
	}
	items := first["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("link_relation.items = %v", items)
	}
	it := items[0].(map[string]any)
	for _, k := range []string{"id", "dict_id", "type_id", "key", "label", "color",
		"description", "sort_order", "meta", "archived_at", "created_at", "updated_at", "usage"} {
		if _, ok := it[k]; !ok {
			t.Errorf("条目缺字段 %q: %v", k, it)
		}
	}
}

func TestListDictionariesWithoutItemsOmitsThem(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	w := do(newTestServer(f), http.MethodGet, "/api/dictionaries", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	if f.lastDictWithItems {
		t.Error("没传 with_items 时不该向 store 要条目")
	}
	if _, ok := dataList(t, w)[0].(map[string]any)["items"]; ok {
		t.Error("with_items 缺省时不该带 items 字段")
	}
}

func TestListDictItems(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodGet, "/api/dictionaries/priority/items", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastDictID != domain.DictPriority || f.lastDictTypeID != nil || f.lastDictArchived {
		t.Errorf("入参 = %q/%v/%v", f.lastDictID, f.lastDictTypeID, f.lastDictArchived)
	}
	if arr := dataList(t, w); len(arr) != 2 {
		t.Fatalf("默认列表应排除停用的, got %d", len(arr))
	}

	w = do(s, http.MethodGet, "/api/dictionaries/priority/items?include_archived=true&type=task", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if !f.lastDictArchived {
		t.Error("include_archived 没传到 store")
	}
	if f.lastDictTypeID == nil || *f.lastDictTypeID != "task" {
		t.Errorf("type 没传到 store: %v", f.lastDictTypeID)
	}

	// 非布尔值要报 400 validation，而不是被静默当成 false。
	w = do(s, http.MethodGet, "/api/dictionaries/priority/items?include_archived=maybe", "")
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodGet, "/api/dictionaries/ghost/items", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestCreateDictItem(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/dictionaries/priority/items",
		`{"key":"P4","label":"最低","color":"#ced4da","description":"可做可不做","meta":{"hint":"x"}}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	m := decodeEnvelope(t, w)["data"].(map[string]any)
	if m["key"] != "P4" || m["dict_id"] != domain.DictPriority || m["label"] != "最低" {
		t.Fatalf("返回体 = %v", m)
	}
	if m["meta"].(map[string]any)["hint"] != "x" {
		t.Errorf("meta 没透传: %v", m["meta"])
	}

	// key 重复走 409。
	w = do(s, http.MethodPost, "/api/dictionaries/priority/items", `{"key":"P0","label":"再来一个"}`)
	assertError(t, w, http.StatusConflict, "conflict")

	w = do(s, http.MethodPost, "/api/dictionaries/priority/items", `{"key":"","label":"没 key"}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPost, "/api/dictionaries/ghost/items", `{"key":"a","label":"b"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestUpdateDictItemIgnoresKey(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	// 请求里带 key 不该报错，但也绝不能改到库里的 key。
	w := do(s, http.MethodPatch, "/api/dict-items/p0", `{"label":"紧急","color":"#ff0000","key":"XX"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	m := decodeEnvelope(t, w)["data"].(map[string]any)
	if m["key"] != "P0" {
		t.Fatalf("key 被改成了 %v", m["key"])
	}
	if m["label"] != "紧急" || m["color"] != "#ff0000" {
		t.Fatalf("返回体 = %v", m)
	}
	// patch 结构里本就没有 Key 字段，store 拿不到它。
	if f.lastDictItemPatch.Label == nil || *f.lastDictItemPatch.Label != "紧急" {
		t.Errorf("patch = %+v", f.lastDictItemPatch)
	}

	// 普通字段传 null 要报错，免得静默变成零值。
	w = do(s, http.MethodPatch, "/api/dict-items/p0", `{"label":null}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPatch, "/api/dict-items/p0", `{"sort_order":"3"}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPatch, "/api/dict-items/ghost", `{"label":"x"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestArchiveDictItem(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/dict-items/p1/archive", `{"archived":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if m := decodeEnvelope(t, w)["data"].(map[string]any); m["archived_at"] == nil {
		t.Fatalf("archived_at 应该有值: %v", m)
	}

	w = do(s, http.MethodPost, "/api/dict-items/p1/archive", `{"archived":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if m := decodeEnvelope(t, w)["data"].(map[string]any); m["archived_at"] != nil {
		t.Fatalf("archived_at 应该清空: %v", m)
	}

	w = do(s, http.MethodPost, "/api/dict-items/ghost/archive", `{"archived":true}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestDeleteDictItemMapsConflict(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodDelete, "/api/dict-items/p1", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}

	// 有引用时 store 回 ErrConflict，这里只验错误码映射，数量文案由 store 负责。
	f.errDeleteDictItem = domain.ErrConflict
	w = do(s, http.MethodDelete, "/api/dict-items/p0", "")
	assertError(t, w, http.StatusConflict, "conflict")

	f.errDeleteDictItem = nil
	w = do(s, http.MethodDelete, "/api/dict-items/ghost", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestDictItemUsage(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodGet, "/api/dict-items/p0/usage", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	// 契约是 {"data":{"usage":12}}，前端按这个字段名读。
	m := decodeEnvelope(t, w)["data"].(map[string]any)
	if m["usage"] != float64(12) {
		t.Fatalf("usage = %v, 期望 12", m["usage"])
	}

	w = do(s, http.MethodGet, "/api/dict-items/ghost/usage", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

// /items/reorder 比 /items 多一段路径，不能被 POST /items 吃掉，
// 否则拖拽排序会被当成「新建一个 key 为 reorder 的条目」。
func TestReorderDictItemsHasItsOwnRoute(t *testing.T) {
	f := newFakeStore()
	seedDicts(f)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/dictionaries/priority/items/reorder",
		`{"type_id":null,"ids":["p1","p0"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastDictID != domain.DictPriority {
		t.Errorf("dict id = %q", f.lastDictID)
	}
	if f.lastDictReorderType != nil {
		t.Errorf("type_id = %v, 期望 nil", f.lastDictReorderType)
	}
	if len(f.lastDictReorderIDs) != 2 || f.lastDictReorderIDs[0] != "p1" {
		t.Fatalf("ids = %v", f.lastDictReorderIDs)
	}
	// 没走成 CreateDictItem 的证据：没有多出一条 key 为 reorder 的条目。
	for _, it := range f.dictItems {
		if it.Key == "reorder" {
			t.Fatal("reorder 被 POST /items 吃掉了")
		}
	}
	if f.dictItems["p1"].SortOrder != 10 || f.dictItems["p0"].SortOrder != 20 {
		t.Errorf("排序号没重写: p1=%d p0=%d", f.dictItems["p1"].SortOrder, f.dictItems["p0"].SortOrder)
	}

	w = do(s, http.MethodPost, "/api/dictionaries/priority/items/reorder", `{"ids":[]}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPost, "/api/dictionaries/priority/items/reorder", `not json`)
	assertError(t, w, http.StatusBadRequest, "validation")
}
