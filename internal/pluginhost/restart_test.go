// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"testing"
	"time"
)

// crashFake 关掉 fake 客户端的连接，等价于插件进程异常退出。
func crashFake(t *testing.T, f *fakePlugin) {
	t.Helper()
	if f == nil {
		t.Fatal("没有 fake 客户端")
	}
	f.proc.conn.close()
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func TestCrashAutoRestart(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, getFake := newFakeHost(t, Options{CrashBackoffBase: 10 * time.Millisecond})
	t.Cleanup(h.Close)
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	first := getFake()
	crashFake(t, first)
	if !waitFor(t, 3*time.Second, func() bool {
		f := getFake()
		return f != nil && f != first && f.proc.isRunning()
	}) {
		t.Fatal("插件崩溃后没有自动重启")
	}
	info, err := h.Get("hello_world")
	if err != nil || !info.Running {
		t.Fatalf("自动重启后应 running：%v %+v", err, info)
	}
}

func TestCrashRestartGivesUpAfterThree(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, getFake := newFakeHost(t, Options{CrashBackoffBase: 10 * time.Millisecond})
	t.Cleanup(h.Close)
	ctx := context.Background()
	installTestPlugin(t, h, dir)
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	// 每次崩溃 → 自动重启；连续 4 次后达到上限（3 次重启失败/再次崩溃），不再拉起。
	for i := 0; i < 4; i++ {
		f := getFake()
		if f == nil || !f.proc.isRunning() {
			t.Fatalf("第 %d 次崩溃前进程没在跑", i+1)
		}
		crashFake(t, f)
		if i < 3 {
			if !waitFor(t, 3*time.Second, func() bool {
				nf := getFake()
				return nf != nil && nf != f && nf.proc.isRunning()
			}) {
				t.Fatalf("第 %d 次崩溃后没有重启", i+1)
			}
		}
	}
	if !waitFor(t, 3*time.Second, func() bool {
		info, err := h.Get("hello_world")
		return err == nil && !info.Running && info.Error != ""
	}) {
		info, _ := h.Get("hello_world")
		t.Fatalf("超过上限后应停止重启并记 last_error：%+v", info)
	}
	// 等可能在途的自动重启 goroutine 收尾，避免 TempDir 清理时目录又被动过（测试 flake）。
	h.Close()
	time.Sleep(50 * time.Millisecond)
}
