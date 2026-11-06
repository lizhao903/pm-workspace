package domain

import "testing"

// TestInferArtifactKind 锁死推断口径（TSK-0497）。线上 116 条未分类全是执行扫目录登记的本地文件，
// 这张表里的路径照着那批真实数据挑：源码、构建产物、库文件、文档、流程图源文件。
func TestInferArtifactKind(t *testing.T) {
	cases := []struct {
		name, note, url, platform, path, want string
	}{
		{"提交前缀压过一切", "[commit] sha=a1b2c3d branch=x", "", "local", "/repo", "commit"},
		{"分支前缀", "[branch] branch=feat/x", "https://github.com/a/b/tree/feat/x", "github", "", "branch"},
		{"PR 前缀", "  [pr] branch=x", "", "", "/repo", "pr"},
		{"GitHub PR 链接", "", "https://github.com/a/b/pull/12", "github", "", "pr"},
		{"GitHub 提交链接", "", "https://github.com/a/b/commit/abcdef1", "github", "", "commit"},
		{"GitHub 分支链接", "", "https://github.com/a/b/tree/main", "github", "", "branch"},
		{"GitHub 仓库首页", "", "https://github.com/a/b", "github", "", "other"},
		{"Confluence 页面", "", "https://x.atlassian.net/wiki/1", "confluence", "", "doc"},
		{"Figma", "", "https://figma.com/file/x", "figma", "", "prototype"},
		{"别的链接", "", "https://example.com/x", "other", "", "other"},
		{"Go 源码", "", "", "local", "/repo/internal/agent/chat.go", "code"},
		{"TSX", "", "", "local", "/repo/frontend/src/plugins/im/SlackForm.tsx", "code"},
		{"构建产物 js", "", "", "local", "/repo/frontend/dist.bak/assets/AgentAvatar-Dn6eKizU.js", "code"},
		{"样式", "", "", "local", "/repo/frontend/src/plugins/im/channels.css", "code"},
		{"Markdown", "", "", "local", "/docs/需求草稿/TSK-0426.md", "doc"},
		{"流程图源文件", "", "", "local", "/docs/assets/pcard-reserve-flow.mmd", "doc"},
		{"大写扩展名", "", "", "local", "/docs/方案.PDF", "doc"},
		{"库文件", "", "", "local", "/repo/data/pm.db", "data"},
		{"WAL 文件", "", "", "local", "/repo/data-dev/pm.db-wal", "data"},
		{"日志", "", "", "local", "/repo/data-dev/pmw.log", "data"},
		{"JSON", "", "", "local", "/docs/.obsidian/workspace.json", "data"},
		{"HTML 原型", "", "", "local", "/proto/index.html", "prototype"},
		{"没有扩展名的二进制", "", "", "local", "/repo/bin/pmw-mcp", "other"},
		{"备份后缀", "", "", "local", "/repo/bin/pmw.prev", "other"},
		{"路径和链接都有按路径", "", "https://x.atlassian.net/wiki/1", "confluence", "/docs/a.md", "doc"},
		{"前缀不在开头不算", "见 [commit] sha=1", "", "local", "/a/b.go", "code"},
	}
	for _, c := range cases {
		if got := InferArtifactKind(c.note, c.url, c.platform, c.path); got != c.want {
			t.Errorf("%s: 得到 %q，期望 %q", c.name, got, c.want)
		}
	}
}

// TestDisplayKindPrefersStoredKind：库里有 kind 就用 kind，推断只补空的。
func TestDisplayKindPrefersStoredKind(t *testing.T) {
	if got := DisplayKindOf(&Artifact{Kind: "doc", Path: "/a/b.go"}); got != "doc" {
		t.Errorf("有 kind 时应原样返回，得到 %q", got)
	}
	if got := DisplayKindOf(&Artifact{Path: "/a/b.go"}); got != "code" {
		t.Errorf("kind 为空时应推断，得到 %q", got)
	}
}
