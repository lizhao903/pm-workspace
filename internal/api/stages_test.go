package api

import (
	"net/http"
	"testing"
)

// AUTO-05：改阶段只换 props.stage、不冲掉别的 props；非法阶段、非任务被拒；阶段变化记审计；
// 按来源消息、提出人（联系人或 IM 发送者）查阶段。
func TestTaskStageAndQuery(t *testing.T) {
	s, _ := newAuditServer(t)

	a := createObjectID(t, s, `{"type_id":"task","title":"IM 转来","source":"im","props":{"acceptance":"- [ ] x",
		"source_ref":{"message_id":"imm_1"},"requester":{"contact_id":"sh_a","name":"甲","channel":"slack","sender_id":"U1","sender_name":"甲"}}}`)
	b := createObjectID(t, s, `{"type_id":"task","title":"认不上的人","props":{"requester":{"name":"路人","channel":"slack","sender_id":"U9","sender_name":"路人"}}}`)
	req := createObjectID(t, s, `{"type_id":"requirement","title":"需求"}`)

	w := do(s, "PUT", "/api/objects/"+a+"/stage", `{"stage":"designing"}`)
	mustCode(t, w, http.StatusOK, "set stage")
	props := decodeEnvelope(t, w)["data"].(map[string]any)["props"].(map[string]any)
	if props["stage"] != "designing" || props["acceptance"] != "- [ ] x" || props["requester"] == nil {
		t.Fatalf("改阶段后 props = %v，要只换 stage", props)
	}

	mustCode(t, do(s, "PUT", "/api/objects/"+a+"/stage", `{"stage":"nope"}`), http.StatusBadRequest, "非法阶段")
	mustCode(t, do(s, "PUT", "/api/objects/"+a+"/stage", `{}`), http.StatusBadRequest, "没给 stage")
	mustCode(t, do(s, "PUT", "/api/objects/"+req+"/stage", `{"stage":"designing"}`), http.StatusBadRequest, "需求没有阶段")
	mustCode(t, do(s, "PATCH", "/api/objects/"+b, `{"props":{"stage":"bogus"}}`), http.StatusBadRequest, "PATCH 非法阶段")
	mustCode(t, do(s, "POST", "/api/objects", `{"type_id":"task","title":"x","props":{"requester":{"channel":"slack"}}}`), http.StatusBadRequest, "提出人没名字")

	// 审计：阶段变化记 kind=stage，同阶段重复设不记
	mustCode(t, do(s, "PUT", "/api/objects/"+a+"/stage", `{"stage":"designing"}`), http.StatusOK, "同阶段")
	au := listAudits(t, s, "kind=stage&target_id="+a)
	if len(au) != 1 {
		t.Fatalf("阶段审计 %d 条，要 1 条：%v", len(au), au)
	}
	if d := au[0]["detail"].(map[string]any); d["from"] != "" || d["to"] != "designing" {
		t.Fatalf("阶段审计 detail = %v", d)
	}

	// 定义
	w = do(s, "GET", "/api/task-stages", "")
	mustCode(t, w, http.StatusOK, "stage defs")
	if defs := decodeEnvelope(t, w)["data"].([]any); len(defs) != 11 || defs[0].(map[string]any)["key"] != "received" {
		t.Fatalf("阶段定义 = %v", defs)
	}

	query := func(q string) []any {
		t.Helper()
		w := do(s, "GET", "/api/tasks/stages?"+q, "")
		mustCode(t, w, http.StatusOK, "stages?"+q)
		return decodeEnvelope(t, w)["data"].([]any)
	}
	rows := query("message_id=imm_1")
	if len(rows) != 1 {
		t.Fatalf("按消息查 %d 条", len(rows))
	}
	r := rows[0].(map[string]any)
	if r["id"] != a || r["stage"] != "designing" || r["stage_label"] != "设计中" || r["message_id"] != "imm_1" ||
		r["requester"].(map[string]any)["contact_id"] != "sh_a" {
		t.Fatalf("按消息查 = %v", r)
	}
	if rows := query("requester_id=sh_a"); len(rows) != 1 || rows[0].(map[string]any)["id"] != a {
		t.Fatalf("按联系人查 = %v", rows)
	}
	if rows := query("channel=slack&sender_id=U9"); len(rows) != 1 || rows[0].(map[string]any)["id"] != b {
		t.Fatalf("按发送者查 = %v", rows)
	}
	if rows := query("channel=telegram&sender_id=U9"); len(rows) != 0 {
		t.Fatalf("别的渠道同号查出了 %v", rows)
	}
	mustCode(t, do(s, "GET", "/api/tasks/stages", ""), http.StatusBadRequest, "没条件")
	mustCode(t, do(s, "GET", "/api/tasks/stages?channel=slack", ""), http.StatusBadRequest, "渠道没配发送者")

	// 列表筛选：按阶段（none 是没设阶段）、提出人
	w = do(s, "GET", "/api/objects?type=task&stage=none", "")
	mustCode(t, w, http.StatusOK, "stage=none")
	if items := decodeEnvelope(t, w)["data"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != b {
		t.Fatalf("stage=none = %v", items)
	}
	mustCode(t, do(s, "GET", "/api/objects?requester_channel=slack", ""), http.StatusBadRequest, "列表渠道没配发送者")

	// 清掉阶段
	w = do(s, "PUT", "/api/objects/"+a+"/stage", `{"stage":""}`)
	mustCode(t, w, http.StatusOK, "clear stage")
	if _, has := decodeEnvelope(t, w)["data"].(map[string]any)["props"].(map[string]any)["stage"]; has {
		t.Fatal("清阶段后 props 里还有 stage")
	}
}
