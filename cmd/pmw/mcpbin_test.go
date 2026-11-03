package main

import "testing"

func TestMCPBinFor(t *testing.T) {
	have := map[string]bool{"/x/bin/pmw-mcp": true, "/x/bin/pmw-mcp-dev": true}
	exists := func(p string) bool { return have[p] }
	cases := map[string]string{
		"/x/bin/pmw":     "/x/bin/pmw-mcp",
		"/x/bin/pmw-dev": "/x/bin/pmw-mcp-dev",
		"/x/bin/pmw-tmp": "/x/bin/pmw-mcp", // 推出来的 pmw-mcp-tmp 不在，退回 pmw-mcp
		"/x/bin/go-run":  "/x/bin/pmw-mcp",
		"/y/pmw":         "",
		"":               "",
	}
	for exe, want := range cases {
		if got := mcpBinFor(exe, exists); got != want {
			t.Errorf("mcpBinFor(%q) = %q，要 %q", exe, got, want)
		}
	}
}
