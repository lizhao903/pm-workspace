// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
)

func TestStateRoundTrip(t *testing.T) {
	d := newTestDB(t, false)
	h := newTestHost(t, Options{DB: d})
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Millisecond)
	row := &stateRow{
		ID:            "hello_world",
		Name:          "Hello World",
		Version:       "0.1.0",
		Description:   "测试",
		SourceType:    "dir",
		SourceRef:     "/tmp/pkg",
		PackageSHA256: "abc",
		InstallDir:    "/tmp/install",
		ManifestJSON:  `{"manifest_version":2,"id":"hello_world","name":"Hello World","version":"0.1.0","api":">=2.0.0 <3.0.0","pmw":">=0.3.0 <1.0.0","license":"MIT","repository":"https://github.com/o/r","permissions":[],"permissions_reason":{},"runtime":{"web":{"entry":"web/entry.js"}}}`,
		Permissions:   []string{"objects:read"},
		Granted:       []string{"objects:read"},
		Enabled:       true,
		InstalledAt:   now,
		UpdatedAt:     now,
	}
	if err := h.saveState(ctx, row); err != nil {
		t.Fatalf("保存状态失败：%v", err)
	}

	got, err := h.loadState(ctx, "hello_world")
	if err != nil {
		t.Fatalf("读取状态失败：%v", err)
	}
	if got.ID != row.ID || got.Version != row.Version || !got.Enabled {
		t.Fatalf("读回的状态不对：%+v", got)
	}
	if len(got.Granted) != 1 || got.Granted[0] != "objects:read" {
		t.Fatalf("granted 不对：%+v", got.Granted)
	}
	if !got.InstalledAt.Equal(now) {
		t.Fatalf("安装时间不对：%v != %v", got.InstalledAt, now)
	}

	info := h.infoFromRow(got)
	if info.ID != "hello_world" || info.Source.Path != "/tmp/pkg" || info.WebEntry != "web/entry.js" {
		t.Fatalf("Info 组装不对：%+v", info)
	}

	// 更新 enabled / last_error。
	if err := h.setEnabled(ctx, "hello_world", false); err != nil {
		t.Fatal(err)
	}
	if err := h.setLastError(ctx, "hello_world", "启动失败"); err != nil {
		t.Fatal(err)
	}
	got, _ = h.loadState(ctx, "hello_world")
	if got.Enabled || got.LastError != "启动失败" {
		t.Fatalf("状态更新失败：%+v", got)
	}
	if list, err := h.listState(ctx); err != nil || len(list) != 1 {
		t.Fatalf("列表不对：%v %d", err, len(list))
	}

	if err := h.deleteState(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.loadState(ctx, "hello_world"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后应 ErrNotFound：%v", err)
	}
}

func TestStateNilDB(t *testing.T) {
	h := New(Options{DataDir: t.TempDir(), Logger: quietLogger()})
	if list := h.List(); len(list) != 0 {
		t.Fatalf("没有状态库时 List 应为空：%+v", list)
	}
	if _, err := h.Get("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("没有状态库时 Get 应 ErrNotFound：%v", err)
	}
	if err := h.setEnabled(context.Background(), "x", true); err != nil {
		t.Fatalf("没有状态库时 setEnabled 应静默成功：%v", err)
	}
}

func TestStateMissingTable(t *testing.T) {
	d, err := db.Open(t.TempDir() + "/pm.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	h := newTestHost(t, Options{DB: d})
	if list := h.List(); len(list) != 0 {
		t.Fatalf("表不存在时 List 应为空：%+v", list)
	}
	if _, err := h.Get("x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("表不存在时 Get 应 ErrNotFound：%v", err)
	}
}
