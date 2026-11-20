// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

// 硬拦截清单（--disallowedTools）：每一档都传，deny 优先于 --allowedTools、项目执行白名单和自动审核。
//
// 两部分：
//   - 内置（BuiltinDeny）：代码里定死、设置里删不掉；
//   - 用户自定义（设置「执行权限」的硬拦截，run_permissions.deny），校验见 CheckDenyRule。
//
// 规则写法按 Claude Code 2.1.329 的权限规则（实测见 deny_test.go 的 TestSmokeRealDeny 和提交说明）：
//   - Bash(前缀:*) 是前缀匹配；Bash(… * …) 里的 * 匹配任意一串字符（可为空、可含空格和 /），其余字符照字面比；
//   - 空格照字面：Bash(git push * -f *) 不匹配 git push -f origin x（push 和 -f 之间只有一个空格），所以同一写法要分开几条；
//   - 用 && ; | 连起来的命令按段判定，任何一段命中 deny 整条被拒；
//   - Edit(//绝对路径/**)、Write(//绝对路径/**) 挡文件编辑工具写这棵目录（// 开头是文件系统绝对路径）。
//
// 已知管不到的（实测或按规则语法推出，契约里写明）：
//   - 不带参数的 git push（当前分支恰好是 main）、git push origin（默认推送当前分支）；
//   - 包了一层的写法：bash -c "…"、sh -c、eval、xargs kill、用 python / node 脚本去做同样的事；
//   - sqlite3 写库只挡常见写法（不带选项、只带 -safe、第一个选项不是 -readonly / -safe），-safe -header 这类组合、--选项写法、
//     cd 进数据目录再 sqlite3 pm.db 挡不住；数据目录名太常见（如 data）时会多挡别处同名目录下的库；
//   - 调管理接口只挡 curl / wget / http（httpie）三个命令行。
//
// 自动审核档（auto）的白名单外调用由分类器按意图判，用户提示词里明说要做的事它会放行（实测连 git push --force origin main 都放）：
// 所以这些操作只能靠这份清单兜底，清单越漏，auto 越危险。

// ProductionHost 是工作台对外服务的域名：调它的 /api/admin/ 一律拦，不管这次执行是哪个实例发起的
// （临时后端上跑的执行也不许去动生产实例的迁移、快照、更新）。
const ProductionHost = "bro.vip"

// DenyEnv 是生成内置清单要的本机信息。
type DenyEnv struct {
	// DataDir 是工作台自己的数据目录（库文件、vault.key、backups 所在），空表示不生成这一组。
	DataDir string
	// PublicURL 是工作台对外地址（--public-url），它的 host[:port] 和 ProductionHost 一起进「管理接口」那一组。
	PublicURL string
}

// DenyGroup 是内置清单的一组：给设置页按组展示，也是被拒提示里说「命中哪一类」的依据。
type DenyGroup struct {
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Rules []string `json:"rules"`
}

// gitForms 是同一条 git 规则的两种开头：在工作目录里跑，和 git -C 别处的仓库。
var gitForms = []string{"git", "git -C *"}

