package plugin_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// cmd/pmw 用 SetConnectors 接的是 *connector.Store，它要同时满足拿配置的接口，否则 With 一直回 ErrNoConnectors
var _ plugin.ConnectorConfigs = (*connector.Store)(nil)

// TestConnectorsWithOnlyOwn：插件只拿得到自己登记的连接器实例的配置，别的插件和内核的按没有这个 id；
// 没接上实现时回 ErrNoConnectors；停用后自己的也拿不到。
func TestConnectorsWithOnlyOwn(t *testing.T) {
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

	cores := map[string]plugin.Core{}
	mk := func(id string) *fakePlugin {
		return &fakePlugin{m: manifestJSON(t, `{"id":"`+id+`","name":"`+id+`","version":"0.1.0","core":">=1.0.0 <2.0.0",`+
			`"provides":{"connectors":["`+id+`_echo"]},"permissions":[]}`), reg: func(r plugin.Registrar) error {
			cores[id] = r.Core()
			d := plugintest.EchoConnector()
			d.Tool = id + "_echo"
			r.Connector(d)
			return nil
		}}
	}
	r := newRegistry(t, plugin.NewMemStateStore(), mk("alpha"), mk("beta"))
	installEnable(t, r, "alpha")
	installEnable(t, r, "beta")

	// 没接上实现
	if err := cores["alpha"].Connectors().With(ctx, "cn_x", func(plugin.ConnectorConfig) error { return nil }); !errors.Is(err, plugin.ErrNoConnectors) {
		t.Fatalf("没接上：%v", err)
	}

	defs := connector.NewRegistry()
	core := plugintest.EchoConnector()
	core.Tool = "core_echo"
	if err := defs.Register(core); err != nil {
		t.Fatal(err)
	}
	defs.SetPluginDefs(r.ConnectorDefs)
	conns := connector.New(st.DB(), v, defs)
	r.SetConnectors(conns)
	inst := map[string]string{}
	for _, tool := range []string{"alpha_echo", "beta_echo", "core_echo"} {
		c, err := conns.Create(ctx, connector.Input{Tool: tool, Config: map[string]string{"account": tool},
			Secrets: map[string]string{"token": "tok-" + tool}})
		if err != nil {
			t.Fatal(err)
		}
		inst[tool] = c.ID
	}

	var tok, acct string
	if err := cores["alpha"].Connectors().With(ctx, inst["alpha_echo"], func(cfg plugin.ConnectorConfig) error {
		tok, acct = cfg.Secret("token"), cfg.Get("account")
		return nil
	}); err != nil || tok != "tok-alpha_echo" || acct != "alpha_echo" {
		t.Fatalf("自己的实例 = %q %q %v", tok, acct, err)
	}
	for _, id := range []string{inst["beta_echo"], inst["core_echo"], "cn_missing"} {
		called := false
		err := cores["alpha"].Connectors().With(ctx, id, func(plugin.ConnectorConfig) error { called = true; return nil })
		if !errors.Is(err, plugin.ErrNoRows) || called {
			t.Fatalf("%s 不该拿到：%v called=%v", id, err, called)
		}
	}

	// 停用后定义不在了，自己的实例也拿不到
	if err := r.Disable(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if err := cores["alpha"].Connectors().With(ctx, inst["alpha_echo"], func(plugin.ConnectorConfig) error { return nil }); err == nil {
		t.Fatal("停用后不该拿到配置")
	}
}
