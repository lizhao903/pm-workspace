// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

type upPlugin struct{ m plugin.Manifest }

func (p upPlugin) Manifest() plugin.Manifest       { return p.m }
func (p upPlugin) Migrations() fs.FS               { return nil }
func (p upPlugin) Register(plugin.Registrar) error { return nil }

// TestPluginUpgrade：换了二进制，状态表里是 0.2.0、没确认 network:any。不带权限 409 并列出新增的，带上后升级。
func TestPluginUpgrade(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	states := plugin.NewSQLStateStore(st.DB())
	if err := states.Save(ctx, plugin.State{ID: "up", Installed: true, Enabled: true, Version: "0.2.0", Permissions: []string{}}); err != nil {
		t.Fatal(err)
	}
	m, err := plugin.Parse([]byte(`{"id":"up","name":"升级","version":"0.3.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":["network:any"]}`))
	if err != nil {
		t.Fatal(err)
	}
	reg := plugin.NewRegistry(states, slog.New(slog.NewTextHandler(io.Discard, nil)))
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	if err := reg.Add(upPlugin{*m}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := New(st, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Plugins: reg})

	list := decodeEnvelope(t, do(s, http.MethodGet, "/api/plugins", ""))["data"].([]any)
	if p := list[0].(map[string]any); p["upgradable"] != true || p["installed_version"] != "0.2.0" || len(p["permissions_confirmed"].([]any)) != 0 {
		t.Fatalf("升级前：%v", p)
	}

	w := do(s, http.MethodPost, "/api/plugins/up/upgrade", "")
	assertError(t, w, http.StatusConflict, "conflict")
	w = do(s, http.MethodPost, "/api/plugins/up/upgrade", `{"permissions":[]}`)
	var body struct {
		Error struct {
			Message     string   `json:"message"`
			Permissions []string `json:"permissions"`
		} `json:"error"`
	}
	if err := json.NewDecoder(w.Result().Body).Decode(&body); err != nil || w.Code != http.StatusConflict ||
		len(body.Error.Permissions) != 1 || body.Error.Permissions[0] != "network:any" {
		t.Fatalf("不带权限应 409 列出新增的：%d %+v", w.Code, body)
	}
	if in, _ := reg.Get("up"); in.State.Version != "0.2.0" {
		t.Fatalf("拒绝后版本不该变：%+v", in.State)
	}

	got := mustOK(t, s, http.MethodPost, "/api/plugins/up/upgrade", `{"permissions":["network:any"]}`)
	p := got["plugin"].(map[string]any)
	if p["installed_version"] != "0.3.0" || p["upgradable"] != false || p["running"] != true ||
		p["permissions_confirmed"].([]any)[0] != "network:any" || got["backup"] != nil || got["from"] != "0.2.0" {
		t.Fatalf("升级后：%v", got)
	}
	assertError(t, do(s, http.MethodPost, "/api/plugins/up/upgrade", `{"permissions":["network:any"]}`), http.StatusConflict, "conflict")
	assertError(t, do(s, http.MethodPost, "/api/plugins/nope/upgrade", ""), http.StatusNotFound, "not_found")
}
