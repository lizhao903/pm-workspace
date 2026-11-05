package im

import (
	"strings"
	"testing"
)

// 消息归到项目（0006）：手动设、清除，按 project_id 筛；SOP 节点 im_set_project 认项目 id、ref、名字。

func seedProjects(t *testing.T, e sopEnv) {
	t.Helper()
	exec(t, e.st.DB(),
		`INSERT INTO objects (id, type_id, ref, title, props, created_at, updated_at) VALUES
		  ('obj_acme', 'project', 'PRJ-0001', 'Acme', '{"related":[{"label":"文档","path":"/tmp/x"}]}', '2026-01-01', '2026-01-01'),
		  ('obj_globex', 'project', 'PRJ-0002', 'Globex', '{}', '2026-01-02', '2026-01-02'),
		  ('obj_gone', 'project', 'PRJ-0003', '旧项目', '{}', '2026-01-03', '2026-01-03'),
		  ('obj_task', 'task', 'T-0001', 'Acme', '{}', '2026-01-04', '2026-01-04')`,
		`UPDATE objects SET deleted_at = '2026-02-01' WHERE id = 'obj_gone'`,
	)
}

func TestSetProjectByHand(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	e.push(t, `{"external_id":"C01:p1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"Acme 的排期"}`)
	e.push(t, `{"external_id":"C01:p2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"别的事"}`)
	_, all := list(t, e.h, "")
	id := all["C01:p1"]["id"].(string)
	if all["C01:p1"]["project_id"] != nil || all["C01:p1"]["project_name"] != "" {
		t.Fatalf("没归时 project_id 为 null、project_name 为空：%v", all["C01:p1"])
	}

	// 按 ref 认
	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{"project_id":"prj-0001"}`)
	if code != 200 || data(out)["project_id"] != "obj_acme" || data(out)["project_name"] != "Acme" {
		t.Fatalf("归到项目：%d %v", code, out)
	}
	if n, got := list(t, e.h, "?project_id=obj_acme"); n != 1 || got["C01:p1"] == nil {
		t.Fatalf("按项目筛：%v", got)
	}
	if n, _ := list(t, e.h, "?project_id=obj_globex"); n != 0 {
		t.Fatalf("别的项目筛出 %d 条", n)
	}
	// 按名字改到另一个项目
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{"project_id":"Globex"}`); code != 200 || data(out)["project_id"] != "obj_globex" {
		t.Fatalf("改项目：%d %v", code, out)
	}
	// 不存在、已删除、不是项目的都 400
	for _, key := range []string{"obj_nope", "旧项目", "obj_task"} {
		code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{"project_id":"`+key+`"}`)
		if code != 400 || errOf(out)["code"] != "validation" {
			t.Fatalf("%s 要 400：%d %v", key, code, out)
		}
	}
	// 不带 project_id 400，不当清除
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{}`); code != 400 {
		t.Fatalf("不带 project_id：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/messages/msg_none/project", `{"project_id":null}`); code != 404 {
		t.Fatalf("消息不存在：%d", code)
	}
	// 清除
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{"project_id":null}`)
	if code != 200 || data(out)["project_id"] != nil || data(out)["project_name"] != "" {
		t.Fatalf("清除：%d %v", code, out)
	}

	// 项目进了回收站：接口上按没归
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/project", `{"project_id":"obj_acme"}`); code != 200 {
		t.Fatal("再归一次")
	}
	exec(t, e.st.DB(), `UPDATE objects SET deleted_at = '2026-03-01' WHERE id = 'obj_acme'`)
	if _, got := list(t, e.h, ""); got["C01:p1"]["project_id"] != nil {
		t.Fatalf("项目删了按没归：%v", got["C01:p1"])
	}
}

func TestSOPSetProjectNode(t *testing.T) {
	e := setupSOP(t)
	seedProjects(t, e)
	if nt := nodeTypes(t, e.h)[NodeSetProject]; nt == nil || nt["source"] != "im" {
		t.Fatalf("节点目录里要有 im_set_project：%v", nt)
	}
	e.push(t, `{"external_id":"C01:s1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"Globex 的合同"}`)
	_, all := list(t, e.h, "")
	mid := all["C01:s1"]["id"].(string)

	// 读取消息之后归到项目：消息取 message.id，项目按名字、支持 {{字段}}
	id := e.flow(t, `{"name":"分流","fields":[{"key":"message_id","label":"消息","type":"text"},{"key":"which","label":"项目","type":"text"}],"steps":[
		{"key":"read","name":"读取消息","kind":"im_get_message","after":[]},
		{"key":"p","name":"归到项目","kind":"im_set_project","after":["read"],"config":{"project":"{{which}}"}}]}`)
	rid := e.start(t, id, `{"input":{"message_id":"`+mid+`","which":"Globex"}}`)
	run := e.until(t, rid, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	p := sopStep(run, "p")["output"].(map[string]any)["project"].(map[string]any)
	if p["id"] != "obj_globex" || p["ref"] != "PRJ-0002" || p["name"] != "Globex" || p["message_id"] != mid {
		t.Fatalf("输出的 project：%v", p)
	}
	if _, got := list(t, e.h, "?project_id=obj_globex"); got["C01:s1"] == nil {
		t.Fatal("消息要归到 Globex")
	}

	// 项目不存在、没填项目：这一步失败，原因写清楚
	for _, c := range []struct{ cfg, want string }{
		{`{"project":"Nope"}`, "项目「Nope」不存在"},
		{`{"project":"{{empty}}"}`, "没有指定项目"},
		{`{"project":"旧项目"}`, "项目「旧项目」不存在"},
	} {
		id := e.flow(t, `{"name":"错","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
			{"key":"p","name":"归到项目","kind":"im_set_project","after":[],"config":`+c.cfg+`}]}`)
		rid := e.start(t, id, `{"input":{"message_id":"`+mid+`"}}`)
		run := e.until(t, rid, "失败", func(r map[string]any) bool { return sopStep(r, "p")["status"] == "failed" })
		if err, _ := sopStep(run, "p")["error"].(string); !strings.Contains(err, c.want) {
			t.Fatalf("%s：%q", c.cfg, err)
		}
	}
}