// BuiltinDenyGroups 是内置硬拦截清单，按组。
func BuiltinDenyGroups(env DenyEnv) []DenyGroup {
	var push, force, reset, clean, branch []string
	for _, g := range gitForms {
		for _, b := range []string{"main", "master"} {
			push = append(push,
				"Bash("+g+" push * "+b+")", "Bash("+g+" push * "+b+" *)",
				"Bash("+g+" push *:"+b+")", "Bash("+g+" push *:"+b+" *)",
				"Bash("+g+" push *:refs/heads/"+b+")", "Bash("+g+" push *:refs/heads/"+b+" *)",
			)
		}
		push = append(push, "Bash("+g+" push *--all*)", "Bash("+g+" push *--mirror*)")
		force = append(force,
			"Bash("+g+" push *--force*)", "Bash("+g+" push -f *)", "Bash("+g+" push * -f *)", "Bash("+g+" push * -f)",
			"Bash("+g+" push * +*)",
		)
		reset = append(reset, "Bash("+g+" reset *--hard*)")
		clean = append(clean, "Bash("+g+" clean*)")
		branch = append(branch, "Bash("+g+" branch *-D*)", "Bash("+g+" branch *--delete *--force*)",
			"Bash("+g+" branch *--force *--delete*)", "Bash("+g+" branch *-d -f*)", "Bash("+g+" branch *-f -d*)")
	}
	var rm []string
	for _, f := range []string{"-rf", "-fr", "-Rf", "-fR"} {
		rm = append(rm, "Bash(rm "+f+"*)", "Bash(rm * "+f+"*)")
	}
	rm = append(rm, "Bash(rm -r -f*)", "Bash(rm -f -r*)", "Bash(rm -R -f*)", "Bash(rm -f -R*)",
		"Bash(rm *--recursive *--force*)", "Bash(rm *--force *--recursive*)")
	groups := []DenyGroup{
		{Key: "push_main", Label: "推送到 main / master", Rules: push},
		{Key: "force_push", Label: "强推（--force、-f、--force-with-lease、+分支）", Rules: force},
		{Key: "reset_hard", Label: "git reset --hard", Rules: reset},
		{Key: "git_clean", Label: "git clean", Rules: clean},
		{Key: "branch_delete", Label: "强删分支（git branch -D）", Rules: branch},
		{Key: "rm_rf", Label: "rm -rf / rm -fr", Rules: rm},
		{Key: "kill", Label: "杀进程、动系统服务（kill、pkill、killall、launchctl）", Rules: []string{"Bash(kill*)", "Bash(pkill*)", "Bash(launchctl*)"}},
	}
	if rules := dataDirDeny(env.DataDir); len(rules) > 0 {
		groups = append(groups, DenyGroup{Key: "data_dir", Label: "写工作台自己的数据目录（" + filepath.Clean(env.DataDir) + "）", Rules: rules})
	}
	groups = append(groups, DenyGroup{Key: "admin_api", Label: "调工作台的管理接口（/api/admin/）", Rules: adminDeny(env.PublicURL)})
	return groups
}

// BuiltinDeny 是内置硬拦截清单摊平、去重。
func BuiltinDeny(env DenyEnv) []string {
	var out []string
	for _, g := range BuiltinDenyGroups(env) {
		out = append(out, g.Rules...)
	}
	return dedupe(out)
}

// DenyWith 是内置清单再合上用户自定义的硬拦截，去重保序。
func DenyWith(env DenyEnv, user []string) []string {
	return dedupe(append(BuiltinDeny(env), user...))
}

// sqliteOptLetters 是 sqlite3 选项的首字母，r（-readonly）和 s（-safe）除外：
// 第一个选项不是 -readonly / -safe 的写法一律当写库挡（-separator、-stats 另列）。
const sqliteOptLetters = "abcdefghijklmnopqtuvwxyz"

// dataDirDeny：文件编辑工具不许写数据目录；sqlite3 不带 -readonly 的常见写法不许碰它。
// 只读的 sqlite3 -readonly -safe（只读白名单里那两种写法）不受影响：deny 压过 allow，所以这里一条都不能匹配到它们。
func dataDirDeny(dir string) []string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil
	}
	abs = filepath.Clean(abs)
	base := filepath.Base(abs)
	if abs == "/" || base == "." || base == "/" {
		return nil
	}
	out := []string{"Edit(/" + abs + "/**)", "Write(/" + abs + "/**)"}
	// 经软链接的路径（macOS 的 /tmp → /private/tmp）两种写法都挡：Claude Code 比的是哪一种没验证过
	if real, err := filepath.EvalSymlinks(abs); err == nil && real != abs {
		out = append(out, "Edit(/"+real+"/**)", "Write(/"+real+"/**)")
	}
	// 库路径紧跟在 sqlite3（或只带 -safe）后面：绝对路径、./ ../ ~/ 开头的、直接写目录名的，只要路径里有「目录名/」就算。
	// 这样连别的工作区里同名的数据目录（data-dev 副本）也一起挡，宁可多挡。
	paths := []string{"/*" + base + "/", ".*" + base + "/", "~*" + base + "/", base + "/"}
	for _, p := range paths {
		out = append(out, "Bash(sqlite3 "+p+"*)")
	}
	for _, p := range paths {
		out = append(out, "Bash(sqlite3 -safe "+p+"*)")
	}
	for _, c := range sqliteOptLetters {
		out = append(out, "Bash(sqlite3 -"+string(c)+"*"+base+"/*)")
	}
	out = append(out, "Bash(sqlite3 -se*"+base+"/*)", "Bash(sqlite3 -st*"+base+"/*)")
	return out
}

