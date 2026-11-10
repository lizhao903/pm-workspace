// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 动作 git_pull「拉取代码」：内核动作，到点在本机一个 git 仓库里跑 git pull --ff-only。
//
// 只做快进：本地有没推的提交、和远端分叉、工作区改动挡住了合并时 git 自己拒绝，记失败，不会产生合并提交或冲突。
// 无人值守地跑，不弹任何交互：GIT_TERMINAL_PROMPT=0，ssh 用 BatchMode（用户自己设了 GIT_SSH_COMMAND 时不动）。
// 调度是串行的，一次拉取最多等 gitPullTimeout，比到点宽限（DefaultGrace）短，卡住的拉取不会把别的定时任务挤成错过。

// gitPullTimeout 是一次拉取最多等多久。
const gitPullTimeout = 90 * time.Second

// maxGitOutput 是失败时写进执行记录的 git 输出字数上限（取末尾）。
const maxGitOutput = 600

// gitRefName 是 remote、branch 允许的字符；不许 - 开头，免得被当成 git 的参数。
var gitRefName = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._/-]*$`)

// GitPullRequest 是一次拉取。Remote、Branch 都空时按仓库自己的上游拉；Branch 非空时 Remote 必填。
type GitPullRequest struct {
	Repo   string
	Remote string
	Branch string
}

// GitPullResult 是拉取的结果：Before、After 是拉取前后的 HEAD，相同即已是最新；Commits 是新拉下来的提交数。
type GitPullResult struct {
	Branch  string
	Before  string
	After   string
	Commits int
}

// GitPuller 执行 git pull；默认是 execGit，测试换成假的。错误文字给人看。
type GitPuller interface {
	Pull(ctx context.Context, q GitPullRequest) (*GitPullResult, error)
	// IsRepo 说这个目录是不是一个 git 工作区，保存时查
	IsRepo(ctx context.Context, dir string) error
}

func (a Action) validateGitPull() error {
	if a.Repo == "" {
		return invalid("action.repo is required for kind git_pull")
	}
	if !filepath.IsAbs(a.Repo) {
		return invalid("action.repo must be an absolute path, got %q", a.Repo)
	}
	if a.Remote != "" && !gitRefName.MatchString(a.Remote) {
		return invalid("action.remote: invalid remote name %q", a.Remote)
	}
	if a.Branch != "" && !gitRefName.MatchString(a.Branch) {
		return invalid("action.branch: invalid branch name %q", a.Branch)
	}
	if a.Branch != "" && a.Remote == "" {
		return invalid("action.remote is required when action.branch is set")
	}
	return nil
}

// SetGit 换掉执行 git 的实现，测试用；没调时用本机的 git 命令。
func (s *Store) SetGit(g GitPuller) { s.git = g }

func (s *Store) gitPuller() GitPuller {
	if s.git == nil {
		return execGit{}
	}
	return s.git
}

// checkGitRepo 保存时查目录是不是 git 工作区；不是回 400。
func (s *Store) checkGitRepo(ctx context.Context, a Action) error {
	if a.Kind != ActionGitPull {
		return nil
	}
	if err := s.gitPuller().IsRepo(ctx, a.Repo); err != nil {
		return invalid("action.repo: %s", err.Error())
	}
	return nil
}

// gitPull 跑一次拉取，结果写进执行记录。
func (r *Runner) gitPull(ctx context.Context, sc *Schedule) runResult {
	a := sc.Action
	got, err := r.s.gitPuller().Pull(ctx, GitPullRequest{Repo: a.Repo, Remote: a.Remote, Branch: a.Branch})
	if err != nil {
		return runResult{status: RunFailed, text: "没拉成：" + err.Error()}
	}
	where := filepath.Base(a.Repo)
	if got.Branch != "" {
		where += "（" + got.Branch + "）"
	}
	if got.Before == got.After {
		return runResult{status: RunOK, text: fmt.Sprintf("%s 已是最新 %s", where, short(got.After))}
	}
	return runResult{status: RunOK, text: fmt.Sprintf("%s 拉了 %d 个新提交 %s → %s", where, got.Commits, short(got.Before), short(got.After))}
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// execGit 用本机的 git 命令。
type execGit struct{}

func (execGit) IsRepo(ctx context.Context, dir string) error {
	st, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("directory %s does not exist", dir)
		}
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(out) != "true" {
		return fmt.Errorf("%s is not a git working tree", dir)
	}
	return nil
}

func (g execGit) Pull(ctx context.Context, q GitPullRequest) (*GitPullResult, error) {
	if err := g.IsRepo(ctx, q.Repo); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, gitPullTimeout)
	defer cancel()
	res := &GitPullResult{}
	// 分离头指针时 --abbrev-ref 回 HEAD，这时 pull 也会失败，交给 git 报
	if b, err := runGit(ctx, q.Repo, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		res.Branch = strings.TrimSpace(b)
	}
	// 空仓库没有 HEAD，before 留空
	if h, err := runGit(ctx, q.Repo, "rev-parse", "HEAD"); err == nil {
		res.Before = strings.TrimSpace(h)
	}
	args := []string{"pull", "--ff-only", "--no-edit"}
	if q.Remote != "" {
		args = append(args, q.Remote)
	}
	if q.Branch != "" {
		args = append(args, q.Branch)
	}
	if out, err := runGit(ctx, q.Repo, args...); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("超过 %d 秒没拉完，已中止", int(gitPullTimeout/time.Second))
		}
		return nil, errors.New(tail(out, err))
	}
	h, err := runGit(ctx, q.Repo, "rev-parse", "HEAD")
	if err != nil {
		return nil, errors.New("拉完读不到 HEAD：" + tail(h, err))
	}
	res.After = strings.TrimSpace(h)
	if res.Before != "" && res.Before != res.After {
		if n, err := runGit(ctx, q.Repo, "rev-list", "--count", res.Before+".."+res.After); err == nil {
			res.Commits, _ = strconv.Atoi(strings.TrimSpace(n))
		}
	}
	return res, nil
}

// runGit 在 dir 里跑 git，回合并的 stdout、stderr。不弹任何交互。
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	if os.Getenv("GIT_SSH_COMMAND") == "" {
		env = append(env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
	}
	cmd.Env = env
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

// tail 取 git 输出的末尾几行给人看；没输出时用错误本身。
func tail(out string, err error) string {
	s := strings.TrimSpace(out)
	if s == "" {
		return err.Error()
	}
	if r := []rune(s); len(r) > maxGitOutput {
		s = "…" + string(r[len(r)-maxGitOutput:])
	}
	return s
}
