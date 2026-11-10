// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// 插件节点（SOP-03a）：示例插件登记的 demo_wait_reply 出现在目录里、能执行、挂起后重启再唤醒、停用后执行失败。

type world struct {
	r    *plugin.Registry
	h    http.Handler
	demo *plugintest.Demo
}

// bootWith 在 d 上起 SOP 插件和示例插件；fresh 为真时装好、启用两个插件。
func bootWith(t *testing.T, d *db.DB, fresh bool) world {
	t.Helper()
	ctx := context.Background()
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	demo := plugintest.NewDemo(time.Hour)
	for _, p := range []plugin.Plugin{New(), demo} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if fresh {
		if err := r.Install(ctx, "sop", sopPerms); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, "sop"); err != nil {
			t.Fatal(err)
		}
		if err := r.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, "demo"); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return world{r, mux, demo}
}

func openDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}

func nodeKinds(t *testing.T, h http.Handler) map[string]map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/node-types", "")
	if code != 200 {
		t.Fatal(code)
	}
	got := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		got[m["kind"].(string)] = m
	}
	if out["meta"].(map[string]any)["total"] != float64(len(out["data"].([]any))) {
		t.Fatalf("meta.total 对不上：%v", out["meta"])
	}
	return got
}

func TestPluginNodeTypesFollowEnabledState(t *testing.T) {
	ctx := context.Background()
	w := bootWith(t, openDB(t), true)
	defer w.r.Close()
	got := nodeKinds(t, w.h)
	n := got[plugintest.SOPNodeKind]
	if n == nil || n["source"] != "demo" || n["group"] != "示例" || len(n["required"].([]any)) != 1 {
		t.Fatalf("启用后应当有示例节点：%v", n)
	}
	if got["template"]["source"] != "builtin" || len(got) != len(NodeTypes)+1 {
		t.Fatalf("内置的 source 应当是 builtin，共 %d 种：%v", len(got), got["template"])
	}
	// 必填项按插件登记的查
	code, out := call(t, w.h, "POST", "/api/sop/flows", `{"name":"缺配置","steps":[{"key":"a","name":"等回复","kind":"demo_wait_reply"}]}`)
	if code != 400 || errMsg(out) != "「等回复」还没填「发给」" {
		t.Fatalf("缺必填项：%d %s", code, errMsg(out))
	}
	if err := w.r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if got := nodeKinds(t, w.h); got[plugintest.SOPNodeKind] != nil || len(got) != len(NodeTypes) {
		t.Fatalf("停用后不该有示例节点：%d 种", len(got))
	}
	// 停用了也能保存用到它的流程（流程定义不动，执行时才失败）；没人声明的 kind 照样拦
	if code, out := call(t, w.h, "POST", "/api/sop/flows", `{"name":"停用中","steps":[{"key":"a","name":"等回复","kind":"demo_wait_reply"}]}`); code != 201 {
		t.Fatalf("停用中保存 %d %s", code, errMsg(out))
	}
	if code, out := call(t, w.h, "POST", "/api/sop/flows", `{"name":"乱写","steps":[{"key":"a","name":"甲","kind":"nobody_x"}]}`); code != 400 || errMsg(out) != "「甲」的类型 nobody_x 不存在" {
		t.Fatalf("没人声明的类型：%d %s", code, errMsg(out))
	}
}

func TestPluginNodeRunsAndFailsWhenDisabled(t *testing.T) {
	ctx := context.Background()
	w := bootWith(t, openDB(t), true)
	defer w.r.Close()
	flowBody := `{"name":"插件节点","fields":[{"key":"who","label":"谁","type":"text"}],"steps":[
		{"key":"a","name":"发出去","kind":"demo_wait_reply","config":{"to":"{{who}}"}},
		{"key":"z","name":"收尾","kind":"auto"}]}`
	id := newFlow(t, w.h, flowBody)
	run := waitStatus(t, w.h, startRun(t, w.h, id, `{"input":{"who":"甲"}}`)["id"].(string), "done")
	a := step(run, "a")
	out := a["output"].(map[string]any)
	if out["to"] != "{{who}}" || out["input"].(map[string]any)["who"] != "甲" {
		t.Fatalf("插件节点输出：%v", out)
	}
	if err := w.r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	run = waitStatus(t, w.h, startRun(t, w.h, id, `{"input":{"who":"乙"}}`)["id"].(string), "failed")
	if a := step(run, "a"); a["status"] != "failed" || a["error"] != "提供这个节点的插件已停用" {
		t.Fatalf("停用后执行：%v %v", a["status"], a["error"])
	}
	// 流程定义不动
	code, got := call(t, w.h, "GET", "/api/sop/flows/"+id, "")
	if code != 200 || !strings.Contains(string(mustJSON(t, got["data"].(map[string]any)["steps"])), "demo_wait_reply") || got["data"].(map[string]any)["version"] != float64(1) {
		t.Fatalf("流程定义被动了：%v", got["data"])
	}
}

