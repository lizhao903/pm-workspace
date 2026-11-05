package im

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// IM 需求自动受理（AUTO-06）：内置流程默认停用（触发方式手动）、只写一次；改成 IM 触发后，
// 一条需求消息建任务、回执、分类、Claude Code 写 PRD 和评审，评审退回一轮后通过、进入开发；分类拿不准时问提出人；
// 不是需求的不建任务。只在测试里把 SOP、项目插件拉进来，插件代码之间不 import。

// intakeAgent 是假的 Core.Agent()：分类器、分类、整理、认项目各回一种，sure 控制分类拿不拿得准。
type intakeAgent struct {
	mu   sync.Mutex
	sure bool
	reqs []plugin.CompleteRequest
}

func (a *intakeAgent) Complete(_ context.Context, req plugin.CompleteRequest) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reqs = append(a.reqs, req)
	switch {
	case strings.Contains(req.System, "你做分类"):
		if strings.Contains(req.Prompt, "午饭") {
			return "不是需求", nil
		}
		return "是需求", nil
	case strings.Contains(req.System, "提取字段"):
		_, text, _ := strings.Cut(req.Prompt, "文字：\n")
		return text, nil
	case strings.Contains(req.Prompt, "判断这条需求该归到哪个项目"):
		if a.sure {
			return `{"project_id":"obj_acme","project":"Acme","confidence":0.92,"sure":"yes","candidates_text":"1. Acme（PRJ-0001）","reason":"说的是客户端"}`, nil
		}
		return "```json\n{\"project_id\":\"\",\"project\":\"\",\"confidence\":0.4,\"sure\":\"no\",\"candidates_text\":\"1. Acme（PRJ-0001）\\n2. Globex（PRJ-0002）\",\"reason\":\"两个项目都有导出\"}\n```", nil
	case strings.Contains(req.Prompt, "从回复里认出"):
		return " obj_acme。", nil
	}
	return "", nil
}

// asked：有一次请求的提示词同时含这几段。
func (a *intakeAgent) asked(parts ...string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, r := range a.reqs {
		ok := true
		for _, p := range parts {
			ok = ok && strings.Contains(r.Prompt, p)
		}
		if ok {
			return true
		}
	}
	return false
}

func (a *intakeAgent) RunAgent(context.Context, plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, nil
}
func (a *intakeAgent) AgentState(context.Context, string) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, nil
}
func (a *intakeAgent) SearchKB(context.Context, []string, string, int) ([]plugin.KBHit, error) {
	return nil, nil
}

// intakeClaude 是可控的 Claude Code：记下请求，按 results 依次回结果。
type intakeClaude struct {
	mu      sync.Mutex
	reqs    []runner.Request
	results chan *runner.Result
	started chan string
}

func (f *intakeClaude) Start(ctx context.Context, req runner.Request, _ func(runner.Event)) (*runner.Result, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	f.mu.Unlock()
	f.started <- req.RunID
	select {
	case res := <-f.results:
		return res, nil
	case <-ctx.Done():
		return &runner.Result{Status: domain.RunCanceled, ExitCode: -1, Error: "已取消"}, nil
	}
}

func (f *intakeClaude) last() runner.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[len(f.reqs)-1]
}

type intakeEnv struct {
	sopEnv
	agent  *intakeAgent
	claude *intakeClaude
	proto  string // Acme 的原型库目录
	code   string // Acme 的项目目录（代码库没设，用它）
}

