// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

var quiet = slog.New(slog.DiscardHandler)

// setup 按 cmd/pmw 的接法：总线 Tap 给事件流和通知中心，store 包事件发布。
func setup(t *testing.T) (store.Store, *notify.Center, *events.Stream) {
	t.Helper()
	raw, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	bus := events.New(nil, quiet)
	stream := events.NewStream(0)
	bus.Tap(stream.Append)
	c := notify.New(raw.DB(), raw, stream, quiet)
	bus.Tap(c.Handle)
	return events.WrapStore(raw, bus), c, stream
}

func waitN(t *testing.T, c *notify.Center) {
	t.Helper()
	if !c.Wait(2 * time.Second) {
		t.Fatal("通知没在 2 秒内生成完")
	}
}

func list(t *testing.T, c *notify.Center, f notify.Filter) ([]notify.Notification, int, int) {
	t.Helper()
	items, total, unread, err := c.List(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	return items, total, unread
}

// 提交验收、执行完成、执行失败各生成一条通知并推进事件流；列表、标已读、全部已读。
func TestNotificationsFromEvents(t *testing.T) {
	ctx := context.Background()
	st, c, stream := setup(t)
	sub := stream.Subscribe(stream.Last(), true)
	defer sub.Close()

	o, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "写通知"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	// 改状态不生成通知
	doing := "doing"
	if _, err := st.UpdateObject(ctx, o.ID, domain.ObjectPatch{Status: &doing}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendProgress(ctx, o.ID, domain.ProgressInput{Kind: domain.ProgressReview, Text: "做完了"}, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	waitN(t, c)
	for _, status := range []string{domain.RunDone, domain.RunFailed, domain.RunCanceled} {
		run, err := st.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: o.ID, Workdir: t.TempDir(), Prompt: "p"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.FinishTaskRun(ctx, run.ID, status, 0, "", ""); err != nil {
			t.Fatal(err)
		}
		waitN(t, c) // 一条一条等，保证顺序
	}

	items, total, unread := list(t, c, notify.Filter{})
	if total != 4 || unread != 4 || len(items) != 4 {
		t.Fatalf("total=%d unread=%d len=%d, want 4", total, unread, len(items))
	}
	want := []struct{ kind, level, suffix string }{
		{events.RunFinished, notify.LevelInfo, " 执行已取消"},
		{events.RunFinished, notify.LevelError, " 执行失败"},
		{events.RunFinished, notify.LevelSuccess, " 执行完成"},
		{events.TaskReviewRequested, notify.LevelInfo, " 提交验收"},
	}
	for i, w := range want {
		n := items[i]
		if n.Kind != w.kind || n.Level != w.level || n.Title != o.Ref+w.suffix || n.Body != "写通知" || n.ObjectID != o.ID || n.ReadAt != nil {
			t.Fatalf("第 %d 条 = %+v, want %+v", i, n, w)
		}
	}
	if items[0].Data["run_id"] == nil || len(items[3].Data) != 0 {
		t.Fatalf("data: %v / %v", items[0].Data, items[3].Data)
	}

	// 事件流里有 notification.created，载荷是整条通知
	var created []notify.Notification
	for len(sub.C) > 0 {
		e := <-sub.C
		if e.Type == notify.Created {
			var n notify.Notification
			if err := json.Unmarshal(e.Payload, &n); err != nil {
				t.Fatal(err)
			}
			created = append(created, n)
		}
	}
	if len(created) != 4 || created[0].ID != items[3].ID {
		t.Fatalf("事件流里的 notification.created = %+v", created)
	}

	// 标一条已读：重复标保留原时间
	n, err := c.MarkRead(ctx, items[3].ID)
	if err != nil || n.ReadAt == nil {
		t.Fatalf("MarkRead = %+v, %v", n, err)
	}
	time.Sleep(5 * time.Millisecond)
	again, _ := c.MarkRead(ctx, items[3].ID)
	if !again.ReadAt.Equal(*n.ReadAt) {
		t.Fatalf("重复标已读改了时间：%v -> %v", n.ReadAt, again.ReadAt)
	}
	if _, err := c.MarkRead(ctx, "ntf_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在的通知 = %v", err)
	}
	items, total, unread = list(t, c, notify.Filter{Unread: true, Limit: 2})
	if total != 3 || unread != 3 || len(items) != 2 {
		t.Fatalf("只看未读：total=%d unread=%d len=%d", total, unread, len(items))
	}

	if got, err := c.MarkAllRead(ctx); err != nil || got != 3 {
		t.Fatalf("MarkAllRead = %d, %v", got, err)
	}
	if _, total, unread := list(t, c, notify.Filter{}); total != 4 || unread != 0 {
		t.Fatalf("全部已读后 total=%d unread=%d", total, unread)
	}
}

// 必填字段缺了报校验错误。
func TestCreateValidation(t *testing.T) {
	_, c, _ := setup(t)
	if _, err := c.Create(context.Background(), notify.Notification{Kind: "x"}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("没有 title = %v", err)
	}
}

// 提醒带上弹窗方式（SPEC-tasks-8.26）：modal 原样带，空和别的值按 toast。
func TestRemindPopup(t *testing.T) {
	_, c, _ := setup(t)
	ctx := context.Background()
	for popup, want := range map[string]string{"modal": "modal", "": "toast", "x": "toast"} {
		got, err := c.Remind(ctx, schedule.RemindRequest{Title: "点餐", Popup: popup, ScheduleID: "sch_1", RunID: "r"})
		if err != nil {
			t.Fatal(err)
		}
		list, _, _ := list(t, c, notify.Filter{})
		var found bool
		for _, n := range list {
			if n.ID == got.NotificationID {
				found = true
				if n.Data["popup"] != want {
					t.Errorf("popup %q 应带 %q，得到 %v", popup, want, n.Data["popup"])
				}
			}
		}
		if !found {
			t.Fatalf("没找到通知 %s", got.NotificationID)
		}
	}
}
