package api

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// childPlugin 强依赖 demo，没有路由和表，测被依赖时的 409。
type childPlugin struct{ m plugin.Manifest }

func (p childPlugin) Manifest() plugin.Manifest       { return p.m }
func (p childPlugin) Migrations() fs.FS               { return nil }
func (p childPlugin) Register(plugin.Registrar) error { return nil }

// newPluginSQLServer 用临时目录下的真库起服务：状态表、迁移记录复用 store 的连接（和 cmd/pmw 一样），
// 快照落在临时目录的 backups/ 下。
func newPluginSQLServer(t *testing.T) (*Server, *sqlite.Store, string) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	st, err := sqlite.Open(ctx, filepath.Join(dir, "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	cm, err := plugin.Parse([]byte(`{"id":"child","name":"子插件","version":"0.1.0","core":">=1.0.0 <2.0.0",` +
		`"depends":{"demo":">=0.1.0 <1.0.0"},"provides":{},"permissions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []plugin.Plugin{plugintest.NewDemo(time.Hour), childPlugin{*cm}} {
		if err := reg.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := New(st, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Plugins: reg})
	return s, st, dir
}

func pluginData(t *testing.T, w interface {
	Result() *http.Response
}) map[string]any {
	t.Helper()
	var env map[string]any
	if err := json.NewDecoder(w.Result().Body).Decode(&env); err != nil {
		t.Fatal(err)
	}
	return env["data"].(map[string]any)
}

func mustOK(t *testing.T, s *Server, method, target, body string) map[string]any {
	t.Helper()
	w := do(s, method, target, body)
	if w.Code != http.StatusOK {
		t.Fatalf("%s %s = %d：%s", method, target, w.Code, w.Body.String())
	}
	return pluginData(t, w)
}

// TestPluginManagementLifecycle：列出、安装（先快照）、启用、被依赖时停用 409、卸载保留数据、
// 删数据不带确认拒绝、带确认先快照再删。
func TestPluginManagementLifecycle(t *testing.T) {
	s, st, dir := newPluginSQLServer(t)

	w := do(s, http.MethodGet, "/api/plugins", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/plugins = %d", w.Code)
	}
	list := decodeEnvelope(t, w)["data"].([]any)
	if len(list) != 2 {
		t.Fatalf("应列出二进制里的两个插件：%v", list)
	}
	demo := list[0].(map[string]any)
	if demo["id"] != "demo" || demo["installed"] != false || demo["pending_migrations"] != float64(2) ||
		demo["dependents"].([]any)[0] != "child" || demo["permissions"].([]any)[0] != "network:localhost" {
		t.Fatalf("未安装的 demo 不对：%v", demo)
	}
	if child := list[1].(map[string]any); child["depends"].(map[string]any)["demo"] != ">=0.1.0 <1.0.0" {
		t.Fatalf("child 的依赖不对：%v", child)
	}

	// 没确认权限 400；依赖没启用 409；都不打快照
	assertError(t, do(s, http.MethodPost, "/api/plugins/demo/install", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, http.MethodPost, "/api/plugins/child/install", ""), http.StatusConflict, "conflict")
	assertError(t, do(s, http.MethodPost, "/api/plugins/nope/install", ""), http.StatusNotFound, "not_found")
	if _, err := os.Stat(filepath.Join(dir, "backups")); !os.IsNotExist(err) {
		t.Fatalf("检查没过就打了快照：%v", err)
	}

	got := mustOK(t, s, http.MethodPost, "/api/plugins/demo/install", `{"permissions":["network:localhost"]}`)
	backup, _ := got["backup"].(string)
	if _, err := os.Stat(backup); backup == "" || err != nil {
		t.Fatalf("有迁移的安装应先快照：%q %v", backup, err)
	}
	p := got["plugin"].(map[string]any)
	if p["installed"] != true || p["enabled"] != false || p["pending_migrations"] != float64(0) ||
		p["installed_version"] != "0.1.0" || p["upgradable"] != false {
		t.Fatalf("安装后的 demo 不对：%v", p)
	}
	assertError(t, do(s, http.MethodPost, "/api/plugins/demo/install", `{"permissions":["network:localhost"]}`), http.StatusConflict, "conflict")

	if p := mustOK(t, s, http.MethodPost, "/api/plugins/demo/enable", ""); p["enabled"] != true || p["running"] != true {
		t.Fatalf("启用后的 demo 不对：%v", p)
	}
	if got := mustOK(t, s, http.MethodPost, "/api/plugins/child/install", ""); got["backup"] != nil {
		t.Fatalf("没有迁移的安装不该快照：%v", got["backup"])
	}
	mustOK(t, s, http.MethodPost, "/api/plugins/child/enable", "")

	// 被依赖时停用：409，dependents 列出依赖方
	e := assertError(t, do(s, http.MethodPost, "/api/plugins/demo/disable", ""), http.StatusConflict, "conflict")
	if deps, _ := e["dependents"].([]any); len(deps) != 1 || deps[0] != "child" {
		t.Fatalf("409 里没列出依赖方：%v", e)
	}
	if w := do(s, http.MethodGet, "/api/demo/ping", ""); w.Code != http.StatusOK {
		t.Fatalf("拒绝停用后插件路由 = %d", w.Code)
	}

	mustOK(t, s, http.MethodPost, "/api/plugins/child/disable", "")
	// 启用中不能卸载
	assertError(t, do(s, http.MethodPost, "/api/plugins/demo/uninstall", ""), http.StatusConflict, "conflict")
	if p := mustOK(t, s, http.MethodPost, "/api/plugins/demo/disable", ""); p["enabled"] != false || p["running"] != false {
		t.Fatalf("停用后的 demo 不对：%v", p)
	}
	// child 停用了但还装着，demo 不能卸载
	e = assertError(t, do(s, http.MethodPost, "/api/plugins/demo/uninstall", ""), http.StatusConflict, "conflict")
	if deps, _ := e["dependents"].([]any); len(deps) != 1 || deps[0] != "child" {
		t.Fatalf("卸载被拒时没列出依赖方：%v", e)
	}
	mustOK(t, s, http.MethodPost, "/api/plugins/child/uninstall", "")

	if _, err := st.DB().W.Exec(`INSERT INTO demo_items (id, title, created_at) VALUES ('a', 'x', '2026-10-28T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	// 删数据不带确认、确认填错：400，数据和状态都不动
	assertError(t, do(s, http.MethodPost, "/api/plugins/demo/uninstall", `{"delete_data":true}`), http.StatusBadRequest, "validation")
	assertError(t, do(s, http.MethodPost, "/api/plugins/demo/uninstall", `{"delete_data":true,"confirm":"child"}`), http.StatusBadRequest, "validation")
	var n int
	if err := st.DB().R.QueryRow(`SELECT COUNT(*) FROM demo_items`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("拒绝删数据后 demo_items = %d, %v", n, err)
	}

	// 默认保留数据
	got = mustOK(t, s, http.MethodPost, "/api/plugins/demo/uninstall", "")
	if got["data_deleted"] != false || got["backup"] != nil || got["plugin"].(map[string]any)["installed"] != false {
		t.Fatalf("保留数据的卸载结果：%v", got)
	}
	if err := st.DB().R.QueryRow(`SELECT COUNT(*) FROM demo_items`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("保留数据后 demo_items = %d, %v", n, err)
	}

	// 重装（迁移已应用，不快照）再停用，带确认删数据：先快照，快照里有数据，库里表没了
	if got := mustOK(t, s, http.MethodPost, "/api/plugins/demo/install", `{"permissions":["network:localhost"]}`); got["backup"] != nil {
		t.Fatalf("迁移都已应用的重装不该快照：%v", got["backup"])
	}
	got = mustOK(t, s, http.MethodPost, "/api/plugins/demo/uninstall", `{"delete_data":true,"confirm":"demo"}`)
	backup, _ = got["backup"].(string)
	if got["data_deleted"] != true || backup == "" || filepath.Dir(backup) != filepath.Join(dir, "backups") {
		t.Fatalf("删数据的卸载结果：%v", got)
	}
	if tables := got["dropped_tables"].([]any); len(tables) != 1 || tables[0] != "demo_items" {
		t.Fatalf("dropped_tables = %v", tables)
	}
	snap, err := sqlite.Open(context.Background(), backup)
	if err != nil {
		t.Fatalf("快照打不开：%v", err)
	}
	defer func() { _ = snap.Close() }()
	if err := snap.DB().R.QueryRow(`SELECT COUNT(*) FROM demo_items`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("快照里的 demo_items = %d, %v", n, err)
	}
	var tbl int
	if err := st.DB().R.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'demo_items'`).Scan(&tbl); err != nil || tbl != 0 {
		t.Fatalf("删数据后表还在：%d, %v", tbl, err)
	}
	if p := got["plugin"].(map[string]any); p["installed"] != false || p["pending_migrations"] != float64(2) {
		t.Fatalf("删数据后迁移应回到待应用：%v", p)
	}
}

// TestPluginManagementWithoutRegistry：没接注册表时列表为空，其余接口 404。
func TestPluginManagementWithoutRegistry(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodGet, "/api/plugins", "")
	if w.Code != http.StatusOK || len(decodeEnvelope(t, w)["data"].([]any)) != 0 {
		t.Fatalf("没接注册表时 GET /api/plugins = %d %s", w.Code, w.Body.String())
	}
	for _, act := range []string{"install", "enable", "disable", "uninstall"} {
		assertError(t, do(s, http.MethodPost, "/api/plugins/demo/"+act, ""), http.StatusNotFound, "not_found")
	}
}
