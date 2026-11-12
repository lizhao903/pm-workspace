// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package terminal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderClaudeCommand(t *testing.T) {
	l := ClaudeLaunch{PromptFile: "/d/tmp/handoff/run_1/prompt.md", MCPConfig: "/d/tmp/handoff/run_1/mcp.json", Workdir: "/w/it's here"}
	cases := []struct{ tmpl, want string }{
		// 默认值：没写占位符，先补提示词再补 MCP 配置
		{"", `gogogo "$(cat '/d/tmp/handoff/run_1/prompt.md')" --mcp-config '/d/tmp/handoff/run_1/mcp.json'`},
		{"  c-d  ", `c-d "$(cat '/d/tmp/handoff/run_1/prompt.md')" --mcp-config '/d/tmp/handoff/run_1/mcp.json'`},
		// 写全了占位符就不补；工作目录里的单引号转义
		{`cd {{workdir}} && claude --mcp-config {{mcp_config}} -- "$(cat {{prompt_file}})"`,
			`cd '/w/it'\''s here' && claude --mcp-config '/d/tmp/handoff/run_1/mcp.json' -- "$(cat '/d/tmp/handoff/run_1/prompt.md')"`},
		// 只写了一个：补另一个
		{`claude --mcp-config {{mcp_config}}`, `claude --mcp-config '/d/tmp/handoff/run_1/mcp.json' "$(cat '/d/tmp/handoff/run_1/prompt.md')"`},
		// 用户自己包了一层引号：去掉，免得变成 "'…'"
		{`cd "{{workdir}}" && claude '{{prompt_file}}' {{mcp_config}}`,
			`cd '/w/it'\''s here' && claude '/d/tmp/handoff/run_1/prompt.md' '/d/tmp/handoff/run_1/mcp.json'`},
	}
	for _, c := range cases {
		if got := RenderClaudeCommand(c.tmpl, l); got != c.want {
			t.Errorf("模板 %q\n得到 %s\n要   %s", c.tmpl, got, c.want)
		}
	}
}

func TestTerminalSettings(t *testing.T) {
	_, srv := setup(t)
	code, out := call(t, srv, "GET", "/api/terminal/settings", "")
	d := out["data"].(map[string]any)
	if code != 200 || d["claude_command"] != "gogogo" || d["default_claude_command"] != "gogogo" {
		t.Fatalf("默认设置：%d %v", code, out)
	}
	if code, out = call(t, srv, "PATCH", "/api/terminal/settings", `{"claude_command":"  cd {{workdir}} && c-d  "}`); code != 200 ||
		out["data"].(map[string]any)["claude_command"] != "cd {{workdir}} && c-d" {
		t.Fatalf("改设置：%d %v", code, out)
	}
	if code, _ = call(t, srv, "PATCH", "/api/terminal/settings", `{"claude_command":"a\nb"}`); code != 400 {
		t.Fatalf("多行命令应 400：%d", code)
	}
	if code, _ = call(t, srv, "PATCH", "/api/terminal/settings", `{"claude_command":"`+strings.Repeat("x", maxClaudeCommand+1)+`"}`); code != 400 {
		t.Fatalf("太长应 400：%d", code)
	}
	// 留空等于恢复默认
	if _, out = call(t, srv, "PATCH", "/api/terminal/settings", `{"claude_command":""}`); out["data"].(map[string]any)["claude_command"] != "gogogo" {
		t.Fatalf("留空应恢复默认：%v", out)
	}
}

// 带 claude 新建会话：按设置渲染命令，shell 起来后执行；响应里带这条命令。
func TestCreateWithClaudeLaunch(t *testing.T) {
	_, srv := setup(t)
	dir := t.TempDir()
	pf, mf := filepath.Join(dir, "prompt.md"), filepath.Join(dir, "mcp.json")
	_ = os.WriteFile(pf, []byte("hello prompt"), 0o600)
	_ = os.WriteFile(mf, []byte("{}"), 0o600)
	if code, out := call(t, srv, "PATCH", "/api/terminal/settings", `{"claude_command":"echo GOT-$(cat {{prompt_file}} | tr ' ' _)"}`); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	body, _ := json.Marshal(map[string]any{"cwd": dir, "claude": map[string]string{"prompt_file": pf, "mcp_config": mf, "workdir": dir}})
	s := create(t, srv, string(body))
	if cmd, _ := s["command"].(string); !strings.HasPrefix(cmd, "echo GOT-$(cat '"+pf+"'") || !strings.Contains(cmd, "--mcp-config '"+mf+"'") {
		t.Fatalf("响应里的命令：%v", s["command"])
	}
	tm, _, err := dial(t, srv, s["id"].(string), "")
	if err != nil {
		t.Fatal(err)
	}
	tm.waitFor(`GOT-hello_prompt --mcp-config`)

	// 文件不在、不是绝对路径 400
	for _, c := range []map[string]string{
		{"prompt_file": filepath.Join(dir, "nope.md"), "mcp_config": mf},
		{"prompt_file": "prompt.md", "mcp_config": mf},
		{"prompt_file": pf, "mcp_config": ""},
	} {
		b, _ := json.Marshal(map[string]any{"cwd": dir, "claude": c})
		if code, out := call(t, srv, "POST", "/api/terminal/sessions", string(b)); code != 400 {
			t.Fatalf("%v 应 400：%d %v", c, code, out)
		}
	}
	// 不带 claude 的照旧，没有 command
	if s := create(t, srv, `{"cwd":"`+dir+`"}`); s["command"] != nil {
		t.Fatalf("不带 claude 不该有 command：%v", s)
	}
}
