package api

import (
	"net/http"
	"testing"
)

// 联系人字段（0026）经 POST、PATCH 读写；last_contact_at 传 null 清空。
func TestStakeholderContactFields(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/stakeholders", `{"name":"宋砚","group":"客户","company":"北岸物流",
		"title":"运营负责人","phone":"135 8899 0011","email":"s@example.com","tags":["潜在客户"],
		"photo":"data:image/png;base64,AA","starred":true,"last_contact_at":"2026-10-01T08:00:00.000Z","note":"展会认识"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	got := dataObject(t, w)
	for k, want := range map[string]any{"group": "客户", "company": "北岸物流", "title": "运营负责人",
		"phone": "135 8899 0011", "photo": "data:image/png;base64,AA", "starred": true} {
		if got[k] != want {
			t.Fatalf("%s = %v, want %v", k, got[k], want)
		}
	}
	if tags, _ := got["tags"].([]any); len(tags) != 1 || tags[0] != "潜在客户" {
		t.Fatalf("tags = %v", got["tags"])
	}
	if got["last_contact_at"] == nil {
		t.Fatal("last_contact_at 没带回来")
	}
	id, _ := got["id"].(string)

	w = do(s, http.MethodPatch, "/api/stakeholders/"+id, `{"starred":false,"last_contact_at":null,"tags":[]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	got = dataObject(t, w)
	if got["starred"] != false || got["last_contact_at"] != nil || got["company"] != "北岸物流" {
		t.Fatalf("PATCH 结果不对: %v", got)
	}

	for _, body := range []string{`{"starred":"yes"}`, `{"tags":"a,b"}`, `{"last_contact_at":"昨天"}`, `{"group":null}`} {
		w = do(s, http.MethodPatch, "/api/stakeholders/"+id, body)
		assertError(t, w, http.StatusBadRequest, "validation")
	}
}
