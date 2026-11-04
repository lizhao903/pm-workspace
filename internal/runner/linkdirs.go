package runner

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 工作目录里软链接进来的外部目录（SPEC-tasks-6.19）。
//
// 资料目录常见的组织方式是在项目目录里放软链接，指向别处的真实目录（例如 Know Me/Octok项目/云端功能需求
// 指向 PRDs/Octok/云端功能需求）。claude 按实际路径判断能不能访问，软链接进来的目录在工作目录外，
// 执行时会被挡下。这里找出这些目录，执行时逐个 --add-dir 放进来。
//
// 只看工作目录本层和下一层（linkDepth），不往更深处走：资料目录可能很大，逐层遍历会拖慢每一次发起；
// 软链接一般就放在项目根目录或它下面一层。指向工作目录里面的、指向文件的、断掉的都不算。

const (
	// linkDepth 是往下看几层：0 是工作目录本层。
	linkDepth = 1
	// maxLinkedDirs 是最多加几个目录，再多说明目录选得太大，加了也意义不大。
	maxLinkedDirs = 20
	// maxLinkScan 是每层最多看多少个条目，挡住一个装了几万个文件的目录。
	maxLinkScan = 2000
)

// LinkedDirs 回工作目录里（本层和下一层）软链接指向、实际路径在工作目录外的目录，按路径排序、去重。
func LinkedDirs(workdir string) []string {
	root, err := filepath.EvalSymlinks(workdir)
	if err != nil {
		return nil
	}
	// 工作目录在 git worktree 里时（AUTO-07），写只许落在 worktree 里：指向主仓库目录的软链不放进来
	mainRepo := WorktreeMainRepo(root)
	seen := map[string]bool{}
	var out []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		f, err := os.Open(dir)
		if err != nil {
			return
		}
		ents, _ := f.ReadDir(maxLinkScan)
		_ = f.Close()
		for _, e := range ents {
			if len(out) >= maxLinkedDirs {
				return
			}
			p := filepath.Join(dir, e.Name())
			if e.Type()&os.ModeSymlink == 0 {
				if e.IsDir() && depth < linkDepth && !strings.HasPrefix(e.Name(), ".") {
					walk(p, depth+1)
				}
				continue
			}
			real, err := filepath.EvalSymlinks(p)
			if err != nil {
				continue
			}
			st, err := os.Stat(real)
			if err != nil || !st.IsDir() || inside(root, real) || seen[real] || (mainRepo != "" && inside(mainRepo, real)) {
				continue
			}
			seen[real] = true
			out = append(out, real)
		}
	}
	walk(root, 0)
	sort.Strings(out)
	return out
}

// WorktreeMainRepo：dir 在 git 的附加 worktree 里时，回主仓库的目录（实际路径），否则回空串。
//
// 附加 worktree 的根目录里 .git 是个文件，写着「gitdir: <主仓库>/.git/worktrees/<名字>」；从 dir 往上找第一个 .git，
// 是目录（普通仓库）或找不到就不是 worktree。只读一个小文件，不起 git 进程。
func WorktreeMainRepo(dir string) string {
	for d := dir; ; {
		p := filepath.Join(d, ".git")
		st, err := os.Lstat(p)
		if err == nil {
			if st.IsDir() || st.Size() > 4096 {
				return ""
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return ""
			}
			gd, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
			if !ok {
				return ""
			}
			gd = strings.TrimSpace(gd)
			if !filepath.IsAbs(gd) {
				gd = filepath.Join(d, gd)
			}
			sep := string(filepath.Separator)
			i := strings.LastIndex(filepath.Clean(gd), sep+".git"+sep+"worktrees"+sep)
			if i < 0 {
				return ""
			}
			main := filepath.Clean(gd)[:i]
			if real, err := filepath.EvalSymlinks(main); err == nil {
				return real
			}
			return main
		}
		up := filepath.Dir(d)
		if up == d {
			return ""
		}
		d = up
	}
}

// inside：p 是 root 本身或在它下面。
func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
