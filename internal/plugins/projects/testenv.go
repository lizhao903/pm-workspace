package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 测试环境与测试报告（AUTO-08）：在任务在用的工作区（worktrees.go）上按项目档案的命令依次
// 构建（build）→ 起临时测试环境（test_env，后台，等端口或档案里配的就绪检查）→ 测试（test）→ 冒烟（smoke），
// 收每步的退出码、耗时、输出尾部，收约定报告目录里的 junit xml 和截图，写 Markdown 报告登记为任务产出，最后杀掉测试环境的进程组。
// 表 projects_test_runs（迁移 0007）。报告放数据目录下 test-reports/<项目 id>/<任务编号>/<测试 id>/report.md，
// 约定报告目录是同一目录下的 out/，经环境变量 TEST_REPORT_DIR 交给命令。
//
// 三种调用方：
//   - 接口：POST /api/projects/tests {task_id} 起一次（202）；GET /api/projects/tests?task_id= 列；GET /api/projects/tests/runs/{id}；
//     POST /api/projects/tests/runs/{id}/stop 手动停；GET /api/projects/tests/runs/{id}/report 报告原文；GET /api/projects/tests/runs/{id}/shots/{name...} 截图。
//   - SOP 节点 projects_run_test（跑测试）：起测试后挂起，跑完唤醒，输出加 test: {ok, status, report_path, url?, port, steps, failed_step?, …}。
//   - 事件 projects.test_changed：起、每步变化、结束时发，前端据此刷新。
//
// 安全：子进程环境只透传白名单（PATH、HOME、LANG 等），不带工作台自己的凭证和别的环境变量；工作目录限定在 worktree 里；
// 每个命令起在自己的进程组里（Setpgid），超时、停止、跑完都按记下的进程组杀，不按名字找进程；要用户确认过 process:spawn。
// 进程组号记在表里：工作台重启后把上次没跑完的记成 interrupted，杀掉记下的进程组。
//
// 保留测试环境（AUTO-09，迁移 0008）：起测试时带 keep（接口 keep_env / keep_hours，SOP 节点 config.keep_env），
// 全部通过时不杀测试环境，进程接着跑，留给人工验收访问，记 env_state = kept 和到点时间 env_keep_until。
// 回收：到点（后台任务 test_env_expiry）、阶段离开「待验收」（验收通过或退回）、任务完成或取消、工作区清理、
// 同一任务再跑一次测试（端口要让出来）、手动回收（POST …/release）、环境自己退出、插件停用或工作台关闭；
// 工作台异常退出后重启，上次保留的按记下的进程组杀掉（不跨进程接着管）。回收后 env_state = released，记原因。

const (
	NodeRunTest = "projects_run_test"
	testChanged = "projects.test_changed"

	// 一次测试的状态
	trRunning     = "running"
	trPassed      = "passed"
	trFailed      = "failed"
	trStopped     = "stopped"
	trInterrupted = "interrupted"

	// 一步的状态
	stPending = "pending"
	stRunning = "running"
	stPassed  = "passed"
	stFailed  = "failed"
	stSkipped = "skipped"
	stStopped = "stopped"

	// ReportsSubdir 是测试报告在数据目录下的目录名，和 worktrees/ 同级。
	ReportsSubdir = "test-reports"
	// ReportOutDir 是约定的报告目录（相对这次测试的目录），环境变量 TEST_REPORT_DIR 指向它。
	ReportOutDir = "out"
	reportFile   = "report.md"

	tailBytes   = 4000 // 每步输出尾部最多留多少字节
	tailLines   = 60   // 每步输出尾部最多留多少行
	bufferBytes = 64 << 10

	defaultBuildTimeout = 10 * time.Minute
	defaultTestTimeout  = 30 * time.Minute
	defaultSmokeTimeout = 5 * time.Minute
	defaultReadyTimeout = 2 * time.Minute

	killGrace      = 5 * time.Second
	readyPoll      = 300 * time.Millisecond
	stopWait       = 20 * time.Second
	maxShots       = 50
	maxJunitFiles  = 50
	maxJunitSize   = 5 << 20
	maxFailedCases = 20
	notifyEvery    = 5 * time.Second
	notifyGiveUp   = time.Hour
	expiryEvery    = 30 * time.Second
)

// 测试环境保留状态（AUTO-09）：空串是没保留（跑完即回收，或没有测试环境）。
const (
	envKept     = "kept"
	envReleased = "released"
)

// 保留的测试环境回收原因，落库 env_release_reason。
const (
	EnvExpired       = "expired"
	EnvAccepted      = "accepted"
	EnvStageChanged  = "stage_changed"
	EnvTaskDone      = "task_done"
	EnvWorktreeGone  = "worktree_removed"
	EnvRerun         = "rerun"
	EnvManual        = "manual"
	EnvExited        = "exited"
	EnvRestart       = "restart"
	EnvPluginStopped = "plugin_stopped"
)

// 任务阶段（AUTO-05）：保留的测试环境在阶段离开「待验收」时回收，进「待发布」「已上线」算验收通过。
const (
	acceptingStage = "accepting"
	releasingStage = "releasing"
)

// testStepKeys 是测试跑的档案命令，顺序即执行顺序。
var testStepKeys = []string{"build", "test_env", "test", "smoke"}

var testStepLabels = map[string]string{"build": "构建", "test_env": "起测试环境", "test": "测试", "smoke": "冒烟"}

// envPassthrough 是子进程从工作台进程继承的环境变量，别的一律不带（凭证、令牌、数据目录都在别的变量里）。
var envPassthrough = []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TMPDIR", "TERM", "TZ"}

// TestStep 是一次测试里的一步。
type TestStep struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Command string `json:"command"`
	// Dir 是执行目录（worktree 里的绝对路径）
	Dir    string `json:"dir"`
	Status string `json:"status"`
	// ExitCode 没跑、被信号杀掉时为 null；测试环境就绪后一直跑着，回收时被杀，也是 null
	ExitCode   *int   `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out"`
	Output     string `json:"output"`
	Error      string `json:"error"`
	// Ready 只有 test_env：就绪检查的说明（端口或地址）
	Ready      string     `json:"ready,omitempty"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// JunitSummary 是约定报告目录里 junit xml 的用例汇总。
type JunitSummary struct {
	Files    int      `json:"files"`
	Tests    int      `json:"tests"`
	Failures int      `json:"failures"`
	Errors   int      `json:"errors"`
	Skipped  int      `json:"skipped"`
	Failed   []string `json:"failed"`
}

// TestRun 是一次测试。
type TestRun struct {
	ID         string `json:"id"`
	TaskID     string `json:"task_id"`
	TaskRef    string `json:"task_ref"`
	ProjectID  string `json:"project_id"`
	WorktreeID string `json:"worktree_id"`
	// Workdir 是工作区的执行目录（worktree.path）
	Workdir   string `json:"workdir"`
	Port      int    `json:"port"`
	PortStart int    `json:"port_start"`
	PortEnd   int    `json:"port_end"`
	// URL 是测试环境地址，档案里有 test_env 时才有；跑完环境已回收，保留中（EnvState = kept）时可访问
	URL         string        `json:"url"`
	Status      string        `json:"status"`
	Steps       []TestStep    `json:"steps"`
	FailedStep  string        `json:"failed_step"`
	Error       string        `json:"error"`
	RunDir      string        `json:"run_dir"`
	ReportPath  string        `json:"report_path"`
	ArtifactIDs []string      `json:"artifact_ids"`
	Shots       []string      `json:"shots"`
	Junit       *JunitSummary `json:"junit"`
	// Source 是谁起的：api（接口、界面）或 sop（SOP 节点）
	Source     string     `json:"source"`
	SopRunID   string     `json:"sop_run_id"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	// EnvState 是测试环境保留状态：空串没保留，kept 保留中，released 保留过、已回收（AUTO-09）
	EnvState string `json:"env_state"`
	// EnvKeepUntil 是保留到什么时候，到点自动回收；没保留为 null
	EnvKeepUntil *time.Time `json:"env_keep_until"`
	// EnvReleasedAt、EnvReleaseReason 是保留后回收的时间和原因
	EnvReleasedAt    *time.Time `json:"env_released_at"`
	EnvReleaseReason string     `json:"env_release_reason"`

	// keep 是这次要求保留多久（通过时才保留），不落库
	keep       time.Duration
	sopStep    string
	sopAttempt int
	sopInput   string
	notified   bool
	pgid       int
	envPgid    int
}

