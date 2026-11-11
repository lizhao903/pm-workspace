package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// gateClaude 是可控的 Claude Code 执行器：收到请求记下，等测试放行或被取消。
type gateClaude struct {
	got     chan runner.Request
	release chan *runner.Result
	mcp     chan string // 运行中读到的 MCP 配置内容
}

func newGateClaude() *gateClaude {
	return &gateClaude{got: make(chan runner.Request, 4), release: make(chan *runner.Result, 4), mcp: make(chan string, 4)}
}

func (g *gateClaude) Start(ctx context.Context, req runner.Request, _ func(runner.Event)) (*runner.Result, error) {
	if req.MCPConfig != "" {
		b, _ := os.ReadFile(req.MCPConfig)
		g.mcp <- string(b)
	}
	g.got <- req
	select {
	case res := <-g.release:
		return res, nil
	case <-ctx.Done():
		return &runner.Result{Status: domain.RunCanceled, ExitCode: -1, Error: "已取消"}, nil
	}
}

// taskRunStore 记下在任务上建、收尾的执行记录。
type taskRunStore struct {
	artifactStore
	mu       sync.Mutex
	created  []domain.TaskRun
	finished map[string]domain.TaskRun
	prompts  map[string]string
}

func (s *taskRunStore) CreateObject(context.Context, *domain.Object, store.Actor) (*domain.Object, error) {
	return nil, errors.New("不建对象")
}
func (s *taskRunStore) CreateTaskRun(_ context.Context, in *domain.TaskRun) (*domain.TaskRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := *in
	r.ID = "run_task1"
	s.created = append(s.created, r)
	return &r, nil
}
func (s *taskRunStore) FinishTaskRun(_ context.Context, id, status string, exitCode int, output, errMsg string) (*domain.TaskRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished == nil {
		s.finished = map[string]domain.TaskRun{}
	}
	r := domain.TaskRun{ID: id, Status: status, ExitCode: exitCode, Output: output, Error: errMsg}
	s.finished[id] = r
	return &r, nil
}
func (s *taskRunStore) SetTaskRunPrompt(_ context.Context, id, prompt string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.prompts == nil {
		s.prompts = map[string]string{}
	}
	s.prompts[id] = prompt
	return nil
}

func reportEnv(t *testing.T) (*plugin.Registry, *plugintest.Demo, plugin.RunService, *gateClaude) {
	t.Helper()
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)
	installEnable(t, r, "demo")
	g := newGateClaude()
	r.SetClaudeRunner(g)
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.WaitRuns(5 * time.Second) })
	return r, demo, runs, g
}

