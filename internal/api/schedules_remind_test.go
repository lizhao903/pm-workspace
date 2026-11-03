package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 提醒（动作 remind）：新建回规范化的字段，GET /api/schedules?object_id= 只回关联这个对象的提醒。
func TestScheduleRemindByObject(t *testing.T) {
	s, _ := newScheduleServer(t)
	mk := func(body string) scheduleResp {
		t.Helper()
		w := do(s, "POST", "/api/schedules", body)
		mustCode(t, w, http.StatusCreated, "create")
		return decodeSchedule(t, w.Body.Bytes())
	}
	a := mk(`{"name":"提醒：回电话","rule":{"freq":"once","date":"2026-10-30","time":"09:00"},
		"action":{"kind":"remind","title":" 回电话 ","body":"","object_id":"obj_a","priority":"P1"}}`)
	if a.Action["title"] != "回电话" || a.Action["object_id"] != "obj_a" || a.Action["body"] != "" || a.Action["priority"] != nil {
		t.Fatalf("action = %v", a.Action)
	}
	mk(`{"name":"喝水","rule":{"freq":"daily","time":"15:00"},"action":{"kind":"remind","title":"喝水"}}`)
	mk(`{"name":"建任务","rule":{"freq":"daily","time":"15:00"},"action":{"kind":"task","title":"obj_a"}}`)

	w := do(s, "GET", "/api/schedules?object_id=obj_a", "")
	mustCode(t, w, http.StatusOK, "list by object")
	var env struct {
		Data []scheduleResp `json:"data"`
		Meta struct {
			Total int `json:"total"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data) != 1 || env.Data[0].ID != a.ID || env.Meta.Total != 1 {
		t.Fatalf("按对象查 = %+v", env)
	}
	w = do(s, "GET", "/api/schedules?object_id=obj_none", "")
	mustCode(t, w, http.StatusOK, "list none")
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil || len(env.Data) != 0 {
		t.Fatalf("没有的对象应回空数组：%s", w.Body.Bytes())
	}

	// 标题必填
	w = do(s, "POST", "/api/schedules", `{"name":"x","rule":{"freq":"daily","time":"09:00"},"action":{"kind":"remind","title":" "}}`)
	mustCode(t, w, http.StatusBadRequest, "title required")
}
