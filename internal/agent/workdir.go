// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// ErrEscape 是所有「这个路径跑到 workdir 外面去了」的统一哨兵。
// 调用方只需判断它，不必区分是 ../、绝对路径还是软链——对使用者来说都是同一件事：
// 这次写入被拒绝了。
var ErrEscape = errors.New("path escapes the session workdir")

// escape 造一条带具体原因的越界错误。原因要说清楚，用户才知道该怎么改；
// 但哨兵统一，调用方不必逐种匹配。
func escape(reason string) error {
	return fmt.Errorf("%w: %s", ErrEscape, reason)
}

// ResolveInWorkdir 把一个相对路径解析成 workdir 之内的绝对路径，越界一律拒绝。
//
// 这是整个 Agent 唯一能写盘的入口，也是它最大的攻击面：模型的输出不可信，
// 一个被诱导的 write_file("../../.ssh/authorized_keys") 就是一次本机接管。
// 所以这里按四道关卡逐层收：
//
//  1. 语法层：拒空路径、拒绝对路径、拒 Clean 之后仍以 .. 开头的路径。
//     先 Clean 再判，"a/../../b" 这种绕一圈才出界的写法才挡得住。
//  2. 前缀层：拼出绝对路径后检查它落在 root 之内，且前缀后面紧跟分隔符——
//     只比前缀的话 /foo/barbaz 会被误判成落在 /foo/bar 里。
//  3. 软链层：父目录逐级解析真实路径再复查。文件本身还不存在，
//     所以要找到「最深的那个已存在的祖先」来解析，再把尚不存在的段拼回去。
//  4. 目标层：如果目标自己已经是一条指向外面的软链，覆盖写会顺着它写出去，同样要拒。
//
// root 本身也先过一次 EvalSymlinks：macOS 上 /var 就是指向 /private/var 的软链，
// 不统一到真实路径的话，第 3 步解析出来的结果永远对不上前缀。
func ResolveInWorkdir(workdir, name string) (string, error) {
	workdir = strings.TrimSpace(workdir)
	if workdir == "" {
		return "", errors.New("这次会话还没有设置产物目录，请先指定一个输出目录")
	}
	if !filepath.IsAbs(workdir) {
		return "", errors.New("产物目录必须是绝对路径")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "", escape("路径不能为空")
	}
	if strings.ContainsRune(name, 0) {
		return "", escape("路径中不能包含空字符")
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return "", escape("不能写绝对路径，只能写相对产物目录的路径")
	}

	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", escape("路径不能跳出产物目录")
	}

	// root 必须是一个真实存在的目录：写进一个不存在的目录没有意义，
	// 而且 EvalSymlinks 也无从解析。
	root, err := filepath.EvalSymlinks(workdir)
	if err != nil {
		return "", fmt.Errorf("产物目录不可用：%s", workdirReason(workdir))
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("产物目录不可用：%s", workdirReason(workdir))
	}

	abs := filepath.Join(root, clean)
	if !within(root, abs) {
		return "", escape("路径不能跳出产物目录")
	}

	// 父目录的真实位置。走到这里 abs 的父目录可能整条都还不存在（write_file 允许建目录）。
	realParent, err := resolveDeepest(filepath.Dir(abs))
	if err != nil {
		return "", escape("无法确认路径的真实位置")
	}
	if !within(root, realParent) {
		return "", escape("路径经由符号链接指向了产物目录之外")
	}

	// 目标自身若已存在且是软链，顺着它写就出界了。
	if real, err := filepath.EvalSymlinks(abs); err == nil && !within(root, real) {
		return "", escape("目标是一条指向产物目录之外的符号链接")
	}

	return filepath.Join(realParent, filepath.Base(abs)), nil
}

// within 判断 p 是否就是 root 或落在 root 之内。
// 必须要求前缀之后紧跟分隔符：否则 /foo/barbaz 会被当成落在 /foo/bar 里，
// 一个同前缀的兄弟目录就足以绕过整道防线。
func within(root, p string) bool {
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(filepath.Separator))
}

// resolveDeepest 解析 dir 的真实路径。dir 可能还不存在，
// 那就一级级往上找到最深的那个存在的祖先，解析它，再把缺的那几段原样接回去。
//
// 只解析存在的部分是有意的：不存在的段不可能是软链，接回去不会引入新的逃逸路径，
// 而调用方随后建目录时会落在已经验证过的真实祖先之下。
func resolveDeepest(dir string) (string, error) {
	var missing []string
	cur := dir
	for {
		real, err := filepath.EvalSymlinks(cur)
		if err == nil {
			out := real
			// missing 是自底向上攒的，接回去要反过来。
			for i := len(missing) - 1; i >= 0; i-- {
				out = filepath.Join(out, missing[i])
			}
			return out, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			// 一路走到根都不存在，只可能是路径本身有问题。
			return "", errors.New("no existing ancestor")
		}
		missing = append(missing, filepath.Base(cur))
		cur = parent
	}
}

// CheckWorkdir 报告一个目录能不能用作产物落盘位置。
// Message 要说清不可用的原因——只回一个 false，用户只能干瞪眼猜是权限问题还是路径打错了。
func CheckWorkdir(path string) domain.WorkdirCheck {
	out := domain.WorkdirCheck{Path: strings.TrimSpace(path)}
	if out.Path == "" {
		out.Message = "请填写一个目录路径"
		return out
	}
	if !filepath.IsAbs(out.Path) {
		out.Message = "请填写绝对路径，例如 /Users/you/Documents/工作台产出"
		return out
	}
	// 规范化一次，把 /a/b/../c 这类写法折平，免得界面上显示的和实际用的不是一个地方。
	out.Path = filepath.Clean(out.Path)

	fi, err := os.Stat(out.Path)
	switch {
	case os.IsNotExist(err):
		out.Message = "目录不存在，可以先在访达里创建它"
		return out
	case os.IsPermission(err):
		out.Message = "没有权限访问这个路径，请检查目录权限"
		return out
	case err != nil:
		out.Message = "无法访问这个路径，请检查它是否正确"
		return out
	}

	out.Exists = true
	if !fi.IsDir() {
		out.Message = "这是一个文件，不是目录"
		return out
	}
	out.IsDir = true

	// 可写性只能实测：权限位、只读挂载、macOS 的 TCC 授权，任何一条都能让
	// 「看起来可写」的目录写不进去。
	f, err := os.CreateTemp(out.Path, ".pmw-write-check-*")
	if err != nil {
		if os.IsPermission(err) {
			out.Message = "目录存在但不可写，请检查目录权限（或该位置需要系统授权）"
		} else {
			out.Message = "目录存在但无法写入，请换一个位置"
		}
		return out
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)

	out.Writable = true
	out.Message = "目录可用，Agent 的产出会写到这里"
	return out
}

// workdirReason 给 ResolveInWorkdir 的失败补一句原因，复用 CheckWorkdir 的判断，
// 保证「检查目录」和「真正写入」两条路径给出的说法是一致的。
func workdirReason(path string) string {
	return CheckWorkdir(path).Message
}
