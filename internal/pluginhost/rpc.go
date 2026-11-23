// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// JSON-RPC 2.0 + 换行分帧（docs/plugin-spec-v2.md 7.2，brief §1）。
//
// 每条消息是一行 UTF-8 JSON + '\n'，不允许批量数组；宿主和插件都可以发 request，
// 响应必须带请求 id，notification 不带 id 不回复。单帧上限 8 MiB，超限断开。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// rpcError 是 JSON-RPC 错误对象；code 按规范（docs/plugin-spec-v2.md 7.7），message 中文可读。
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

// rpcErrorCodes 是语义错误名 → JSON-RPC 整数码。
var rpcErrorCodes = map[string]int{
	"parse_error":       -32700,
	"invalid_request":   -32600,
	"method_not_found":  -32601,
	"invalid_params":    -32602,
	"internal_error":    -32603,
	"permission_denied": -32001,
	"not_found":         -32002,
	"validation":        -32003,
	"conflict":          -32004,
	"rate_limited":      -32005,
	"unavailable":       -32006,
	"internal":          -32007,
}

func rpcErrorf(name, format string, args ...any) *rpcError {
	num, ok := rpcErrorCodes[name]
	if !ok {
		num = rpcErrorCodes["internal_error"]
	}
	return &rpcError{Code: num, Message: fmt.Sprintf(format, args...)}
}

// rpcRequest 是一条请求/通知帧。
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// rpcResponse 是一条响应帧。
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// rpcHandler 处理插件 → 宿主的方法调用；返回的 result 会被序列化成响应。
type rpcHandler func(ctx context.Context, method string, params json.RawMessage) (any, error)

// errFrameTooLarge 表示单帧超过 8 MiB。
var errFrameTooLarge = errors.New("单条消息超过帧上限")

// rpcConn 是一条插件连接：读写分帧、请求/响应关联、双向请求。
type rpcConn struct {
	rw       io.ReadWriteCloser
	br       *bufio.Reader
	log      *slog.Logger
	maxFrame int

	writeMu sync.Mutex
	nextID  atomic.Int64

	mu         sync.Mutex
	handler    rpcHandler
	onResponse func(id json.RawMessage) // 响应写完后回调（握手用，保证 welcome 先于 activate 上线）
	pending    map[string]chan *rpcResponse

	baseCtx context.Context
	done    chan struct{}
	once    sync.Once
	wg      sync.WaitGroup
	sem     chan struct{}
}

func newRPCConn(rw io.ReadWriteCloser, log *slog.Logger) *rpcConn {
	if log == nil {
		log = slog.Default()
	}
	return &rpcConn{
		rw:       rw,
		br:       bufio.NewReaderSize(rw, 64*1024),
		log:      log,
		maxFrame: MaxFrameBytes,
		pending:  map[string]chan *rpcResponse{},
		done:     make(chan struct{}),
		sem:      make(chan struct{}, MaxConcurrentRequests),
		baseCtx:  context.Background(),
	}
}

func (c *rpcConn) setHandler(h rpcHandler) {
	c.mu.Lock()
	c.handler = h
	c.mu.Unlock()
}

// setOnResponse 设置「请求响应已经写到线上」的回调；握手用它确认 host.welcome
// 已经发出后，宿主才能发 plugin.activate，避免两条帧乱序。
func (c *rpcConn) setOnResponse(fn func(id json.RawMessage)) {
	c.mu.Lock()
	c.onResponse = fn
	c.mu.Unlock()
}

func (c *rpcConn) fireResponse(id json.RawMessage) {
	c.mu.Lock()
	fn := c.onResponse
	c.mu.Unlock()
	if fn != nil {
		fn(id)
	}
}

// start 启动读循环；ctx 只作为处理插件请求的父上下文，取消后连接不自动关闭。
func (c *rpcConn) start(ctx context.Context) {
	c.mu.Lock()
	c.baseCtx = ctx
	c.mu.Unlock()
	go c.readLoop()
}

// done 返回连接关闭信号。
func (c *rpcConn) closed() <-chan struct{} { return c.done }

// close 关闭连接（幂等）。
func (c *rpcConn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.rw.Close()
	})
}

// readLoop 逐帧读取并分发；任何读错误都视为连接结束。
func (c *rpcConn) readLoop() {
	defer c.close()
	for {
		frame, err := c.readFrame()
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, errFrameTooLarge) && !c.isClosed() {
				c.log.Debug("读取插件消息结束", "err", err)
			}
			if errors.Is(err, errFrameTooLarge) {
				c.log.Error("插件消息超过帧上限，断开连接", "limit", c.maxFrame)
			}
			return
		}
		if len(bytes.TrimSpace(frame)) > 0 {
			c.dispatch(frame)
		}
	}
}

