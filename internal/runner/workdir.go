// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// invalid 让 message 只留面向用户的那句话，错误类别交给哨兵（API 层据此映射 code）。
// 用 fmt.Errorf("%w: ...") 会把哨兵自己的英文文案也拼进去，界面上会出现
// "validation failed: 工作区目录不存在" 这种半中半英的提示。
type invalid struct {
	msg      string
	sentinel error
}

func (e *invalid) Error() string { return e.msg }
func (e *invalid) Unwrap() error { return e.sentinel }

// validationErr 构造一条 400 校验错误，message 直接展示给用户。
func validationErr(msg string) error {
	return &invalid{msg: msg, sentinel: domain.ErrValidation}
}

// ErrNoWorkdir 是「这次执行没有工作目录」的哨兵。
//
// 它必须是一条硬错误，不能退化成「用当前目录」：进程的当前目录就是工作台自己的
// 源码目录，claude 会在里面直接改文件。一个默认值就能把「跑个任务」变成
// 「把工作台自己改了」，这是本包最不能省的一道校验。
var ErrNoWorkdir = validationErr("请先为这个任务或它所属的项目设置工作区目录")

// checkWorkdir 把用户给的路径校验成可以直接交给 exec.Cmd.Dir 的绝对路径。
//
// 可写性只能实测：权限位、只读挂载、macOS 的 TCC 授权，任何一条都能让
// 「看起来可写」的目录写不进去。报错信息要说清是哪一环不行，否则用户
// 只能对着一句「目录不可用」猜是路径打错了还是没授权。
func checkWorkdir(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", ErrNoWorkdir
	}
	if !filepath.IsAbs(path) {
		return "", validationErr("工作区目录必须是绝对路径，例如 /Users/you/Projects/demo")
	}
	// 规范化一次，把 /a/b/../c 折平，免得记录里存的和实际用的不是一个地方。
	path = filepath.Clean(path)

	fi, err := os.Stat(path)
	switch {
	case os.IsNotExist(err):
		return "", validationErr("工作区目录不存在：" + path)
	case os.IsPermission(err):
		return "", validationErr("没有权限访问工作区目录：" + path)
	case err != nil:
		return "", validationErr("无法访问工作区目录：" + path)
	}
	if !fi.IsDir() {
		return "", validationErr("工作区目录是一个文件，不是目录：" + path)
	}

	f, err := os.CreateTemp(path, ".pmw-run-check-*")
	if err != nil {
		if os.IsPermission(err) {
			return "", validationErr("工作区目录不可写，请检查目录权限（或该位置需要系统授权）：" + path)
		}
		return "", validationErr("工作区目录无法写入，请换一个位置：" + path)
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)

	return path, nil
}

// CheckWorkdir 是给 API 层用的预检：在建执行记录之前就把不可用的目录挡掉，
// 免得库里留下一条注定失败的记录。返回规范化后的绝对路径。
func CheckWorkdir(path string) (string, error) { return checkWorkdir(path) }
