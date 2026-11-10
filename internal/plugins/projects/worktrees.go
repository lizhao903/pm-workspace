// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 需求级 git worktree（AUTO-07）：每个进研发的任务在项目代码库建一个独立 worktree 和分支 auto/<任务 ref>，
// Claude Code 在 worktree 里跑，写只落在 worktree 里；任务完成、取消或阶段变成已上线后删 worktree，分支合并了才删。
// 表 projects_worktrees、projects_worktree_settings（迁移 0006）。worktree 放在数据目录下的 worktrees/<项目 id>/<任务 ref>。
//
// 统一入口 worktreeService，三种调用方共用：
//   - 接口：POST /api/projects/worktrees {task_id} 准备（新建 201，复用 200）；GET /api/projects/worktrees?task_id=&project_id=&status= 列；
//     POST /api/projects/worktrees/{worktree_id}/cleanup {force} 手动清理；GET/PATCH /api/projects/worktree-settings 端口范围。
//   - SOP 节点 projects_prepare_worktree（准备工作区）：输出加 worktree，下游 Claude Code 节点的工作目录填 {{worktree.path}}。
//   - 事件：object.stage_changed 到 developing 时自动准备；object.status_changed 到 done、cancelled，object.stage_changed 到 released 时自动清理（不加 --force）。
// 准备、清理、端口分配在插件进程内一把锁里串行。git 是子进程，要用户确认过 process:spawn。

const (
	NodePrepareWorktree = "projects_prepare_worktree"
	worktreeChanged     = "projects.worktree_changed"

	wtActive  = "active"
	wtRemoved = "removed"

	// BranchPrefix 是工作区分支名的前缀，后面接任务 ref。
	BranchPrefix = "auto/"

	defaultPortMin   = 7900
	defaultPortMax   = 8899
	defaultPortBlock = 10
	// defaultEnvKeepHours 是测试环境保留给人工验收的默认时长（AUTO-09），maxEnvKeepHours 是上限（7 天）
	defaultEnvKeepHours = 24
	maxEnvKeepHours     = 168
	// reservedPortLo、reservedPortHi 是工作台自己用的端口（生产、测试实例、前端 dev），端口范围不能和它重叠。
	reservedPortLo = 7700
	reservedPortHi = 7899
	maxPortBlock   = 100

	gitTimeout = 2 * time.Minute
)

// 清理原因，落库 removed_reason。
const (
	ReasonTaskDone      = "task_done"
	ReasonTaskCancelled = "task_cancelled"
	ReasonReleased      = "released"
	ReasonManual        = "manual"
)

// doneStatuses 是触发自动清理的任务状态（任务类型的已完成、已取消；canceled 兼容另一种拼法）。
var doneStatuses = map[string]string{"done": ReasonTaskDone, "cancelled": ReasonTaskCancelled, "canceled": ReasonTaskCancelled}

// developingStage、releasedStage 是任务阶段（props.stage，AUTO-05）：进开发中时自动准备，上线后自动清理。
const (
	developingStage = "developing"
	releasedStage   = "released"
)