// sopRef 是 SOP 节点发起时带的执行、步骤、第几次尝试和输入。
type sopRef struct {
	runID, step string
	attempt     int
	input       map[string]any
}

// liveTest 是本进程里在跑的一次测试。stop 关掉 stopCh，执行协程看到后杀掉当前步骤和测试环境。
type liveTest struct {
	id       string
	stopCh   chan struct{}
	done     chan struct{}
	once     sync.Once
	mu       sync.Mutex
	reason   string // stopped 或 interrupted
	stopNote string
}

func (lt *liveTest) stop(reason, note string) {
	lt.once.Do(func() {
		lt.mu.Lock()
		lt.reason, lt.stopNote = reason, note
		lt.mu.Unlock()
		close(lt.stopCh)
	})
}

func (lt *liveTest) stopped() (string, string, bool) {
	select {
	case <-lt.stopCh:
		lt.mu.Lock()
		defer lt.mu.Unlock()
		return lt.reason, lt.stopNote, true
	default:
		return "", "", false
	}
}

type testService struct {
	c      plugin.Core
	wt     *worktreeService
	mu     sync.Mutex
	closed bool
	live   map[string]*liveTest
	// kept 是本进程里保留着的测试环境，按测试 id（AUTO-09）
	kept map[string]*bgProc
	// publicURL 是浏览器访问工作台的地址（--public-url），SOP 输出里的报告链接拼在它后面
	publicURL string
	// now 是当前时间，测试里换掉
	now func() time.Time
	// reconciled 只在第一次用到时把上次没跑完的记成 interrupted
	reconcile sync.Once
	// listen 看端口在不在监听，测试里换掉
	listen func(port int, timeout time.Duration) bool
}

func newTestService(c plugin.Core, wt *worktreeService, publicURL string) *testService {
	s := &testService{c: c, wt: wt, live: map[string]*liveTest{}, kept: map[string]*bgProc{}, listen: listeningWithin,
		publicURL: publicURL, now: func() time.Time { return time.Now().UTC() }}
	wt.beforeCleanup = func(ctx context.Context, w Worktree, reason string) {
		why := EnvWorktreeGone
		switch reason {
		case ReasonTaskDone, ReasonTaskCancelled:
			why = EnvTaskDone
		case ReasonReleased:
			why = EnvAccepted
		}
		s.releaseTask(ctx, w.TaskID, why)
	}
	return s
}

func (s *testService) register(r plugin.Registrar, h *stakeholders) {
	r.Routes(func(m plugin.RouteRegistrar) {
		api := &testAPI{h, s}
		m.HandleFunc("GET /api/projects/tests", api.list)
		m.HandleFunc("POST /api/projects/tests", api.start)
		m.HandleFunc("GET /api/projects/tests/runs/{test_id}", api.show)
		m.HandleFunc("POST /api/projects/tests/runs/{test_id}/stop", api.stop)
		m.HandleFunc("POST /api/projects/tests/runs/{test_id}/release", api.release)
		m.HandleFunc("GET /api/projects/tests/runs/{test_id}/report", api.report)
		m.HandleFunc("GET /api/projects/tests/runs/{test_id}/shots/{name...}", api.shot)
	})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeRunTest, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.runNode})
	// 唤醒 SOP 挂起的步骤：跑完时立刻唤醒一次，没唤醒上（执行还没调度上、SOP 插件没在跑）的由这里重试
	r.Job(plugin.Job{Name: "test_sop_notify", Every: notifyEvery, Run: func(ctx context.Context, _ plugin.Core) error {
		s.ensureReconciled(ctx)
		return s.notifyPending(ctx)
	}})
	// 保留的测试环境到点回收（AUTO-09）
	r.Job(plugin.Job{Name: "test_env_expiry", Every: expiryEvery, Run: func(ctx context.Context, _ plugin.Core) error {
		s.ensureReconciled(ctx)
		return s.releaseExpired(ctx)
	}})
	// 验收结束（阶段离开待验收）、任务完成或取消时回收保留的测试环境
	r.Subscribe("object.stage_changed", s.onStageChanged)
	r.Subscribe("object.status_changed", s.onStatusChanged)
	// 插件停用、服务关闭：停掉这次启用起的全部测试，记成 interrupted
	r.Job(plugin.Job{Name: "tests", Run: func(ctx context.Context, _ plugin.Core) error {
		s.ensureReconciled(ctx)
		<-ctx.Done()
		s.closeAll()
		return nil
	}})
}

/* ---------- 起一次测试 ---------- */

// plannedStep 是要跑的一步：档案命令和解析好的目录、超时。
type plannedStep struct {
	key     string
	cmd     Command
	dir     string
	timeout time.Duration
}

