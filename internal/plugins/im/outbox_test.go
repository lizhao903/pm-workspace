// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"strings"
	"testing"
)

// 主动发消息（0.17.0）：发到已有会话、私聊发给对方、记发件记录（含失败）、审计、会话统计带发出条数、各种拦截。

func TestSendToConversation(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C01:o1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"一"}`)
	e.push(t, `{"external_id":"D9:o2","connector_id":"cn_ok","conversation_id":"D9","conversation_kind":"direct","sender_id":"U3","sender_name":"阿青","text":"私聊"}`)
	e.push(t, `{"external_id":"C02:o3","connector_id":"cn_recv","conversation_id":"C02","conversation_name":"#readonly","sender_id":"U1","sender_name":"林原","text":"只收"}`)
	_, all := list(t, e.h, "")
	dm := all["D9:o2"]["conversation_id"].(string)

	// 群：发到会话，不串在哪条下面
	code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_prod","text":"  周五发版  "}`)
	d := data(out)
	if code != 200 || d["status"] != "sent" || d["text"] != "周五发版" || d["source"] != "manual" || d["conversation_id"] != "cv_prod" ||
		d["connector_id"] != "cn_ok" || d["external_id"] == "" || !strings.HasPrefix(d["id"].(string), "ob_") {
		t.Fatalf("发到群：%d %v", code, out)
	}
	sent := e.fake.Sent()
	if g := sent[len(sent)-1]; g.ConversationID != "C01" || g.ReplyTo != "" || g.RecipientID != "" || g.ConnectorID != "cn_ok" {
		t.Fatalf("群里直接发、不串：%+v", g)
	}
	// 私聊：发给对方
	if code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"`+dm+`","text":"收到"}`); code != 200 {
		t.Fatalf("私聊：%d %v", code, out)
	}
	sent = e.fake.Sent()
	if g := sent[len(sent)-1]; g.RecipientID != "U3" || g.ConversationKind != "direct" {
		t.Fatalf("私聊发给对方：%+v", g)
	}

	// 渠道发送失败：502，记录照样留着
	e.fake.FailReplies("channel_not_found")
	code, out = call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_prod","text":"第二条"}`)
	if code != 502 || errOf(out)["code"] != "send_failed" || errOf(out)["outbox_id"] == "" || !strings.Contains(errOf(out)["message"].(string), "channel_not_found") {
		t.Fatalf("发送失败：%d %v", code, out)
	}
	e.fake.FailReplies("")

	// 发件记录：新的在前，含失败的
	code, out = call(t, e.h, "GET", "/api/im/conversations/cv_prod/sent", "")
	rows := out["data"].([]any)
	if code != 200 || len(rows) != 2 || out["meta"].(map[string]any)["total"] != 2.0 {
		t.Fatalf("发件记录：%d %v", code, out)
	}
	if f := rows[0].(map[string]any); f["status"] != "failed" || f["text"] != "第二条" || !strings.Contains(f["error"].(string), "channel_not_found") || f["external_id"] != "" {
		t.Fatalf("失败的在前：%v", f)
	}
	if code, out := call(t, e.h, "GET", "/api/im/conversations/cv_prod/sent?limit=1", ""); code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("limit：%d %v", code, out)
	}

	// 审计：成功、失败各一条
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM audits WHERE action = 'send' AND target_type = 'conversation' AND target_id = 'cv_prod'
		AND json_extract(detail, '$.source') = 'manual'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("审计：%v %d", err, n)
	}

	// 会话统计带发成功的条数
	code, out = call(t, e.h, "GET", "/api/im/conversations/summary", "")
	for _, x := range out["data"].([]any) {
		s := x.(map[string]any)
		switch s["conversation_id"] {
		case "cv_prod":
			if s["sent"] != 1.0 || s["last_sent_at"] == nil {
				t.Fatalf("群发出 1 条（失败的不算）：%v", s)
			}
		case "cv_recv":
			if s["sent"] != 0.0 || s["last_sent_at"] != nil {
				t.Fatalf("没发过：%v", s)
			}
		}
	}

	// 拦截：只收的连接器、没收过消息、会话不存在、空、太长
	if code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_recv","text":"x"}`); code != 409 || errOf(out)["reason"] != "receive_only" {
		t.Fatalf("只收：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_empty","text":"x"}`); code != 409 || errOf(out)["reason"] != "no_messages" {
		t.Fatalf("没收过消息：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_none","text":"x"}`); code != 404 {
		t.Fatalf("会话不存在：%d", code)
	}
	if code, _ := call(t, e.h, "GET", "/api/im/conversations/cv_none/sent", ""); code != 404 {
		t.Fatalf("记录：会话不存在：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_prod","text":"   "}`); code != 400 {
		t.Fatalf("空：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_prod","text":"`+strings.Repeat("长", maxReply+1)+`"}`); code != 400 {
		t.Fatalf("太长：%d", code)
	}
	if code, out := call(t, e.h, "GET", "/api/im/conversations/cv_prod/sent?limit=x", ""); code != 400 {
		t.Fatalf("limit 不合法：%d %v", code, out)
	}
}