func setupIntake(t *testing.T) intakeEnv {
	t.Helper()
	oldWait, oldTask, oldIntake := waitEvery, taskWaitEvery, intakeEvery
	waitEvery, taskWaitEvery, intakeEvery = 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { waitEvery, taskWaitEvery, intakeEvery = oldWait, oldTask, oldIntake })
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	bus := events.New(r, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Events = bus
	// 建对象、改阶段经事件总线发 object.* 事件（同 cmd/pmw），项目插件据此准备工作区、回收保留的测试环境
	r.SetObjectCreator(events.WrapStore(st, bus))
	r.DataDir = t.TempDir() // 研发 pipeline 的工作区、测试报告放这里（AUTO-09）
	e := intakeEnv{sopEnv: sopEnv{r: r, st: st, fake: NewFake("fake", "slack", time.Hour, "Broleez")},
		agent: &intakeAgent{sure: true}, claude: &intakeClaude{results: make(chan *runner.Result, 8), started: make(chan string, 8)}}
	r.SetAgent(e.agent)
	r.SetClaudeRunner(e.claude)
	r.SetRunPresets(func(_ context.Context, id string) (*runner.Preset, error) {
		return &runner.Preset{Scene: id, Content: "角色 " + id, ReadOnly: id == "rp_review"}, nil
	})
	bin := filepath.Join(t.TempDir(), "pmw-mcp")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.SetRunCallback(bin, "http://127.0.0.1:7806")
	for _, p := range []plugin.Plugin{sop.New(), projects.New().WithPublicURL("http://pmw.test/"), New(e.fake).WithPublicURL("http://pmw.test/")} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.WaitRuns(5 * time.Second); r.Close() })
	// 先装 SOP、项目插件，IM 插件启用后后台任务把内置流程写进去
	for _, id := range []string{"sop", "projects", "im"} {
		perms := map[string][]string{"sop": {"network:any", "fs:write:project", "process:spawn"}, "projects": {"process:spawn"}, "im": {"network:im"}}[id]
		if err := r.Install(ctx, id, perms); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	e.h = mux
	e.proto, e.code = t.TempDir(), t.TempDir()
	exec(t, st.DB(),
		`INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
		  ('cn_ok', 'slack', 'Slack 工作区', 'connected', 'both', 'x', 'x')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES
		  ('cv_prod', 'slack', 'C01', 'group', '#product', 'x', 'x')`,
		`INSERT INTO objects (id, type_id, ref, title, props, workdir, created_at, updated_at) VALUES
		  ('obj_acme', 'project', 'PRJ-0001', 'Acme', '{}', '`+e.code+`', '2026-01-01', '2026-01-01'),
		  ('obj_globex', 'project', 'PRJ-0002', 'Globex', '{}', '', '2026-01-02', '2026-01-02')`,
	)
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_acme/profile", `{"intro":"桌面客户端","keywords":["客户端","导出"],"proto_dir":"`+e.proto+`"}`); code != 200 {
		t.Fatalf("建档案 %d %v", code, out)
	}
	e.waitFlow(t)
	return e
}

