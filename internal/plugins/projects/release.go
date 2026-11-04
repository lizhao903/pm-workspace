package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 发布（AUTO-10，docs/auto-delivery-flow.md 第 1 节第 9 段）：在任务在用的工作区（worktrees.go）上按项目档案的命令分两段跑，
// 子进程的执行口径同测试环境（testenv.go 的 runForeground、childEnv：白名单环境、各自的进程组、超时、输出尾部）。
//
//   - 准备（prepare）：版本号与更新日志（version）→ 打包（package）。只在工作区里跑，不碰生产；跑完停在 prepared，等上线审批。
//     两段的命令在准备时一起定下来写进 steps，审批的人看到的就是之后要跑的。
//   - 上线（deploy）：审批通过才能起（接口 POST …/deploy 或 SOP 节点 projects_release，记 approved_at、approved_by），
//     发布前检查（preflight：备份数据库、核对密钥等，档案里写什么跑什么）→ 发布（release）→ 线上冒烟（prod_smoke）。
//     发布或线上冒烟没过时自动跑回滚（rollback），记 rollback_state；发布前检查没过时生产还没动，不回滚。
//
// 表 projects_releases（迁移 0009）。报告放数据目录下 releases/<项目 id>/<任务编号>/<发布 id>/report.md，
// 约定目录是同一目录下的 out/，经环境变量 RELEASE_DIR 交给命令：version 那步把版本号写进 version.txt、更新日志写进 changelog.md。
//
// SOP 节点：projects_prepare_release（准备发布）、projects_release（上线），都挂起等跑完，同 projects_run_test 的口径；
// 输出加 release: {ok, status, …}。事件 projects.release_changed。
// 同一任务同时只有一次在跑；同一项目同时只有一次在上线（两个任务一起往生产发会互相盖）。

const (
	NodePrepareRelease = "projects_prepare_release"
	NodeRelease        = "projects_release"
	releaseChanged     = "projects.release_changed"

	// 一次发布的状态
	rlRunning        = "running"
	rlPrepared       = "prepared"
	rlReleased       = "released"
	rlFailed         = "failed"
	rlRolledBack     = "rolled_back"
	rlRollbackFailed = "rollback_failed"
	rlStopped        = "stopped"
	rlInterrupted    = "interrupted"
	rlCancelled      = "cancelled"

	phasePrepare = "prepare"
	phaseDeploy  = "deploy"

	// 回滚情况
	rbDone        = "done"
	rbFailed      = "failed"
	rbUnavailable = "unavailable"

	// ReleasesSubdir 是发布报告在数据目录下的目录名，和 worktrees/、test-reports/ 同级。
	ReleasesSubdir = "releases"
	versionFile    = "version.txt"
	changelogFile  = "changelog.md"

	maxVersion   = 100
	maxChangelog = 20000
)

// releaseStepKeys 是发布跑的档案命令，顺序即执行顺序；rollback 只在发布或线上冒烟没过时跑。
var releaseStepKeys = []string{"version", "package", "preflight", "release", "prod_smoke", "rollback"}

var releaseStepLabels = map[string]string{"version": "版本号与更新日志", "package": "打包", "preflight": "发布前检查", "release": "发布",
	"prod_smoke": "线上冒烟", "rollback": "回滚"}

// releasePhaseOf 是每步属于哪一段。
func releasePhaseOf(key string) string {
	if key == "version" || key == "package" {
		return phasePrepare
	}
	return phaseDeploy
}

var releaseDefaultTimeout = map[string]time.Duration{"version": 5 * time.Minute, "package": 30 * time.Minute, "preflight": 10 * time.Minute,
	"release": 30 * time.Minute, "prod_smoke": 5 * time.Minute, "rollback": 30 * time.Minute}