func (c *rpcConn) isClosed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// readFrame 读到 '\n' 为止；累计长度超限立即报错，避免无换行的巨帧把内存吃满。
func (c *rpcConn) readFrame() ([]byte, error) {
	var buf []byte
	for {
		chunk, err := c.br.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > c.maxFrame {
			return nil, errFrameTooLarge
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return buf, err
	}
}

// dispatch 解析一帧：有 method 是请求/通知，没有 method 是响应。
func (c *rpcConn) dispatch(frame []byte) {
	var probe struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(frame, &probe); err != nil {
		c.log.Warn("收到无法解析的帧", "err", err)
		_ = c.writeResponse(nil, nil, rpcErrorf("parse_error", "消息不是合法 JSON：%v", err))
		return
	}

	if probe.Method == "" {
		if len(probe.ID) > 0 {
			c.deliverResponse(frame)
		}
		return
	}

	if len(probe.ID) == 0 || string(probe.ID) == "null" {
		// notification：不回应，失败了只记日志。
		c.mu.Lock()
		h := c.handler
		ctx := c.baseCtx
		c.mu.Unlock()
		if h == nil {
			return
		}
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			// 通知也受并发上限约束：恶意插件不能靠刷通知无限起 goroutine / 打爆宿主动作。
			select {
			case c.sem <- struct{}{}:
				defer func() { <-c.sem }()
			case <-c.done:
				return
			}
			if _, err := h(ctx, probe.Method, paramsOf(frame)); err != nil {
				c.log.Warn("处理插件通知失败", "method", probe.Method, "err", err)
			}
		}()
		return
	}

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		select {
		case c.sem <- struct{}{}:
			defer func() { <-c.sem }()
		case <-c.done:
			return
		}
		c.mu.Lock()
		h := c.handler
		ctx := c.baseCtx
		c.mu.Unlock()
		if h == nil {
			_ = c.writeResponse(probe.ID, nil, rpcErrorf("method_not_found", "未实现方法 %s", probe.Method))
			return
		}
		result, err := h(ctx, probe.Method, paramsOf(frame))
		if err != nil {
			var re *rpcError
			if !errors.As(err, &re) {
				re = rpcErrorf("internal", "%s 处理失败：%v", probe.Method, err)
			}
			_ = c.writeResponse(probe.ID, nil, re)
			c.fireResponse(probe.ID)
			return
		}
		_ = c.writeResponse(probe.ID, result, nil)
		c.fireResponse(probe.ID)
	}()
}

// paramsOf 从原始帧里取 params 原文。
func paramsOf(frame []byte) json.RawMessage {
	var full rpcRequest
	if err := json.Unmarshal(frame, &full); err != nil {
		return nil
	}
	return full.Params
}

// deliverResponse 把响应交给等待中的 call。
func (c *rpcConn) deliverResponse(frame []byte) {
	var resp rpcResponse
	if err := json.Unmarshal(frame, &resp); err != nil {
		c.log.Warn("收到无法解析的响应", "err", err)
		return
	}
	key := idKey(resp.ID)
	c.mu.Lock()
	ch, ok := c.pending[key]
	c.mu.Unlock()
	if !ok {
		c.log.Debug("收到未知请求 id 的响应", "id", key)
		return
	}
	select {
	case ch <- &resp:
	default:
	}
}

// write 写一帧（自动加换行、检查上限）。
func (c *rpcConn) write(v any) error {
	frame, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(frame)+1 > c.maxFrame {
		return wrap(ErrValidation, "响应超过单帧上限 %d 字节", c.maxFrame)
	}
	frame = append(frame, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.rw.Write(frame)
	return err
}

func (c *rpcConn) writeResponse(id json.RawMessage, result any, rerr *rpcError) error {
	resp := map[string]any{"jsonrpc": "2.0", "id": id}
	if rerr != nil {
		resp["error"] = rerr
	} else {
		resp["result"] = result
	}
	return c.write(resp)
}

// call 发一个宿主 → 插件请求并等响应；out 非 nil 时解出 result。
func (c *rpcConn) call(ctx context.Context, method string, params any, out any) error {
	res, err := c.callRaw(ctx, method, params)
	if err != nil {
		return err
	}
	if out != nil && len(res) > 0 {
		if err := json.Unmarshal(res, out); err != nil {
			return fmt.Errorf("解析 %s 的响应失败：%w", method, err)
		}
	}
	return nil
}

// callRaw 同 call，但返回 result 原文；用于把插件结果原样透传给 API。
func (c *rpcConn) callRaw(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := "host-" + strconv.FormatInt(c.nextID.Add(1), 10)
	ch := make(chan *rpcResponse, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	if err := c.write(req); err != nil {
		return nil, wrap(ErrNotRunning, "向插件发送 %s 失败：%v", method, err)
	}

	timer := time.NewTimer(DefaultTimeoutMS * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("调用 %s 超时或被取消：%w", method, ctx.Err())
	case <-c.done:
		return nil, wrap(ErrNotRunning, "插件连接已断开")
	case <-timer.C:
		return nil, fmt.Errorf("调用 %s 超时（%dms）", method, DefaultTimeoutMS)
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	}
}

// notify 发一个通知（无 id、不等响应）。
func (c *rpcConn) notify(method string, params any) error {
	req := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		req["params"] = params
	}
	return c.write(req)
}

// wait 等读循环和处理中的请求收尾，最多 timeout。
func (c *rpcConn) wait(timeout time.Duration) {
	ch := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(ch)
	}()
	select {
	case <-ch:
	case <-time.After(timeout):
	}
}

// idKey 把 id 的 JSON 原文规整成 map key：字符串 id 去掉引号，数字原样。
func idKey(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		if unq, err := strconv.Unquote(s); err == nil {
			return unq
		}
	}
	return s
}