// Worktree 是一次准备的工作区。Path 是执行用的目录（Root 加 SubDir），SOP 里的 {{worktree.path}} 就是它。
type Worktree struct {
	ID         string `json:"id"`
	TaskID     string `json:"task_id"`
	TaskRef    string `json:"task_ref"`
	ProjectID  string `json:"project_id"`
	RepoDir    string `json:"repo_dir"`
	SubDir     string `json:"sub_dir"`
	Root       string `json:"root"`
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	BaseCommit string `json:"base_commit"`
	PortStart  int    `json:"port_start"`
	PortEnd    int    `json:"port_end"`
	PortCount  int    `json:"port_count"`
	// Status 是 active（在用）或 removed（已清理，端口已归还）
	Status        string `json:"status"`
	LastError     string `json:"last_error"`
	RemovedReason string `json:"removed_reason"`
	BranchDeleted bool   `json:"branch_deleted"`
	// Exists：目录现在还在（只在 active 时有意义）
	Exists    bool       `json:"exists"`
	Reused    bool       `json:"reused,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	RemovedAt *time.Time `json:"removed_at"`
}

// PortSettings 是工作区端口范围。
type PortSettings struct {
	PortMin   int `json:"port_min"`
	PortMax   int `json:"port_max"`
	PortBlock int `json:"port_block"`
	// EnvKeepHours 是测试通过后保留测试环境的默认时长（小时，AUTO-09，迁移 0008）
	EnvKeepHours int `json:"env_keep_hours"`
}

type worktreeService struct {
	c  plugin.Core
	mu sync.Mutex
	// beforeCleanup 在删 worktree 之前调：回收保留在这个工作区上的测试环境（AUTO-09，testenv.go 接上）
	beforeCleanup func(ctx context.Context, w Worktree, reason string)
	// portFree 看本机端口现在空不空，测试里换掉
	portFree func(port int) bool
}

func newWorktreeService(c plugin.Core) *worktreeService {
	return &worktreeService{c: c, portFree: localPortFree}
}

func (s *worktreeService) register(r plugin.Registrar, h *stakeholders) {
	r.Routes(func(m plugin.RouteRegistrar) {
		api := &worktreeAPI{h, s}
		m.HandleFunc("GET /api/projects/worktrees", api.list)
		m.HandleFunc("POST /api/projects/worktrees", api.prepare)
		m.HandleFunc("POST /api/projects/worktrees/{worktree_id}/cleanup", api.cleanup)
		m.HandleFunc("GET /api/projects/worktree-settings", api.settings)
		m.HandleFunc("PATCH /api/projects/worktree-settings", api.saveSettings)
	})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodePrepareWorktree, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.prepareNode})
	r.Subscribe("object.status_changed", s.onStatusChanged)
	r.Subscribe("object.stage_changed", s.onStageChanged)
}

/* ---------- 准备 ---------- */

// Prepare 给任务准备工作区，幂等：已有在用的直接复用（目录被删了按原分支、原端口重建）。key 是任务 id 或 ref。
func (s *worktreeService) Prepare(ctx context.Context, key string) (Worktree, error) {
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return Worktree{}, apiErr(errConflict, "%s", err.Error())
	}
	base := s.c.WorktreeDir()
	if base == "" {
		return Worktree{}, apiErr(errConflict, "工作台没有数据目录，建不了工作区")
	}
	task, err := s.task(ctx, key)
	if err != nil {
		return Worktree{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if cur, err := s.activeOf(ctx, task.ID); err == nil {
		return s.reuse(ctx, cur)
	} else if !errors.Is(err, plugin.ErrNoRows) {
		return Worktree{}, err
	}

	repo, sub, err := s.repoOf(ctx, task)
	if err != nil {
		return Worktree{}, err
	}
	if err := checkConflicts(ctx, repo); err != nil {
		return Worktree{}, err
	}
	head, err := git(ctx, repo, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return Worktree{}, apiErr(errConflict, "代码库 %s 还没有提交，建不了分支", repo)
	}
	ref := strings.TrimSpace(task.Ref)
	if ref == "" {
		ref = task.ID
	}
	branch := BranchPrefix + ref
	if _, err := git(ctx, repo, "check-ref-format", "--branch", branch); err != nil {
		return Worktree{}, apiErr(errValidation, "任务编号 %s 做不了分支名", ref)
	}
	root := filepath.Join(base, safeSeg(task.ProjectID), safeSeg(ref))

	// 先清掉已经没有目录的登记，再看分支有没有被别的 worktree 检出
	_, _ = git(ctx, repo, "worktree", "prune")
	list, err := worktreeList(ctx, repo)
	if err != nil {
		return Worktree{}, err
	}
	adopted := false
	for _, e := range list {
		if e.branch != "refs/heads/"+branch {
			continue
		}
		if !samePath(e.path, root) {
			return Worktree{}, apiErr(errConflict, "分支 %s 已经被 %s 的 worktree 检出着：先在那里切到别的分支或删掉那个 worktree", branch, e.path)
		}
		adopted = true // 记录丢了但 worktree 还在：接着用
	}
	if !adopted {
		if err := clearTarget(root); err != nil {
			return Worktree{}, err
		}
	}

	ps, err := s.settingsOf(ctx)
	if err != nil {
		return Worktree{}, err
	}
	port, err := s.allocPorts(ctx, ps)
	if err != nil {
		return Worktree{}, err
	}
	if !adopted {
		if err := addWorktree(ctx, repo, root, branch, head); err != nil {
			return Worktree{}, err
		}
	}
	now := time.Now().UTC()
	w := Worktree{
		ID: idgen.Prefixed("wt"), TaskID: task.ID, TaskRef: ref, ProjectID: task.ProjectID, RepoDir: repo, SubDir: sub,
		Root: root, Branch: branch, BaseCommit: head, PortStart: port, PortCount: ps.PortBlock, Status: wtActive,
		CreatedAt: now, UpdatedAt: now,
	}
	ts := now.Format(time.RFC3339)
	if _, err := s.c.Store().Exec(ctx, `INSERT INTO projects_worktrees
		(id, task_id, task_ref, project_id, repo_dir, sub_dir, root, branch, base_commit, port_start, port_count, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		w.ID, w.TaskID, w.TaskRef, w.ProjectID, w.RepoDir, w.SubDir, w.Root, w.Branch, w.BaseCommit, w.PortStart, w.PortCount, w.Status, ts, ts); err != nil {
		if !adopted {
			_, _ = git(context.WithoutCancel(ctx), repo, "worktree", "remove", "--force", root)
		}
		return Worktree{}, err
	}
	s.publish(ctx, w)
	return fill(w), nil
}

