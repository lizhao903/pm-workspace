package incident

import (
	"fmt"
	"strings"
)

// ClaudeFingerprintPrefix 是 Claude Code 执行失败的指纹前缀；巡检认它跳过，不自动建修复任务。
const ClaudeFingerprintPrefix = "claude:"

// Claude Code 执行失败记运行异常（INC-01a 追加，用户要求「claude 执行异常也记入运行异常」）。
// 任务执行（POST /api/objects/{id}/run）和插件交给 Claude Code 的运行（Core.Runs().StartClaudeCode）共用这个口径；
// 取消不算异常，只有 failed（含没起来、超时、退出码不为 0、服务重启中断）记。

// ModuleClaudeCode 是 Claude Code 执行失败的模块名。
const ModuleClaudeCode = "Claude Code"

// claudeOutputTail 是带进 stack 的输出末尾行数。
const claudeOutputTail = 40

// ClaudeRun 是一次失败的 Claude Code 执行。ObjectID 为空时按 Via（发起方，插件 id）归并。
type ClaudeRun struct {
	RunID       string
	ObjectID    string
	ObjectRef   string
	ObjectTitle string
	Workdir     string
	ExitCode    int
	Error       string
	Output      string
	AllowWrites bool
	Via         string // task（任务执行）或插件 id
	Source      string // 记到 Incident.source，空为 backend
}

// ClaudeRunReport 是失败执行的运行异常：错误级、模块 Claude Code，
// 指纹 claude:<对象 id>:failed（同一个任务反复失败合并；没有对象的按 claude:<发起方>:failed），
// 内容是失败原因（没有原因时写退出码），stack 是输出的最后 40 行。
func ClaudeRunReport(c ClaudeRun) Report {
	key := c.ObjectID
	if key == "" {
		key = c.Via
	}
	title := "Claude Code 执行失败"
	if name := strings.TrimSpace(strings.TrimSpace(c.ObjectRef) + " " + strings.TrimSpace(c.ObjectTitle)); name != "" {
		title += "：" + name
	}
	msg := strings.TrimSpace(c.Error)
	if msg == "" {
		msg = fmt.Sprintf("进程退出码 %d", c.ExitCode)
	}
	ctx := map[string]any{"执行 id": c.RunID, "工作目录": c.Workdir, "退出码": c.ExitCode, "允许写文件": c.AllowWrites, "发起": c.Via}
	if c.ObjectID != "" {
		ctx["任务"] = strings.TrimSpace(c.ObjectRef + " " + c.ObjectTitle)
		ctx["任务 id"] = c.ObjectID
	}
	lines := strings.Split(strings.TrimRight(c.Output, "\n"), "\n")
	if len(lines) > claudeOutputTail {
		lines = lines[len(lines)-claudeOutputTail:]
	}
	src := c.Source
	if src == "" {
		src = SourceBackend
	}
	return Report{
		Fingerprint: ClaudeFingerprintPrefix + key + ":failed",
		Level:       LevelError,
		Module:      ModuleClaudeCode,
		Title:       title,
		Message:     msg,
		Stack:       strings.TrimSpace(strings.Join(lines, "\n")),
		Context:     ctx,
		Source:      src,
	}
}
