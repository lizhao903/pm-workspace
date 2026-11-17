// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"fmt"
	"testing"
	"time"
)

// 我回复了消息（0.31.0）：串里、私聊里本人回的、消息页回复的发 im.message_replied，内置流程「我回复后标为已处理」把被回复的标为已处理；
// 群聊里不在串里发的不算；同一条回复只发起一次。
func TestRepliedDoneFlow(t *testing.T) {
	e := setupIntake(t)
	// 内置流程由 IM 插件的后台任务写进 SOP，触发方式就是「我回复了消息」
	fid := RepliedDoneFlowID
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, out := call(t, e.h, "GET", "/api/sop/flows/"+fid, "")
		if code == 200 {
			if tr := data(out)["trigger"]; tr != "im_reply" {
				t.Fatalf("内置流程的触发方式：%v", tr)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("等了 5 秒「我回复后标为已处理」还没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}

	base := time.Now().UTC().Add(-time.Minute)
	at := func(sec int) string { return base.Add(time.Duration(sec) * time.Second).Format(time.RFC3339Nano) }
	idOf := func(ext string) string {
		t.Helper()
		var id string
		if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
			t.Fatalf("%s: %v", ext, err)
		}
		return id
	}
	status := func(ext string) string {
		t.Helper()
		var s string
		if err := e.st.DB().R.QueryRow(`SELECT status FROM im_messages WHERE external_id = ?`, ext).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	waitDone := func(ext string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for status(ext) != "done" {
			if time.Now().After(deadline) {
				var rr, sk, rp string
				_ = e.st.DB().R.QueryRow(`SELECT coalesce(group_concat(status||':'||input),'') FROM sop_runs`).Scan(&rr)
				_ = e.st.DB().R.QueryRow(`SELECT coalesce(group_concat(reason||':'||detail),'') FROM sop_skips`).Scan(&sk)
				_ = e.st.DB().R.QueryRow(`SELECT coalesce(group_concat(message_id||':'||text),'') FROM im_replies`).Scan(&rp)
				t.Fatalf("%s 没被标为已处理：%s\nruns=%s\nskips=%s\nreplies=%s", ext, status(ext), rr, sk, rp)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	runs := func() int {
		t.Helper()
		var n int
		if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM sop_runs WHERE flow_id = ?`, fid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	msg := func(ext, conv, kind, extra string, sec int) string {
		return fmt.Sprintf(`{"external_id":%q,"conversation_id":%q,"conversation_kind":%q,"sender_id":"U1","sender_name":"林原","text":"在吗"%s,"at":%q}`,
			ext, conv, kind, extra, at(sec))
	}
	mine := func(ext, conv, kind, extra string, sec int) string {
		return fmt.Sprintf(`{"external_id":%q,"conversation_id":%q,"conversation_kind":%q,"sender_id":"UME","sender_name":"我","text":"好的"%s,"from_self":true,"at":%q}`,
			ext, conv, kind, extra, at(sec))
	}

	// 串里：被回复的是串里在我之前最近一条
	e.push(t, msg("C01:p", "C01", "group", "", 1))
	e.push(t, msg("C01:p1", "C01", "group", `,"thread_parent_id":"C01:p"`, 2))
	e.push(t, mine("C01:p2", "C01", "group", `,"thread_parent_id":"C01:p"`, 3))
	waitDone("C01:p1")
	if status("C01:p") != "pending" {
		t.Fatalf("串里更早的那条不动：%s", status("C01:p"))
	}
	// 私聊里直接回
	e.push(t, msg("D01:a", "D01", "direct", "", 4))
	e.push(t, mine("D01:b", "D01", "direct", "", 5))
	waitDone("D01:a")
	// 群聊里不在串里发的：只记成回复，不发起
	e.push(t, msg("C01:q", "C01", "group", "", 6))
	before := runs()
	e.push(t, mine("C01:q2", "C01", "group", "", 7))
	time.Sleep(100 * time.Millisecond)
	if status("C01:q") != "pending" || runs() != before {
		t.Fatalf("群聊里不在串里的不算：%s，执行 %d→%d", status("C01:q"), before, runs())
	}
	// 消息页回复（不带 done）也算
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+idOf("C01:q")+"/reply", `{"text":"收到"}`); code != 200 {
		t.Fatalf("回复：%d %v", code, out)
	}
	waitDone("C01:q")
	// 同一条回复再拉到一次：不重复发起
	n := runs()
	e.push(t, mine("D01:b", "D01", "direct", "", 5))
	time.Sleep(100 * time.Millisecond)
	if runs() != n || n != 3 {
		t.Fatalf("同一条回复只发起一次：%d→%d", n, runs())
	}
	var via string
	if err := e.st.DB().R.QueryRow(`SELECT json_extract(input, '$.via') FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?`,
		fid, idOf("C01:q")).Scan(&via); err != nil || via != ReplyViaWorkbench {
		t.Fatalf("via = %q %v", via, err)
	}
}
