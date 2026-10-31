package im

import (
	"testing"
	"time"
)

// 已过期（IM-07）：待处理的消息超过天数没处理标成已过期，接口状态为 expired、带 expired_at，不再算待处理；
// 稍后提醒没到点的、已处理的、天数以内的不动；改回待处理后从当时重新起算，不会下一轮又被标过期；0 天不过期。
func TestMessagesExpire(t *testing.T) {
	old := expireEvery
	expireEvery = 20 * time.Millisecond
	t.Cleanup(func() { expireEvery = old })
	e := setupActions(t)
	settings := func(body string) (int, map[string]any) { return call(t, e.h, "PATCH", "/api/im/settings", body) }
	if code, out := call(t, e.h, "GET", "/api/im/settings", ""); code != 200 || data(out)["expire_days"] != float64(7) {
		t.Fatalf("默认 7 天：%d %v", code, out)
	}
	if code, _ := settings(`{"expire_days":0}`); code != 200 {
		t.Fatal("关掉过期")
	}
	ago := func(d time.Duration) string { return time.Now().Add(-d).UTC().Format(time.RFC3339) }
	if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", `{"messages":[
		{"external_id":"x:old","sender_id":"U9","text":"十天前","at":"`+ago(240*time.Hour)+`"},
		{"external_id":"x:snooze","sender_id":"U9","text":"十天前稍后","at":"`+ago(240*time.Hour)+`"},
		{"external_id":"x:done","sender_id":"U9","text":"十天前已处理","at":"`+ago(240*time.Hour)+`"},
		{"external_id":"x:new","sender_id":"U9","text":"一小时前","at":"`+ago(time.Hour)+`"}]}`); code != 200 {
		t.Fatalf("收消息：%d %v", code, out)
	}
	ids := map[string]string{}
	_, out := call(t, e.h, "GET", "/api/im/messages", "")
	for _, m := range out["data"].([]any) {
		mm := m.(map[string]any)
		ids[mm["text"].(string)] = mm["id"].(string)
	}
	call(t, e.h, "POST", "/api/im/messages/"+ids["十天前稍后"]+"/snooze", `{"until":"`+time.Now().Add(time.Hour).UTC().Format(time.RFC3339)+`"}`)
	call(t, e.h, "POST", "/api/im/messages/"+ids["十天前已处理"]+"/done", "")
	time.Sleep(60 * time.Millisecond)
	if _, out := call(t, e.h, "GET", "/api/im/messages?status=expired", ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("0 天不该过期：%v", out["data"])
	}

	if code, out := settings(`{"expire_days":7}`); code != 200 || data(out)["expire_days"] != float64(7) {
		t.Fatalf("设 7 天：%d %v", code, out)
	}
	status := func(text string) map[string]any {
		t.Helper()
		_, out := call(t, e.h, "GET", "/api/im/messages/"+ids[text], "")
		return data(out)
	}
	if m := status("十天前"); m["status"] != "expired" || m["expired_at"] == nil {
		t.Fatalf("超过 7 天没处理应已过期：%v %v", m["status"], m["expired_at"])
	}
	for _, text := range []string{"十天前稍后", "一小时前"} {
		if m := status(text); m["status"] != "pending" || m["expired_at"] != nil {
			t.Fatalf("%s 应仍待处理：%v", text, m["status"])
		}
	}
	if m := status("十天前已处理"); m["status"] != "done" {
		t.Fatalf("已处理的不动：%v", m["status"])
	}
	_, out = call(t, e.h, "GET", "/api/im/messages?status=pending", "")
	if n := len(out["data"].([]any)); n != 2 {
		t.Fatalf("待处理不含已过期，应 2 条：%d", n)
	}
	_, out = call(t, e.h, "GET", "/api/im/messages?status=expired", "")
	if n := len(out["data"].([]any)); n != 1 {
		t.Fatalf("已过期 1 条：%d", n)
	}

	// 改回待处理：从当时重新起算，几轮之后仍是待处理
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+ids["十天前"]+"/reopen", ""); code != 200 || data(out)["status"] != "pending" || data(out)["expired_at"] != nil {
		t.Fatalf("改回待处理：%d %v", code, out)
	}
	time.Sleep(80 * time.Millisecond)
	if m := status("十天前"); m["status"] != "pending" {
		t.Fatalf("改回待处理后不该马上又过期：%v", m["status"])
	}
	// 已过期的可以直接忽略
	settings(`{"expire_days":1}`)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+ids["十天前稍后"]+"/ignore", ""); code != 200 || data(out)["status"] != "ignored" {
		t.Fatalf("忽略：%d %v", code, out)
	}

	for _, bad := range []string{`{"expire_days":-1}`, `{"expire_days":366}`} {
		if code, _ := settings(bad); code != 400 {
			t.Fatalf("%s 应 400，得 %d", bad, code)
		}
	}
}
