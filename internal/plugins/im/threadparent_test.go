// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// 串的父消息（0.32.0）：父消息在库里取全文；父消息是我发的（拉回来记成了我的回复）取我那条的全文；都取不到用 80 字快照、标 partial。
// 转任务写进来源的 source_ref.thread_parent 同口径，提示词据此写原消息。
func TestThreadParentFullText(t *testing.T) {
	e := setupActions(t)
	base := time.Now().UTC().Add(-time.Hour)
	at := func(sec int) string { return base.Add(time.Duration(sec) * time.Second).Format(time.RFC3339Nano) }
	push := func(body string) {
		t.Helper()
		if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", `{"messages":[`+body+`]}`); code != 200 {
			t.Fatalf("回调：%d %v", code, out)
		}
	}
	idOf := func(ext string) string {
		t.Helper()
		var id string
		if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
			t.Fatalf("%s: %v", ext, err)
		}
		return id
	}
	parentOf := func(ext string) map[string]any {
		t.Helper()
		code, out := call(t, e.h, "GET", "/api/im/messages/"+idOf(ext)+"/thread-parent", "")
		if code != 200 {
			t.Fatalf("父消息：%d %v", code, out)
		}
		d, _ := out["data"].(map[string]any)
		return d
	}
	long := "Grant Agent 外发文件有个问题，会把私桶的链接发出去，外部用户是无法访问的，需要能直接外发文件。" +
		"这是第二句，超过八十个字的部分快照里没有，全文里才有：链接打开不了，需要一个文件投递的机制。"
	// 1. 父消息在库里（别人发的）
	push(fmt.Sprintf(`{"external_id":"C01:p1","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"Lin Yuan","text":%q,"at":%q}`, long, at(1)))
	push(fmt.Sprintf(`{"external_id":"C01:r1","conversation_id":"C01","conversation_name":"#product","sender_id":"U09","sender_name":"赵振华","text":"这个华哥看一下吧","thread_parent_id":"C01:p1","at":%q}`, at(2)))
	p := parentOf("C01:r1")
	if p["source"] != ParentFromMessage || p["text"] != long || p["sender"] != "林原" || p["partial"] != false || p["message_id"] != idOf("C01:p1") || p["link"] == "" {
		t.Fatalf("父消息在库里：%v", p)
	}
	// 2. 父消息是我发的：我的消息不落成消息，拉回来记成会话里最近一条的回复
	push(fmt.Sprintf(`{"external_id":"C01:q0","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"先说一句","at":%q}`, at(3)))
	push(fmt.Sprintf(`{"external_id":"C01:mine","conversation_id":"C01","conversation_name":"#product","sender_id":"UME","sender_name":"Broleez","text":%q,"from_self":true,"at":%q}`, long, at(4)))
	push(fmt.Sprintf(`{"external_id":"C01:r2","conversation_id":"C01","conversation_name":"#product","sender_id":"U09","sender_name":"赵振华","text":"我先记到表上吧","thread_parent_id":"C01:mine","thread_parent_sender":"Broleez Li 李钊","thread_parent_text":"Grant Agent 外发文件有个问题","thread_parent_mine":true,"at":%q}`, at(5)))
	p = parentOf("C01:r2")
	if p["source"] != ParentFromSelf || p["text"] != long || p["sender"] != "Broleez Li 李钊" || p["partial"] != false || p["message_id"] != nil {
		t.Fatalf("父消息是我发的：%v", p)
	}
	// 3. 都取不到：用快照，标 partial
	push(fmt.Sprintf(`{"external_id":"C01:r3","conversation_id":"C01","conversation_name":"#product","sender_id":"U09","sender_name":"赵振华","text":"跟进一下","thread_parent_id":"C01:gone","thread_parent_sender":"Zhou","thread_parent_text":"很早以前的一条","at":%q}`, at(6)))
	p = parentOf("C01:r3")
	if p["source"] != ParentFromSnapshot || p["text"] != "很早以前的一条" || p["sender"] != "Zhou" || p["partial"] != true {
		t.Fatalf("取不到用快照：%v", p)
	}
	// 不是串里回复：null
	if p := parentOf("C01:p1"); p != nil {
		t.Fatalf("不是串里回复为 null：%v", p)
	}

	// 转任务：来源里带上父消息全文
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+idOf("C01:r2")+"/task", `{"title":"文件投递","reply_on_done":false}`); code != 201 {
		t.Fatalf("转任务：%d %v", code, out)
	}
	var raw string
	if err := e.st.DB().R.QueryRow(`SELECT o.props FROM objects o JOIN im_messages m ON m.task_id = o.id WHERE m.external_id = 'C01:r2'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var props struct {
		Ref struct {
			Text   string         `json:"text"`
			Parent map[string]any `json:"thread_parent"`
		} `json:"source_ref"`
	}
	if err := json.Unmarshal([]byte(raw), &props); err != nil {
		t.Fatal(err)
	}
	if props.Ref.Text != "我先记到表上吧" || props.Ref.Parent["text"] != long || props.Ref.Parent["sender"] != "Broleez Li 李钊" || props.Ref.Parent["partial"] != false {
		t.Fatalf("来源里的父消息：%+v", props.Ref)
	}
}