func (e intakeEnv) waitFlow(t *testing.T) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, out := call(t, e.h, "GET", "/api/sop/flows/"+AutoIntakeFlowID, ""); code == 200 {
			return data(out)
		}
		if time.Now().After(deadline) {
			t.Fatal("等了 5 秒内置流程还没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e intakeEnv) enable(t *testing.T) {
	t.Helper()
	if code, out := call(t, e.h, "PATCH", "/api/sop/flows/"+AutoIntakeFlowID, `{"trigger":"im"}`); code != 200 {
		t.Fatalf("改成 IM 触发 %d %v", code, out)
	}
}

// runOf 等这条消息发起的那次执行，回执行 id。
func (e intakeEnv) runOf(t *testing.T, msgID string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var id string
		err := e.st.DB().R.QueryRow(`SELECT id FROM sop_runs WHERE flow_id = ? AND json_extract(input, '$.message_id') = ?`, AutoIntakeFlowID, msgID).Scan(&id)
		if err == nil {
			return id
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒消息 %s 还没发起执行", msgID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e intakeEnv) recv(t *testing.T) string {
	t.Helper()
	select {
	case id := <-e.claude.started:
		return id
	case <-time.After(5 * time.Second):
		t.Fatal("等了 5 秒 Claude Code 还没被发起")
		return ""
	}
}

// finish 让在跑的 Claude Code 回报结论并结束。
func (e intakeEnv) finish(t *testing.T, runID, summary string, result map[string]any) {
	t.Helper()
	if _, err := e.r.ReportRun(runID, "done", summary, result); err != nil {
		t.Fatal(err)
	}
	e.claude.results <- &runner.Result{Status: domain.RunDone, Output: summary}
}

func (e intakeEnv) task(t *testing.T, msgID string) *domain.Object {
	t.Helper()
	_, out := call(t, e.h, "GET", "/api/im/messages/"+msgID, "")
	id, _ := data(out)["task_id"].(string)
	if id == "" {
		t.Fatalf("消息上没记任务：%v", data(out))
	}
	o, err := e.st.GetObject(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func (e intakeEnv) stageIs(t *testing.T, msgID, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		o := e.task(t, msgID)
		if domain.StageOf(o.Props) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("阶段应为 %s，实际 %s", want, domain.StageOf(o.Props))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestIntakeFlowInstalledDisabled：内置流程写进 SOP、触发方式手动（默认停用）；来消息不发起；删了不补回来。
func TestIntakeFlowInstalledDisabled(t *testing.T) {
	e := setupIntake(t)
	f := e.waitFlow(t)
	if f["trigger"] != "manual" || f["name"] != "IM 需求自动受理" || f["version"].(float64) != 1 {
		t.Fatalf("内置流程：%v", f)
	}
	e.push(t, `{"external_id":"C01:d1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"导出能不能加个 CSV"}`)
	time.Sleep(100 * time.Millisecond)
	var n int
	_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM sop_runs WHERE flow_id = ?`, AutoIntakeFlowID).Scan(&n)
	if n != 0 {
		t.Fatalf("没启用不该自动跑：%d 次", n)
	}
	if code, out := call(t, e.h, "DELETE", "/api/sop/flows/"+AutoIntakeFlowID, ""); code != 200 {
		t.Fatalf("删流程 %d %v", code, out)
	}
	time.Sleep(100 * time.Millisecond)
	if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+AutoIntakeFlowID, ""); code != 404 {
		t.Fatalf("删了不该补回来：%d", code)
	}
}

// TestIntakeHappyPathWithRework：需求消息 → 建任务（已接收）→ 回执带看板链接 → 分类拿得准、绑 Acme → 设计中 →
// 产品在原型库目录写 PRD → 评审中 → 评审退回一轮（意见带回产品）→ 第二轮通过 → 开发中，告诉提出人。
func TestIntakeHappyPathWithRework(t *testing.T) {
	e := setupIntake(t)
	e.enable(t)
	e.push(t, `{"external_id":"C01:h1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"客户端导出能不能加个 CSV 格式"}`)
	msg := e.msgID(t, "客户端导出能不能加个 CSV 格式")
	runID := e.runOf(t, msg)

	first := e.recv(t)
	o := e.task(t, msg)
	req := o.Props[domain.PropRequester].(map[string]any)
	if o.TypeID != "task" || req["name"] != "林原" || o.ProjectID == nil || *o.ProjectID != "obj_acme" || domain.StageOf(o.Props) != "designing" {
		t.Fatalf("任务：%+v props %v", o, o.Props)
	}
	if src, _ := o.Props[domain.PropSourceRef].(map[string]any); src["message_id"] != msg {
		t.Fatalf("来源消息：%v", o.Props)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || sent[0].ReplyTo != "C01:h1" || !strings.Contains(sent[0].Text, o.Ref) ||
		!strings.Contains(sent[0].Text, "http://pmw.test/tasks/board?t="+o.ID) {
		t.Fatalf("回执：%+v", sent)
	}
	pm := e.claude.last()
	if pm.Workdir != e.proto || !strings.Contains(pm.Prompt, "客户端导出能不能加个 CSV 格式") || !strings.Contains(pm.Prompt, o.Ref) {
		t.Fatalf("产品这一步：workdir %s prompt %s", pm.Workdir, pm.Prompt)
	}
	if !e.agent.asked("判断这条需求该归到哪个项目", "Acme（编号 PRJ-0001，id obj_acme）：桌面客户端；关键词：客户端、导出") {
		t.Fatal("分类提示词应带项目档案摘要")
	}
	e.finish(t, first, "PRD 初稿写好了", map[string]any{"artifacts": []any{"prd/csv.md"}, "questions": []any{}})

	review := e.recv(t)
	e.stageIs(t, msg, "reviewing")
	if rv := e.claude.last(); rv.Workdir != e.code || rv.AllowWrites || !strings.Contains(rv.Prompt, "PRD 初稿写好了") {
		t.Fatalf("评审这一步：workdir %s 可写 %v prompt %s", rv.Workdir, rv.AllowWrites, rv.Prompt)
	}
	e.finish(t, review, "缺验收标准", map[string]any{"verdict": "reject", "issues": []any{map[string]any{"title": "缺验收标准", "severity": "blocker"}}})

	// 退回：回到设计中，产品第二轮带着评审意见
	second := e.recv(t)
	e.stageIs(t, msg, "designing")
	if p2 := e.claude.last(); !strings.Contains(p2.Prompt, "缺验收标准") {
		t.Fatalf("第二轮提示词应带评审意见：%s", p2.Prompt)
	}
	e.finish(t, second, "补了验收标准", map[string]any{"artifacts": []any{"prd/csv.md"}})
	review2 := e.recv(t)
	e.finish(t, review2, "可以开发", map[string]any{"verdict": "pass", "issues": []any{}})

	// 评审通过后接研发 pipeline（AUTO-09）：子流程带着任务 id 和来源消息起来；这里 Acme 的目录不是 git 仓库，研发 pipeline 停在准备工作区
	run := e.until(t, runID, "接上研发 pipeline", func(r map[string]any) bool { return sopStep(r, "pipeline")["child_run_id"] != nil })
	e.stageIs(t, msg, "developing")
	if sopStep(run, "gate")["loops"].(float64) != 1 || sopStep(run, "human")["status"] != "bypassed" || sopStep(run, "ask")["status"] != "bypassed" {
		t.Fatalf("执行：gate %v human %v ask %v", sopStep(run, "gate"), sopStep(run, "human")["status"], sopStep(run, "ask")["status"])
	}
	sent = e.fake.Sent()
	if len(sent) != 2 || !strings.Contains(sent[1].Text, "进入开发") || sent[1].ReplyTo != "C01:h1" {
		t.Fatalf("应告诉提出人进入开发：%+v", sent)
	}
	child := e.until(t, sopStep(run, "pipeline")["child_run_id"].(string), "研发 pipeline 停在准备工作区",
		func(r map[string]any) bool { return sopStep(r, "worktree")["status"] == "failed" })
	in := child["input"].(map[string]any)
	if child["flow_id"] != DevPipelineFlowID || in["task_id"] != o.ID || in["message_id"] != msg || len(in) != 3 ||
		!strings.Contains(sopStep(child, "worktree")["error"].(string), "准备工作区失败") {
		t.Fatalf("研发 pipeline：input %v object %v worktree %v", in, child["object_id"], sopStep(child, "worktree"))
	}
	if code, out := call(t, e.h, "POST", "/api/sop/runs/"+runID+"/actions", `{"kind":"stop"}`); code != 200 {
		t.Fatalf("终止 %d %v", code, out)
	}
}

// TestIntakeAsksWhenUnsure：分类拿不准 → 阶段待确认项目 → 在原消息串里列候选问提出人 → 等到回复 → 认出项目、绑定 → 设计中。
func TestIntakeAsksWhenUnsure(t *testing.T) {
	e := setupIntake(t)
	e.agent.sure = false
	e.enable(t)
	e.push(t, `{"external_id":"C01:u1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"导出要支持 CSV"}`)
	msg := e.msgID(t, "导出要支持 CSV")
	runID := e.runOf(t, msg)
	e.until(t, runID, "挂在等提出人回复", func(r map[string]any) bool {
		out, _ := sopStep(r, "wait")["output"].(map[string]any)
		return out["waiting"] != nil
	})
	e.stageIs(t, msg, "confirm_project")
	sent := e.fake.Sent()
	if len(sent) != 2 || !strings.Contains(sent[1].Text, "拿不准") || !strings.Contains(sent[1].Text, "Globex（PRJ-0002）") || sent[1].ReplyTo != "C01:u1" {
		t.Fatalf("应在原消息串里问提出人：%+v", sent)
	}
	if o := e.task(t, msg); o.ProjectID != nil {
		t.Fatalf("问之前不该绑项目：%v", *o.ProjectID)
	}
	e.push(t, `{"external_id":"C01:u2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"Acme 的"}`)
	rid := e.recv(t)
	o := e.task(t, msg)
	if o.ProjectID == nil || *o.ProjectID != "obj_acme" || domain.StageOf(o.Props) != "designing" {
		t.Fatalf("回复后应绑 Acme、设计中：%+v %v", o.ProjectID, o.Props)
	}
	run := e.until(t, runID, "", func(map[string]any) bool { return true })
	if sopStep(run, "bind_auto")["status"] != "bypassed" || sopStep(run, "pick")["output"].(map[string]any)["picked"] != "obj_acme。" {
		t.Fatalf("执行：%v / %v", sopStep(run, "bind_auto"), sopStep(run, "pick")["output"])
	}
	if code, out := call(t, e.h, "POST", "/api/sop/runs/"+runID+"/actions", `{"kind":"stop"}`); code != 200 {
		t.Fatalf("终止 %d %v", code, out)
	}
	_ = rid
}

// TestIntakeSkipsNonRequirement：不是需求的消息不建任务、不回执。
func TestIntakeSkipsNonRequirement(t *testing.T) {
	e := setupIntake(t)
	e.enable(t)
	e.push(t, `{"external_id":"C01:n1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"中午一起吃午饭吗"}`)
	msg := e.msgID(t, "中午一起吃午饭吗")
	run := e.until(t, e.runOf(t, msg), "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	if sopStep(run, "is_req")["route"] != "other" || sopStep(run, "to_task")["status"] != "bypassed" || sopStep(run, "skip")["status"] != "done" {
		t.Fatalf("执行：%v", run["steps"])
	}
	_, out := call(t, e.h, "GET", "/api/im/messages/"+msg, "")
	if data(out)["task_id"] != nil || len(e.fake.Sent()) != 0 {
		t.Fatalf("不该建任务、不该回复：%v %+v", data(out)["task_id"], e.fake.Sent())
	}
}

// TestSetTaskStageNodeErrors：设置任务阶段节点的出错口径；转成任务节点对已转过的消息取回原任务。
func TestSetTaskStageNodeErrors(t *testing.T) {
	e := setupIntake(t)
	e.push(t, `{"external_id":"C01:s1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"加个暗色模式"}`)
	msg := e.msgID(t, "加个暗色模式")
	fid := e.flow(t, `{"name":"测","fields":[{"key":"message_id","label":"消息","type":"text"},{"key":"stage","label":"阶段","type":"text"},{"key":"project","label":"项目","type":"text"}],"steps":[
		{"key":"a","name":"转任务","kind":"im_to_task","after":[]},
		{"key":"b","name":"再转一次","kind":"im_to_task"},
		{"key":"c","name":"改阶段","kind":"im_set_task_stage","config":{"stage":"{{stage}}","project":"{{project}}"}}
	]}`)
	run := e.until(t, e.start(t, fid, `{"input":{"message_id":"`+msg+`","stage":"testing","project":"PRJ-0002"}}`), "跑完",
		func(r map[string]any) bool { return r["status"] == "done" || r["status"] == "failed" })
	a := sopStep(run, "a")["output"].(map[string]any)["task"].(map[string]any)
	b := sopStep(run, "b")["output"].(map[string]any)["task"].(map[string]any)
	c := sopStep(run, "c")["output"].(map[string]any)
	if a["id"] != b["id"] || b["reused"] != true || a["stage"] != "received" || c["task"].(map[string]any)["stage"] != "testing" ||
		c["project"].(map[string]any)["id"] != "obj_globex" || c["conversation_id"] != "cv_prod" {
		t.Fatalf("输出：a %v b %v c %v", a, b, c)
	}
	for _, tc := range []struct{ stage, project, want string }{
		{"nope", "", "阶段「nope」不认"},
		{"", "obj_gone", "项目「obj_gone」不存在"},
		{"", "", "没有认出项目"},
	} {
		body := `{"input":{"message_id":"` + msg + `","stage":"` + tc.stage + `","project":"` + tc.project + `"}}`
		run := e.until(t, e.start(t, fid, body), "失败", func(r map[string]any) bool { return r["status"] == "failed" || r["status"] == "done" })
		if errS, _ := sopStep(run, "c")["error"].(string); !strings.Contains(errS, tc.want) {
			t.Fatalf("%v：要 %q，实际 %v", tc, tc.want, sopStep(run, "c"))
		}
	}
}
