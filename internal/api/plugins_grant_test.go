// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

type livePlugin struct {
	upPlugin
	ok *bool
}

func (p livePlugin) CanGrant(context.Context, plugin.Core, string) (bool, string) {
	if *p.ok {
		return true, ""
	}
	return false, "实盘评审还差 5 项没确认"
}

// TestPluginGrantSeparate（TRD-08c）：单独申请的权限只接受用户本人在界面上申请（X-Actor-Source: ui、不带会话标识），
// 二次确认要填插件名，插件不同意时 403；收回谁调都行。
func TestPluginGrantSeparate(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	m, err := plugin.Parse([]byte(`{"id":"tr","name":"交易套件","version":"0.6.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":["network:market-data","trade:live"]}`))
	if err != nil {
		t.Fatal(err)
	}
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	ok := false
	if err := reg.Add(livePlugin{upPlugin{*m}, &ok}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := New(st, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Plugins: reg})

	// 安装只要确认普通权限；trade:live 列在 permissions_separate，不授予
	got := mustOK(t, s, http.MethodPost, "/api/plugins/tr/install", `{"permissions":["network:market-data"]}`)
	p := got["plugin"].(map[string]any)
	if conf := p["permissions_confirmed"].([]any); len(conf) != 1 || conf[0] != "network:market-data" || p["permissions_separate"].([]any)[0] != "trade:live" {
		t.Fatalf("安装后：%v", p)
	}
	mustOK(t, s, http.MethodPost, "/api/plugins/tr/enable", `{}`)

	ui := [2]string{"X-Actor-Source", "ui"}
	body := `{"permission":"trade:live","confirm":"交易套件"}`
	// 代理、接口、带会话标识的界面请求：403
	for _, hs := range [][][2]string{
		{{"X-Actor-Source", "agent"}, {"X-Actor-Session", "be557ce3"}},
		nil,
		{ui, {"X-Actor-Session", "spoof"}},
	} {
		e := assertError(t, do(s, http.MethodPost, "/api/plugins/tr/permissions/grant", body, hs...), http.StatusForbidden, "forbidden")
		if !strings.Contains(e["message"].(string), "只能由用户本人在界面上操作") {
			t.Fatalf("拒绝的说明：%v", e)
		}
	}
	// 插件名不对：400
	assertError(t, do(s, http.MethodPost, "/api/plugins/tr/permissions/grant", `{"permission":"trade:live","confirm":"tr"}`, ui), http.StatusBadRequest, "validation")
	// 普通权限不能单独授予：400
	assertError(t, do(s, http.MethodPost, "/api/plugins/tr/permissions/grant", `{"permission":"network:any","confirm":"交易套件"}`, ui), http.StatusBadRequest, "validation")
	// 插件不同意：403，原因原样
	e := assertError(t, do(s, http.MethodPost, "/api/plugins/tr/permissions/grant", body, ui), http.StatusForbidden, "forbidden")
	if !strings.Contains(e["message"].(string), "实盘评审还差 5 项没确认") {
		t.Fatalf("插件不同意的原因：%v", e)
	}
	if in, _ := reg.Get("tr"); len(in.State.Permissions) != 1 {
		t.Fatalf("拒绝后不该授予：%v", in.State.Permissions)
	}
	// 用户本人、插件同意：授予
	ok = true
	w := do(s, http.MethodPost, "/api/plugins/tr/permissions/grant", body, ui)
	if w.Code != http.StatusOK {
		t.Fatalf("授予 = %d %s", w.Code, w.Body.String())
	}
	if in, _ := reg.Get("tr"); len(in.State.Permissions) != 2 || in.State.Permissions[1] != "trade:live" {
		t.Fatalf("授予后：%v", in.State.Permissions)
	}
	// 收回谁调都行
	mustOK(t, s, http.MethodPost, "/api/plugins/tr/permissions/revoke", `{"permission":"trade:live"}`)
	if in, _ := reg.Get("tr"); len(in.State.Permissions) != 1 {
		t.Fatalf("收回后：%v", in.State.Permissions)
	}
	assertError(t, do(s, http.MethodPost, "/api/plugins/nope/permissions/grant", body, ui), http.StatusNotFound, "not_found")
}
