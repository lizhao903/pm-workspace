package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 插件发起运行的句柄（VID-03a），见 docs/plugin-api.md 2.0「发起运行」。
// 三种：按 Agent 加提示词跑一轮（AgentService.RunAgent）、按流程加入参起一条 SOP 执行（Registry.StartSOP）、
// 按工作目录加提示词交给本机 Claude Code（internal/runner）。都不等跑完，先回运行 id。
// 跑完给发起的插件投一条 run.finished，只投给它、不上总线：总线上的 run.finished 是任务执行的，通知中心、
// 事件流都按任务执行认。插件停用后运行照样跑完，只是不再投给它。运行记录只在进程内存里，重启后查不到。

// 运行的种类。
const (
	RunKindAgent      = "agent"
	RunKindSOP        = "sop"
	RunKindClaudeCode = "claude_code"
)

// 运行状态。Agent 停在要确认的调用上记 waiting 并算结束，确认后接着跑由会话管（AgentState 查）。
const (
	RunRunning  = "running"
	RunDone     = "done"
	RunFailed   = "failed"
	RunWaiting  = "waiting"
	RunCanceled = "canceled"
	RunStopped  = "stopped"
)

// RunFinishedEvent 是运行结束时投给发起插件的事件，和内核的执行结束同名，插件要在清单 subscribes 里写它。
const RunFinishedEvent = "run.finished"

// sopRunStatusEvent 是 SOP 插件发的执行状态变化，内核据此认出 SOP 运行结束。
const sopRunStatusEvent = "sop.run_status_changed"

// AgentRunTimeout 是插件发起的一轮 Agent 的上限，同 Agent 的自动执行。
const AgentRunTimeout = 10 * time.Minute

// maxFinishedRuns 是内存里最多留多少条跑完的运行，超了丢最早结束的。
const maxFinishedRuns = 500

var (
	// ErrRunNotFound：没有这条运行，或者不是本插件发起的。
	ErrRunNotFound = errors.New("没有这条运行")
	// ErrNoClaudeRunner：注册表没接上 Claude Code 的执行器（测试里没接时）。
	ErrNoClaudeRunner = errors.New("Claude Code 执行还没接上")
	// ErrRunInactive：插件没在跑，不能发起运行。
	ErrRunInactive = errors.New("插件没在跑，不能发起运行")
)

// AgentRunStart 是发起一轮 Agent：Agent 是 id 或名称，Title 是会话标题（空时取提示词开头）。
type AgentRunStart struct {
	Agent  string
	Prompt string
	Title  string
}

// SOPRunStart 是发起一条 SOP 执行：Flow 是流程 id 或名称，Input 没给的字段取流程默认值。
type SOPRunStart struct {
	Flow  string
	Input map[string]any
}

// ClaudeCodeStart 是交给 Claude Code 跑一次。
type ClaudeCodeStart struct {
	Workdir string // 绝对路径，必填
	Prompt  string // 必填，原样交给 claude
	// AllowWrites 放开文件编辑，要用户确认过 process:spawn；默认只读
	AllowWrites bool
	// ObjectID 可选，产物挂到这个对象
	ObjectID string
	// ScopeType、ScopeID 可选，产物的非对象归属（例 video、vd_xxx），要同时给
	ScopeType string
	ScopeID   string
}

// RunInfo 是一条运行的样子，Finished 为假时只有 ID、Kind、Source、Status、StartedAt 可信。
type RunInfo struct {
	ID     string
	Kind   string
	Source string // 发起的插件 id
	Status string
	OK     bool // 只有 done 为真
	// Ref 是底下那条记录：SOP 执行 id、Agent 会话 id；Claude Code 为空
	Ref string
	// Output 是 Agent 最新一条回复、Claude Code 的过程记录（已截断）；SOP 为空，详情查 SOP 执行
	Output   string
	Error    string
	ExitCode int
	// Artifacts 是登记的产物 id（Claude Code 改动的文件）
	Artifacts  []string
	Finished   bool
	StartedAt  time.Time
	FinishedAt time.Time
}

