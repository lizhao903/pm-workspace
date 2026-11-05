package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 任务交给工作台 Agent 执行（TSK-0460）：假 Ollama 按剧本回工具调用，验正常完成、确认、拒绝、超时、超限、服务商不可用。

type agentRunFixture struct {
	r     *connRec
	st    *sqlite.Store
	up    *grantUpstream
	agent string
	task  string
	ref   string
}

func newAgentRunFixture(t *testing.T, grants string) *agentRunFixture {
	t.Helper()
	r, st, up := newGrantServer(t)
	r.s.agentTimeUnit = 40 * time.Millisecond
	r.s.agentSvc.RetryDelays = []time.Duration{time.Millisecond}
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"执行助手","provider_id":"`+pid+`"}`, http.StatusCreated)
	id := ag["id"].(string)
	r.call("PUT", "/api/agents/"+id+"/grants", `{"grants":`+grants+`}`, http.StatusOK)
	task := r.call("POST", "/api/objects", `{"type_id":"task","title":"整理竞品清单","body":"列出三家竞品"}`, http.StatusCreated)
	return &agentRunFixture{r: r, st: st, up: up, agent: id, task: task["id"].(string), ref: task["ref"].(string)}
}

func (f *agentRunFixture) run(t *testing.T, body string) []map[string]any {
	t.Helper()
	w := do(f.r.s, "POST", "/api/objects/"+f.task+"/run", body)
	mustCode(t, w, http.StatusOK, "run "+w.Body.String())
	return sse(t, w.Body.String())
}

func (f *agentRunFixture) taskRun(t *testing.T, id string) *domain.TaskRun {
	t.Helper()
	run, err := f.st.GetTaskRun(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func (f *agentRunFixture) progress(t *testing.T) []string {
	t.Helper()
	list, err := f.st.ListProgress(context.Background(), f.task, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, p := range list {
		out = append(out, p.Text)
	}
	return out
}

func lastEvent(evs []map[string]any, typ string) map[string]any {
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i]["type"] == typ {
			return evs[i]
		}
	}
	return nil
}

func TestAgentRunDone(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto","write_tasks":"auto"}`)
	ctx := context.Background()
	f.up.push(
		toolCallLine("get_object", `{"ref":"`+f.ref+`"}`),
		toolCallLine("append_progress", `{"ref":"`+f.ref+`","text":"读完了任务"}`),
		toolCallLine("create_object", `{"type_id":"task","title":"调研竞品 A","parent_ref":"`+f.ref+`"}`),
		toolCallLine("update_object", `{"ref":"`+f.ref+`","status":"done"}`),
		`{"message":{"role":"assistant","content":"结论：建了子任务，任务已完成。"},"done":true}`,
	)
	evs := f.run(t, `{"harness":"agent","agent_id":"`+f.agent+`","extra_prompt":"先拆子任务"}`)

	start := findEvent(evs, "start")
	if start == nil || start["session_id"] == "" || start["run_id"] == "" {
		t.Fatalf("start 事件：%v", evs)
	}
	done := lastEvent(evs, "done")
	if done == nil || done["exit_code"].(float64) != 0 || findEvent(evs, "error") != nil {
		t.Fatalf("应正常完成：%v", evs)
	}
	if tool := findEvent(evs, "tool"); tool == nil || tool["name"] != "get_object" || tool["id"] == "" {
		t.Fatalf("tool 事件：%v", evs)
	}
	if tr := findEvent(evs, "tool_result"); tr == nil || tr["ok"] != true || tr["summary"] == "" || tr["id"] != findEvent(evs, "tool")["id"] {
		t.Fatalf("tool_result 事件：%v", evs)
	}
	// 无人值守：不给 ask_user
	if tools := f.up.lastTools(); hasStr(tools, "ask_user") || !hasStr(tools, "append_progress") {
		t.Fatalf("给模型的工具 = %v", tools)
	}

	run := f.taskRun(t, start["run_id"].(string))
	sid := start["session_id"].(string)
	if run.Harness != domain.RunHarnessAgent || run.HarnessSession != sid || run.Status != domain.RunDone ||
		!strings.Contains(run.Output, "[工具] create_object") || !strings.Contains(run.Prompt, "先拆子任务") || !strings.Contains(run.Prompt, "整理竞品清单") {
		t.Fatalf("执行记录 = %+v", run)
	}
	// 会话：全局、挂 Agent、来源标出任务
	sess, err := f.st.GetAgentSession(ctx, sid)
	if err != nil || sess.ObjectID != nil || sess.AgentID == nil || *sess.AgentID != f.agent ||
		sess.SourceRef["kind"] != "task_run" || sess.SourceRef["object_id"] != f.task || sess.SourceRef["run_id"] != run.ID {
		t.Fatalf("会话 = %+v %v", sess, err)
	}
	// 子任务挂到父任务下
	links, _ := f.st.ListLinks(ctx, f.task)
	if len(links) != 1 || links[0].Relation != domain.RelParent {
		t.Fatalf("父子关联 = %+v", links)
	}
	obj, _ := f.st.GetObject(ctx, f.task)
	if obj.Status != "done" {
		t.Fatalf("任务状态 = %s", obj.Status)
	}
	prog := strings.Join(f.progress(t), "\n")
	if !strings.Contains(prog, "读完了任务") || !strings.Contains(prog, "执行完成") || !strings.Contains(prog, "结论：建了子任务") {
		t.Fatalf("进展 = %s", prog)
	}

	// 续跑：用同一个会话
	f.up.push(`{"message":{"role":"assistant","content":"续跑看过了，没什么要做的。"},"done":true}`)
	evs = f.run(t, `{"harness":"agent","resume_session":true}`)
	if s2 := findEvent(evs, "start"); s2 == nil || s2["session_id"] != sid {
		t.Fatalf("续跑应续用会话 %s：%v", sid, evs)
	}
	if !strings.Contains(f.taskRun(t, findEvent(evs, "start")["run_id"].(string)).Prompt, "接着上次的执行") {
		t.Fatal("续跑的提示词应说明是接着上次")
	}
}

