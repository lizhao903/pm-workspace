// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func dataObject(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	m := decodeEnvelope(t, w)
	obj, ok := m["data"].(map[string]any)
	if !ok {
		t.Fatalf("data 不是对象: %s", w.Body.String())
	}
	return obj
}

func seedStakeholders(f *fakeStore) (active, archived *domain.Stakeholder) {
	gone := time.Now()
	active = &domain.Stakeholder{ID: "stk_1", Name: "张三", Role: "研发", SortOrder: 10}
	archived = &domain.Stakeholder{ID: "stk_9", Name: "已离职", SortOrder: 90, ArchivedAt: &gone}
	f.stakeholdersMap()[active.ID] = active
	f.stakeholdersMap()[archived.ID] = archived
	return active, archived
}

// 默认只回在岗的（选人时用），archived=true 才带上已归档的（名册管理页用）。
func TestListStakeholdersArchivedParam(t *testing.T) {
	f := newFakeStore()
	seedStakeholders(f)
	s := newTestServer(f)

	w := do(s, http.MethodGet, "/api/stakeholders", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	arr := dataList(t, w)
	if len(arr) != 1 {
		t.Fatalf("默认列表 = %d 条, 期望 1（归档的人不该出现在选人下拉里）", len(arr))
	}
	first := arr[0].(map[string]any)
	// 字段名要和 web 的 Stakeholder 对上，前端直接吃这个结构。
	for _, k := range []string{"id", "name", "role", "email", "note", "color", "sort_order",
		"archived_at", "created_at", "updated_at", "owned_count", "participating_count"} {
		if _, ok := first[k]; !ok {
			t.Errorf("干系人缺字段 %q: %v", k, first)
		}
	}

	w = do(s, http.MethodGet, "/api/stakeholders?archived=true", "")
	if len(dataList(t, w)) != 2 {
		t.Fatalf("archived=true 时该带上已归档的, body=%s", w.Body.String())
	}

	w = do(s, http.MethodGet, "/api/stakeholders?archived=maybe", "")
	assertError(t, w, http.StatusBadRequest, "validation")
}

// 名字全局唯一：出现两个「张三」时用户无从选择，而错选的后果是任务分给了另一个人。
func TestCreateStakeholderDuplicateNameConflicts(t *testing.T) {
	f := newFakeStore()
	seedStakeholders(f)
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/stakeholders", `{"name":"王闯","role":"产品"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if got := dataObject(t, w)["name"]; got != "王闯" {
		t.Fatalf("name = %v", got)
	}

	w = do(s, http.MethodPost, "/api/stakeholders", `{"name":"张三"}`)
	assertError(t, w, http.StatusConflict, "conflict")

	w = do(s, http.MethodPost, "/api/stakeholders", `{"name":"  "}`)
	assertError(t, w, http.StatusBadRequest, "validation")
}