// RunService 是插件发起运行的入口，回运行 id，不等跑完。
type RunService interface {
	StartAgent(ctx context.Context, q AgentRunStart) (string, error)
	StartSOP(ctx context.Context, q SOPRunStart) (string, error)
	StartClaudeCode(ctx context.Context, q ClaudeCodeStart) (string, error)
	// Get 查本插件发起的运行，别的插件发起的回 ErrRunNotFound。
	Get(runID string) (RunInfo, error)
}

// ClaudeRunner 是 Claude Code 的执行器，*runner.Runner 满足它。
type ClaudeRunner interface {
	Start(ctx context.Context, req runner.Request, on func(runner.Event)) (*runner.Result, error)
}

type claudeBox struct{ r ClaudeRunner }

// SetClaudeRunner 接上 Claude Code 的执行器，可以在 Start 之后调（发起时现取）。
func (r *Registry) SetClaudeRunner(cr ClaudeRunner) { r.claude.Store(&claudeBox{cr}) }

// artifactRecorder 是登记产物的 store 方法，cmd/pmw 交的外层 store 满足它。
type artifactRecorder interface {
	RecordArtifact(ctx context.Context, in domain.ArtifactInput) (*domain.Artifact, error)
}

// runTable 是进程内存里的运行记录。
type runTable struct {
	mu   sync.Mutex
	m    map[string]*RunInfo
	sops map[string]string // SOP 执行 id -> 运行 id
	// early 是还没对上运行的 SOP 结束状态：执行跑得比 StartSOP 返回还快时先记在这
	early map[string]string
	wg    sync.WaitGroup
}

// WaitRuns 等在途的运行和 run.finished 投递，最多等 timeout；等到了返回 true。进程退出和测试用。
func (r *Registry) WaitRuns(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		r.runs.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (c *core) Runs() RunService { return runService{c} }

type runService struct{ c *core }

// begin 检查插件在跑，记一条运行和一条审计。
func (s runService) begin(ctx context.Context, kind, summary string, detail map[string]any) (*RunInfo, error) {
	r := s.c.reg
	if r == nil {
		return nil, ErrRunInactive
	}
	if e := r.entries[s.c.id]; e == nil || e.active.Load() == nil {
		return nil, fmt.Errorf("%w：%s", ErrRunInactive, s.c.id)
	}
	info := &RunInfo{ID: idgen.Prefixed("run"), Kind: kind, Source: s.c.id, Status: RunRunning, StartedAt: time.Now().UTC()}
	r.runs.mu.Lock()
	if r.runs.m == nil {
		r.runs.m, r.runs.sops, r.runs.early = map[string]*RunInfo{}, map[string]string{}, map[string]string{}
	}
	r.runs.m[info.ID] = info
	r.runs.mu.Unlock()
	detail["kind"] = kind
	s.c.note(ctx, WriteMeta{}, "run", "plugin_run", info.ID, summary, detail)
	return info, nil
}

func (s runService) StartAgent(ctx context.Context, q AgentRunStart) (string, error) {
	q.Agent, q.Prompt = strings.TrimSpace(q.Agent), strings.TrimSpace(q.Prompt)
	if q.Agent == "" || q.Prompt == "" {
		return "", errors.New("Agent 和提示词都不能为空")
	}
	svc := s.c.Agent()
	if _, ok := svc.(noAgent); ok {
		return "", ErrNoAgent
	}
	info, err := s.begin(ctx, RunKindAgent, "发起 Agent 运行："+q.Agent, map[string]any{"agent": q.Agent})
	if err != nil {
		return "", err
	}
	r := s.c.reg
	r.runs.wg.Add(1)
	go func() {
		defer r.runs.wg.Done()
		rctx, cancel := context.WithTimeout(context.Background(), AgentRunTimeout)
		defer cancel()
		res, err := safeRunAgent(rctx, svc, AgentRunRequest{Agent: q.Agent, Prompt: q.Prompt, Title: q.Title})
		r.finishRun(info.ID, func(i *RunInfo) {
			i.Ref, i.Output = res.SessionID, res.Reply
			switch {
			case err != nil:
				i.Status, i.Error = RunFailed, err.Error()
			case res.Waiting:
				i.Status, i.Error = RunWaiting, res.Pending
			default:
				i.Status = RunDone
			}
		})
	}()
	return info.ID, nil
}

func safeRunAgent(ctx context.Context, svc AgentService, q AgentRunRequest) (res AgentRunResult, err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("Agent 运行出错：%v", v)
		}
	}()
	return svc.RunAgent(ctx, q)
}