// reuse 处理已有在用的工作区：目录还是这个分支的 worktree 就原样回；目录没了按原分支、原端口重建。
func (s *worktreeService) reuse(ctx context.Context, w Worktree) (Worktree, error) {
	if isWorktreeOn(ctx, w.Root, w.Branch) {
		if w.LastError != "" {
			w.LastError = ""
			s.touch(ctx, w.ID, `last_error = ''`)
		}
		w.Reused = true
		return fill(w), nil
	}
	if st, err := os.Stat(w.Root); err == nil && st.IsDir() {
		return Worktree{}, apiErr(errConflict, "工作区目录 %s 还在，但已经不是分支 %s 的 worktree：先清理这个工作区再准备", w.Root, w.Branch)
	}
	if _, err := os.Stat(w.RepoDir); err != nil {
		return Worktree{}, apiErr(errConflict, "代码库 %s 找不到了：先清理这个工作区（强制），改好项目档案再准备", w.RepoDir)
	}
	if err := checkConflicts(ctx, w.RepoDir); err != nil {
		return Worktree{}, err
	}
	_, _ = git(ctx, w.RepoDir, "worktree", "prune")
	list, err := worktreeList(ctx, w.RepoDir)
	if err != nil {
		return Worktree{}, err
	}
	for _, e := range list {
		if e.branch == "refs/heads/"+w.Branch && !samePath(e.path, w.Root) {
			return Worktree{}, apiErr(errConflict, "分支 %s 已经被 %s 的 worktree 检出着：先在那里切到别的分支或删掉那个 worktree", w.Branch, e.path)
		}
	}
	base := w.BaseCommit
	if base == "" {
		base = "HEAD"
	}
	if err := addWorktree(ctx, w.RepoDir, w.Root, w.Branch, base); err != nil {
		return Worktree{}, err
	}
	w.LastError = ""
	w.UpdatedAt = time.Now().UTC()
	s.touch(ctx, w.ID, `last_error = ''`)
	s.publish(ctx, w)
	return fill(w), nil
}

// task 按 id 或 ref 找任务；项目不算，删了的不算。
func (s *worktreeService) task(ctx context.Context, key string) (plugin.ObjectInfo, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return plugin.ObjectInfo{}, apiErr(errValidation, "task_id is required")
	}
	o, err := s.c.Objects().Get(ctx, key)
	if errors.Is(err, plugin.ErrNoRows) {
		o, err = s.c.Objects().Find(ctx, "task", key)
	}
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Deleted || o.Type == "project")) {
		return plugin.ObjectInfo{}, apiErr(errNotFound, "任务 %s 不存在", key)
	}
	return o, err
}

