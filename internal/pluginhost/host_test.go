// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// newFakeHost 建一个用 fake 客户端代替真实子进程的宿主；第二个返回值用来取
// 本次拉起（或最近一次拉起）的 fake 客户端。
func newFakeHost(t *testing.T, opts Options) (*Host, func() *fakePlugin) {
	t.Helper()
	h := newTestHost(t, opts)
	var (
		mu   sync.Mutex
		fake *fakePlugin
	)
	h.testLaunch = func(p *pluginProcess) error {
		f := startFakePlugin(t, p)
		mu.Lock()
		fake = f
		mu.Unlock()
		return nil
	}
	t.Cleanup(h.Close)
	return h, func() *fakePlugin {
		mu.Lock()
		defer mu.Unlock()
		return fake
	}
}

func TestHostLifecycle(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, getFake := newFakeHost(t, Options{})
	ctx := context.Background()

	info := installTestPlugin(t, h, dir)
	if info.Enabled || info.Running {
		t.Fatalf("装完默认不启用：%+v", info)
	}
	if len(info.Permissions) != 2 || len(info.Granted) != 2 {
		t.Fatalf("权限记录不对：%+v", info)
	}
	if info.InstallDir == "" || info.DataDir == "" {
		t.Fatalf("目录字段为空：%+v", info)
	}

	enabled, err := h.Enable(ctx, "hello_world")
	if err != nil {
		t.Fatalf("Enable 失败：%v", err)
	}
	if !enabled.Enabled || !enabled.Running {
		t.Fatalf("启用后状态不对：%+v", enabled)
	}
	fake := getFake()
	if fake == nil {
		t.Fatal("fake 插件没有被拉起")
	}
	fake.waitReady()
	fake.checkErr()

	// 宿主 → 插件：命令透传。
	res, err := h.Call(ctx, "hello_world", "plugin.command.run",
		json.RawMessage(`{"command":"hello_world.say_hi"}`))
	if err != nil {
		t.Fatalf("Call 失败：%v", err)
	}
	var cmdRes struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(res, &cmdRes); err != nil || !strings.Contains(cmdRes.Result, "fake") {
		t.Fatalf("Call 结果不对：%s %v", res, err)
	}

	// 启用是幂等的。
	again, err := h.Enable(ctx, "hello_world")
	if err != nil || !again.Running {
		t.Fatalf("重复 Enable 应幂等：%v %+v", err, again)
	}

	// 停用：fake 收到 deactivate 后退出。
	disabled, err := h.Disable(ctx, "hello_world")
	if err != nil {
		t.Fatalf("Disable 失败：%v", err)
	}
	if disabled.Enabled || disabled.Running {
		t.Fatalf("停用后状态不对：%+v", disabled)
	}
	if _, err := h.Call(ctx, "hello_world", "plugin.health", nil); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("停用后 Call 应 ErrNotRunning：%v", err)
	}

	// 再启用 → 再停用，验证可恢复。
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatalf("再次 Enable 失败：%v", err)
	}
	if _, err := h.Disable(ctx, "hello_world"); err != nil {
		t.Fatalf("再次 Disable 失败：%v", err)
	}

	// 插件私有库已创建。
	privPath := filepath.Join(h.dataDir("hello_world"), "data.db")
	if _, err := os.Stat(privPath); err != nil {
		t.Fatalf("插件私有库不存在：%v", err)
	}
}

func TestHostUninstall(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	info := installTestPlugin(t, h, dir)
	installDir := info.InstallDir

	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatalf("Enable 失败：%v", err)
	}
	if _, err := h.Uninstall(ctx, "hello_world", true); err != nil {
		t.Fatalf("Uninstall 失败：%v", err)
	}
	if _, err := os.Stat(installDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("安装目录没删：%v", err)
	}
	if _, err := os.Stat(h.dataDir("hello_world")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("delete_data=true 时数据目录没删：%v", err)
	}
	if _, err := h.Get("hello_world"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("卸载后 Get 应 ErrNotFound：%v", err)
	}
}

func TestHostUninstallKeepsData(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Uninstall(ctx, "hello_world", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(h.dataDir("hello_world")); err != nil {
		t.Fatalf("delete_data=false 时数据目录应保留：%v", err)
	}
}

func TestHostInstallPermissionConfirmation(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	ctx := context.Background()

	// 少确认一个非高风险权限 → ErrValidation。
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("少确认权限应 ErrValidation：%v", err)
	}
	// 确认未声明的权限 → ErrValidation。
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir},
		[]string{"objects:read", "notify", "network:any"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("确认未声明权限应 ErrValidation：%v", err)
	}

	// 高风险权限不能随安装授予。
	riskyDir := t.TempDir()
	m := testManifestObj(platformKey(), "bin/hello_world")
	m["permissions"] = []any{"objects:read", "notify", "fs:write:any"}
	m["permissions_reason"].(map[string]any)["fs:write:any"] = "导出文件到用户选择的任意目录"
	writeTestPackage(t, riskyDir, m)
	if _, err := h.Install(ctx, Source{Type: "dir", Path: riskyDir},
		[]string{"objects:read", "notify", "fs:write:any"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("高风险权限不应随安装授予：%v", err)
	}
	// 不确认高风险项时可以安装，且 granted 里没有它。
	info, err := h.Install(ctx, Source{Type: "dir", Path: riskyDir}, []string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("非高风险权限确认后应能安装：%v", err)
	}
	for _, g := range info.Granted {
		if g == "fs:write:any" {
			t.Fatalf("高风险权限被授予了：%+v", info.Granted)
		}
	}
}

