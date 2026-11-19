// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// TSK-0499：每一档都带只读白名单；测试构建命令只在 edits_and_tests；自定义白名单只在 custom。
func TestPermAllowedProfiles(t *testing.T) {
	custom := []string{"Bash(git commit:*)"}
	for _, p := range PermProfiles {
		got := PermAllowed(p, custom)
		for _, want := range []string{"Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(ls:*)", "Bash(grep:*)", "Bash(sqlite3 -readonly -safe:*)"} {
			if !slices.Contains(got, want) {
				t.Errorf("%s 档缺只读命令 %s：%v", p, want, got)
			}
		}
		if slices.Contains(got, "Bash(go test:*)") != (p == PermEditsAndTests) {
			t.Errorf("%s 档的测试命令放行不对：%v", p, got)
		}
		if slices.Contains(got, "Bash(git commit:*)") != (p == PermCustom) {
			t.Errorf("%s 档的自定义白名单放行不对：%v", p, got)
		}
		// 反面：任何档位都不能把整个 Bash 或不带 -safe 的 sqlite3 放进来
		for _, r := range got {
			if r == "Bash" || r == "Bash(*)" || r == "Bash(sqlite3:*)" || r == "Bash(sqlite3 -readonly:*)" || r == "Bash(rg:*)" {
				t.Errorf("%s 档放进了不该放的 %s", p, r)
			}
		}
	}
	if PermWrites(PermReadOnly) || !PermWrites(PermAcceptEdits) || !PermWrites(PermEditsAndTests) || !PermWrites(PermCustom) {
		t.Fatal("只有只读档不放开文件编辑")
	}
}

func TestCheckRule(t *testing.T) {
	for _, ok := range []string{"Bash(git commit:*)", " Bash(make deploy:*) ", "mcp__slack", "mcp__slack__post", "WebFetch", "WebFetch(domain:example.com)", "Bash(pwd)"} {
		if _, err := CheckRule(ok); err != nil {
			t.Errorf("%q 应当收：%v", ok, err)
		}
	}
	for _, bad := range []string{"", "Bash", "Bash(*)", "Bash(:*)", "Bash( * )", "Bash(git", "mcp__", "rm -rf", "bash(ls:*)", "Bash(ls:*)\nBash(rm:*)", strings.Repeat("x", 300)} {
		if _, err := CheckRule(bad); err == nil {
			t.Errorf("%q 不该收", bad)
		}
	}
	got, err := CleanRules([]string{"Bash(git commit:*)", "", "Bash(git commit:*)", "mcp__x"})
	if err != nil || strings.Join(got, ",") != "Bash(git commit:*),mcp__x" {
		t.Fatalf("去重去空保序：%v %v", got, err)
	}
}

// 被拒的管道命令按段推规则：已在白名单里的段（head、wc）不出建议，git / npm 带子命令。
func TestSuggestRules(t *testing.T) {
	allowed := PermAllowed(PermReadOnly, nil)
	d := []Denial{
		{ToolName: "Bash", ToolInput: map[string]any{"command": `FOO=1 npm run e2e -- --x | wc -l; cd web && git push origin main`}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": `echo "a | b" > out.txt`}},
		{ToolName: "Write"},
		{ToolName: "mcp__pm-workspace__pmw_get_object"},
		{ToolName: "WebFetch"},
	}
	got := SuggestRules(d, allowed)
	// echo 第二批起在只读白名单里（TSK-0837），不再出建议
	want := []string{"Bash(npm run e2e:*)", "Bash(git push:*)", "mcp__pm-workspace__pmw_get_object", "WebFetch"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("建议规则\n got %v\nwant %v", got, want)
	}
}

// TSK-0837 / TSK-0841 复盘：重定向、引号、变量、here-doc 不能被拆成「命令名」（实测出过 Bash(1:*)），
// 解释器带上脚本名，python -c 这类不给规则，已在只读白名单里的段不出建议。
func TestSuggestRulesShellSyntax(t *testing.T) {
	allowed := PermAllowed(PermEditsAndTests, nil)
	for _, c := range []struct {
		cmd  string
		want []string
	}{
		// 真实被拒的命令（run_06gz553951f4mnje、run_06gz5xke0f0jke21）
		{`cd /Volumes/project/Bitbucket/octok-platform && git log -1 --format='%h %ad %s' --date=short origin/main 2>/dev/null; ls libs/agent/src/tool | head -80`, nil},
		{`grep -rln --include=*.ts -i "toolPolic\|tool_policy" /x/apps /x/libs 2>&1 | head`, nil},
		{`cd /a/_shared && python3 核格式.py --export cloud-v1119-02 2>&1 | tail -30`, []string{"Bash(python3 核格式.py:*)"}},
		{`cd /Volumes/docs/PRDs/Octok; grep -rl -E "投递|文件交付" --include=*.md . | head -30; echo ---; cat 云端功能需求/索引.md | tail -60`, nil},
		{`cd "/Volumes/docs/Know Me/Octok项目"; ls -la | grep 功能需求; C="/x/云端功能需求"; cat "$C/README.md"; ls "$C/_shared"`, nil},
		{`/opt/miniconda3/bin/python 采集截图.py`, []string{"Bash(/opt/miniconda3/bin/python 采集截图.py:*)"}},
		{`./_shared/新建需求.sh "AI员工文件投递" "云端-消息渠道（AI 员工工具）" 1119`, []string{"Bash(./_shared/新建需求.sh:*)"}},
		// 重定向的各种写法
		{`make lint >&2`, []string{"Bash(make lint:*)"}},
		{`deploy.sh &> /tmp/log; deploy.sh &>>/tmp/log`, []string{"Bash(deploy.sh:*)"}},
		{`foo 2> err.txt`, []string{"Bash(foo:*)"}},
		{`foo < in.txt`, []string{"Bash(foo:*)"}},
		// 引号里的连接符、$( )、反引号不拆
		{`awk '{print $1}' a.txt | sort; jq ".a | .b" x.json`, []string{"Bash(awk:*)"}},
		{`echo "$(rm -rf x; ls)"`, nil},
		{"echo `whoami | tr a b`", nil},
		// here-doc 正文不是命令
		{"cat > x.md <<'EOF'\nrm -rf /\nfoo bar\nEOF\nwc -l x.md", nil},
		{`grep x <<< "a | b"`, nil},
		// 后台 & 照旧是连接符
		{`server --port 1 & curl localhost:1`, []string{"Bash(server:*)", "Bash(curl:*)"}},
		// 不给规则的：变量开头、等于放开任意代码的
		{`$C/run.sh`, nil},
		{`python3 -c "import os; os.remove('x')"`, nil},
		{`bash -c "rm -rf x"`, nil},
		{`sudo rm x`, nil},
		{`env FOO=1 rm x`, nil},
		{`node scripts/build.js --prod`, []string{"Bash(node scripts/build.js:*)"}},
	} {
		got := SuggestRules([]Denial{{ToolName: "Bash", ToolInput: map[string]any{"command": c.cmd}}}, allowed)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s\n got %v\nwant %v", c.cmd, got, c.want)
		}
		for _, r := range got {
			if _, err := CheckRule(r); err != nil {
				t.Errorf("建议的规则 %q 过不了 CheckRule：%v", r, err)
			}
		}
	}
}

