package runner

import (
	"fmt"
	"strings"
)

// 后台执行的权限档位（TSK-0499）。
//
// claude -p 没人值守：任何需要确认的调用都会被直接拒绝。只给 --permission-mode acceptEdits 时，
// 工作台自己的 MCP 和最普通的只读命令（sqlite3 -readonly、管道里的 wc）也一并被挡，
// 提示词要求的「读任务、记进展、回写结论」根本调不通。所以每一档都带两样东西：
//
//   - 工作台 MCP（server 名 MCPServer）的全部工具，指回当前工作台实例；
//   - 一份默认的只读命令白名单。
//
// 档位从低到高：
//
//	read_only        只读：不加 --permission-mode，文件编辑仍要确认（即被拒）
//	accept_edits     允许改文件：--permission-mode acceptEdits
//	edits_and_tests  允许改文件 + 跑测试构建：再加测试、构建、格式检查命令
//	custom           自定义白名单：允许改文件 + 只读命令 + 设置里录的规则
//
// 任何档位都不传 --dangerously-skip-permissions，白名单之外的调用照旧被拒，
// 被拒的会在结尾列出并给出放行的入口（denialReason）。
//
// Claude Code 对管道、&&、; 连起来的命令按每一段分别判定，白名单按段生效：
// `sqlite3 -readonly -safe x.db ".tables" | head` 要两段都在白名单里（或是 Claude Code
// 自己认定的只读命令）才放行。输出重定向（> 文件）不算只读，只读档位下照旧被拒（2.1.319 实测）。
const (
	PermReadOnly      = "read_only"
	PermAcceptEdits   = "accept_edits"
	PermEditsAndTests = "edits_and_tests"
	PermCustom        = "custom"
)

// PermProfiles 是全部档位，按从低到高排。
var PermProfiles = []string{PermReadOnly, PermAcceptEdits, PermEditsAndTests, PermCustom}

// PermLabel 是档位给人看的名字，界面和被拒提示里用同一套。
func PermLabel(p string) string {
	switch p {
	case PermReadOnly:
		return "只读"
	case PermAcceptEdits:
		return "允许改文件"
	case PermEditsAndTests:
		return "允许改文件 + 跑测试构建"
	case PermCustom:
		return "自定义白名单"
	}
	return p
}

// ValidPerm 报告 p 是不是认识的档位。
func ValidPerm(p string) bool {
	for _, x := range PermProfiles {
		if x == p {
			return true
		}
	}
	return false
}

// PermWrites 报告这一档放不放开文件编辑。
func PermWrites(p string) bool { return p != PermReadOnly }

// ReadOnlyCommands 是每一档都放行的只读命令。
//
// 收录的标准是「按这个前缀开头的命令不会改文件、不会再拉起任意程序」。刻意没收的：
//   - sqlite3 不带 -safe：.shell / .system 能跑任意命令，.output 能写文件，-readonly 管不住；
//     -safe 模式下这三样连同 ATTACH 都被拒（sqlite 3.45 实测），所以只放 -readonly -safe 两种写法；
//   - rg：--pre 会对每个文件跑一个外部程序；搜索用 Grep 工具或 grep；
//   - find：-exec / -delete；sed / awk：-i 和 system() 都能写；git branch / checkout：会改仓库。
//
// git diff 的 --output=<文件> 能写文件，属已知边界：写的位置受工作目录约束，影响等同一次文件编辑。
var ReadOnlyCommands = []string{
	"Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
	"Bash(git blame:*)", "Bash(git ls-files:*)", "Bash(git rev-parse:*)",
	"Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
	"Bash(grep:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(cut:*)", "Bash(jq:*)", "Bash(pwd)",
	"Bash(sqlite3 -readonly -safe:*)", "Bash(sqlite3 -safe -readonly:*)",
}

// TestCommands 是「允许改文件 + 跑测试构建」档额外放行的命令。
//
// 安全边界：测试和构建会执行项目自己的代码（测试用例、Makefile、npm scripts），
// 等于让项目代码以你的身份在本机运行——所以它是单独一档、要在发起时选，不是默认。
var TestCommands = []string{
	"Bash(go test:*)", "Bash(go vet:*)", "Bash(go build:*)", "Bash(gofmt -l:*)",
	"Bash(make test:*)", "Bash(make build:*)",
	"Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npm run typecheck:*)", "Bash(npm run build:*)", "Bash(npm run lint:*)",
	"Bash(npx tsc:*)", "Bash(npx vitest:*)",
	"Bash(pytest:*)", "Bash(cargo test:*)", "Bash(cargo build:*)",
}

