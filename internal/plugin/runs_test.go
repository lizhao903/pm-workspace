package plugin_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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

// runAgent 是假的模型和 Agent：RunAgent 等 gate 关上（nil 不等）再回一条回复。
type runAgent struct {
	gate chan struct{}
	mu   sync.Mutex
	got  []plugin.AgentRunRequest
}

func (a *runAgent) Complete(context.Context, plugin.CompleteRequest) (string, error) { return "", nil }
func (a *runAgent) RunAgent(_ context.Context, q plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	if a.gate != nil {
		<-a.gate
	}
	a.mu.Lock()
	a.got = append(a.got, q)
	a.mu.Unlock()
	return plugin.AgentRunResult{SessionID: "ags_1", Reply: "整理好了：" + q.Prompt}, nil
}
func (a *runAgent) AgentState(context.Context, string) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, nil
}
func (a *runAgent) SearchKB(context.Context, []string, string, int) ([]plugin.KBHit, error) {
	return nil, nil
}

// sopEngine 是假的 SOP 插件：发起后在后台把执行推到 done；flow 为 fast 时在返回前就推完。
type sopEngine struct{ c plugin.Core }

func (s *sopEngine) StartSOP(ctx context.Context, q plugin.SOPStartRequest) (*plugin.SOPStarted, error) {
	id := "spr_" + q.FlowID
	pub := func(from, to string) {
		_ = s.c.Events().Publish(ctx, "sop.run_status_changed", map[string]any{"run_id": id, "from": from, "to": to})
	}
	pub("", "running")
	if q.FlowID == "fast" {
		pub("running", "done")
	} else {
		go func() {
			time.Sleep(5 * time.Millisecond)
			pub("running", "failed")
		}()
	}
	return &plugin.SOPStarted{RunID: id, FlowID: q.FlowID, Status: "running"}, nil
}

func sopPlugin(t *testing.T) *fakePlugin {
	e := &sopEngine{}
	return &fakePlugin{m: manifest(t, "sop", `,"provides":{"modules":["sop"]},"emits":["sop.run_status_changed"]`),
		reg: func(r plugin.Registrar) error {
			e.c = r.Core()
			r.SOPStarter(e)
			return nil
		}}
}

// artifactStore 记下登记的产物。
type artifactStore struct {
	mu  sync.Mutex
	got []domain.ArtifactInput
}

func (s *artifactStore) CreateObject(context.Context, *domain.Object, store.Actor) (*domain.Object, error) {
	return nil, errors.New("不建对象")
}
func (s *artifactStore) RecordArtifact(_ context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.got = append(s.got, in)
	return &domain.Artifact{ID: "art_1"}, nil
}