func TestAgentRunRejectsBadRequests(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto"}`)
	// 没有可续的会话
	w := do(f.r.s, "POST", "/api/objects/"+f.task+"/run", `{"harness":"agent","resume_session":true}`)
	mustCode(t, w, http.StatusBadRequest, "resume without session")
	if !strings.Contains(w.Body.String(), "可续") {
		t.Fatalf("原因 = %s", w.Body.String())
	}
	mustCode(t, do(f.r.s, "POST", "/api/objects/"+f.task+"/run", `{"harness":"agent","max_steps":500}`), http.StatusBadRequest, "max_steps out of range")
	mustCode(t, do(f.r.s, "POST", "/api/objects/"+f.task+"/run", `{"harness":"agent","agent_id":"ag_nope"}`), http.StatusNotFound, "missing agent")
	mustCode(t, do(f.r.s, "POST", "/api/objects/"+f.task+"/run", `{"harness":"agent","provider_id":"prv_nope"}`), http.StatusNotFound, "missing provider")
	mustCode(t, do(f.r.s, "POST", "/api/objects/"+f.task+"/run", `{"harness":"robot"}`), http.StatusBadRequest, "bad harness")
	// 没指定 Agent：用第一个启用的
	evs := f.run(t, `{"harness":"agent"}`)
	if lastEvent(evs, "done") == nil {
		t.Fatalf("默认 Agent：%v", evs)
	}
}

func TestAgentRunReadOnlyRole(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto","write_tasks":"auto","write_content":"auto"}`)
	evs := f.run(t, `{"harness":"agent","preset_id":"rp_classify"}`)
	if lastEvent(evs, "done") == nil {
		t.Fatalf("只读角色：%v", evs)
	}
	tools := f.up.lastTools()
	if hasStr(tools, "update_object") || hasStr(tools, "append_progress") || hasStr(tools, "write_file") || !hasStr(tools, "get_object") {
		t.Fatalf("只读角色给模型的工具 = %v", tools)
	}
}

func TestAgentRunStepBudget(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto"}`)
	for range 5 {
		f.up.push(toolCallLine("get_object", `{"ref":"`+f.ref+`"}`))
	}
	evs := f.run(t, `{"harness":"agent","max_steps":2}`)
	done := lastEvent(evs, "done")
	er := findEvent(evs, "error")
	if done == nil || done["exit_code"].(float64) != 1 || er == nil || !strings.Contains(er["message"].(string), "步数上限（2 步）") {
		t.Fatalf("超步数应失败：%v", evs)
	}
	run := f.taskRun(t, findEvent(evs, "start")["run_id"].(string))
	if run.Status != domain.RunFailed || !strings.Contains(run.Error, "步数上限") {
		t.Fatalf("执行记录 = %+v", run)
	}
	if prog := strings.Join(f.progress(t), "\n"); !strings.Contains(prog, "执行失败") || !strings.Contains(prog, "步数上限") {
		t.Fatalf("失败也要记进展：%s", prog)
	}
}

