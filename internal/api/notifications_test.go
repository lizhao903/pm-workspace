package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newEventsServer 按 cmd/pmw 的接法：总线 Tap 给事件流和通知，store 包事件发布，真监听（SSE 要真连接）。
func newEventsServer(t *testing.T) (*httptest.Server, *Server, *notify.Center, *events.Stream) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := events.New(nil, log)
	stream := events.NewStream(0)
	bus.Tap(stream.Append)
	nc := notify.New(st.DB(), st, stream, log)
	bus.Tap(nc.Handle)
	s := New(events.WrapStore(st, bus), Options{Version: "test", Logger: log, Notify: nc, Stream: stream})
	ts := httptest.NewServer(s)
	t.Cleanup(func() {
		stream.Close()
		ts.Close()
	})
	return ts, s, nc, stream
}

type sseMsg struct {
	ID   string
	Data sseEvent
}

// sseConn 是一条事件流连接，后台把消息读进通道。
type sseConn struct {
	resp *http.Response
	msgs chan sseMsg
}

func openEvents(t *testing.T, ts *httptest.Server, lastID string) *sseConn {
	t.Helper()
	req, _ := http.NewRequest("GET", ts.URL+"/api/events", nil)
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("GET /api/events = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	c := &sseConn{resp: resp, msgs: make(chan sseMsg, 64)}
	go func() {
		defer close(c.msgs)
		sc := bufio.NewScanner(resp.Body)
		var cur sseMsg
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "id: "):
				cur.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &cur.Data)
			case line == "" && cur.Data.Type != "":
				c.msgs <- cur
				cur = sseMsg{}
			}
		}
	}()
	t.Cleanup(c.close)
	return c
}

func (c *sseConn) close() { _ = c.resp.Body.Close() }

func (c *sseConn) next(t *testing.T) sseMsg {
	t.Helper()
	select {
	case m, ok := <-c.msgs:
		if !ok {
			t.Fatal("事件流断了")
		}
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("两秒内没收到事件")
	}
	return sseMsg{}
}

// until 读到某类事件为止，返回它。
func (c *sseConn) until(t *testing.T, typ string) sseMsg {
	t.Helper()
	for {
		if m := c.next(t); m.Data.Type == typ {
			return m
		}
	}
}

func httpDo(t *testing.T, ts *httptest.Server, method, path, body string) map[string]any {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode >= 300 {
		t.Fatalf("%s %s = %d %v", method, path, resp.StatusCode, out)
	}
	return out
}

// 验收：订阅事件流后改任务状态收到对应事件；断线后带 Last-Event-ID 重连补齐中间事件。
func TestEventsStreamAcceptance(t *testing.T) {
	ts, _, _, _ := newEventsServer(t)

	c := openEvents(t, ts, "")
	ready := c.next(t)
	if ready.Data.Type != events.StreamReady || ready.ID == "" || ready.ID != ready.Data.ID {
		t.Fatalf("第一条应是 stream.ready：%+v", ready)
	}

	id := httpDo(t, ts, "POST", "/api/objects", `{"type_id":"task","title":"流"}`)["data"].(map[string]any)["id"].(string)
	created := c.until(t, events.ObjectCreated)
	httpDo(t, ts, "PATCH", "/api/objects/"+id, `{"status":"doing"}`)
	m := c.until(t, events.ObjectStatusChanged)
	var p map[string]any
	_ = json.Unmarshal(m.Data.Payload, &p)
	if p["id"] != id || p["from"] != "todo" || p["to"] != "doing" {
		t.Fatalf("object.status_changed payload = %v", p)
	}
	if m.ID <= created.ID && len(m.ID) == len(created.ID) {
		t.Fatalf("id 应递增：%s -> %s", created.ID, m.ID)
	}

	// 断线，期间又改了两次
	c.close()
	httpDo(t, ts, "PATCH", "/api/objects/"+id, `{"status":"done"}`)
	httpDo(t, ts, "PATCH", "/api/objects/"+id, `{"title":"流 2"}`)

	c2 := openEvents(t, ts, m.ID)
	var got []string
	for range 3 {
		got = append(got, c2.next(t).Data.Type)
	}
	want := []string{events.ObjectUpdated, events.ObjectStatusChanged, events.ObjectUpdated}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("补齐的事件 = %v, want %v", got, want)
	}
	// 补齐之后接着收实时
	httpDo(t, ts, "PATCH", "/api/objects/"+id, `{"title":"流 3"}`)
	if m := c2.next(t); m.Data.Type != events.ObjectUpdated {
		t.Fatalf("补齐后的实时事件 = %+v", m)
	}

	// 窗口外的 id：stream.reset
	c3 := openEvents(t, ts, "1")
	if m := c3.next(t); m.Data.Type != events.StreamReset || m.ID == "" {
		t.Fatalf("窗口外的 id 应收到 stream.reset：%+v", m)
	}
	// 查询参数也认；非数字回 400
	req, _ := http.NewRequest("GET", ts.URL+"/api/events?last_event_id=abc", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("非数字的 last_event_id = %d", resp.StatusCode)
	}
}

