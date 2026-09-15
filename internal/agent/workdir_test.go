package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newWorkdir 造一个真实目录当 workdir。t.TempDir 在 macOS 上给的是 /var/folders/…，
// 而 /var 本身是指向 /private/var 的软链——这正好顺带验证了 root 侧也做了 EvalSymlinks。
func newWorkdir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "work")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	return dir
}

// TestResolveInWorkdirRejectsEscapes 是这个包最重要的一组断言：
// 模型的输出不可信，任何一条漏网的路径都是一次本机文件系统的越权写入。
func TestResolveInWorkdirRejectsEscapes(t *testing.T) {
	wd := newWorkdir(t)

	cases := []struct{ name, path, why string }{
		{"上跳一级", "../evil.txt", "最朴素的逃逸"},
		{"上跳两级到系统目录", "../../etc/passwd", "题面点名要挡住的那条"},
		{"深层上跳", "../../../../../../etc/passwd", "跳到根之外也不能放行"},
		{"绕一圈再出界", "a/b/../../../evil.txt", "Clean 之后才现形，先 Clean 再判就是为了它"},
		{"绝对路径", "/etc/passwd", "绝对路径一律拒"},
		{"绝对路径指向 tmp", "/tmp/evil.txt", "落在哪都一样，不是相对路径就拒"},
		{"当前目录", ".", "写不进一个目录"},
		{"父目录", "..", "同上，且已经出界"},
		{"空路径", "", "没有目标"},
		{"只有空白", "   ", "trim 之后即空"},
		{"隐藏的上跳", "docs/../../evil.txt", "中间段抵消后仍然出界"},
		{"空字符注入", "evil\x00.txt", "截断攻击的老把戏"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ResolveInWorkdir(wd, c.path)
			if err == nil {
				t.Fatalf("路径 %q 被放行了（解析成 %q），但它应当被拒：%s", c.path, got, c.why)
			}
		})
	}
}

// TestResolveInWorkdirRejectsSiblingWithSharedPrefix 盯的是前缀判断本身。
// 只比字符串前缀的话，/…/work 和 /…/workbench 会被认成同一棵树。
func TestResolveInWorkdirRejectsSiblingWithSharedPrefix(t *testing.T) {
	base := t.TempDir()
	wd := filepath.Join(base, "work")
	sibling := filepath.Join(base, "workbench") // 与 wd 共享前缀 "work"
	for _, d := range []string{wd, sibling} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("建目录 %s: %v", d, err)
		}
	}

	// 直接用相对路径跳过去。
	if got, err := ResolveInWorkdir(wd, "../workbench/stolen.txt"); err == nil {
		t.Fatalf("同前缀兄弟目录被放行了：%q", got)
	}

	// 更隐蔽的一条：workdir 里放一条指向兄弟目录的软链，再顺着它写。
	link := filepath.Join(wd, "shortcut")
	if err := os.Symlink(sibling, link); err != nil {
		t.Skipf("当前环境不支持创建软链: %v", err)
	}
	got, err := ResolveInWorkdir(wd, "shortcut/stolen.txt")
	if err == nil {
		t.Fatalf("经软链写入同前缀兄弟目录被放行了：%q", got)
	}
	if !errors.Is(err, ErrEscape) {
		t.Errorf("错误未归到 ErrEscape: %v", err)
	}
}

// TestResolveInWorkdirRejectsSymlinkEscape 覆盖三种软链形态：
// 目录软链、文件软链、以及多层嵌套之后才指出去的软链。
func TestResolveInWorkdirRejectsSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	wd := filepath.Join(base, "work")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{wd, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("建目录 %s: %v", d, err)
		}
	}
	root, err := filepath.EvalSymlinks(wd)
	if err != nil {
		t.Fatalf("解析 workdir: %v", err)
	}
	victim := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(victim, []byte("原始内容"), 0o644); err != nil {
		t.Fatalf("写诱饵文件: %v", err)
	}

	// 1) 目录软链：workdir/escape -> outside
	if err := os.Symlink(outside, filepath.Join(wd, "escape")); err != nil {
		t.Skipf("当前环境不支持创建软链: %v", err)
	}
	// 2) 文件软链：workdir/secret.txt -> outside/secret.txt
	if err := os.Symlink(victim, filepath.Join(wd, "secret.txt")); err != nil {
		t.Fatalf("建文件软链: %v", err)
	}
	// 3) 嵌套：workdir/deep/ 是真目录，deep/out -> outside
	deep := filepath.Join(wd, "deep")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(deep, "out")); err != nil {
		t.Fatalf("建嵌套软链: %v", err)
	}

	cases := []struct{ name, path string }{
		{"经目录软链写新文件", "escape/planted.txt"},
		{"经目录软链覆盖已有文件", "escape/secret.txt"},
		{"目标自身是指向外部的文件软链", "secret.txt"},
		{"嵌套目录下的软链", "deep/out/planted.txt"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ResolveInWorkdir(wd, c.path)
			if err == nil {
				t.Fatalf("软链逃逸被放行：%q -> %q", c.path, got)
			}
			if !errors.Is(err, ErrEscape) {
				t.Errorf("错误未归到 ErrEscape: %v", err)
			}
		})
	}

	// "escape/../outside/x" 这条不在上面的拒绝清单里，而是被**改写进**了 workdir：
	// filepath.Clean 是纯词法的，先 Clean 再拼就把它折成了 "outside/x"，
	// 落点是 workdir 内一个同名的新目录，而不是软链指向的那个外部目录。
	// 这正是「先 Clean 再拼」相对「直接交给操作系统解析」的价值所在——
	// 交给操作系统的话 escape 会被真的展开成外部目录，.. 再退一级就出界了。
	if got, err := ResolveInWorkdir(wd, "escape/../outside/planted.txt"); err != nil {
		t.Fatalf("经 Clean 折平后应落在 workdir 内: %v", err)
	} else if !strings.HasPrefix(got, root+string(filepath.Separator)) {
		t.Fatalf("折平后的落点跑到 workdir 外了: %q", got)
	}

	// 诱饵文件必须原封不动——上面任何一条真写出去了，这里就会变。
	b, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("读诱饵文件: %v", err)
	}
	if string(b) != "原始内容" {
		t.Fatalf("workdir 之外的文件被改写了，内容变成 %q", b)
	}
}

