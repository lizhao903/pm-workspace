// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// IM 转任务执行完成后回复原消息（SPEC-messages-2.50）：转任务时发起内置流程「IM 任务回执」，
// 任务执行成功结束（run.finished）或改成已完成时，在原消息的串里回复。

func setupTaskReply(t *testing.T) (sopEnv, *events.Bus) {
	t.Helper()
	old := taskWaitEvery
	taskWaitEvery = 10 * time.Millisecond
	t.Cleanup(func() { taskWaitEvery = old })
	e := setupSOP(t)
	bus := events.New(e.r, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.r.Events = bus
	e.r.SetObjectCreator(e.st)
	return e, bus
}

// waitingOnTask：「等任务执行完成」这一步挂起着。
func waitingOnTask(r map[string]any) bool {
	out, _ := sopStep(r, "wait")["output"].(map[string]any)
	return out["waiting"] != nil
}

func (e sopEnv) toTask(t *testing.T, msgID, body string) (task, reply map[string]any) {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/im/messages/"+msgID+"/task", body)
	if code != 201 {
		t.Fatalf("转任务 %d %v", code, out)
	}
	return data(out)["task"].(map[string]any), data(out)["reply"].(map[string]any)
}

func (e sopEnv) msgID(t *testing.T, text string) string {
	t.Helper()
	_, out := call(t, e.h, "GET", "/api/im/messages", "")
	for _, m := range out["data"].([]any) {
		if mm := m.(map[string]any); mm["text"] == text {
			return mm["id"].(string)
		}
	}
	t.Fatalf("找不到消息 %q", text)
	return ""
}

// replyRun 是关联到任务上的那条回执执行。
func (e sopEnv) replyRun(t *testing.T, taskID string) string {
	t.Helper()
	var id string
	if err := e.st.DB().R.QueryRow(`SELECT id FROM sop_runs WHERE flow_id = ? AND object_id = ?`, TaskReplyFlowID, taskID).Scan(&id); err != nil {
		t.Fatalf("任务上应关联一条回执执行：%v", err)
	}
	return id
}

func TestTaskReplyAfterRunFinished(t *testing.T) {
	e, bus := setupTaskReply(t)
	ctx := context.Background()
	e.push(t, `{"external_id":"C01:t1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"对话框图片能点开放大吗"}`)
	id := e.msgID(t, "对话框图片能点开放大吗")
	task, reply := e.toTask(t, id, `{}`)
	if reply["enabled"] != true || reply["run_id"] == nil {
		t.Fatalf("回执应发起：%v", reply)
	}
	o, err := e.st.GetObject(ctx, task["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if ref, _ := o.Props[domain.PropSourceRef].(map[string]any); ref["reply_on_done"] != true {
		t.Fatalf("source_ref 应记 reply_on_done：%v", o.Props)
	}
	runID := e.replyRun(t, o.ID)
	e.until(t, runID, "挂在等任务完成", waitingOnTask)
	sent := len(e.fake.Sent())

	// 执行失败不算完成，接着等
	_ = bus.Publish(ctx, "run.finished", map[string]any{"run_id": "trn_1", "object_id": o.ID, "ok": false, "summary": "挂了"})
	bus.Wait(time.Second)
	time.Sleep(50 * time.Millisecond)
	if r := e.until(t, runID, "", func(map[string]any) bool { return true }); !waitingOnTask(r) {
		t.Fatalf("执行失败不该往下走：%v", r)
	}
	// 回执流程自己的 run.finished（没有 object_id）不当成任务执行
	_ = bus.Publish(ctx, "run.finished", map[string]any{"run_id": "run_x", "kind": "sop", "ok": true})
	// SOP 流程里一步 Claude Code（带 origin）跑完也不算任务做完
	_ = bus.Publish(ctx, "run.finished", map[string]any{"run_id": "trn_sop", "object_id": o.ID, "ok": true, "summary": "PRD 初稿", "origin": "plugin:sop"})
	bus.Wait(time.Second)
	time.Sleep(50 * time.Millisecond)
	if r := e.until(t, runID, "", func(map[string]any) bool { return true }); !waitingOnTask(r) {
		t.Fatalf("流程里的一步跑完不该回复：%v", r)
	}
	if n := len(e.fake.Sent()); n != sent {
		t.Fatalf("流程里的一步跑完不该发消息，多发了 %d 条", n-sent)
	}

	// 万一 summary 里混进了执行过程的工具行，回给对方前也去掉（TSK-0470）
	_ = bus.Publish(ctx, "run.finished", map[string]any{"run_id": "trn_2", "object_id": o.ID, "ok": true, "summary": "[工具] Bash · ls\nPRD 写好了，放在需求草稿里"})
	run := e.until(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	out := sopStep(run, "wait")["output"].(map[string]any)["task"].(map[string]any)
	if out["via"] != "run" || out["summary"] != "PRD 写好了，放在需求草稿里" {
		t.Fatalf("等任务的输出：%v", out)
	}
	got := e.fake.Sent()
	if len(got) != sent+1 {
		t.Fatalf("应回复一条：%d -> %d", sent, len(got))
	}
	last := got[len(got)-1]
	if last.ReplyTo != "C01:t1" || last.Text != "「"+o.Title+"」（"+o.Ref+"）已完成。\n结果：PRD 写好了，放在需求草稿里" {
		t.Fatalf("回复：%+v", last)
	}
	var n int
	_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_replies WHERE message_id = ? AND status = 'sent'`, id).Scan(&n)
	if n != 1 {
		t.Fatalf("回复要记进 im_replies：%d", n)
	}
	_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_task_waits`).Scan(&n)
	if n != 0 {
		t.Fatalf("等待行应删掉：%d", n)
	}
}

func TestTaskReplyAfterMarkedDoneAndOptOut(t *testing.T) {
	e, _ := setupTaskReply(t)
	ctx := context.Background()
	e.push(t, `{"external_id":"C01:t2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"导出按钮没反应"}`)
	e.push(t, `{"external_id":"C01:t3","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"不用回我"}`)

	task, _ := e.toTask(t, e.msgID(t, "导出按钮没反应"), `{"title":"修导出按钮"}`)
	runID := e.replyRun(t, task["id"].(string))
	e.until(t, runID, "挂在等任务完成", waitingOnTask)

	// 不经事件改成已完成（插件停用期间改的）：后台任务按当前状态补认
	done := "done"
	if _, err := e.st.UpdateObject(ctx, task["id"].(string), domain.ObjectPatch{Status: &done}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	run := e.until(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	if sopStep(run, "wait")["output"].(map[string]any)["task"].(map[string]any)["via"] != "status" {
		t.Fatalf("应按状态认：%v", run)
	}
	// 改成已完成没有结论：只回状态一行，不留空的「结果：」（TSK-0470）
	if last := e.fake.Sent()[len(e.fake.Sent())-1]; last.ReplyTo != "C01:t2" || last.Text != "「修导出按钮」（"+task["ref"].(string)+"）已完成。" {
		t.Fatalf("回复：%+v", last)
	}

	// 不勾：不发起，source_ref 不记
	task2, reply := e.toTask(t, e.msgID(t, "不用回我"), `{"reply_on_done":false}`)
	if reply["enabled"] != false {
		t.Fatalf("不勾不该发起：%v", reply)
	}
	o, _ := e.st.GetObject(ctx, task2["id"].(string))
	if ref, _ := o.Props[domain.PropSourceRef].(map[string]any); ref["reply_on_done"] != nil {
		t.Fatalf("不勾不记 reply_on_done：%v", ref)
	}
	var n int
	_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM sop_runs WHERE object_id = ?`, o.ID).Scan(&n)
	if n != 0 {
		t.Fatalf("不勾不该有回执执行：%d", n)
	}
}

func TestTaskReplyFlowDeletedNotReAdded(t *testing.T) {
	e, _ := setupTaskReply(t)
	e.push(t, `{"external_id":"C01:t4","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"第一条"}`)
	e.push(t, `{"external_id":"C01:t5","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"第二条"}`)
	e.toTask(t, e.msgID(t, "第一条"), `{"reply_on_done":false}`)
	// 写过一次之后用户在 SOP 里删掉：不再加回来
	_, reply := e.toTask(t, e.msgID(t, "第二条"), `{}`)
	if reply["enabled"] != true {
		t.Fatalf("第一次用应现写流程并发起：%v", reply)
	}
	// 有进行中的执行删不掉：先停掉
	var runID, taskID string
	_ = e.st.DB().R.QueryRow(`SELECT id, object_id FROM sop_runs WHERE flow_id = ?`, TaskReplyFlowID).Scan(&runID, &taskID)
	e.until(t, runID, "挂在等任务完成", waitingOnTask)
	if code, out := call(t, e.h, "POST", "/api/sop/runs/"+runID+"/actions", `{"kind":"stop"}`); code >= 300 {
		t.Fatalf("停执行 %d %v", code, out)
	}
	// 停掉的执行：任务之后完成了，等待行删掉、不再重试
	done := "done"
	if _, err := e.st.UpdateObject(context.Background(), taskID, domain.ObjectPatch{Status: &done}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var n int
		_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_task_waits WHERE run_id = ?`, runID).Scan(&n)
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("执行停掉后等待行应删掉")
		}
	}
	if code, out := call(t, e.h, "DELETE", "/api/sop/flows/"+TaskReplyFlowID, ""); code >= 300 {
		t.Fatalf("删流程 %d %v", code, out)
	}
	e.push(t, `{"external_id":"C01:t6","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U07LUCY","sender_name":"Lucy","text":"第三条"}`)
	_, reply = e.toTask(t, e.msgID(t, "第三条"), `{}`)
	if reply["enabled"] != false || !strings.Contains(reply["note"].(string), "删掉") {
		t.Fatalf("流程删了不该加回来：%v", reply)
	}
	if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+TaskReplyFlowID, ""); code != 404 {
		t.Fatalf("流程应仍是删掉的：%d", code)
	}
}

// TestCleanReply：回给对方的文字去掉执行过程的工具行、末尾空着的标签行；中间带列表的标签不动（TSK-0470）。
func TestCleanReply(t *testing.T) {
	cases := map[string]string{
		"「导出」（TSK-0001）已完成。\n结果：":                                  "「导出」（TSK-0001）已完成。",
		"「导出」（TSK-0001）已完成。\n结果：改好了":                               "「导出」（TSK-0001）已完成。\n结果：改好了",
		"先同步一下进度\n[工具] Bash · ls\n  [工具失败] Read · a.go\n改好了，单测通过。": "先同步一下进度\n改好了，单测通过。",
		"请验收。\n验收清单：\n- [ ] 导出 CSV":                                "请验收。\n验收清单：\n- [ ] 导出 CSV",
		"[工具] Bash · ls": "",
	}
	for in, want := range cases {
		if got := cleanReply(in); got != want {
			t.Errorf("cleanReply(%q) = %q，应当 %q", in, got, want)
		}
	}
}

// TestReplyMessageStripsProcess：im_reply_message 这一层去掉工具行再发；只剩工具行时失败。
func TestReplyMessageStripsProcess(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "导出要支持 CSV")
	fid := e.flow(t, `{"name":"回","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"r","name":"回复原消息","kind":"im_reply_message","after":[],"config":{"text":"已完成。\n[工具] Bash · go test ./...\n结果：{{note}}"}}]}`)
	e.ended(t, e.start(t, fid, fmt.Sprintf(`{"input":{"message_id":%q,"note":"改好了"}}`, mid)), "done")
	e.ended(t, e.start(t, fid, fmt.Sprintf(`{"input":{"message_id":%q}}`, mid)), "done")
	got := e.acksTo("C01")
	if len(got) != 2 || got[0] != "已完成。\n结果：改好了" || got[1] != "已完成。" {
		t.Fatalf("回复 = %q", got)
	}
}

// TestTaskReplyFlowUpgrade：已写进 SOP 的旧版「IM 任务回执」：第 1 版换成新模板；改过的不动（TSK-0470）。
func TestTaskReplyFlowUpgrade(t *testing.T) {
	e := setupConfirm(t)
	old := `[{"key":"wait","name":"等任务执行完成","kind":"im_wait_task","desc":"","config":{"task":"{{task_id}}","timeout":"14 天"}},` +
		`{"key":"reply","name":"回复原消息","kind":"im_reply_message","desc":"","config":{"message":"{{message_id}}","text":"「{{task.title}}」已经处理完了（{{task.ref}}）。\n{{task.summary}}"}}]`
	ins := func(version int) {
		exec(t, e.st.DB(), `DELETE FROM sop_flows WHERE id = '`+TaskReplyFlowID+`'`,
			fmt.Sprintf(`INSERT INTO sop_flows (id, name, description, trigger_desc, fields, steps, version, created_at, updated_at)
			VALUES ('%s', 'IM 任务回执', '', 'manual', '[]', '%s', %d, 'x', 'x')`, TaskReplyFlowID, strings.ReplaceAll(old, "'", "''"), version),
			`INSERT INTO im_sop_templates (flow_id, installed_at) VALUES ('`+TaskReplyFlowID+`', 'x') ON CONFLICT DO NOTHING`,
			`DELETE FROM im_sop_templates WHERE flow_id = '`+taskReplyUpgradeMark+`'`)
	}
	stepsOf := func() string {
		var s string
		_ = e.st.DB().R.QueryRow(`SELECT steps FROM sop_flows WHERE id = ?`, TaskReplyFlowID).Scan(&s)
		return s
	}
	waitMark := func() {
		deadline := time.Now().Add(5 * time.Second)
		for {
			var n int
			_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, taskReplyUpgradeMark).Scan(&n)
			if n > 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("等了 5 秒没有升级标记")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	ins(1)
	waitMark()
	if s := stepsOf(); !strings.Contains(s, "已完成。") || strings.Contains(s, "已经处理完了") {
		t.Fatalf("第 1 版应当换成新模板：%s", s)
	}
	ins(3)
	waitMark()
	if s := stepsOf(); !strings.Contains(s, "已经处理完了") {
		t.Fatalf("改过的不该覆盖：%s", s)
	}
}
