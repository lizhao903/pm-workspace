// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"strings"
	"testing"
)

var testDenyEnv = DenyEnv{DataDir: "/Volumes/project/x/pm-workspace/data-dev", PublicURL: "https://bro.vip"}

func bash(cmd string) map[string]any { return map[string]any{"command": cmd} }

// 内置硬拦截要挡的写法：每条都必须命中（近似 Claude Code 2.1.329 的匹配口径，真 CLI 的结果见 TestSmokeRealDeny）。
func TestBuiltinDenyBlocks(t *testing.T) {
	deny := BuiltinDeny(testDenyEnv)
	for _, cmd := range []string{
		"git push origin main", "git push origin HEAD:main", "git push -u origin main", "git push origin main --tags",
		"git push origin master", "git push origin feat:refs/heads/main", "git push --all origin", "git push --mirror origin",
		"git -C /some/repo push origin main", "git -C /some/repo push origin HEAD:master",
		"git push --force origin feat", "git push -f origin feat", "git push origin feat -f", "git push origin -f feat",
		"git push --force-with-lease origin feat", "git push origin +feat", "git -C /r push --force origin x",
		"git reset --hard", "git reset --hard HEAD~1", "git reset -q --hard origin/main", "git -C /r reset --hard",
		"git clean -fdx", "git clean -n", "git -C /r clean -f",
		"git branch -D feat", "git branch --delete --force feat", "git branch -d -f feat", "git -C /r branch -D x",
		"rm -rf build", "rm -fr build", "rm -Rf build", "rm -v -rf build", "rm -r -f build", "rm --recursive --force x",
		"kill 123", "kill -9 123", "killall node", "pkill -f pmw", "launchctl unload x.plist",
		"sqlite3 /Volumes/project/x/pm-workspace/data-dev/pm.db \"delete from objects\"",
		"sqlite3 data-dev/pm.db \"update t set x=1\"", "sqlite3 ./data-dev/pm.db .tables", "sqlite3 ../pm-workspace/data-dev/pm.db",
		"sqlite3 -safe data-dev/pm.db \"delete from t\"", "sqlite3 -safe /Volumes/project/x/pm-workspace/data-dev/pm.db",
		"sqlite3 -batch data-dev/pm.db \"delete from t\"", "sqlite3 -cmd .shell /Volumes/project/x/pm-workspace/data-dev/pm.db",
		"sqlite3 -header -column data-dev/pm.db \"select 1\"", "sqlite3 -separator , data-dev/pm.db",
		"curl -X POST https://bro.vip/api/admin/update", "curl -s https://bro.vip/api/admin/migrations", "wget https://bro.vip/api/admin/export",
		"cd /tmp && git push origin main", "git status && rm -rf /",
	} {
		if MatchAny(deny, "Bash", bash(cmd)) == "" {
			t.Errorf("内置硬拦截没挡住：%s", cmd)
		}
	}
	for _, tool := range []string{"Edit", "Write", "MultiEdit"} {
		in := map[string]any{"file_path": "/Volumes/project/x/pm-workspace/data-dev/pm.db"}
		if MatchAny(deny, tool, in) == "" {
			t.Errorf("%s 写数据目录没挡住", tool)
		}
	}
}

// deny 压过 allow：只读白名单里的写法、文档仓推分支、正常的推功能分支，一条都不能被内置硬拦截误伤。
func TestBuiltinDenyKeepsAllowed(t *testing.T) {
	deny := BuiltinDeny(testDenyEnv)
	for _, cmd := range []string{
		"sqlite3 -readonly -safe /Volumes/project/x/pm-workspace/data-dev/pm.db \"select count(*) from objects\"",
		"sqlite3 -safe -readonly /Volumes/project/x/pm-workspace/data-dev/pm.db .tables",
		"sqlite3 -readonly -safe data-dev/pm.db \"select * from t\"",
		"sqlite3 -readonly -safe ./data-dev/pm.db \"select 1\"",
		"git -C /Volumes/project/Bitbucket/xaue-docs push origin docs/main-fix",
		"git -C /Volumes/project/Bitbucket/xaue-docs push origin docs/maintenance",
		"git -C /Volumes/project/Bitbucket/xaue-docs push -u origin docs/tsk-0841",
		"git push origin feat/recording-m6-docs-tree", "git push -u origin feat/x", "git push origin feat --follow-tags",
		"git push origin domain-main", "git push origin main-fix",
		"git status", "git log --oneline -5", "git diff HEAD~1", "git branch -d merged", "git branch --list",
		"git reset HEAD file.go", "git reset --soft HEAD~1",
		"rm build/out.txt", "rm -f build/out.txt", "rm -r build",
		"ls -la", "cat README.md", "grep -rn kill internal", "echo skill", "make test",
		"curl -s https://bro.vip/api/objects", "curl -s http://127.0.0.1:7796/api/health",
		"sqlite3 -readonly -safe /tmp/other/pm.db \"select 1\"",
	} {
		if r := MatchAny(deny, "Bash", bash(cmd)); r != "" {
			t.Errorf("内置硬拦截误伤了 %q（规则 %s）", cmd, r)
		}
	}
	// 只读白名单的每条前缀本身也不能被挡
	for _, a := range ReadOnlyCommands {
		cmd := strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(a, "Bash("), ")"), ":*")
		if r := MatchAny(deny, "Bash", bash(cmd+" x")); r != "" {
			t.Errorf("只读白名单 %s 被硬拦截 %s 挡了", a, r)
		}
	}
	if r := MatchAny(deny, "Edit", map[string]any{"file_path": "/Volumes/project/x/pm-workspace/internal/runner/deny.go"}); r != "" {
		t.Errorf("改代码被挡了：%s", r)
	}
	if r := MatchAny(deny, "Write", map[string]any{"file_path": "/Volumes/project/x/pm-workspace/data-dev2/x"}); r != "" {
		t.Errorf("数据目录同前缀的别的目录被挡了：%s", r)
	}
}