// 只读白名单第二批（TSK-0837）：收的都在，刻意没收的不在。
func TestReadOnlyCommandsSecondBatch(t *testing.T) {
	have := map[string]bool{}
	for _, r := range ReadOnlyCommands {
		have[r] = true
	}
	for _, r := range []string{"Bash(cd:*)", "Bash(echo:*)", "Bash(printf:*)", "Bash(test:*)", "Bash(true)", "Bash(basename:*)",
		"Bash(dirname:*)", "Bash(realpath:*)", "Bash(stat:*)", "Bash(du:*)", "Bash(date:*)", "Bash(which:*)"} {
		if !have[r] {
			t.Errorf("只读白名单缺 %s", r)
		}
	}
	for _, r := range []string{"Bash(env:*)", "Bash(env)", "Bash(file:*)", "Bash(tree:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(rg:*)", "Bash(sqlite3:*)"} {
		if have[r] {
			t.Errorf("%s 不该在只读白名单里", r)
		}
	}
}

// 生产参数：MCP 配置和白名单一条一个 --allowedTools，不传 --dangerously-skip-permissions。
func TestClaudeArgsWithMCPAndAllowedTools(t *testing.T) {
	req := Request{AllowWrites: true, MCPConfig: "/d/mcp.json", AllowedTools: append([]string{MCPAllowRule()}, PermAllowed(PermAcceptEdits, nil)...)}
	args := claudeArgs(req, "做点什么", t.TempDir())
	joined := strings.Join(args, " ")
	for _, want := range []string{"--permission-mode acceptEdits", "--mcp-config /d/mcp.json", "--allowedTools mcp__pmw-run", "--allowedTools Bash(sqlite3 -readonly -safe:*)"} {
		if !strings.Contains(joined, want) {
			t.Errorf("命令行缺 %q：%s", want, joined)
		}
	}
	if strings.Contains(joined, "dangerously") {
		t.Fatalf("任何档位都不传 --dangerously-skip-permissions：%s", joined)
	}
	// 提示词必须是 -p 后面那一个参数，不能被 --allowedTools 这类可变参数吞掉
	if args[0] != "-p" || args[1] != "做点什么" {
		t.Fatalf("提示词位置不对：%v", args[:2])
	}
}

