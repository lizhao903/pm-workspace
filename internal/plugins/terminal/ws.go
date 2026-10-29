package terminal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// WebSocket 收发（TERM-01a）：二进制帧是终端字节，两个方向都是；文本帧是 JSON 控制消息。
// 客户端发 {"type":"resize","cols":..,"rows":..}；服务端连上先发 {"type":"replay","from":..,"to":..}
// 再补发这段输出，shell 退出时发 {"type":"exit","code":..} 后正常关闭。

const (
	maxInFrame = 64 << 10         // 客户端单帧上限
	writeWait  = 10 * time.Second // 单次写超时
)

// 关闭码：会话被删或插件停用、连接跟不上输出（重连即可）
const (
	closeGone    = websocket.StatusGoingAway
	closeTooSlow = websocket.StatusTryAgainLater
)

type control struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// originCheck 认本机（127.0.0.1、localhost、::1，任意端口）和 --public-url 同源的 Origin。
// 没有 Origin 头的是非浏览器客户端，放行：跨站页面发起的握手浏览器一定带 Origin。
type originCheck struct{ public string }

func newOriginCheck(publicURL string) originCheck {
	if u, err := url.Parse(strings.TrimSpace(publicURL)); err == nil && u.Host != "" {
		return originCheck{public: normOrigin(u)}
	}
	return originCheck{}
}

func normOrigin(u *url.URL) string {
	scheme, host, port := strings.ToLower(u.Scheme), strings.ToLower(u.Hostname()), u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host
}

func (o originCheck) ok(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return o.public != "" && normOrigin(u) == o.public
}

func (h *handlers) ws(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); !h.origins.ok(origin) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]string{
			"code": "forbidden", "message": "Origin " + origin + " 不是本机也不是工作台地址，拒绝连接终端"}})
		return
	}
	s, err := h.m.get(r.PathValue("id"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	after := int64(-1)
	if v := r.URL.Query().Get("after"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			h.fail(w, r, apiErr(errValidation, "after 要是非负整数"))
			return
		}
		after = n
	}
	// Origin 上面已经查过，库自带的同源检查关掉（它只比 Host，不认 --public-url）
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return // Accept 已经写了错误响应
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(maxInFrame)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	from, data, sb := s.attach(after)
	if sb != nil {
		defer s.detach(sb)
	}
	if err := writeCtl(ctx, c, map[string]any{"type": "replay", "from": from, "to": from + int64(len(data))}); err != nil {
		return
	}
	if len(data) > 0 {
		if err := writeBin(ctx, c, data); err != nil {
			return
		}
	}
	if sb == nil {
		h.sendExit(ctx, c, s)
		return
	}

	// 读：输入写进 pty，控制消息调大小；连接断了取消写
	go func() {
		defer cancel()
		for {
			typ, msg, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				if s.write(msg) != nil {
					return
				}
				continue
			}
			var ctl control
			if json.Unmarshal(msg, &ctl) != nil {
				continue // 不认的控制消息忽略
			}
			if ctl.Type == "resize" {
				_ = s.resize(ctl.Cols, ctl.Rows)
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case p, ok := <-sb.ch:
			if !ok {
				switch sb.end {
				case endExited:
					h.sendExit(ctx, c, s)
				case endTooSlow:
					_ = c.Close(closeTooSlow, "输出积压，重连补发")
				default:
					_ = c.Close(closeGone, "会话已结束")
				}
				return
			}
			if err := writeBin(ctx, c, p); err != nil {
				return
			}
		}
	}
}

func (h *handlers) sendExit(ctx context.Context, c *websocket.Conn, s *session) {
	v := s.view()
	code := 0
	if v.ExitCode != nil {
		code = *v.ExitCode
	}
	_ = writeCtl(ctx, c, map[string]any{"type": "exit", "code": code})
	_ = c.Close(websocket.StatusNormalClosure, "进程已退出")
}

func writeBin(ctx context.Context, c *websocket.Conn, p []byte) error {
	ctx, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	return c.Write(ctx, websocket.MessageBinary, p)
}

func writeCtl(ctx context.Context, c *websocket.Conn, v any) error {
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, b)
}
