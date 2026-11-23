// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestRPCRequestResponse(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	host := newRPCConn(a, quietLogger())
	host.setHandler(func(_ context.Context, method string, params json.RawMessage) (any, error) {
		if method != "plugin.activate" {
			return nil, rpcErrorf("method_not_found", "未知方法 %s", method)
		}
		return map[string]any{"ok": true, "echo": json.RawMessage(params)}, nil
	})
	host.start(context.Background())
	defer host.close()

	client := newRPCConn(b, quietLogger())
	client.start(context.Background())
	defer client.close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var out struct {
		OK   bool            `json:"ok"`
		Echo json.RawMessage `json:"echo"`
	}
	if err := client.call(ctx, "plugin.activate", map[string]any{"x": 1}, &out); err != nil {
		t.Fatalf("RPC 调用失败：%v", err)
	}
	if !out.OK || string(out.Echo) != `{"x":1}` {
		t.Fatalf("响应不对：%+v / %s", out, out.Echo)
	}

	// 未知方法回 method_not_found。
	err := client.call(ctx, "nope", nil, nil)
	var rerr *rpcError
	if !errors.As(err, &rerr) || rerr.Code != rpcErrorCodes["method_not_found"] {
		t.Fatalf("未知方法应返回 -32601：%v", err)
	}
}

func TestRPCNotification(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	got := make(chan string, 1)
	host := newRPCConn(a, quietLogger())
	host.setHandler(func(_ context.Context, method string, _ json.RawMessage) (any, error) {
		got <- method
		return nil, nil
	})
	host.start(context.Background())
	defer host.close()

	client := newRPCConn(b, quietLogger())
	client.start(context.Background())
	defer client.close()

	if err := client.notify("plugin.permission_changed", map[string]any{"permissions": []string{}}); err != nil {
		t.Fatalf("发通知失败：%v", err)
	}
	select {
	case method := <-got:
		if method != "plugin.permission_changed" {
			t.Fatalf("通知方法不对：%s", method)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("通知没有被处理")
	}
}

func TestRPCFrameTooLarge(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	host := newRPCConn(a, quietLogger())
	host.maxFrame = 128
	host.setHandler(func(_ context.Context, _ string, _ json.RawMessage) (any, error) {
		return map[string]any{"ok": true}, nil
	})
	host.start(context.Background())
	defer host.close()

	client := newRPCConn(b, quietLogger())
	client.start(context.Background())
	defer client.close()

	// 发一帧超过上限的消息，连接应被断开。
	big := `{"jsonrpc":"2.0","id":"1","method":"plugin.health","params":{"pad":"` +
		strings.Repeat("x", 256) + `"}}` + "\n"
	if _, err := b.Write([]byte(big)); err != nil {
		t.Fatalf("写大帧失败：%v", err)
	}
	select {
	case <-host.closed():
	case <-time.After(3 * time.Second):
		t.Fatal("超过帧上限后连接没有被断开")
	}
}

func TestRPCWriteLimit(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	conn := newRPCConn(a, quietLogger())
	conn.maxFrame = 64
	defer conn.close()
	if err := conn.write(map[string]any{"pad": strings.Repeat("x", 200)}); err == nil {
		t.Fatal("超过帧上限的写应报错")
	}
}

func TestRPCBadFrameDoesNotPanic(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	host := newRPCConn(a, quietLogger())
	host.start(context.Background())
	defer host.close()
	client := newRPCConn(b, quietLogger())
	client.start(context.Background())
	defer client.close()

	if _, err := b.Write([]byte("这不是 JSON\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte(`{"jsonrpc":"2.0","id":"2","method":"plugin.health"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	// 坏帧后连接应仍可处理合法帧（host 没有 handler 时回 method_not_found）。
	if err := client.call(context.Background(), "plugin.health", nil, nil); err == nil {
		t.Fatal("没有 handler 时应返回错误")
	}
}
