// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package terminal

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 交给 Claude Code「切换到终端」（终端插件 0.2.0）：设置里配一条启动命令模板，
// 新建会话时带上 claude（工作台写好的提示词文件、MCP 配置、工作目录），插件按模板渲染出命令，
// shell 起来后写进 pty 执行。命令只在用户点击「在终端中打开」后才会被写进去。
//
// 模板占位符：{{prompt_file}} 提示词文件、{{mcp_config}} MCP 配置文件、{{workdir}} 工作目录。
// 替换成单引号引起来的路径（路径里的单引号转义成 '\''），所以模板里不用再加引号；
// 写成 "{{x}}" 或 '{{x}}' 时外面那层引号会去掉，免得变成 "'…'"。
// 没写 {{prompt_file}} 就在末尾补 "$(cat {{prompt_file}})"，没写 {{mcp_config}} 就补 --mcp-config {{mcp_config}}。
// 提示词放在 --mcp-config 前面：--mcp-config 能接多个值，放在它后面的参数会被当成另一份配置吞掉。

const (
	settingClaudeCommand = "claude_command"
	// DefaultClaudeCommand 是没配过时的启动命令：用户 ~/.zshrc 里的别名
	// gogogo='cd /Volumes/docs/Know\ Me && c-d'，c-d='claude --dangerously-skip-permissions'。
	// 终端起的是带 pty 的登录 shell（zsh -l），是交互式的，会读 ~/.zshrc，别名可用。
	DefaultClaudeCommand = "gogogo"
	maxClaudeCommand     = 2000

	phPrompt  = "{{prompt_file}}"
	phMCP     = "{{mcp_config}}"
	phWorkdir = "{{workdir}}"
)

// ClaudeLaunch 是新建会话时带的「开 Claude Code」请求，三个都是工作台给的绝对路径。
type ClaudeLaunch struct {
	PromptFile string `json:"prompt_file"`
	MCPConfig  string `json:"mcp_config"`
	Workdir    string `json:"workdir"`
}

// shellQuote 把值引成 POSIX shell 的单引号字符串。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// RenderClaudeCommand 按模板渲染启动命令，模板为空时用默认值。
func RenderClaudeCommand(tmpl string, l ClaudeLaunch) string {
	cmd := strings.TrimSpace(tmpl)
	if cmd == "" {
		cmd = DefaultClaudeCommand
	}
	if !strings.Contains(cmd, phPrompt) {
		cmd += ` "$(cat ` + phPrompt + `)"`
	}
	if !strings.Contains(cmd, phMCP) {
		cmd += " --mcp-config " + phMCP
	}
	for ph, v := range map[string]string{phPrompt: l.PromptFile, phMCP: l.MCPConfig, phWorkdir: l.Workdir} {
		q := shellQuote(v)
		// 外面包了一层同样的引号的，连引号一起换掉
		cmd = strings.ReplaceAll(cmd, `"`+ph+`"`, q)
		cmd = strings.ReplaceAll(cmd, `'`+ph+`'`, q)
		cmd = strings.ReplaceAll(cmd, ph, q)
	}
	return cmd
}

// checkLaunch：提示词和 MCP 配置要是存在的普通文件（绝对路径），工作目录要是存在的绝对目录。
func checkLaunch(l *ClaudeLaunch) error {
	for name, p := range map[string]*string{"prompt_file": &l.PromptFile, "mcp_config": &l.MCPConfig} {
		v := strings.TrimSpace(*p)
		if v == "" || !filepath.IsAbs(v) {
			return apiErr(errValidation, "claude.%s 要是绝对路径", name)
		}
		st, err := os.Stat(v)
		if err != nil || !st.Mode().IsRegular() {
			return apiErr(errValidation, "claude.%s 不存在：%s", name, v)
		}
		*p = filepath.Clean(v)
	}
	if strings.TrimSpace(l.Workdir) != "" {
		wd, err := checkCwd(l.Workdir)
		if err != nil {
			return err
		}
		l.Workdir = wd
	}
	return nil
}

// claudeCommand 读设置里的启动命令模板，没配过回默认值。
func claudeCommand(ctx context.Context, st plugin.Store) (string, error) {
	var v string
	err := st.QueryRow(ctx, `SELECT value FROM terminal_settings WHERE key = ?`, settingClaudeCommand).Scan(&v)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return DefaultClaudeCommand, nil
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(v) == "" {
		return DefaultClaudeCommand, nil
	}
	return v, nil
}

// terminalSettings 是 GET / PATCH /api/terminal/settings 的响应。
type terminalSettings struct {
	ClaudeCommand        string `json:"claude_command"`
	DefaultClaudeCommand string `json:"default_claude_command"`
}

func (h *handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	cmd, err := claudeCommand(r.Context(), h.c.Store())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": terminalSettings{ClaudeCommand: cmd, DefaultClaudeCommand: DefaultClaudeCommand}})
}

type settingsIn struct {
	ClaudeCommand *string `json:"claude_command"`
}

func (h *handlers) patchSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in settingsIn
	if err := decode(r, &in); err != nil {
		h.fail(w, r, err)
		return
	}
	if in.ClaudeCommand != nil {
		v := strings.TrimSpace(*in.ClaudeCommand)
		if strings.ContainsAny(v, "\r\n") {
			h.fail(w, r, apiErr(errValidation, "启动命令只能写一行，多条命令用 && 或 ; 连起来"))
			return
		}
		if utf8.RuneCountInString(v) > maxClaudeCommand || !utf8.ValidString(v) {
			h.fail(w, r, apiErr(errValidation, "启动命令最多 %d 个字", maxClaudeCommand))
			return
		}
		if v == "" {
			v = DefaultClaudeCommand // 留空等于恢复默认
		}
		old, err := claudeCommand(ctx, h.c.Store())
		if err != nil {
			h.fail(w, r, err)
			return
		}
		if _, err := h.c.Store().Exec(ctx, `INSERT INTO terminal_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			settingClaudeCommand, v, time.Now().UTC().Format(time.RFC3339)); err != nil {
			h.fail(w, r, err)
			return
		}
		if old != v {
			h.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "terminal_settings", TargetID: settingClaudeCommand,
				Summary: "Claude Code 启动命令 " + old + " → " + v, Detail: map[string]any{"from": old, "to": v}}, plugin.WriteMeta{})
		}
	}
	h.getSettings(w, r)
}
