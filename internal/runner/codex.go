package runner

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func prepareCodex(req Request, prompt string) (cmdSpec, error) {
	bin := strings.TrimSpace(req.CodexBin)
	if bin == "" {
		bin = "codex"
	}
	sandbox := "read-only"
	if req.AllowWrites {
		sandbox = "workspace-write"
	}
	args := []string{"exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", sandbox, "--color", "never"}
	env := []string{}
	if rt := req.Codex; rt != nil {
		if rt.Kind != domain.ProviderOpenAI {
			return cmdSpec{}, validationErr("Codex 执行器需要 OpenAI 兼容服务商（支持 Responses API）")
		}
		if strings.TrimSpace(rt.Model) == "" || strings.TrimSpace(rt.BaseURL) == "" {
			return cmdSpec{}, validationErr("Codex 服务商需要接口地址和模型")
		}
		args = append(args, "--model", rt.Model, "-c", `model_provider="pmw_executor"`, "-c", `model_providers.pmw_executor.name="PMW executor"`, "-c", "model_providers.pmw_executor.base_url="+strconv.Quote(rt.BaseURL), "-c", `model_providers.pmw_executor.wire_api="responses"`, "-c", `model_providers.pmw_executor.env_key="PMW_CODEX_API_KEY"`)
		env = append(env, "PMW_CODEX_API_KEY="+rt.APIKey)
	}
	if req.MCPConfig != "" {
		raw, err := os.ReadFile(req.MCPConfig)
		if err != nil {
			return cmdSpec{}, err
		}
		var config struct {
			Servers map[string]struct {
				Command string   `json:"command"`
				Args    []string `json:"args"`
			} `json:"mcpServers"`
		}
		if err := json.Unmarshal(raw, &config); err != nil {
			return cmdSpec{}, err
		}
		for name, server := range config.Servers {
			if strings.ContainsAny(name, ". ") {
				return cmdSpec{}, validationErr("无效的 MCP 名称")
			}
			prefix := "mcp_servers." + name
			values := make([]string, len(server.Args))
			for i, value := range server.Args {
				values[i] = strconv.Quote(value)
			}
			args = append(args, "-c", prefix+".command="+strconv.Quote(server.Command), "-c", prefix+".args=["+strings.Join(values, ",")+"]")
		}
	}
	args = append(args, "-")
	return cmdSpec{bin: bin, args: args, stdin: prompt, env: env, name: "codex", hint: "请检查 Codex CLI 的安装和登录状态", read: readCodexStream}, nil
}

func readCodexStream(stdout io.Reader, out io.Writer, on func(Event)) streamOutcome {
	var result streamOutcome
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxLineBytes)
	for scanner.Scan() {
		var event struct {
			Type     string `json:"type"`
			ThreadID string `json:"thread_id"`
			Message  string `json:"message"`
			Error    struct {
				Message string `json:"message"`
			} `json:"error"`
			Item struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Text     string `json:"text"`
				Command  string `json:"command"`
				Output   string `json:"aggregated_output"`
				Status   string `json:"status"`
				ExitCode *int   `json:"exit_code"`
			} `json:"item"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		switch event.Type {
		case "thread.started":
			result.sessionID = event.ThreadID
		case "error", "turn.failed":
			result.finalErr = true
			result.turnReason = firstNonEmpty(event.Error.Message, event.Message, "Codex 执行失败")
			result.finalText = result.turnReason
			_, _ = fmt.Fprintln(out, result.turnReason)
		case "item.completed":
			if event.Item.Type == "agent_message" {
				result.finalText = event.Item.Text
				_, _ = fmt.Fprintln(out, event.Item.Text)
				if on != nil {
					on(Event{Type: EventDelta, Text: event.Item.Text})
				}
			} else if event.Item.Type == "command_execution" {
				ok := event.Item.ExitCode != nil && *event.Item.ExitCode == 0
				_, _ = fmt.Fprintf(out, "%s\n%s\n", event.Item.Command, event.Item.Output)
				if ok {
					result.okTools++
				}
				if on != nil {
					on(Event{Type: EventToolResult, ID: event.Item.ID, Name: "command", OK: ok, Message: event.Item.Output})
				}
			}
		case "item.started":
			if event.Item.Type == "command_execution" && on != nil {
				on(Event{Type: EventTool, ID: event.Item.ID, Name: "command", Detail: event.Item.Command})
			}
		}
	}
	if err := scanner.Err(); err != nil {
		result.finalErr = true
		result.finalText = "读取 Codex 输出失败：" + err.Error()
	}
	return result
}

// CodexBash renders the same invocation as prepareCodex without exposing credentials.
func CodexBash(req Request, prompt string) (string, error) {
	spec, err := prepareCodex(req, prompt)
	if err != nil {
		return "", err
	}
	quoteShell := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	var b strings.Builder
	b.WriteString("(\n")
	if req.Codex != nil {
		b.WriteString("  if [ -z \"${PMW_CODEX_API_KEY:-}\" ]; then\n    printf 'API Key: ' >&2\n    read -r -s PMW_CODEX_API_KEY\n    printf '\\n' >&2\n  fi\n  export PMW_CODEX_API_KEY\n")
	}
	b.WriteString("  pmw_test_dir=$(mktemp -d) || exit 1\n  trap 'rm -rf -- \"$pmw_test_dir\"' EXIT\n  cd -- \"$pmw_test_dir\" || exit 1\n  printf '%s\\n' " + quoteShell(prompt) + " | " + quoteShell(spec.bin))
	for _, arg := range spec.args {
		b.WriteString(" \\\n    " + quoteShell(arg))
	}
	b.WriteString("\n)\n")
	return b.String(), nil
}
