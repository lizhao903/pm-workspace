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
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 任务关联来源消息（sop 0.23.0）：task 节点把来源消息记进 source_ref、发 sop.task_created；历史任务按执行记录回填。

// eventRec 记下插件发的事件（代替事件总线）。
type eventRec struct {
	mu  sync.Mutex
	evs []TaskCreated
}

func (r *eventRec) Publish(_ context.Context, typ string, payload any) error {
	if typ != EventTaskCreated {
		return nil
	}
	raw, _ := json.Marshal(payload)
	var p TaskCreated
	_ = json.Unmarshal(raw, &p)
	r.mu.Lock()
	r.evs = append(r.evs, p)
	r.mu.Unlock()
	return nil
}

func (r *eventRec) take() []TaskCreated {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.evs
	r.evs = nil
	return out
}

// fakeIM 只登记读取消息节点：消息 id 取配置，再没有取输入的 message_id，输出 message.id。
type fakeIM struct{}

func (fakeIM) Manifest() plugin.Manifest {
	return plugin.MustParse([]byte(`{"id":"im","name":"im","version":"0.32.0","core":">=1.0.0 <2.0.0",
		"provides":{"sop_nodes":["im_get_message"]},"permissions":[]}`))
}
func (fakeIM) Migrations() fs.FS { return nil }
func (fakeIM) Register(r plugin.Registrar) error {
	r.SOPNode(plugin.SOPNodeDef{Kind: imGetMessageKind, Run: func(_ context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
		id := n.Config["message"]
		if id == "" {
			id, _ = n.Input["message_id"].(string)
		}
		return with(n.Input, "message", map[string]any{"id": id, "text": "登录页打不开"}), nil
	}})
	return nil
}