// repoOf 找任务所属项目的代码库：档案的 code_dir，没设用项目目录；回仓库根和代码库目录相对仓库根的路径。
func (s *worktreeService) repoOf(ctx context.Context, task plugin.ObjectInfo) (string, string, error) {
	if task.ProjectID == "" {
		return "", "", apiErr(errValidation, "任务 %s 没挂项目：先选所属项目，再准备工作区", task.Ref)
	}
	h := &profiles{&stakeholders{c: s.c}}
	proj, err := h.liveProject(ctx, task.ProjectID)
	if err != nil {
		return "", "", apiErr(errValidation, "任务 %s 所属的项目不在了", task.Ref)
	}
	p, err := h.load(ctx, proj)
	if err != nil {
		return "", "", err
	}
	code := firstNonEmpty(p.CodeDir, proj.Workdir)
	if code == "" {
		return "", "", apiErr(errValidation, "项目「%s」还没设代码库目录：到项目的档案里填", proj.Title)
	}
	if st, err := os.Stat(code); err != nil || !st.IsDir() {
		return "", "", apiErr(errValidation, "项目「%s」的代码库目录 %s 找不到了", proj.Title, code)
	}
	top, err := git(ctx, code, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", apiErr(errValidation, "项目「%s」的代码库目录 %s 不是 git 仓库", proj.Title, code)
	}
	if main, err := git(ctx, code, "rev-parse", "--path-format=absolute", "--git-common-dir"); err == nil &&
		filepath.Base(main) == ".git" && !samePath(filepath.Dir(main), top) {
		// 代码库目录自己就是某个附加 worktree：建到主仓库上
		top = filepath.Dir(main)
	}
	realCode, _ := filepath.EvalSymlinks(code)
	realTop, _ := filepath.EvalSymlinks(top)
	sub, err := filepath.Rel(realTop, realCode)
	if err != nil || sub == "." || strings.HasPrefix(sub, "..") {
		sub = ""
	}
	return realTop, sub, nil
}

func checkConflicts(ctx context.Context, repo string) error {
	out, err := git(ctx, repo, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return apiErr(errConflict, "看不了代码库 %s 的状态：%s", repo, err.Error())
	}
	if files := strings.Fields(out); len(files) > 0 {
		if len(files) > 5 {
			files = append(files[:5], "…")
		}
		return apiErr(errConflict, "代码库 %s 有没解决的冲突（%s）：先解决冲突再准备工作区", repo, strings.Join(files, "、"))
	}
	return nil
}

func addWorktree(ctx context.Context, repo, root, branch, base string) error {
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return err
	}
	var err error
	if _, e := git(ctx, repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); e == nil {
		_, err = git(ctx, repo, "worktree", "add", root, branch)
	} else {
		_, err = git(ctx, repo, "worktree", "add", "-b", branch, root, base)
	}
	if err != nil {
		return apiErr(errConflict, "建 worktree 失败：%s", err.Error())
	}
	return nil
}

// clearTarget：目标目录不在最好；是空目录删掉；有东西就报错，不替用户删。
func clearTarget(root string) error {
	ents, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err == nil && len(ents) == 0 {
		return os.Remove(root)
	}
	return apiErr(errConflict, "目录 %s 已经有东西了，又不是这个任务的 worktree：先移走它再准备", root)
}

/* ---------- 端口 ---------- */

// allocPorts 在范围里按段找第一段：和在用的工作区不重叠，本机每个端口现在都能 bind。调用方持锁。
func (s *worktreeService) allocPorts(ctx context.Context, ps PortSettings) (int, error) {
	type span struct{ lo, hi int }
	var used []span
	rows, err := s.c.Store().Query(ctx, `SELECT port_start, port_count FROM projects_worktrees WHERE status = ?`, wtActive)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var a, n int
		if err := rows.Scan(&a, &n); err != nil {
			_ = rows.Close()
			return 0, err
		}
		used = append(used, span{a, a + n - 1})
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
next:
	for lo := ps.PortMin; lo+ps.PortBlock-1 <= ps.PortMax; lo += ps.PortBlock {
		hi := lo + ps.PortBlock - 1
		for _, u := range used {
			if lo <= u.hi && u.lo <= hi {
				continue next
			}
		}
		for p := lo; p <= hi; p++ {
			if !s.portFree(p) {
				continue next
			}
		}
		return lo, nil
	}
	return 0, apiErr(errConflict, "端口范围 %d–%d 里没有空闲的端口段了：清理不用的工作区，或到设置里放宽范围", ps.PortMin, ps.PortMax)
}