func TestMCPConfigJSON(t *testing.T) {
	var cfg struct {
		MCPServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(MCPConfigJSON("/b/pmw-mcp", "http://127.0.0.1:7796/"), &cfg); err != nil {
		t.Fatal(err)
	}
	sv, ok := cfg.MCPServers[MCPServer]
	if MCPServer == "pm-workspace" || !ok || len(cfg.MCPServers) != 1 || sv.Command != "/b/pmw-mcp" || strings.Join(sv.Args, " ") != "--api http://127.0.0.1:7796" {
		t.Fatalf("MCP 配置：%+v", cfg)
	}
	if err := CheckMCP("", "http://x"); err == nil {
		t.Fatal("没配 MCP 程序要报出来")
	}
	if err := CheckMCP("/nope/pmw-mcp", "http://x"); err == nil {
		t.Fatal("MCP 程序不存在要报出来")
	}
}

// 项目执行白名单（TSK-0837）：写入档位全合，只读档位只合读规则（Read / Grep / Glob / LS），合进去去重保序。
func TestProjectAllowFor(t *testing.T) {
	proj := []string{"Bash(./_shared/新建需求.sh:*)", "Read(//Volumes/docs/PRDs/**)", "mcp__claude_ai_Slack__slack_read_thread", "Grep", "Bash(ls:*)"}
	if got := ProjectAllowFor(PermReadOnly, proj); strings.Join(got, ",") != "Read(//Volumes/docs/PRDs/**),Grep" {
		t.Fatalf("只读档只合读规则：%v", got)
	}
	for _, p := range []string{PermAcceptEdits, PermEditsAndTests, PermCustom} {
		if got := ProjectAllowFor(p, proj); len(got) != len(proj) {
			t.Fatalf("%s 档全合：%v", p, got)
		}
	}
	got := PermAllowedWith(PermCustom, []string{"Bash(make deploy:*)"}, ProjectAllowFor(PermCustom, proj))
	n := 0
	for _, r := range got {
		if r == "Bash(ls:*)" {
			n++
		}
	}
	if n != 1 || got[len(got)-1] != "Grep" || !strings.Contains(strings.Join(got, ","), "Bash(make deploy:*),Bash(./_shared/新建需求.sh:*)") {
		t.Fatalf("合并去重保序（档位、自定义、项目）：%v", got)
	}
}

// 后台执行的提示词（TSK-0837）：写明命令怎么写才不被拒；列出合进来的项目执行白名单；IM 来源的任务指向 pmw_get_source_message。
func TestPromptStreamPermissionsAndSource(t *testing.T) {
	wb := &WriteBack{RunID: "run_1", ObjectID: "obj_1", Stream: true, ProjectAllow: []string{"Bash(./_shared/新建需求.sh:*)", "Read(//x/**)"}}
	got := BuildPrompt(Task{Title: "t", WriteBack: wb, Source: &Source{Channel: "slack", Text: "看一下"}})
	for _, want := range []string{
		"这个项目的执行白名单（项目档案）另放行：`Bash(./_shared/新建需求.sh:*)`、`Read(//x/**)`。",
		"不用 shell 变量", "不要 cd 到别处再跑 git", "被拒了不要换个写法重试",
		"pmw_get_source_message（object_id=obj_1），不要用 Slack 等渠道自己的 MCP 工具",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("缺 %q：\n%s", want, got)
		}
	}
	plain := BuildPrompt(Task{Title: "t", WriteBack: &WriteBack{RunID: "run_1", ObjectID: "obj_1", Stream: true}})
	if strings.Contains(plain, "执行白名单") || strings.Contains(plain, "pmw_get_source_message") {
		t.Errorf("没有项目白名单、不是 IM 来源时不写：\n%s", plain)
	}
	term := BuildPrompt(Task{Title: "t", WriteBack: &WriteBack{RunID: "run_1", ObjectID: "obj_1"}, Source: &Source{Text: "x"}})
	if !strings.Contains(term, "pmw_get_source_message（object_id=obj_1）。") || strings.Contains(term, "不用 shell 变量") {
		t.Errorf("终端方式：指向读来源工具，不写后台执行的命令约束：\n%s", term)
	}
}

// 被拒提示（TSK-0841 实录）：不再建议 Bash(1:*)；每段都已放行仍被拒的，说清原因在白名单之外（目录外、变量、cd 后跑 git）。
func TestDenialReasonRealRun(t *testing.T) {
	req := Request{AllowWrites: true, Permission: PermEditsAndTests, AllowedTools: PermAllowed(PermEditsAndTests, nil)}
	d := []Denial{
		{ToolName: "Bash", ToolInput: map[string]any{"command": `C="/x/云端功能需求"; ls "$C/_shared"; ls "$C/待审核"`}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": `grep -rln --include=*.ts -i "toolPolic" /y/apps 2>&1`}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": `/opt/miniconda3/bin/python 采集截图.py`}},
	}
	got := denialReason(d, req, true)
	if strings.Contains(got, "Bash(1:*)") || !strings.Contains(got, "建议放行：`Bash(/opt/miniconda3/bin/python 采集截图.py:*)`。") ||
		!strings.Contains(got, "原因不在白名单") || !strings.Contains(got, "项目档案的「执行白名单」") {
		t.Fatalf("被拒提示：\n%s", got)
	}
	only := denialReason(d[:2], req, false)
	if strings.Contains(only, "建议放行") || !strings.Contains(only, "原因不在白名单") {
		t.Fatalf("推不出规则时只说原因：\n%s", only)
	}
}