// TestClaudeRunReport：ReportBack 的运行接上回写 MCP、提示词带回写一节；pmw_finish_run 回报的结论和结构化 result
// 在进程退出后进运行结果和 run.finished；回报只收一次，结束后不收。
func TestClaudeRunReport(t *testing.T) {
	ctx := context.Background()
	r, demo, runs, g := reportEnv(t)
	bin := t.TempDir() + "/pmw-mcp"
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.SetRunCallback(bin, "http://127.0.0.1:7801/")
	r.SetRunPresets(func(_ context.Context, id string) (*runner.Preset, error) {
		switch id {
		case "rp_dev":
			return &runner.Preset{Scene: "研发开发", Content: "跑通测试", Output: "回报 result"}, nil
		case "rp_review":
			return &runner.Preset{Scene: "研发评审", Content: "评审", ReadOnly: true}, nil
		}
		return nil, errors.New("角色不存在")
	})
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", PresetID: "nope"}); err == nil {
		t.Fatal("找不到的预置提示词应当报错")
	}
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "评审 PRD", PresetID: "rp_dev",
		ReportBack: true, Timeout: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	cfg := <-g.mcp
	req := <-g.got
	if req.Timeout != 2*time.Hour || len(req.AllowedTools) != 1 || req.AllowedTools[0] != "mcp__"+plugin.CallbackMCPServer {
		t.Fatalf("请求 = %+v", req)
	}
	if !strings.Contains(req.Prompt, "评审 PRD") || !strings.Contains(req.Prompt, "执行要求（研发开发）") || !strings.Contains(req.Prompt, "输出要求：\n回报 result") ||
		!strings.Contains(req.Prompt, "pmw_finish_run：run_id="+id) || !strings.Contains(req.Prompt, "verdict") {
		t.Fatalf("提示词 = %s", req.Prompt)
	}
	var mc struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(cfg), &mc); err != nil {
		t.Fatal(err)
	}
	if s := mc.MCPServers[plugin.CallbackMCPServer]; s.Command != bin || len(s.Args) != 2 || s.Args[1] != "http://127.0.0.1:7801" {
		t.Fatalf("MCP 配置 = %s", cfg)
	}

	// 只读角色不放开写，即使要了写；FollowPreset 时按角色定（没确认 process:spawn 的放开写会被拦）
	roID, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", PresetID: "rp_review", AllowWrites: true})
	if err != nil {
		t.Fatalf("只读角色要写 = %v", err)
	}
	if ro := <-g.got; ro.AllowWrites || !strings.Contains(ro.Prompt, "这个角色只读") {
		t.Fatalf("只读角色 = %+v", ro)
	}
	if err := runs.Cancel(roID); err != nil {
		t.Fatal(err)
	}
	finished(t, demo, roID)
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", PresetID: "rp_dev", FollowPreset: true}); !errors.Is(err, plugin.ErrNotGranted) {
		t.Fatalf("按角色放开写但没确认 process:spawn = %v", err)
	}
	if _, err := r.ReportRun("run_nope", "done", "", nil); !errors.Is(err, plugin.ErrRunNotFound) {
		t.Fatalf("没有的运行 = %v", err)
	}
	if _, err := r.ReportRun(id, "maybe", "", nil); err == nil {
		t.Fatal("status 不对应当报错")
	}
	res := map[string]any{"verdict": "reject", "issues": []any{"验收标准不可测"}}
	if _, err := r.ReportRun(id, "done", "评审不通过", res); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ReportRun(id, "done", "再报一次", nil); !errors.Is(err, plugin.ErrRunEnded) {
		t.Fatalf("回报两次 = %v", err)
	}
	if info, _ := runs.Get(id); info.Finished || info.Reported != "done" {
		t.Fatalf("回报后还没结束 = %+v", info)
	}
	g.release <- &runner.Result{Status: domain.RunDone, Output: "过程"}
	info := finished(t, demo, id)
	if info.Status != plugin.RunDone || info.Summary != "评审不通过" || info.Result["verdict"] != "reject" {
		t.Fatalf("运行结果 = %+v", info)
	}
	if _, err := r.ReportRun(id, "done", "", nil); !errors.Is(err, plugin.ErrRunEnded) {
		t.Fatalf("结束后回报 = %v", err)
	}
	// 回写用的临时配置跑完就删
	waitFor(t, "临时 MCP 配置删掉", func() bool { _, err := os.Stat(req.MCPConfig); return os.IsNotExist(err) })
}

// TestClaudeRunReportFailed：进程正常结束但回报 failed，整条记失败，原因带回报的摘要。没回报时按退出码。
func TestClaudeRunReportFailed(t *testing.T) {
	ctx := context.Background()
	r, demo, runs, g := reportEnv(t)
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", ReportBack: true})
	if err != nil {
		t.Fatal(err)
	}
	req := <-g.got
	if req.MCPConfig != "" || !strings.Contains(req.Prompt, "没能接上回写用的 MCP") {
		t.Fatalf("没配 MCP 时 = %+v", req)
	}
	if _, err := r.ReportRun(id, "failed", "缺权限", nil); err != nil {
		t.Fatal(err)
	}
	g.release <- &runner.Result{Status: domain.RunDone}
	if info := finished(t, demo, id); info.Status != plugin.RunFailed || !strings.Contains(info.Error, "缺权限") || info.Result != nil {
		t.Fatalf("回报失败 = %+v", info)
	}

	id2, _ := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p"})
	<-g.got
	g.release <- &runner.Result{Status: domain.RunFailed, ExitCode: 2, Error: "退出码 2"}
	if info := finished(t, demo, id2); info.Status != plugin.RunFailed || info.Reported != "" || info.Summary != "" {
		t.Fatalf("没回报 = %+v", info)
	}
}