// Start 给任务起一次测试，立刻返回（状态 running），执行在后台。key 是任务 id 或 ref。
// keep 大于 0 时全部通过后保留测试环境这么久（AUTO-09）。
func (s *testService) Start(ctx context.Context, key string, sop *sopRef, keep time.Duration) (TestRun, error) {
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return TestRun{}, apiErr(errConflict, "%s", err.Error())
	}
	s.ensureReconciled(ctx)
	base := s.c.WorktreeDir()
	if base == "" {
		return TestRun{}, apiErr(errConflict, "工作台没有数据目录，跑不了测试")
	}
	task, err := s.wt.task(ctx, key)
	if err != nil {
		return TestRun{}, err
	}
	w, err := s.wt.activeOf(ctx, task.ID)
	if errors.Is(err, plugin.ErrNoRows) {
		return TestRun{}, apiErr(errConflict, "任务 %s 还没有在用的工作区：先准备工作区再跑测试", refOr(task))
	}
	if err != nil {
		return TestRun{}, err
	}
	w = fill(w)
	if !w.Exists {
		return TestRun{}, apiErr(errConflict, "工作区目录 %s 不在了：先再准备一次工作区", w.Root)
	}
	h := &profiles{&stakeholders{c: s.c}}
	proj, err := h.liveProject(ctx, w.ProjectID)
	if err != nil {
		return TestRun{}, apiErr(errConflict, "工作区所属的项目不在了")
	}
	prof, err := h.load(ctx, proj)
	if err != nil {
		return TestRun{}, err
	}
	plan, err := planSteps(prof.Commands, w)
	if err != nil {
		return TestRun{}, err
	}
	// 同一任务上次保留的测试环境占着端口段，先回收（正在跑的那次没有保留，下面照常回 409）
	s.releaseTask(ctx, task.ID, EnvRerun)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return TestRun{}, apiErr(errConflict, "项目插件正在停用，不能再起测试")
	}
	var running string
	err = s.c.Store().QueryRow(ctx, `SELECT id FROM projects_test_runs WHERE task_id = ? AND status = ?`, task.ID, trRunning).Scan(&running)
	if err == nil {
		return TestRun{}, apiErr(errConflict, "任务 %s 的测试正在跑（%s）：等它跑完或先停掉", refOr(task), running)
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return TestRun{}, err
	}

	now := time.Now().UTC()
	id := idgen.Prefixed("tr")
	runDir := filepath.Join(filepath.Dir(base), ReportsSubdir, safeSeg(w.ProjectID), safeSeg(w.TaskRef), id)
	if err := os.MkdirAll(filepath.Join(runDir, ReportOutDir), 0o755); err != nil {
		return TestRun{}, fmt.Errorf("create test report dir: %w", err)
	}
	r := TestRun{
		ID: id, TaskID: task.ID, TaskRef: w.TaskRef, ProjectID: w.ProjectID, WorktreeID: w.ID, Workdir: w.Path,
		Port: w.PortStart, PortStart: w.PortStart, PortEnd: w.PortEnd, Status: trRunning, RunDir: runDir,
		ArtifactIDs: []string{}, Shots: []string{}, Source: "api", StartedAt: now, UpdatedAt: now, keep: keep,
	}
	if _, ok := prof.Commands["test_env"]; ok {
		r.URL = "http://127.0.0.1:" + strconv.Itoa(r.Port)
	}
	vars := r.vars()
	for _, p := range plan {
		st := TestStep{Key: p.key, Label: testStepLabels[p.key], Command: expand(p.cmd.Command, vars), Dir: p.dir, Status: stPending}
		if p.key == "test_env" {
			st.Ready = readyLabel(p.cmd.Ready, vars)
		}
		r.Steps = append(r.Steps, st)
	}
	input := "{}"
	if sop != nil {
		r.Source, r.SopRunID, r.sopStep, r.sopAttempt = "sop", sop.runID, sop.step, sop.attempt
		if b, err := json.Marshal(orEmptyMap(sop.input)); err == nil {
			input = string(b)
		}
		r.sopInput = input
	}
	ts := now.Format(time.RFC3339)
	if _, err := s.c.Store().Exec(ctx, `INSERT INTO projects_test_runs
		(id, task_id, task_ref, project_id, worktree_id, workdir, port, port_start, port_end, url, status, steps, run_dir,
		 source, sop_run_id, sop_step, sop_attempt, sop_input, started_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.TaskID, r.TaskRef, r.ProjectID, r.WorktreeID, r.Workdir, r.Port, r.PortStart, r.PortEnd, r.URL, r.Status, encJSON(r.Steps), r.RunDir,
		r.Source, r.SopRunID, r.sopStep, r.sopAttempt, input, ts, ts); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return TestRun{}, apiErr(errConflict, "任务 %s 的测试正在跑：等它跑完或先停掉", refOr(task))
		}
		return TestRun{}, err
	}
	lt := &liveTest{id: id, stopCh: make(chan struct{}), done: make(chan struct{})}
	s.live[id] = lt
	s.publish(r)
	// 执行协程改它自己那份步骤，回给调用方的是拷贝
	ret := r
	ret.Steps = slices.Clone(r.Steps)
	go s.execute(r, plan, task.Title, w.Branch, lt)
	return ret, nil
}

// planSteps 按档案挑出要跑的命令，解析目录：dir 相对执行目录，解开软链后还要在 worktree 里。
func planSteps(cmds map[string]Command, w Worktree) ([]plannedStep, error) {
	var plan []plannedStep
	root, err := filepath.EvalSymlinks(w.Root)
	if err != nil {
		return nil, apiErr(errConflict, "工作区目录 %s 读不了：%v", w.Root, err)
	}
	for _, k := range testStepKeys {
		c, ok := cmds[k]
		if !ok || strings.TrimSpace(c.Command) == "" {
			continue
		}
		dir := filepath.Join(w.Path, c.Dir)
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			return nil, apiErr(errValidation, "%s命令的目录 %s 在工作区里不存在", testStepLabels[k], dir)
		}
		if real != root && !within(root, real) {
			return nil, apiErr(errValidation, "%s命令的目录 %s 跑出了工作区", testStepLabels[k], dir)
		}
		if st, err := os.Stat(real); err != nil || !st.IsDir() {
			return nil, apiErr(errValidation, "%s命令的目录 %s 不是文件夹", testStepLabels[k], dir)
		}
		plan = append(plan, plannedStep{key: k, cmd: c, dir: dir, timeout: stepTimeout(k, c.TimeoutSec)})
	}
	if len(plan) == 0 {
		return nil, apiErr(errValidation, "项目档案里没有构建、测试、起测试环境、冒烟命令：先到项目的档案里填")
	}
	return plan, nil
}

func stepTimeout(key string, sec int) time.Duration {
	if sec > 0 {
		return time.Duration(sec) * time.Second
	}
	switch key {
	case "build":
		return defaultBuildTimeout
	case "test_env":
		return defaultReadyTimeout
	case "smoke":
		return defaultSmokeTimeout
	}
	return defaultTestTimeout
}

func refOr(o plugin.ObjectInfo) string {
	if o.Ref != "" {
		return o.Ref
	}
	return o.ID
}

/* ---------- 执行 ---------- */

// vars 是注入子进程的变量，命令里也能写 {{PORT}} 这类占位。
func (r TestRun) vars() map[string]string {
	return map[string]string{
		"PORT":            strconv.Itoa(r.Port),
		"PORT_START":      strconv.Itoa(r.PortStart),
		"PORT_END":        strconv.Itoa(r.PortEnd),
		"WORKTREE":        r.Workdir,
		"TASK_REF":        r.TaskRef,
		"TEST_REPORT_DIR": filepath.Join(r.RunDir, ReportOutDir),
	}
}

var placeholderRe = regexp.MustCompile(`\{\{\s*([A-Z_]+)\s*\}\}`)

// expand 换掉命令里认得的 {{变量}}，认不得的原样留着。
func expand(s string, vars map[string]string) string {
	return placeholderRe.ReplaceAllStringFunc(s, func(m string) string {
		k := placeholderRe.FindStringSubmatch(m)[1]
		if v, ok := vars[k]; ok {
			return v
		}
		return m
	})
}

// childEnv 是子进程的环境：白名单里的照传，再加注入的变量和 CI=1。
func childEnv(vars map[string]string) []string {
	var env []string
	for _, k := range envPassthrough {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = append(env, k+"="+vars[k])
	}
	return append(env, "CI=1")
}

// execute 是一次测试的执行协程：依次跑每一步，失败后面的跳过，最后回收测试环境、写报告、登记产出、唤醒 SOP。
func (s *testService) execute(r TestRun, plan []plannedStep, taskTitle, branch string, lt *liveTest) {
	ctx := context.Background()
	defer func() {
		s.mu.Lock()
		delete(s.live, r.ID)
		s.mu.Unlock()
		close(lt.done)
	}()
	vars := r.vars()
	env := childEnv(vars)
	var envProc *bgProc
	for i, p := range plan {
		st := &r.Steps[i]
		if r.FailedStep != "" {
			st.Status = stSkipped
			continue
		}
		if reason, note, ok := lt.stopped(); ok {
			st.Status = stSkipped
			if r.Status == trRunning {
				r.Status, r.Error = reason, note
			}
			continue
		}
		start := time.Now().UTC()
		st.Status, st.StartedAt = stRunning, &start
		s.save(ctx, &r)
		var res stepResult
		if p.key == "test_env" {
			envProc, res = s.startEnv(ctx, &r, p, vars, env, lt)
		} else {
			res = runForeground(st.Command, p.dir, env, p.timeout, lt.stopCh, func(pgid int) {
				r.pgid = pgid
				s.save(ctx, &r)
			})
			r.pgid = 0
		}
		end := time.Now().UTC()
		st.FinishedAt, st.DurationMs = &end, end.Sub(start).Milliseconds()
		st.ExitCode, st.TimedOut, st.Output, st.Error = res.exitCode, res.timedOut, res.output, res.err
		switch {
		case res.stopped:
			st.Status = stStopped
			reason, note, _ := lt.stopped()
			r.Status, r.Error = reason, note
		case res.ok:
			st.Status = stPassed
		default:
			st.Status = stFailed
			r.FailedStep = p.key
			r.Error = st.Label + "：" + st.Error
		}
		s.save(ctx, &r)
	}
	if r.Status == trRunning {
		if r.FailedStep != "" {
			r.Status = trFailed
		} else {
			r.Status = trPassed
		}
	}
	out := filepath.Join(r.RunDir, ReportOutDir)
	r.Shots = collectShots(out)
	r.Junit = collectJunit(out)
	if r.Junit != nil && r.Status == trPassed && r.Junit.Failures+r.Junit.Errors > 0 {
		// 命令退出码是 0、junit 里却有失败的：以 junit 为准算没通过，记在最后一步跑过的测试上
		r.Status = trFailed
		r.FailedStep = lastRan(r.Steps)
		r.Error = fmt.Sprintf("junit 报告里有 %d 个用例没通过", r.Junit.Failures+r.Junit.Errors)
	}
	// 测试环境：要求保留且全部通过时留着给人工验收（AUTO-09），否则杀整个进程组；输出尾部补进那一步
	if envProc != nil {
		if !(r.Status == trPassed && r.keep > 0 && s.keepEnv(&r, envProc)) {
			envProc.kill()
			r.envPgid = 0
		}
		for i := range r.Steps {
			if r.Steps[i].Key == "test_env" {
				r.Steps[i].Output = envProc.buf.tail()
			}
		}
	}
	now := time.Now().UTC()
	r.FinishedAt = &now
	r.ReportPath = filepath.Join(r.RunDir, reportFile)
	if err := os.WriteFile(r.ReportPath, []byte(renderReport(r, taskTitle, branch)), 0o644); err != nil {
		s.c.Log().Warn("write test report failed", "test", r.ID, "err", err)
		r.ReportPath = ""
	}
	r.ArtifactIDs = s.recordArtifacts(ctx, r)
	r.pgid = 0
	if r.EnvState != envKept {
		r.envPgid = 0
	}
	s.save(ctx, &r)
	s.notify(ctx, r.ID)
}

func lastRan(steps []TestStep) string {
	for i := len(steps) - 1; i >= 0; i-- {
		if steps[i].Status == stPassed && (steps[i].Key == "test" || steps[i].Key == "smoke") {
			return steps[i].Key
		}
	}
	return "test"
}

// stepResult 是一步的结果。ok 为真表示通过；stopped 是被手动停了或插件停用。
type stepResult struct {
	ok, stopped, timedOut bool
	exitCode              *int
	output, err           string
}

// runForeground 跑一条前台命令到结束：超时或收到停止时杀整个进程组。onStart 拿到进程组号（记进表）。
func runForeground(command, dir string, env []string, timeout time.Duration, stop <-chan struct{}, onStart func(int)) stepResult {
	buf := &tailBuffer{}
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.Dir, cmd.Env = dir, env
	cmd.Stdout, cmd.Stderr = buf, buf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		return stepResult{err: "起不来：" + err.Error()}
	}
	pgid := cmd.Process.Pid
	onStart(pgid)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var werr error
	var timedOut, stopped bool
	select {
	case werr = <-done:
	case <-timer.C:
		timedOut = true
		werr = killWait(pgid, done)
	case <-stop:
		stopped = true
		werr = killWait(pgid, done)
	}
	// 组长退了，组里可能还留着它拉起的子进程
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	res := stepResult{output: buf.tail(), timedOut: timedOut, stopped: stopped}
	code, sig := exitOf(werr)
	if sig == "" {
		res.exitCode = &code
	}
	switch {
	case stopped:
		res.err = "手动停止"
	case timedOut:
		res.err = fmt.Sprintf("超过 %s 没跑完，已结束", humanDuration(timeout))
	case sig != "":
		res.err = "被信号 " + sig + " 结束"
	case code != 0:
		res.err = "退出码 " + strconv.Itoa(code)
	default:
		res.ok = true
	}
	return res
}

// killWait 先 SIGTERM 整个进程组，等 killGrace 还没退就 SIGKILL，再等进程退出。
func killWait(pgid int, done <-chan error) error {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case err := <-done:
		return err
	case <-time.After(killGrace):
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	select {
	case err := <-done:
		return err
	case <-time.After(waitDelay + time.Second):
		return errors.New("killed")
	}
}

func exitOf(err error) (int, string) {
	if err == nil {
		return 0, ""
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return -1, ws.Signal().String()
		}
		return ee.ExitCode(), ""
	}
	if errors.Is(err, exec.ErrWaitDelay) {
		return 0, ""
	}
	return -1, "unknown"
}

// bgProc 是后台跑着的测试环境。
type bgProc struct {
	pgid   int
	buf    *tailBuffer
	exited chan struct{}
	err    error
	once   sync.Once
}

func (p *bgProc) kill() {
	p.once.Do(func() {
		select {
		case <-p.exited:
		default:
			_ = syscall.Kill(-p.pgid, syscall.SIGTERM)
			select {
			case <-p.exited:
			case <-time.After(killGrace):
				_ = syscall.Kill(-p.pgid, syscall.SIGKILL)
				select {
				case <-p.exited:
				case <-time.After(waitDelay + time.Second):
				}
			}
		}
		_ = syscall.Kill(-p.pgid, syscall.SIGKILL)
	})
}

// startEnv 起测试环境（后台），等它就绪：端口能连上，或档案里配的地址回 2xx、3xx。
// 进程在就绪前退出、超时、被停都算这一步没成；没成时当场回收。
func (s *testService) startEnv(ctx context.Context, r *TestRun, p plannedStep, vars map[string]string, env []string, lt *liveTest) (*bgProc, stepResult) {
	if s.listen(r.Port, extTimeout) {
		return nil, stepResult{err: fmt.Sprintf("端口 %d 已经有程序在监听：测试环境起不来，或者会连到别的程序上；先关掉它", r.Port)}
	}
	buf := &tailBuffer{}
	cmd := exec.Command("/bin/sh", "-c", expand(p.cmd.Command, vars))
	cmd.Dir, cmd.Env = p.dir, env
	cmd.Stdout, cmd.Stderr = buf, buf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		return nil, stepResult{err: "起不来：" + err.Error()}
	}
	bp := &bgProc{pgid: cmd.Process.Pid, buf: buf, exited: make(chan struct{})}
	go func() {
		bp.err = cmd.Wait()
		close(bp.exited)
	}()
	r.envPgid = bp.pgid
	s.save(ctx, r)

	check := readyCheck(p.cmd.Ready, vars, s.listen, r.Port)
	deadline := time.NewTimer(p.timeout)
	defer deadline.Stop()
	tick := time.NewTicker(readyPoll)
	defer tick.Stop()
	for {
		if check() {
			return bp, stepResult{ok: true, output: buf.tail()}
		}
		select {
		case <-bp.exited:
			bp.kill()
			code, sig := exitOf(bp.err)
			res := stepResult{output: buf.tail()}
			if sig == "" {
				res.exitCode = &code
				res.err = fmt.Sprintf("测试环境在就绪前退出了（退出码 %d）", code)
			} else {
				res.err = "测试环境在就绪前被信号 " + sig + " 结束"
			}
			return nil, res
		case <-deadline.C:
			bp.kill()
			return nil, stepResult{timedOut: true, output: buf.tail(), err: fmt.Sprintf("等了 %s 测试环境还没就绪（%s），已结束", humanDuration(p.timeout), readyLabel(p.cmd.Ready, vars))}
		case <-lt.stopCh:
			bp.kill()
			return nil, stepResult{stopped: true, output: buf.tail(), err: "手动停止"}
		case <-tick.C:
		}
	}
}

// readyCheck 是就绪检查：空串看 PORT 能不能连上；/ 开头 GET 本机 PORT 上的这个路径；完整地址 GET 它（只许本机）。
func readyCheck(ready string, vars map[string]string, listen func(int, time.Duration) bool, port int) func() bool {
	if ready == "" {
		return func() bool { return listen(port, extTimeout) }
	}
	target := expand(ready, vars)
	if strings.HasPrefix(target, "/") {
		target = "http://127.0.0.1:" + strconv.Itoa(port) + target
	}
	u, err := url.Parse(target)
	if err != nil || !loopbackHost(u.Hostname()) {
		return func() bool { return false }
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func() bool {
		resp, err := client.Get(target)
		if err != nil {
			return false
		}
		_ = resp.Body.Close()
		return resp.StatusCode >= 200 && resp.StatusCode < 400
	}
}

func readyLabel(ready string, vars map[string]string) string {
	if ready == "" {
		return "端口 " + vars["PORT"] + " 能连上"
	}
	target := expand(ready, vars)
	if strings.HasPrefix(target, "/") {
		target = "http://127.0.0.1:" + vars["PORT"] + target
	}
	u, err := url.Parse(target)
	if err != nil || !loopbackHost(u.Hostname()) {
		return target + " 不是本机地址，就绪检查只连本机"
	}
	return "GET " + target + " 回 2xx、3xx"
}

func loopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func humanDuration(d time.Duration) string {
	switch {
	case d >= time.Hour && d%time.Hour == 0:
		return strconv.Itoa(int(d/time.Hour)) + " 小时"
	case d >= time.Minute && d%time.Minute == 0:
		return strconv.Itoa(int(d/time.Minute)) + " 分钟"
	}
	return strconv.Itoa(int(d.Round(time.Second)/time.Second)) + " 秒"
}

// tailBuffer 收子进程输出，只留最后 bufferBytes 字节。
type tailBuffer struct {
	mu sync.Mutex
	b  []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > bufferBytes {
		t.b = append([]byte(nil), t.b[len(t.b)-bufferBytes:]...)
	}
	return len(p), nil
}

// tail 是输出尾部：最多 tailLines 行、tailBytes 字节，切在完整的字符上。
func (t *tailBuffer) tail() string {
	t.mu.Lock()
	b := append([]byte(nil), t.b...)
	t.mu.Unlock()
	return tailOf(string(b))
}

func tailOf(s string) string {
	s = strings.TrimRight(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	if len(s) > tailBytes {
		s = s[len(s)-tailBytes:]
		// 切在多字节字符中间时丢掉开头不完整的那几个字节
		for len(s) > 0 && s[0]&0xC0 == 0x80 {
			s = s[1:]
		}
	}
	lines := strings.Split(s, "\n")
	if len(lines) > tailLines {
		lines = lines[len(lines)-tailLines:]
	}
	return strings.ToValidUTF8(strings.Join(lines, "\n"), "?")
}

/* ---------- 停止、回收 ---------- */

// Stop 手动停一次测试：在本进程跑着的通知执行协程停下并等它收尾；记录是 running 但不在本进程里的（上次没收尾）
// 杀掉记下的进程组、记成 stopped。已经结束的原样回。
func (s *testService) Stop(ctx context.Context, id string) (TestRun, error) {
	s.mu.Lock()
	lt := s.live[id]
	s.mu.Unlock()
	if lt != nil {
		lt.stop(trStopped, "手动停止")
		select {
		case <-lt.done:
		case <-time.After(stopWait):
			s.c.Log().Warn("test run did not finish after stop", "test", id)
		}
		return s.get(ctx, id)
	}
	r, err := s.get(ctx, id)
	if err != nil || r.Status != trRunning {
		return r, err
	}
	s.abandon(ctx, r, trStopped, "手动停止")
	return s.get(ctx, id)
}

// abandon 收掉不在本进程里跑的 running 记录：杀掉记下的进程组，没跑完的步骤记 stopped / skipped。
func (s *testService) abandon(ctx context.Context, r TestRun, status, why string) {
	for _, g := range []int{r.pgid, r.envPgid} {
		if g > 0 {
			killGroupAsync(g)
		}
	}
	for i := range r.Steps {
		switch r.Steps[i].Status {
		case stRunning:
			r.Steps[i].Status, r.Steps[i].Error = stStopped, why
		case stPending:
			r.Steps[i].Status = stSkipped
		}
	}
	now := time.Now().UTC()
	r.Status, r.Error, r.FinishedAt, r.pgid, r.envPgid = status, why, &now, 0, 0
	s.save(ctx, &r)
}

func killGroupAsync(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	go func() {
		time.Sleep(killGrace)
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}()
}

// ensureReconciled：第一次用到时把表里 running、又不在本进程里的记录（工作台重启前没跑完的）记成 interrupted，杀掉记下的进程组。
func (s *testService) ensureReconciled(ctx context.Context) {
	s.reconcile.Do(func() {
		rows, err := s.list(ctx, "status = ?", []any{trRunning}, 200)
		if err != nil {
			s.c.Log().Warn("reconcile test runs failed", "err", err)
			return
		}
		for _, r := range rows {
			s.mu.Lock()
			_, mine := s.live[r.ID]
			s.mu.Unlock()
			if !mine {
				s.abandon(ctx, r, trInterrupted, "工作台重启过，这次测试没跑完；测试环境已回收")
			}
		}
		// 上次保留着的测试环境：进程不归本进程管了（拿不到它的输出、退出），按记下的进程组杀掉
		kept, err := s.list(ctx, "env_state = ?", []any{envKept}, 200)
		if err != nil {
			s.c.Log().Warn("reconcile kept test envs failed", "err", err)
			return
		}
		for _, r := range kept {
			s.mu.Lock()
			_, mine := s.kept[r.ID]
			s.mu.Unlock()
			if !mine {
				if _, err := s.release(ctx, r.ID, EnvRestart); err != nil {
					s.c.Log().Warn("release kept test env after restart failed", "test", r.ID, "err", err)
				}
			}
		}
	})
}

// closeAll 停掉本次启用起的全部测试（记 interrupted），之后不再接受新的。插件停用、服务关闭时调。
func (s *testService) closeAll() {
	s.mu.Lock()
	s.closed = true
	lts := make([]*liveTest, 0, len(s.live))
	for _, lt := range s.live {
		lts = append(lts, lt)
	}
	s.mu.Unlock()
	for _, lt := range lts {
		lt.stop(trInterrupted, "项目插件停用了，这次测试没跑完；测试环境已回收")
	}
	for _, lt := range lts {
		select {
		case <-lt.done:
		case <-time.After(stopWait):
		}
	}
	// 保留着的测试环境一起回收：插件不在了没人到点回收它们
	s.mu.Lock()
	ids := make([]string, 0, len(s.kept))
	for id := range s.kept {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		if _, err := s.release(context.Background(), id, EnvPluginStopped); err != nil {
			s.c.Log().Warn("release kept test env on stop failed", "test", id, "err", err)
		}
	}
}

/* ---------- 报告目录：截图、junit ---------- */

var shotExt = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

// collectShots 收约定报告目录里的截图（递归，按路径排序，最多 maxShots 张），回相对 out/ 的路径。
func collectShots(dir string) []string {
	out := []string{}
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || len(out) >= maxShots {
			return nil
		}
		if _, ok := shotExt[strings.ToLower(filepath.Ext(p))]; !ok || !d.Type().IsRegular() {
			return nil
		}
		if rel, err := filepath.Rel(dir, p); err == nil {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	slices.Sort(out)
	return out
}

/* ---------- 产出 ---------- */

// recordArtifacts 把报告和截图登记为任务的产出；登记失败只记日志。
func (s *testService) recordArtifacts(ctx context.Context, r TestRun) []string {
	ids := []string{}
	props := map[string]any{"test_run_id": r.ID, "test_status": r.Status}
	if r.ReportPath != "" {
		id, err := s.c.Artifacts().Record(ctx, plugin.NewArtifact{ObjectID: r.TaskID, Title: "测试报告 " + r.TaskRef + "（" + statusLabel(r.Status) + "）",
			Path: r.ReportPath, BaseDir: r.RunDir, Kind: "doc", Props: props})
		if err != nil {
			s.c.Log().Warn("record test report artifact failed", "test", r.ID, "err", err)
		} else {
			ids = append(ids, id)
		}
	}
	out := filepath.Join(r.RunDir, ReportOutDir)
	for _, name := range r.Shots {
		id, err := s.c.Artifacts().Record(ctx, plugin.NewArtifact{ObjectID: r.TaskID, Title: "测试截图 " + name,
			Path: filepath.Join(out, filepath.FromSlash(name)), BaseDir: r.RunDir, Kind: "other", Props: props})
		if err != nil {
			s.c.Log().Warn("record test screenshot artifact failed", "test", r.ID, "shot", name, "err", err)
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

func statusLabel(st string) string {
	switch st {
	case trPassed:
		return "通过"
	case trFailed:
		return "没通过"
	case trStopped:
		return "已停止"
	case trInterrupted:
		return "没跑完"
	}
	return "进行中"
}

/* ---------- SOP 节点 ---------- */

// runNode 是「跑测试」：config.task 是任务 id 或 ref（支持 {{字段}}），留空依次取输入的 task_id、task.id、worktree.task_id。
// 起测试后挂起，跑完由 notify 唤醒；同一次执行、同一步、同一次尝试再进来（服务重启后重跑）不重复起：跑完了直接回结果。
func (s *testService) runNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	s.ensureReconciled(ctx)
	if n.RunID != "" {
		rows, err := s.list(ctx, "sop_run_id = ? AND sop_step = ? AND sop_attempt = ?", []any{n.RunID, n.Step, n.Attempt}, 1)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			r := rows[0]
			if r.Status == trRunning {
				return nil, fmt.Errorf("等任务 %s 的测试跑完：%w", r.TaskRef, plugin.ErrWaiting)
			}
			s.markNotified(ctx, r.ID)
			return with(n.Input, map[string]any{"test": s.sopOutput(r)}), nil
		}
	}
	key := strings.TrimSpace(render(n.Config["task"], n.Input))
	if strings.TrimSpace(n.Config["task"]) == "" {
		key = firstNonEmpty(txt(getPath(n.Input, "task_id")), txt(getPath(n.Input, "task.id")), txt(getPath(n.Input, "worktree.task_id")))
	}
	if key == "" {
		return nil, errors.New("没有指定任务：在「任务」里填 {{字段}}，或者确认输入里有 task_id")
	}
	keep, err := s.keepOf(ctx, render(n.Config["keep_env"], n.Input))
	if err != nil {
		return nil, err
	}
	r, err := s.Start(ctx, key, &sopRef{runID: n.RunID, step: n.Step, attempt: n.Attempt, input: n.Input}, keep)
	if err != nil {
		_, msg, _ := strings.Cut(err.Error(), ": ")
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New("测试没起来：" + msg)
	}
	if n.RunID == "" {
		// 没有执行 id（不是 SOP 引擎调的）没法唤醒：等它跑完直接回
		s.mu.Lock()
		lt := s.live[r.ID]
		s.mu.Unlock()
		if lt != nil {
			select {
			case <-lt.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		r, err = s.get(ctx, r.ID)
		if err != nil {
			return nil, err
		}
		return with(n.Input, map[string]any{"test": s.sopOutput(r)}), nil
	}
	return nil, fmt.Errorf("等任务 %s 的测试跑完：%w", r.TaskRef, plugin.ErrWaiting)
}

// sopOutput 是节点输出里的 test。下游条件分支、条件回退按 test.ok 走。
// 另加给通知用的 report_url（报告链接）、env_kept、env_keep_until、env_text（测试环境地址和保留情况的一句话，AUTO-09）。
func (s *testService) sopOutput(r TestRun) map[string]any {
	steps := make([]any, 0, len(r.Steps))
	for _, st := range r.Steps {
		m := map[string]any{"key": st.Key, "label": st.Label, "status": st.Status, "duration_ms": st.DurationMs,
			"timed_out": st.TimedOut, "error": st.Error, "output": st.Output}
		if st.ExitCode != nil {
			m["exit_code"] = *st.ExitCode
		} else {
			m["exit_code"] = nil
		}
		steps = append(steps, m)
	}
	out := map[string]any{"ok": r.Status == trPassed, "status": r.Status, "id": r.ID, "task_id": r.TaskID, "task_ref": r.TaskRef,
		"report_path": r.ReportPath, "port": r.Port, "steps": steps, "artifact_ids": anyStrs(r.ArtifactIDs), "shots": anyStrs(r.Shots)}
	if r.URL != "" {
		out["url"] = r.URL
	}
	if r.FailedStep != "" {
		out["failed_step"] = r.FailedStep
	}
	if r.Error != "" {
		out["error"] = r.Error
	}
	if r.Junit != nil {
		out["junit"] = map[string]any{"files": r.Junit.Files, "tests": r.Junit.Tests, "failures": r.Junit.Failures,
			"errors": r.Junit.Errors, "skipped": r.Junit.Skipped, "failed": anyStrs(r.Junit.Failed)}
	}
	out["report_url"] = ""
	if r.ReportPath != "" {
		out["report_url"] = s.publicURL + "/api/projects/tests/runs/" + url.PathEscape(r.ID) + "/report"
	}
	out["env_kept"] = r.EnvState == envKept
	out["env_keep_until"] = ""
	if r.EnvState == envKept && r.EnvKeepUntil != nil {
		out["env_keep_until"] = r.EnvKeepUntil.Format(time.RFC3339)
	}
	out["env_text"] = envText(r)
	return out
}

// envText 是测试环境的一句话，拼进通知：地址和保留到什么时候。
func envText(r TestRun) string {
	switch {
	case r.URL == "":
		return "（这次没有起测试环境：项目档案里没有起测试环境命令）"
	case r.EnvState == envKept && r.EnvKeepUntil != nil:
		return fmt.Sprintf("%s（保留到 %s，到点自动回收）", r.URL, localTime(*r.EnvKeepUntil))
	case r.EnvState == envReleased:
		return fmt.Sprintf("%s（已回收：%s）", r.URL, envReasonLabel(r.EnvReleaseReason))
	}
	return r.URL + "（测试跑完已回收）"
}

// localTime 是给人看的本机时间。
func localTime(t time.Time) string { return t.Local().Format("2006-01-02 15:04") }

func envReasonLabel(reason string) string {
	switch reason {
	case EnvExpired:
		return "保留时间到了"
	case EnvAccepted:
		return "验收通过"
	case EnvStageChanged:
		return "验收结束"
	case EnvTaskDone:
		return "任务完成或取消"
	case EnvWorktreeGone:
		return "工作区清理了"
	case EnvRerun:
		return "又跑了一次测试"
	case EnvManual:
		return "手动回收"
	case EnvExited:
		return "测试环境自己退出了"
	case EnvRestart:
		return "工作台重启过"
	case EnvPluginStopped:
		return "项目插件停用或工作台关闭"
	}
	return reason
}

// notify 唤醒 SOP 挂起的步骤：输出是当初的输入加 test。唤醒不上留着，notifyPending 重试，跑完一小时还唤醒不上就不再试。
func (s *testService) notify(ctx context.Context, id string) {
	r, err := s.get(ctx, id)
	if err != nil || r.SopRunID == "" || r.notified || r.Status == trRunning {
		return
	}
	var input map[string]any
	_ = json.Unmarshal([]byte(r.sopInput), &input)
	if err := s.c.SOP().Resume(ctx, r.SopRunID, r.sopStep, with(input, map[string]any{"test": s.sopOutput(r)})); err != nil {
		if r.FinishedAt != nil && time.Since(*r.FinishedAt) > notifyGiveUp {
			s.c.Log().Warn("give up resuming sop step for test run", "test", r.ID, "run", r.SopRunID, "step", r.sopStep, "err", err)
			s.markNotified(ctx, r.ID)
		} else {
			s.c.Log().Debug("resume sop step for test run failed, retry later", "test", r.ID, "err", err)
		}
		return
	}
	s.markNotified(ctx, r.ID)
}

func (s *testService) notifyPending(ctx context.Context) error {
	rows, err := s.list(ctx, "sop_run_id <> '' AND sop_notified = 0 AND status <> ?", []any{trRunning}, 50)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.notify(ctx, r.ID)
	}
	return nil
}

func (s *testService) markNotified(ctx context.Context, id string) {
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_test_runs SET sop_notified = 1 WHERE id = ?`, id); err != nil {
		s.c.Log().Warn("mark test run notified failed", "test", id, "err", err)
	}
}