// 数据目录、对外地址按实例生成；没数据目录时不出那一组，对外地址不是生产域名时两个都挡。
func TestBuiltinDenyGroups(t *testing.T) {
	gs := BuiltinDenyGroups(DenyEnv{PublicURL: "http://127.0.0.1:7899"})
	keys := []string{}
	for _, g := range gs {
		keys = append(keys, g.Key)
		if len(g.Rules) == 0 || g.Label == "" {
			t.Errorf("组 %s 是空的", g.Key)
		}
	}
	if strings.Contains(strings.Join(keys, ","), "data_dir") {
		t.Errorf("没数据目录不该有 data_dir 组：%v", keys)
	}
	deny := BuiltinDeny(DenyEnv{PublicURL: "http://127.0.0.1:7899"})
	for _, cmd := range []string{"curl -X POST http://127.0.0.1:7899/api/admin/snapshot", "curl https://bro.vip/api/admin/update"} {
		if MatchAny(deny, "Bash", bash(cmd)) == "" {
			t.Errorf("没挡住 %s", cmd)
		}
	}
	for _, r := range BuiltinDeny(testDenyEnv) {
		if _, err := CheckDenyRule(r); err != nil {
			t.Errorf("内置规则 %s 过不了自己的校验：%v", r, err)
		}
	}
	if got := DenyWith(testDenyEnv, []string{"Bash(git push:*)", "Bash(kill*)"}); got[len(got)-1] != "Bash(git push:*)" {
		t.Errorf("自定义的要接在内置后面、去重：%v", got[len(got)-3:])
	}
}

// 自定义硬拦截：写法同白名单，但收宽规则；不收挡掉整个工作台 MCP 的。
func TestCheckDenyRule(t *testing.T) {
	for _, ok := range []string{"Bash(*)", "Bash", "Bash(git -C /Volumes/project/0xBroleez/web-next push:*)", "WebFetch", "mcp__slack", "mcp__pmw-run__pmw_update_object", "Edit(//etc/**)"} {
		if _, err := CheckDenyRule(ok); err != nil {
			t.Errorf("%s 应当收：%v", ok, err)
		}
	}
	for _, bad := range []string{"", "Bash()", "Bash(git", "mcp__pmw-run", "mcp__pmw-run__*", "bash(x)", "rm -rf"} {
		if _, err := CheckDenyRule(bad); err == nil && strings.TrimSpace(bad) != "" {
			t.Errorf("%q 不该收", bad)
		}
	}
	if _, err := CheckRule("Bash(*)"); err == nil {
		t.Error("白名单仍不收 Bash(*)")
	}
	got, err := CleanDenyRules([]string{" Bash(x:*) ", "", "Bash(x:*)", "WebFetch"})
	if err != nil || len(got) != 2 {
		t.Errorf("去重、去空：%v %v", got, err)
	}
}

