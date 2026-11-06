package im

import (
	"testing"
	"time"
)

// TSK-0495：自动忽略发信人。按渠道身份（机器人编号）、按联系人、只在某个会话里；
// 命中的新消息入库即已忽略、已读、不发事件；一并忽略已有待处理；取消后恢复，已忽略的不恢复。
func TestMuteSender(t *testing.T) {
	e := setup(t)
	post := func(body string) {
		t.Helper()
		if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", body); code != 200 {
			t.Fatalf("回调：%d %v", code, out)
		}
	}
	// 先到两条：Google Calendar 机器人私信一条（待处理）、林原在 #product 一条
	post(`{"messages":[
	  {"external_id":"D01:1","conversation_id":"D01","conversation_kind":"direct","sender_id":"B0GCAL","sender_name":"Google Calendar","text":"会议提醒 1","at":"2026-11-06T01:00:00Z"},
	  {"external_id":"C01:1","conversation_id":"C01","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"@Broleez 看下","at":"2026-11-06T01:00:00Z"}
	]}`)
	e.bus.Wait(time.Second)
	before := len(e.watch.events())

	// 一并忽略前先看条数
	code, out := call(t, e.h, "GET", "/api/im/mutes/pending?channel=slack&sender_id=B0GCAL", "")
	if code != 200 || out["data"].(map[string]any)["pending"] != 1.0 {
		t.Fatalf("待处理条数：%d %v", code, out)
	}
	code, out = call(t, e.h, "POST", "/api/im/mutes", `{"channel":"slack","sender_id":"B0GCAL","ignore_pending":true}`)
	if code != 201 {
		t.Fatalf("标记：%d %v", code, out)
	}
	res := out["data"].(map[string]any)
	mute := res["mute"].(map[string]any)
	muteID := mute["id"].(string)
	if res["created"] != true || res["ignored"] != 1.0 || mute["kind"] != "sender" || mute["name"] != "Google Calendar" || mute["ignored"] != 1.0 || mute["conversation_id"] != nil {
		t.Fatalf("标记结果：%v", res)
	}
	// 同一对象再标一次回原来那条
	if code, out := call(t, e.h, "POST", "/api/im/mutes", `{"channel":"Slack","sender_id":"B0GCAL"}`); code != 200 || out["data"].(map[string]any)["created"] != false {
		t.Fatalf("重复标记：%d %v", code, out)
	}

	// 新消息：入库即已忽略、已读、不发事件；别人照常
	post(`{"messages":[
	  {"external_id":"D01:2","conversation_id":"D01","conversation_kind":"direct","sender_id":"B0GCAL","sender_name":"Google Calendar","text":"会议提醒 2","at":"2026-11-06T02:00:00Z"},
	  {"external_id":"C01:2","conversation_id":"C01","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"在吗","at":"2026-11-06T02:00:00Z"}
	]}`)
	e.bus.Wait(time.Second)
	if n := len(e.watch.events()) - before; n != 1 {
		t.Fatalf("只有没被忽略的那条发事件：%d", n)
	}
	_, got := list(t, e.h, "")
	for _, ext := range []string{"D01:1", "D01:2"} {
		m := got[ext]
		mu, _ := m["muted"].(map[string]any)
		if m["status"] != "ignored" || m["read"] != true || mu == nil || mu["mute_id"] != muteID || mu["name"] != "Google Calendar" || mu["active"] != true {
			t.Fatalf("%s 应被自动忽略：%v", ext, m)
		}
	}
	if m := got["C01:2"]; m["status"] != "pending" || m["muted"] != nil {
		t.Fatalf("别人的消息照常：%v", m)
	}
	if n, _ := list(t, e.h, "?unread=true"); n != 2 {
		t.Fatalf("被忽略的不计未读：%d", n)
	}

	// 按联系人、只在 #product 里：林原在 #product 的忽略，在别处照常
	code, out = call(t, e.h, "POST", "/api/im/mutes", `{"stakeholder_id":"stk_lin","conversation_id":"cv_prod"}`)
	if code != 201 || out["data"].(map[string]any)["ignored"] != 0.0 {
		t.Fatalf("按联系人标：%d %v", code, out)
	}
	cm := out["data"].(map[string]any)["mute"].(map[string]any)
	if cm["kind"] != "contact" || cm["name"] != "林原" || cm["contact_name"] != "林原" || cm["conversation"] != "#product" {
		t.Fatalf("联系人标记：%v", cm)
	}
	post(`{"messages":[
	  {"external_id":"C01:3","conversation_id":"C01","sender_id":"U04LIN","text":"#product 里","at":"2026-11-06T03:00:00Z"},
	  {"external_id":"C99:3","conversation_id":"C99","conversation_name":"#ops","sender_id":"U04LIN","text":"#ops 里","at":"2026-11-06T03:00:00Z"}
	]}`)
	_, got = list(t, e.h, "")
	if got["C01:3"]["status"] != "ignored" || got["C99:3"]["status"] != "pending" {
		t.Fatalf("会话级只在 #product 生效：%v / %v", got["C01:3"]["status"], got["C99:3"]["status"])
	}

	// 参数不对
	for _, body := range []string{`{}`, `{"channel":"slack"}`, `{"stakeholder_id":"stk_none"}`, `{"channel":"slack","sender_id":"B1","stakeholder_id":"stk_lin"}`,
		`{"channel":"slack","sender_id":"B1","conversation_id":"cv_none"}`} {
		if code, _ := call(t, e.h, "POST", "/api/im/mutes", body); code != 400 {
			t.Errorf("%s 应 400：%d", body, code)
		}
	}

	// 列表、取消：之后新消息恢复正常，已忽略的不恢复，消息上 active 变 false
	code, out = call(t, e.h, "GET", "/api/im/mutes", "")
	if code != 200 || out["meta"].(map[string]any)["total"] != 2.0 {
		t.Fatalf("列表：%d %v", code, out)
	}
	code, out = call(t, e.h, "DELETE", "/api/im/mutes/"+muteID, "")
	if code != 200 || out["data"].(map[string]any)["ignored"] != 2.0 {
		t.Fatalf("取消：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/im/mutes/"+muteID, ""); code != 404 {
		t.Fatalf("再取消应 404：%d", code)
	}
	post(`{"messages":[{"external_id":"D01:3","conversation_id":"D01","conversation_kind":"direct","sender_id":"B0GCAL","text":"会议提醒 3","at":"2026-11-06T04:00:00Z"}]}`)
	_, got = list(t, e.h, "")
	if got["D01:3"]["status"] != "pending" || got["D01:2"]["status"] != "ignored" {
		t.Fatalf("取消后新消息正常、旧的不恢复：%v / %v", got["D01:3"]["status"], got["D01:2"]["status"])
	}
	if mu := got["D01:2"]["muted"].(map[string]any); mu["active"] != false {
		t.Fatalf("取消后 active=false：%v", mu)
	}
	// 手动改回待处理后不再标「自动忽略」
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+got["D01:2"]["id"].(string)+"/reopen", ""); code != 200 || out["data"].(map[string]any)["muted"] != nil {
		t.Fatalf("改回待处理：%d %v", code, out)
	}
}
