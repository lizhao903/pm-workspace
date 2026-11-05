package sop

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	clauderun "github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 执行任务、更新任务（TSK-0411）：工作目录按任务 → 项目继承、没有或不可写时失败写明原因、on_fail=continue 交给下游；
// 改负责人（名册里没有时不改、给提示）、改状态、只读取；task 节点按来源消息不重复建任务。

func newTaskRunEnv(t *testing.T) (writeEnv, *plugin.Registry, http.Handler, *fakeClaude) {
	t.Helper()
	e := newWriteEnv(t)
	r, h := e.boot(New())
	t.Cleanup(r.Close)
	f := newFakeClaude()
	r.SetClaudeRunner(f)
	bin := t.TempDir() + "/pmw-mcp"
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.SetRunCallback(bin, "http://127.0.0.1:7801")
	t.Cleanup(func() { r.WaitRuns(5 * time.Second) })
	return e, r, h, f
}

func mkObj(t *testing.T, e writeEnv, o domain.Object) *domain.Object {
	t.Helper()
	out, err := e.st.CreateObject(context.Background(), &o, store.Actor{Name: "me", Source: "ui"})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

const taskRunFlow = `{"name":"派活","fields":[{"key":"task_id","label":"任务","type":"text"}],"steps":[
	{"key":"run","name":"执行任务","kind":"task_run","after":[],"config":{"task":"{{task_id}}","prompt":"先跑测试"%s}},
	{"key":"ok","name":"成功？","kind":"decide","after":["run"],"rule":"status 等于 done","cases":[{"key":"yes","label":"成功"},{"key":"no","label":"失败"}]},
	{"key":"good","name":"好","kind":"template","after":["ok"],"branch":{"of":"ok","case":"yes"},"config":{"template":"完成：{{summary}}","output":"text"}},
	{"key":"bad","name":"坏","kind":"template","after":["ok"],"branch":{"of":"ok","case":"no"},"config":{"template":"失败：{{error}}","output":"text"}}
]}`

// TestTaskRunInheritsProjectWorkdir：任务没设工作目录时用所属项目的；可写、提示词由任务拼、执行记录留在任务上。
func TestTaskRunInheritsProjectWorkdir(t *testing.T) {
	e, r, h, f := newTaskRunEnv(t)
	wd := t.TempDir()
	proj := mkObj(t, e, domain.Object{TypeID: "project", Title: "控制台", Workdir: wd})
	task := mkObj(t, e, domain.Object{TypeID: "task", Title: "加个按钮", ProjectID: &proj.ID,
		Props: map[string]any{domain.PropAcceptance: "- [ ] 按钮能点"}})
	fid := newFlow(t, h, fmt.Sprintf(taskRunFlow, ""))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q}}`, task.ID))["id"].(string)
	rid := recvRun(t, f)
	req := f.req(0)
	if req.Workdir != wd || !req.AllowWrites || !strings.Contains(req.Prompt, task.Ref) || !strings.Contains(req.Prompt, "按钮能点") ||
		!strings.Contains(req.Prompt, "先跑测试") || !strings.Contains(req.Prompt, "pmw_get_object") || !strings.Contains(req.Prompt, "控制台") {
		t.Fatalf("请求 = %+v", req)
	}
	if _, err := r.ReportRun(rid, "done", "改好了", nil); err != nil {
		t.Fatal(err)
	}
	f.results <- &clauderun.Result{Status: domain.RunDone}
	got := waitStatus(t, h, id, "done")
	if txt := step(got, "good")["output"].(map[string]any)["text"]; txt != "完成：改好了" {
		t.Fatalf("下游 = %v", txt)
	}
	c, _ := step(got, "run")["claude"].(map[string]any)
	if c["task_id"] != task.ID || c["workdir"] != wd {
		t.Fatalf("claude = %v", c)
	}
	runs, err := e.st.ListTaskRuns(context.Background(), task.ID, 10)
	if err != nil || len(runs) != 1 || runs[0].Workdir != wd {
		t.Fatalf("任务上的执行记录 = %+v %v", runs, err)
	}
}

// TestTaskRunOwnWorkdirWins：任务自己设了工作目录时优先用它；任务可以按编号认。
func TestTaskRunOwnWorkdirWins(t *testing.T) {
	e, _, h, f := newTaskRunEnv(t)
	pwd, twd := t.TempDir(), t.TempDir()
	proj := mkObj(t, e, domain.Object{TypeID: "project", Title: "控制台", Workdir: pwd})
	task := mkObj(t, e, domain.Object{TypeID: "task", Title: "改文案", ProjectID: &proj.ID, Workdir: twd})
	fid := newFlow(t, h, fmt.Sprintf(taskRunFlow, ""))
	startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q}}`, task.Ref))
	recvRun(t, f)
	if f.req(0).Workdir != twd {
		t.Fatalf("工作目录 = %s", f.req(0).Workdir)
	}
	f.results <- &clauderun.Result{Status: domain.RunDone}
}