func TestAgentRunProviderUnavailable(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto"}`)
	ctx := context.Background()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusServiceUnavailable)
	}))
	t.Cleanup(down.Close)
	p, err := f.st.CreateProvider(ctx, &domain.AgentProvider{Name: "挂了的", Kind: domain.ProviderOllama, BaseURL: down.URL, Model: "m", Enabled: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	evs := f.run(t, `{"harness":"agent","provider_id":"`+p.ID+`"}`)
	er := findEvent(evs, "error")
	if er == nil || !strings.Contains(er["message"].(string), "服务商不可用") || !strings.Contains(er["message"].(string), "挂了的") {
		t.Fatalf("服务商不可用应失败并写明：%v", evs)
	}
	if run := f.taskRun(t, findEvent(evs, "start")["run_id"].(string)); run.Status != domain.RunFailed {
		t.Fatalf("执行记录 = %+v", run)
	}
}

// liveRun 用真 HTTP 连接读流：等确认时 handler 挂着，测试要一边读事件一边去点确认。
type liveRun struct {
	evs  chan map[string]any
	done chan struct{}
}

func startLiveRun(t *testing.T, ts *httptest.Server, objID, body string) *liveRun {
	t.Helper()
	resp, err := http.Post(ts.URL+"/api/objects/"+objID+"/run", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("run = %d", resp.StatusCode)
	}
	lr := &liveRun{evs: make(chan map[string]any, 100), done: make(chan struct{})}
	go func() {
		defer close(lr.done)
		defer func() { _ = resp.Body.Close() }()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) == nil {
				lr.evs <- ev
			}
		}
		close(lr.evs)
	}()
	return lr
}

// until 读到 typ 事件为止，回读过的全部事件。
func (lr *liveRun) until(t *testing.T, typ string) []map[string]any {
	t.Helper()
	var got []map[string]any
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-lr.evs:
			if !ok {
				t.Fatalf("没等到 %s，流就结束了：%v", typ, got)
			}
			got = append(got, ev)
			if ev["type"] == typ {
				return got
			}
		case <-timeout:
			t.Fatalf("等 %s 超时：%v", typ, got)
		}
	}
}

