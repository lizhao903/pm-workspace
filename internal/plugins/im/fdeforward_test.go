// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// FDE 反馈转发（TSK-0468）：手动转任务后私信联系人「FDE 反馈」+ 原始消息 + 任务；SOP 自动建的不发；同一条消息只发一次；
// 拆分出几条任务汇成一条；联系人没有 Slack 身份时失败写明；发送失败记运行异常、不影响任务；设置没开不发。

func setupFDE(t *testing.T) confirmEnv {
	t.Helper()
	oldEvery, oldQuiet := fdeEvery, fdeSplitQuiet
	fdeEvery, fdeSplitQuiet = 10*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() { fdeEvery, fdeSplitQuiet = oldEvery, oldQuiet })
	e := setupConfirm(t)
	exec(t, e.st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_robot', 'Robot.CyberBroleez', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES
		  ('idn_me', 'stk_robot', 'slack', 'U08MYH0MVL6', 'x', 'x'), ('idn_robot', 'stk_robot', 'slack', 'U0BQZG8LSTB', 'x', 'x')`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+FDEForwardFlowID, ""); code == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("等了 5 秒「FDE 反馈转发」还没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code, out := call(t, e.h, "PATCH", "/api/im/settings", `{"fde_forward":true}`); code != 200 || data(out)["fde_forward"] != true {
		t.Fatalf("打开设置 %d %v", code, out)
	}
	return e
}

// fdes 是私信给 to 的。
func (e confirmEnv) fdes(to string) []Outgoing {
	var out []Outgoing
	for _, o := range e.fake.Sent() {
		if o.RecipientID == to && o.ConversationKind == "direct" {
			out = append(out, o)
		}
	}
	return out
}

func (e confirmEnv) waitFDE(t *testing.T, n int) []Outgoing {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if xs := e.fdes("U0BQZG8LSTB"); len(xs) >= n {
			return xs
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒没有第 %d 条 FDE 反馈，已发 %+v", n, e.fake.Sent())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e confirmEnv) convert(t *testing.T, msgID string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/im/messages/"+msgID+"/task", `{"title":"导出支持 CSV","reply_on_done":false}`)
	if code != 201 {
		t.Fatalf("转任务 %d %v", code, out)
	}
	return data(out)["task"].(map[string]any)
}

// fdeRun 是这条消息的转发发起的执行。
func (e confirmEnv) fdeRun(t *testing.T, msgID string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var run string
		_ = e.st.DB().R.QueryRow(`SELECT r.id FROM sop_runs r JOIN im_fde_forwards f ON r.object_id = json_extract(f.task_ids, '$[0]')
			WHERE f.id = ? AND f.status = 'started' AND r.flow_id = ?`, msgID, FDEForwardFlowID).Scan(&run)
		if run != "" {
			return run
		}
		if time.Now().After(deadline) {
			t.Fatal("等了 5 秒转发还没发起")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestFDEForwardOnManualConvert(t *testing.T) {
	e := setupFDE(t)
	e.push(t, fmt.Sprintf(`{"external_id":"C01:fde1","conversation_id":"C01","conversation_kind":"group","conversation_name":"#product",
		"sender_id":"U04LIN","sender_name":"Lin Yuan","text":"客户现场：导出要支持 CSV","at":"2026-11-05T02:30:00Z",
		"attachments":[{"id":"F1","name":"现场截图.png","kind":"image"}]}`))
	var mid string
	if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = 'C01:fde1'`).Scan(&mid); err != nil {
		t.Fatal(err)
	}
	task := e.convert(t, mid)
	xs := e.waitFDE(t, 1)
	txt := xs[0].Text
	at := time.Date(2026, 11, 5, 2, 30, 0, 0, time.UTC).Local().Format("2006-01-02 15:04")
	for _, want := range []string{"发信人：Lin Yuan", "会话：#product（slack）", "时间：" + at, "原文：客户现场：导出要支持 CSV", "附件：现场截图.png",
		"任务：" + task["ref"].(string) + "「导出支持 CSV」http://pmw.test/tasks/board?t=" + task["id"].(string)} {
		if !strings.Contains(txt, want) {
			t.Fatalf("FDE 反馈里应当有 %q：\n%s", want, txt)
		}
	}
	if !strings.HasPrefix(txt, "FDE 反馈\n") {
		t.Fatalf("第一行应当是 FDE 反馈：\n%s", txt)
	}
	run := e.ended(t, e.fdeRun(t, mid), "done")
	if s := sopStep(run, "send")["output"].(map[string]any)["sent_to"].(map[string]any); s["to"] != "U0BQZG8LSTB" || s["contact"] != "Robot.CyberBroleez" {
		t.Fatalf("sent_to = %v", s)
	}
	// 再点一次转任务：409，不再发
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+mid+"/task", `{}`); code != 409 {
		t.Fatalf("重复转任务 %d", code)
	}
	time.Sleep(100 * time.Millisecond)
	if n := len(e.fdes("U0BQZG8LSTB")); n != 1 {
		t.Fatalf("只发一次，发了 %d", n)
	}
}