func (s runService) StartSOP(ctx context.Context, q SOPRunStart) (string, error) {
	q.Flow = strings.TrimSpace(q.Flow)
	if q.Flow == "" {
		return "", errors.New("没有指定流程")
	}
	r := s.c.reg
	if r == nil || r.sopStarterOwner("") == "" {
		return "", ErrNoSOPStarter
	}
	info, err := s.begin(ctx, RunKindSOP, "发起 SOP 运行："+q.Flow, map[string]any{"flow": q.Flow})
	if err != nil {
		return "", err
	}
	input := q.Input
	if input == nil {
		input = map[string]any{}
	}
	st, err := r.StartSOP(ctx, SOPStartRequest{FlowID: q.Flow, Input: input, Source: "plugin", SourceID: s.c.id, SourceName: s.c.id})
	if err != nil {
		// 没起来：运行 id 没交出去，记录直接丢掉，不投 run.finished
		r.runs.mu.Lock()
		delete(r.runs.m, info.ID)
		r.runs.mu.Unlock()
		return "", err
	}
	r.runs.mu.Lock()
	info.Ref = st.RunID
	r.runs.sops[st.RunID] = info.ID
	end, early := r.runs.early[st.RunID]
	delete(r.runs.early, st.RunID)
	if st.Status == RunWaiting {
		info.Status = RunWaiting
	}
	r.runs.mu.Unlock()
	if early {
		r.endSOP(st.RunID, end)
	} else if sopEnded(st.Status) {
		r.endSOP(st.RunID, st.Status)
	}
	return info.ID, nil
}

func (s runService) StartClaudeCode(ctx context.Context, q ClaudeCodeStart) (string, error) {
	q.Prompt, q.ObjectID = strings.TrimSpace(q.Prompt), strings.TrimSpace(q.ObjectID)
	if q.Prompt == "" {
		return "", errors.New("提示词不能为空")
	}
	if (q.ScopeType == "") != (q.ScopeID == "") {
		return "", errors.New("产物归属的类型和 id 要同时给")
	}
	workdir, err := runner.CheckWorkdir(q.Workdir)
	if err != nil {
		return "", err
	}
	if q.AllowWrites {
		if err := Require(s.c, "process:spawn"); err != nil {
			return "", err
		}
	}
	r := s.c.reg
	var cr ClaudeRunner
	if r != nil {
		if b := r.claude.Load(); b != nil {
			cr = b.r
		}
	}
	if cr == nil {
		return "", ErrNoClaudeRunner
	}
	info, err := s.begin(ctx, RunKindClaudeCode, "交给 Claude Code："+workdir,
		map[string]any{"workdir": workdir, "allow_writes": q.AllowWrites, "object_id": q.ObjectID})
	if err != nil {
		return "", err
	}
	r.runs.wg.Add(1)
	go func() {
		defer r.runs.wg.Done()
		// 执行前拍快照，跑完比对出改动的文件登记成产物（同 POST /api/objects/{id}/run）
		before := runner.TakeSnapshot(workdir)
		res, err := safeClaude(cr, runner.Request{RunID: info.ID, Workdir: workdir, Prompt: q.Prompt, AllowWrites: q.AllowWrites})
		arts := s.recordArtifacts(info.ID, workdir, q, before)
		var failed *incident.ClaudeRun
		r.finishRun(info.ID, func(i *RunInfo) {
			i.Artifacts = arts
			if err != nil {
				i.Status, i.Error, i.ExitCode = RunFailed, err.Error(), -1
			} else {
				i.Status, i.Output, i.Error, i.ExitCode = res.Status, res.Output, res.Error, res.ExitCode
			}
			if i.Status == RunFailed {
				failed = &incident.ClaudeRun{RunID: i.ID, ObjectID: q.ObjectID, Workdir: workdir, ExitCode: i.ExitCode,
					Error: i.Error, Output: i.Output, AllowWrites: q.AllowWrites, Via: s.c.id, Source: incident.SourcePlugin + s.c.id}
			}
		})
		// 失败记运行异常（INC-01a），取消不记；记不上只记日志
		if failed != nil {
			s.noteClaudeFailed(*failed)
		}
	}()
	return info.ID, nil
}

