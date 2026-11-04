package runner

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLinkedDirs(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	wd := filepath.Join(base, "wd")
	outA, outB, outDeep := filepath.Join(base, "a"), filepath.Join(base, "b"), filepath.Join(base, "deep")
	for _, d := range []string{wd, outA, outB, outDeep, filepath.Join(wd, "sub", "inner"), filepath.Join(wd, "sub", "x")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "f.txt"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := func(target, at string) {
		if err := os.Symlink(target, filepath.Join(wd, at)); err != nil {
			t.Fatal(err)
		}
	}
	link(outA, "云端功能需求")                          // 本层，指向外面：要
	link(outB, "sub/本地功能需求")                      // 下一层：要
	link(outA, "sub/重复")                          // 同一个目标只算一次
	link(filepath.Join(wd, "sub", "inner"), "内部") // 指向里面：不要
	link(filepath.Join(base, "f.txt"), "文件")      // 指向文件：不要
	link(filepath.Join(base, "nope"), "断的")       // 断掉的：不要
	link(outDeep, "sub/x/太深")                     // 第三层：不看

	got := LinkedDirs(wd)
	if want := []string{outA, outB}; !reflect.DeepEqual(got, want) {
		t.Errorf("LinkedDirs = %q，want %q", got, want)
	}
	if LinkedDirs(filepath.Join(base, "不存在")) != nil {
		t.Error("目录不存在时应回 nil")
	}
	args := strings.Join(buildArgs("p", false, got...), " ")
	if !strings.Contains(args, "--add-dir "+outA+" --add-dir "+outB) {
		t.Errorf("每个目录单独一个 --add-dir：%q", args)
	}
}

// 工作目录在 git 附加 worktree 里时（AUTO-07），指向主仓库目录的软链不 --add-dir，写只落在 worktree 里
func TestLinkedDirsSkipsMainRepoOfWorktree(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	main := filepath.Join(base, "main")
	wt := filepath.Join(base, "data", "worktrees", "TSK-1")
	out := filepath.Join(base, "docs")
	for _, d := range []string{filepath.Join(main, ".git", "worktrees", "TSK-1"), filepath.Join(main, "src"), filepath.Join(wt, "pkg"), out} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+filepath.Join(main, ".git", "worktrees", "TSK-1")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for at, target := range map[string]string{"主仓库": main, "pkg/主仓库源码": filepath.Join(main, "src"), "资料": out} {
		if err := os.Symlink(target, filepath.Join(wt, at)); err != nil {
			t.Fatal(err)
		}
	}
	if got := WorktreeMainRepo(filepath.Join(wt, "pkg")); got != main {
		t.Fatalf("WorktreeMainRepo = %q，want %q", got, main)
	}
	if got := WorktreeMainRepo(main); got != "" {
		t.Fatalf("主仓库本身不是附加 worktree：%q", got)
	}
	if got := LinkedDirs(wt); !reflect.DeepEqual(got, []string{out}) {
		t.Fatalf("LinkedDirs = %q，只该有 worktree 外、主仓库外的目录", got)
	}
	// 普通目录照旧
	if got := LinkedDirs(main); got != nil {
		t.Fatalf("主仓库里没有软链：%q", got)
	}
}
