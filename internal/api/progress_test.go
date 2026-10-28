package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func TestActorFromReadsNameAndSession(t *testing.T) {
	tests := []struct {
		name, hName, hSession string
		wantName, wantSession string
	}{
		{"缺省", "", "", "me", ""},
		{"正常", "claude-code", "332d2cac-6041-4a72", "claude-code", "332d2cac-6041-4a72"},
		// 分隔符和控制字符要去掉，否则 SplitActor 会把名字拆错。
		{"名字带分隔符", "evil#name\n", "", "evilname", ""},
		// 会话标识里有非法字符就整串作废，不做截断或替换——那会让它和别的会话撞上。
		{"会话带非法字符", "claude-code", "abc def", "claude-code", ""},
		{"会话超长", "claude-code", strings.Repeat("a", actorSessionMax+1), "claude-code", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeStore()
			f.objs["obj_1"] = &domain.Object{ID: "obj_1", TypeID: "task", Status: "todo"}
			s := newTestServer(f)
			w := do(s, http.MethodPost, "/api/objects/obj_1/progress", `{"text":"x"}`,
				[2]string{"X-Actor-Source", "agent"},
				[2]string{"X-Actor-Name", tt.hName},
				[2]string{"X-Actor-Session", tt.hSession})
			if w.Code != http.StatusCreated {
				t.Fatalf("状态码 %d: %s", w.Code, w.Body.String())
			}
			if f.lastActor.Name != tt.wantName || f.lastActor.Session != tt.wantSession || f.lastActor.Source != "agent" {
				t.Fatalf("actor = %+v", f.lastActor)
			}
		})
	}
}

func TestProgressEndpoints(t *testing.T) {
	f := newFakeStore()
	f.objs["obj_1"] = &domain.Object{ID: "obj_1", TypeID: "task", Status: "todo"}
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/objects/obj_1/progress",
		`{"text":"改完了","commits":["abc"],"files":["a.go"]}`,
		[2]string{"X-Actor-Session", "s1"})
	if w.Code != http.StatusCreated {
		t.Fatalf("追加状态码 %d: %s", w.Code, w.Body.String())
	}
	w = do(s, http.MethodGet, "/api/objects/obj_1/progress", "")
	m := decodeEnvelope(t, w)
	items, _ := m["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("应读回 1 条: %s", w.Body.String())
	}
	got := items[0].(map[string]any)
	if got["text"] != "改完了" || got["session_id"] != "s1" || got["kind"] != "note" {
		t.Fatalf("读回内容不对: %v", got)
	}

	assertError(t, do(s, http.MethodGet, "/api/objects/obj_x/progress", ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, http.MethodPost, "/api/objects/obj_1/progress", ``), http.StatusBadRequest, "validation")
}

func TestClaimEndpointStatusCodes(t *testing.T) {
	f := newFakeStore()
	other := "stk_other"
	f.objs["obj_1"] = &domain.Object{ID: "obj_1", TypeID: "task", Status: "todo"}
	f.objs["obj_2"] = &domain.Object{ID: "obj_2", TypeID: "task", Status: "todo", OwnerID: &other}
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/objects/obj_1/claim", `{"owner_id":"stk_cc"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("领取状态码 %d: %s", w.Code, w.Body.String())
	}
	m := decodeEnvelope(t, w)
	data := m["data"].(map[string]any)
	if data["object"].(map[string]any)["status"] != "doing" || data["progress"].(map[string]any)["kind"] != "claim" {
		t.Fatalf("领取结果不对: %v", data)
	}
	assertError(t, do(s, http.MethodPost, "/api/objects/obj_2/claim", `{"owner_id":"stk_cc"}`), http.StatusConflict, "conflict")
}
