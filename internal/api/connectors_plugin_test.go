package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

func defTools(d map[string]any) []string {
	out := []string{}
	for _, x := range d["data"].([]any) {
		out = append(out, x.(map[string]any)["tool"].(string))
	}
	return out
}

// TestPluginConnectorFollowsPlugin（CONN-02）：示例插件登记的连接器随插件启停出现、隐藏；
// 停用后实例还在、available 为 false、测试回 409、改名照常；重新启用后配置和凭证都还在，测试通过。
func TestPluginConnectorFollowsPlugin(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), log)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	if err := reg.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	defs := connector.NewRegistry()
	if err := defs.Register(connector.Fake()); err != nil {
		t.Fatal(err)
	}
	defs.SetPluginDefs(reg.ConnectorDefs)
	r := &connRec{t: t, s: New(st, Options{Version: "test", Logger: log, Vault: v, Plugins: reg,
		Connectors: connector.New(st.DB(), v, defs)})}

	if got := defTools(r.call("GET", "/api/connectors/defs", "", http.StatusOK)); len(got) != 1 || got[0] != "fake" {
		t.Fatalf("没装插件时 defs = %v", got)
	}
	r.call("POST", "/api/plugins/demo/install", `{"permissions":["network:localhost"]}`, http.StatusOK)
	r.call("POST", "/api/plugins/demo/enable", "", http.StatusOK)
	d := r.call("GET", "/api/connectors/defs", "", http.StatusOK)
	if got := defTools(d); len(got) != 2 || got[1] != plugintest.EchoTool {
		t.Fatalf("启用后 defs = %v", got)
	}
	if src := d["data"].([]any)[1].(map[string]any)["source"]; src != "demo" {
		t.Fatalf("source = %v", src)
	}

	const tok = "demo_tokenValue_0123456789abcdef"
	c := r.call("POST", "/api/connectors", `{"tool":"demo_echo","name":"示例","config":{"account":"小明"},"secrets":{"token":"`+tok+`"}}`, http.StatusCreated)
	id := c["id"].(string)
	if res := r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK); res["ok"] != true || res["account"] != "小明" {
		t.Fatalf("test = %v", res)
	}
	r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusOK)
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"post":"auto"}}`, http.StatusOK)

	// 停用：定义隐藏，实例保留、available=false，测试和拉工具 409，改名照常
	r.call("POST", "/api/plugins/demo/disable", "", http.StatusOK)
	if got := defTools(r.call("GET", "/api/connectors/defs", "", http.StatusOK)); len(got) != 1 || got[0] != "fake" {
		t.Fatalf("停用后 defs = %v", got)
	}
	list := r.call("GET", "/api/connectors", "", http.StatusOK)["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["available"] != false {
		t.Fatalf("停用后 list = %v", list)
	}
	r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusConflict)
	r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusConflict)
	r.call("PATCH", "/api/connectors/"+id, `{"name":"示例二"}`, http.StatusOK)
	// 定义不在了，同 tool 不能新建
	r.call("POST", "/api/connectors", `{"tool":"demo_echo","secrets":{"token":"x"}}`, http.StatusBadRequest)

	// 重新启用：配置、凭证、工具授权都还在
	r.call("POST", "/api/plugins/demo/enable", "", http.StatusOK)
	got := r.call("GET", "/api/connectors/"+id, "", http.StatusOK)
	if got["available"] != true || got["name"] != "示例二" || got["config"].(map[string]any)["account"] != "小明" ||
		got["secret_hints"].(map[string]any)["token"] != vault.Hint(tok) || toolModes(got)["post"] != "auto" {
		t.Fatalf("重新启用后 = %v", got)
	}
	if res := r.call("POST", "/api/connectors/"+id+"/test", "", http.StatusOK); res["ok"] != true {
		t.Fatalf("重新启用后 test = %v", res)
	}
}