func TestPluginNodeWaitsAcrossRestart(t *testing.T) {
	ctx := context.Background()
	d := openDB(t)
	w1 := bootWith(t, d, true)
	id := newFlow(t, w1.h, `{"name":"等回复","steps":[
		{"key":"ask","name":"问一下","kind":"demo_wait_reply","config":{"to":"甲","mode":"wait"}},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	rid := startRun(t, w1.h, id, `{}`)["id"].(string)
	var before map[string]any
	waitFor(t, "插件节点挂起", func() bool {
		before = getRun(t, w1.h, rid)
		return hasLog(step(before, "ask"), "等插件唤醒")
	})
	ask := step(before, "ask")
	if ask["status"] != "running" || before["status"] != "running" || !hasLog(ask, "挂起：等 甲 回复") {
		t.Fatalf("挂起后：%v %v %v", ask["status"], before["status"], ask["log"])
	}
	if in, _ := w1.demo.Waiting.Load().(plugin.SOPNodeInput); in.RunID != rid || in.Step != "ask" || in.Attempt != 1 || in.FlowID != id {
		t.Fatalf("Run 拿到的上下文：%+v", in)
	}
	// 不是自己提供的节点不能唤醒；没在等的步骤不能唤醒
	if err := w1.demo.Resume(ctx, rid, "z", nil); err == nil || !strings.Contains(err.Error(), "没在等唤醒") {
		t.Fatalf("唤醒没在等的步骤：%v", err)
	}
	w1.r.Close()

	w2 := bootWith(t, d, false)
	defer w2.r.Close()
	var after map[string]any
	waitFor(t, "重启后接着调度", func() bool {
		after = getRun(t, w2.h, rid)
		return hasLog(step(after, "ask"), "服务重启后")
	})
	ask = step(after, "ask")
	if ask["status"] != "running" || ask["attempts"] != float64(1) || !hasLog(ask, "服务重启后继续等插件唤醒") {
		t.Fatalf("重启后应当接着等，不重跑：%v attempts=%v log=%v", ask["status"], ask["attempts"], ask["log"])
	}
	if w2.demo.Waiting.Load() != nil {
		t.Fatal("重启后不该再调 Run")
	}
	if err := w2.demo.Resume(ctx, "nope", "ask", nil); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("唤醒不存在的执行：%v", err)
	}
	if err := w2.demo.Resume(ctx, rid, "ask", map[string]any{"reply": "好的"}); err != nil {
		t.Fatalf("唤醒：%v", err)
	}
	done := waitStatus(t, w2.h, rid, "done")
	ask = step(done, "ask")
	if ask["output"].(map[string]any)["reply"] != "好的" || !hasLog(ask, "插件 demo 唤醒") {
		t.Fatalf("唤醒后的输出：%v", ask)
	}
	if err := w2.demo.Resume(ctx, rid, "ask", nil); err == nil || err.Error() != "这次执行已经结束" {
		t.Fatalf("结束后再唤醒：%v", err)
	}
}

// TestResumeOnlyByProvider：别的插件不能唤醒示例插件的节点。
func TestResumeOnlyByProvider(t *testing.T) {
	ctx := context.Background()
	d := openDB(t)
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	other := &probe{}
	for _, p := range []plugin.Plugin{New(), plugintest.NewDemo(time.Hour), other} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for id, perms := range map[string][]string{"sop": sopPerms, "demo": {"network:localhost"}} {
		if err := r.Install(ctx, id, perms); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	id := newFlow(t, mux, `{"name":"等回复","steps":[{"key":"ask","name":"问一下","kind":"demo_wait_reply","config":{"to":"甲","mode":"wait"}}]}`)
	rid := startRun(t, mux, id, `{}`)["id"].(string)
	waitFor(t, "插件节点挂起", func() bool { return hasLog(step(getRun(t, mux, rid), "ask"), "等插件唤醒") })
	if err := other.c.SOP().Resume(ctx, rid, "ask", nil); err == nil || err.Error() != "步骤 ask 的节点 demo_wait_reply 不是插件 other 提供的" {
		t.Fatalf("冒名唤醒：%v", err)
	}
	if s := step(getRun(t, mux, rid), "ask"); s["status"] != "running" {
		t.Fatalf("冒名唤醒后状态变了：%v", s["status"])
	}
}

// probe 是只为拿到 Core 的插件，不用装也不用启用。
type probe struct{ c plugin.Core }

func (p *probe) Manifest() plugin.Manifest {
	return plugin.MustParse([]byte(`{"id":"other","name":"other","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":[]}`))
}
func (p *probe) Migrations() fs.FS { return nil }
func (p *probe) Register(r plugin.Registrar) error {
	p.c = r.Core()
	return nil
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