func safeClaude(cr ClaudeRunner, req runner.Request) (res *runner.Result, err error) {
	defer func() {
		if v := recover(); v != nil {
			res, err = nil, fmt.Errorf("Claude Code 执行出错：%v", v)
		}
	}()
	return cr.Start(context.Background(), req, nil)
}

// recordArtifacts 把改动的文件登记成产物：来源 run、产出者记发起的插件，props 带运行 id。登记失败只记日志。
func (s runService) recordArtifacts(runID, workdir string, q ClaudeCodeStart, before runner.Snapshot) []string {
	rec, ok := s.c.reg.objectCreator().(artifactRecorder)
	if !ok {
		return nil
	}
	changed, truncated := runner.Diff(before, runner.TakeSnapshot(workdir))
	if truncated {
		s.c.log.Warn("plugin run changed too many files", "run", runID, "limit", runner.MaxRecordedArtifacts)
	}
	var objID *string
	if q.ObjectID != "" {
		objID = &q.ObjectID
	}
	out := []string{}
	for _, f := range changed {
		art, err := rec.RecordArtifact(context.Background(), domain.ArtifactInput{
			ObjectID: objID, Path: f.Path, BaseDir: workdir, Platform: "local", Size: f.Size,
			Source: domain.ArtifactSourceRun, ActorType: domain.ActorRun, ActorID: s.c.id, ActorLabel: s.c.id,
			ScopeType: q.ScopeType, ScopeID: q.ScopeID,
			Props: map[string]any{"plugin_run_id": runID},
		})
		if err != nil {
			s.c.log.Warn("record plugin run artifact failed", "run", runID, "path", f.Path, "err", err)
			continue
		}
		out = append(out, art.ID)
	}
	return out
}

func (s runService) Get(runID string) (RunInfo, error) {
	r := s.c.reg
	if r == nil {
		return RunInfo{}, ErrRunNotFound
	}
	r.runs.mu.Lock()
	defer r.runs.mu.Unlock()
	i, ok := r.runs.m[runID]
	if !ok || i.Source != s.c.id {
		return RunInfo{}, ErrRunNotFound
	}
	out := *i
	out.Artifacts = slices.Clone(i.Artifacts)
	return out, nil
}

// finishRun 收尾一条运行（只收一次），再投 run.finished 给发起的插件。
func (r *Registry) finishRun(id string, fill func(*RunInfo)) {
	r.runs.mu.Lock()
	i, ok := r.runs.m[id]
	if !ok || i.Finished {
		r.runs.mu.Unlock()
		return
	}
	fill(i)
	i.OK = i.Status == RunDone
	i.Finished, i.FinishedAt = true, time.Now().UTC()
	info := *i
	r.pruneRuns()
	r.runs.mu.Unlock()
	r.deliverRunFinished(info)
}

