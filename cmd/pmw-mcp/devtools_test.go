// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func typeWith(keys ...string) *domain.ObjectType {
	t := &domain.ObjectType{ID: "task"}
	for _, k := range keys {
		t.Statuses = append(t.Statuses, domain.Status{Key: k})
	}
	return t
}

func TestResolveReviewStatus(t *testing.T) {
	// 内置 task 没有待验收类状态：不切换，并说明原因。
	got, why := resolveReviewStatus(typeWith("todo", "doing", "blocked", "done", "cancelled"), "")
	if got != "" || why == "" {
		t.Fatalf("没有待验收状态时应不切换并给出原因: %q %q", got, why)
	}
	// 有 review 就用它；按 key 认，不看标签。
	if got, _ := resolveReviewStatus(typeWith("todo", "doing", "qa", "review", "done"), ""); got != "review" {
		t.Fatalf("应优先取 review，实际 %q", got)
	}
	// 显式指定优先。
	if got, _ := resolveReviewStatus(typeWith("todo", "review"), "blocked"); got != "blocked" {
		t.Fatalf("显式 status 应优先，实际 %q", got)
	}
}

func TestCodeArtifact(t *testing.T) {
	in := recordArtifactArgs{Kind: "commit", SHA: "a1b2c3d4e5f6a7b8", Branch: "feat/x", Repo: "/tmp/repo"}
	title, note, path, err := codeArtifact("commit", in, "", "修好了", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if title != "commit a1b2c3d4e5" || path != "/tmp/repo" || !strings.HasPrefix(note, "[commit] sha=a1b2c3d4e5f6a7b8 branch=feat/x repo=/tmp/repo") || !strings.HasSuffix(note, "修好了") {
		t.Fatalf("title=%q note=%q path=%q", title, note, path)
	}
	// 有远端链接时不强求 repo，也不把仓库目录塞进 path。
	_, _, path, err = codeArtifact("pr", recordArtifactArgs{Kind: "pr"}, "", "", "https://github.com/a/b/pull/1", "")
	if err != nil || path != "" {
		t.Fatalf("pr 有 url 时应放行且 path 为空: %q %v", path, err)
	}
	for _, bad := range []recordArtifactArgs{
		{Kind: "commit", Repo: "/tmp/repo"}, // 缺 sha
		{Kind: "branch", Repo: "/tmp/repo"}, // 缺 branch
		{Kind: "commit", SHA: "abc"},        // 没有 url 也没有 repo
	} {
		if _, _, _, err := codeArtifact(bad.Kind, bad, "", "", "", ""); err == nil {
			t.Fatalf("%+v 应报错", bad)
		}
	}
	if _, _, _, err := codeArtifact("pr", recordArtifactArgs{Kind: "pr"}, "", "", "", "/tmp/x"); err == nil {
		t.Fatal("pr 缺 url 应报错")
	}
}

func TestResolveSession(t *testing.T) {
	t.Setenv("PMW_SESSION_ID", "")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "332d2cac-6041-4a72-bd2a-96d5db218df9")
	if got := resolveSession(); got != "332d2cac-6041-4a72-bd2a-96d5db218df9" {
		t.Fatalf("应取 Claude Code 的会话 id，实际 %q", got)
	}
	t.Setenv("PMW_SESSION_ID", "demo-run-1")
	if got := resolveSession(); got != "demo-run-1" {
		t.Fatalf("PMW_SESSION_ID 应优先，实际 %q", got)
	}
	// 不合法的值落到下一级，而不是带着一个会被后端丢掉的值去写。
	t.Setenv("PMW_SESSION_ID", "has space")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	if got := resolveSession(); !strings.HasPrefix(got, "mcp-") || !validSession(got) {
		t.Fatalf("应生成实例 id，实际 %q", got)
	}
}

func TestResolveActor(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	if got := resolveActor(""); got != "claude-code" {
		t.Fatalf("在 Claude Code 里应是 claude-code，实际 %q", got)
	}
	t.Setenv("CLAUDECODE", "")
	if got := resolveActor(""); got != "mcp-agent" {
		t.Fatalf("不在 Claude Code 里应是 mcp-agent，实际 %q", got)
	}
	if got := resolveActor("bot"); got != "bot" {
		t.Fatalf("--actor 应优先，实际 %q", got)
	}
}

// 注册全部工具不能 panic：go-sdk 在 AddTool 时才从 struct tag 生成 schema，
// tag 写法不合规（比如以 "kind=" 开头）要到进程启动才炸，单测里先炸出来。
func TestRegisterToolsDoesNotPanic(t *testing.T) {
	srv := mcp.NewServer(&mcp.Implementation{Name: "t", Version: "0"}, nil)
	registerTools(srv, newClient("http://127.0.0.1:1"))
}
