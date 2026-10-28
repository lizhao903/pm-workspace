package events_test

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

var quiet = slog.New(slog.DiscardHandler)

// testPlugin 订阅清单里写的全部事件，处理函数由 handle 决定。
type testPlugin struct {
	m      plugin.Manifest
	handle func(e plugin.Event) error
	core   plugin.Core
}

func (p *testPlugin) Manifest() plugin.Manifest { return p.m }
func (p *testPlugin) Migrations() fs.FS         { return nil }
func (p *testPlugin) Register(r plugin.Registrar) error {
	p.core = r.Core()
	for _, typ := range p.m.Subscribes {
		r.Subscribe(typ, func(_ context.Context, _ plugin.Core, e plugin.Event) error { return p.handle(e) })
	}
	return nil
}

func newPlugin(t *testing.T, id, extra string, handle func(e plugin.Event) error) *testPlugin {
	t.Helper()
	js := `{"id":"` + id + `","name":"` + id + `","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":[]` + extra + `}`
	m, err := plugin.Parse([]byte(js))
	if err != nil {
		t.Fatalf("manifest %s: %v", id, err)
	}
	return &testPlugin{m: *m, handle: handle}
}

// recorder 记下收到的事件。
type recorder struct {
	mu  sync.Mutex
	got []plugin.Event
}

func (r *recorder) handle(e plugin.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, e)
	return nil
}

func (r *recorder) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.got {
		out = append(out, e.Type)
	}
	return out
}

func (r *recorder) find(t *testing.T, typ string) map[string]any {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.got {
		if e.Type == typ {
			var m map[string]any
			if err := json.Unmarshal(e.Payload, &m); err != nil {
				t.Fatalf("payload of %s: %v", typ, err)
			}
			return m
		}
	}
	t.Fatalf("没收到 %s，收到的是 %v", typ, r.got)
	return nil
}

func (r *recorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = nil
}

// setup 起注册表并把插件全部装上、启用，再接上总线。
func setup(t *testing.T, ps ...plugin.Plugin) (*plugin.Registry, *events.Bus) {
	t.Helper()
	ctx := context.Background()
	reg := plugin.NewRegistry(plugin.NewMemStateStore(), quiet)
	bus := events.New(reg, quiet)
	reg.Events = bus
	for _, p := range ps {
		if err := reg.Add(p); err != nil {
			t.Fatalf("add: %v", err)
		}
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(reg.Close)
	for _, p := range ps {
		id := p.Manifest().ID
		if err := reg.Install(ctx, id, nil); err != nil {
			t.Fatalf("install %s: %v", id, err)
		}
		if err := reg.Enable(ctx, id); err != nil {
			t.Fatalf("enable %s: %v", id, err)
		}
	}
	return reg, bus
}

func wait(t *testing.T, bus *events.Bus) {
	t.Helper()
	if !bus.Wait(2 * time.Second) {
		t.Fatal("订阅者没处理完")
	}
}

const subAll = `,"subscribes":["object.created","object.updated","object.status_changed","task.review_requested","run.finished"]`

// TestSubscriberPanicIsolated：一个订阅者 panic、一个出错、一个卡住，另一个照样收到，发布方立刻返回。
func TestSubscriberPanicIsolated(t *testing.T) {
	rec := &recorder{}
	release := make(chan struct{})
	_, bus := setup(t,
		newPlugin(t, "boom", subAll, func(plugin.Event) error { panic("boom") }),
		newPlugin(t, "fail", subAll, func(plugin.Event) error { return errors.New("fail") }),
		newPlugin(t, "slow", subAll, func(plugin.Event) error { <-release; return nil }),
		newPlugin(t, "rec", subAll, rec.handle),
	)

	start := time.Now()
	for range 3 {
		if err := bus.Publish(context.Background(), events.ObjectCreated, map[string]any{"id": "obj_1"}); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("Publish 被订阅者拖住了：%v", d)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(rec.types()) < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("其它订阅者 panic 后正常订阅者只收到 %d 条", len(rec.types()))
		}
		time.Sleep(2 * time.Millisecond)
	}
	if bus.Wait(20 * time.Millisecond) {
		t.Fatal("slow 还卡着，Wait 不该返回 true")
	}
	close(release)
	wait(t, bus)
}

