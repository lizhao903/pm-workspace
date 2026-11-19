// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 串相关（0.32.0）：串里回复的父消息 @我、私信、我发起的、转过任务时，im.message_received 带 thread_related 和原因、父消息 id；
// relevance 不变；不是串里回复、父消息和我不相关的不算；im_get_message 也带这三项。
func TestThreadRelatedEvent(t *testing.T) {
	e := setup(t)
	exec(t, e.d,
		`INSERT INTO objects (id, type_id, ref, title, props, created_at, updated_at) VALUES ('obj_t1', 'task', 'T-0001', '跟进', '{}', 'x', 'x')`)
	at := time.Now().UTC().Format(time.RFC3339Nano)
	push := func(body string) {
		t.Helper()
		if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", `{"messages":[`+body+`]}`); code != 200 {
			t.Fatalf("回调：%d %v", code, out)
		}
	}
	msg := func(ext, extra string) string {
		return fmt.Sprintf(`{"external_id":%q,"conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"看下"%s,"at":%q}`, ext, extra, at)
	}
	push(msg("C01:p_me", `,"mention":"me"`))
	push(msg("C01:p_none", ``))
	push(msg("C01:p_task", ``))
	exec(t, e.d, `UPDATE im_messages SET task_id = 'obj_t1' WHERE external_id = 'C01:p_task'`)
	push(msg("C01:r_me", `,"thread_parent_id":"C01:p_me"`))
	push(msg("C01:r_none", `,"thread_parent_id":"C01:p_none"`))
	push(msg("C01:r_task", `,"thread_parent_id":"C01:p_task"`))
	push(msg("C01:r_mine", `,"thread_parent_id":"C01:p_gone","thread_parent_mine":true`))
	push(msg("C01:r_lost", `,"thread_parent_id":"C01:p_gone2"`))

	byExt := map[string]Received{}
	deadline := time.Now().Add(3 * time.Second)
	for len(byExt) < 8 && time.Now().Before(deadline) {
		for _, ev := range e.watch.events() {
			var ext string
			if err := e.d.R.QueryRow(`SELECT external_id FROM im_messages WHERE id = ?`, ev.MessageID).Scan(&ext); err == nil {
				byExt[ext] = ev
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	idOf := func(ext string) string {
		var id string
		if err := e.d.R.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
			t.Fatalf("%s: %v", ext, err)
		}
		return id
	}
	for _, c := range []struct {
		ext, reason, parent, relevance string
	}{
		{"C01:p_me", "", "", "me"},
		{"C01:r_me", ThreadRelMention, "C01:p_me", ""},
		{"C01:r_none", "", "C01:p_none", ""},
		{"C01:r_task", ThreadRelTask, "C01:p_task", ""},
		{"C01:r_mine", ThreadRelMine, "", "me"}, // 我发起的串本来就记 me（0010），这里另外带上原因
		{"C01:r_lost", "", "", ""},
	} {
		ev, ok := byExt[c.ext]
		if !ok {
			t.Fatalf("%s 没发 im.message_received", c.ext)
		}
		if ev.ThreadRelated != (c.reason != "") || ev.ThreadReason != c.reason || ev.Relevance != c.relevance {
			t.Fatalf("%s：thread_related=%v reason=%q relevance=%q，要 reason=%q relevance=%q", c.ext, ev.ThreadRelated, ev.ThreadReason, ev.Relevance, c.reason, c.relevance)
		}
		want := ""
		if c.parent != "" {
			want = idOf(c.parent)
		}
		if got := deref(ev.ThreadParentMessageID); got != want {
			t.Fatalf("%s：thread_parent_message_id=%q，要 %q", c.ext, got, want)
		}
	}

	// 关联任务带现在的状态（0.32.0）：转成的 task_status、拆出来的 split_tasks[].status，前端据此只显示没到终态的
	exec(t, e.d, `UPDATE objects SET status = 'done' WHERE id = 'obj_t1'`,
		`INSERT INTO objects (id, type_id, ref, title, status, props, created_at, updated_at) VALUES ('obj_t2', 'task', 'T-0002', '拆出', 'todo', '{}', 'x', 'x')`,
		`INSERT INTO im_message_tasks (message_id, task_id, created_at) VALUES ('`+idOf("C01:p_task")+`', 'obj_t2', 'x')`)
	_, rows := list(t, e.h, "")
	pt := rows["C01:p_task"]
	split := pt["split_tasks"].([]any)
	if pt["task_status"] != "done" || len(split) != 1 || split[0].(map[string]any)["status"] != "todo" {
		t.Fatalf("关联任务的状态：task_status=%v split=%v", pt["task_status"], split)
	}
	if rows["C01:p_none"]["task_status"] != "" {
		t.Fatalf("没转任务的 task_status 为空串：%v", rows["C01:p_none"]["task_status"])
	}
}

// SOP 的 IM 过滤「相关串里的回复按 @我 算」（sop 0.23.0）：只要 @我和私信、勾了 thread_related 的流程接相关串里别人的回复，
// 父消息被这条流程跑过的也算；没勾的流程照旧不接；读取消息（模拟 IM 触发）带串相关并按它判。
func TestThreadRelatedSOPFilter(t *testing.T) {
	e := setup0490(t)
	ctx := context.Background()
	steps := `"fields":[],"steps":[{"key":"g","name":"读","kind":"review","after":[]}]`
	with := e.flow(t, `{"name":"分诊（含相关串）","trigger":"im",`+steps+`,"im":{"relevance":["me","dm"],"thread_related":true}}`)
	plain := e.flow(t, `{"name":"分诊（旧）","trigger":"im",`+steps+`,"im":{"relevance":["me","dm"]}}`)
	if code, out := call(t, e.h, "GET", "/api/sop/flows/"+with, ""); code != 200 || data(out)["im"].(map[string]any)["thread_related"] != true {
		t.Fatalf("存上 thread_related：%d %v", code, out)
	}
	now := time.Now()
	parentMe := pushed(t, e, "C0BNCBRL5C0:p1", "C0BNCBRL5C0", "Lin", "@Broleez 看下", now)
	parentNone := pushed(t, e, "C0BNCBRL5C0:p2", "C0BNCBRL5C0", "Lin", "大家看下", now)
	reply := func(ext, parent string) string {
		t.Helper()
		e.push(t, fmt.Sprintf(`{"external_id":%q,"conversation_id":"C0BNCBRL5C0","conversation_name":"#ai-octok-platform","sender_id":"Zhou","sender_name":"Zhou","text":"好的","thread_parent_id":%q,"at":%q}`,
			ext, parent, now.UTC().Format(time.RFC3339)))
		var id string
		if err := e.st.DB().W.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	r1 := reply("C0BNCBRL5C0:r1", "C0BNCBRL5C0:p1")
	r2 := reply("C0BNCBRL5C0:r2", "C0BNCBRL5C0:p2")
	settled(t, e)

	deliver := func(id string, extra map[string]any) {
		t.Helper()
		p := map[string]any{"message_id": id, "channel": "slack", "connector_id": "", "conversation_id": "cv_octok", "relevance": "",
			"at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
		for k, v := range extra {
			p[k] = v
		}
		b, _ := json.Marshal(p)
		for _, s := range e.r.Subscribers("im.message_received") {
			if err := s.Handle(ctx, plugin.Event{Type: "im.message_received", At: time.Now(), Payload: b}); err != nil {
				t.Fatal(err)
			}
		}
	}
	runs := func(flow, msg string) int {
		t.Helper()
		var n int
		if err := e.st.DB().W.QueryRow(`SELECT COUNT(*) FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?`, flow, msg).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// 父消息 @我 的串里别人的回复：勾了的接，没勾的不接
	deliver(r1, map[string]any{"thread_related": true, "thread_reason": "mention", "thread_parent_message_id": parentMe})
	if runs(with, r1) != 1 || runs(plain, r1) != 0 {
		t.Fatalf("相关串里的回复：含相关串 %d、旧 %d", runs(with, r1), runs(plain, r1))
	}
	// 父消息和我无关、这条流程也没跑过：不接
	deliver(r2, map[string]any{"thread_parent_message_id": parentNone})
	if runs(with, r2) != 0 {
		t.Fatal("不相关的串里的回复不接")
	}
	// 父消息被这条流程跑过（批量分诊过）：再来的回复接
	if code, out := call(t, e.h, "POST", "/api/sop/flows/"+with+"/runs/batch", fmt.Sprintf(`{"inputs":[{"message_id":%q}],"skip_existing_key":"message_id"}`, parentNone)); code != 200 {
		t.Fatalf("批量发起：%d %v", code, out)
	}
	r3 := reply("C0BNCBRL5C0:r3", "C0BNCBRL5C0:p2")
	deliver(r3, map[string]any{"thread_parent_message_id": parentNone})
	if runs(with, r3) != 1 || runs(plain, r3) != 0 {
		t.Fatalf("父消息被这条流程跑过：含相关串 %d、旧 %d", runs(with, r3), runs(plain, r3))
	}
	// 没发起的记录写清楚原因
	code, out := call(t, e.h, "GET", "/api/sop/flows/"+with+"/skips", "")
	if code != 200 || !strings.Contains(fmt.Sprint(out["data"]), "所在消息列和我不相关") {
		t.Fatalf("没发起的记录：%d %v", code, out)
	}

	// 模拟 IM 触发：读取消息带串相关，按它判
	code, out = call(t, e.h, "POST", "/api/sop/im-explain", fmt.Sprintf(`{"message_id":%q}`, r1))
	if code != 200 {
		t.Fatalf("模拟：%d %v", code, out)
	}
	res := data(out)
	msg := res["message"].(map[string]any)
	if msg["thread_related"] != true || msg["thread_reason"] != ThreadRelMention || msg["thread_parent_message_id"] != parentMe {
		t.Fatalf("读取消息的串相关：%v", msg)
	}
	// 读取消息带串的父消息全文（0.32.0）：正文模板能写 {{message.thread_parent.text}}
	if tp, _ := msg["thread_parent"].(map[string]any); tp["text"] != "@Broleez 看下" || tp["source"] != ParentFromMessage || tp["message_id"] != parentMe {
		t.Fatalf("读取消息的父消息：%v", msg["thread_parent"])
	}
	verdict := map[string]string{}
	for _, f := range res["flows"].([]any) {
		fm := f.(map[string]any)
		verdict[fm["flow_id"].(string)] = fm["verdict"].(string)
	}
	if verdict[plain] != "filtered" || verdict[with] != "already" {
		t.Fatalf("模拟判定：%v", verdict)
	}
	if !strings.Contains(fmt.Sprint(res["flows"]), "相关消息列里的回复按 @我 算：原消息 @我") {
		t.Fatalf("判定要写出串相关的原因：%v", res["flows"])
	}
}
