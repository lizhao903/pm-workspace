// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MCPServer 是工作台注入给 Claude Code 的 MCP server 名（TSK-0499）。
//
// 三条路共用这一个名字和同一份配置：任务的后台执行（POST /api/objects/{id}/run）、
// 终端交接（POST /api/objects/{id}/run/terminal）、插件交给 Claude Code 的运行（AUTO-01）。
//
// 不叫 pm-workspace：工作目录里的 .mcp.json 可能已经有一个同名 server（本仓库就有，
// 指向 ./bin/pmw-mcp-dev），可能指向别的工作台实例。同名时谁覆盖谁由 Claude Code 决定，
// 回写可能落到别处；独立起名后两者并存，提示词和 --allowedTools 只认这一个。
const MCPServer = "pmw-run"

// MCPEndpoint 是接回工作台的 MCP：程序路径和工作台地址。dsh 的 patch 用它（TSK-0722），
// claude 用的是由同样两样东西生成的 MCPConfigJSON 文件。
type MCPEndpoint struct {
	Bin string
	API string
}

// MCPConfigJSON 生成接回工作台的 MCP 配置：一个 stdio server，命令是本机工作台的 MCP 程序，
// --api 指向当前工作台实例。不含任何凭证。
func MCPConfigJSON(bin, api string) []byte {
	cfg := map[string]any{"mcpServers": map[string]any{
		MCPServer: map[string]any{
			"type":    "stdio",
			"command": bin,
			"args":    []string{"--api", strings.TrimRight(api, "/")},
		},
	}}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return append(b, '\n')
}

// CheckMCP 确认 MCP 程序和工作台地址都在，缺哪样说哪样。
func CheckMCP(bin, api string) error {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return fmt.Errorf("没配工作台的 MCP 程序（make build-mcp，或启动时用 --mcp-bin 指定）")
	}
	if st, err := os.Stat(bin); err != nil || st.IsDir() {
		return fmt.Errorf("工作台的 MCP 程序 %s 不存在（make build-mcp，或启动时用 --mcp-bin 指定）", bin)
	}
	if strings.TrimSpace(api) == "" {
		return fmt.Errorf("不知道工作台自己的地址（--public-url），MCP 接不回来")
	}
	return nil
}

// WriteMCPConfig 把配置写到 dir/mcp.json（目录不存在就建，只有本人可读写），回文件路径。
func WriteMCPConfig(dir, bin, api string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, MCPConfigJSON(bin, api), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// TempMCPConfig 校验后把配置写进新建的临时目录，回路径和删掉它的函数。
func TempMCPConfig(bin, api string) (string, func(), error) {
	if err := CheckMCP(bin, api); err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp("", "pmw-run-")
	if err != nil {
		return "", nil, err
	}
	path, err := WriteMCPConfig(dir, bin, api)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", nil, err
	}
	return path, func() { _ = os.RemoveAll(dir) }, nil
}
