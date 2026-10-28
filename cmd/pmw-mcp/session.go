package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
)

// defaultAgentOwner 是领任务时写进负责人的干系人名字。
const defaultAgentOwner = "Claude Code"

// resolveActor 决定写入时记成谁。
//
// Claude Code 会给它拉起的子进程（含 MCP server）设 CLAUDECODE=1。认出来就记 claude-code，
// 否则记 mcp-agent——别的 Agent 也可能接这个 MCP，把它们都记成 claude-code 等于撒谎。
func resolveActor(flagVal string) string {
	if v := strings.TrimSpace(flagVal); v != "" {
		return v
	}
	if os.Getenv("CLAUDECODE") == "1" {
		return "claude-code"
	}
	return "mcp-agent"
}

// resolveSession 决定写入时带的会话标识，按优先级：
//  1. PMW_SESSION_ID：手工指定，演练脚本用它把一串调用归到同一个会话。
//  2. CLAUDE_CODE_SESSION_ID：Claude Code 给子进程设的会话 id，和 claude --resume 用的是同一个，
//     拿它能从任务页一路追到那次对话。
//  3. 都没有时生成一个进程级的实例 id（mcp-<16 位十六进制>）：至少同一个进程里的写入能归到一组，
//     不至于和别的进程混在一起。
//
// 取到的值必须满足后端的白名单 [A-Za-z0-9._:-]{1,64}，不满足时后端会整串丢弃，
// 所以这里提前校验，不合格就落到下一级，而不是带着一个会被丢掉的值去写。
func resolveSession() string {
	for _, k := range []string{"PMW_SESSION_ID", "CLAUDE_CODE_SESSION_ID"} {
		if v := strings.TrimSpace(os.Getenv(k)); validSession(v) {
			return v
		}
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "mcp-unknown"
	}
	return "mcp-" + hex.EncodeToString(b)
}

func validSession(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == '.' || r == '_' || r == ':' || r == '-'
		if !ok {
			return false
		}
	}
	return true
}
