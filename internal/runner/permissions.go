// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"fmt"
	"path/filepath"
	"regexp"
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
//	auto             自动审核：--permission-mode auto；只读命令、自定义白名单、项目执行白名单照旧直接放行，
//	                 白名单之外的由 Claude Code 的自动审核（分类器）按这次任务的意图逐次决定放不放
//
// 任何档位都不传 --dangerously-skip-permissions。除自动审核档外，白名单之外的调用照旧被拒，
// 被拒的会在结尾列出并给出放行的入口（denialReason）。
//
// 每一档都再传一份硬拦截清单（--disallowedTools，deny.go）：deny 优先于 allow 和自动审核，
// 推 main、强推、reset --hard、rm -rf、杀进程、写工作台自己的数据目录这些，哪一档都放不开。
// 自动审核档尤其要靠它：2.1.329 在 -p 下实测，用户提示词里明说要做的事（连推 main、强推）分类器都放行。
//
// Claude Code 对管道、&&、; 连起来的命令按每一段分别判定，白名单按段生效：
// `sqlite3 -readonly -safe x.db ".tables" | head` 要两段都在白名单里（或是 Claude Code
// 自己认定的只读命令）才放行。输出重定向（> 文件）不算只读，只读档位下照旧被拒（2.1.319 实测）。
//
// 2.1.328 实测（TSK-0837、TSK-0841 复盘）补充几条白名单管不到的：
//   - 2>/dev/null、2>&1 跟着所在那一段，不另算一段，不影响放行；> 文件 即便命令本身放行了也照旧要确认；
//   - 路径在工作目录（和 --add-dir）之外的 ls / cat / grep / cd 被挡，Bash(ls:*) 这类前缀规则放不开，
//     要么软链接进工作目录（LinkedDirs），要么放行 Read(//绝对路径/**)；
//   - 命令里给 shell 变量赋值（C=...; ls "$C"）一律要确认，规则放不开；
//   - cd 到别处再跑 git（cd x && git log）有单独的安全确认，规则放不开，要写 git -C 或直接在工作目录里跑；
//   - 以 Agent 工具起的子代理继承这一组 --allowedTools。
const (
	PermReadOnly      = "read_only"
	PermAcceptEdits   = "accept_edits"
	PermEditsAndTests = "edits_and_tests"
	PermCustom        = "custom"
	PermAuto          = "auto"
)

// PermProfiles 是全部档位，按从低到高排。
var PermProfiles = []string{PermReadOnly, PermAcceptEdits, PermEditsAndTests, PermCustom, PermAuto}

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
	case PermAuto:
		return "自动审核"
	}
	return p
}