func TestHostInstallIdempotentSameVersion(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	ctx := context.Background()
	first := installTestPlugin(t, h, dir)
	second, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"})
	if err != nil {
		t.Fatalf("同版本重装应幂等：%v", err)
	}
	if second.ID != first.ID || second.Version != first.Version || second.InstallDir != first.InstallDir {
		t.Fatalf("幂等安装返回的记录不一致：%+v vs %+v", first, second)
	}
}

func TestHostWebFileAndIcon(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}

	data, ctype, err := h.WebFile("hello_world", "web/entry.js")
	if err != nil {
		t.Fatalf("WebFile 失败：%v", err)
	}
	if !strings.Contains(string(data), "export default") || !strings.Contains(ctype, "javascript") {
		t.Fatalf("WebFile 内容/类型不对：%q %q", data, ctype)
	}
	// 嵌套路径。
	if _, _, err := h.WebFile("hello_world", "web/style.css"); err != nil {
		t.Fatalf("WebFile 嵌套路径失败：%v", err)
	}
	// 越界：不允许读到 web/ 目录外。
	for _, rel := range []string{"web/../plugin.json", "plugin.json", "../pm.db", "/etc/passwd", "web/..%2fplugin.json"} {
		if _, _, err := h.WebFile("hello_world", rel); !errors.Is(err, ErrNotFound) {
			t.Fatalf("越界路径 %q 应 ErrNotFound：%v", rel, err)
		}
	}

	icon, iconType, err := h.IconFile("hello_world")
	if err != nil {
		t.Fatalf("IconFile 失败：%v", err)
	}
	if !strings.Contains(string(icon), "<svg") || iconType != "image/svg+xml" {
		t.Fatalf("图标内容/类型不对：%q %q", icon, iconType)
	}
	if _, _, err := h.WebFile("nope", "web/entry.js"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的插件应 ErrNotFound：%v", err)
	}
}

func TestHostStartRestoresEnabledPlugins(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	d := newTestDB(t, false)
	ctx := context.Background()

	// 第一个宿主：安装 + 启用。
	h1, _ := newFakeHost(t, Options{DataDir: t.TempDir(), DB: d})
	if _, err := h1.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h1.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	h1.Close()

	// 第二个宿主用同一数据目录/状态库启动，应自动拉起 enabled 插件。
	h2, getFake2 := newFakeHost(t, Options{DataDir: h1.opts.DataDir, DB: d})
	if err := h2.Start(ctx); err != nil {
		t.Fatalf("Start 失败：%v", err)
	}
	info, err := h2.Get("hello_world")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Running || !info.Enabled {
		t.Fatalf("Start 后应恢复运行：%+v", info)
	}
	if fake2 := getFake2(); fake2 != nil {
		fake2.waitReady()
	}
	h2.Close()
}

func TestValidateHello(t *testing.T) {
	h := newTestHost(t, Options{})
	p := &pluginProcess{
		host:     h,
		id:       "hello_world",
		version:  "0.1.0",
		token:    "secret-token",
		row:      &stateRow{ID: "hello_world", Granted: []string{"objects:read"}},
		manifest: &Manifest{},
	}
	hello := func(protocol, token, id, api string) json.RawMessage {
		b, _ := json.Marshal(map[string]any{
			"protocol": protocol, "token": token, "plugin_id": id, "api": api,
		})
		return b
	}
	if _, rerr := p.validateHello(hello(ProtocolVersion, "secret-token", "hello_world", ">=2.0.0 <3.0.0")); rerr != nil {
		t.Fatalf("合法握手被拒绝：%s", rerr.Message)
	}
	cases := []struct {
		name string
		raw  json.RawMessage
	}{
		{"协议不符", hello("pmw-plugin-rpc/2", "secret-token", "hello_world", ">=2.0.0 <3.0.0")},
		{"token 不符", hello(ProtocolVersion, "wrong", "hello_world", ">=2.0.0 <3.0.0")},
		{"id 不符", hello(ProtocolVersion, "secret-token", "other", ">=2.0.0 <3.0.0")},
		{"api 不含宿主版本", hello(ProtocolVersion, "secret-token", "hello_world", ">=1.0.0 <2.0.0")},
		{"参数不是 JSON", json.RawMessage(`[]`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, rerr := p.validateHello(tc.raw); rerr == nil {
				t.Fatalf("%s 应握手失败", tc.name)
			}
		})
	}

	welcome, rerr := p.validateHello(hello(ProtocolVersion, "secret-token", "hello_world", ">=2.0.0 <3.0.0"))
	if rerr != nil {
		t.Fatal(rerr.Message)
	}
	if welcome["protocol"] != ProtocolVersion {
		t.Fatalf("welcome.protocol 不对：%+v", welcome["protocol"])
	}
	hostInfo := welcome["host"].(map[string]any)
	if hostInfo["api_version"] != ExternalAPIVersion || hostInfo["pmw_version"] != "0.3.0" {
		t.Fatalf("welcome.host 不对：%+v", hostInfo)
	}
	if perms := welcome["permissions"].([]string); len(perms) != 1 || perms[0] != "objects:read" {
		t.Fatalf("welcome.permissions 不对：%+v", perms)
	}
}

func TestHostCloseIdempotent(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	h.Close()
	h.Close()
	if h.isRunning("hello_world") {
		t.Fatal("Close 后插件仍在运行")
	}
}

// TestHostCloseWithoutStart 确认没安装插件时 Close 不 panic。
func TestHostCloseWithoutStart(t *testing.T) {
	h := newTestHost(t, Options{})
	h.Close()
	if len(h.List()) != 0 {
		t.Fatal("空宿主 List 应为空")
	}
}