func TestSOPSendRecordsOutbox(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C01:s1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"一"}`)
	id := e.flow(t, `{"name":"发周报","steps":[{"key":"say","name":"发消息","kind":"im_send_message","config":{"conversation":"cv_prod","text":"周报发出来了"}}]}`)
	rid := e.start(t, id, `{"input":{}}`)
	e.until(t, rid, "发完", func(r map[string]any) bool { return sopStep(r, "say")["status"] == "done" })
	code, out := call(t, e.h, "GET", "/api/im/conversations/cv_prod/sent", "")
	rows := out["data"].([]any)
	if code != 200 || len(rows) != 1 {
		t.Fatalf("SOP 发的也有记录：%d %v", code, out)
	}
	if r := rows[0].(map[string]any); r["source"] != "sop" || r["run_id"] != rid || r["status"] != "sent" || r["text"] != "周报发出来了" {
		t.Fatalf("SOP 记录：%v", r)
	}
}

func TestSendWithConnectorAndNewChannel(t *testing.T) {
	e := setupSOP(t)
	exec(t, e.st.DB(), `INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES ('cn_tg', 'telegram', 'Bot', 'connected', 'both', 'x', 'x')`)
	// 还没收过消息的会话：给连接器就能发
	code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_empty","connector_id":"cn_ok","text":"大家好"}`)
	if code != 200 || data(out)["connector_id"] != "cn_ok" {
		t.Fatalf("没收过消息、给了连接器：%d %v", code, out)
	}
	if g := e.fake.Sent()[0]; g.ConversationID != "C03" || g.ConnectorID != "cn_ok" {
		t.Fatalf("发到 C03：%+v", g)
	}
	// 连接器和会话不是同一渠道
	if code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_empty","connector_id":"cn_tg","text":"x"}`); code != 400 {
		t.Fatalf("渠道不同：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_empty","connector_id":"cn_none","text":"x"}`); code != 404 {
		t.Fatalf("连接器不存在：%d", code)
	}
	// 还没登记的频道：先登记成群组会话，再发
	code, out = call(t, e.h, "POST", "/api/im/send", `{"connector_id":"cn_ok","conversation_external_id":"C77","conversation_name":"ops","text":"上线了"}`)
	cid, _ := data(out)["conversation_id"].(string)
	if code != 200 || cid == "" {
		t.Fatalf("新频道：%d %v", code, out)
	}
	var kind, name string
	if err := e.st.DB().R.QueryRow(`SELECT kind, name FROM conversations WHERE id = ?`, cid).Scan(&kind, &name); err != nil || kind != "group" || name != "#ops" {
		t.Fatalf("登记的会话：%v %s %s", err, kind, name)
	}
	// 同一个频道再发不重复登记
	if code, out := call(t, e.h, "POST", "/api/im/send", `{"connector_id":"cn_ok","conversation_external_id":"C77","text":"再一条"}`); code != 200 || data(out)["conversation_id"] != cid {
		t.Fatalf("已登记的频道：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/send", `{"connector_id":"cn_ok","text":"x"}`); code != 400 {
		t.Fatalf("缺频道编号：%d", code)
	}
}

func TestSentRepliesAndSelfDedupe(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C01:r0","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"早","at":"2026-01-01T00:00:00Z"}`)
	code, out := call(t, e.h, "POST", "/api/im/send", `{"conversation_id":"cv_prod","text":"方案看了吗"}`)
	ext, _ := data(out)["external_id"].(string)
	if code != 200 || ext == "" {
		t.Fatalf("发：%d %v", code, out)
	}
	// 以本人身份发出的，拉取时又看到：不再记成回复
	e.push(t, `{"external_id":"`+ext+`","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"UME","sender_name":"我","text":"方案看了吗","from_self":true}`)
	_, all := list(t, e.h, "")
	if rs := all["C01:r0"]["replies"].([]any); len(rs) != 0 {
		t.Fatalf("本人发出的不重复记成回复：%v", rs)
	}
	// 发件后同会话第一条来信算回复了我发出的；第二条不算；串里回复按父消息对
	e.push(t, `{"external_id":"C01:r1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"看了"}`)
	e.push(t, `{"external_id":"C01:r2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U2","sender_name":"周舟","text":"别的事"}`)
	e.push(t, `{"external_id":"C01:r3","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U2","sender_name":"周舟","text":"串里说","thread_parent_id":"`+ext+`"}`)
	_, all = list(t, e.h, "")
	if r := all["C01:r1"]["replied_sent"]; r == nil || r.(map[string]any)["via"] != "next" || r.(map[string]any)["text"] != "方案看了吗" {
		t.Fatalf("第一条来信：%v", all["C01:r1"]["replied_sent"])
	}
	if all["C01:r2"]["replied_sent"] != nil || all["C01:r0"]["replied_sent"] != nil {
		t.Fatalf("第二条、发件前的不算：%v %v", all["C01:r2"]["replied_sent"], all["C01:r0"]["replied_sent"])
	}
	if r := all["C01:r3"]["replied_sent"]; r == nil || r.(map[string]any)["via"] != "thread" {
		t.Fatalf("串里回复：%v", all["C01:r3"])
	}
}
