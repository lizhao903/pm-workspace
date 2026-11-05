package im

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

// 回执需求方（TSK-0467）：建任务后在原会话回复需求方一次；重跑、几条流程都建任务不重复回；任务是取回的、消息回过就不回；
// 我自己发的、只收不发的不回；回复失败这一步照常完成、记运行异常，之后再跑能补发；内置流程升级：没改过的换新版，改过的不动。

const ackFlowBody = `{"name":"转任务并回执","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
	{"key":"t","name":"转成任务","kind":"im_to_task","after":[]},
	{"key":"ack","name":"回执需求方","kind":"im_ack_task","after":["t"],"config":{"text":"%s"}}]}`

func (e confirmEnv) ackFlow(t *testing.T, text string) string {
	t.Helper()
	return e.flow(t, fmt.Sprintf(ackFlowBody, text))
}

func (e confirmEnv) acked(t *testing.T, flowID, msgID string) map[string]any {
	t.Helper()
	run := e.ended(t, e.start(t, flowID, fmt.Sprintf(`{"input":{"message_id":%q}}`, msgID)), "done")
	return sopStep(run, "ack")["output"].(map[string]any)["acked"].(map[string]any)
}

// acksTo 是发到这个会话里、不是私信我的回复。
func (e confirmEnv) acksTo(conv string) []string {
	var out []string
	for _, o := range e.fake.Sent() {
		if o.ConversationID == conv && o.ConversationKind != "direct" {
			out = append(out, o.Text)
		}
	}
	return out
}