// TestTaskRunNoWorkdir：任务和项目都没设工作目录、目录不存在、不可写时这一步失败，写明是哪条任务、哪个项目；不发起。
func TestTaskRunNoWorkdir(t *testing.T) {
	e, _, h, f := newTaskRunEnv(t)
	proj := mkObj(t, e, domain.Object{TypeID: "project", Title: "空项目"})
	bare := mkObj(t, e, domain.Object{TypeID: "task", Title: "没目录", ProjectID: &proj.ID})
	gone := mkObj(t, e, domain.Object{TypeID: "task", Title: "目录没了", Workdir: filepath.Join(t.TempDir(), "nope")})
	ro := t.TempDir()
	if err := os.Chmod(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })
	roProj := mkObj(t, e, domain.Object{TypeID: "project", Title: "只读项目", Workdir: ro})
	roTask := mkObj(t, e, domain.Object{TypeID: "task", Title: "只读", ProjectID: &roProj.ID})
	fid := newFlow(t, h, fmt.Sprintf(taskRunFlow, ""))
	cases := []struct {
		task string
		want []string
	}{
		{bare.ID, []string{bare.Ref, "没有工作目录", "所属项目「空项目」也没设"}},
		{gone.ID, []string{gone.Ref, "继承自任务", "不存在"}},
		{roTask.ID, []string{roTask.Ref, "继承自所属项目「只读项目」", "不可写"}},
		{"obj_missing", []string{"任务 obj_missing 不存在"}},
		{"", []string{"没有指定任务"}},
	}
	for _, c := range cases {
		id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q}}`, c.task))["id"].(string)
		got := waitStatus(t, h, id, "failed")
		msg, _ := step(got, "run")["error"].(string)
		for _, w := range c.want {
			if !strings.Contains(msg, w) {
				t.Errorf("任务 %q 的失败原因 %q 里应当有 %q", c.task, msg, w)
			}
		}
	}
	select {
	case <-f.started:
		t.Fatal("不该发起")
	default:
	}
}

// TestTaskRunContinueOnFail：on_fail=continue 时没有工作目录、执行失败都不让这一步失败，输出 status=failed 和原因，下游按它分支。
func TestTaskRunContinueOnFail(t *testing.T) {
	e, _, h, f := newTaskRunEnv(t)
	bare := mkObj(t, e, domain.Object{TypeID: "task", Title: "没目录"})
	fid := newFlow(t, h, fmt.Sprintf(taskRunFlow, `,"on_fail":"continue"`))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q}}`, bare.ID))["id"].(string)
	got := waitStatus(t, h, id, "done")
	if txt, _ := step(got, "bad")["output"].(map[string]any)["text"].(string); !strings.Contains(txt, "没有工作目录") {
		t.Fatalf("下游 = %v", step(got, "bad"))
	}

	wd := t.TempDir()
	task := mkObj(t, e, domain.Object{TypeID: "task", Title: "会失败", Workdir: wd})
	id = startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q}}`, task.ID))["id"].(string)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunFailed, ExitCode: 1, Error: "退出码 1"}
	got = waitStatus(t, h, id, "done")
	out := step(got, "run")["output"].(map[string]any)
	if out["status"] != "failed" || !strings.Contains(fmt.Sprint(out["error"]), "退出码 1") || out["run_id"] == nil {
		t.Fatalf("输出 = %v", out)
	}
	if step(got, "ok")["route"] != "no" {
		t.Fatalf("分支 = %v", step(got, "ok"))
	}
}

// TestTaskRunCheck：保存时检查超时写法和 on_fail。
func TestTaskRunCheck(t *testing.T) {
	_, _, h, _ := newTaskRunEnv(t)
	code, out := call(t, h, "POST", "/api/sop/flows", fmt.Sprintf(taskRunFlow, `,"on_fail":"retry","timeout":"永远"`))
	if code != 400 || !strings.Contains(fmt.Sprint(out), "失败时只能是") || !strings.Contains(fmt.Sprint(out), "超时") {
		t.Fatalf("%d %v", code, out)
	}
}

// TestTaskUpdate：改负责人（名册里的人）、名字对不上不改并给提示、改状态、都不填只读取；输出带继承后的工作目录。
func TestTaskUpdate(t *testing.T) {
	e, _, h, _ := newTaskRunEnv(t)
	e.exec(t, `INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_lin', '林原', 'x', 'x')`)
	wd := t.TempDir()
	proj := mkObj(t, e, domain.Object{TypeID: "project", Title: "控制台", Workdir: wd})
	task := mkObj(t, e, domain.Object{TypeID: "task", Title: "加个按钮", ProjectID: &proj.ID})
	fid := newFlow(t, h, `{"name":"改任务","fields":[{"key":"task_id","label":"任务","type":"text"},{"key":"who","label":"谁","type":"text"},{"key":"st","label":"状态","type":"text"}],"steps":[
		{"key":"read","name":"读","kind":"task_update","after":[]},
		{"key":"u","name":"改","kind":"task_update","after":["read"],"config":{"task":"{{task.id}}","assignee":"{{who}}","status":"{{st}}"}}]}`)
	run := func(who, st string) map[string]any {
		id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q,"who":%q,"st":%q}}`, task.ID, who, st))["id"].(string)
		return waitStatus(t, h, id, "done")
	}
	got := run("@林原", "")
	rd := step(got, "read")["output"].(map[string]any)["task"].(map[string]any)
	if rd["workdir"] != wd || rd["project"] != "控制台" || rd["ref"] != task.Ref || !hasLog(step(got, "read"), "只读取了任务") {
		t.Fatalf("只读取 = %v", rd)
	}
	u := step(got, "u")["output"].(map[string]any)["task"].(map[string]any)
	if u["assign_ok"] != "yes" || u["assignee"] != "林原" || u["owner_id"] != "stk_lin" {
		t.Fatalf("分配 = %v", u)
	}
	o, _ := e.st.GetObject(context.Background(), task.ID)
	if o.OwnerID == nil || *o.OwnerID != "stk_lin" {
		t.Fatalf("负责人 = %v", o.OwnerID)
	}

	got = run("张三", "")
	u = step(got, "u")["output"].(map[string]any)["task"].(map[string]any)
	if u["assign_ok"] != "no" || u["assign_note"] != "没找到「张三」，任务留着没分配" || u["owner_id"] != "stk_lin" ||
		!hasLog(step(got, "u"), "没找到「张三」") {
		t.Fatalf("对不上 = %v", u)
	}

	got = run("", "cancelled")
	u = step(got, "u")["output"].(map[string]any)["task"].(map[string]any)
	if u["status"] != "cancelled" || u["assign_ok"] != "no" {
		t.Fatalf("取消 = %v", u)
	}
	if o, _ = e.st.GetObject(context.Background(), task.ID); o.Status != "cancelled" {
		t.Fatalf("状态 = %s", o.Status)
	}

	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"task_id":%q,"who":"","st":"whatever"}}`, task.ID))["id"].(string)
	got = waitStatus(t, h, id, "failed")
	if msg, _ := step(got, "u")["error"].(string); !strings.Contains(msg, "改任务 "+task.Ref+" 失败") {
		t.Fatalf("状态不认 = %v", msg)
	}
}