// PermMode 是这一档传给 claude 的 --permission-mode，空表示不传（只读）。
// 自动审核是 auto，其余写入档位是 acceptEdits。
func PermMode(p string) string {
	switch p {
	case PermReadOnly, "":
		return ""
	case PermAuto:
		return "auto"
	}
	return "acceptEdits"
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
//   - find：-exec / -delete；sed / awk：-i 和 system() 都能写；git branch / checkout：会改仓库；
//   - env：env 命令 能拉起任意程序；不带参数时把环境变量（含令牌）整段打进执行记录，也不收；
//   - file：-C 会在当前目录写编译好的 magic 文件；tree：-o 把输出写进文件；
//   - [：规则里的方括号 Claude Code 怎么解析没验证过，用 test 写法（[ 本身 Claude Code 已自行放行）。
//
// 第二批（TSK-0837、TSK-0841 复盘）补的 cd、echo、printf、test、true、basename、dirname、realpath、stat、du、date、which：
// 2.1.328 下这些 Claude Code 自己已经认作只读，写进来是为了换版本也稳，以及被拒提示不再把它们当成建议。
// echo / printf 带 > 文件 时重定向照旧单独判定（实测命令放行了重定向仍要确认），不会因此变成写文件的口子。
//
// git diff 的 --output=<文件> 能写文件，属已知边界：写的位置受工作目录约束，影响等同一次文件编辑。
var ReadOnlyCommands = []string{
	"Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
	"Bash(git blame:*)", "Bash(git ls-files:*)", "Bash(git rev-parse:*)",
	"Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
	"Bash(grep:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(cut:*)", "Bash(jq:*)", "Bash(pwd)",
	"Bash(sqlite3 -readonly -safe:*)", "Bash(sqlite3 -safe -readonly:*)",
	"Bash(cd:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(test:*)", "Bash(true)",
	"Bash(basename:*)", "Bash(dirname:*)", "Bash(realpath:*)", "Bash(stat:*)", "Bash(du:*)",
	"Bash(date:*)", "Bash(which:*)",
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
// custom 是自定义白名单，在 custom 档和 auto 档生效：auto 档里白名单内的直接放行、不送自动审核。
func PermAllowed(p string, custom []string) []string {
	out := append([]string(nil), ReadOnlyCommands...)
	switch p {
	case PermEditsAndTests:
		out = append(out, TestCommands...)
	case PermCustom, PermAuto:
		out = append(out, custom...)
	}
	return dedupe(out)
}

// ProjectAllowFor 是项目执行白名单（项目档案 run_allow，TSK-0837）在这一档实际合进去的规则。
//
// 写入档位（accept_edits / edits_and_tests / custom / auto）全部合并：项目白名单是用户按项目录的，
// 和自定义白名单同一口径，只是只在这个项目的任务上生效。
// 只读档位只合并读规则（Read / Grep / Glob / LS，用来放行工作目录之外的目录）：只读是选角色、选档位时的明确承诺，
// 不能因为任务挂在某个项目下就悄悄多出能执行脚本、调写操作 MCP 的口子。
func ProjectAllowFor(p string, project []string) []string {
	out := []string{}
	for _, r := range project {
		if PermWrites(p) || readRule(r) {
			out = append(out, r)
		}
	}
	return out
}

// readRule：只读的工具规则（工具名是 Read、Grep、Glob、LS，可带括号限定）。
func readRule(r string) bool {
	name, _, _ := strings.Cut(r, "(")
	switch name {
	case "Read", "Grep", "Glob", "LS":
		return true
	}
	return false
}

// PermAllowedWith 是 PermAllowed 再合上项目执行白名单（已按档位筛过的，ProjectAllowFor），去重保序。
func PermAllowedWith(p string, custom, project []string) []string {
	return dedupe(append(PermAllowed(p, custom), project...))
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
func CheckRule(rule string) (string, error) { return checkRule(rule, false) }

// checkRule 是白名单（broad=false）和硬拦截（broad=true，CheckDenyRule）共用的写法校验。
// broad 为真时收「整个 Bash」：硬拦截只会收紧，Bash(*) 等于不许跑任何命令，是用户自己的选择。
func checkRule(rule string, broad bool) (string, error) {
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
	if r == "Bash()" {
		return "", fmt.Errorf("「%s」括号里是空的，写成 Bash(命令前缀:*)", r)
	}
	switch r {
	case "Bash", "Bash(*)", "Bash(:*)", "Bash(* :*)":
		if broad {
			return r, nil
		}
		return "", fmt.Errorf("「%s」等于放开任意命令，不收；按命令前缀写，如 Bash(git commit:*)", r)
	}
	if strings.HasPrefix(r, "Bash(") {
		if !strings.HasSuffix(r, ")") {
			return "", fmt.Errorf("「%s」少了右括号，写成 Bash(命令前缀:*)", r)
		}
		inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(r, "Bash("), ")"))
		if inner == "" {
			return "", fmt.Errorf("「%s」括号里是空的，写成 Bash(命令前缀:*)", r)
		}
		if broad {
			return r, nil
		}
		if strings.HasPrefix(inner, "*") || strings.HasPrefix(inner, ":") {
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
// Bash 命令按 &&、||、;、|、& 拆段，每段取命令名（git / npm / go / make 这类再带上子命令，
// python、node 这类解释器带上脚本名）作前缀；已经在 allowed 里的段跳过——那一段不是被拒的原因。
// 推不出可靠规则的段不给：变量赋值、$C 开头的命令、python -c 这类等于放开任意代码的写法。
// 文件编辑类工具不给规则：它们靠档位放开（选「允许改文件」），不该一条条加进白名单。
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
			for _, r := range bashRules(d, allowed) {
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

// bashRules 是一次被拒的 Bash 调用推出的规则（没去重）：每段一条，已放行、推不出的段跳过。
func bashRules(d Denial, allowed []string) []string {
	cmd, _ := d.ToolInput["command"].(string)
	var out []string
	for _, seg := range splitCommand(cmd) {
		words := segWords(seg)
		r := bashRule(words)
		if r == "" || covered(r, strings.Join(words, " "), allowed) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// unexplainedBash 报告有没有被拒的 Bash 调用推不出任何规则：每一段都已放行或放不开，
// 那被拒的原因在白名单之外（工作目录外的路径、shell 变量、cd 后跑 git），denialReason 据此另说一句。
func unexplainedBash(denials []Denial, allowed []string) bool {
	for _, d := range denials {
		if d.ToolName == "Bash" && len(bashRules(d, allowed)) == 0 {
			return true
		}
	}
	return false
}

var editTools = map[string]bool{"Edit": true, "MultiEdit": true, "Write": true, "NotebookEdit": true}

// subcommandTools 的规则带上子命令：Bash(git:*) 会把 git push、git reset 一起放开。
var subcommandTools = map[string]bool{
	"git": true, "go": true, "npm": true, "npx": true, "pnpm": true, "yarn": true, "make": true,
	"cargo": true, "docker": true, "kubectl": true, "gh": true, "pip": true, "uv": true,
}

// interpreterRe 认解释器（按程序名，/opt/miniconda3/bin/python 也算）：规则带上脚本名，
// 只放这一个脚本；后面跟的是选项（python -c、node -e）时不给规则——那等于放开任意代码。
var interpreterRe = regexp.MustCompile(`^(python[0-9.]*|node|ruby|perl|bash|sh|zsh|deno|bun|php)$`)

// noRuleTools 是拿来再拉起别的程序的命令，按命令名放行等于放开任意命令，不给规则。
var noRuleTools = map[string]bool{
	"sudo": true, "eval": true, "exec": true, "xargs": true, "env": true, "nohup": true, "command": true,
	"builtin": true, "source": true, ".": true, "time": true, "timeout": true, "nice": true,
}

// splitCommand 按 shell 的连接符拆段：&&、||、;、|、|&、后台 &、换行。只为给建议，不求完全符合 shell 语法，
// 但要认得这几样，不然会拆出假命令（TSK-0837 实测拆出过 Bash(1:*)）：
//   - 引号（单引号、双引号）和反斜杠转义里的连接符不算；
//   - 重定向里的 &（2>&1、>&2、&>file、&>>file）不算连接符；
//   - $( ) 和反引号里的整段跟着外面那一段；
//   - here-doc（<<EOF … EOF）的正文不是命令，整段跳过。
func splitCommand(cmd string) []string {
	var segs []string
	cur := strings.Builder{}
	var quote rune
	depth := 0 // $( ) 的层数
	backtick := false
	var heredocs []string // 这一行开了、还没读正文的 here-doc 结束标记
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			segs = append(segs, s)
		}
		cur.Reset()
	}
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		next := rune(0)
		if i+1 < len(rs) {
			next = rs[i+1]
		}
		if c == '\\' && quote != '\'' && i+1 < len(rs) {
			cur.WriteRune(c)
			cur.WriteRune(next)
			i++
			continue
		}
		if quote != 0 {
			cur.WriteRune(c)
			if c == quote {
				quote = 0
			}
			continue
		}
		if depth > 0 || backtick {
			cur.WriteRune(c)
			switch {
			case c == '\'' || c == '"':
				quote = c
			case c == '`':
				backtick = !backtick
			case c == '$' && next == '(':
				cur.WriteRune(next)
				i++
				depth++
			case c == ')' && depth > 0:
				depth--
			}
			continue
		}
		switch {
		case c == '\'' || c == '"':
			quote = c
			cur.WriteRune(c)
		case c == '`':
			backtick = true
			cur.WriteRune(c)
		case c == '$' && next == '(':
			depth++
			cur.WriteRune(c)
			cur.WriteRune(next)
			i++
		case c == '<' && next == '<' && prevRune(rs, i) != '<' && (i+2 >= len(rs) || rs[i+2] != '<'):
			// here-doc：记下结束标记，换行之后跳过正文
			j := i + 2
			if j < len(rs) && rs[j] == '-' {
				j++
			}
			for j < len(rs) && (rs[j] == ' ' || rs[j] == '\t') {
				j++
			}
			k := j
			for k < len(rs) && !strings.ContainsRune(" \t\n;|&<>()", rs[k]) {
				k++
			}
			if tag := strings.Trim(string(rs[j:k]), `'"\`); tag != "" {
				heredocs = append(heredocs, tag)
			}
			cur.WriteString(string(rs[i:k]))
			i = k - 1
		case c == '&' && (next == '>' || prevRune(rs, i) == '>' || prevRune(rs, i) == '<'):
			// 2>&1、>&2、&>file、&>>file：重定向，不是连接符
			cur.WriteRune(c)
		case c == ';' || c == '|' || c == '&':
			flush()
		case c == '\n':
			flush()
			for len(heredocs) > 0 {
				// 跳过正文，直到一行（去掉开头的制表符）等于结束标记
				tag := heredocs[0]
				heredocs = heredocs[1:]
				for i+1 < len(rs) {
					end := i + 1
					for end < len(rs) && rs[end] != '\n' {
						end++
					}
					line := strings.TrimLeft(string(rs[i+1:end]), "\t")
					i = end
					if line == tag {
						break
					}
				}
			}
		default:
			cur.WriteRune(c)
		}
	}
	flush()
	return segs
}

func prevRune(rs []rune, i int) rune {
	if i == 0 {
		return 0
	}
	return rs[i-1]
}

var (
	// redirRe 认一个重定向词：可带文件描述符的 >、>>、<、<>、&>、&>>、>&、<&、<<、<<<，后面可直接跟目标
	redirRe  = regexp.MustCompile(`^[0-9]*(&>>|&>|>>|>&|<&|<<<|<<-|<<|<>|>\||>|<)(.*)$`)
	assignRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\+?=`)
)

// segWords 把一段命令拆成词：认引号（去掉引号、引号里的空格不拆），去掉重定向（2>/dev/null、2>&1、> 文件、<<EOF）
// 和开头的变量赋值（FOO=1 cmd 的 FOO=1）、子 shell 括号。只剩赋值或重定向时回空。
func segWords(seg string) []string {
	var toks []string
	cur := strings.Builder{}
	in := false
	var quote rune
	for _, c := range seg {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else {
				cur.WriteRune(c)
			}
		case c == '\'' || c == '"':
			quote, in = c, true
		case c == ' ' || c == '\t':
			if in {
				toks = append(toks, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteRune(c)
			in = true
		}
	}
	if in {
		toks = append(toks, cur.String())
	}
	var words []string
	skip := false
	for _, t := range toks {
		if skip {
			skip = false
			continue
		}
		if m := redirRe.FindStringSubmatch(t); m != nil {
			skip = m[2] == "" // 目标在下一个词
			continue
		}
		if len(words) == 0 {
			t = strings.TrimLeft(t, "({!")
			if t == "" || assignRe.MatchString(t) {
				continue
			}
		}
		words = append(words, t)
	}
	return words
}

// bashRule 给一段命令（segWords 的结果）拼前缀规则：命令名，或命令名加子命令（subcommandTools）、
// 解释器加脚本名（interpreterRe）。推不出可靠规则时回空：cd（已在只读白名单）、变量开头、像数字或符号的「命令名」、
// 再拉起别的程序的（noRuleTools）、解释器后面直接跟选项的。
func bashRule(f []string) string {
	if len(f) == 0 {
		return ""
	}
	name := f[0]
	if name == "cd" || noRuleTools[name] || !plausibleCommand(name) {
		return ""
	}
	if interpreterRe.MatchString(filepath.Base(name)) {
		if len(f) < 2 || strings.HasPrefix(f[1], "-") || !plausibleCommand(f[1]) {
			return ""
		}
		return "Bash(" + name + " " + f[1] + ":*)"
	}
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

// plausibleCommand：像个命令名或脚本路径——不以 $、-、` 开头，不全是数字，不带 shell 的特殊符号。
func plausibleCommand(s string) bool {
	if s == "" || strings.ContainsAny(s[:1], "$-`*?~") || strings.ContainsAny(s, "<>|&;()$`=") {
		return false
	}
	return strings.Trim(s, "0123456789") != ""
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