func localPortFree(port int) bool {
	l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

func (s *worktreeService) settingsOf(ctx context.Context) (PortSettings, error) {
	var ps PortSettings
	err := s.c.Store().QueryRow(ctx, `SELECT port_min, port_max, port_block, env_keep_hours FROM projects_worktree_settings WHERE id = 1`).
		Scan(&ps.PortMin, &ps.PortMax, &ps.PortBlock, &ps.EnvKeepHours)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return PortSettings{PortMin: defaultPortMin, PortMax: defaultPortMax, PortBlock: defaultPortBlock, EnvKeepHours: defaultEnvKeepHours}, nil
	}
	return ps, err
}

func checkPortSettings(ps PortSettings) error {
	switch {
	case ps.PortMin < 1024 || ps.PortMax > 65535 || ps.PortMin > ps.PortMax:
		return apiErr(errValidation, "端口范围要在 1024 到 65535 之间，起点不能大于终点")
	case ps.PortBlock < 1 || ps.PortBlock > maxPortBlock:
		return apiErr(errValidation, "每段端口数要在 1 到 %d 之间", maxPortBlock)
	case ps.PortMax-ps.PortMin+1 < ps.PortBlock:
		return apiErr(errValidation, "端口范围放不下一段 %d 个端口", ps.PortBlock)
	case ps.PortMin <= reservedPortHi && reservedPortLo <= ps.PortMax:
		return apiErr(errValidation, "端口范围不能和工作台自己用的 %d–%d 重叠", reservedPortLo, reservedPortHi)
	case ps.EnvKeepHours < 1 || ps.EnvKeepHours > maxEnvKeepHours:
		return apiErr(errValidation, "测试环境保留时长要在 1 到 %d 小时之间", maxEnvKeepHours)
	}
	return nil
}

/* ---------- 清理 ---------- */

// Cleanup 删工作区的 worktree：不 force 时有没提交的改动会失败（原因写进 last_error，记录保持在用）。
// 分支合并进主目录当前 HEAD 了才删，否则保留。已经清理过的原样回。
func (s *worktreeService) Cleanup(ctx context.Context, id, reason string, force bool) (Worktree, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, err := s.get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) {
		return Worktree{}, apiErr(errNotFound, "工作区 %s 不存在", id)
	}
	if err != nil || w.Status != wtActive {
		return fill(w), err
	}
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return Worktree{}, apiErr(errConflict, "%s", err.Error())
	}
	// 保留着的测试环境跑在这个工作区里，先回收（删不删得掉 worktree 都回收：清理就是不再要这个环境了）
	if s.beforeCleanup != nil {
		s.beforeCleanup(ctx, w, reason)
	}
	_, repoErr := os.Stat(w.RepoDir)
	_, dirErr := os.Stat(w.Root)
	switch {
	case repoErr != nil:
		// 代码库没了：git 帮不上，只在强制时删工作区目录（只删数据目录 worktrees/ 下面的）
		if dirErr == nil {
			if !force {
				return Worktree{}, s.failCleanup(ctx, w, fmt.Sprintf("代码库 %s 找不到了，删不了 worktree；确认不要了就强制清理", w.RepoDir))
			}
			if base := s.c.WorktreeDir(); base == "" || !within(base, w.Root) {
				return Worktree{}, s.failCleanup(ctx, w, "工作区目录不在数据目录下，不替你删："+w.Root)
			}
			if err := os.RemoveAll(w.Root); err != nil {
				return Worktree{}, s.failCleanup(ctx, w, "删工作区目录失败："+err.Error())
			}
		}
	case dirErr != nil:
		_, _ = git(ctx, w.RepoDir, "worktree", "prune")
	default:
		args := []string{"worktree", "remove"}
		if force {
			args = append(args, "--force", "--force")
		}
		if _, err := git(ctx, w.RepoDir, append(args, w.Root)...); err != nil {
			msg := "删 worktree 失败：" + err.Error()
			if strings.Contains(err.Error(), "modified or untracked") || strings.Contains(err.Error(), "--force") {
				msg = "工作区里有没提交的改动，没有删：提交或丢弃后再清理，确认不要了就强制清理"
			}
			return Worktree{}, s.failCleanup(ctx, w, msg)
		}
	}
	deleted := false
	if repoErr == nil {
		if _, err := git(ctx, w.RepoDir, "merge-base", "--is-ancestor", "refs/heads/"+w.Branch, "HEAD"); err == nil {
			if _, err := git(ctx, w.RepoDir, "branch", "-D", w.Branch); err == nil {
				deleted = true
			}
		}
	}
	_ = os.Remove(filepath.Dir(w.Root)) // 项目那一层空了顺手删，不空删不掉
	now := time.Now().UTC()
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_worktrees SET status = ?, removed_reason = ?, branch_deleted = ?, last_error = '',
		removed_at = ?, updated_at = ? WHERE id = ?`, wtRemoved, reason, deleted, now.Format(time.RFC3339), now.Format(time.RFC3339), w.ID); err != nil {
		return Worktree{}, err
	}
	w.Status, w.RemovedReason, w.BranchDeleted, w.LastError, w.RemovedAt, w.UpdatedAt = wtRemoved, reason, deleted, "", &now, now
	s.publish(ctx, w)
	return fill(w), nil
}

func (s *worktreeService) failCleanup(ctx context.Context, w Worktree, msg string) error {
	s.touch(ctx, w.ID, `last_error = ?`, msg)
	w.LastError = msg
	s.publish(ctx, w)
	return apiErr(errConflict, "%s", msg)
}

// cleanupTask 是自动清理：任务没有在用的工作区就什么都不做；失败只记 last_error 和日志。
func (s *worktreeService) cleanupTask(ctx context.Context, taskID, reason string) {
	w, err := s.activeOf(ctx, taskID)
	if err != nil {
		return
	}
	if _, err := s.Cleanup(ctx, w.ID, reason, false); err != nil {
		s.c.Log().Warn("auto cleanup worktree failed", "task", taskID, "worktree", w.ID, "err", err)
	}
}

func (s *worktreeService) onStatusChanged(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		ID string `json:"id"`
		To string `json:"to"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
		return nil
	}
	if reason, ok := doneStatuses[p.To]; ok {
		s.cleanupTask(ctx, p.ID, reason)
	}
	return nil
}

