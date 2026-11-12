// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func TestCodexCLIExecution(t *testing.T) {
	bin := fakeClaude(t, `cat > prompt.txt
printf '%s\n' "$@" > args.txt
printf '%s\n' '{"type":"thread.started","thread_id":"thread-1"}' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}' '{"type":"turn.completed"}'
`)
	r := Runner{}
	res, err := r.Start(context.Background(), Request{RunID: "codex_test", Workdir: t.TempDir(), Prompt: "hello", Harness: HarnessCodex, CodexBin: bin}, nil)
	if err != nil || res.Status != domain.RunDone || !strings.Contains(res.Output, "hello from codex") {
		t.Fatal(res, err)
	}
}
func TestCodexRoutingAndPermissions(t *testing.T) {
	spec, err := prepareCodex(Request{Codex: &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: "https://example.com/v1", Model: "test-model", APIKey: "secret"}}, "hello")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(spec.args, " ")
	if strings.Contains(joined, "secret") || !strings.Contains(joined, "read-only") || !strings.Contains(joined, `wire_api="responses"`) || len(spec.env) != 1 {
		t.Fatal(spec)
	}
	spec, err = prepareCodex(Request{AllowWrites: true}, "hello")
	if err != nil || !strings.Contains(strings.Join(spec.args, " "), "workspace-write") {
		t.Fatal(spec, err)
	}
	if _, err := prepareCodex(Request{Codex: &DeepSeekRoute{Kind: "anthropic"}}, "x"); err == nil {
		t.Fatal("unsupported provider accepted")
	}
}
func TestCodexReportedFailure(t *testing.T) {
	so := readCodexStream(strings.NewReader("{\"type\":\"turn.failed\",\"error\":{\"message\":\"login required\"}}\n"), &strings.Builder{}, nil)
	if !so.finalErr || so.finalText != "login required" {
		t.Fatal(so)
	}
}
func TestCodexTimeout(t *testing.T) {
	r := Runner{}
	res, err := r.Start(context.Background(), Request{RunID: "codex_timeout", Workdir: t.TempDir(), Prompt: "hello", Harness: HarnessCodex, CodexBin: fakeClaude(t, "sleep 30"), Timeout: 50 * time.Millisecond}, nil)
	if err != nil || res.Status == domain.RunDone {
		t.Fatal(res, err)
	}
}

func TestCodexCallbackMCP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"pmw":{"command":"/tmp/my mcp","args":["--api","http://localhost:8080"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	spec, err := prepareCodex(Request{MCPConfig: path}, "hello")
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(spec.args, " ")
	if !strings.Contains(args, `mcp_servers.pmw.command="/tmp/my mcp"`) || !strings.Contains(args, `mcp_servers.pmw.args=["--api","http://localhost:8080"]`) {
		t.Fatal(args)
	}
}

func TestCodexBashPreview(t *testing.T) {
	req := Request{CodexBin: "/Applications/test app/codex", Codex: &DeepSeekRoute{Kind: domain.ProviderOpenAI, BaseURL: "https://example.com/v1", Model: "model-'quoted", APIKey: "never-show-secret"}}
	command, err := CodexBash(req, "hello 'quoted' $(false)")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(command, "never-show-secret") || !strings.Contains(command, "PMW_CODEX_API_KEY") || !strings.Contains(command, "--model") {
		t.Fatal(command)
	}
	path := filepath.Join(t.TempDir(), "preview.sh")
	if err := os.WriteFile(path, []byte(command), 0600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("bash", "-n", path).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	native, err := CodexBash(Request{}, "test")
	if err != nil || strings.Contains(native, "PMW_CODEX_API_KEY") || strings.Contains(native, "--model") {
		t.Fatal(native, err)
	}
}