// TestTaskNodeDedupByMessage：输入带 message_id 时任务来源记上消息；这条消息已经被别的执行建过任务时取回那条，不再建。
func TestTaskNodeDedupByMessage(t *testing.T) {
	e, _, h, _ := newTaskRunEnv(t)
	fid := newFlow(t, h, `{"name":"建任务","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"跟进 {{message_id}}"}}]}`)
	first := waitStatus(t, h, startRun(t, h, fid, `{"input":{"message_id":"msg_1"}}`)["id"].(string), "done")
	t1 := step(first, "t")["output"].(map[string]any)["task"].(map[string]any)
	o, _ := e.st.GetObject(context.Background(), t1["id"].(string))
	if ref, _ := o.Props["source_ref"].(map[string]any); ref["message_id"] != "msg_1" {
		t.Fatalf("来源 = %v", o.Props)
	}
	second := waitStatus(t, h, startRun(t, h, fid, `{"input":{"message_id":"msg_1"}}`)["id"].(string), "done")
	t2 := step(second, "t")["output"].(map[string]any)["task"].(map[string]any)
	if t2["id"] != t1["id"] || t2["reused"] != true || !hasLog(step(second, "t"), "已经建过任务") {
		t.Fatalf("第二次 = %v", t2)
	}
	if n := e.count(t, `SELECT count(*) FROM objects WHERE type_id = 'task'`); n != 1 {
		t.Fatalf("任务 %d 条", n)
	}
	// 别的消息、没带消息的照常建
	waitStatus(t, h, startRun(t, h, fid, `{"input":{"message_id":"msg_2"}}`)["id"].(string), "done")
	waitStatus(t, h, startRun(t, h, fid, `{"input":{}}`)["id"].(string), "done")
	if n := e.count(t, `SELECT count(*) FROM objects WHERE type_id = 'task'`); n != 3 {
		t.Fatalf("任务 %d 条", n)
	}
}