// ReleaseStep 是一次发布里的一步，字段同 TestStep，另有 phase 和 timeout_sec。
type ReleaseStep struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// Phase 是 prepare（审批前）或 deploy（审批后）
	Phase string `json:"phase"`
	// Command 是换过占位的命令；上线段的在执行时再换一次（版本号要等 version 那步跑完）
	Command    string     `json:"command"`
	Dir        string     `json:"dir"`
	TimeoutSec int        `json:"timeout_sec"`
	Status     string     `json:"status"`
	ExitCode   *int       `json:"exit_code"`
	DurationMs int64      `json:"duration_ms"`
	TimedOut   bool       `json:"timed_out"`
	Output     string     `json:"output"`
	Error      string     `json:"error"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

// Release 是一次发布。
type Release struct {
	ID            string        `json:"id"`
	TaskID        string        `json:"task_id"`
	TaskRef       string        `json:"task_ref"`
	ProjectID     string        `json:"project_id"`
	WorktreeID    string        `json:"worktree_id"`
	Workdir       string        `json:"workdir"`
	Status        string        `json:"status"`
	Phase         string        `json:"phase"`
	Version       string        `json:"version"`
	Changelog     string        `json:"changelog"`
	Steps         []ReleaseStep `json:"steps"`
	FailedStep    string        `json:"failed_step"`
	Error         string        `json:"error"`
	RollbackState string        `json:"rollback_state"`
	RunDir        string        `json:"run_dir"`
	ReportPath    string        `json:"report_path"`
	ArtifactIDs   []string      `json:"artifact_ids"`
	Source        string        `json:"source"`
	ApprovedAt    *time.Time    `json:"approved_at"`
	ApprovedBy    string        `json:"approved_by"`
	SopRunID      string        `json:"sop_run_id"`
	StartedAt     time.Time     `json:"started_at"`
	FinishedAt    *time.Time    `json:"finished_at"`
	UpdatedAt     time.Time     `json:"updated_at"`

	sopStep    string
	sopAttempt int
	sopInput   string
	notified   bool
	pgid       int
	prepKey    string
	deployKey  string
}

type releaseService struct {
	c         plugin.Core
	wt        *worktreeService
	mu        sync.Mutex
	closed    bool
	live      map[string]*liveTest
	publicURL string
	reconcile sync.Once
}

func newReleaseService(c plugin.Core, wt *worktreeService, publicURL string) *releaseService {
	return &releaseService{c: c, wt: wt, live: map[string]*liveTest{}, publicURL: publicURL}
}

func (s *releaseService) register(r plugin.Registrar, h *stakeholders) {
	r.Routes(func(m plugin.RouteRegistrar) {
		api := &releaseAPI{h, s}
		m.HandleFunc("GET /api/projects/releases", api.list)
		m.HandleFunc("POST /api/projects/releases", api.prepare)
		m.HandleFunc("GET /api/projects/releases/runs/{release_id}", api.show)
		m.HandleFunc("POST /api/projects/releases/runs/{release_id}/deploy", api.deploy)
		m.HandleFunc("POST /api/projects/releases/runs/{release_id}/stop", api.stop)
		m.HandleFunc("GET /api/projects/releases/runs/{release_id}/report", api.report)
	})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodePrepareRelease, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.prepareNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeRelease, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.deployNode})
	r.Job(plugin.Job{Name: "release_sop_notify", Every: notifyEvery, Run: func(ctx context.Context, _ plugin.Core) error {
		s.ensureReconciled(ctx)
		return s.notifyPending(ctx)
	}})
	r.Job(plugin.Job{Name: "releases", Run: func(ctx context.Context, _ plugin.Core) error {
		s.ensureReconciled(ctx)
		<-ctx.Done()
		s.closeAll()
		return nil
	}})
}

/* ---------- 准备 ---------- */

// Prepare 给任务起一次发布的准备段，立刻返回（running），执行在后台。key 是任务 id 或 ref。
// 档案里没有发布命令时 400：没有发布命令就没什么可审批的。同一任务之前准备好、还在等审批的作废（cancelled）。
func (s *releaseService) Prepare(ctx context.Context, key string, sop *sopRef) (Release, error) {
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return Release{}, apiErr(errConflict, "%s", err.Error())
	}
	s.ensureReconciled(ctx)
	base := s.c.WorktreeDir()
	if base == "" {
		return Release{}, apiErr(errConflict, "工作台没有数据目录，发不了布")
	}
	task, err := s.wt.task(ctx, key)
	if err != nil {
		return Release{}, err
	}
	w, err := s.wt.activeOf(ctx, task.ID)
	if errors.Is(err, plugin.ErrNoRows) {
		return Release{}, apiErr(errConflict, "任务 %s 没有在用的工作区：发布在任务的工作区里跑，先准备工作区", refOr(task))
	}
	if err != nil {
		return Release{}, err
	}
	w = fill(w)
	if !w.Exists {
		return Release{}, apiErr(errConflict, "工作区目录 %s 不在了：先再准备一次工作区", w.Root)
	}
	h := &profiles{&stakeholders{c: s.c}}
	proj, err := h.liveProject(ctx, w.ProjectID)
	if err != nil {
		return Release{}, apiErr(errConflict, "工作区所属的项目不在了")
	}
	prof, err := h.load(ctx, proj)
	if err != nil {
		return Release{}, err
	}
	if c, ok := prof.Commands["release"]; !ok || strings.TrimSpace(c.Command) == "" {
		return Release{}, apiErr(errValidation, "项目档案里没有发布命令：先到项目的档案里填「发布」")
	}
	root, err := filepath.EvalSymlinks(w.Root)
	if err != nil {
		return Release{}, apiErr(errConflict, "工作区目录 %s 读不了：%v", w.Root, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Release{}, apiErr(errConflict, "项目插件正在停用，不能再起发布")
	}
	var running string
	err = s.c.Store().QueryRow(ctx, `SELECT id FROM projects_releases WHERE task_id = ? AND status = ?`, task.ID, rlRunning).Scan(&running)
	if err == nil {
		return Release{}, apiErr(errConflict, "任务 %s 的发布正在跑（%s）：等它跑完或先停掉", refOr(task), running)
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return Release{}, err
	}

	now := time.Now().UTC()
	id := idgen.Prefixed("rel")
	runDir := filepath.Join(filepath.Dir(base), ReleasesSubdir, safeSeg(w.ProjectID), safeSeg(w.TaskRef), id)
	if err := os.MkdirAll(filepath.Join(runDir, ReportOutDir), 0o755); err != nil {
		return Release{}, fmt.Errorf("create release dir: %w", err)
	}
	r := Release{ID: id, TaskID: task.ID, TaskRef: w.TaskRef, ProjectID: w.ProjectID, WorktreeID: w.ID, Workdir: w.Path,
		Status: rlRunning, Phase: phasePrepare, RunDir: runDir, ArtifactIDs: []string{}, Source: "api", StartedAt: now, UpdatedAt: now}
	vars := r.vars()
	delete(vars, "RELEASE_VERSION") // 版本号要等 version 那步跑完，占位留到执行时再换
	for _, k := range releaseStepKeys {
		c, ok := prof.Commands[k]
		if !ok || strings.TrimSpace(c.Command) == "" {
			continue
		}
		dir, err := stepDir(w, root, releaseStepLabels[k], c)
		if err != nil {
			return Release{}, err
		}
		sec := c.TimeoutSec
		if sec <= 0 {
			sec = int(releaseDefaultTimeout[k] / time.Second)
		}
		r.Steps = append(r.Steps, ReleaseStep{Key: k, Label: releaseStepLabels[k], Phase: releasePhaseOf(k), Command: expand(c.Command, vars),
			Dir: dir, TimeoutSec: sec, Status: stPending})
	}
	input := "{}"
	if sop != nil {
		r.Source, r.SopRunID, r.sopStep, r.sopAttempt = "sop", sop.runID, sop.step, sop.attempt
		if b, err := json.Marshal(orEmptyMap(sop.input)); err == nil {
			input = string(b)
		}
		r.sopInput, r.prepKey = input, sopKey(sop)
	}
	// 同一任务准备好、还在等审批的作废：审批只认最新这次定下的命令
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_releases SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE task_id = ? AND status = ?`,
		rlCancelled, "又准备了一次发布，这次作废", now.Format(time.RFC3339), now.Format(time.RFC3339), task.ID, rlPrepared); err != nil {
		return Release{}, err
	}
	ts := now.Format(time.RFC3339)
	if _, err := s.c.Store().Exec(ctx, `INSERT INTO projects_releases
		(id, task_id, task_ref, project_id, worktree_id, workdir, status, phase, steps, run_dir, source,
		 sop_run_id, sop_step, sop_attempt, sop_input, prep_key, started_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.TaskID, r.TaskRef, r.ProjectID, r.WorktreeID, r.Workdir, r.Status, r.Phase, encJSON(r.Steps), r.RunDir, r.Source,
		r.SopRunID, r.sopStep, r.sopAttempt, input, r.prepKey, ts, ts); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return Release{}, apiErr(errConflict, "任务 %s 的发布正在跑：等它跑完或先停掉", refOr(task))
		}
		return Release{}, err
	}
	lt := &liveTest{id: id, stopCh: make(chan struct{}), done: make(chan struct{})}
	s.live[id] = lt
	s.publish(r)
	ret := r
	ret.Steps = slices.Clone(r.Steps)
	go s.execute(r, task.Title, w.Branch, lt)
	return ret, nil
}

// stepDir 解析一条命令的执行目录：执行目录加档案的 dir，解开软链后还要在 worktree 里。
func stepDir(w Worktree, root, label string, c Command) (string, error) {
	dir := filepath.Join(w.Path, c.Dir)
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", apiErr(errValidation, "%s命令的目录 %s 在工作区里不存在", label, dir)
	}
	if real != root && !within(root, real) {
		return "", apiErr(errValidation, "%s命令的目录 %s 跑出了工作区", label, dir)
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", apiErr(errValidation, "%s命令的目录 %s 不是文件夹", label, dir)
	}
	return dir, nil
}

func sopKey(sop *sopRef) string { return fmt.Sprintf("%s/%s#%d", sop.runID, sop.step, sop.attempt) }

/* ---------- 上线 ---------- */

// Deploy 是上线审批通过：只认准备好（prepared）的发布，记审批，在后台跑上线段。by 是审批来源（sop:<执行 id> 或 api）。
func (s *releaseService) Deploy(ctx context.Context, id, by string, sop *sopRef) (Release, error) {
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return Release{}, apiErr(errConflict, "%s", err.Error())
	}
	s.ensureReconciled(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Release{}, apiErr(errConflict, "项目插件正在停用，不能再起发布")
	}
	r, err := s.get(ctx, id)
	if err != nil {
		return Release{}, err
	}
	if r.Status != rlPrepared {
		return Release{}, apiErr(errConflict, "发布 %s 现在是「%s」：只有准备好、等审批的发布才能上线", r.ID, releaseStatusLabel(r.Status))
	}
	var other string
	err = s.c.Store().QueryRow(ctx, `SELECT id FROM projects_releases WHERE project_id = ? AND status = ? AND phase = ? AND id <> ?`,
		r.ProjectID, rlRunning, phaseDeploy, r.ID).Scan(&other)
	if err == nil {
		return Release{}, apiErr(errConflict, "这个项目另有一次发布正在上线（%s）：等它结束再上", other)
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return Release{}, err
	}
	if st, err := os.Stat(r.Workdir); err != nil || !st.IsDir() {
		return Release{}, apiErr(errConflict, "工作区目录 %s 不在了：重新准备工作区后再准备一次发布", r.Workdir)
	}
	now := time.Now().UTC()
	r.Status, r.Phase, r.ApprovedAt, r.ApprovedBy, r.FinishedAt = rlRunning, phaseDeploy, &now, by, nil
	input := r.sopInput
	if sop != nil {
		if b, err := json.Marshal(orEmptyMap(sop.input)); err == nil {
			input = string(b)
		}
		r.Source, r.SopRunID, r.sopStep, r.sopAttempt, r.sopInput, r.notified, r.deployKey = "sop", sop.runID, sop.step, sop.attempt, input, false, sopKey(sop)
	} else {
		// 接口审批的不唤醒谁：准备段的 SOP 早就回过结果了
		r.SopRunID, r.sopStep, r.sopAttempt, r.notified = "", "", 0, true
	}
	ts := now.Format(time.RFC3339)
	res, err := s.c.Store().Exec(ctx, `UPDATE projects_releases SET status = ?, phase = ?, approved_at = ?, approved_by = ?, finished_at = NULL,
		source = ?, sop_run_id = ?, sop_step = ?, sop_attempt = ?, sop_input = ?, sop_notified = ?, deploy_key = ?, updated_at = ?
		WHERE id = ? AND status = ?`,
		r.Status, r.Phase, ts, by, r.Source, r.SopRunID, r.sopStep, r.sopAttempt, input, boolInt(r.notified), r.deployKey, ts, r.ID, rlPrepared)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return Release{}, apiErr(errConflict, "任务 %s 的发布正在跑：等它跑完或先停掉", r.TaskRef)
		}
		return Release{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Release{}, apiErr(errConflict, "发布 %s 刚被别人处理了：刷新看看", r.ID)
	}
	lt := &liveTest{id: id, stopCh: make(chan struct{}), done: make(chan struct{})}
	s.live[id] = lt
	s.publish(r)
	ret := r
	ret.Steps = slices.Clone(r.Steps)
	branch := ""
	if w, err := s.wt.get(ctx, r.WorktreeID); err == nil {
		branch = w.Branch
	}
	title := ""
	if o, err := s.c.Objects().Get(ctx, r.TaskID); err == nil {
		title = o.Title
	}
	go s.execute(r, title, branch, lt)
	return ret, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

/* ---------- 执行 ---------- */

// vars 是注入子进程的变量，命令里也能写 {{RELEASE_VERSION}} 这类占位。
func (r Release) vars() map[string]string {
	return map[string]string{
		"WORKTREE":        r.Workdir,
		"TASK_REF":        r.TaskRef,
		"RELEASE_ID":      r.ID,
		"RELEASE_DIR":     filepath.Join(r.RunDir, ReportOutDir),
		"RELEASE_VERSION": r.Version,
	}
}

// execute 跑当前段（r.Phase）的步骤：失败后面的跳过；上线段发布或线上冒烟没过时跑回滚。最后写报告、唤醒 SOP。
func (s *releaseService) execute(r Release, taskTitle, branch string, lt *liveTest) {
	ctx := context.Background()
	defer func() {
		s.mu.Lock()
		delete(s.live, r.ID)
		s.mu.Unlock()
		close(lt.done)
	}()
	phase := r.Phase
	for i := range r.Steps {
		st := &r.Steps[i]
		if st.Phase != phase || st.Key == "rollback" {
			continue
		}
		if r.FailedStep != "" {
			st.Status = stSkipped
			continue
		}
		if reason, note, ok := lt.stopped(); ok {
			st.Status = stSkipped
			if r.Status == rlRunning {
				r.Status, r.Error = reason, note
			}
			continue
		}
		s.runStep(ctx, &r, st, lt)
		if st.Key == "version" && st.Status == stPassed {
			r.Version, r.Changelog = readVersion(filepath.Join(r.RunDir, ReportOutDir), st.Output)
			s.save(ctx, &r)
		}
	}
	if phase == phaseDeploy && r.Status == rlRunning && (r.FailedStep == "release" || r.FailedStep == "prod_smoke") {
		s.rollback(ctx, &r, lt)
	}
	if r.Status == rlRunning {
		switch {
		case r.FailedStep != "":
			r.Status = rlFailed
		case phase == phasePrepare:
			r.Status = rlPrepared
		default:
			r.Status = rlReleased
		}
	}
	// 没跑到的都记 skipped：准备段没过、停了，上线段整段不跑；不需要回滚时回滚那步也不跑
	if r.Status != rlPrepared {
		for i := range r.Steps {
			if r.Steps[i].Status == stPending {
				r.Steps[i].Status = stSkipped
			}
		}
	}
	now := time.Now().UTC()
	r.FinishedAt = &now
	r.ReportPath = filepath.Join(r.RunDir, reportFile)
	if err := os.WriteFile(r.ReportPath, []byte(renderReleaseReport(r, taskTitle, branch)), 0o644); err != nil {
		s.c.Log().Warn("write release report failed", "release", r.ID, "err", err)
		r.ReportPath = ""
	}
	if r.Status != rlPrepared {
		r.ArtifactIDs = s.recordArtifact(ctx, r)
	}
	r.pgid = 0
	s.save(ctx, &r)
	s.notify(ctx, r.ID)
}

// runStep 跑一步到结束，结果写回 st；没过时记 failed_step、error，停了记 status。
func (s *releaseService) runStep(ctx context.Context, r *Release, st *ReleaseStep, lt *liveTest) {
	start := time.Now().UTC()
	st.Status, st.StartedAt = stRunning, &start
	vars := r.vars()
	st.Command = expand(st.Command, vars)
	s.save(ctx, r)
	res := runForeground(st.Command, st.Dir, childEnv(vars), time.Duration(st.TimeoutSec)*time.Second, lt.stopCh, func(pgid int) {
		r.pgid = pgid
		s.save(ctx, r)
	})
	r.pgid = 0
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
		if r.FailedStep == "" {
			r.FailedStep = st.Key
			r.Error = st.Label + "：" + st.Error
		}
	}
	s.save(ctx, r)
}

// rollback 发布或线上冒烟没过：有回滚命令就跑，结果记 rollback_state；没有记 unavailable。
// 回滚不看「停止」：已经停了的（status 不是 running）不会走到这里，回滚一旦起了就跑完。
func (s *releaseService) rollback(ctx context.Context, r *Release, _ *liveTest) {
	i := slices.IndexFunc(r.Steps, func(st ReleaseStep) bool { return st.Key == "rollback" })
	if i < 0 {
		r.RollbackState = rbUnavailable
		return
	}
	st := &r.Steps[i]
	never := &liveTest{stopCh: make(chan struct{})}
	failed := r.FailedStep
	s.runStep(ctx, r, st, never)
	r.FailedStep = failed // 回滚没过不改「第一个没过的步骤」
	if st.Status == stPassed {
		r.Status, r.RollbackState = rlRolledBack, rbDone
	} else {
		r.Status, r.RollbackState = rlRollbackFailed, rbFailed
	}
}

// readVersion 读 version 那步写的 version.txt（第一行）、changelog.md；没写 version.txt 时取输出最后一个非空行。
func readVersion(out, output string) (string, string) {
	v := ""
	if b, err := os.ReadFile(filepath.Join(out, versionFile)); err == nil {
		v, _, _ = strings.Cut(strings.TrimSpace(string(b)), "\n")
	} else {
		lines := strings.Split(strings.TrimSpace(output), "\n")
		v = lines[len(lines)-1]
	}
	v = clipRunes(strings.TrimSpace(strings.ToValidUTF8(v, "?")), maxVersion)
	cl := ""
	if b, err := os.ReadFile(filepath.Join(out, changelogFile)); err == nil {
		cl = clipRunes(strings.TrimSpace(strings.ToValidUTF8(string(b), "?")), maxChangelog)
	}
	return v, cl
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

/* ---------- 停止、回收 ---------- */

// Stop：在跑的停下（当前步骤的进程组杀掉，记 stopped；上线段停下不自动回滚，生产可能停在半路，报告里写明）；
// 准备好等审批的作废（cancelled）；别的原样回。
func (s *releaseService) Stop(ctx context.Context, id string) (Release, error) {
	s.mu.Lock()
	lt := s.live[id]
	s.mu.Unlock()
	if lt != nil {
		lt.stop(rlStopped, "手动停止")
		select {
		case <-lt.done:
		case <-time.After(stopWait):
			s.c.Log().Warn("release did not finish after stop", "release", id)
		}
		return s.get(ctx, id)
	}
	r, err := s.get(ctx, id)
	if err != nil {
		return r, err
	}
	switch r.Status {
	case rlRunning:
		s.abandon(ctx, r, rlStopped, "手动停止")
	case rlPrepared:
		now := time.Now().UTC()
		r.Status, r.Error, r.FinishedAt = rlCancelled, "手动作废，没有上线", &now
		for i := range r.Steps {
			if r.Steps[i].Status == stPending {
				r.Steps[i].Status = stSkipped
			}
		}
		s.save(ctx, &r)
		s.notify(ctx, r.ID)
	}
	return s.get(ctx, id)
}

// abandon 收掉不在本进程里跑的 running 记录：杀掉记下的进程组，没跑完的步骤记 stopped / skipped。
func (s *releaseService) abandon(ctx context.Context, r Release, status, why string) {
	if r.pgid > 0 {
		killGroupAsync(r.pgid)
	}
	if r.Phase == phaseDeploy {
		why += "：上线段没跑完，生产可能停在半路，请人工核对"
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
	r.Status, r.Error, r.FinishedAt, r.pgid = status, why, &now, 0
	s.save(ctx, &r)
	s.notify(ctx, r.ID)
}

// ensureReconciled：第一次用到时把表里 running、又不在本进程里的记录（工作台重启前没跑完的）记成 interrupted，杀掉记下的进程组。
func (s *releaseService) ensureReconciled(ctx context.Context) {
	s.reconcile.Do(func() {
		rows, err := s.list(ctx, "status = ?", []any{rlRunning}, 200)
		if err != nil {
			s.c.Log().Warn("reconcile releases failed", "err", err)
			return
		}
		for _, r := range rows {
			s.mu.Lock()
			_, mine := s.live[r.ID]
			s.mu.Unlock()
			if !mine {
				s.abandon(ctx, r, rlInterrupted, "工作台重启过，这次发布没跑完")
			}
		}
	})
}

// closeAll 停掉本次启用起的全部发布（记 interrupted），之后不再接受新的。插件停用、服务关闭时调。
func (s *releaseService) closeAll() {
	s.mu.Lock()
	s.closed = true
	lts := make([]*liveTest, 0, len(s.live))
	for _, lt := range s.live {
		lts = append(lts, lt)
	}
	s.mu.Unlock()
	for _, lt := range lts {
		lt.stop(rlInterrupted, "项目插件停用了，这次发布没跑完")
	}
	for _, lt := range lts {
		select {
		case <-lt.done:
		case <-time.After(stopWait):
		}
	}
}

/* ---------- 产出 ---------- */

func (s *releaseService) recordArtifact(ctx context.Context, r Release) []string {
	if r.ReportPath == "" {
		return []string{}
	}
	title := "发布报告 " + r.TaskRef
	if r.Version != "" {
		title += " " + r.Version
	}
	title += "（" + releaseStatusLabel(r.Status) + "）"
	id, err := s.c.Artifacts().Record(ctx, plugin.NewArtifact{ObjectID: r.TaskID, Title: title, Path: r.ReportPath, BaseDir: r.RunDir, Kind: "doc",
		Props: map[string]any{"release_id": r.ID, "release_status": r.Status, "version": r.Version}})
	if err != nil {
		s.c.Log().Warn("record release report artifact failed", "release", r.ID, "err", err)
		return []string{}
	}
	return []string{id}
}

func releaseStatusLabel(st string) string {
	switch st {
	case rlRunning:
		return "进行中"
	case rlPrepared:
		return "等上线审批"
	case rlReleased:
		return "已上线"
	case rlFailed:
		return "没成功"
	case rlRolledBack:
		return "已回滚"
	case rlRollbackFailed:
		return "回滚失败"
	case rlStopped:
		return "已停止"
	case rlInterrupted:
		return "没跑完"
	case rlCancelled:
		return "已作废"
	}
	return st
}

/* ---------- SOP 节点 ---------- */

// prepareNode 是「准备发布」：config.task 是任务 id 或 ref（支持 {{字段}}），留空依次取输入的 task_id、task.id、worktree.task_id。
// 起准备段后挂起，跑完唤醒；同一次执行、同一步、同一次尝试再进来不重复起。
func (s *releaseService) prepareNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	s.ensureReconciled(ctx)
	ref := &sopRef{runID: n.RunID, step: n.Step, attempt: n.Attempt, input: n.Input}
	if n.RunID != "" {
		if r, ok, err := s.byKey(ctx, "prep_key", sopKey(ref)); err != nil {
			return nil, err
		} else if ok {
			if r.Status == rlRunning && r.Phase == phasePrepare {
				return nil, fmt.Errorf("等任务 %s 的发布准备跑完：%w", r.TaskRef, plugin.ErrWaiting)
			}
			s.markNotified(ctx, r.ID)
			return with(n.Input, map[string]any{"release": s.sopOutput(r, phasePrepare)}), nil
		}
	}
	key := strings.TrimSpace(render(n.Config["task"], n.Input))
	if strings.TrimSpace(n.Config["task"]) == "" {
		key = firstNonEmpty(txt(getPath(n.Input, "task_id")), txt(getPath(n.Input, "task.id")), txt(getPath(n.Input, "worktree.task_id")))
	}
	if key == "" {
		return nil, errors.New("没有指定任务：在「任务」里填 {{字段}}，或者确认输入里有 task_id")
	}
	r, err := s.Prepare(ctx, key, ref)
	if err != nil {
		return nil, errors.New("发布准备没起来：" + apiMessage(err))
	}
	return s.waitOrReturn(ctx, n, r, phasePrepare, "等任务 %s 的发布准备跑完：%w")
}

// deployNode 是「上线」：config.release 是发布 id（支持 {{字段}}），留空取输入的 release.id（接在「准备发布」和审批后面不用配）。
// 只认准备好、等审批的；起上线段后挂起，跑完唤醒。流程里要把它放在人工审批之后：审批前不跑任何动生产的命令。
func (s *releaseService) deployNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	s.ensureReconciled(ctx)
	ref := &sopRef{runID: n.RunID, step: n.Step, attempt: n.Attempt, input: n.Input}
	if n.RunID != "" {
		if r, ok, err := s.byKey(ctx, "deploy_key", sopKey(ref)); err != nil {
			return nil, err
		} else if ok {
			if r.Status == rlRunning {
				return nil, fmt.Errorf("等任务 %s 上线跑完：%w", r.TaskRef, plugin.ErrWaiting)
			}
			s.markNotified(ctx, r.ID)
			return with(n.Input, map[string]any{"release": s.sopOutput(r, phaseDeploy)}), nil
		}
	}
	id := strings.TrimSpace(render(n.Config["release"], n.Input))
	if strings.TrimSpace(n.Config["release"]) == "" {
		id = txt(getPath(n.Input, "release.id"))
	}
	if id == "" {
		return nil, errors.New("没有指定发布：接在「准备发布」后面，或者在「发布」里填 {{release.id}}")
	}
	by := "sop"
	if n.RunID != "" {
		by = "sop:" + n.RunID
	}
	r, err := s.Deploy(ctx, id, by, ref)
	if err != nil {
		return nil, errors.New("上线没起来：" + apiMessage(err))
	}
	return s.waitOrReturn(ctx, n, r, phaseDeploy, "等任务 %s 上线跑完：%w")
}

// waitOrReturn：有执行 id 时挂起等唤醒；没有（不是 SOP 引擎调的）等它跑完直接回。
func (s *releaseService) waitOrReturn(ctx context.Context, n plugin.SOPNodeInput, r Release, phase, waitMsg string) (map[string]any, error) {
	if n.RunID != "" {
		return nil, fmt.Errorf(waitMsg, r.TaskRef, plugin.ErrWaiting)
	}
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
	r, err := s.get(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	return with(n.Input, map[string]any{"release": s.sopOutput(r, phase)}), nil
}

func apiMessage(err error) string {
	_, msg, _ := strings.Cut(err.Error(), ": ")
	if msg == "" {
		msg = err.Error()
	}
	return msg
}

func (s *releaseService) byKey(ctx context.Context, col, key string) (Release, bool, error) {
	rows, err := s.list(ctx, col+" = ?", []any{key}, 1)
	if err != nil || len(rows) == 0 {
		return Release{}, false, err
	}
	return rows[0], true, nil
}

// sopOutput 是节点输出里的 release。phase 是哪个节点要的：准备节点 ok 是准备段过了（等审批或已经往后走了），上线节点 ok 是已上线。
func (s *releaseService) sopOutput(r Release, phase string) map[string]any {
	steps := make([]any, 0, len(r.Steps))
	for _, st := range r.Steps {
		m := map[string]any{"key": st.Key, "label": st.Label, "phase": st.Phase, "status": st.Status, "duration_ms": st.DurationMs,
			"timed_out": st.TimedOut, "error": st.Error, "output": st.Output, "exit_code": nil}
		if st.ExitCode != nil {
			m["exit_code"] = *st.ExitCode
		}
		steps = append(steps, m)
	}
	ok := r.Status == rlReleased
	if phase == phasePrepare {
		ok = r.Status == rlPrepared || (r.Phase == phaseDeploy && r.Status != rlCancelled)
	}
	out := map[string]any{"ok": ok, "status": r.Status, "phase": r.Phase, "id": r.ID, "task_id": r.TaskID, "task_ref": r.TaskRef,
		"version": r.Version, "changelog": r.Changelog, "steps": steps, "rollback": r.RollbackState,
		"rolled_back": r.RollbackState == rbDone, "report_path": r.ReportPath, "artifact_ids": anyStrs(r.ArtifactIDs),
		"failed_step": r.FailedStep, "error": r.Error, "text": releaseText(r), "report_url": ""}
	if r.ReportPath != "" {
		out["report_url"] = s.publicURL + "/api/projects/releases/runs/" + url.PathEscape(r.ID) + "/report"
	}
	if out["changelog"] == "" {
		out["changelog"] = "（没有更新日志）"
	}
	if out["version"] == "" {
		out["version"] = "（没有版本号）"
	}
	return out
}

// releaseText 是一次发布的一句话，拼进通知。
func releaseText(r Release) string {
	v := r.Version
	if v == "" {
		v = "（没有版本号）"
	}
	switch r.Status {
	case rlRunning:
		if r.Phase == phaseDeploy {
			return "版本 " + v + " 正在上线"
		}
		return "正在准备发布"
	case rlPrepared:
		return "版本 " + v + " 已打包，等上线审批"
	case rlReleased:
		return "版本 " + v + " 已上线，线上冒烟通过"
	case rlRolledBack:
		return r.Error + "；已自动回滚"
	case rlRollbackFailed:
		e := ""
		if i := slices.IndexFunc(r.Steps, func(st ReleaseStep) bool { return st.Key == "rollback" }); i >= 0 {
			e = "（" + r.Steps[i].Error + "）"
		}
		return r.Error + "；自动回滚也没成功" + e + "，请马上人工处理"
	case rlFailed:
		switch {
		case r.RollbackState == rbUnavailable:
			return r.Error + "；档案里没有回滚命令，没有回滚，请人工处理"
		case r.Phase == phaseDeploy:
			return r.Error + "；还没动生产"
		}
		return r.Error
	}
	return r.Error
}

func (s *releaseService) notify(ctx context.Context, id string) {
	r, err := s.get(ctx, id)
	if err != nil || r.SopRunID == "" || r.notified || r.Status == rlRunning {
		return
	}
	var input map[string]any
	_ = json.Unmarshal([]byte(r.sopInput), &input)
	phase := phaseDeploy
	if r.deployKey == "" {
		phase = phasePrepare
	}
	if err := s.c.SOP().Resume(ctx, r.SopRunID, r.sopStep, with(input, map[string]any{"release": s.sopOutput(r, phase)})); err != nil {
		if r.FinishedAt != nil && time.Since(*r.FinishedAt) > notifyGiveUp {
			s.c.Log().Warn("give up resuming sop step for release", "release", r.ID, "run", r.SopRunID, "step", r.sopStep, "err", err)
			s.markNotified(ctx, r.ID)
		} else {
			s.c.Log().Debug("resume sop step for release failed, retry later", "release", r.ID, "err", err)
		}
		return
	}
	s.markNotified(ctx, r.ID)
}

func (s *releaseService) notifyPending(ctx context.Context) error {
	rows, err := s.list(ctx, "sop_run_id <> '' AND sop_notified = 0 AND status <> ?", []any{rlRunning}, 50)
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

func (s *releaseService) markNotified(ctx context.Context, id string) {
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_releases SET sop_notified = 1 WHERE id = ?`, id); err != nil {
		s.c.Log().Warn("mark release notified failed", "release", id, "err", err)
	}
}