// TestClaudeRunCancel：Cancel 取消在跑的 Claude Code 运行，结果记取消；别的插件、别的种类的运行不能取消。
func TestClaudeRunCancel(t *testing.T) {
	ctx := context.Background()
	_, demo, runs, g := reportEnv(t)
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	<-g.got
	if err := runs.Cancel("run_nope"); !errors.Is(err, plugin.ErrRunNotFound) {
		t.Fatalf("没有的运行 = %v", err)
	}
	if err := runs.Cancel(id); err != nil {
		t.Fatal(err)
	}
	if info := finished(t, demo, id); info.Status != plugin.RunCanceled || info.OK {
		t.Fatalf("取消后 = %+v", info)
	}
	// 结束了再取消不报错
	if err := runs.Cancel(id); err != nil {
		t.Fatalf("结束后取消 = %v", err)
	}
}

// TestClaudeRunOnTask：RecordOnTask 在任务上建执行记录，运行 id 就是记录 id；跑完收尾记录，回报的摘要放在输出前面，产物挂到记录上。
func TestClaudeRunOnTask(t *testing.T) {
	ctx := context.Background()
	r, demo, runs, g := reportEnv(t)
	st := &taskRunStore{}
	r.SetObjectCreator(st)
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "p", ObjectID: "obj_task", RecordOnTask: true, ReportBack: true})
	if err != nil {
		t.Fatal(err)
	}
	if id != "run_task1" {
		t.Fatalf("运行 id = %s，要用任务执行记录的 id", id)
	}
	req := <-g.got
	if !strings.Contains(req.Prompt, "关联任务 obj_task") && !strings.Contains(req.Prompt, "没能接上") {
		t.Fatalf("提示词 = %s", req.Prompt)
	}
	if _, err := r.ReportRun(id, "done", "做完了", map[string]any{"verdict": "pass"}); err != nil {
		t.Fatal(err)
	}
	g.release <- &runner.Result{Status: domain.RunDone, Output: "过程"}
	if info := finished(t, demo, id); !info.TaskRun || info.Status != plugin.RunDone {
		t.Fatalf("运行 = %+v", info)
	}
	waitFor(t, "任务执行记录收尾", func() bool {
		st.mu.Lock()
		defer st.mu.Unlock()
		_, ok := st.finished[id]
		return ok
	})
	st.mu.Lock()
	defer st.mu.Unlock()
	if c := st.created[0]; c.ObjectID != "obj_task" || c.Mode != domain.RunModeStream || c.Status != domain.RunRunning {
		t.Fatalf("建的记录 = %+v", c)
	}
	if f := st.finished[id]; f.Status != domain.RunDone || !strings.HasPrefix(f.Output, "做完了") || !strings.Contains(f.Output, "过程") {
		t.Fatalf("收尾 = %+v", f)
	}
	if !strings.Contains(st.prompts[id], "run_task1") {
		t.Fatalf("记录的提示词 = %s", st.prompts[id])
	}
}

func TestClaudeRunSelectedExecutor(t *testing.T) {
	r, _, runs, g := reportEnv(t)
	r.SetRunExecutors(func(_ context.Context, id string) (runner.Request, error) {
		if id != "cx" {
			return runner.Request{}, errors.New("执行器不存在")
		}
		return runner.Request{Harness: runner.HarnessCodex, CodexBin: "/custom/codex"}, nil
	})
	if _, err := runs.StartClaudeCode(context.Background(), plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "test", ExecutorID: "deleted"}); err == nil {
		t.Fatal("missing executor accepted")
	}
	id, err := runs.StartClaudeCode(context.Background(), plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "test", ExecutorID: "cx", Timeout: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case req := <-g.got:
		if req.Harness != runner.HarnessCodex || req.CodexBin != "/custom/codex" || req.Timeout != time.Minute || req.RunID != id || req.AllowWrites {
			t.Fatalf("%+v", req)
		}
	case <-time.After(time.Second):
		t.Fatal("executor not started")
	}
	g.release <- &runner.Result{Status: domain.RunDone}
}
