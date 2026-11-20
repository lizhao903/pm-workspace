// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"os"
	"path/filepath"
	"strings"
)

// 额外可读目录（TSK-0851）。
//
// Claude Code 只许访问工作目录（和 --add-dir）。SOP 的 Claude Code 节点常常要在 A 目录产出、去 B 目录读素材
// （「系统版本更新 → 视频素材」：在 web-video 里做视频，去 pm-workspace 读本周 git log）。B 在工作目录外，
// ls / cat / Read 和 git log 全被挡，白名单里的 Bash(git log:*)、Bash(ls:*) 也放不开（2.1.329 实测）。
//
// 不用 --add-dir：它把目录并进工作区，可写档位下连编辑也一起放开了，而这里要的只是「读」。
// 改为按目录生成一组只读规则（2.1.329 -p + acceptEdits 实测全部放行、且 cd 到别处再跑 git 照旧被拒）：
//
//   - Read(//<目录>/**)：Read / Grep / Glob 和 ls、cat、head 这类带该目录绝对路径的只读命令；
//   - Bash(git -C <目录> <子命令>:*)：git 在别的目录里跑要写成 git -C，前缀和 Bash(git log:*) 对不上，
//     要按目录单独放；子命令只收 ReadOnlyCommands 里那几个只读的（log、show、diff、status、blame、ls-files、rev-parse）。
//
// 路径里有空白、引号或 shell 元字符时不给 git 规则（命令里得加引号，前缀对不上），只给 Read 规则。

// readDirGitSubs 是给额外可读目录放行的 git 子命令，和 ReadOnlyCommands 里的 git 那几条一致。
var readDirGitSubs = []string{"log", "show", "diff", "status", "blame", "ls-files", "rev-parse"}

// CheckReadDir 校验一个额外可读目录：绝对路径、存在、是目录。回规范化后的路径（不解软链）。
func CheckReadDir(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", validationErr("额外可读目录不能是空的")
	}
	if !filepath.IsAbs(path) {
		return "", validationErr("额外可读目录必须是绝对路径：" + path)
	}
	path = filepath.Clean(path)
	fi, err := os.Stat(path)
	switch {
	case os.IsNotExist(err):
		return "", validationErr("额外可读目录不存在：" + path)
	case err != nil:
		return "", validationErr("无法访问额外可读目录：" + path)
	case !fi.IsDir():
		return "", validationErr("额外可读目录是一个文件，不是目录：" + path)
	}
	if strings.ContainsAny(path, "()") {
		// 括号会截断规则（Read(//a(b)/**)），Claude Code 怎么解析没验证过，不收
		return "", validationErr("额外可读目录的路径里不能有括号：" + path)
	}
	return path, nil
}

// ReadDirRules 是放行这些目录只读访问的 --allowedTools 规则，去重保序。dirs 应当先过 CheckReadDir。
// 目录是软链接时实际路径也放一份：Claude Code 按实际路径判。
func ReadDirRules(dirs []string) []string {
	var out []string
	for _, d := range dirs {
		paths := []string{filepath.Clean(d)}
		if real, err := filepath.EvalSymlinks(d); err == nil && real != paths[0] {
			paths = append(paths, real)
		}
		for _, p := range paths {
			out = append(out, "Read(/"+p+"/**)")
			if !shellSafePath(p) {
				continue
			}
			for _, sub := range readDirGitSubs {
				out = append(out, "Bash(git -C "+p+" "+sub+":*)")
			}
		}
	}
	return dedupe(out)
}

// shellSafePath：路径不用加引号就能原样写进命令（只含字母数字、中文等非 ASCII 字符和 / . _ - + @ 这几个符号）。
func shellSafePath(p string) bool {
	for _, c := range p {
		switch {
		case c > 127:
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.ContainsRune("/._-+@", c):
		default:
			return false
		}
	}
	return true
}

// ReadDirsSection 是拼在提示词末尾的一节：告诉 Claude Code 哪些目录能读、怎么写命令才不会被拒。没有目录回空串。
func ReadDirsSection(dirs []string) string {
	if len(dirs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n## 额外可读目录\n")
	b.WriteString("下面这些目录在工作目录之外，已放行只读访问，不能改里面的文件。读文件用 Read / Grep，或 ls、cat 带绝对路径；" +
		"看 git 历史写成 `git -C <目录> log …`（也可 show、diff、status），不要 cd 过去再跑 git，也不要给 shell 变量赋值，那样会被拒。\n")
	for _, d := range dirs {
		b.WriteString("- " + d + "\n")
	}
	return b.String()
}