// onStageChanged：阶段进「开发中」（developing）时自动准备（任务没挂项目、项目没设代码库这类准备不了的只记日志，SOP 的「准备工作区」节点会再报清楚）；
// 进「已上线」时自动清理。
func (s *worktreeService) onStageChanged(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		ID string `json:"id"`
		To string `json:"to"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
		return nil
	}
	switch p.To {
	case developingStage:
		if _, err := s.Prepare(ctx, p.ID); err != nil {
			s.c.Log().Info("auto prepare worktree skipped", "task", p.ID, "err", err)
		}
	case releasedStage:
		s.cleanupTask(ctx, p.ID, ReasonReleased)
	}
	return nil
}

/* ---------- SOP 节点 ---------- */

// prepareNode 是「准备工作区」：config.task 是任务 id 或 ref（支持 {{字段}}），留空取输入的 task_id、task.id。
// 输出是输入加 worktree：id、path（执行目录）、root、branch、base_commit、port_start、port_end、port_count、reused。
func (s *worktreeService) prepareNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	key := strings.TrimSpace(render(n.Config["task"], n.Input))
	if strings.TrimSpace(n.Config["task"]) == "" {
		key = firstNonEmpty(txt(getPath(n.Input, "task_id")), txt(getPath(n.Input, "task.id")))
	}
	if key == "" {
		return nil, errors.New("没有指定任务：在「任务」里填 {{字段}}，或者确认输入里有 task_id")
	}
	w, err := s.Prepare(ctx, key)
	if err != nil {
		_, msg, _ := strings.Cut(err.Error(), ": ")
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New("准备工作区失败：" + msg)
	}
	return with(n.Input, map[string]any{"worktree": map[string]any{
		"id": w.ID, "path": w.Path, "root": w.Root, "branch": w.Branch, "base_commit": w.BaseCommit,
		"port_start": w.PortStart, "port_end": w.PortEnd, "port_count": w.PortCount, "reused": w.Reused,
		"task_id": w.TaskID, "task_ref": w.TaskRef,
	}}), nil
}

/* ---------- 读写记录 ---------- */

const worktreeCols = `id, task_id, task_ref, project_id, repo_dir, sub_dir, root, branch, base_commit, port_start, port_count,
	status, last_error, removed_reason, branch_deleted, created_at, updated_at, removed_at`

func scanWorktree(row plugin.Row) (Worktree, error) {
	var w Worktree
	var created, updated string
	var removed sql.NullString
	if err := row.Scan(&w.ID, &w.TaskID, &w.TaskRef, &w.ProjectID, &w.RepoDir, &w.SubDir, &w.Root, &w.Branch, &w.BaseCommit,
		&w.PortStart, &w.PortCount, &w.Status, &w.LastError, &w.RemovedReason, &w.BranchDeleted, &created, &updated, &removed); err != nil {
		return Worktree{}, err
	}
	w.CreatedAt, _ = time.Parse(time.RFC3339, created)
	w.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	if removed.Valid {
		if t, err := time.Parse(time.RFC3339, removed.String); err == nil {
			w.RemovedAt = &t
		}
	}
	return w, nil
}

func (s *worktreeService) get(ctx context.Context, id string) (Worktree, error) {
	return scanWorktree(s.c.Store().QueryRow(ctx, `SELECT `+worktreeCols+` FROM projects_worktrees WHERE id = ?`, id))
}

func (s *worktreeService) activeOf(ctx context.Context, taskID string) (Worktree, error) {
	return scanWorktree(s.c.Store().QueryRow(ctx, `SELECT `+worktreeCols+` FROM projects_worktrees WHERE task_id = ? AND status = ?`, taskID, wtActive))
}

func (s *worktreeService) touch(ctx context.Context, id, set string, args ...any) {
	args = append(args, time.Now().UTC().Format(time.RFC3339), id)
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_worktrees SET `+set+`, updated_at = ? WHERE id = ?`, args...); err != nil {
		s.c.Log().Warn("update worktree failed", "worktree", id, "err", err)
	}
}