// TestResolveInWorkdirAcceptsLegitPaths 反向确认防线没有把正常写入也拦掉。
func TestResolveInWorkdirAcceptsLegitPaths(t *testing.T) {
	wd := newWorkdir(t)
	root, err := filepath.EvalSymlinks(wd)
	if err != nil {
		t.Fatalf("解析 workdir: %v", err)
	}

	cases := []struct{ name, path, want string }{
		{"根下的文件", "notes.md", "notes.md"},
		{"子目录（尚不存在）", "docs/prd.md", "docs/prd.md"},
		{"多层子目录", "a/b/c/deep.md", "a/b/c/deep.md"},
		{"./ 前缀会被折平", "./notes.md", "notes.md"},
		{"中间的 . 会被折平", "docs/./prd.md", "docs/prd.md"},
		{"抵消后仍在目录内", "docs/tmp/../prd.md", "docs/prd.md"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ResolveInWorkdir(wd, c.path)
			if err != nil {
				t.Fatalf("正常路径 %q 被拒了: %v", c.path, err)
			}
			want := filepath.Join(root, c.want)
			if got != want {
				t.Errorf("解析结果 = %q，期望 %q", got, want)
			}
		})
	}
}

// TestResolveInWorkdirRejectsBadWorkdir 覆盖 workdir 本身不可用的情形。
func TestResolveInWorkdirRejectsBadWorkdir(t *testing.T) {
	cases := []struct{ name, workdir string }{
		{"未设置", ""},
		{"相对路径", "relative/dir"},
		{"不存在", filepath.Join(t.TempDir(), "nope")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ResolveInWorkdir(c.workdir, "a.txt"); err == nil {
				t.Fatalf("workdir=%q 应当被拒", c.workdir)
			}
		})
	}

	// workdir 指向一个文件而不是目录。
	f := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatalf("写文件: %v", err)
	}
	if _, err := ResolveInWorkdir(f, "a.txt"); err == nil {
		t.Fatal("workdir 是文件时应当被拒")
	}
}

func TestCheckWorkdir(t *testing.T) {
	dir := newWorkdir(t)

	ok := CheckWorkdir(dir)
	if !ok.Exists || !ok.IsDir || !ok.Writable {
		t.Fatalf("正常目录应当可用，得到 %+v", ok)
	}
	if ok.Message == "" {
		t.Error("message 不能为空")
	}

	missing := CheckWorkdir(filepath.Join(dir, "nope"))
	if missing.Exists || missing.Writable {
		t.Errorf("不存在的目录不应报可用: %+v", missing)
	}
	if !strings.Contains(missing.Message, "不存在") {
		t.Errorf("message 要说清原因，得到 %q", missing.Message)
	}

	file := filepath.Join(dir, "afile")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("写文件: %v", err)
	}
	asFile := CheckWorkdir(file)
	if !asFile.Exists || asFile.IsDir || asFile.Writable {
		t.Errorf("文件不应被当成可用目录: %+v", asFile)
	}

	if rel := CheckWorkdir("relative/path"); rel.Writable || rel.Message == "" {
		t.Errorf("相对路径应当被拒并说明原因: %+v", rel)
	}

	// 只读目录：0o500 去掉写位，创建临时文件必然失败。root 身份会无视权限位，跳过。
	if os.Geteuid() != 0 {
		ro := filepath.Join(dir, "readonly")
		if err := os.Mkdir(ro, 0o500); err != nil {
			t.Fatalf("建只读目录: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })

		res := CheckWorkdir(ro)
		if !res.Exists || !res.IsDir {
			t.Fatalf("只读目录仍然是存在的目录: %+v", res)
		}
		if res.Writable {
			t.Error("只读目录不应报可写")
		}
		if !strings.Contains(res.Message, "不可写") && !strings.Contains(res.Message, "无法写入") {
			t.Errorf("不可写时要说清原因，得到 %q", res.Message)
		}
	}
}
