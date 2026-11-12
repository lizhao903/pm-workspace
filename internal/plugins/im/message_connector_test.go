// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import "testing"

func TestLatestMessageByConnector(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"old","connector_id":"cn_ok","conversation_id":"C01","sender_id":"U1","text":"old","at":"2026-11-10T10:00:00Z"}`)
	e.push(t, `{"external_id":"latest","connector_id":"cn_ok","conversation_id":"C01","sender_id":"U1","text":"latest","at":"2026-11-11T10:00:00Z"}`)
	e.push(t, `{"external_id":"other","connector_id":"cn_other","conversation_id":"C02","sender_id":"U2","text":"other","at":"2026-11-11T11:00:00Z"}`)
	code, out := call(t, e.h, "GET", "/api/im/messages?connector_id=cn_ok&limit=1", "")
	if code != 200 {
		t.Fatalf("list: %d %v", code, out)
	}
	rows := out["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["text"] != "latest" || out["meta"].(map[string]any)["total"].(float64) != 2 {
		t.Fatalf("wrong latest message or count: %v", out)
	}
}