// TestDisabledPluginStopsReceiving：停用后不再收到，包括停用前已经取到订阅、停用后才送的那条；重新启用恢复。
func TestDisabledPluginStopsReceiving(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{}
	reg, bus := setup(t, newPlugin(t, "rec", subAll, rec.handle))

	_ = bus.Publish(ctx, events.ObjectCreated, map[string]any{"id": "a"})
	wait(t, bus)
	if n := len(rec.types()); n != 1 {
		t.Fatalf("启用时收到 %d 条，要 1", n)
	}

	stale := reg.Subscribers(events.ObjectCreated)
	if err := reg.Disable(ctx, "rec"); err != nil {
		t.Fatalf("disable: %v", err)
	}
	_ = bus.Publish(ctx, events.ObjectCreated, map[string]any{"id": "b"})
	wait(t, bus)
	for _, s := range stale {
		_ = s.Handle(ctx, plugin.Event{Type: events.ObjectCreated})
	}
	if n := len(rec.types()); n != 1 {
		t.Fatalf("停用后还收到了事件：共 %d 条", n)
	}

	if err := reg.Enable(ctx, "rec"); err != nil {
		t.Fatalf("enable: %v", err)
	}
	_ = bus.Publish(ctx, events.ObjectCreated, map[string]any{"id": "c"})
	wait(t, bus)
	if n := len(rec.types()); n != 2 {
		t.Fatalf("重新启用后收到 %d 条，要 2", n)
	}
}