// MCPAllowRule 是放行工作台 MCP 全部工具的规则（只写 server 名即放行该 server 的所有工具）。
func MCPAllowRule() string { return "mcp__" + MCPServer }

// PermAllowed 是某一档要传给 --allowedTools 的全部规则（不含 MCP，MCP 只在接上时才加）。
// custom 是自定义白名单，只在 custom 档生效。
func PermAllowed(p string, custom []string) []string {
	out := append([]string(nil), ReadOnlyCommands...)
	switch p {
	case PermEditsAndTests:
		out = append(out, TestCommands...)
	case PermCustom:
		out = append(out, custom...)
	}
	return dedupe(out)
}

func dedupe(xs []string) []string {
	seen := map[string]bool{}
	out := xs[:0]
	for _, x := range xs {
		if x == "" || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
	}
	return out
}

// 自定义白名单的上限。规则是给 --allowedTools 的参数，一条一个，没理由很长很多。
const (
	MaxCustomRules   = 100
	MaxCustomRuleLen = 200
)

// CheckRule 校验一条自定义规则，回规范化之后的写法。
//
// 不收「整个 Bash」：Bash、Bash(*)、Bash(:*) 等于放开任意命令，和 --dangerously-skip-permissions
// 只差文件编辑那一步，不能让它通过白名单的口子进来。
func CheckRule(rule string) (string, error) {
	r := strings.TrimSpace(rule)
	if r == "" {
		return "", fmt.Errorf("规则不能是空的")
	}
	if len(r) > MaxCustomRuleLen {
		return "", fmt.Errorf("规则「%s…」太长，最多 %d 个字符", r[:40], MaxCustomRuleLen)
	}
	if strings.ContainsAny(r, "\n\r\t") {
		return "", fmt.Errorf("规则「%s」里不能有换行或制表符", r)
	}
	switch r {
	case "Bash", "Bash(*)", "Bash(:*)", "Bash()", "Bash(* :*)":
		return "", fmt.Errorf("「%s」等于放开任意命令，不收；按命令前缀写，如 Bash(git commit:*)", r)
	}
	if strings.HasPrefix(r, "Bash(") {
		if !strings.HasSuffix(r, ")") {
			return "", fmt.Errorf("「%s」少了右括号，写成 Bash(命令前缀:*)", r)
		}
		inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(r, "Bash("), ")"))
		if inner == "" || strings.HasPrefix(inner, "*") || strings.HasPrefix(inner, ":") {
			return "", fmt.Errorf("「%s」等于放开任意命令，不收；按命令前缀写，如 Bash(git commit:*)", r)
		}
		return r, nil
	}
	if strings.HasPrefix(r, "mcp__") {
		if len(r) <= len("mcp__") {
			return "", fmt.Errorf("「%s」少了 server 名", r)
		}
		return r, nil
	}
	// 其余按工具名（可带括号限定）收：Edit、WebFetch(domain:example.com)、Read(~/notes/**) 等。
	name, _, _ := strings.Cut(r, "(")
	for _, c := range name {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return "", fmt.Errorf("「%s」不像 Claude Code 的权限规则：写成 Bash(命令前缀:*)、mcp__server 或工具名", r)
		}
	}
	if name == "" || name[0] < 'A' || name[0] > 'Z' {
		return "", fmt.Errorf("「%s」不像 Claude Code 的权限规则：工具名首字母大写，如 WebFetch", r)
	}
	return r, nil
}