func (s *worktreeService) publish(ctx context.Context, w Worktree) {
	_ = s.c.Events().Publish(ctx, worktreeChanged, map[string]any{"id": w.ID, "task_id": w.TaskID, "project_id": w.ProjectID, "status": w.Status})
}

// fill 补算出来的字段：执行目录、端口段终点、目录在不在。
func fill(w Worktree) Worktree {
	if w.ID == "" {
		return w
	}
	w.Path = w.Root
	if w.SubDir != "" {
		w.Path = filepath.Join(w.Root, w.SubDir)
	}
	w.PortEnd = w.PortStart + w.PortCount - 1
	if w.Status == wtActive {
		st, err := os.Stat(w.Root)
		w.Exists = err == nil && st.IsDir()
	}
	return w
}

/* ---------- 接口 ---------- */

type worktreeAPI struct {
	*stakeholders
	s *worktreeService
}

func (a *worktreeAPI) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
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
	case wtActive, wtRemoved:
		where, args = append(where, "status = ?"), append(args, v)
	default:
		a.fail(w, r, apiErr(errValidation, "status must be active, removed or all"))
		return
	}
	rows, err := a.c.Store().Query(ctx, `SELECT `+worktreeCols+` FROM projects_worktrees WHERE `+strings.Join(where, " AND ")+
		` ORDER BY created_at DESC, id DESC LIMIT 200`, args...)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := []Worktree{}
	for rows.Next() {
		x, err := scanWorktree(rows)
		if err != nil {
			_ = rows.Close()
			a.fail(w, r, err)
			return
		}
		out = append(out, fill(x))
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (a *worktreeAPI) prepare(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskID string `json:"task_id"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	out, err := a.s.Prepare(r.Context(), in.TaskID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	status := http.StatusCreated
	if out.Reused {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"data": out})
}

func (a *worktreeAPI) cleanup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Force bool `json:"force"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &in); err != nil {
			a.fail(w, r, err)
			return
		}
	}
	out, err := a.s.Cleanup(r.Context(), r.PathValue("worktree_id"), ReasonManual, in.Force)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// settingsView 是端口范围加给界面看的：在用的工作区数、工作台保留的端口。