func TestTaskNodeLinksMessages(t *testing.T) {
	ctx := context.Background()
	old := messageTasksDelay
	messageTasksDelay = 300 * time.Millisecond
	t.Cleanup(func() { messageTasksDelay = old })
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	r.SetObjectCreator(st)
	rec := &eventRec{}
	r.Events = rec
	for _, p := range []plugin.Plugin{fakeIM{}, New()} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for id, perms := range map[string][]string{"im": nil, "sop": sopPerms} {
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
	var h http.Handler = mux
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := st.DB().R.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// 启用后自动回填一次（这时还没有执行，发 0 条），记下标记，之后不再自动跑
	waitFor(t, "自动回填记下标记", func() bool {
		return count(`SELECT count(*) FROM sop_settings WHERE key = ?`, messageTasksKey) == 1
	})
	srcRef := func(id string) map[string]any {
		t.Helper()
		o, err := st.GetObject(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		ref, _ := o.Props["source_ref"].(map[string]any)
		return ref
	}
	taskOf := func(run map[string]any, key string) string {
		return step(run, key)["output"].(map[string]any)["task"].(map[string]any)["id"].(string)
	}

	// 1. 输入带 message_id（IM 触发）：来源记这条，事件带上
	f1 := newFlow(t, h, `{"name":"IM 建任务","fields":[{"key":"message_id","label":"消息","type":"text"},{"key":"message_ids","label":"一组消息","type":"text"}],"steps":[{"key":"get","name":"读消息","kind":"im_get_message","after":[],"config":{}},
		{"key":"t","name":"建任务","kind":"task","after":["get"],"config":{"title":"{{message.text}}"}}]}`)
	run1 := waitStatus(t, h, startRun(t, h, f1, `{"input":{"message_id":"msg_a","message_ids":"msg_a, msg_x"}}`)["id"].(string), "done")
	t1 := taskOf(run1, "t")
	ref := srcRef(t1)
	if ref["message_id"] != "msg_a" || len(ref["message_ids"].([]any)) != 1 || ref["message_ids"].([]any)[0] != "msg_x" {
		t.Fatalf("来源：%v", ref)
	}
	evs := rec.take()
	if len(evs) != 1 || evs[0].TaskID != t1 || evs[0].MessageID != "msg_a" || !slices.Equal(evs[0].MessageIDs, []string{"msg_x"}) ||
		evs[0].Backfill || evs[0].RunID != run1["id"] || evs[0].Step != "t" {
		t.Fatalf("事件：%+v", evs)
	}

	// 2. 输入没带 message_id、上游读取消息取出一条：来源记它，不按它去重（再跑一次另建一条）
	f2 := newFlow(t, h, `{"name":"按配置读消息","steps":[{"key":"get","name":"读消息","kind":"im_get_message","after":[],"config":{"message":"msg_b"}},
		{"key":"t","name":"建任务","kind":"task","after":["get"],"config":{"title":"跟进"}}]}`)
	run2 := waitStatus(t, h, startRun(t, h, f2, `{}`)["id"].(string), "done")
	t2 := taskOf(run2, "t")
	if srcRef(t2)["message_id"] != "msg_b" {
		t.Fatalf("上游消息：%v", srcRef(t2))
	}
	run2b := waitStatus(t, h, startRun(t, h, f2, `{}`)["id"].(string), "done")
	if taskOf(run2b, "t") == t2 {
		t.Fatal("上游取出的消息不该按它去重")
	}
	// 3. 没有消息：照常建，事件 message_id 为空
	f3 := newFlow(t, h, `{"name":"手动","steps":[{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"手动任务"}}]}`)
	run3 := waitStatus(t, h, startRun(t, h, f3, `{}`)["id"].(string), "done")
	if _, ok := srcRef(taskOf(run3, "t"))["message_id"]; ok {
		t.Fatalf("没有消息不该记：%v", srcRef(taskOf(run3, "t")))
	}
	rec.take()

	// 4. 历史回填：把第一条任务的来源改成 TSK-0411 之前的样子（没有 message_id），回填按执行记录补出来
	if _, err := st.DB().W.Exec(`UPDATE objects SET props = json_remove(props, '$.source_ref.message_id', '$.source_ref.message_ids') WHERE id = ?`, t1); err != nil {
		t.Fatal(err)
	}
	code, out := call(t, h, "POST", "/api/sop/maintenance/message-tasks", "")
	res, _ := out["data"].(map[string]any)
	if code != 200 || res["scanned"] != float64(4) || res["published"] != float64(3) || res["no_message"] != float64(1) || res["im_running"] != true {
		t.Fatalf("回填：%d %v", code, out)
	}
	evs = rec.take()
	i := slices.IndexFunc(evs, func(e TaskCreated) bool { return e.TaskID == t1 })
	if i < 0 || evs[i].MessageID != "msg_a" || !slices.Equal(evs[i].MessageIDs, []string{"msg_x"}) || !evs[i].Backfill || evs[i].RunID != run1["id"] {
		t.Fatalf("回填事件：%+v", evs)
	}
	// 回填不改任务；再跑一遍结果一样（幂等交给 IM 那边的 ON CONFLICT）
	if _, ok := srcRef(t1)["message_id"]; ok {
		t.Fatal("回填不该改任务")
	}
	// 任务不是这一步建的（删了、或步骤输出指着别的执行的任务）不发
	if err := st.DeleteObject(ctx, t2, false, store.Actor{Name: "me", Source: "ui"}); err != nil {
		t.Fatal(err)
	}
	if _, out = call(t, h, "POST", "/api/sop/maintenance/message-tasks", ""); out["data"].(map[string]any)["not_created_here"] != float64(1) {
		t.Fatalf("删了的任务：%v", out)
	}
	if count(`SELECT count(*) FROM sop_settings WHERE key = ?`, messageTasksKey) != 1 {
		t.Fatal("标记只记一次")
	}

	// IM 插件没在跑：409，不发
	if err := r.Disable(ctx, "im"); err != nil {
		t.Fatal(err)
	}
	rec.take()
	if code, _ := call(t, h, "POST", "/api/sop/maintenance/message-tasks", ""); code != 409 || len(rec.take()) != 0 {
		t.Fatalf("IM 没在跑应 409：%d", code)
	}
}

func TestMessageIDList(t *testing.T) {
	for _, c := range []struct {
		in   any
		want []string
	}{
		{[]any{"msg_1", " msg_2 ", "msg_1", 3, "p"}, []string{"msg_1", "msg_2"}},
		{"msg_1, msg_2，msg_3\np", []string{"msg_1", "msg_2", "msg_3"}},
		{nil, nil},
	} {
		if got := messageIDList(c.in, "p"); !slices.Equal(got, c.want) {
			t.Errorf("messageIDList(%v) = %v，应为 %v", c.in, got, c.want)
		}
	}
	if upstreamMessageID(Json{"message": map[string]any{"id": "cv_1"}}) != "" || upstreamMessageID(Json{"message": map[string]any{"id": "msg_1"}}) != "msg_1" {
		t.Error("上游消息 id 只认 msg_ 开头的")
	}
}
