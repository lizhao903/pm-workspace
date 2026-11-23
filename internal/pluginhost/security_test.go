// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// startBadClient 连接宿主 socket 但不发 plugin.hello：首帧是一个普通请求。
// 这是回归测试：早期实现会把这条请求的错误响应当成握手成功，token 完全没验。
func startBadClient(t *testing.T, p *pluginProcess) {
	t.Helper()
	go func() {
		conn, err := net.DialTimeout("unix", p.socketPath, 3*time.Second)
		if err != nil {
			return
		}
		defer conn.Close()
		frame, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      "evil-1",
			"method":  "host.objects.list",
			"params":  map[string]any{"limit": 1},
		})
		_, _ = conn.Write(append(frame, '\n'))
		// 等宿主反应；握手失败会断开。
		br := bufio.NewReader(conn)
		_, _ = br.ReadBytes('\n')
		time.Sleep(200 * time.Millisecond)
	}()
}

func TestHandshakeRejectsNonHelloFirstFrame(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	t.Cleanup(h.Close)
	h.testLaunch = func(p *pluginProcess) error {
		startBadClient(t, p)
		return nil
	}
	if _, err := h.Install(context.Background(), Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := h.Enable(context.Background(), "hello_world"); err == nil {
		t.Fatal("没有 plugin.hello 的客户端不应能完成握手")
	} else if !strings.Contains(err.Error(), "握手") {
		t.Fatalf("期望握手错误，得到：%v", err)
	}
}

func TestStoreRejectsCommentAndWriteBypass(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("插件进程没起来")
	}
	attach := `/*x*/ ATTACH DATABASE '` + filepath.Join(t.TempDir(), "core.db") + `' AS core`
	if _, err := p.storeExec(ctx, []byte(`{"sql":`+quoteJSON(attach)+`}`)); err == nil {
		t.Fatal("注释前缀的 ATTACH 应被拒绝")
	}
	commentAttach := "-- x\nATTACH DATABASE '" + filepath.Join(t.TempDir(), "core2.db") + "' AS core"
	if _, err := p.storeExec(ctx, []byte(`{"sql":`+quoteJSON(commentAttach)+`}`)); err == nil {
		t.Fatal("行注释前缀的 ATTACH 应被拒绝")
	}
	withDelete := "WITH x AS (SELECT 1) DELETE FROM _pmw_settings"
	if _, err := p.storeQuery(ctx, []byte(`{"sql":`+quoteJSON(withDelete)+`}`)); err == nil {
		t.Fatal("host.store.query 不允许 WITH ... DELETE")
	}
	// 正常 SELECT 仍可用。
	if _, err := p.storeQuery(ctx, []byte(`{"sql":"SELECT 1 AS ok"}`)); err != nil {
		t.Fatalf("正常查询失败：%v", err)
	}
}

func TestWebAndIconRejectSymlinkEscape(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	t.Cleanup(h.Close)
	info, err := h.Install(context.Background(), Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"})
	if err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("core-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(info.InstallDir, "web", "escape.css")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.WebFile("hello_world", "web/escape.css"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("指向包外的 web 符号链接应 404，得到：%v", err)
	}
	if err := os.Remove(filepath.Join(info.InstallDir, "assets", "icon.svg")); err == nil {
		if err := os.Symlink(secret, filepath.Join(info.InstallDir, "assets", "icon.svg")); err == nil {
			if _, _, err := h.IconFile("hello_world"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("指向包外的 icon 符号链接应 404，得到：%v", err)
			}
		}
	}
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
