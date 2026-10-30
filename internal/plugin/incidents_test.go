package plugin_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// fakeIncidents 记下收到的运行异常。
type fakeIncidents struct {
	mu  sync.Mutex
	got []incident.Report
}

func (f *fakeIncidents) Record(_ context.Context, r incident.Report) (*incident.Incident, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, r)
	return &incident.Incident{ID: "inc_x"}, nil
}

// TestIncidentsRecordAsPlugin：来源记 plugin:<id>，级别空记 error，指纹必填；没接上回 ErrNoIncidents。
func TestIncidentsRecordAsPlugin(t *testing.T) {
	ctx := context.Background()
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)
	installEnable(t, r, "demo")
	in := plugin.Incident{Fingerprint: "demo:x:fail", Module: "SOP", Title: "失败了", Context: map[string]any{"步骤": "发送"}}
	if err := demo.RecordIncident(ctx, in); !errors.Is(err, plugin.ErrNoIncidents) {
		t.Fatalf("没接上 = %v", err)
	}
	f := &fakeIncidents{}
	r.SetIncidents(f)
	if err := demo.RecordIncident(ctx, in); err != nil {
		t.Fatal(err)
	}
	if err := demo.RecordIncident(ctx, plugin.Incident{Module: "SOP", Title: "没指纹"}); err == nil {
		t.Fatal("没有指纹应当被拒")
	}
	if len(f.got) != 1 {
		t.Fatalf("got %d", len(f.got))
	}
	if g := f.got[0]; g.Source != "plugin:demo" || g.Level != "error" || g.Fingerprint != "demo:x:fail" || g.Context["步骤"] != "发送" {
		t.Fatalf("记下的 = %+v", g)
	}
}

// TestClaudeCodeFailureRecordsIncident：插件交给 Claude Code 的运行失败记运行异常，来源 plugin:<id>；成功的不记。
func TestClaudeCodeFailureRecordsIncident(t *testing.T) {
	ctx := context.Background()
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)
	installEnable(t, r, "demo")
	f := &fakeIncidents{}
	r.SetIncidents(f)
	bad := filepath.Join(t.TempDir(), "bad-claude")
	if err := os.WriteFile(bad, []byte("#!/bin/sh\necho '鉴权失败' >&2\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.SetClaudeRunner(&runner.Runner{Bin: bad})
	runs, err := demo.Runs()
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if info := finished(t, demo, id); info.Status != plugin.RunFailed {
		t.Fatalf("应当失败：%+v", info)
	}
	r.SetClaudeRunner(&runner.Runner{Bin: fakeClaudeBin(t)})
	id2, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{Workdir: wd, Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	finished(t, demo, id2)
	if !r.WaitRuns(10 * time.Second) {
		t.Fatal("运行没收完")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.got) != 1 {
		t.Fatalf("只有失败的该记：%+v", f.got)
	}
	g := f.got[0]
	if g.Fingerprint != "claude:demo:failed" || g.Module != "Claude Code" || g.Source != "plugin:demo" || g.Level != "error" ||
		g.Context["执行 id"] != id || !strings.Contains(g.Message+g.Stack, "鉴权失败") {
		t.Fatalf("记下的 = %+v", g)
	}
}
