// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 插件 HTTP/WebSocket 代理（P1-b，docs/plugin-spec-v2.md 7.4/7.6）：
//   - 浏览器/本机调用 /api/plugins/external/<id>/api/<path> 时，宿主把它转成
//     plugin.http.request 请求；插件可一次性返回，也可先回流式头再用 host.http.chunk/end 推块；
//   - 升级 WebSocket 时宿主 accept 客户端连接，发 plugin.http.upgrade；之后双向帧经
//     plugin.http.ws_message（宿主→插件）和 host.ws.send/close（插件→宿主）转交。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	httpProxyMaxBody = 8 << 20
	httpProxyTimeout = 60 * time.Second
)

type httpStream struct {
	pluginID string
	start    chan httpStart
	chunks   chan []byte
	end      chan struct{}
	once     sync.Once
	mu       sync.Mutex
	nextSeq  int
	pending  map[int][]byte
	endSeq   int // -1 表示还没收到 end
	ended    bool
	closed   bool
}

type httpStart struct {
	Stream  bool              `json:"stream"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	BodyB64 string            `json:"body_b64"`
}

type wsStream struct {
	pluginID string
	conn     *websocket.Conn
	once     sync.Once
}

func (h *Host) newHTTPStream(id string) *httpStream {
	return &httpStream{
		pluginID: id,
		start:    make(chan httpStart, 1),
		chunks:   make(chan []byte, 64),
		end:      make(chan struct{}),
		pending:  map[int][]byte{},
		endSeq:   -1,
	}
}

func (h *Host) newWSStream(id string, conn *websocket.Conn) *wsStream {
	return &wsStream{pluginID: id, conn: conn}
}

// ProxyHTTP 把一次 HTTP 请求转给运行中的插件并写回响应；支持一次性响应与 chunk 流。
func (h *Host) ProxyHTTP(ctx context.Context, id string, r *http.Request, w http.ResponseWriter) error {
	p := h.lookupProc(id)
	if p == nil || !p.isRunning() {
		return wrap(ErrNotRunning, "插件 %s 未运行", id)
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, httpProxyMaxBody+1))
	if err != nil {
		return wrap(ErrValidation, "读取请求体失败：%v", err)
	}
	if len(body) > httpProxyMaxBody {
		return wrap(ErrValidation, "请求体超过 %d 字节", httpProxyMaxBody)
	}
	streamID, err := randomHex(16)
	if err != nil {
		return err
	}
	st := h.newHTTPStream(id)
	h.mu.Lock()
	h.httpStreams[streamID] = st
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.httpStreams, streamID)
		h.mu.Unlock()
	}()

	path := pluginAPIPath(r.URL.Path, id)
	params, err := json.Marshal(map[string]any{
		"request_id":  streamID,
		"method":      r.Method,
		"path":        path,
		"query":       r.URL.RawQuery,
		"headers":     flattenHeaders(r.Header),
		"body_b64":    base64.StdEncoding.EncodeToString(body),
		"remote_addr": r.RemoteAddr,
		"stream":      true,
	})
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, httpProxyTimeout)
	defer cancel()
	var first httpStart
	if err := p.callInto(reqCtx, "plugin.http.request", params, &first); err != nil {
		return err
	}
	if !first.Stream {
		status := first.Status
		if status == 0 {
			status = http.StatusOK
		}
		writeProxyHeaders(w, first.Headers)
		w.WriteHeader(status)
		if first.BodyB64 != "" {
			data, derr := base64.StdEncoding.DecodeString(first.BodyB64)
			if derr != nil {
				return wrap(ErrValidation, "插件返回的响应体不是合法 base64：%v", derr)
			}
			_, _ = w.Write(data)
		}
		return nil
	}

	writeProxyHeaders(w, first.Headers)
	status := first.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	flusher, _ := w.(http.Flusher)
	for {
		select {
		case chunk, ok := <-st.chunks:
			if !ok {
				return nil
			}
			if _, err := w.Write(chunk); err != nil {
				return nil
			}
			if flusher != nil {
				flusher.Flush()
			}
		case <-reqCtx.Done():
			return wrap(ErrNotRunning, "插件流式响应超时")
		}
	}
}

// ProxyWebSocket 把客户端 WebSocket 升级并转给插件；插件通过 host.ws.send/close 回帧。
func (h *Host) ProxyWebSocket(ctx context.Context, id string, w http.ResponseWriter, r *http.Request) error {
	p := h.lookupProc(id)
	if p == nil || !p.isRunning() {
		return wrap(ErrNotRunning, "插件 %s 未运行", id)
	}
	wsID, err := randomHex(16)
	if err != nil {
		return err
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return nil // 客户端不是合法 WS / 已拒绝，Accept 已写响应
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	st := h.newWSStream(id, conn)
	h.mu.Lock()
	h.wsStreams[wsID] = st
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.wsStreams, wsID)
		h.mu.Unlock()
	}()

	path := pluginAPIPath(r.URL.Path, id)
	params, _ := json.Marshal(map[string]any{
		"stream_id":   wsID,
		"path":        path,
		"query":       r.URL.RawQuery,
		"headers":     flattenHeaders(r.Header),
		"remote_addr": r.RemoteAddr,
	})
	upCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := p.call(upCtx, "plugin.http.upgrade", params); err != nil {
		_ = conn.Close(websocket.StatusInternalError, "plugin upgrade failed")
		return err
	}
	// 客户端 → 插件。
	go func() {
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				msg, _ := json.Marshal(map[string]any{"stream_id": wsID, "reason": "closed"})
				_, _ = p.call(context.Background(), "plugin.http.ws_close", msg)
				return
			}
			msg, _ := json.Marshal(map[string]any{
				"stream_id": wsID,
				"type":      wsType(typ),
				"data_b64":  base64.StdEncoding.EncodeToString(data),
			})
			if _, err := p.call(context.Background(), "plugin.http.ws_message", msg); err != nil {
				return
			}
		}
	}()
	<-ctx.Done()
	return ctx.Err()
}

// handleHTTPChunk / handleHTTPEnd / handleWSSend / handleWSClose 是插件 → 宿主 broker 的回调。
func (h *Host) handleHTTPChunk(pluginID string, params json.RawMessage) (any, error) {
	var in struct {
		RequestID string `json:"request_id"`
		Seq       int    `json:"seq"`
		DataB64   string `json:"data_b64"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "chunk 参数不合法：%v", err)
	}
	h.mu.Lock()
	st := h.httpStreams[in.RequestID]
	h.mu.Unlock()
	if st == nil || st.pluginID != pluginID {
		return nil, rpcErrorf("not_found", "没有这个流式请求：%s", in.RequestID)
	}
	data, err := base64.StdEncoding.DecodeString(in.DataB64)
	if err != nil {
		return nil, rpcErrorf("validation", "chunk 不是合法 base64")
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.closed || in.Seq < st.nextSeq {
		return nil, rpcErrorf("validation", "chunk seq 非法：%d（已消费到 %d）", in.Seq, st.nextSeq)
	}
	st.pending[in.Seq] = data
	// broker 请求是并发的：按 seq 排序后按序送入 channel，避免 end 先到导致丢块。
	for {
		chunk, ok := st.pending[st.nextSeq]
		if !ok {
			break
		}
		delete(st.pending, st.nextSeq)
		st.nextSeq++
		select {
		case st.chunks <- chunk:
		case <-time.After(5 * time.Second):
			return nil, rpcErrorf("rate_limited", "流式响应消费过慢")
		}
	}
	if st.ended && st.nextSeq >= st.endSeq {
		st.closed = true
		close(st.chunks)
		close(st.end)
	}
	return map[string]any{"ok": true}, nil
}

