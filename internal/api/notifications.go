// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/notify"
)

// --- 通知 ---

// notificationMeta 比通用 Meta 多一个全部未读数，铃铛角标不用再发一次请求。
type notificationMeta struct {
	Meta
	Unread int `json:"unread"`
}

func (s *Server) notifyConfigured(w http.ResponseWriter) bool {
	if s.opt.Notify == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "notifications are not configured on this server"}})
		return false
	}
	return true
}

func (s *Server) handleListNotifications(w http.ResponseWriter, r *http.Request) {
	if !s.notifyConfigured(w) {
		return
	}
	p := newParams(r)
	unread, err := p.boolean("unread")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	limit, err := p.limit("limit", defaultLimit, maxLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	offset, err := p.intRange("offset", 0, 0, 1<<30)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, total, unreadN, err := s.opt.Notify.List(r.Context(), notify.Filter{Unread: unread, Limit: limit, Offset: offset})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Data any              `json:"data"`
		Meta notificationMeta `json:"meta"`
	}{items, notificationMeta{Meta{Total: total, Limit: limit, Offset: offset}, unreadN}})
}

func (s *Server) handleReadNotification(w http.ResponseWriter, r *http.Request) {
	if !s.notifyConfigured(w) {
		return
	}
	n, err := s.opt.Notify.MarkRead(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, n)
}

func (s *Server) handleReadAllNotifications(w http.ResponseWriter, r *http.Request) {
	if !s.notifyConfigured(w) {
		return
	}
	n, err := s.opt.Notify.MarkAllRead(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, map[string]int{"updated": n})
}

// --- 事件流 ---

// eventsPing 是心跳间隔：SSE 注释行，防止中间设备把空闲连接掐掉，也让断线尽早暴露。
var eventsPing = 25 * time.Second

// sseEvent 是事件流里一条的 data。id 用字符串：和 EventSource 的 lastEventId 一致，也不用担心 JS 数字精度。
type sseEvent struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	At      time.Time       `json:"at"`
	Payload json.RawMessage `json:"payload"`
}

// handleEvents 是 GET /api/events：推送总线上的事件摘要，断线重连带 Last-Event-ID 补齐。
//
// 新连接（没带 Last-Event-ID）先收到一条 stream.ready，带当前 id；带了的，补发之后的事件，
// 补不齐时发一条 stream.reset，前端应整页重新拉。之后是实时事件，直到客户端断开或服务退出。
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if s.opt.Stream == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "event stream is not configured on this server"}})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, r, fmt.Errorf("response writer does not support streaming"))
		return
	}
	after, hasAfter, err := lastEventID(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sub := s.opt.Stream.Subscribe(after, hasAfter)
	defer sub.Close()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	// 断线后 3 秒重连（EventSource 默认值因浏览器而异）
	_, _ = fmt.Fprint(w, "retry: 3000\n\n")

	now := time.Now().UTC()
	switch {
	case !hasAfter:
		writeEventSSE(w, events.Entry{ID: sub.Last, Type: events.StreamReady, At: now})
	case sub.Gap:
		writeEventSSE(w, events.Entry{ID: sub.Last, Type: events.StreamReset, At: now})
	default:
		for _, e := range sub.Backlog {
			writeEventSSE(w, e)
		}
	}
	flusher.Flush()

	ping := time.NewTicker(eventsPing)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-sub.C:
			if !ok {
				// 连接太慢被踢，或服务在退出；前端带 Last-Event-ID 重连即可
				return
			}
			writeEventSSE(w, e)
			flusher.Flush()
		case <-ping.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// lastEventID 取 Last-Event-ID 头，没有时取 ?last_event_id=（curl 和首连接手动指定用）。
func lastEventID(r *http.Request) (int64, bool, error) {
	raw := strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	if raw == "" {
		raw = strings.TrimSpace(r.URL.Query().Get("last_event_id"))
	}
	if raw == "" {
		return 0, false, nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 0 {
		return 0, false, validationf("invalid Last-Event-ID %q: expected an event id from this stream", raw)
	}
	return id, true, nil
}

func writeEventSSE(w http.ResponseWriter, e events.Entry) {
	payload := e.Payload
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}
	id := strconv.FormatInt(e.ID, 10)
	b, err := json.Marshal(sseEvent{ID: id, Type: e.Type, At: e.At, Payload: payload})
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "id: %s\ndata: %s\n\n", id, b)
}
