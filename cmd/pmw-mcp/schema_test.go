// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestToolSchemasHaveProperties 守 TSK-0722 踩到的坑：每个工具的入参 schema 根上都要有 properties 对象。
// 只有 {"type":"object"} 的，经 DeepSeek（dsh）转给本机 Ollama 时整个请求 400「properties must be an object」，
// 一个工具不合规就让所有工具都用不了。
func TestToolSchemasHaveProperties(t *testing.T) {
	ctx := context.Background()
	srv := mcp.NewServer(&mcp.Implementation{Name: "t", Version: "0"}, nil)
	registerTools(srv, newClient("http://127.0.0.1:1"))
	st, ct := mcp.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tools) == 0 {
		t.Fatal("一个工具都没列出来")
	}
	for _, tool := range res.Tools {
		b, _ := json.Marshal(tool.InputSchema)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if _, ok := m["properties"].(map[string]any); !ok {
			t.Errorf("%s 的入参 schema 根上没有 properties 对象：%s", tool.Name, b)
		}
	}
}