func (h *Host) handleHTTPEnd(pluginID string, params json.RawMessage) (any, error) {
	var in struct {
		RequestID string `json:"request_id"`
		Seq       int    `json:"seq"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "end 参数不合法：%v", err)
	}
	h.mu.Lock()
	st := h.httpStreams[in.RequestID]
	h.mu.Unlock()
	if st == nil || st.pluginID != pluginID {
		return nil, rpcErrorf("not_found", "没有这个流式请求：%s", in.RequestID)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	st.ended = true
	st.endSeq = in.Seq
	if st.nextSeq >= st.endSeq && !st.closed {
		st.once.Do(func() {
			st.closed = true
			close(st.chunks)
			close(st.end)
		})
	}
	return map[string]any{"ok": true}, nil
}

func (h *Host) handleWSSend(pluginID string, params json.RawMessage) (any, error) {
	var in struct {
		StreamID string `json:"stream_id"`
		Type     string `json:"type"`
		DataB64  string `json:"data_b64"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return nil, rpcErrorf("invalid_params", "ws.send 参数不合法：%v", err)
	}
	h.mu.Lock()
	st := h.wsStreams[in.StreamID]
	h.mu.Unlock()
	if st == nil || st.pluginID != pluginID {
		return nil, rpcErrorf("not_found", "没有这个 WS 流：%s", in.StreamID)
	}
	data, err := base64.StdEncoding.DecodeString(in.DataB64)
	if err != nil {
		return nil, rpcErrorf("validation", "ws.send 不是合法 base64")
	}
	typ := websocket.MessageText
	if in.Type == "binary" {
		typ = websocket.MessageBinary
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := st.conn.Write(ctx, typ, data); err != nil {
		return nil, rpcErrorf("unavailable", "写 WebSocket 失败：%v", err)
	}
	return map[string]any{"ok": true}, nil
}

func (h *Host) handleWSClose(pluginID string, params json.RawMessage) (any, error) {
	var in struct {
		StreamID string `json:"stream_id"`
		Code     int    `json:"code"`
		Reason   string `json:"reason"`
	}
	_ = json.Unmarshal(params, &in)
	h.mu.Lock()
	st := h.wsStreams[in.StreamID]
	h.mu.Unlock()
	if st == nil || st.pluginID != pluginID {
		return nil, rpcErrorf("not_found", "没有这个 WS 流：%s", in.StreamID)
	}
	code := websocket.StatusNormalClosure
	if in.Code != 0 {
		code = websocket.StatusCode(in.Code)
	}
	st.once.Do(func() { _ = st.conn.Close(code, in.Reason) })
	return map[string]any{"ok": true}, nil
}

func flattenHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		if len(v) > 0 {
			out[strings.ToLower(k)] = strings.Join(v, ", ")
		}
	}
	return out
}

func writeProxyHeaders(w http.ResponseWriter, headers map[string]string) {
	for k, v := range headers {
		switch strings.ToLower(k) {
		case "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "content-length":
			continue
		}
		w.Header().Set(k, v)
	}
}

func wsType(t websocket.MessageType) string {
	if t == websocket.MessageBinary {
		return "binary"
	}
	return "text"
}

// pluginAPIPath 把 /api/plugins/external/<id>/api/<rest> 还原成插件看到的 /<rest>（spec 7.4）。
// 2026-11-23 修：以前取的是第一个 "/api/" 之后，插件收到的是 /plugins/external/<id>/api/<rest>。
func pluginAPIPath(full, id string) string {
	prefix := "/api/plugins/external/" + id + "/api"
	if rest, ok := strings.CutPrefix(full, prefix); ok {
		if rest == "" || rest[0] != '/' {
			rest = "/" + rest
		}
		return rest
	}
	return full
}