// SOP 自动建的任务（im_to_task、task 节点）不发；设置没开时手动转任务也不发。
func TestFDEForwardNotForSOPOrDisabled(t *testing.T) {
	e := setupFDE(t)
	mid := e.msg(t, "流程建的")
	e.acked(t, e.ackFlow(t, ""), mid)
	other := e.flow(t, `{"name":"分流","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"分流建的"}}]}`)
	e.ended(t, e.start(t, other, fmt.Sprintf(`{"input":{"message_id":%q}}`, e.msg(t, "分流的"))), "done")
	call(t, e.h, "PATCH", "/api/im/settings", `{"fde_forward":false}`)
	e.convert(t, e.msg(t, "关着设置手动转"))
	time.Sleep(150 * time.Millisecond)
	if xs := e.fdes("U0BQZG8LSTB"); len(xs) != 0 {
		t.Fatalf("不该发：%+v", xs)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_fde_forwards`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("im_fde_forwards = %d %v", n, err)
	}
}

// 拆分任务：会话里一条条建的任务汇成一条，列出全部任务编号；之后再转任务也不再发。
func TestFDEForwardSplitAggregated(t *testing.T) {
	e := setupFDE(t)
	a, b := e.msg(t, "第一件：导出 CSV"), e.msg(t, "第二件：导入 Excel")
	bus := e.r.Events.(*events.Bus)
	ws := events.WrapStore(e.st, bus)
	var refs []string
	for _, title := range []string{"导出 CSV", "导入 Excel", "批量打印"} {
		o, err := ws.CreateObject(context.Background(), &domain.Object{TypeID: "task", Title: title, Props: map[string]any{
			domain.PropSourceRef: map[string]any{"kind": "im_message", "message_id": b, "message_ids": []any{a, b}},
		}}, store.Actor{Name: "agent", Source: "agent"})
		if err != nil {
			t.Fatal(err)
		}
		refs = append(refs, o.Ref)
		time.Sleep(30 * time.Millisecond)
	}
	xs := e.waitFDE(t, 1)
	txt := xs[0].Text
	if !strings.Contains(txt, "任务（3 条）") || !strings.Contains(txt, "第一件：导出 CSV") || !strings.Contains(txt, "第二件：导入 Excel") {
		t.Fatalf("汇总：\n%s", txt)
	}
	for _, r := range refs {
		if !strings.Contains(txt, r) {
			t.Fatalf("应当列出 %s：\n%s", r, txt)
		}
	}
	// 组里的消息再手动转任务：不再发
	e.convert(t, a)
	time.Sleep(300 * time.Millisecond)
	if n := len(e.fdes("U0BQZG8LSTB")); n != 1 {
		t.Fatalf("只发一次，发了 %d", n)
	}
}

// 联系人没有指定的 Slack 身份：流程失败写明原因；任务照常建好。
func TestFDEForwardNoIdentity(t *testing.T) {
	e := setupFDE(t)
	exec(t, e.st.DB(), `DELETE FROM contact_identities WHERE id = 'idn_robot'`)
	mid := e.msg(t, "没有身份")
	e.convert(t, mid)
	run := e.ended(t, e.fdeRun(t, mid), "failed")
	if msg, _ := sopStep(run, "send")["error"].(string); msg != "联系人 Robot.CyberBroleez 没有 Slack 身份 U0BQZG8LSTB" {
		t.Fatalf("失败原因 = %q", msg)
	}
	// 收件人留空、只剩我自己的身份
	cid := e.flow(t, `{"name":"发","fields":[],"steps":[{"key":"send","name":"私信","kind":"im_send_contact","after":[],
		"config":{"contact":"Robot.CyberBroleez","text":"hi"}}]}`)
	exec(t, e.st.DB(), `UPDATE contact_identities SET external_id = 'Broleez' WHERE id = 'idn_me'`)
	run = e.ended(t, e.start(t, cid, `{"input":{}}`), "failed")
	if msg, _ := sopStep(run, "send")["error"].(string); !strings.Contains(msg, "联系人 Robot.CyberBroleez 没有 Slack 身份") {
		t.Fatalf("失败原因 = %q", msg)
	}
	exec(t, e.st.DB(), `DELETE FROM contact_identities`)
	run = e.ended(t, e.start(t, cid, `{"input":{}}`), "failed")
	if msg, _ := sopStep(run, "send")["error"].(string); msg != "联系人 Robot.CyberBroleez 没有 Slack 身份" {
		t.Fatalf("失败原因 = %q", msg)
	}
}

// 发送失败：流程失败、记运行异常；任务照常。
func TestFDEForwardSendFails(t *testing.T) {
	e := setupFDE(t)
	e.r.SetIncidents(incident.New(e.st.DB(), nil))
	e.fake.FailReplies("not_allowed_token_type")
	mid := e.msg(t, "发不出去")
	task := e.convert(t, mid)
	run := e.ended(t, e.fdeRun(t, mid), "failed")
	if msg, _ := sopStep(run, "send")["error"].(string); !strings.Contains(msg, "私信 Robot.CyberBroleez 发不出去") || !strings.Contains(msg, "not_allowed_token_type") {
		t.Fatalf("失败原因 = %q", msg)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM incidents WHERE fingerprint LIKE 'sop:%:send'`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("应当记运行异常：%d %v", n, err)
	}
	if o, err := e.st.GetObject(context.Background(), task["id"].(string)); err != nil || o.DeletedAt != nil {
		t.Fatalf("任务应当还在：%v", err)
	}
}
