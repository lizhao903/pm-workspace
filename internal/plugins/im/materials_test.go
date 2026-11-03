package im

import (
	"context"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 消息转项目资料（0009）：记出处、消息上带 materials、项目资料页按项目列出处、移除时清掉；项目软删不列、硬删级联
func TestMaterialLinks(t *testing.T) {
	e := setupActions(t)
	ctx := context.Background()
	exec(t, e.st.DB(),
		`INSERT INTO objects (id, type_id, ref, title, props, created_at, updated_at) VALUES
		  ('obj_octok', 'project', 'PRJ-0001', 'Octok', '{}', '2026-01-01', '2026-01-01'),
		  ('obj_xaue', 'project', 'PRJ-0002', 'XAUE', '{}', '2026-01-02', '2026-01-02'),
		  ('obj_task', 'task', 'T-0001', '任务', '{}', '2026-01-04', '2026-01-04')`)
	a := e.push(t, "fake", `{"external_id":"C1:1","connector_id":"cn_ok","conversation_id":"C1","conversation_name":"#product","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"先说需求","at":"2026-10-30T06:00:00Z"}`)
	b := e.push(t, "fake", `{"external_id":"C1:2","connector_id":"cn_ok","conversation_id":"C1","conversation_name":"#product","sender_id":"U9","sender_name":"Kevin","text":"补一句","at":"2026-10-30T06:05:00Z","attachments":[{"id":"f1","kind":"link","name":"Figma","url":"https://figma.com/x"}]}`)

	for _, bad := range []string{
		`{}`,
		`{"material_id":"mt_1","project_id":"obj_octok"}`,
		`{"material_id":"mt_1","message_ids":["` + a + `"]}`,
		`{"material_id":"mt_1","project_id":"obj_nope","message_ids":["` + a + `"]}`,
		`{"material_id":"mt_1","project_id":"obj_task","message_ids":["` + a + `"]}`,
		`{"material_id":"mt_1","project_id":"obj_octok","message_ids":["` + a + `"],"kind":"x"}`,
		`{"material_id":"mt_1","project_id":"obj_octok","message_ids":["` + a + `"],"kind":"attachment"}`,
		`{"material_id":"mt_1","project_id":"obj_octok","message_ids":["` + b + `"],"kind":"attachment","attachment_id":"nope"}`,
		`{"material_id":"mt_1","project_id":"obj_octok","message_ids":["` + a + `"],"attachment_id":"f1"}`,
	} {
		if code, out := call(t, e.h, "POST", "/api/im/materials", bad); code != 400 || errOf(out)["code"] != "validation" {
			t.Fatalf("%s 应 400：%d %v", bad, code, out)
		}
	}
	if code, _ := call(t, e.h, "POST", "/api/im/materials", `{"material_id":"mt_1","project_id":"obj_octok","message_ids":["imm_nope"]}`); code != 404 {
		t.Fatalf("消息不存在应 404：%d", code)
	}

	// 一组消息转成一条笔记：给的顺序不论，出处按时间正序
	code, out := call(t, e.h, "POST", "/api/im/materials", `{"material_id":"mt_1","project_id":"PRJ-0001","message_ids":["`+b+`","`+a+`"],"title":"#product 10月30日 的消息"}`)
	if code != 201 {
		t.Fatalf("记出处：%d %v", code, out)
	}
	src := data(out)["source"].(map[string]any)
	if src["project_id"] != "obj_octok" || src["kind"] != "messages" || src["channel"] != "slack" || src["conversation"] != "#product" ||
		src["first_at"] != "2026-10-30T06:00:00.000Z" || src["last_at"] != "2026-10-30T06:05:00.000Z" {
		t.Fatalf("出处：%v", src)
	}
	if ids := src["message_ids"].([]any); len(ids) != 2 || ids[0] != a || ids[1] != b {
		t.Fatalf("消息按时间正序：%v", ids)
	}
	if ss := src["senders"].([]any); len(ss) != 2 || ss[0] != "林原" || ss[1] != "Kevin" {
		t.Fatalf("发信人（认上的用联系人名）：%v", ss)
	}
	if ms := data(out)["messages"].([]any); len(ms) != 2 {
		t.Fatalf("回记好后的消息：%v", ms)
	}
	// 同一条资料再记 409
	if code, out := call(t, e.h, "POST", "/api/im/materials", `{"material_id":"mt_1","project_id":"obj_octok","message_ids":["`+a+`"]}`); code != 409 || errOf(out)["code"] != "conflict" {
		t.Fatalf("重复记：%d %v", code, out)
	}
	// 附件加进另一个项目
	if code, out := call(t, e.h, "POST", "/api/im/materials", `{"material_id":"mt_2","project_id":"obj_xaue","message_ids":["`+b+`"],"kind":"attachment","attachment_id":"f1","title":"Figma"}`); code != 201 {
		t.Fatalf("附件：%d %v", code, out)
	}

	_, got := list(t, e.h, "")
	ma := got["C1:1"]["materials"].([]any)
	mb := got["C1:2"]["materials"].([]any)
	if len(ma) != 1 || len(mb) != 2 {
		t.Fatalf("消息上的资料：%v / %v", ma, mb)
	}
	first := ma[0].(map[string]any)
	if first["material_id"] != "mt_1" || first["project_name"] != "Octok" || first["count"] != float64(2) || first["title"] != "#product 10月30日 的消息" {
		t.Fatalf("消息上的资料：%v", first)
	}
	if mb[0].(map[string]any)["material_id"] != "mt_2" || mb[0].(map[string]any)["attachment_id"] != "f1" {
		t.Fatalf("新的在前：%v", mb)
	}

	// 按项目列出处
	if code, _ := call(t, e.h, "GET", "/api/im/materials", ""); code != 400 {
		t.Fatalf("不带项目：%d", code)
	}
	code, out = call(t, e.h, "GET", "/api/im/materials?project_id=obj_octok", "")
	rows, _ := out["data"].([]any)
	if code != 200 || len(rows) != 1 || rows[0].(map[string]any)["material_id"] != "mt_1" || len(rows[0].(map[string]any)["message_ids"].([]any)) != 2 {
		t.Fatalf("项目里的出处：%d %v", code, out)
	}

	// 资料移除了清掉出处；再删 404
	if code, _ := call(t, e.h, "DELETE", "/api/im/materials/mt_2", ""); code != 200 {
		t.Fatalf("清出处：%d", code)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/im/materials/mt_2", ""); code != 404 {
		t.Fatalf("再清：%d", code)
	}
	if _, got = list(t, e.h, ""); len(got["C1:2"]["materials"].([]any)) != 1 {
		t.Fatalf("清掉后：%v", got["C1:2"]["materials"])
	}

	// 项目软删：消息上不列；硬删：级联
	if err := e.st.DeleteObject(ctx, "obj_octok", false, store.Actor{Name: "u", Source: "ui"}); err != nil {
		t.Fatal(err)
	}
	if _, got = list(t, e.h, ""); len(got["C1:1"]["materials"].([]any)) != 0 {
		t.Fatalf("项目软删后：%v", got["C1:1"]["materials"])
	}
	if err := e.st.DeleteObject(ctx, "obj_octok", true, store.Actor{Name: "u", Source: "ui"}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.st.DB().R.QueryRowContext(ctx, `SELECT COUNT(*) FROM im_material_messages`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("硬删后剩 %d 条（%v）", n, err)
	}
}