/* ---------- 读写记录 ---------- */

const testRunCols = `id, task_id, task_ref, project_id, worktree_id, workdir, port, port_start, port_end, url, status, steps, failed_step,
	error, run_dir, report_path, artifact_ids, shots, junit, pgid, env_pgid, source, sop_run_id, sop_step, sop_attempt, sop_input,
	sop_notified, started_at, finished_at, updated_at, env_state, env_keep_until, env_released_at, env_release_reason`

func scanTestRun(row plugin.Row) (TestRun, error) {
	var r TestRun
	var steps, arts, shots, junit, started, updated string
	var finished, keepUntil, releasedAt *string
	if err := row.Scan(&r.ID, &r.TaskID, &r.TaskRef, &r.ProjectID, &r.WorktreeID, &r.Workdir, &r.Port, &r.PortStart, &r.PortEnd, &r.URL,
		&r.Status, &steps, &r.FailedStep, &r.Error, &r.RunDir, &r.ReportPath, &arts, &shots, &junit, &r.pgid, &r.envPgid, &r.Source,
		&r.SopRunID, &r.sopStep, &r.sopAttempt, &r.sopInput, &r.notified, &started, &finished, &updated,
		&r.EnvState, &keepUntil, &releasedAt, &r.EnvReleaseReason); err != nil {
		return TestRun{}, err
	}
	r.EnvKeepUntil, r.EnvReleasedAt = parseTimePtr(keepUntil), parseTimePtr(releasedAt)
	_ = json.Unmarshal([]byte(steps), &r.Steps)
	_ = json.Unmarshal([]byte(arts), &r.ArtifactIDs)
	_ = json.Unmarshal([]byte(shots), &r.Shots)
	if junit != "" {
		var j JunitSummary
		if json.Unmarshal([]byte(junit), &j) == nil {
			r.Junit = &j
		}
	}
	if r.Steps == nil {
		r.Steps = []TestStep{}
	}
	if r.ArtifactIDs == nil {
		r.ArtifactIDs = []string{}
	}
	if r.Shots == nil {
		r.Shots = []string{}
	}
	r.StartedAt, _ = time.Parse(time.RFC3339, started)
	r.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	if finished != nil {
		if t, err := time.Parse(time.RFC3339, *finished); err == nil {
			r.FinishedAt = &t
		}
	}
	return r, nil
}

