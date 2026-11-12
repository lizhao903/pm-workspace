// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// impactPlugin 登记两项影响：msgs 按 counts 给条数，flaky 总是出错。
type impactPlugin struct {
	m      plugin.Manifest
	counts map[string]int
}

func (p impactPlugin) Manifest() plugin.Manifest { return p.m }
func (p impactPlugin) Migrations() fs.FS         { return nil }
func (p impactPlugin) Register(r plugin.Registrar) error {
	r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "msgs", Load: func(_ context.Context, _ plugin.Core, cn plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
		return &plugin.ConnectorImpactData{Count: p.counts[cn.ID], Text: "有消息", Effect: plugin.ImpactKeep}, nil
	}})
	r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "flaky", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
		return nil, errors.New("boom")
	}})
	return nil
}

// TestConnectorImpact（CONN-03）：内核数开着的工具授权，插件的提供者按实例 id 回条数，出错的进 incomplete；
// 影响检查不拦删除；不存在的实例 404。
func TestConnectorImpact(t *testing.T) {
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
	m, err := plugin.Parse([]byte(`{"id":"imp","name":"影响","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	p := impactPlugin{m: *m, counts: map[string]int{}}
	if err := reg.Add(p); err != nil {
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
	r := &connRec{t: t, s: New(st, Options{Version: "test", Logger: log, Vault: v, Plugins: reg,
		Connectors: connector.New(st.DB(), v, defs)})}

	c := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	id := c["id"].(string)
	got := r.call("GET", "/api/connectors/"+id+"/impact", "", http.StatusOK)
	if got["connector_id"] != id || len(got["items"].([]any)) != 0 || len(got["incomplete"].([]any)) != 0 {
		t.Fatalf("新接入的 impact = %v", got)
	}

	r.call("POST", "/api/connectors/"+id+"/tools/refresh", "", http.StatusOK)
	r.call("PATCH", "/api/connectors/"+id+"/tools", `{"modes":{"get_item":"off"}}`, http.StatusOK)
	r.call("POST", "/api/plugins/imp/install", `{"permissions":[]}`, http.StatusOK)
	r.call("POST", "/api/plugins/imp/enable", "", http.StatusOK)
	p.counts[id] = 4
	got = r.call("GET", "/api/connectors/"+id+"/impact", "", http.StatusOK)
	items := got["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items = %v", items)
	}
	core := items[0].(map[string]any)
	if core["source"] != "core" || core["key"] != "tool_grants" || core["count"] != float64(2) || core["effect"] != "revoke" ||
		core["text"] != "2 个 Agent 工具授权会一并撤销：list_items、create_item" {
		t.Fatalf("内核这项 = %v", core)
	}
	msgs := items[1].(map[string]any)
	if msgs["source"] != "imp" || msgs["key"] != "msgs" || msgs["count"] != float64(4) || msgs["effect"] != "keep" {
		t.Fatalf("插件这项 = %v", msgs)
	}
	inc := got["incomplete"].([]any)
	if len(inc) != 1 || inc[0].(map[string]any)["source"] != "imp" || inc[0].(map[string]any)["key"] != "flaky" {
		t.Fatalf("incomplete = %v", inc)
	}

	r.call("DELETE", "/api/connectors/"+id, "", http.StatusOK)
	r.call("GET", "/api/connectors/"+id+"/impact", "", http.StatusNotFound)
}