/* ---------- 读写记录 ---------- */

const releaseCols = `id, task_id, task_ref, project_id, worktree_id, workdir, status, phase, version, changelog, steps, failed_step, error,
	rollback_state, run_dir, report_path, artifact_ids, pgid, source, approved_at, approved_by, sop_run_id, sop_step, sop_attempt, sop_input,
	sop_notified, prep_key, deploy_key, started_at, finished_at, updated_at`

func scanRelease(row plugin.Row) (Release, error) {
	var r Release
	var steps, arts, started, updated string
	var finished, approved *string
	if err := row.Scan(&r.ID, &r.TaskID, &r.TaskRef, &r.ProjectID, &r.WorktreeID, &r.Workdir, &r.Status, &r.Phase, &r.Version, &r.Changelog,
		&steps, &r.FailedStep, &r.Error, &r.RollbackState, &r.RunDir, &r.ReportPath, &arts, &r.pgid, &r.Source, &approved, &r.ApprovedBy,
		&r.SopRunID, &r.sopStep, &r.sopAttempt, &r.sopInput, &r.notified, &r.prepKey, &r.deployKey, &started, &finished, &updated); err != nil {
		return Release{}, err
	}
	_ = json.Unmarshal([]byte(steps), &r.Steps)
	_ = json.Unmarshal([]byte(arts), &r.ArtifactIDs)
	if r.Steps == nil {
		r.Steps = []ReleaseStep{}
	}
	if r.ArtifactIDs == nil {
		r.ArtifactIDs = []string{}
	}
	r.StartedAt, _ = time.Parse(time.RFC3339, started)
	r.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	r.FinishedAt, r.ApprovedAt = parseTimePtr(finished), parseTimePtr(approved)
	return r, nil
}

