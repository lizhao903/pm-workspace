package im

import "testing"

// 按项目筛（TSK-0723）：project_id=none 是「未归项目」，口径同读出时的 project_id——
// 消息自己归的（还在的）项目优先，其次所在会话的默认项目；项目删了按没归，按项目筛和「未归项目」都跟着走。

func TestListProjectNone(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	e.push(t, `{"external_id":"C01:a","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"群默认"}`)
	e.push(t, `{"external_id":"C01:b","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"消息上另设"}`)
	e.push(t, `{"external_id":"C02:c","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#ops","sender_id":"U1","sender_name":"林原","text":"没归"}`)
	e.push(t, `{"external_id":"C02:d","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#ops","sender_id":"U1","sender_name":"林原","text":"消息上设"}`)
	_, all := list(t, e.h, "")
	cid := all["C01:a"]["conversation_id"].(string)
	if code, out := call(t, e.h, "PUT", "/api/im/conversation-projects/"+cid, `{"project_id":"obj_acme"}`); code != 200 {
		t.Fatalf("设群默认：%d %v", code, out)
	}
	for k, p := range map[string]string{"C01:b": "obj_globex", "C02:d": "obj_acme"} {
		if code, out := call(t, e.h, "POST", "/api/im/messages/"+all[k]["id"].(string)+"/project", `{"project_id":"`+p+`"}`); code != 200 {
			t.Fatalf("%s 设项目：%d %v", k, code, out)
		}
	}
	keys := func(q string) map[string]bool {
		t.Helper()
		_, got := list(t, e.h, q)
		out := map[string]bool{}
		for k := range got {
			out[k] = true
		}
		return out
	}
	same := func(name string, got map[string]bool, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("%s：%v，要 %v", name, got, want)
		}
		for _, k := range want {
			if !got[k] {
				t.Fatalf("%s：%v，要 %v", name, got, want)
			}
		}
	}
	same("Acme", keys("?project_id=obj_acme"), "C01:a", "C02:d")
	same("Globex", keys("?project_id=obj_globex"), "C01:b")
	same("未归项目", keys("?project_id=none"), "C02:c")
	// 和别的筛选一起用
	same("未归项目且待处理", keys("?project_id=none&status=pending"), "C02:c")
	same("未归项目且在 #product", keys("?project_id=none&conversation_id="+cid))

	// 消息上归的项目删了：按没归，回到群默认；群默认的项目删了：这个群里没单独归的都算未归项目
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = '2026-03-01' WHERE id = 'obj_globex'`)
	same("Globex 删了，消息回到群默认", keys("?project_id=obj_acme"), "C01:a", "C01:b", "C02:d")
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = NULL WHERE id = 'obj_globex'`, `UPDATE objects SET deleted_at = '2026-03-01' WHERE id = 'obj_acme'`)
	same("Acme 删了的未归项目", keys("?project_id=none"), "C01:a", "C02:c", "C02:d")
	_, got := list(t, e.h, "?project_id=none")
	for k, m := range got {
		if m["project_id"] != nil {
			t.Fatalf("未归项目筛出来的 %s 读出时也要没归：%v", k, m)
		}
	}
}