// adminDeny：curl / wget / http 调 ProductionHost 和本实例对外地址的 /api/admin/。
func adminDeny(publicURL string) []string {
	hosts := []string{ProductionHost}
	if u, err := url.Parse(strings.TrimSpace(publicURL)); err == nil && u.Host != "" {
		hosts = append(hosts, u.Host)
	}
	var out []string
	for _, h := range dedupe(hosts) {
		for _, c := range []string{"curl", "wget", "http"} {
			out = append(out, "Bash("+c+" *"+h+"/api/admin*)")
		}
	}
	return out
}

// 用户自定义硬拦截的上限，同自定义白名单。
const MaxDenyRules = MaxCustomRules

// CheckDenyRule 校验一条用户自定义的硬拦截规则，回规范化之后的写法。
//
// 写法同白名单（CheckRule），但收「整个 Bash」这类宽规则：deny 只会收紧，Bash(*) 等于这台机器上的后台执行
// 一条命令都不许跑，是用户自己的选择。不收挡掉整个工作台 MCP 的规则：读任务、记进展、回写结论全靠它，
// 挡掉以后每次执行都回不了话；要挡具体某个工具写全名（mcp__pmw-run__pmw_update_object）。
func CheckDenyRule(rule string) (string, error) {
	r, err := checkRule(rule, true)
	if err != nil {
		return "", err
	}
	if r == MCPAllowRule() || r == MCPAllowRule()+"__*" {
		return "", fmt.Errorf("「%s」会挡掉工作台 MCP 的全部工具，执行就没法读任务、回写结论；要挡具体工具写全名，如 %s__pmw_update_object", r, MCPAllowRule())
	}
	return r, nil
}

