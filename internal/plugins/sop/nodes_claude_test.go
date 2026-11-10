// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	clauderun "github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// Claude Code 节点测试（AUTO-01）：等运行结束后继续、结构化结论给下游分支、失败重试、终止取消、超时。

func init() {
	claudePoll = 10 * time.Millisecond
}

// fakeClaude 是可控的 Claude Code：收到请求记下，按 results 依次回结果（没有就一直等），被取消时记一笔。
type fakeClaude struct {
	mu       sync.Mutex
	reqs     []clauderun.Request
	canceled []string
	results  chan *clauderun.Result
	started  chan string
}

func newFakeClaude() *fakeClaude {
	return &fakeClaude{results: make(chan *clauderun.Result, 8), started: make(chan string, 8)}
}

func (f *fakeClaude) Start(ctx context.Context, req clauderun.Request, _ func(clauderun.Event)) (*clauderun.Result, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	f.mu.Unlock()
	f.started <- req.RunID
	select {
	case res := <-f.results:
		return res, nil
	case <-ctx.Done():
		f.mu.Lock()
		f.canceled = append(f.canceled, req.RunID)
		f.mu.Unlock()
		return &clauderun.Result{Status: domain.RunCanceled, ExitCode: -1, Error: "已取消"}, nil
	}
}

func (f *fakeClaude) req(i int) clauderun.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[i]
}

func (f *fakeClaude) wasCanceled(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.canceled {
		if c == id {
			return true
		}
	}
	return false
}

func recvRun(t *testing.T, f *fakeClaude) string {
	t.Helper()
	select {
	case id := <-f.started:
		return id
	case <-time.After(5 * time.Second):
		t.Fatal("等了 5 秒 Claude Code 还没被发起")
		return ""
	}
}

func setupClaude(t *testing.T) (*plugin.Registry, http.Handler, *fakeClaude, string) {
	t.Helper()
	r, h := setup(t, New())
	f := newFakeClaude()
	r.SetClaudeRunner(f)
	bin := t.TempDir() + "/pmw-mcp"
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.SetRunCallback(bin, "http://127.0.0.1:7801")
	t.Cleanup(func() { r.WaitRuns(5 * time.Second) })
	return r, h, f, t.TempDir()
}

func claudeFlow(wd, extra string) string {
	return fmt.Sprintf(`{"name":"评审","fields":[{"key":"topic","label":"主题","type":"text"},{"key":"dir","label":"目录","type":"text"}],"steps":[
		{"key":"review","name":"研发评审","kind":"claude_code","after":[],"config":{"workdir":"{{dir}}","prompt":"评审 {{topic}}"%s}},
		{"key":"d","name":"通过吗","kind":"decide","after":["review"],"rule":"result.verdict 等于 reject","cases":[{"key":"no","label":"不通过"},{"key":"yes","label":"通过"}]},
		{"key":"back","name":"退回","kind":"template","branch":{"of":"d","case":"no"},"config":{"template":"要改：{{result.issues[0]}}","output":"text"}},
		{"key":"go","name":"往下走","kind":"template","branch":{"of":"d","case":"yes"},"config":{"template":"ok","output":"text"}}
	]}`, extra)
}

// TestClaudeNodeWaitsAndBranches：节点发起 Claude Code 后停在 running 等它结束；pmw_finish_run 回报的 result 进输出，
// 下游条件分支按 result.verdict 走；提示词按输入渲染、带回写一节，超时默认 2 小时、只读。
func TestClaudeNodeWaitsAndBranches(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, claudeFlow(wd, ""))
	run := startRun(t, h, fid, fmt.Sprintf(`{"input":{"topic":"登录 PRD","dir":%q}}`, wd))
	id := run["id"].(string)
	rid := recvRun(t, f)
	req := f.req(0)
	if req.Workdir != wd || !strings.HasPrefix(req.Prompt, "评审 登录 PRD") || !strings.Contains(req.Prompt, "pmw_finish_run") ||
		req.Timeout != 2*time.Hour || req.AllowWrites {
		t.Fatalf("请求 = %+v", req)
	}
	var s map[string]any
	waitFor(t, "步骤记下运行 id", func() bool {
		s = step(getRun(t, h, id), "review")
		c, _ := s["claude"].(map[string]any)
		return c != nil && c["run_id"] == rid
	})
	if s["status"] != stRunning || !hasLog(s, "交给 Claude Code") {
		t.Fatalf("等待中 = %v", s)
	}
	if _, err := r.ReportRun(rid, "done", "两处要改", map[string]any{"verdict": "reject", "issues": []any{"验收标准不可测"}}); err != nil {
		t.Fatal(err)
	}
	f.results <- &clauderun.Result{Status: domain.RunDone, Output: "过程"}
	got := waitStatus(t, h, id, "done")
	s = step(got, "review")
	out := s["output"].(map[string]any)
	res, _ := out["result"].(map[string]any)
	if out["status"] != "done" || out["summary"] != "两处要改" || out["run_id"] != rid || res["verdict"] != "reject" || out["topic"] != "登录 PRD" {
		t.Fatalf("输出 = %v", out)
	}
	if !hasLog(s, "回报结论 reject") {
		t.Fatalf("日志 = %v", s["log"])
	}
	if step(got, "d")["route"] != "no" || step(got, "go")["status"] != stBypassed {
		t.Fatalf("分支 = %v / %v", step(got, "d"), step(got, "go"))
	}
	if txt := step(got, "back")["output"].(map[string]any)["text"]; txt != "要改：验收标准不可测" {
		t.Fatalf("下游 = %v", txt)
	}
}

