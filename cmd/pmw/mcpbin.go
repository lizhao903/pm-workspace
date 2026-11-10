// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// mcpBinFor 按工作台程序的位置推 MCP 程序：同目录下把名字里的 pmw 换成 pmw-mcp，
// 保留后缀（bin/pmw → bin/pmw-mcp，bin/pmw-dev → bin/pmw-mcp-dev）；推出来的不存在时退回同目录的 pmw-mcp；
// 都没有回空串（发起终端执行时回 409 说清怎么补）。go run 起的临时程序名字不是 pmw 开头，同样回落。
func mcpBinFor(exe string, exists func(string) bool) string {
	if exe == "" {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir, base := filepath.Split(exe)
	var cands []string
	if rest, ok := strings.CutPrefix(base, "pmw"); ok && !strings.HasPrefix(rest, "-mcp") {
		cands = append(cands, filepath.Join(dir, "pmw-mcp"+rest))
	}
	cands = append(cands, filepath.Join(dir, "pmw-mcp"))
	for _, c := range cands {
		if exists(c) {
			return c
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