func TestAgentRunConfirmRejectTimeout(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto","write_tasks":"confirm"}`)
	ctx := context.Background()
	ts := httptest.NewServer(f.r.s)
	t.Cleanup(ts.Close)

	// 1. 确认：停下等、记录是 waiting；确认后执行、接着跑完
	f.up.push(toolCallLine("update_object", `{"ref":"`+f.ref+`","priority":"P0"}`),
		`{"message":{"role":"assistant","content":"改好了优先级。"},"done":true}`)
	lr := startLiveRun(t, ts, f.task, `{"harness":"agent","agent_id":"`+f.agent+`"}`)
	evs := lr.until(t, "confirm")
	runID := findEvent(evs, "start")["run_id"].(string)
	cf := lastEvent(evs, "confirm")
	if cf["name"] != "update_object" || cf["deadline"] == "" || cf["summary"] == "" {
		t.Fatalf("confirm 事件 = %v", cf)
	}
	if run := f.taskRun(t, runID); run.Status != domain.RunWaiting {
		t.Fatalf("等确认时状态 = %s", run.Status)
	}
	if obj, _ := f.st.GetObject(ctx, f.task); obj.Priority == "P0" {
		t.Fatal("确认前就执行了")
	}
	w := do(f.r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/confirm", "")
	mustCode(t, w, http.StatusOK, "confirm")
	if findEvent(sse(t, w.Body.String()), "done") == nil {
		t.Fatalf("确认接口应回 done：%s", w.Body.String())
	}
	evs = lr.until(t, "done")
	<-lr.done
	if d := findEvent(evs, "decision"); d == nil || d["approved"] != true || d["reason"] != "user" {
		t.Fatalf("decision 事件：%v", evs)
	}
	if obj, _ := f.st.GetObject(ctx, f.task); obj.Priority != "P0" {
		t.Fatalf("确认后没执行：%s", obj.Priority)
	}
	if run := f.taskRun(t, runID); run.Status != domain.RunDone || !strings.Contains(run.Output, "[等待确认]") || !strings.Contains(run.Output, "[已确认]") {
		t.Fatalf("执行记录 = %+v", run)
	}
	mustCode(t, do(f.r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/confirm", ""), http.StatusConflict, "confirm twice")

	// 2. 拒绝：不执行，Agent 收尾
	f.up.push(toolCallLine("update_object", `{"ref":"`+f.ref+`","priority":"P3"}`),
		`{"message":{"role":"assistant","content":"那就不改了。"},"done":true}`)
	lr = startLiveRun(t, ts, f.task, `{"harness":"agent"}`)
	cf = lastEvent(lr.until(t, "confirm"), "confirm")
	mustCode(t, do(f.r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/reject", ""), http.StatusOK, "reject")
	evs = lr.until(t, "done")
	<-lr.done
	if d := findEvent(evs, "decision"); d == nil || d["approved"] != false {
		t.Fatalf("decision 事件：%v", evs)
	}
	if obj, _ := f.st.GetObject(ctx, f.task); obj.Priority != "P0" {
		t.Fatalf("拒绝后不该执行：%s", obj.Priority)
	}
	if tc, _ := f.st.GetAgentToolCall(ctx, cf["id"].(string)); tc.State != "rejected" {
		t.Fatalf("调用记录 = %+v", tc)
	}

	// 3. 等待超时按拒绝（confirm_wait_minutes=1，测试里一分钟是 40ms）
	f.up.push(toolCallLine("update_object", `{"ref":"`+f.ref+`","priority":"P2"}`),
		`{"message":{"role":"assistant","content":"没等到确认，先不改。"},"done":true}`)
	lr = startLiveRun(t, ts, f.task, `{"harness":"agent","confirm_wait_minutes":1}`)
	evs = lr.until(t, "done")
	<-lr.done
	cf = findEvent(evs, "confirm")
	if d := findEvent(evs, "decision"); d == nil || d["approved"] != false || d["reason"] != "timeout" {
		t.Fatalf("超时 decision：%v", evs)
	}
	if tc, _ := f.st.GetAgentToolCall(ctx, cf["id"].(string)); tc.State != "rejected" || !strings.Contains(tc.Result, "超时") {
		t.Fatalf("超时的调用记录 = %+v", tc)
	}
	if obj, _ := f.st.GetObject(ctx, f.task); obj.Priority != "P0" {
		t.Fatalf("超时后不该执行：%s", obj.Priority)
	}
	if run := f.taskRun(t, findEvent(evs, "start")["run_id"].(string)); run.Status != domain.RunDone {
		t.Fatalf("超时按拒绝后接着收尾：%+v", run)
	}

	// 4. 等确认时取消：记录 canceled，待确认的调用被拒掉
	f.up.push(toolCallLine("update_object", `{"ref":"`+f.ref+`","priority":"P1"}`))
	lr = startLiveRun(t, ts, f.task, `{"harness":"agent","confirm_wait_minutes":60}`)
	evs = lr.until(t, "confirm")
	runID = findEvent(evs, "start")["run_id"].(string)
	callID := lastEvent(evs, "confirm")["id"].(string)
	mustCode(t, do(f.r.s, "POST", "/api/runs/"+runID+"/cancel", ""), http.StatusOK, "cancel")
	lr.until(t, "done")
	<-lr.done
	if run := f.taskRun(t, runID); run.Status != domain.RunCanceled {
		t.Fatalf("取消后 = %+v", run)
	}
	if tc, _ := f.st.GetAgentToolCall(ctx, callID); tc.State != "rejected" {
		t.Fatalf("取消后待确认的调用 = %+v", tc)
	}
}

func TestAgentRunDurationBudget(t *testing.T) {
	f := newAgentRunFixture(t, `{"read_tasks":"auto"}`)
	f.up.delay = 150 * time.Millisecond
	for range 5 {
		f.up.push(toolCallLine("get_object", `{"ref":"`+f.ref+`"}`))
	}
	// 一分钟是 40ms，max_minutes=2 即 80ms，第一步就超
	evs := f.run(t, `{"harness":"agent","max_minutes":2}`)
	er := findEvent(evs, "error")
	if er == nil || !strings.Contains(er["message"].(string), "时长上限（2 分钟）") {
		t.Fatalf("超时长应失败：%v", evs)
	}
}