// CleanRules 校验并去重一组自定义规则，保持原顺序。
func CleanRules(rules []string) ([]string, error) {
	out := make([]string, 0, len(rules))
	seen := map[string]bool{}
	for _, x := range rules {
		if strings.TrimSpace(x) == "" {
			continue
		}
		r, err := CheckRule(x)
		if err != nil {
			return nil, err
		}
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	if len(out) > MaxCustomRules {
		return nil, fmt.Errorf("自定义白名单最多 %d 条", MaxCustomRules)
	}
	return out, nil
}

// SuggestRules 从被拒的调用里推出「加进白名单就能放行」的规则，去重保序。
//
// Bash 命令按 &&、||、;、| 拆段，每段取命令名（git / npm / go / make 这类再带上子命令）
// 作前缀；已经在 allowed 里的段跳过——那一段不是被拒的原因。文件编辑类工具不给规则：
// 它们靠档位放开（选「允许改文件」），不该一条条加进白名单。
func SuggestRules(denials []Denial, allowed []string) []string {
	have := map[string]bool{}
	for _, a := range allowed {
		have[a] = true
	}
	var out []string
	add := func(r string) {
		if r != "" && !have[r] {
			have[r] = true
			out = append(out, r)
		}
	}
	for _, d := range denials {
		switch {
		case d.ToolName == "Bash":
			cmd, _ := d.ToolInput["command"].(string)
			for _, seg := range splitCommand(cmd) {
				r := bashRule(seg)
				if r == "" || covered(r, seg, allowed) {
					continue
				}
				add(r)
			}
		case strings.HasPrefix(d.ToolName, "mcp__"):
			add(d.ToolName)
		case editTools[d.ToolName]:
			// 档位的事，不进白名单
		case d.ToolName != "":
			add(d.ToolName)
		}
	}
	return out
}

var editTools = map[string]bool{"Edit": true, "MultiEdit": true, "Write": true, "NotebookEdit": true}

// subcommandTools 的规则带上子命令：Bash(git:*) 会把 git push、git reset 一起放开。
var subcommandTools = map[string]bool{
	"git": true, "go": true, "npm": true, "npx": true, "pnpm": true, "yarn": true, "make": true,
	"cargo": true, "docker": true, "kubectl": true, "gh": true, "pip": true, "uv": true, "python": true, "python3": true,
}

// splitCommand 按 shell 的连接符拆段。只为给建议，不求完全符合 shell 语法：引号里的 | 会被误拆，
// 误拆的结果只是多一条建议，不影响放行本身（放行由 Claude Code 判定）。
func splitCommand(cmd string) []string {
	var segs []string
	cur := strings.Builder{}
	var quote rune
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			segs = append(segs, s)
		}
		cur.Reset()
	}
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		if quote != 0 {
			cur.WriteRune(c)
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
			cur.WriteRune(c)
		case ';', '|', '&', '\n':
			flush()
		default:
			cur.WriteRune(c)
		}
	}
	flush()
	return segs
}

// bashRule 给一段命令拼前缀规则：命令名，或命令名加子命令（subcommandTools）。
// 开头的环境变量赋值（FOO=1 cmd）跳过；cd 不出规则（Claude Code 自己放行）。
func bashRule(seg string) string {
	f := strings.Fields(seg)
	for len(f) > 0 && strings.Contains(f[0], "=") && !strings.HasPrefix(f[0], "-") {
		f = f[1:]
	}
	if len(f) == 0 || f[0] == "cd" {
		return ""
	}
	name := f[0]
	if subcommandTools[name] && len(f) > 1 && !strings.HasPrefix(f[1], "-") {
		if (name == "npm" || name == "pnpm" || name == "yarn") && f[1] == "run" && len(f) > 2 {
			return "Bash(" + name + " run " + f[2] + ":*)"
		}
		return "Bash(" + name + " " + f[1] + ":*)"
	}
	if name == "sqlite3" {
		// 不给 Bash(sqlite3:*)：那会连 .shell 一起放开。指向只读安全写法。
		return "Bash(sqlite3 -readonly -safe:*)"
	}
	return "Bash(" + name + ":*)"
}

// covered 粗判一段命令是不是已被某条前缀规则覆盖（只看 Bash(前缀:*) 和 Bash(完整命令)）。
func covered(rule, seg string, allowed []string) bool {
	seg = strings.TrimSpace(seg)
	for _, a := range allowed {
		if a == rule {
			return true
		}
		if !strings.HasPrefix(a, "Bash(") || !strings.HasSuffix(a, ")") {
			continue
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(a, "Bash("), ")")
		if p, ok := strings.CutSuffix(inner, ":*"); ok {
			if seg == p || strings.HasPrefix(seg, p+" ") {
				return true
			}
		} else if seg == inner {
			return true
		}
	}
	return false
}