// fakeClaudeBin 写一个假的 claude：在工作目录里写 out.md，再吐一行结果。
func fakeClaudeBin(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	script := "#!/bin/sh\necho hi > out.md\n" +
		`echo '{"type":"assistant","message":{"content":[{"type":"text","text":"写好了"}]}}'` + "\n" +
		`echo '{"type":"result","subtype":"success","is_error":false,"result":"写好了"}'` + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func finished(t *testing.T, d *plugintest.Demo, id string) plugin.RunInfo {
	t.Helper()
	var info plugin.RunInfo
	waitFor(t, "run.finished "+id, func() bool {
		v, ok := d.Finished.Load(id)
		if ok {
			info = v.(plugin.RunInfo)
		}
		return ok
	})
	return info
}

// TestRunsThreeKinds：示例插件发起 Agent、SOP、Claude Code 三种运行，都在 run.finished 里按运行 id 拿到结果；
// 产物来源记 run、产出者记插件；审计里每次发起一条，操作者是插件 id。
func TestRunsThreeKinds(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	demo := plugintest.NewDemo(time.Hour)
	r, err := sqlRegistry(t, d, demo, sopPlugin(t))
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	installEnable(t, r, "sop")
	agent := &runAgent{}
	r.SetAgent(agent)
	arts := &artifactStore{}
	r.SetObjectCreator(arts)
	r.SetClaudeRunner(&runner.Runner{Bin: fakeClaudeBin(t)})
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}

	aid, err := runs.StartAgent(ctx, plugin.AgentRunStart{Agent: "剪辑助理", Prompt: "列出选题"})
	if err != nil || !strings.HasPrefix(aid, "run_") {
		t.Fatalf("StartAgent = %q %v", aid, err)
	}
	sid, err := runs.StartSOP(ctx, plugin.SOPRunStart{Flow: "weekly", Input: map[string]any{"topic": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	fid, err := runs.StartSOP(ctx, plugin.SOPRunStart{Flow: "fast"})
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	cid, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "写一份说明", ScopeType: "video", ScopeID: "vd_1"})
	if err != nil {
		t.Fatal(err)
	}

	a := finished(t, demo, aid)
	if a.Kind != plugin.RunKindAgent || a.Source != "demo" || a.Status != plugin.RunDone || !a.OK || a.Ref != "ags_1" || a.Output != "整理好了：列出选题" {
		t.Fatalf("Agent 运行 = %+v", a)
	}
	if len(agent.got) != 1 || agent.got[0].Agent != "剪辑助理" {
		t.Fatalf("Agent 收到 %+v", agent.got)
	}
	s := finished(t, demo, sid)
	if s.Kind != plugin.RunKindSOP || s.Status != plugin.RunFailed || s.OK || s.Ref != "spr_weekly" || s.Error == "" {
		t.Fatalf("SOP 运行 = %+v", s)
	}
	// 返回前就跑完的 SOP 执行也对得上
	if f := finished(t, demo, fid); f.Status != plugin.RunDone || f.Ref != "spr_fast" {
		t.Fatalf("快的 SOP 运行 = %+v", f)
	}
	c := finished(t, demo, cid)
	if c.Kind != plugin.RunKindClaudeCode || c.Status != plugin.RunDone || !c.OK || !strings.Contains(c.Output, "写好了") || len(c.Artifacts) != 1 {
		t.Fatalf("Claude Code 运行 = %+v", c)
	}
	if len(arts.got) != 1 {
		t.Fatalf("产物 = %+v", arts.got)
	}
	in := arts.got[0]
	if in.Path != filepath.Join(wd, "out.md") || in.Source != domain.ArtifactSourceRun || in.ActorType != domain.ActorRun ||
		in.ActorID != "demo" || in.ScopeType != "video" || in.ScopeID != "vd_1" || in.Props["plugin_run_id"] != cid || in.RunID != nil {
		t.Fatalf("产物登记 = %+v", in)
	}

	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM audits WHERE actor = 'demo' AND source = 'plugin' AND action = 'run'
		AND target_type = 'plugin_run' AND target_id IN (?,?,?,?)`, aid, sid, fid, cid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Fatalf("审计 %d 条，要 4 条", n)
	}
	if !r.WaitRuns(10 * time.Second) {
		t.Fatal("运行没收完")
	}
}

// TestRunsKeepGoingAfterDisable：停用插件后它发起的运行照样跑完，但 run.finished 不再投给它。
func TestRunsKeepGoingAfterDisable(t *testing.T) {
	ctx := context.Background()
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)
	installEnable(t, r, "demo")
	agent := &runAgent{gate: make(chan struct{})}
	r.SetAgent(agent)
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}
	id, err := runs.StartAgent(ctx, plugin.AgentRunStart{Agent: "ag_1", Prompt: "慢慢来"})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	close(agent.gate)
	if !r.WaitRuns(10 * time.Second) {
		t.Fatal("运行没收完")
	}
	info, err := runs.Get(id)
	if err != nil || !info.Finished || info.Status != plugin.RunDone {
		t.Fatalf("停用后运行 = %+v %v", info, err)
	}
	if _, ok := demo.Finished.Load(id); ok {
		t.Fatal("停用后还投了 run.finished")
	}
	// 停用后不能再发起
	if _, err := runs.StartAgent(ctx, plugin.AgentRunStart{Agent: "ag_1", Prompt: "再来"}); !errors.Is(err, plugin.ErrRunInactive) {
		t.Fatalf("停用后发起 = %v", err)
	}
}

// TestRunsGuards：没接实现、没确认 process:spawn 就放开写、目录不对、查别的插件的运行，都回错误。
func TestRunsGuards(t *testing.T) {
	ctx := context.Background()
	demo := plugintest.NewDemo(time.Hour)
	other := &fakePlugin{m: manifest(t, "other", "")}
	var otherCore plugin.Core
	other.reg = func(r plugin.Registrar) error {
		otherCore = r.Core()
		return nil
	}
	r := newRegistry(t, plugin.NewMemStateStore(), demo, other)
	installEnable(t, r, "demo")
	installEnable(t, r, "other")
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runs.StartAgent(ctx, plugin.AgentRunStart{Agent: "a", Prompt: "p"}); !errors.Is(err, plugin.ErrNoAgent) {
		t.Fatalf("没接 Agent = %v", err)
	}
	if _, err := runs.StartSOP(ctx, plugin.SOPRunStart{Flow: "f"}); !errors.Is(err, plugin.ErrNoSOPStarter) {
		t.Fatalf("没有 SOP 插件 = %v", err)
	}
	wd := t.TempDir()
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "p"}); !errors.Is(err, plugin.ErrNoClaudeRunner) {
		t.Fatalf("没接执行器 = %v", err)
	}
	r.SetClaudeRunner(&runner.Runner{Bin: fakeClaudeBin(t)})
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "p", AllowWrites: true}); !errors.Is(err, plugin.ErrNotGranted) {
		t.Fatalf("没确认 process:spawn 就放开写 = %v", err)
	}
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: "relative", Prompt: "p"}); err == nil {
		t.Fatal("相对路径应当报错")
	}
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	finished(t, demo, id)
	if _, err := otherCore.Runs().Get(id); !errors.Is(err, plugin.ErrRunNotFound) {
		t.Fatalf("别的插件查 = %v", err)
	}
	if !r.WaitRuns(10 * time.Second) {
		t.Fatal("运行没收完")
	}
}
