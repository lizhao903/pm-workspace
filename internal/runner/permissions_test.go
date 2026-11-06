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
	want := []string{"Bash(npm run e2e:*)", "Bash(git push:*)", "Bash(echo:*)", "mcp__pm-workspace__pmw_get_object", "WebFetch"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("建议规则\n got %v\nwant %v", got, want)
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
