// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// fakeNotifier 记下收到的通知。
type fakeNotifier struct {
	mu  sync.Mutex
	got []plugin.Notification
}

func (f *fakeNotifier) NotifyFromPlugin(_ context.Context, n plugin.Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, n)
	return nil
}

// TestNotifyPrefixesKindAndFollowsState：kind 补插件前缀、来源记插件 id；没接通知中心、没在跑都发不出去。
func TestNotifyPrefixesKindAndFollowsState(t *testing.T) {
	ctx := context.Background()
	demo := plugintest.NewDemo(time.Hour)
	r := newRegistry(t, plugin.NewMemStateStore(), demo)
	installEnable(t, r, "demo")
	n := plugin.Notification{Kind: "publish_failed", Title: "发布失败", Data: map[string]any{"source": "kernel", "x": 1}}
	if err := demo.Notify(ctx, n); !errors.Is(err, plugin.ErrNoNotifier) {
		t.Fatalf("没接通知中心 = %v", err)
	}
	f := &fakeNotifier{}
	r.SetNotifier(f)
	if err := demo.Notify(ctx, n); err != nil {
		t.Fatal(err)
	}
	// 已带本插件前缀的不重复加
	if err := demo.Notify(ctx, plugin.Notification{Kind: "demo.alert", Level: plugin.NotifyError, Title: "提醒"}); err != nil {
		t.Fatal(err)
	}
	if len(f.got) != 2 {
		t.Fatalf("got %d", len(f.got))
	}
	a, b := f.got[0], f.got[1]
	if a.Kind != "demo.publish_failed" || a.Level != plugin.NotifyInfo || a.Data["source"] != "demo" || a.Data["x"] != 1 {
		t.Fatalf("第一条 = %+v", a)
	}
	if n.Data["source"] != "kernel" {
		t.Fatal("改了插件传进来的 Data")
	}
	if b.Kind != "demo.alert" || b.Level != plugin.NotifyError || b.Data["source"] != "demo" {
		t.Fatalf("第二条 = %+v", b)
	}

	for _, bad := range []plugin.Notification{
		{Kind: "", Title: "t"},
		{Kind: "Bad Kind", Title: "t"},
		{Kind: "x", Title: " "},
		{Kind: "x", Title: "t", Level: "warn"},
	} {
		if err := demo.Notify(ctx, bad); err == nil {
			t.Fatalf("%+v 应当被拒", bad)
		}
	}
	// 想冒充内核的 kind 也只会落在本插件前缀下
	if err := demo.Notify(ctx, plugin.Notification{Kind: "task.review_requested", Title: "t"}); err != nil {
		t.Fatal(err)
	}
	if got := f.got[len(f.got)-1].Kind; got != "demo.task.review_requested" {
		t.Fatalf("kind = %s", got)
	}

	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if err := demo.Notify(ctx, n); !errors.Is(err, plugin.ErrNotifyInactive) {
		t.Fatalf("停用后 = %v", err)
	}
	if len(f.got) != 3 {
		t.Fatalf("停用后多发了：%d", len(f.got))
	}
}

// TestNotifyRejectsKernelNamespaceID：插件 id 是内核事件的命名空间（task、run）时一律不让发，免得拼出内核的 kind。
func TestNotifyRejectsKernelNamespaceID(t *testing.T) {
	ctx := context.Background()
	var cv atomic.Value
	r := newRegistry(t, plugin.NewMemStateStore(), sopProbe(t, "task", &cv), sopProbe(t, "run", &atomic.Value{}))
	f := &fakeNotifier{}
	r.SetNotifier(f)
	installEnable(t, r, "task")
	c := cv.Load().(plugin.Core)
	for _, kind := range []string{"review_requested", "other"} {
		if err := c.Notify(ctx, plugin.Notification{Kind: kind, Title: "t"}); err == nil {
			t.Fatalf("task 插件发 %s 应当被拒", kind)
		}
	}
	if len(f.got) != 0 {
		t.Fatalf("got %+v", f.got)
	}
}