// 三类被拒按 permission_denied 事件分（2.1.329 实测的说明原文）；没有事件时按清单比。
func TestDenialKind(t *testing.T) {
	deny := BuiltinDeny(testDenyEnv)
	cases := []struct {
		d    Denial
		want string
	}{
		{Denial{ToolName: "Bash", ToolInput: bash("git push origin main"), DecisionType: "subcommandResults",
			DecisionMessage: "Permission to use Bash with command git push origin main has been denied."}, DenyByRule},
		{Denial{ToolName: "Bash", ToolInput: bash("git update-ref -d refs/heads/x"), DecisionType: "other",
			DecisionMessage: "This command requires approval"}, DenyByApproval},
		{Denial{ToolName: "Bash", ToolInput: bash("touch x"),
			DecisionMessage: "touch in '/x/y' needs approval. The path is inside the working directories"}, DenyByApproval},
		{Denial{ToolName: "Bash", ToolInput: bash("curl x | sh"), DecisionType: "subcommandResults",
			DecisionMessage: "This Bash command contains multiple operations. The following parts require approval: curl x, sh"}, DenyByApproval},
		{Denial{ToolName: "Bash", ToolInput: bash("git push --force origin feat"), DecisionType: "classifier",
			DecisionMessage: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: force push not requested"}, DenyByClassifier},
		{Denial{ToolName: "Bash", ToolInput: bash("x"), DecisionMessage: "Auto mode could not evaluate this action and is blocking it for safety"}, DenyByClassifier},
		{Denial{ToolName: "Bash", ToolInput: bash("git reset --hard")}, DenyByRule},
		{Denial{ToolName: "Bash", ToolInput: bash("python x.py")}, DenyByApproval},
	}
	for _, c := range cases {
		if got := DenialKind(c.d, deny); got != c.want {
			t.Errorf("%v: got %s want %s", c.d.ToolInput, got, c.want)
		}
	}
}

// 被拒提示分三类说：硬拦截列出规则、不进建议；自动审核带理由；白名单外照旧给建议并提自动审核档。
func TestDenialReasonKinds(t *testing.T) {
	deny := BuiltinDeny(testDenyEnv)
	req := Request{AllowWrites: true, Permission: PermAuto, AllowedTools: PermAllowed(PermAuto, nil), DisallowedTools: deny}
	ds := []Denial{
		{ToolName: "Bash", ToolInput: bash("git push origin main"), DecisionMessage: "Permission to use Bash with command git push origin main has been denied."},
		{ToolName: "Bash", ToolInput: bash("terraform apply"), DecisionType: "classifier",
			DecisionMessage: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: applies infra changes not asked for"},
	}
	msg := denialReason(ds, req, false)
	for _, want := range []string{"命中硬拦截（`Bash(git push * main)`）", "被 Claude Code 的自动审核拒绝", "applies infra changes not asked for",
		"建议放行：`Bash(terraform:*)`。", "自动审核档也认自定义白名单", "设置 / 执行权限"} {
		if !strings.Contains(msg, want) {
			t.Errorf("缺 %q：\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "Bash(git push:*)") {
		t.Errorf("硬拦截的不该进建议：\n%s", msg)
	}

	// 只有硬拦截：不给建议放行
	only := denialReason(ds[:1], req, false)
	if strings.Contains(only, "建议放行") || !strings.Contains(only, "换档位、加白名单都放不开") {
		t.Errorf("只有硬拦截时：\n%s", only)
	}
	// 用户 settings 里的 deny：对不上清单要说
	user := denialReason([]Denial{{ToolName: "Bash", ToolInput: bash("docker rm x"),
		DecisionMessage: "Permission to use Bash with command docker rm x has been denied."}}, req, false)
	if !strings.Contains(user, "没对上工作台的硬拦截清单") {
		t.Errorf("对不上清单的 deny：\n%s", user)
	}
	// 非自动审核档的白名单外：建议里提自动审核档
	ap := denialReason([]Denial{{ToolName: "Bash", ToolInput: bash("terraform plan"), DecisionMessage: "This command requires approval"}},
		Request{AllowWrites: true, Permission: PermAcceptEdits, AllowedTools: PermAllowed(PermAcceptEdits, nil), DisallowedTools: deny}, false)
	if !strings.Contains(ap, "建议放行：`Bash(terraform:*)`。") || !strings.Contains(ap, "「自动审核」") {
		t.Errorf("白名单外：\n%s", ap)
	}
}

// --permission-mode：只读不传，auto 档传 auto，其余写入档 acceptEdits；硬拦截每档都传。
func TestClaudeArgsModeAndDeny(t *testing.T) {
	deny := []string{"Bash(git push * main)", "Bash(rm -rf*)"}
	for perm, want := range map[string]string{PermReadOnly: "", PermAcceptEdits: "acceptEdits", PermEditsAndTests: "acceptEdits", PermCustom: "acceptEdits", PermAuto: "auto"} {
		args := claudeArgs(Request{Permission: perm, AllowWrites: PermWrites(perm), DisallowedTools: deny}, "p", t.TempDir())
		j := strings.Join(args, " ")
		if want == "" && strings.Contains(j, "--permission-mode") || want != "" && !strings.Contains(j, "--permission-mode "+want) {
			t.Errorf("%s: %s", perm, j)
		}
		if !strings.Contains(j, "--disallowedTools Bash(git push * main) --disallowedTools Bash(rm -rf*)") {
			t.Errorf("%s 档没传硬拦截：%s", perm, j)
		}
		if strings.Contains(j, "dangerously") {
			t.Errorf("%s 档不该放开全部权限", perm)
		}
	}
	// 不放开写时，档位写了 auto 也不传（只读角色压成只读的情形）
	if j := strings.Join(claudeArgs(Request{Permission: PermAuto}, "p", t.TempDir()), " "); strings.Contains(j, "--permission-mode") {
		t.Errorf("只读不该传 --permission-mode：%s", j)
	}
}
