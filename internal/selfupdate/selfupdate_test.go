package selfupdate

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// miniRepo 造一个最小的「源码仓库」：go.mod、cmd/pmw、cmd/pmw-mcp、Makefile（frontend 目标按 makeFrontend），
// 再放一个旧的 bin/pmw-dev 和 bin/pmw-mcp-dev，提交一次
func miniRepo(t *testing.T, makeFrontend string) (repo, exe string) {
	t.Helper()
	repo = t.TempDir()
	w := func(p, s string) {
		full := filepath.Join(repo, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	w("go.mod", "module example.com/mini\n\ngo 1.22\n")
	main := "package main\n\nimport \"flag\"\n\nvar version = \"x\"\n\nfunc main() { flag.String(\"addr\", \"\", \"\"); flag.Parse(); println(version) }\n"
	w("cmd/pmw/main.go", main)
	w("cmd/pmw-mcp/main.go", main)
	w("Makefile", "frontend:\n\t"+makeFrontend+"\n")
	w("bin/pmw-dev", "old")
	w("bin/pmw-mcp-dev", "old-mcp")
	git := func(args ...string) {
		c := exec.Command("git", append([]string{"-C", repo}, args...)...)
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-q")
	git("add", ".")
	git("commit", "-q", "-m", "初始")
	return repo, filepath.Join(repo, "bin", "pmw-dev")
}

func waitJob(t *testing.T, u *Updater, want ...string) *Job {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		if j := u.snapshotJob(); j != nil {
			for _, s := range want {
				if j.State == s {
					return j
				}
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("等不到更新结束，最后 %+v", u.snapshotJob())
	return nil
}

func TestFindRepoAndMCP(t *testing.T) {
	repo, exe := miniRepo(t, "true")
	if got := FindRepo(exe); got != repo {
		t.Errorf("FindRepo = %q，期望 %q", got, repo)
	}
	if got := FindRepo(filepath.Join(t.TempDir(), "bin", "pmw")); got != "" {
		t.Errorf("不在仓库里应找不到，得到 %q", got)
	}
	for in, want := range map[string]string{"/a/bin/pmw": "/a/bin/pmw-mcp", "/a/bin/pmw-dev": "/a/bin/pmw-mcp-dev", "/a/bin/other": ""} {
		if got := mcpOf(in); got != want {
			t.Errorf("mcpOf(%s) = %q，期望 %q", in, got, want)
		}
	}
}

func TestStatusListsNewCommitsAndDirty(t *testing.T) {
	repo, exe := miniRepo(t, "true")
	u := New(exe, "dev", nil, nil)
	ctx := context.Background()
	first, err := u.git(ctx, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "a.txt"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加 a"}} {
		if _, err := u.git(ctx, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "b.txt"), []byte("2"), 0o644); err != nil {
		t.Fatal(err)
	}
	src, err := u.source(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if src.Head == nil || src.Head.Subject != "加 a" || src.AheadTotal != 1 || len(src.Ahead) != 1 || src.Dirty != 1 || src.Diverged {
		t.Errorf("source = %+v", src)
	}
	if src, _ := u.source(ctx, strings.Repeat("0", 40)); !src.Diverged {
		t.Errorf("正在跑的提交不在这条线上应标 diverged")
	}
}

func TestUpdateFailsWithoutTouchingRunningBinary(t *testing.T) {
	_, exe := miniRepo(t, "exit 3")
	restarted := ""
	u := New(exe, "dev", func(context.Context) (string, error) { return "/tmp/snap.db", nil }, func(e string) { restarted = e })
	if err := u.Start(); err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, u, "failed")
	if j.Steps[0].State != "done" || j.Steps[1].State != "failed" || j.Steps[2].State != "pending" {
		t.Errorf("步骤 = %+v", j.Steps)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Errorf("构建失败时不该动正在跑的二进制")
	}
	if restarted != "" {
		t.Errorf("失败不该重启")
	}
	if !strings.Contains(j.Log, "正在跑的旧版本没有动") {
		t.Errorf("日志 = %s", j.Log)
	}
}

func TestUpdateSwapsAndRestarts(t *testing.T) {
	if testing.Short() {
		t.Skip("要真编译")
	}
	_, exe := miniRepo(t, "true")
	done := make(chan string, 1)
	u := New(exe, "dev", func(context.Context) (string, error) { return "/tmp/snap.db", nil }, func(e string) { done <- e })
	if err := u.Start(); err != nil {
		t.Fatal(err)
	}
	if err := u.Start(); err != ErrBusy {
		t.Errorf("在跑时再点应 ErrBusy，得到 %v", err)
	}
	j := waitJob(t, u, "restarting", "failed")
	if j.State != "restarting" {
		t.Fatalf("更新没走完：%s\n%s", j.Error, j.Log)
	}
	if got := <-done; got != u.Exe {
		t.Errorf("重启的程序 = %q", got)
	}
	if b, _ := os.ReadFile(exe + ".prev"); string(b) != "old" {
		t.Errorf("旧程序应留在 .prev")
	}
	if b, _ := os.ReadFile(exe); string(b) == "old" {
		t.Errorf("应换成新程序")
	}
	mcp := mcpOf(u.Exe)
	if b, _ := os.ReadFile(mcp + ".prev"); string(b) != "old-mcp" {
		t.Errorf("MCP 旧程序应留在 .prev")
	}
	if _, err := os.Stat(exe + ".new"); !os.IsNotExist(err) {
		t.Errorf(".new 应已改名")
	}
}