func (a *worktreeAPI) settingsView(ctx context.Context) (map[string]any, error) {
	ps, err := a.s.settingsOf(ctx)
	if err != nil {
		return nil, err
	}
	var n int
	if err := a.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM projects_worktrees WHERE status = ?`, wtActive).Scan(&n); err != nil {
		return nil, err
	}
	return map[string]any{"port_min": ps.PortMin, "port_max": ps.PortMax, "port_block": ps.PortBlock, "env_keep_hours": ps.EnvKeepHours,
		"reserved": []int{reservedPortLo, reservedPortHi}, "active": n, "dir": a.c.WorktreeDir()}, nil
}

func (a *worktreeAPI) settings(w http.ResponseWriter, r *http.Request) {
	v, err := a.settingsView(r.Context())
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

func (a *worktreeAPI) saveSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in struct {
		PortMin      *int `json:"port_min"`
		PortMax      *int `json:"port_max"`
		PortBlock    *int `json:"port_block"`
		EnvKeepHours *int `json:"env_keep_hours"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	ps, err := a.s.settingsOf(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	for _, f := range []struct {
		in  *int
		out *int
	}{{in.PortMin, &ps.PortMin}, {in.PortMax, &ps.PortMax}, {in.PortBlock, &ps.PortBlock}, {in.EnvKeepHours, &ps.EnvKeepHours}} {
		if f.in != nil {
			*f.out = *f.in
		}
	}
	if err := checkPortSettings(ps); err != nil {
		a.fail(w, r, err)
		return
	}
	// 已经分出去的端口段不动，新范围只管以后的分配
	if _, err := a.c.Store().Exec(ctx, `INSERT INTO projects_worktree_settings (id, port_min, port_max, port_block, env_keep_hours, updated_at)
		VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET port_min = excluded.port_min, port_max = excluded.port_max, port_block = excluded.port_block,
		env_keep_hours = excluded.env_keep_hours, updated_at = excluded.updated_at`,
		ps.PortMin, ps.PortMax, ps.PortBlock, ps.EnvKeepHours, time.Now().UTC().Format(time.RFC3339)); err != nil {
		a.fail(w, r, err)
		return
	}
	v, err := a.settingsView(ctx)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

/* ---------- git ---------- */

// git 在 dir 里跑一条 git 命令，回去掉首尾空白的标准输出；失败时错误里是 git 的报错原文。
func git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", errors.New("本机没装 git")
		}
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(oneLine(msg, 400))
	}
	return strings.TrimSpace(out.String()), nil
}

type wtEntry struct{ path, branch string }

// worktreeList 解析 git worktree list --porcelain：每段 worktree <path>、branch refs/heads/<name>（分离头指针时没有）。
func worktreeList(ctx context.Context, repo string) ([]wtEntry, error) {
	out, err := git(ctx, repo, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, apiErr(errConflict, "列不出代码库 %s 的 worktree：%s", repo, err.Error())
	}
	var list []wtEntry
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			list = append(list, wtEntry{path: strings.TrimPrefix(line, "worktree ")})
		case strings.HasPrefix(line, "branch ") && len(list) > 0:
			list[len(list)-1].branch = strings.TrimPrefix(line, "branch ")
		}
	}
	return list, nil
}

// isWorktreeOn：root 是个 worktree 的根目录，检出的是 branch。
func isWorktreeOn(ctx context.Context, root, branch string) bool {
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return false
	}
	top, err := git(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil || !samePath(top, root) {
		return false
	}
	cur, err := git(ctx, root, "symbolic-ref", "--quiet", "HEAD")
	return err == nil && cur == "refs/heads/"+branch
}

func samePath(a, b string) bool {
	if ra, err := filepath.EvalSymlinks(a); err == nil {
		a = ra
	}
	if rb, err := filepath.EvalSymlinks(b); err == nil {
		b = rb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// within：p 在 base 下面（不含 base 本身）。
func within(base, p string) bool {
	rel, err := filepath.Rel(filepath.Clean(base), filepath.Clean(p))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

var unsafeSeg = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// safeSeg 把 id、ref 变成一段安全的目录名。
func safeSeg(s string) string {
	s = strings.Trim(unsafeSeg.ReplaceAllString(s, "_"), "._")
	if s == "" {
		return "_"
	}
	return s
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x = strings.TrimSpace(x); x != "" {
			return x
		}
	}
	return ""
}
