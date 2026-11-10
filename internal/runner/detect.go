// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// 执行器可用性检测（TSK-0722）：找得到可执行文件没有、是哪个版本。
//
// 只做「--version 跑得通」这一层：真正能不能跑一轮（模型路由、MCP、沙箱）要靠集成检查，
// 那一步要花模型调用，不该在每次打开分派弹窗时发生。

// detectTimeout 是 --version 的上限。dsh 是 node 程序，冷启动一两秒；
// 给宽一点，免得机器忙的时候误报「坏了」。
const detectTimeout = 15 * time.Second

// BinInfo 是一次检测的结果。
type BinInfo struct {
	// Path 是解析后的绝对路径；找不到时为空。
	Path string
	// Version 是 --version 输出的第一行，去掉首尾空白。
	Version string
	// NotFound 为真表示按给的名字或路径找不到可执行文件。
	NotFound bool
	// Err 是 --version 跑失败的原因（找不到时也有，文案说清找的是什么）。
	Err error
}

// DetectBin 找 bin（名字走 PATH，带斜杠的按路径）并跑一次 `bin --version`。
// env 追加在当前进程环境后面（dsh 的 DSH_HOME 之类），可以为空。
func DetectBin(ctx context.Context, bin string, env ...string) BinInfo {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return BinInfo{NotFound: true, Err: errors.New("没有指定可执行文件")}
	}
	path, err := exec.LookPath(bin)
	if err != nil {
		return BinInfo{NotFound: true, Err: err}
	}
	ctx, cancel := context.WithTimeout(ctx, detectTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	// 和正式执行一样自成进程组，超时时整组杀掉，不留孤儿。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	if len(env) > 0 {
		cmd.Env = append(cmd.Environ(), env...)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		msg := oneLine(strings.TrimSpace(errOut.String()), 200)
		if ctx.Err() != nil {
			msg = "超过 " + detectTimeout.String() + " 没有返回"
		}
		if msg == "" {
			msg = err.Error()
		}
		return BinInfo{Path: path, Err: errors.New(msg)}
	}
	line, _, _ := strings.Cut(strings.TrimSpace(out.String()), "\n")
	return BinInfo{Path: path, Version: strings.TrimSpace(line)}
}

// ProcessGroupGone 报告进程组 pgid 是不是已经没有任何进程了（kill(-pgid, 0) 回 ESRCH）。
// 集成检查用它确认一次执行收尾后整组都退干净了。pgid <= 1 一律回 false，不去碰。
func ProcessGroupGone(pgid int) bool {
	if pgid <= 1 {
		return false
	}
	return errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH)
}

// KillProcessGroup 给进程组发 SIGKILL。只在 ProcessGroupGone 回 false 时用：
// 组还在，说明这个组号没被回收，不会打到别人。
func KillProcessGroup(pgid int) {
	if pgid > 1 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
}