// PATCH 的 archived 是归档/复岗开关；没传的字段一个都不能被动。
func TestUpdateStakeholderArchiveAndPartialFields(t *testing.T) {
	f := newFakeStore()
	active, _ := seedStakeholders(f)
	s := newTestServer(f)

	w := do(s, http.MethodPatch, "/api/stakeholders/"+active.ID, `{"archived":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if got := dataObject(t, w)["archived_at"]; got == nil {
		t.Fatal("archived=true 之后 archived_at 仍为 null")
	}
	// 只改 role 时不能把 sort_order 清成 0：值类型直接 unmarshal 就会踩这个坑。
	w = do(s, http.MethodPatch, "/api/stakeholders/"+active.ID, `{"role":"架构"}`)
	got := dataObject(t, w)
	if got["role"] != "架构" {
		t.Fatalf("role = %v", got["role"])
	}
	if got["sort_order"] != float64(10) {
		t.Fatalf("sort_order = %v, 期望 10（没传的字段不该被改）", got["sort_order"])
	}
	if got["archived_at"] == nil {
		t.Fatal("没传 archived 时不该顺手复岗")
	}

	w = do(s, http.MethodPatch, "/api/stakeholders/"+active.ID, `{"sort_order":"前面"}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPatch, "/api/stakeholders/stk_nobody", `{"role":"x"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

// 有引用只能归档：人被历史对象引用过，删掉就在列表里留下一个查不出来源的空位。
func TestDeleteStakeholderConflictsWhenReferenced(t *testing.T) {
	f := newFakeStore()
	active, _ := seedStakeholders(f)
	f.objs["obj_1"] = &domain.Object{
		ID: "obj_1", TypeID: "task", Title: "某任务", OwnerID: &active.ID,
	}
	s := newTestServer(f)

	w := do(s, http.MethodDelete, "/api/stakeholders/"+active.ID, "")
	assertError(t, w, http.StatusConflict, "conflict")

	// 参与人同样算引用。
	f.objs["obj_1"].OwnerID = nil
	f.objs["obj_1"].Participants = []domain.StakeholderRef{{ID: active.ID}}
	w = do(s, http.MethodDelete, "/api/stakeholders/"+active.ID, "")
	assertError(t, w, http.StatusConflict, "conflict")

	f.objs["obj_1"].Participants = nil
	if w := do(s, http.MethodDelete, "/api/stakeholders/"+active.ID, ""); w.Code != http.StatusOK {
		t.Fatalf("零引用时应能删除, 状态码 = %d (%s)", w.Code, w.Body.String())
	}
}

// 列表按 owner_id 筛负责人。0010 起取代了 owner 文本匹配，一个语义只留一个定义。
func TestListObjectsFiltersByOwnerID(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)
	if w := do(s, http.MethodGet, "/api/objects?owner_id=stk_1", ""); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	if f.lastFilter.OwnerID != "stk_1" {
		t.Fatalf("owner_id 没传到 store: %+v", f.lastFilter)
	}
}

// PATCH 能改的，POST 建对象时就该能直接带上，否则前端只能「先建后改」两次请求。
func TestCreateObjectAcceptsOwnerAndParticipants(t *testing.T) {
	f := newFakeStore()
	seedStakeholders(f)
	f.stakeholdersMap()["stk_2"] = &domain.Stakeholder{ID: "stk_2", Name: "王闯"}
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/objects",
		`{"type_id":"task","title":"某任务","owner_id":"stk_1","participant_ids":["stk_2"]}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	got := dataObject(t, w)
	if got["owner_id"] != "stk_1" {
		t.Errorf("owner_id = %v", got["owner_id"])
	}
	if got["owner_name"] != "张三" {
		t.Errorf("owner_name = %v, 期望 张三（列表要显示人名）", got["owner_name"])
	}
	parts, _ := got["participants"].([]any)
	if len(parts) != 1 {
		t.Fatalf("participants = %v", got["participants"])
	}
	if p := parts[0].(map[string]any); p["id"] != "stk_2" || p["name"] != "王闯" {
		t.Errorf("参与人 = %v, 期望带上 id 与姓名", p)
	}

	// 空串的 owner_id 等于没有负责人，不能落成一个空串 id。
	w = do(s, http.MethodPost, "/api/objects", `{"type_id":"task","title":"没有负责人","owner_id":""}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if got := dataObject(t, w)["owner_id"]; got != nil {
		t.Errorf(`owner_id: "" 应落成 null, 得到 %v`, got)
	}
}

// owner_id 的空串与 participant_ids 的空数组都是「清空」，
// 而不是「没提这个字段」——两者在 PATCH 上必须分得开。
func TestUpdateObjectClearsOwnerAndParticipants(t *testing.T) {
	f := newFakeStore()
	active, _ := seedStakeholders(f)
	f.objs["obj_1"] = &domain.Object{
		ID: "obj_1", TypeID: "task", Title: "某任务", OwnerID: &active.ID,
		Participants: []domain.StakeholderRef{{ID: active.ID, Name: "张三"}},
	}
	s := newTestServer(f)

	// 不提这两个字段 = 不改。
	w := do(s, http.MethodPatch, "/api/objects/obj_1", `{"title":"改个标题"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastPatch.OwnerID != nil || f.lastPatch.ParticipantIDs != nil {
		t.Fatalf("没提的字段不该解析出值: owner_id=%v participant_ids=%v",
			f.lastPatch.OwnerID, f.lastPatch.ParticipantIDs)
	}
	got := dataObject(t, w)
	if got["owner_id"] != active.ID || len(got["participants"].([]any)) != 1 {
		t.Fatalf("没提这两个字段时不该被动: %v", got)
	}

	w = do(s, http.MethodPatch, "/api/objects/obj_1", `{"owner_id":"","participant_ids":[]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastPatch.ParticipantIDs == nil || len(*f.lastPatch.ParticipantIDs) != 0 {
		t.Fatalf("participant_ids: [] 该解析成空切片而不是 nil: %v", f.lastPatch.ParticipantIDs)
	}
	got = dataObject(t, w)
	if got["owner_id"] != nil {
		t.Errorf(`owner_id: "" 没能清空, 仍是 %v`, got["owner_id"])
	}
	if parts := got["participants"].([]any); len(parts) != 0 {
		t.Errorf("participant_ids: [] 没能清空, 仍是 %v", parts)
	}
}
