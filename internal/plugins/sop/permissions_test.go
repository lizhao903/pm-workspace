package sop

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// setupStale 复现 7796 的状态：状态表里装的是 0.2.0、没确认 network:any，二进制里跑的是 0.3.0。
func setupStale(t *testing.T) (*plugin.Registry, http.Handler) {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	newReg := func() *plugin.Registry {
		r := plugin.NewRegistry(plugin.NewSQLStateStore(d), log)
		r.Migrations = plugin.NewSQLMigrationStore(d)
		if err := r.Add(New()); err != nil {
			t.Fatal(err)
		}
		if err := r.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return r
	}
	first := newReg()
	if err := first.Install(ctx, "sop", sopPerms); err != nil {
		t.Fatal(err)
	}
	if err := first.Enable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	first.Close()
	st, err := plugin.NewSQLStateStore(d).Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	old := st["sop"]
	old.Version, old.Permissions = "0.2.0", []string{}
	if err := plugin.NewSQLStateStore(d).Save(ctx, old); err != nil {
		t.Fatal(err)
	}
	r := newReg()
	t.Cleanup(r.Close)
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return r, mux
}

func TestHTTPNodeNeedsConfirmedNetworkAny(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	r, h := setupStale(t)
	if in, _ := r.Get("sop"); !in.Running || in.State.Version != "0.2.0" {
		t.Fatalf("要复现旧版本在跑的状态：%+v running=%v", in.State, in.Running)
	}
	id := newFlow(t, h, `{"name":"HTTP","steps":[{"key":"h","name":"通知","kind":"http","after":[],"config":{"method":"GET","url":"`+srv.URL+`"}}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	run := waitStatus(t, h, rid, "failed")
	if got := step(run, "h")["error"]; got != "插件 sop 的 network:any 权限还没确认，到插件管理里升级并确认" {
		t.Fatalf("没确认时 http 节点要失败：%v", got)
	}
	if hits.Load() != 0 {
		t.Fatalf("没确认不能出网，对方收到 %d 次", hits.Load())
	}

	if err := r.Upgrade(context.Background(), "sop", sopPerms); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	// 升级后插件重新注册，旧引擎已停；重试这一步走新注册的路由
	if code, out := act(t, h, rid, `{"kind":"retry","step":"h"}`); code != 200 {
		t.Fatalf("重试 %d %s", code, errMsg(out))
	}
	run = waitStatus(t, h, rid, "done")
	if res := step(run, "h")["output"].(map[string]any)["http"].(map[string]any); res["status"] != float64(200) || hits.Load() != 1 {
		t.Fatalf("确认后要真发请求：%v hits=%d", res, hits.Load())
	}
}

// 写进项目目录要 fs:write:project：升级后没确认之前这一步失败，不碰磁盘
func TestLocalAppendNeedsConfirmedWrite(t *testing.T) {
	_, h := setupStale(t)
	id := newFlow(t, h, `{"name":"写目录","steps":[{"key":"w","name":"写","kind":"local_append","after":[],"config":{"project":"Octok","path":"a.md","content":"x"}}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	run := waitStatus(t, h, rid, "failed")
	if got := step(run, "w")["error"]; got != "插件 sop 的 fs:write:project 权限还没确认，到插件管理里升级并确认" {
		t.Fatalf("没确认时要失败：%v", got)
	}
}