// TestPluginPublish：插件只能发清单 emits 里的事件，别的插件订阅得到。
func TestPluginPublish(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{}
	src := newPlugin(t, "src", `,"emits":["src.ping"]`, nil)
	_, bus := setup(t, src, newPlugin(t, "rec", `,"optional_depends":{"src":">=0.1.0"},"subscribes":["src.ping"]`, rec.handle))

	if err := src.core.Events().Publish(ctx, "src.pong", nil); !errors.Is(err, plugin.ErrEventNotDeclared) {
		t.Fatalf("发没声明的事件 err = %v，要 ErrEventNotDeclared", err)
	}
	if err := src.core.Events().Publish(ctx, "src.ping", map[string]int{"n": 1}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	wait(t, bus)
	if got := rec.find(t, "src.ping"); got["n"] != float64(1) {
		t.Fatalf("payload = %v", got)
	}
}

func newStore(t *testing.T, bus *events.Bus) (store.Store, *sqlite.Store) {
	t.Helper()
	raw, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "workspace.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	return events.WrapStore(raw, bus), raw
}

func pstr(s string) *string { return &s }

// TestStorePublishesAfterWrite：各写方法成功后发对应的内核事件，载荷和 docs/plugin-api.md 2.10 一致。
func TestStorePublishesAfterWrite(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{}
	_, bus := setup(t, newPlugin(t, "rec", subAll, rec.handle))
	st, _ := newStore(t, bus)

	o, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "事件"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.find(t, events.ObjectCreated); got["id"] != o.ID || got["type_id"] != "task" {
		t.Fatalf("object.created = %v", got)
	}

	rec.reset()
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: pstr("事件 2"), Status: pstr("doing"), Body: pstr("")}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	upd := rec.find(t, events.ObjectUpdated)
	if f, _ := json.Marshal(upd["fields"]); string(f) != `["title","status"]` {
		t.Fatalf("object.updated fields = %s，要只有真变了的 title、status", f)
	}
	if got := rec.find(t, events.ObjectStatusChanged); got["from"] != "todo" || got["to"] != "doing" || got["id"] != o.ID {
		t.Fatalf("object.status_changed = %v", got)
	}

	// 什么都没变：不发
	rec.reset()
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: pstr("事件 2")}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.types(); len(got) != 0 {
		t.Fatalf("没有字段变化却发了 %v", got)
	}

	rec.reset()
	if _, err := st.AppendProgress(ctx, o.ID, domain.ProgressInput{Kind: domain.ProgressReview, Text: "做完了", Status: "blocked"}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.find(t, events.TaskReviewRequested); got["id"] != o.ID {
		t.Fatalf("task.review_requested = %v", got)
	}
	if got := rec.find(t, events.ObjectStatusChanged); got["from"] != "doing" || got["to"] != "blocked" {
		t.Fatalf("提交验收顺带切状态：object.status_changed = %v", got)
	}

	// 普通进展：不发验收事件
	rec.reset()
	if _, err := st.AppendProgress(ctx, o.ID, domain.ProgressInput{Text: "记一笔"}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.types(); len(got) != 0 {
		t.Fatalf("普通进展发了 %v", got)
	}

	rec.reset()
	run, err := st.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: o.ID, Workdir: t.TempDir(), Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishTaskRun(ctx, run.ID, domain.RunDone, 0, "ok", ""); err != nil {
		t.Fatal(err)
	}
	wait(t, bus)
	if got := rec.find(t, events.RunFinished); got["run_id"] != run.ID || got["object_id"] != o.ID || got["ok"] != true {
		t.Fatalf("run.finished = %v", got)
	}
}

// failStore 的写方法一律失败，模拟事务回滚。
type failStore struct{ store.Store }

var errRollback = errors.New("rollback")

func (failStore) CreateObject(context.Context, *domain.Object, store.Actor) (*domain.Object, error) {
	return nil, errRollback
}

func (failStore) FinishTaskRun(context.Context, string, string, int, string, string) (*domain.TaskRun, error) {
	return nil, errRollback
}

// TestRollbackPublishesNothing：写失败、事务回滚时一条事件都不发。
func TestRollbackPublishesNothing(t *testing.T) {
	ctx := context.Background()
	rec := &recorder{}
	_, bus := setup(t, newPlugin(t, "rec", subAll, rec.handle))
	st, raw := newStore(t, bus)

	o, err := raw.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "回滚"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}

	// 提交验收时状态不合法：状态切换和进展在同一个事务里，整体回滚
	if _, err := st.AppendProgress(ctx, o.ID, domain.ProgressInput{Kind: domain.ProgressReview, Text: "x", Status: "no-such-status"}, store.DefaultActor); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v，要校验错误", err)
	}
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Title: pstr(" "), Status: pstr("doing")}, store.DefaultActor); err == nil {
		t.Fatal("空标题应该失败")
	}
	if _, err := st.UpdateObject(ctx, "obj_missing", domain.ObjectPatch{Status: pstr("doing")}, store.DefaultActor); err == nil {
		t.Fatal("不存在的对象应该失败")
	}
	if _, err := st.ClaimObject(ctx, o.ID, domain.ClaimInput{OwnerID: "sh_missing"}, store.DefaultActor); err == nil {
		t.Fatal("不存在的负责人应该失败")
	}
	failing := events.WrapStore(failStore{raw}, bus)
	if _, err := failing.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "x"}, store.DefaultActor); !errors.Is(err, errRollback) {
		t.Fatalf("err = %v", err)
	}
	if _, err := failing.FinishTaskRun(ctx, "run_x", domain.RunDone, 0, "", ""); !errors.Is(err, errRollback) {
		t.Fatalf("err = %v", err)
	}
	wait(t, bus)
	if got := rec.types(); len(got) != 0 {
		t.Fatalf("写失败却发了 %v", got)
	}
	if cur, _ := raw.GetObject(ctx, o.ID); cur.Status != "todo" {
		t.Fatalf("回滚后状态 = %s，要 todo", cur.Status)
	}
}