func TestAckTaskRepliesOnceInThread(t *testing.T) {
	e := setupConfirm(t)
	// 消息列里的一条：回在消息列里
	e.push(t, fmt.Sprintf(`{"external_id":"C01:900","conversation_id":"C01","conversation_kind":"group","conversation_name":"#product",
		"sender_id":"U04LIN","sender_name":"Lin Yuan","text":"导出要支持 CSV","thread_parent_id":"C01:800","thread_parent_sender":"Lin Yuan",
		"thread_parent_text":"导出的问题","at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)))
	var mid string
	if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = 'C01:900'`).Scan(&mid); err != nil {
		t.Fatal(err)
	}
	fid := e.ackFlow(t, "")
	a := e.acked(t, fid, mid)
	task := e.task(t, mid)
	if a["status"] != ackSent || a["task_ref"] != task.Ref {
		t.Fatalf("acked = %v", a)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || sent[0].Text != "已创建任务 "+task.Ref+"，开始进行需求规划" || sent[0].ThreadOf != "C01:800" || sent[0].ConversationID != "C01" {
		t.Fatalf("发出 = %+v", sent)
	}
	// 重跑同一条消息：任务取回、不再回
	a = e.acked(t, fid, mid)
	if a["status"] != ackSkipped || a["reason"] != "already" || a["task_reused"] != true {
		t.Fatalf("重跑 acked = %v", a)
	}
	// 另一条流程（文案不同）对同一条消息：也不回
	a = e.acked(t, e.ackFlow(t, "收到 {{task_ref}}"), mid)
	if a["status"] != ackSkipped || a["reason"] != "already" {
		t.Fatalf("别的流程 acked = %v", a)
	}
	if n := len(e.fake.Sent()); n != 1 {
		t.Fatalf("应当只回一次，发了 %d 条", n)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_replies WHERE message_id = ? AND status = 'sent'`, mid).Scan(&n); err != nil || n != 1 {
		t.Fatalf("im_replies = %d %v", n, err)
	}
}

// 变量：任务编号、标题、项目、链接。
func TestAckTaskVariables(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "客户端导出要支持 CSV")
	other := e.flow(t, `{"name":"分流","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"分流建的","project":"Acme"}},
		{"key":"ack","name":"回执需求方","kind":"im_ack_task","after":["t"],"config":{"text":"{{task_ref}}|{{task_title}}|{{task_project}}|{{task_url}}"}}]}`)
	a := e.acked(t, other, mid)
	if a["status"] != ackSent {
		t.Fatalf("acked = %v", a)
	}
	var tid, ref string
	if err := e.st.DB().R.QueryRow(`SELECT id, ref FROM objects WHERE title = '分流建的'`).Scan(&tid, &ref); err != nil {
		t.Fatal(err)
	}
	want := ref + "|分流建的|Acme|http://pmw.test/tasks/board?t=" + tid
	if got := e.acksTo("C01"); len(got) != 1 || got[0] != want {
		t.Fatalf("回执 = %v，应当 %q", got, want)
	}
	// 再用转成任务（取回分流建的那条）回执：消息回过了，不回
	a = e.acked(t, e.ackFlow(t, ""), mid)
	if a["status"] != ackSkipped || a["reason"] != "already" || a["task_reused"] != true {
		t.Fatalf("取回已有任务 acked = %v", a)
	}
}

// 取回的已有任务、但这条消息还没回过（先建任务的流程没有回执）：回一次。
func TestAckTaskReusedButNotAckedYet(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "别的流程建过")
	other := e.flow(t, `{"name":"分流","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"分流建的"}}]}`)
	e.ended(t, e.start(t, other, fmt.Sprintf(`{"input":{"message_id":%q}}`, mid)), "done")
	a := e.acked(t, e.ackFlow(t, ""), mid)
	if a["status"] != ackSent || a["task_reused"] != true {
		t.Fatalf("acked = %v", a)
	}
	if got := e.acksTo("C01"); len(got) != 1 {
		t.Fatalf("回执 = %v", got)
	}
}

func TestAckTaskSkipsSelfAndReceiveOnly(t *testing.T) {
	e := setupConfirm(t)
	fid := e.ackFlow(t, "")
	// 我自己发的
	e.push(t, fmt.Sprintf(`{"external_id":"C01:me","conversation_id":"C01","conversation_kind":"group","conversation_name":"#product",
		"sender_id":"Broleez","sender_name":"Broleez","text":"记一下：导出要支持 CSV","at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)))
	var mine string
	if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = 'C01:me'`).Scan(&mine); err != nil {
		t.Fatal(err)
	}
	a := e.acked(t, fid, mine)
	if a["status"] != ackSkipped || a["reason"] != "self" || !strings.Contains(a["reason_text"].(string), "我自己发的") {
		t.Fatalf("我自己的 acked = %v", a)
	}
	// 只收不发的连接器
	mid := e.msg(t, "只收的群里的需求")
	exec(t, e.st.DB(), `INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
		('cn_recv', 'slack', 'Slack 只收', 'connected', 'receive', 'x', 'x')`,
		`UPDATE im_messages SET connector_id = 'cn_recv' WHERE id = '`+mid+`'`)
	a = e.acked(t, fid, mid)
	if a["status"] != ackSkipped || a["reason"] != "receive_only" || a["connector"] != "Slack 只收" {
		t.Fatalf("只收 acked = %v", a)
	}
	if n := len(e.fake.Sent()); n != 0 {
		t.Fatalf("不该发：%v", e.fake.Sent())
	}
	// 不回的不占位：之后能回
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_task_acks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("im_task_acks = %d %v", n, err)
	}
}

func TestAckTaskSendFailsDoesNotFail(t *testing.T) {
	e := setupConfirm(t)
	e.r.SetIncidents(incident.New(e.st.DB(), nil))
	mid := e.msg(t, "客户端导出要支持 CSV")
	fid := e.ackFlow(t, "")
	e.fake.FailReplies("channel_not_found")
	a := e.acked(t, fid, mid)
	if a["status"] != ackFailed || a["reason"] != "send_failed" || !strings.Contains(a["reason_text"].(string), "channel_not_found") ||
		!strings.Contains(a["reason_text"].(string), "已建好") {
		t.Fatalf("acked = %v", a)
	}
	if e.task(t, mid) == nil {
		t.Fatal("任务应当建好")
	}
	var level, ctxJSON string
	if err := e.st.DB().R.QueryRow(`SELECT level, context FROM incidents WHERE fingerprint = ?`, "im:ack:"+fid+":ack").Scan(&level, &ctxJSON); err != nil || level != "warn" {
		t.Fatalf("运行异常 %q %v", level, err)
	}
	var c map[string]any
	_ = json.Unmarshal([]byte(ctxJSON), &c)
	if c["消息"] != mid {
		t.Fatalf("运行异常上下文 = %v", c)
	}
	// 恢复后再跑：补发一次
	e.fake.FailReplies("")
	a = e.acked(t, fid, mid)
	if a["status"] != ackSent {
		t.Fatalf("补发 acked = %v", a)
	}
	if got := e.acksTo("C01"); len(got) != 1 {
		t.Fatalf("回执 = %v", got)
	}
}

// 来消息确认派发：建任务后先回执需求方，再私信我。
func TestTaskConfirmAcksBeforeAskingMe(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "客户端导出要支持 CSV")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q}`, mid))
	e.asking(t, rid)
	task := e.task(t, mid)
	sent := e.fake.Sent()
	if len(sent) < 2 || sent[0].ConversationID != "C01" || sent[0].Text != "已创建任务 "+task.Ref+"，开始进行需求规划" || sent[1].RecipientID != "Broleez" {
		t.Fatalf("发出顺序 = %+v", sent)
	}
}

// 内置流程升级：还是第 1 版的换成带回执的新版；改过的不动，记标记不再试。
func TestAckUpgradeBuiltinFlows(t *testing.T) {
	e := setupConfirm(t)
	stepsOf := func(id string) string {
		var s string
		if err := e.st.DB().R.QueryRow(`SELECT steps FROM sop_flows WHERE id = ?`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	waitMark := func(mark string) {
		deadline := time.Now().Add(5 * time.Second)
		for {
			var n int
			_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, mark).Scan(&n)
			if n > 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("等了 5 秒没有标记 %s", mark)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	for _, id := range []string{TaskConfirmFlowID, AutoIntakeFlowID} {
		if !strings.Contains(stepsOf(id), `"im_ack_task"`) {
			t.Fatalf("%s 新写的应当带回执", id)
		}
	}
	// 旧版（没有回执）、第 1 版：换成新版
	old := strings.Replace(stepsOf(TaskConfirmFlowID), `"kind":"im_ack_task"`, `"kind":"auto"`, 1)
	exec(t, e.st.DB(), `UPDATE sop_flows SET steps = '`+strings.ReplaceAll(old, "'", "''")+`' WHERE id = '`+TaskConfirmFlowID+`'`,
		`DELETE FROM im_sop_templates WHERE flow_id = '`+confirmAckMark+`'`)
	waitMark(confirmAckMark)
	if !strings.Contains(stepsOf(TaskConfirmFlowID), `"im_ack_task"`) {
		t.Fatal("第 1 版应当换成新版")
	}
	// 用户改过（第 2 版）：不动
	old = strings.Replace(stepsOf(AutoIntakeFlowID), `"kind":"im_ack_task"`, `"kind":"auto"`, 1)
	exec(t, e.st.DB(), `UPDATE sop_flows SET steps = '`+strings.ReplaceAll(old, "'", "''")+`', version = 2 WHERE id = '`+AutoIntakeFlowID+`'`,
		`DELETE FROM im_sop_templates WHERE flow_id = '`+intakeAckMark+`'`)
	waitMark(intakeAckMark)
	if strings.Contains(stepsOf(AutoIntakeFlowID), `"im_ack_task"`) {
		t.Fatal("改过的不该被覆盖")
	}
}