// 通知接口：提交验收生成通知并推 notification.created；列表带 unread，标已读、全部已读。
func TestNotificationsAPI(t *testing.T) {
	ts, _, nc, _ := newEventsServer(t)
	c := openEvents(t, ts, "")
	c.until(t, events.StreamReady)

	id := httpDo(t, ts, "POST", "/api/objects", `{"type_id":"task","title":"通知"}`)["data"].(map[string]any)["id"].(string)
	httpDo(t, ts, "POST", "/api/objects/"+id+"/progress", `{"kind":"review","text":"好了"}`)
	httpDo(t, ts, "POST", "/api/objects/"+id+"/progress", `{"kind":"review","text":"再看看"}`)
	nc.Wait(2 * time.Second)
	m := c.until(t, notify.Created)
	var n map[string]any
	_ = json.Unmarshal(m.Data.Payload, &n)
	if n["kind"] != events.TaskReviewRequested || n["object_id"] != id || !strings.HasSuffix(n["title"].(string), " 提交验收") || n["read_at"] != nil {
		t.Fatalf("notification.created = %v", n)
	}

	env := httpDo(t, ts, "GET", "/api/notifications?unread=true", "")
	meta := env["meta"].(map[string]any)
	items := env["data"].([]any)
	if len(items) != 2 || meta["total"].(float64) != 2 || meta["unread"].(float64) != 2 {
		t.Fatalf("列表 = %v", env)
	}
	first := items[0].(map[string]any)["id"].(string)
	read := httpDo(t, ts, "POST", "/api/notifications/"+first+"/read", "")["data"].(map[string]any)
	if read["read_at"] == nil {
		t.Fatalf("标已读 = %v", read)
	}
	env = httpDo(t, ts, "GET", "/api/notifications?unread=1", "")
	if env["meta"].(map[string]any)["unread"].(float64) != 1 || len(env["data"].([]any)) != 1 {
		t.Fatalf("标一条后 = %v", env)
	}
	if got := httpDo(t, ts, "POST", "/api/notifications/read-all", "")["data"].(map[string]any)["updated"].(float64); got != 1 {
		t.Fatalf("read-all updated = %v", got)
	}
	env = httpDo(t, ts, "GET", "/api/notifications", "")
	if env["meta"].(map[string]any)["unread"].(float64) != 0 || len(env["data"].([]any)) != 2 {
		t.Fatalf("全部已读后 = %v", env)
	}

	req, _ := http.NewRequest("POST", ts.URL+"/api/notifications/ntf_nope/read", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("不存在的通知 = %d", resp.StatusCode)
	}
}

// 没接通知和事件流时回 500 并说明。
func TestEventsNotConfigured(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, path := range []string{"/api/events", "/api/notifications"} {
		w := do(s, "GET", path, "")
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "not configured") {
			t.Fatalf("GET %s = %d %s", path, w.Code, w.Body.String())
		}
	}
}
