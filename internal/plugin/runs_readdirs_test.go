// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// argsClaudeBin 写一个假的 claude：把收到的参数逐行写进工作目录的 args.txt，再吐一行结果。
func argsClaudeBin(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > args.txt\n" +
		`echo '{"type":"result","subtype":"success","is_error":false,"result":"好了"}'` + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestClaudeCodeReadDirs（TSK-0851 复现）：SOP 在 web-video 里跑 Claude Code、要去 pm-workspace 读 git log，
// 以前工作目录外的目录没有任何放行，git -C <目录> log、ls、Read 全被拒。
// 给了 ReadDirs 后，命令行要带上该目录的只读规则（Read 和 git -C <目录> log 等），提示词要说明能读哪些目录；
// 不能用 --add-dir（那会连写一起放开）；工作目录里面的目录忽略；不存在的目录直接报错，不发起。
func TestClaudeCodeReadDirs(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	demo := plugintest.NewDemo(time.Hour)
	r, err := sqlRegistry(t, d, demo, sopPlugin(t))
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	r.SetObjectCreator(&artifactStore{})
	r.SetClaudeRunner(&runner.Runner{Bin: argsClaudeBin(t)})
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}

	wd := t.TempDir()
	repo := t.TempDir()
	repo, _ = filepath.EvalSymlinks(repo)
	inside := filepath.Join(wd, "sub")
	if err := os.Mkdir(inside, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "做视频", ReadDirs: []string{filepath.Join(repo, "nope")}}); err == nil ||
		!strings.Contains(err.Error(), "额外可读目录不存在") {
		t.Fatalf("不存在的目录要报错，得到 %v", err)
	}
	if _, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "做视频", ReadDirs: []string{"relative/dir"}}); err == nil {
		t.Fatal("相对路径要报错")
	}

	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "做视频", AllowWrites: false,
		ReadDirs: []string{repo, " ", repo + "/", inside}})
	if err != nil {
		t.Fatal(err)
	}
	if c := finished(t, demo, id); c.Status != plugin.RunDone {
		t.Fatalf("运行 = %+v", c)
	}
	raw, err := os.ReadFile(filepath.Join(wd, "args.txt"))
	if err != nil {
		t.Fatal(err)
	}
	args := string(raw)
	for _, want := range []string{
		"--allowedTools\nRead(/" + repo + "/**)\n",
		"--allowedTools\nBash(git -C " + repo + " log:*)\n",
		"--allowedTools\nBash(git -C " + repo + " show:*)\n",
		"## 额外可读目录",
		"- " + repo + "\n",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("命令行里没有 %q：\n%s", want, args)
		}
	}
	if strings.Contains(args, "--add-dir") {
		t.Errorf("额外可读目录不该用 --add-dir（会放开写）：\n%s", args)
	}
	if strings.Contains(args, inside) {
		t.Errorf("工作目录里面的目录不用再放：\n%s", args)
	}
	if n := strings.Count(args, "Read(/"+repo+"/**)"); n != 1 {
		t.Errorf("同一个目录写了 %d 次规则，要去重", n)
	}
	if !r.WaitRuns(10 * time.Second) {
		t.Fatal("运行没收完")
	}
}
