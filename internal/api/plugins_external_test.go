// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/pluginhost"
)

// TestExternalPluginRoutes：没有宿主时一条路由都不注册（默认构建的路由表不变）；
// 有宿主时全部模式都进真实 ServeMux（Go 1.22 的模式冲突会 panic）。
func TestExternalPluginRoutes(t *testing.T) {
	rec := &recordingMux{}
	(&Server{opt: Options{}}).externalPluginRoutes(rec)
	if len(rec.patterns) != 0 {
		t.Fatalf("没有外部插件宿主时不该注册路由，收到：%v", rec.patterns)
	}

	s := &Server{opt: Options{External: new(pluginhost.Host)}}
	s.externalPluginRoutes(http.NewServeMux())
}

// TestExternalPluginErr：宿主哨兵到契约错误码的映射，message 原样保留。
func TestExternalPluginErr(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want error
	}{
		{"not_found", fmt.Errorf("外部插件 demo 没装: %w", pluginhost.ErrNotFound), domain.ErrNotFound},
		{"validation", fmt.Errorf("清单字段不合法: %w", pluginhost.ErrValidation), domain.ErrValidation},
		{"permission", fmt.Errorf("缺少 objects:read 权限: %w", pluginhost.ErrPermission), domain.ErrValidation},
		{"conflict", fmt.Errorf("插件 demo 已经启用: %w", pluginhost.ErrConflict), domain.ErrConflict},
		{"incompatible", fmt.Errorf("当前平台没有可执行入口: %w", pluginhost.ErrIncompatible), domain.ErrConflict},
		{"not_running", fmt.Errorf("插件 demo 没在运行: %w", pluginhost.ErrNotRunning), domain.ErrConflict},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := externalPluginErr(tc.err)
			if !errors.Is(got, tc.want) {
				t.Fatalf("errors.Is(%v, %v) = false", got, tc.want)
			}
			if got.Error() != tc.err.Error() {
				t.Fatalf("message 被改了：%q，想要 %q", got.Error(), tc.err.Error())
			}
		})
	}
	// 普通错误原样交给 fail 按 500 处理
	plain := errors.New("disk on fire")
	if got := externalPluginErr(plain); got != plain {
		t.Fatalf("普通错误应原样返回，得到 %v", got)
	}
}

