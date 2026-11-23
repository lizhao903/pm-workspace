// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// fakeBus 模拟 internal/events.Bus：Tap 收集订阅者，Publish 记录并分发给订阅者。
type fakeBus struct {
	mu        sync.Mutex
	taps      []func(plugin.Event)
	published []plugin.Event
}

func (b *fakeBus) Tap(fn func(plugin.Event)) (cancel func()) {
	b.mu.Lock()
	b.taps = append(b.taps, fn)
	idx := len(b.taps) - 1
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		if idx < len(b.taps) {
			b.taps[idx] = nil
		}
		b.mu.Unlock()
	}
}

func (b *fakeBus) Publish(_ context.Context, eventType string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ev := plugin.Event{Type: eventType, At: time.Now(), Payload: raw}
	b.mu.Lock()
	b.published = append(b.published, ev)
	taps := append([]func(plugin.Event){}, b.taps...)
	b.mu.Unlock()
	for _, fn := range taps {
		if fn != nil {
			fn(ev)
		}
	}
	return nil
}

func (b *fakeBus) emit(ev plugin.Event) {
	b.mu.Lock()
	taps := append([]func(plugin.Event){}, b.taps...)
	b.mu.Unlock()
	for _, fn := range taps {
		if fn != nil {
			fn(ev)
		}
	}
}

func (b *fakeBus) publishedTypes() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.published))
	for _, ev := range b.published {
		out = append(out, ev.Type)
	}
	return out
}

func eventTestPackage(t *testing.T, dir string) {
	t.Helper()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	obj["permissions"] = []any{"objects:read", "notify", "events:subscribe"}
	obj["permissions_reason"] = map[string]any{
		"objects:read":     "读对象",
		"notify":           "发通知",
		"events:subscribe": "订阅内核对象事件",
	}
	obj["subscribes"] = []any{"object.created"}
	obj["emits"] = []any{"hello_world.ping"}
	writeTestPackage(t, dir, obj)
}

func TestKernelEventDeliveredToSubscribers(t *testing.T) {
	dir := t.TempDir()
	eventTestPackage(t, dir)
	bus := &fakeBus{}
	h, getFake := newFakeHost(t, Options{Events: bus})
	t.Cleanup(h.Close)
	ctx := context.Background()
	if err := h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify", "events:subscribe"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	bus.emit(plugin.Event{Type: "object.created", At: time.Now(), Payload: json.RawMessage(`{"id":"obj_1"}`)})
	fake := getFake()
	select {
	case got := <-fake.events:
		ev, _ := got["event"].(map[string]any)
		if ev["type"] != "object.created" {
			t.Fatalf("投递的事件不对：%v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("订阅的内核事件没有投递给插件")
	}
	// 没订阅的事件不投递。
	bus.emit(plugin.Event{Type: "run.finished", At: time.Now(), Payload: json.RawMessage(`{}`)})
	select {
	case got := <-fake.events:
		t.Fatalf("未订阅的事件不应投递：%v", got)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestPluginPublishEvent(t *testing.T) {
	dir := t.TempDir()
	eventTestPackage(t, dir)
	bus := &fakeBus{}
	h, _ := newFakeHost(t, Options{Events: bus})
	t.Cleanup(h.Close)
	ctx := context.Background()
	if err := h.Start(ctx); err != nil {
		t.Fatal(err)
	}
	installTestPlugin, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify", "events:subscribe"})
	if err != nil {
		t.Fatal(err)
	}
	_ = installTestPlugin
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}
	if _, err := p.handleHostCall(ctx, "host.events.publish", json.RawMessage(`{"type":"hello_world.ping","payload":{"n":1}}`)); err != nil {
		t.Fatalf("发布声明过的事件失败：%v", err)
	}
	if got := bus.publishedTypes(); len(got) != 1 || got[0] != "hello_world.ping" {
		t.Fatalf("发布事件不对：%v", got)
	}
	if _, err := p.handleHostCall(ctx, "host.events.publish", json.RawMessage(`{"type":"other.thing"}`)); err == nil {
		t.Fatal("未声明的事件应被拒绝")
	}
}

func TestEventsUnavailableWithoutBus(t *testing.T) {
	dir := t.TempDir()
	eventTestPackage(t, dir)
	h, _ := newFakeHost(t, Options{})
	t.Cleanup(h.Close)
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, []string{"objects:read", "notify", "events:subscribe"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}
	if _, err := p.handleHostCall(ctx, "host.events.publish", json.RawMessage(`{"type":"hello_world.ping"}`)); err == nil {
		t.Fatal("没有事件总线时应回 unavailable")
	}
}
