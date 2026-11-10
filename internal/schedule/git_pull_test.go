// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package schedule_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// git 在 dir 里跑一条 git 命令，失败就停。
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func commit(t *testing.T, dir, file, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", file)
}

// gitRepos 建一个裸仓库当远端、一个往里推的 up、一个定时任务去拉的 down。
func gitRepos(t *testing.T) (up, down string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("没有 git")
	}
	root := t.TempDir()
	bare, up, down := filepath.Join(root, "remote.git"), filepath.Join(root, "up"), filepath.Join(root, "down")
	git(t, root, "init", "-q", "--bare", "-b", "main", bare)
	git(t, root, "clone", "-q", bare, up)
	git(t, up, "checkout", "-q", "-b", "main")
	commit(t, up, "a.txt", "a")
	git(t, up, "push", "-q", "origin", "main")
	git(t, root, "clone", "-q", bare, down)
	return up, down
}

// 动作 git_pull：到点快进拉取，执行记录写拉了几个提交；已是最新照样记成功；分叉时 git 拒绝，记失败、不产生合并。
func TestRunnerGitPull(t *testing.T) {
	up, down := gitRepos(t)
	f := newFixture(t)
	sc := f.create(t, schedule.Input{Name: "拉代码", Rule: schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"},
		Action: schedule.Action{Kind: schedule.ActionGitPull, Repo: down + "/"}})
	if sc.Action.Repo != down {
		t.Fatalf("repo 应去掉末尾斜杠：%q", sc.Action.Repo)
	}

	commit(t, up, "b.txt", "b")
	commit(t, up, "c.txt", "c")
	git(t, up, "push", "-q", "origin", "main")

	f.clk.set(f.at(9, 0, 5))
	f.tick(t)
	rs := f.runs(t, sc.ID)
	if len(rs) != 1 || rs[0].Status != schedule.RunOK || !strings.Contains(rs[0].Text, "拉了 2 个新提交") || !strings.Contains(rs[0].Text, "（main）") {
		t.Fatalf("到点应拉下 2 个提交：%+v", rs)
	}
	if git(t, down, "rev-parse", "HEAD") != git(t, up, "rev-parse", "HEAD") {
		t.Fatal("拉完 HEAD 应和远端一致")
	}

	run, err := f.r.RunNow(context.Background(), sc.ID)
	if err != nil || run.Status != schedule.RunOK || !strings.Contains(run.Text, "已是最新") {
		t.Fatalf("已是最新：%+v，%v", run, err)
	}

	// 本地和远端各有一个提交：只快进，拒绝，HEAD 不动
	commit(t, up, "d.txt", "d")
	git(t, up, "push", "-q", "origin", "main")
	commit(t, down, "local.txt", "x")
	before := git(t, down, "rev-parse", "HEAD")
	run, err = f.r.RunNow(context.Background(), sc.ID)
	if err != nil || run.Status != schedule.RunFailed || !strings.HasPrefix(run.Text, "没拉成：") {
		t.Fatalf("分叉应记失败：%+v，%v", run, err)
	}
	if git(t, down, "rev-parse", "HEAD") != before {
		t.Fatal("分叉时不应动本地 HEAD")
	}
}

// 指定 remote、branch 拉；保存时查路径是绝对路径、是 git 工作区，branch 要配 remote。
func TestGitPullValidate(t *testing.T) {
	up, down := gitRepos(t)
	f := newFixture(t)
	ctx := context.Background()
	rule := schedule.Rule{Freq: schedule.FreqDaily, Time: "09:00"}

	git(t, up, "checkout", "-q", "-b", "dev")
	commit(t, up, "dev.txt", "dev")
	git(t, up, "push", "-q", "origin", "dev")
	sc := f.create(t, schedule.Input{Name: "拉 dev", Rule: rule,
		Action: schedule.Action{Kind: schedule.ActionGitPull, Repo: down, Remote: "origin", Branch: "dev"}})
	run, err := f.r.RunNow(ctx, sc.ID)
	if err != nil || run.Status != schedule.RunOK || !strings.Contains(run.Text, "拉了 1 个新提交") {
		t.Fatalf("指定分支：%+v，%v", run, err)
	}

	notRepo := t.TempDir()
	for _, c := range []struct {
		a    schedule.Action
		want string
	}{
		{schedule.Action{Kind: schedule.ActionGitPull}, "action.repo is required"},
		{schedule.Action{Kind: schedule.ActionGitPull, Repo: "relative/dir"}, "absolute path"},
		{schedule.Action{Kind: schedule.ActionGitPull, Repo: notRepo}, "not a git working tree"},
		{schedule.Action{Kind: schedule.ActionGitPull, Repo: filepath.Join(notRepo, "nope")}, "does not exist"},
		{schedule.Action{Kind: schedule.ActionGitPull, Repo: down, Branch: "dev"}, "action.remote is required"},
		{schedule.Action{Kind: schedule.ActionGitPull, Repo: down, Remote: "--upload-pack=x"}, "invalid remote"},
	} {
		_, err := f.ss.Create(ctx, schedule.Input{Name: "x", Rule: rule, Action: c.a})
		if !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v：应回 %q，得 %v", c.a, c.want, err)
		}
	}

	// 保存后目录被删：到点记失败
	gone := t.TempDir()
	git(t, gone, "init", "-q")
	sc2 := f.create(t, schedule.Input{Name: "会删", Rule: rule, Action: schedule.Action{Kind: schedule.ActionGitPull, Repo: gone}})
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	run, err = f.r.RunNow(ctx, sc2.ID)
	if err != nil || run.Status != schedule.RunFailed || !strings.Contains(run.Text, "does not exist") {
		t.Fatalf("目录没了：%+v，%v", run, err)
	}
}