// CleanDenyRules 校验并去重一组自定义硬拦截，保持原顺序。
func CleanDenyRules(rules []string) ([]string, error) {
	out := make([]string, 0, len(rules))
	seen := map[string]bool{}
	for _, x := range rules {
		if strings.TrimSpace(x) == "" {
			continue
		}
		r, err := CheckDenyRule(x)
		if err != nil {
			return nil, err
		}
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	if len(out) > MaxDenyRules {
		return nil, fmt.Errorf("自定义硬拦截最多 %d 条", MaxDenyRules)
	}
	return out, nil
}

// --- 规则匹配（近似 Claude Code 的口径，只用来归因和自测，不拿它放行或拦截） ---

// MatchRule 报告一条规则是否命中这次调用。
//
// 只认三种：Bash(…)（按段比，见文件头的口径）、Edit / Write（按 // 绝对路径 glob 比 file_path）、
// 其余按工具名（mcp__server 认前缀）。真正拦不拦以 Claude Code 为准，这里用在：
//   - 被拒提示里说清命中的是哪一条（denialReason）；
//   - 测试里锁住「内置清单不误伤只读白名单和文档仓推分支」。
func MatchRule(rule, tool string, input map[string]any) bool {
	name, arg, hasArg := strings.Cut(rule, "(")
	if hasArg {
		arg = strings.TrimSuffix(arg, ")")
	}
	switch {
	case name == "Bash" && tool == "Bash":
		if !hasArg || arg == "*" || arg == ":*" {
			return true
		}
		cmd, _ := input["command"].(string)
		for _, seg := range splitCommand(cmd) {
			if matchBash(arg, strings.Join(strings.Fields(seg), " ")) {
				return true
			}
		}
		return false
	case (name == "Edit" || name == "Write") && (editTools[tool]):
		if name == "Write" && tool != "Write" {
			return false
		}
		if !hasArg {
			return true
		}
		p, _ := input["file_path"].(string)
		if p == "" {
			p, _ = input["notebook_path"].(string)
		}
		return p != "" && strings.HasPrefix(arg, "//") && globMatch(strings.TrimPrefix(arg, "/"), p)
	case strings.HasPrefix(name, "mcp__") && !hasArg:
		return tool == name || strings.HasPrefix(tool, name+"__")
	}
	return !hasArg && name == tool
}

// MatchAny 回第一条命中的规则，都不中回空。
func MatchAny(rules []string, tool string, input map[string]any) string {
	for _, r := range rules {
		if MatchRule(r, tool, input) {
			return r
		}
	}
	return ""
}

// matchBash：:* 结尾是前缀（等于前缀本身或前缀加空格开头）；带 * 的按通配；都没有就整段相等。
func matchBash(pat, seg string) bool {
	if p, ok := strings.CutSuffix(pat, ":*"); ok {
		return seg == p || strings.HasPrefix(seg, p+" ")
	}
	if !strings.Contains(pat, "*") {
		return seg == pat
	}
	parts := strings.Split(pat, "*")
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	return err == nil && re.MatchString(seg)
}

// globMatch：** 跨目录，* 不跨 /。
func globMatch(pat, p string) bool {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(pat); i++ {
		switch {
		case strings.HasPrefix(pat[i:], "**"):
			b.WriteString(".*")
			i++
		case pat[i] == '*':
			b.WriteString("[^/]*")
		default:
			b.WriteString(regexp.QuoteMeta(pat[i : i+1]))
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	return err == nil && re.MatchString(p)
}

// --- 被拒的三类 ---

// 被拒的类别（DenialKind）。
const (
	// DenyByRule：命中 deny 规则（工作台的硬拦截清单，或用户自己 settings 里的 deny）。
	DenyByRule = "deny_rule"
	// DenyByClassifier：自动审核档里被 Claude Code 的自动审核（分类器）拒绝。
	DenyByClassifier = "classifier"
	// DenyByApproval：要人确认、后台没人应答，等于白名单外（非自动审核档的常态）。
	DenyByApproval = "approval"
)

// DenialKind 判一次被拒属于哪一类。
//
// 依据是 stream-json 里的 system / permission_denied 事件（2.1.329 有，按 tool_use_id 对上，见 readStream）：
//   - decision_reason_type 是 classifier，或说明里提到 auto mode（分类器拒绝、分类器不可用时的兜底拒绝）→ 自动审核；
//   - 说明是「Permission to use … has been denied」→ deny 规则（实测 Bash 命中 deny 时 decision_reason_type 是
//     subcommandResults、不是 rule，只能看这句话）；
//   - 其余（「This command requires approval」「… needs approval」）→ 白名单外。
//
// 没有这个事件（老版本 CLI）时退回按清单比：命中 deny 规则算硬拦截，否则算白名单外。
// 自动审核拒绝在 -p 下没能实测触发（分类器对提示词里明说的操作都放行了），这一支按 2.1.329 的事件定义写，没有实测样本。
func DenialKind(d Denial, deny []string) string {
	t, m := d.DecisionType, d.DecisionMessage
	lm := strings.ToLower(m)
	switch {
	case t == "classifier" || strings.Contains(lm, "auto mode"):
		return DenyByClassifier
	case strings.HasPrefix(m, "Permission to use ") && strings.Contains(m, "has been denied"):
		return DenyByRule
	case t == "rule" && strings.Contains(lm, "denied"):
		return DenyByRule
	case m == "" && MatchAny(deny, d.ToolName, d.ToolInput) != "":
		return DenyByRule
	}
	return DenyByApproval
}