// TestClaudeNodeNoReport：没回报时 result 为空、摘要取过程记录末尾，条件分支按「不成立」走。
func TestClaudeNodeNoReport(t *testing.T) {
	_, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, claudeFlow(wd, ""))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"topic":"x","dir":%q}}`, wd))["id"].(string)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone, Output: "写好了"}
	got := waitStatus(t, h, id, "done")
	out := step(got, "review")["output"].(map[string]any)
	if out["result"] != nil || out["summary"] != "写好了" || step(got, "d")["route"] != "yes" {
		t.Fatalf("没回报 = %v，分支 %v", out, step(got, "d")["route"])
	}
}

// TestClaudeNodeFailRetryStop：执行失败步骤失败、重试会重新发起；终止执行取消在跑的那次。
func TestClaudeNodeFailRetryStop(t *testing.T) {
	_, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, claudeFlow(wd, `,"permission":"read","timeout":"30 分钟"`))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"topic":"x","dir":%q}}`, wd))["id"].(string)
	first := recvRun(t, f)
	if f.req(0).Timeout != 30*time.Minute {
		t.Fatalf("超时 = %v", f.req(0).Timeout)
	}
	f.results <- &clauderun.Result{Status: domain.RunFailed, ExitCode: 1, Error: "退出码 1"}
	got := waitStatus(t, h, id, "failed")
	if e := step(got, "review")["error"].(string); !strings.Contains(e, "Claude Code 执行失败") || !strings.Contains(e, "退出码 1") {
		t.Fatalf("失败原因 = %s", e)
	}
	if code, out := act(t, h, id, `{"kind":"retry","step":"review"}`); code != 200 {
		t.Fatalf("重试 %d %s", code, errMsg(out))
	}
	second := recvRun(t, f)
	if second == first {
		t.Fatal("重试应当重新发起一次")
	}
	if code, out := act(t, h, id, `{"kind":"stop"}`); code != 200 {
		t.Fatalf("终止 %d %s", code, errMsg(out))
	}
	waitFor(t, "终止后取消那次运行", func() bool { return f.wasCanceled(second) })
}

// TestClaudeNodeTimeout：超过配置的超时（加宽限）还没收尾，SOP 取消这次运行、步骤失败。
func TestClaudeNodeTimeout(t *testing.T) {
	old := claudeGrace
	claudeGrace = 0
	t.Cleanup(func() { claudeGrace = old })
	_, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, claudeFlow(wd, `,"timeout":"1 秒"`))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"topic":"x","dir":%q}}`, wd))["id"].(string)
	rid := recvRun(t, f)
	got := waitStatus(t, h, id, "failed")
	if e := step(got, "review")["error"].(string); !strings.Contains(e, "超时") {
		t.Fatalf("失败原因 = %s", e)
	}
	waitFor(t, "超时取消那次运行", func() bool { return f.wasCanceled(rid) })
}

// TestClaudeNodeBadInput：工作目录取不到、可写没确认权限时步骤失败，不发起。
func TestClaudeNodeBadInput(t *testing.T) {
	_, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, claudeFlow(wd, ""))
	id := startRun(t, h, fid, `{"input":{"topic":"x","dir":""}}`)["id"].(string)
	got := waitStatus(t, h, id, "failed")
	if e := step(got, "review")["error"].(string); !strings.Contains(e, "工作目录是空的") || !strings.Contains(e, "{{dir}}") {
		t.Fatalf("失败原因 = %s", e)
	}
	select {
	case <-f.started:
		t.Fatal("不该发起")
	default:
	}
}

// TestClaudeNodeCheck：保存时检查权限、超时写法。
func TestClaudeNodeCheck(t *testing.T) {
	_, h, _, wd := setupClaude(t)
	code, out := call(t, h, "POST", "/api/sop/flows", claudeFlow(wd, `,"permission":"admin","timeout":"永远"`))
	if code != 400 || !strings.Contains(errMsg(out), "权限只能是") {
		t.Fatalf("%d %v", code, out)
	}
	code, out = call(t, h, "POST", "/api/sop/flows", claudeFlow(wd, `,"timeout":"永远"`))
	if code != 400 || !strings.Contains(fmt.Sprint(out), "超时") {
		t.Fatalf("%d %v", code, out)
	}
}

// taskRuns 是在任务上建执行记录的假 store。
type taskRuns struct {
	mu      sync.Mutex
	created []domain.TaskRun
}

func (s *taskRuns) CreateObject(context.Context, *domain.Object, store.Actor) (*domain.Object, error) {
	return nil, errors.New("不建对象")
}
func (s *taskRuns) CreateTaskRun(_ context.Context, in *domain.TaskRun) (*domain.TaskRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := *in
	r.ID = fmt.Sprintf("run_t%d", len(s.created)+1)
	s.created = append(s.created, r)
	return &r, nil
}
func (s *taskRuns) FinishTaskRun(context.Context, string, string, int, string, string) (*domain.TaskRun, error) {
	return &domain.TaskRun{}, nil
}
func (s *taskRuns) SetTaskRunPrompt(context.Context, string, string) error { return nil }

// TestClaudeNodeOnTask：配了关联任务时在任务上留执行记录，步骤记下任务 id，界面据此跳到那次执行。
func TestClaudeNodeOnTask(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	st := &taskRuns{}
	r.SetObjectCreator(st)
	fid := newFlow(t, h, claudeFlow(wd, `,"task":"{{task_id}}"`))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"topic":"x","dir":%q,"task_id":"obj_t1"}}`, wd))["id"].(string)
	rid := recvRun(t, f)
	if rid != "run_t1" {
		t.Fatalf("运行 id = %s", rid)
	}
	var c map[string]any
	waitFor(t, "步骤记下任务", func() bool {
		s := step(getRun(t, h, id), "review")
		c, _ = s["claude"].(map[string]any)
		if c == nil {
			t.Logf("%v", s)
		}
		return c != nil
	})
	if c["task_id"] != "obj_t1" || c["workdir"] != wd {
		t.Fatalf("claude = %v", c)
	}
	st.mu.Lock()
	if st.created[0].ObjectID != "obj_t1" {
		t.Fatalf("执行记录 = %+v", st.created[0])
	}
	st.mu.Unlock()
	f.results <- &clauderun.Result{Status: domain.RunDone}
	waitStatus(t, h, id, "done")
}