func (s *testService) get(ctx context.Context, id string) (TestRun, error) {
	r, err := scanTestRun(s.c.Store().QueryRow(ctx, `SELECT `+testRunCols+` FROM projects_test_runs WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return TestRun{}, apiErr(errNotFound, "测试 %s 不存在", id)
	}
	return r, err
}

func (s *testService) list(ctx context.Context, where string, args []any, limit int) ([]TestRun, error) {
	rows, err := s.c.Store().Query(ctx, `SELECT `+testRunCols+` FROM projects_test_runs WHERE `+where+
		` ORDER BY started_at DESC, id DESC LIMIT `+strconv.Itoa(limit), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []TestRun{}
	for rows.Next() {
		r, err := scanTestRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// save 把执行中的变化写回表并发事件。写失败只记日志：执行不因为记录写不上停下。
func (s *testService) save(ctx context.Context, r *TestRun) {
	now := time.Now().UTC()
	r.UpdatedAt = now
	var fin any
	if r.FinishedAt != nil {
		fin = r.FinishedAt.Format(time.RFC3339)
	}
	junit := ""
	if r.Junit != nil {
		junit = encJSON(r.Junit)
	}
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_test_runs SET status = ?, steps = ?, failed_step = ?, error = ?, report_path = ?,
		artifact_ids = ?, shots = ?, junit = ?, pgid = ?, env_pgid = ?, finished_at = ?, updated_at = ?,
		env_state = ?, env_keep_until = ?, env_released_at = ?, env_release_reason = ? WHERE id = ?`,
		r.Status, encJSON(r.Steps), r.FailedStep, r.Error, r.ReportPath, encJSON(orEmptyStrs(r.ArtifactIDs)), encJSON(orEmptyStrs(r.Shots)), junit,
		r.pgid, r.envPgid, fin, now.Format(time.RFC3339), r.EnvState, timeCol(r.EnvKeepUntil), timeCol(r.EnvReleasedAt), r.EnvReleaseReason,
		r.ID); err != nil {
		s.c.Log().Warn("save test run failed", "test", r.ID, "err", err)
	}
	s.publish(*r)
}

func (s *testService) publish(r TestRun) {
	_ = s.c.Events().Publish(context.Background(), testChanged, map[string]any{"id": r.ID, "task_id": r.TaskID, "project_id": r.ProjectID, "status": r.Status})
}

func encJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

func orEmptyStrs(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

func orEmptyMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

/* ---------- 接口 ---------- */

type testAPI struct {
	*stakeholders
	s *testService
}

func (a *testAPI) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := strings.TrimSpace(q.Get("task_id")); v != "" {
		where, args = append(where, "task_id = ?"), append(args, v)
	}
	if v := strings.TrimSpace(q.Get("project_id")); v != "" {
		where, args = append(where, "project_id = ?"), append(args, v)
	}
	switch v := strings.TrimSpace(q.Get("status")); v {
	case "", "all":
	case trRunning, trPassed, trFailed, trStopped, trInterrupted:
		where, args = append(where, "status = ?"), append(args, v)
	default:
		a.fail(w, r, apiErr(errValidation, "status must be running, passed, failed, stopped, interrupted or all"))
		return
	}
	limit := 20
	if v := strings.TrimSpace(q.Get("limit")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			a.fail(w, r, apiErr(errValidation, "limit must be between 1 and 200"))
			return
		}
		limit = n
	}
	a.s.ensureReconciled(r.Context())
	out, err := a.s.list(r.Context(), strings.Join(where, " AND "), args, limit)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (a *testAPI) start(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskID    string `json:"task_id"`
		KeepEnv   bool   `json:"keep_env"`
		KeepHours *int   `json:"keep_hours"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	var keep time.Duration
	if in.KeepEnv {
		if in.KeepHours != nil {
			if *in.KeepHours < 1 || *in.KeepHours > maxEnvKeepHours {
				a.fail(w, r, apiErr(errValidation, "keep_hours 要在 1 到 %d 之间", maxEnvKeepHours))
				return
			}
			keep = time.Duration(*in.KeepHours) * time.Hour
		} else {
			ps, err := a.s.wt.settingsOf(r.Context())
			if err != nil {
				a.fail(w, r, err)
				return
			}
			keep = time.Duration(ps.EnvKeepHours) * time.Hour
		}
	}
	out, err := a.s.Start(r.Context(), in.TaskID, nil, keep)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": out})
}

func (a *testAPI) show(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.get(r.Context(), r.PathValue("test_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// release 手动回收保留着的测试环境；没保留、已经回收的原样回。
func (a *testAPI) release(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.release(r.Context(), r.PathValue("test_id"), EnvManual)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (a *testAPI) stop(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.Stop(r.Context(), r.PathValue("test_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// report 回报告原文（Markdown，按纯文本给浏览器看）。还没写出来 404。
func (a *testAPI) report(w http.ResponseWriter, r *http.Request) {
	t, err := a.s.get(r.Context(), r.PathValue("test_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if t.ReportPath == "" {
		a.fail(w, r, apiErr(errNotFound, "这次测试还没有报告"))
		return
	}
	b, err := os.ReadFile(t.ReportPath)
	if err != nil {
		a.fail(w, r, apiErr(errNotFound, "报告文件不在了：%s", t.ReportPath))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	_, _ = w.Write(b)
}

// shot 回一张截图：只认这次测试收进来的（shots 里有的），不按路径随便读。
func (a *testAPI) shot(w http.ResponseWriter, r *http.Request) {
	t, err := a.s.get(r.Context(), r.PathValue("test_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	name := r.PathValue("name")
	if !slices.Contains(t.Shots, name) {
		a.fail(w, r, apiErr(errNotFound, "截图 %s 不在这次测试里", name))
		return
	}
	p := filepath.Join(t.RunDir, ReportOutDir, filepath.FromSlash(name))
	b, err := os.ReadFile(p)
	if err != nil {
		a.fail(w, r, apiErr(errNotFound, "截图文件不在了：%s", p))
		return
	}
	w.Header().Set("Content-Type", shotExt[strings.ToLower(filepath.Ext(name))])
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	_, _ = w.Write(b)
}