// pruneRuns 丢掉超出上限的最早结束的运行。调用方持有 runs.mu。
func (r *Registry) pruneRuns() {
	var done []*RunInfo
	for _, i := range r.runs.m {
		if i.Finished {
			done = append(done, i)
		}
	}
	if len(done) <= maxFinishedRuns {
		return
	}
	slices.SortFunc(done, func(a, b *RunInfo) int { return a.FinishedAt.Compare(b.FinishedAt) })
	for _, i := range done[:len(done)-maxFinishedRuns] {
		delete(r.runs.m, i.ID)
		if i.Kind == RunKindSOP {
			delete(r.runs.sops, i.Ref)
		}
	}
}

// deliverRunFinished 只投给发起的插件当前在跑的订阅，停用了就不投。异步执行，出错、panic 只记日志。
func (r *Registry) deliverRunFinished(i RunInfo) {
	raw, err := json.Marshal(map[string]any{
		"run_id": i.ID, "kind": i.Kind, "source": i.Source, "status": i.Status, "ok": i.OK, "ref": i.Ref,
	})
	if err != nil {
		return
	}
	ev := Event{Type: RunFinishedEvent, At: i.FinishedAt, Payload: raw}
	for _, sub := range r.Subscribers(RunFinishedEvent) {
		if sub.Plugin != i.Source {
			continue
		}
		r.runs.wg.Add(1)
		go func() {
			defer r.runs.wg.Done()
			defer func() {
				if v := recover(); v != nil {
					r.log.Error("plugin run.finished handler panic", "plugin", sub.Plugin, "panic", v, "stack", string(debug.Stack()))
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := sub.Handle(ctx, ev); err != nil {
				r.log.Warn("plugin run.finished handler failed", "plugin", sub.Plugin, "run", i.ID, "err", err)
			}
		}()
	}
}

func sopEnded(status string) bool {
	return status == RunDone || status == RunFailed || status == RunStopped
}

// watchSOPRun 在 SOP 插件发执行状态变化时调：插件发起的执行结束了就收尾，还没对上的先记下。
func (r *Registry) watchSOPRun(payload any) {
	if r == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	var p struct {
		RunID string `json:"run_id"`
		To    string `json:"to"`
	}
	if json.Unmarshal(raw, &p) != nil || p.RunID == "" {
		return
	}
	r.runs.mu.Lock()
	id, ok := r.runs.sops[p.RunID]
	if !ok {
		if sopEnded(p.To) && r.runs.early != nil {
			if len(r.runs.early) >= 256 {
				clear(r.runs.early)
			}
			r.runs.early[p.RunID] = p.To
		}
		r.runs.mu.Unlock()
		return
	}
	if p.To == RunWaiting || p.To == RunRunning {
		if i := r.runs.m[id]; i != nil && !i.Finished {
			i.Status = p.To
		}
	}
	r.runs.mu.Unlock()
	if sopEnded(p.To) {
		r.endSOP(p.RunID, p.To)
	}
}

func (r *Registry) endSOP(sopRunID, status string) {
	r.runs.mu.Lock()
	id := r.runs.sops[sopRunID]
	r.runs.mu.Unlock()
	if id == "" {
		return
	}
	r.finishRun(id, func(i *RunInfo) {
		i.Status = status
		if status != RunDone {
			i.Error = "SOP 执行" + map[string]string{RunFailed: "失败", RunStopped: "被停止"}[status]
		}
	})
}

// noteClaudeFailed 插件交给 Claude Code 的运行失败，记一条运行异常，来源 plugin:<插件 id>；有对象时带上编号和标题。
func (s runService) noteClaudeFailed(c incident.ClaudeRun) {
	r := s.c.reg
	if r == nil {
		return
	}
	b := r.incidents.Load()
	if b == nil || b.r == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if c.ObjectID != "" {
		if o, err := s.c.Objects().Get(ctx, c.ObjectID); err == nil {
			c.ObjectTitle = o.Title
		}
	}
	if _, err := b.r.Record(ctx, incident.ClaudeRunReport(c)); err != nil {
		s.c.log.Warn("claude code run incident not recorded", "run", c.RunID, "err", err)
	}
}