// TestClaudeNodeLoopback：评审（Claude Code）回报 reject，条件回退退回研发（Claude Code）重做，研发的提示词里带上一轮的意见；
// 第二轮评审 pass 后往下走（AUTO-01 + AUTO-02）。
func TestClaudeNodeLoopback(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	fid := newFlow(t, h, fmt.Sprintf(`{"name":"研发闭环","fields":[{"key":"dir","label":"目录","type":"text"}],"steps":[
		{"key":"dev","name":"研发","kind":"claude_code","after":[],"config":{"workdir":"{{dir}}","prompt":"实现需求"}},
		{"key":"rv","name":"评审","kind":"claude_code","after":["dev"],"config":{"workdir":"{{dir}}","prompt":"评审改动"}},
		{"key":"gate","name":"不通过退回研发","kind":"loopback","after":["rv"],"rule":"result.verdict 等于 reject","config":{"target":"dev"},
			"cases":[{"key":"pass","label":"通过"},{"key":"over","label":"超限"}]},
		{"key":"end","name":"结束","kind":"end","after":["gate"],"branch":{"of":"gate","case":"pass"}}
	]}`))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q}}`, wd))["id"].(string)
	finish := func(verdict string) {
		rid := recvRun(t, f)
		if _, err := r.ReportRun(rid, "done", "意见："+verdict, map[string]any{"verdict": verdict, "issues": []any{"缺单测"}}); err != nil {
			t.Fatal(err)
		}
		f.results <- &clauderun.Result{Status: domain.RunDone}
	}
	finish("pass")       // 研发第 1 轮
	finish("reject")     // 评审第 1 轮
	rid := recvRun(t, f) // 研发第 2 轮
	f.mu.Lock()
	p := f.reqs[len(f.reqs)-1].Prompt
	f.mu.Unlock()
	if !strings.Contains(p, "上一轮被退回（这是第 2 轮）") || !strings.Contains(p, "缺单测") || !strings.Contains(p, "意见：reject") {
		t.Fatalf("第 2 轮提示词 = %s", p)
	}
	if _, err := r.ReportRun(rid, "done", "补了单测", map[string]any{"verdict": "pass"}); err != nil {
		t.Fatal(err)
	}
	f.results <- &clauderun.Result{Status: domain.RunDone}
	finish("pass") // 评审第 2 轮
	run := waitStatus(t, h, id, "done")
	if g := step(run, "gate"); g["route"] != "pass" || g["loops"] != float64(1) {
		t.Fatalf("回退节点 = %v", g)
	}
	if d := step(run, "dev"); d["round"] != float64(2) || d["attempts"] != float64(2) {
		t.Fatalf("研发 = %v", d)
	}
	// 第 2 轮评审输入里透传着 feedback，但不是退给它的，提示词里不附退回意见
	f.mu.Lock()
	last := f.reqs[len(f.reqs)-1].Prompt
	f.mu.Unlock()
	if !strings.HasPrefix(last, "评审改动") || strings.Contains(last, "上一轮被退回") {
		t.Fatalf("第 2 轮评审提示词 = %s", last)
	}
}