func TestExternalPluginCapabilities(t *testing.T) {
	s := &Server{opt: Options{Version: "1.2.3"}}
	rec := httptest.NewRecorder()
	s.handleExternalPluginCapabilities(rec, httptest.NewRequest(http.MethodGet, "/api/plugins/external/capabilities", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态：%d", rec.Code)
	}
	var body struct {
		Data struct {
			ExternalPlugins bool   `json:"external_plugins"`
			APIVersion      string `json:"api_version"`
			HostVersion     string `json:"host_version"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析响应：%v（%s）", err, rec.Body.String())
	}
	if !body.Data.ExternalPlugins || body.Data.APIVersion != pluginhost.ExternalAPIVersion || body.Data.HostVersion != "1.2.3" {
		t.Fatalf("capabilities 不对：%+v", body.Data)
	}
}

func TestValidateExternalSource(t *testing.T) {
	good := []externalSourceBody{
		{Type: "dir", Path: "/tmp/hello-world"},
		{Type: "archive", Path: "/tmp/hello-world.tar.gz", SHA256: strings.Repeat("a", 64)},
		{Type: "github", URL: "https://github.com/o/r"},
		{Type: "github", URL: "https://github.com/o/r/releases/download/v1.0.0/x.tar.gz"},
	}
	for _, b := range good {
		if err := validateExternalSource(b); err != nil {
			t.Errorf("%+v 应该合法：%v", b, err)
		}
	}
	bad := []externalSourceBody{
		{},                              // 缺 type
		{Type: "zip", Path: "/tmp/x"},   // 不认识的 type
		{Type: "dir"},                   // 缺 path
		{Type: "dir", Path: "relative"}, // 不是绝对路径
		{Type: "github"},                // 缺 url
		{Type: "github", URL: "github.com/o/r"},
		{Type: "dir", Path: "/tmp/x", SHA256: "abc"},
		{Type: "dir", Path: "/tmp/x", SHA256: strings.Repeat("z", 64)},
	}
	for _, b := range bad {
		if err := validateExternalSource(b); err == nil {
			t.Errorf("%+v 应该不合法", b)
		}
	}
}

func TestExternalAssetType(t *testing.T) {
	cases := map[string]string{
		"entry.js":      "text/javascript; charset=utf-8",
		"web/entry.mjs": "text/javascript; charset=utf-8",
		"style.css":     "text/css; charset=utf-8",
		"chunk.json":    "application/json; charset=utf-8",
		"entry.js.map":  "application/json; charset=utf-8",
		"icon.svg":      "image/svg+xml",
		"logo.png":      "image/png",
	}
	for rel, want := range cases {
		if got := externalAssetType(rel, ""); got != want {
			t.Errorf("externalAssetType(%q) = %q，想要 %q", rel, got, want)
		}
	}
	// 宿主给的 Content-Type 优先
	if got := externalAssetType("weird.xyz", "text/plain; charset=utf-8"); got != "text/plain; charset=utf-8" {
		t.Errorf("宿主给的 Content-Type 应优先，得到 %q", got)
	}
}

// TestExternalPluginAPIEndToEnd 是 API 层到宿主的集成测试（不全套起进程，用纯前端插件）：
// 真实 SQLite（跑 0059 迁移）+ 真实 pluginhost，把 resolve/install/list/web/icon/call/disable/uninstall
// 全部走一遍，守住「路由 → 宿主」这层接线（字段名、权限确认、错误映射、静态文件路径）。
func TestExternalPluginAPIEndToEnd(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	d, err := db.Open(filepath.Join(dir, "pmw.db"))
	if err != nil {
		t.Fatalf("打开数据库：%v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatalf("跑迁移：%v", err)
	}

	pkgDir := filepath.Join(dir, "hello-ext")
	writeExternalTestPlugin(t, pkgDir)

	log := slog.New(slog.DiscardHandler)
	host := pluginhost.New(pluginhost.Options{DataDir: dir, DB: d, Version: "1.2.0", Logger: log})
	t.Cleanup(host.Close)
	srv := &Server{opt: Options{External: host, Version: "1.2.0"}, log: log}
	handler := srv.build()

	do := func(method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		var rdr io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("序列化请求体：%v", err)
			}
			rdr = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, rdr)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		var out map[string]any
		if rec.Body.Len() > 0 {
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
		}
		return rec, out
	}
	dataOf := func(t *testing.T, out map[string]any) map[string]any {
		t.Helper()
		data, ok := out["data"].(map[string]any)
		if !ok {
			t.Fatalf("响应没有 data 对象：%v", out)
		}
		return data
	}
	errCode := func(t *testing.T, out map[string]any) string {
		t.Helper()
		e, ok := out["error"].(map[string]any)
		if !ok {
			t.Fatalf("响应没有 error：%v", out)
		}
		code, _ := e["code"].(string)
		return code
	}
	doUser := func(method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		var rdr io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("序列化请求体：%v", err)
			}
			rdr = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, rdr)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Actor-Source", "ui")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		var out map[string]any
		if rec.Body.Len() > 0 {
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
		}
		return rec, out
	}

	// capabilities
	rec, out := do(http.MethodGet, "/api/plugins/external/capabilities", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("capabilities 状态：%d %s", rec.Code, rec.Body.String())
	}
	cap := dataOf(t, out)
	if cap["api_version"] != pluginhost.ExternalAPIVersion || cap["host_version"] != "1.2.0" {
		t.Fatalf("capabilities 不对：%v", cap)
	}

	// 列表：还没装任何插件
	rec, out = do(http.MethodGet, "/api/plugins/external", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表状态：%d", rec.Code)
	}
	if list, ok := out["data"].([]any); !ok || len(list) != 0 {
		t.Fatalf("空列表不对：%v", out["data"])
	}

	// resolve：目录来源，纯前端插件
	source := map[string]any{"type": "dir", "path": pkgDir}
	rec, out = do(http.MethodPost, "/api/plugins/external/resolve", map[string]any{"source": source})
	if rec.Code != http.StatusOK {
		t.Fatalf("resolve 状态：%d %s", rec.Code, rec.Body.String())
	}
	preview := dataOf(t, out)
	manifest, _ := preview["manifest"].(map[string]any)
	if manifest["id"] != "hello_ext_test" || preview["compatible"] != true {
		t.Fatalf("预览不对：%v", preview)
	}
	perms, _ := preview["permissions"].([]any)
	if len(perms) != 2 {
		t.Fatalf("权限预览数量不对：%v", perms)
	}
	risks := map[string]string{}
	for _, raw := range perms {
		if perm, ok := raw.(map[string]any); ok {
			name, _ := perm["name"].(string)
			risk, _ := perm["risk"].(string)
			risks[name] = risk
		}
	}
	if risks["objects:read"] != "normal" || risks["fs:write:any"] != "high" {
		t.Fatalf("权限预览风险不对：%v", risks)
	}

	// install：没确认权限要 400
	rec, out = do(http.MethodPost, "/api/plugins/external/install", map[string]any{"source": source})
	if rec.Code != http.StatusBadRequest || errCode(t, out) != "validation" {
		t.Fatalf("缺权限确认时应 400 validation，得到 %d %s", rec.Code, rec.Body.String())
	}

	// install：确认权限，装完启用（纯前端插件 enabled=true、running=false）
	rec, out = do(http.MethodPost, "/api/plugins/external/install", map[string]any{
		"source": source, "confirm_permissions": []string{"objects:read"}, "enable": true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("install 状态：%d %s", rec.Code, rec.Body.String())
	}
	installed := dataOf(t, out)
	if installed["enabled"] != true {
		t.Fatalf("install 结果不对：%v", installed)
	}
	warnings, _ := installed["warnings"].([]any)
	if len(warnings) != 1 || !strings.Contains(fmt.Sprint(warnings[0]), "fs:write:any") {
		t.Fatalf("高风险权限应只进 warnings：%v", warnings)
	}
	plugin, _ := installed["plugin"].(map[string]any)
	if plugin["id"] != "hello_ext_test" || plugin["enabled"] != true || plugin["running"] != false {
		t.Fatalf("安装后的插件状态不对：%v", plugin)
	}

	// 列表能看到刚装的插件
	rec, out = do(http.MethodGet, "/api/plugins/external", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表状态：%d", rec.Code)
	}
	if list, _ := out["data"].([]any); len(list) != 1 {
		t.Fatalf("列表应有 1 个插件：%v", out["data"])
	}

	// web 静态文件：web_entry 是包内相对路径 web/entry.js，URL 原样拼在 /web/ 后面
	rec, _ = do(http.MethodGet, "/api/plugins/external/hello_ext_test/web/web/entry.js", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "__PMW_PLUGIN__") {
		t.Fatalf("读 entry.js 失败：%d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("entry.js Content-Type：%q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("entry.js Cache-Control：%q", cc)
	}
	rec, out = do(http.MethodGet, "/api/plugins/external/hello_ext_test/web/web/nope.js", nil)
	if rec.Code != http.StatusNotFound || errCode(t, out) != "not_found" {
		t.Fatalf("不存在的资源应 404，得到 %d %s", rec.Code, rec.Body.String())
	}
	// 兼容相对前端目录的写法：/web/entry.js 也能读到同一个文件
	rec, _ = do(http.MethodGet, "/api/plugins/external/hello_ext_test/web/entry.js", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "__PMW_PLUGIN__") {
		t.Fatalf("相对前端目录的 entry.js 失败：%d %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("相对前端目录的 entry.js Cache-Control：%q", cc)
	}

	// 图标
	rec, _ = do(http.MethodGet, "/api/plugins/external/hello_ext_test/icon", nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("图标读取失败：%d %q", rec.Code, rec.Header().Get("Content-Type"))
	}

	// call：纯前端插件没进程，409 conflict；不允许的方法 400
	rec, out = do(http.MethodPost, "/api/plugins/external/hello_ext_test/call", map[string]any{
		"method": "plugin.command.run", "params": map[string]any{"command": "x.y"},
	})
	if rec.Code != http.StatusConflict || errCode(t, out) != "conflict" {
		t.Fatalf("没运行时应 409 conflict，得到 %d %s", rec.Code, rec.Body.String())
	}
	rec, out = do(http.MethodPost, "/api/plugins/external/hello_ext_test/call", map[string]any{
		"method": "plugin.activate", "params": map[string]any{},
	})
	if rec.Code != http.StatusBadRequest || errCode(t, out) != "validation" {
		t.Fatalf("不允许的透传方法应 400，得到 %d %s", rec.Code, rec.Body.String())
	}

	// 高风险权限：非用户操作 403；confirm 不对 400；正确授予后 granted 出现，收回后消失
	rec, out = do(http.MethodPost, "/api/plugins/external/hello_ext_test/permissions/grant", map[string]any{
		"permission": "fs:write:any", "confirm": "外部测试插件",
	})
	if rec.Code != http.StatusForbidden || errCode(t, out) != "forbidden" {
		t.Fatalf("非用户操作授予应 403，得到 %d %s", rec.Code, rec.Body.String())
	}
	rec, out = doUser(http.MethodPost, "/api/plugins/external/hello_ext_test/permissions/grant", map[string]any{
		"permission": "fs:write:any", "confirm": "错了",
	})
	if rec.Code != http.StatusBadRequest || errCode(t, out) != "validation" {
		t.Fatalf("confirm 不对应 400，得到 %d %s", rec.Code, rec.Body.String())
	}
	rec, out = doUser(http.MethodPost, "/api/plugins/external/hello_ext_test/permissions/grant", map[string]any{
		"permission": "fs:write:any", "confirm": "外部测试插件",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("授予失败：%d %s", rec.Code, rec.Body.String())
	}
	granted, _ := dataOf(t, out)["granted"].([]any)
	hasGrant := false
	for _, g := range granted {
		if g == "fs:write:any" {
			hasGrant = true
		}
	}
	if !hasGrant {
		t.Fatalf("授予后 granted 不含 fs:write:any：%v", out["data"])
	}
	rec, out = doUser(http.MethodPost, "/api/plugins/external/hello_ext_test/permissions/revoke", map[string]any{
		"permission": "fs:write:any",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("收回失败：%d %s", rec.Code, rec.Body.String())
	}
	for _, g := range func() []any { granted, _ := dataOf(t, out)["granted"].([]any); return granted }() {
		if g == "fs:write:any" {
			t.Fatalf("收回后 granted 仍含 fs:write:any：%v", out["data"])
		}
	}

	// disable 再 uninstall（删数据）
	rec, out = do(http.MethodPost, "/api/plugins/external/hello_ext_test/disable", map[string]any{})
	if rec.Code != http.StatusOK || dataOf(t, out)["enabled"] != false {
		t.Fatalf("disable 失败：%d %s", rec.Code, rec.Body.String())
	}
	rec, out = do(http.MethodPost, "/api/plugins/external/hello_ext_test/uninstall", map[string]any{"delete_data": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("uninstall 失败：%d %s", rec.Code, rec.Body.String())
	}
	rec, out = do(http.MethodGet, "/api/plugins/external", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("列表状态：%d", rec.Code)
	}
	if list, _ := out["data"].([]any); len(list) != 0 {
		t.Fatalf("卸载后列表应为空：%v", out["data"])
	}
}

// writeExternalTestPlugin 在 root 下写一个最小的合法外部插件包（纯前端插件，不用编译二进制）。
func writeExternalTestPlugin(t *testing.T, root string) {
	t.Helper()
	manifest := `{
  "manifest_version": 2,
  "id": "hello_ext_test",
  "name": "外部测试插件",
  "description": "API 集成测试用",
  "version": "0.1.0",
  "api": ">=2.0.0 <3.0.0",
  "pmw": ">=1.0.0 <2.0.0",
  "license": "MIT",
  "repository": "https://github.com/example/hello-ext-test",
  "icon": "icon.svg",
  "provides": {"modules": ["hello_ext_test"]},
  "permissions": ["objects:read", "fs:write:any"],
  "permissions_reason": {"objects:read": "列出工作对象", "fs:write:any": "按用户选择导出本机文件"},
  "runtime": {"web": {"entry": "web/entry.js"}}
}`
	files := map[string]string{
		"plugin.json":  manifest,
		"LICENSE":      "MIT License\n",
		"icon.svg":     `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`,
		"web/entry.js": `window.__PMW_PLUGIN__?.register({activate(){},deactivate(){}});`,
	}
	for rel, content := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录 %s：%v", rel, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("写 %s：%v", rel, err)
		}
	}
}
