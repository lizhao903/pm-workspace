package plugin_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

func connTools(ds []connector.Def) []string {
	out := []string{}
	for _, d := range ds {
		out = append(out, d.Tool+"@"+d.Source)
	}
	return out
}

// TestConnectorDefsFollowEnabledState：示例插件登记的连接器只在它在跑时出现，Source 是插件 id；
// 接到内核注册表后 List、Get 跟着启停走，重新启用后回来。
func TestConnectorDefsFollowEnabledState(t *testing.T) {
	ctx := context.Background()
	r := newRegistry(t, plugin.NewMemStateStore(), plugintest.NewDemo(time.Hour))
	defs := connector.NewRegistry()
	defs.SetPluginDefs(r.ConnectorDefs)
	if got := connTools(defs.List()); len(got) != 0 {
		t.Fatalf("没装就有定义：%v", got)
	}
	installEnable(t, r, "demo")
	if got := connTools(defs.List()); len(got) != 1 || got[0] != "demo_echo@demo" {
		t.Fatalf("启用后 defs = %v", got)
	}
	if d, ok := defs.Get(plugintest.EchoTool); !ok || d.Test == nil || len(d.Fields) != 2 {
		t.Fatalf("Get = %+v, %v", d, ok)
	}
	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if _, ok := defs.Get(plugintest.EchoTool); ok || len(defs.List()) != 0 {
		t.Fatalf("停用后还取得到：%v", connTools(defs.List()))
	}
	if err := r.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if _, ok := defs.Get(plugintest.EchoTool); !ok {
		t.Fatal("重新启用后取不到")
	}
}

func TestConnectorChecksManifest(t *testing.T) {
	ok := func(tool string) plugin.ConnectorDef {
		d := plugintest.EchoConnector()
		d.Tool = tool
		return d
	}
	bad := ok("bad_a")
	bad.Auth = nil
	cases := []struct {
		name string
		def  []plugin.ConnectorDef
		want string
	}{
		{"没声明", []plugin.ConnectorDef{ok("bad_other")}, "provides.connectors"},
		{"定义不合法", []plugin.ConnectorDef{bad}, "不合法"},
		{"重复", []plugin.ConnectorDef{ok("bad_a"), ok("bad_a")}, "连接器重复"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePlugin{m: manifestJSON(t, `{"id":"bad","name":"bad","version":"0.1.0","core":">=1.0.0 <2.0.0",`+
				`"provides":{"connectors":["bad_a"]},"permissions":[]}`), reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.Connector(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
}

func manifestJSON(t *testing.T, js string) plugin.Manifest {
	t.Helper()
	m, err := plugin.Parse([]byte(js))
	if err != nil {
		t.Fatal(err)
	}
	return *m
}