func (s *releaseService) get(ctx context.Context, id string) (Release, error) {
	r, err := scanRelease(s.c.Store().QueryRow(ctx, `SELECT `+releaseCols+` FROM projects_releases WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return Release{}, apiErr(errNotFound, "发布 %s 不存在", id)
	}
	return r, err
}

func (s *releaseService) list(ctx context.Context, where string, args []any, limit int) ([]Release, error) {
	rows, err := s.c.Store().Query(ctx, `SELECT `+releaseCols+` FROM projects_releases WHERE `+where+
		` ORDER BY started_at DESC, id DESC LIMIT `+strconv.Itoa(limit), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Release{}
	for rows.Next() {
		r, err := scanRelease(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// save 把执行中的变化写回表并发事件。写失败只记日志。
func (s *releaseService) save(ctx context.Context, r *Release) {
	now := time.Now().UTC()
	r.UpdatedAt = now
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_releases SET status = ?, phase = ?, version = ?, changelog = ?, steps = ?, failed_step = ?,
		error = ?, rollback_state = ?, report_path = ?, artifact_ids = ?, pgid = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
		r.Status, r.Phase, r.Version, r.Changelog, encJSON(r.Steps), r.FailedStep, r.Error, r.RollbackState, r.ReportPath,
		encJSON(orEmptyStrs(r.ArtifactIDs)), r.pgid, timeCol(r.FinishedAt), now.Format(time.RFC3339), r.ID); err != nil {
		s.c.Log().Warn("save release failed", "release", r.ID, "err", err)
	}
	s.publish(*r)
}

func (s *releaseService) publish(r Release) {
	_ = s.c.Events().Publish(context.Background(), releaseChanged, map[string]any{"id": r.ID, "task_id": r.TaskID, "project_id": r.ProjectID,
		"status": r.Status, "phase": r.Phase})
}

/* ---------- 接口 ---------- */

type releaseAPI struct {
	*stakeholders
	s *releaseService
}

var releaseStatuses = []string{rlRunning, rlPrepared, rlReleased, rlFailed, rlRolledBack, rlRollbackFailed, rlStopped, rlInterrupted, rlCancelled}

func (a *releaseAPI) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := strings.TrimSpace(q.Get("task_id")); v != "" {
		where, args = append(where, "task_id = ?"), append(args, v)
	}
	if v := strings.TrimSpace(q.Get("project_id")); v != "" {
		where, args = append(where, "project_id = ?"), append(args, v)
	}
	switch v := strings.TrimSpace(q.Get("status")); {
	case v == "" || v == "all":
	case slices.Contains(releaseStatuses, v):
		where, args = append(where, "status = ?"), append(args, v)
	default:
		a.fail(w, r, apiErr(errValidation, "status must be %s or all", strings.Join(releaseStatuses, ", ")))
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

func (a *releaseAPI) prepare(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskID string `json:"task_id"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	out, err := a.s.Prepare(r.Context(), in.TaskID, nil)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": out})
}

// deploy 是在接口上批准上线（不经 SOP 的手动发布）。
func (a *releaseAPI) deploy(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.Deploy(r.Context(), r.PathValue("release_id"), "api", nil)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": out})
}

func (a *releaseAPI) show(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.get(r.Context(), r.PathValue("release_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (a *releaseAPI) stop(w http.ResponseWriter, r *http.Request) {
	out, err := a.s.Stop(r.Context(), r.PathValue("release_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (a *releaseAPI) report(w http.ResponseWriter, r *http.Request) {
	rl, err := a.s.get(r.Context(), r.PathValue("release_id"))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if rl.ReportPath == "" {
		a.fail(w, r, apiErr(errNotFound, "这次发布还没有报告"))
		return
	}
	b, err := os.ReadFile(rl.ReportPath)
	if err != nil {
		a.fail(w, r, apiErr(errNotFound, "报告文件不在了：%s", rl.ReportPath))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	_, _ = w.Write(b)
}
