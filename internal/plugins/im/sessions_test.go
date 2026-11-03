package im

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// deliver 把一条内核事件交给订阅了它的插件（测试里没接事件总线）
func (e actEnv) deliver(t *testing.T, typ string, payload any) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	for _, s := range e.r.Subscribers(typ) {
		if err := s.Handle(context.Background(), plugin.Event{Type: typ, Payload: raw}); err != nil {
			t.Fatalf("%s 处理出错：%v", typ, err)
		}
	}
}

// 从消息发起会话（0008）：记到一组消息上，读出来带 sessions；会话里建的任务来源指向消息时记下，读出来带 split_tasks
func TestSessionLinkAndSplitTasks(t *testing.T) {
	e := setupActions(t)
	ctx := context.Background()
	a := e.push(t, "fake", `{"external_id":"D1:1","connector_id":"cn_ok","conversation_id":"D1","conversation_kind":"direct","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"第一件事"}`)
	b := e.push(t, "fake", `{"external_id":"D1:2","connector_id":"cn_ok","conversation_id":"D1","conversation_kind":"direct","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"第二件事"}`)
	sess, err := e.st.CreateAgentSession(ctx, &domain.AgentSession{Title: "拆分任务", SourceRef: map[string]any{"message_id": a, "message_ids": []any{a, b}}})
	if err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{`{}`, `{"session_id":"` + sess.ID + `"}`, `{"session_id":"` + sess.ID + `","message_ids":["` + a + `"],"intent":"x"}`,
		`{"session_id":"ags_nope","message_ids":["` + a + `"]}`} {
		if code, out := call(t, e.h, "POST", "/api/im/sessions", bad); code != 400 {
			t.Fatalf("%s 应 400：%d %v", bad, code, out)
		}
	}
	if code, _ := call(t, e.h, "POST", "/api/im/sessions", `{"session_id":"`+sess.ID+`","message_ids":["imm_nope"]}`); code != 404 {
		t.Fatalf("消息不存在应 404：%d", code)
	}
	body := `{"session_id":"` + sess.ID + `","message_ids":["` + a + `","` + b + `"],"intent":"split"}`
	code, out := call(t, e.h, "POST", "/api/im/sessions", body)
	if code != 200 || data(out)["intent"] != "split" {
		t.Fatalf("记会话：%d %v", code, out)
	}
	ms := data(out)["messages"].([]any)
	first := ms[0].(map[string]any)
	ss := first["sessions"].([]any)
	if len(ms) != 2 || first["id"] != a || len(ss) != 1 || ss[0].(map[string]any)["session_id"] != sess.ID {
		t.Fatalf("回的消息：%v", ms)
	}
	// 再记一次不重复
	if code, out := call(t, e.h, "POST", "/api/im/sessions", body); code != 200 || len(data(out)["messages"].([]any)[1].(map[string]any)["sessions"].([]any)) != 1 {
		t.Fatalf("重复记：%d %v", code, out)
	}

	// 会话里建的任务（内核把会话来源记进 props.source_ref）
	task, err := e.st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "拆出来的一条", Source: "agent",
		Props: map[string]any{domain.PropSourceRef: sess.SourceRef}}, store.Actor{Name: "agent", Source: "agent"})
	if err != nil {
		t.Fatal(err)
	}
	note, err := e.st.CreateObject(ctx, &domain.Object{TypeID: "note", Title: "不是任务",
		Props: map[string]any{domain.PropSourceRef: sess.SourceRef}}, store.Actor{Name: "agent", Source: "agent"})
	if err != nil {
		t.Fatal(err)
	}
	e.deliver(t, "object.created", map[string]any{"id": task.ID, "type_id": "task"})
	e.deliver(t, "object.created", map[string]any{"id": task.ID, "type_id": "task"})
	e.deliver(t, "object.created", map[string]any{"id": note.ID, "type_id": "note"})
	_, got := list(t, e.h, "")
	for _, k := range []string{"D1:1", "D1:2"} {
		st := got[k]["split_tasks"].([]any)
		if len(st) != 1 || st[0].(map[string]any)["id"] != task.ID || st[0].(map[string]any)["ref"] != task.Ref {
			t.Fatalf("%s 拆出来的任务：%v", k, got[k]["split_tasks"])
		}
	}

	// 转任务建的那一条不算拆出来的
	code, out = call(t, e.h, "POST", "/api/im/messages/"+a+"/task", "")
	if code != 201 {
		t.Fatalf("转任务：%d %v", code, out)
	}
	tid := data(out)["task"].(map[string]any)["id"].(string)
	e.deliver(t, "object.created", map[string]any{"id": tid, "type_id": "task"})
	if _, got = list(t, e.h, ""); len(got["D1:1"]["split_tasks"].([]any)) != 1 {
		t.Fatalf("转任务那条不该算：%v", got["D1:1"]["split_tasks"])
	}

	// 任务软删后不列；会话删了「已发起会话」一起没
	if err := e.st.DeleteObject(ctx, task.ID, false, store.Actor{Name: "u", Source: "ui"}); err != nil {
		t.Fatal(err)
	}
	if err := e.st.DeleteAgentSession(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	_, got = list(t, e.h, "")
	if len(got["D1:2"]["split_tasks"].([]any)) != 0 || len(got["D1:2"]["sessions"].([]any)) != 0 {
		t.Fatalf("删后：%v %v", got["D1:2"]["split_tasks"], got["D1:2"]["sessions"])
	}
}
