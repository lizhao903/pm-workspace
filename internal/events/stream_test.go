package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func ev(typ string) plugin.Event {
	return plugin.Event{Type: typ, At: time.Now().UTC(), Payload: []byte(`{}`)}
}

func recv(t *testing.T, c <-chan events.Entry) events.Entry {
	t.Helper()
	select {
	case e, ok := <-c:
		if !ok {
			t.Fatal("订阅被关了")
		}
		return e
	case <-time.After(time.Second):
		t.Fatal("一秒内没收到事件")
	}
	return events.Entry{}
}

// TestStreamReplay：id 递增，按 Last-Event-ID 补齐，补发与实时之间不漏不重；超出窗口算补不齐。
func TestStreamReplay(t *testing.T) {
	s := events.NewStream(3)
	start := s.Last()
	if start < time.Now().Add(-time.Minute).UnixMicro() {
		t.Fatalf("起点 %d 应是启动时刻的微秒数", start)
	}

	live := s.Subscribe(0, false)
	defer live.Close()
	if len(live.Backlog) != 0 || live.Gap || live.Last != start {
		t.Fatalf("新连接不补发：%+v", live)
	}
	s.Append(ev("a"))
	s.Append(ev("b"))
	a, b := recv(t, live.C), recv(t, live.C)
	if a.ID != start+1 || b.ID != start+2 || a.Type != "a" || b.Type != "b" {
		t.Fatalf("实时事件 id 应递增：%+v %+v", a, b)
	}

	// 从 a 之后补：只有 b
	sub := s.Subscribe(a.ID, true)
	if sub.Gap || len(sub.Backlog) != 1 || sub.Backlog[0].ID != b.ID {
		t.Fatalf("补发 = %+v", sub)
	}
	s.Append(ev("c"))
	if got := recv(t, sub.C); got.Type != "c" {
		t.Fatalf("补发之后接实时，收到 %+v", got)
	}
	sub.Close()
	sub.Close() // 可重复调用

	// 已是最新：不补也不算缺
	if sub := s.Subscribe(s.Last(), true); sub.Gap || len(sub.Backlog) != 0 {
		t.Fatalf("最新 id 重连 = %+v", sub)
	}

	// 窗口 3 条：再发两条后 a、b 被挤掉，从起点补就缺了
	s.Append(ev("d"))
	s.Append(ev("e"))
	if sub := s.Subscribe(start, true); !sub.Gap || len(sub.Backlog) != 0 {
		t.Fatalf("超出窗口应 Gap：%+v", sub)
	}
	// 从 b 之后补：c d e 都还在
	sub = s.Subscribe(b.ID, true)
	if sub.Gap || len(sub.Backlog) != 3 || sub.Backlog[0].Type != "c" || sub.Backlog[2].Type != "e" {
		t.Fatalf("窗口内补发 = %+v", sub.Backlog)
	}
	// 比最新还大（别的进程发的 id）
	if sub := s.Subscribe(s.Last()+5, true); !sub.Gap {
		t.Fatal("未来的 id 应 Gap")
	}

	// 重启：新流的起点比旧流发过的都大，旧 id 落在窗口前
	time.Sleep(2 * time.Millisecond)
	s2 := events.NewStream(3)
	if s2.Last() <= s.Last() {
		t.Fatalf("重启后起点 %d 不大于旧 id %d", s2.Last(), s.Last())
	}
	if sub := s2.Subscribe(s.Last(), true); !sub.Gap {
		t.Fatal("重启前的 id 应 Gap")
	}
}

// TestStreamSlowAndClose：积压超过缓冲的连接被踢（通道关闭），Close 关掉所有连接。
func TestStreamSlowAndClose(t *testing.T) {
	s := events.NewStream(1000)
	slow := s.Subscribe(0, false)
	for range 300 {
		s.Append(ev("x"))
	}
	n := 0
	for range slow.C {
		n++
	}
	if n == 0 || n >= 300 {
		t.Fatalf("慢连接收到 %d 条后应被关掉", n)
	}
	// 被踢后带最后收到的 id 重连能补齐
	if sub := s.Subscribe(s.Last()-300+int64(n), true); sub.Gap || len(sub.Backlog) != 300-n {
		t.Fatalf("被踢后补发 %d 条 gap=%v，want %d", len(sub.Backlog), sub.Gap, 300-n)
	}

	a := s.Subscribe(0, false)
	s.Close()
	if _, ok := <-a.C; ok {
		t.Fatal("Close 后通道应关闭")
	}
	if _, ok := <-s.Subscribe(0, false).C; ok {
		t.Fatal("关闭后的新订阅应直接是关闭的")
	}
	s.Append(ev("y")) // 不 panic
}

// TestBusTap：内部订阅者收所有类型、按发布顺序同步收到，不需要插件注册表；取消后不再收到，panic 不影响发布。
func TestBusTap(t *testing.T) {
	bus := events.New(nil, quiet)
	var got []string
	cancel := bus.Tap(func(e plugin.Event) { got = append(got, e.Type) })
	bus.Tap(func(plugin.Event) { panic("boom") })
	ctx := context.Background()
	for _, typ := range []string{events.ObjectCreated, "projects.x", events.RunFinished} {
		if err := bus.Publish(ctx, typ, map[string]string{"id": "1"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(got) != 3 || got[0] != events.ObjectCreated || got[1] != "projects.x" || got[2] != events.RunFinished {
		t.Fatalf("tap 收到 %v", got)
	}
	cancel()
	_ = bus.Publish(ctx, events.ObjectCreated, nil)
	if len(got) != 3 {
		t.Fatalf("取消后还收到：%v", got)
	}
}
