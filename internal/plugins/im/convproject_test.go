// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import "testing"

// 群组默认归属的项目（0007）：设、改、清除；消息没归时按会话默认项目兜底，消息上设的优先；按 project_id 筛也算进来。

func TestConversationDefaultProject(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	e.push(t, `{"external_id":"C01:d1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"一"}`)
	e.push(t, `{"external_id":"C01:d2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"二"}`)
	e.push(t, `{"external_id":"C02:d3","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#ops","sender_id":"U1","sender_name":"林原","text":"三"}`)
	_, all := list(t, e.h, "")
	cid, _ := all["C01:d1"]["conversation_id"].(string)
	if cid == "" {
		t.Fatalf("会话要认上：%v", all["C01:d1"])
	}
	if all["C01:d1"]["project_source"] != "" {
		t.Fatalf("没归时 project_source 为空串：%v", all["C01:d1"])
	}
	if code, out := call(t, e.h, "GET", "/api/im/conversation-projects", ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("还没设：%d %v", code, out)
	}

	// 按 ref 设
	code, out := call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{"project_id":"PRJ-0001"}`)
	if d := data(out); code != 200 || d["project_id"] != "obj_acme" || d["project_name"] != "Acme" || d["project_ref"] != "PRJ-0001" || d["conversation_id"] != cid {
		t.Fatalf("设默认项目：%d %v", code, out)
	}
	_, all = list(t, e.h, "")
	for _, k := range []string{"C01:d1", "C01:d2"} {
		if all[k]["project_id"] != "obj_acme" || all[k]["project_name"] != "Acme" || all[k]["project_source"] != "conversation" {
			t.Fatalf("%s 按群组默认项目兜底：%v", k, all[k])
		}
	}
	if all["C02:d3"]["project_id"] != nil {
		t.Fatalf("别的群不受影响：%v", all["C02:d3"])
	}
	if n, got := list(t, e.h, "?project_id=obj_acme"); n != 2 || got["C01:d1"] == nil {
		t.Fatalf("按项目筛要算上群组默认：%d %v", n, got)
	}
	code, out = call(t, e.h, "GET", "/api/im/conversation-projects", "")
	if rows := out["data"].([]any); code != 200 || len(rows) != 1 || rows[0].(map[string]any)["project_name"] != "Acme" {
		t.Fatalf("列表：%d %v", code, out)
	}

	// 消息上手动设的优先，改了也不跟着群组
	mid := all["C01:d2"]["id"].(string)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/project", `{"project_id":"obj_globex"}`); code != 200 ||
		data(out)["project_id"] != "obj_globex" || data(out)["project_source"] != "message" {
		t.Fatalf("手动设：%d %v", code, out)
	}
	if n, _ := list(t, e.h, "?project_id=obj_acme"); n != 1 {
		t.Fatalf("手动改走的不再算群组默认：%d", n)
	}
	// 清掉消息上的归属，回到群组默认
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/project", `{"project_id":null}`); code != 200 || data(out)["project_source"] != "conversation" {
		t.Fatalf("清掉手动归属后回到群组默认：%d %v", code, out)
	}

	// 按名字改默认项目
	if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{"project_id":"Globex"}`); code != 200 || data(out)["project_id"] != "obj_globex" {
		t.Fatalf("改默认项目：%d %v", code, out)
	}
	if n, _ := list(t, e.h, "?project_id=obj_globex"); n != 2 {
		t.Fatalf("改了默认项目，消息跟着走：%d", n)
	}

	// 校验
	for _, key := range []string{"obj_nope", "旧项目", "obj_task"} {
		if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{"project_id":"`+key+`"}`); code != 400 || errOf(out)["code"] != "validation" {
			t.Fatalf("%s 要 400：%d %v", key, code, out)
		}
	}
	if code, _ := call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{}`); code != 400 {
		t.Fatalf("不带 project_id：%d", code)
	}
	if code, _ := call(t, e.h, "PUT", "/api/im/conversation-projects/cv_none", `{"project_id":"Globex"}`); code != 404 {
		t.Fatalf("会话不存在：%d", code)
	}

	// 项目进了回收站：按没设，列表里也不列
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = '2026-03-01' WHERE id = 'obj_globex'`)
	if _, got := list(t, e.h, ""); got["C01:d1"]["project_id"] != nil || got["C01:d1"]["project_source"] != "" {
		t.Fatalf("项目删了按没归：%v", got["C01:d1"])
	}
	if _, out := call(t, e.h, "GET", "/api/im/conversation-projects", ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("项目删了不列：%v", out)
	}
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = NULL WHERE id = 'obj_globex'`)

	// 清除
	code, out = call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{"project_id":null}`)
	if code != 200 || data(out)["project_id"] != nil {
		t.Fatalf("清除：%d %v", code, out)
	}
	if n, _ := list(t, e.h, "?project_id=obj_globex"); n != 0 {
		t.Fatalf("清除后不再兜底：%d", n)
	}
}
