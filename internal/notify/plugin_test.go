// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// TestNotificationFromPlugin：示例插件经 Core.Notify 发的通知进列表、推 notification.created；停用后发不了，已发的留着。
func TestNotificationFromPlugin(t *testing.T) {
	ctx := context.Background()
	_, c, stream := setup(t)
	sub := stream.Subscribe(stream.Last(), true)
	defer sub.Close()

	demo := plugintest.NewDemo(time.Hour)
	r := plugin.NewRegistry(plugin.NewMemStateStore(), quiet)
	if err := r.Add(demo); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	r.SetNotifier(c)
	if err := r.Install(ctx, "demo", demo.Manifest().Permissions); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}

	err := demo.Notify(ctx, plugin.Notification{Kind: "publish_failed", Level: plugin.NotifyError, Title: "发布失败", Body: "平台拒绝", ObjectID: "obj_1", Data: map[string]any{"platform": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	items, total, unread := list(t, c, notify.Filter{})
	if total != 1 || unread != 1 {
		t.Fatalf("total=%d unread=%d", total, unread)
	}
	n := items[0]
	if n.Kind != "demo.publish_failed" || n.Level != notify.LevelError || n.Title != "发布失败" || n.Body != "平台拒绝" ||
		n.ObjectID != "obj_1" || n.Data["source"] != "demo" || n.Data["platform"] != "x" {
		t.Fatalf("通知 = %+v", n)
	}
	var created []notify.Notification
	for len(sub.C) > 0 {
		e := <-sub.C
		if e.Type == notify.Created {
			var got notify.Notification
			if err := json.Unmarshal(e.Payload, &got); err != nil {
				t.Fatal(err)
			}
			created = append(created, got)
		}
	}
	if len(created) != 1 || created[0].ID != n.ID || created[0].Kind != "demo.publish_failed" {
		t.Fatalf("事件流 = %+v", created)
	}

	if err := r.Disable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	if err := demo.Notify(ctx, plugin.Notification{Kind: "x", Title: "t"}); !errors.Is(err, plugin.ErrNotifyInactive) {
		t.Fatalf("停用后 = %v", err)
	}
	if items, total, _ := list(t, c, notify.Filter{}); total != 1 || items[0].ID != n.ID {
		t.Fatalf("停用后已发的通知没了：%d", total)
	}
}
