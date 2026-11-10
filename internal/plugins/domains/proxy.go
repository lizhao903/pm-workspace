// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domains

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内置代理（DOM-02a）：登记内核的 Host 处理器，后缀下命中启用路由的请求用反向代理转到本机。
// 原型转到 127.0.0.1:<端口>（连不上再试 ::1，vite 默认只听 localhost），地址目标只转本机和 lan_ip（权限 network:localhost）。
// 工作台自己的域名（后缀本身、别名、目标是工作台的路由）不接，照常进工作台。WebSocket 升级由 ReverseProxy 照转。

// snapTTL 是设置和路由快照的有效期；本插件改了设置、路由会立刻作废。
const snapTTL = 2 * time.Second

// snapshot 是按 Host 分发要用的设置和路由，每个请求都要查，不能每次读库。
type snapshot struct {
	mu     sync.Mutex
	at     time.Time
	s      Settings
	routes map[string]Route // 子域名 -> 启用的路由
	ok     bool
}

func (sn *snapshot) invalidate() {
	sn.mu.Lock()
	sn.ok = false
	sn.mu.Unlock()
}

// get 回有效的快照，过期了用 load 重读；读失败按「不接」处理（设置为空）。
func (sn *snapshot) get(load func() (Settings, []Route, error)) (Settings, map[string]Route) {
	sn.mu.Lock()
	defer sn.mu.Unlock()
	if sn.ok && time.Since(sn.at) < snapTTL {
		return sn.s, sn.routes
	}
	s, routes, err := load()
	if err != nil {
		return Settings{}, nil
	}
	m := map[string]Route{}
	for _, rt := range routes {
		if rt.Enabled && rt.Host != "" {
			if _, dup := m[rt.Host]; !dup {
				m[rt.Host] = rt
			}
		}
	}
	sn.s, sn.routes, sn.at, sn.ok = s, m, time.Now(), true
	return s, m
}

func (h *handlers) snapshot() (Settings, map[string]Route) {
	return h.p.snap.get(func() (Settings, []Route, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s, err := h.loadSettings(ctx)
		if err != nil {
			h.c.Log().Warn("domains snapshot", "err", err)
			return s, nil, err
		}
		routes, err := h.loadRoutes(ctx, s)
		if err != nil {
			h.c.Log().Warn("domains snapshot", "err", err)
		}
		return s, routes, err
	})
}

// hostSuffix 是 Host 处理器的 Suffix：插件总开关关着时不接。
func (h *handlers) hostSuffix() string {
	s, _ := h.snapshot()
	if !s.Enabled {
		return ""
	}
	return s.Suffix
}

// lookup 找主机对应的路由：只认后缀下一级子域名、不是别名、目标不是工作台的启用路由。
func (h *handlers) lookup(host string) (Settings, Route, bool) {
	s, routes := h.snapshot()
	if !s.Enabled || s.Suffix == "" || contains(s.Aliases, host) {
		return s, Route{}, false
	}
	sub, ok := strings.CutSuffix(host, "."+s.Suffix)
	if !ok || sub == "" || strings.Contains(sub, ".") {
		return s, Route{}, false
	}
	rt, ok := routes[sub]
	if !ok || rt.Target.Kind == "app" {
		return s, Route{}, false
	}
	return s, rt, true
}

func (h *handlers) hostMatch(host string) bool {
	_, _, ok := h.lookup(host)
	return ok
}

// serveHost 转发一个请求；目标没在运行、连不上回 502 中文说明页。
func (h *handlers) serveHost(w http.ResponseWriter, r *http.Request) {
	host := plugin.HostName(r.Host)
	s, rt, ok := h.lookup(host)
	if !ok {
		proxyPage(w, http.StatusNotFound, host, "没有这个域名", "内网域名里没有启用的 "+host+"，到设置里的内网域名看看。")
		return
	}
	var target *url.URL
	switch rt.Target.Kind {
	case "proto":
		port, running := h.p.protos.running(rt.Target.ProtoID)
		if !running {
			proxyPage(w, http.StatusBadGateway, host, "原型没在运行",
				host+" 指向的项目原型现在没在运行。到项目的原型页启动它，启动后刷新这一页。")
			return
		}
		target = &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	case "url":
		u, err := url.Parse(rt.Target.URL)
		if err != nil || !isLocalURL(rt.Target.URL, s.LANIP) {
			proxyPage(w, http.StatusBadGateway, host, "不转发到外部地址",
				"内置代理只转发到本机和本机的局域网地址，"+host+" 的目标是 "+rt.Target.URL+"。")
			return
		}
		target = &url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}
	default:
		proxyPage(w, http.StatusBadGateway, host, "目标不对", host+" 的目标不能转发。")
		return
	}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
		},
		Transport: h.p.transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			h.c.Log().Info("domains proxy failed", "host", host, "target", target.Host, "err", err)
			proxyPage(w, http.StatusBadGateway, host, "连不上目标",
				fmt.Sprintf("%s 转发到 %s，但连不上。原型可能还在启动，稍等几秒刷新；一直这样就看看原型的日志。", host, target.Host))
		},
	}
	rp.ServeHTTP(w, r)
}

// newTransport 只连本机：127.0.0.1 连不上时再试 ::1（反过来也一样），别的地址照常拨。
func newTransport() *http.Transport {
	d := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	t := &http.Transport{
		Proxy:                 nil,
		MaxIdleConns:          50,
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 0, // 开发服务器的长请求、SSE 不设上限
		ExpectContinueTimeout: time.Second,
	}
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := d.DialContext(ctx, network, addr)
		if err == nil {
			return c, nil
		}
		host, port, serr := net.SplitHostPort(addr)
		if serr != nil {
			return nil, err
		}
		var alt string
		switch host {
		case "127.0.0.1", "localhost":
			alt = "::1"
		case "::1":
			alt = "127.0.0.1"
		default:
			return nil, err
		}
		if c, err2 := d.DialContext(ctx, network, net.JoinHostPort(alt, port)); err2 == nil {
			return c, nil
		}
		return nil, err
	}
	return t
}

// proxyPage 是转发不了时给浏览器看的说明页。
func proxyPage(w http.ResponseWriter, status int, host, title, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;color:#1f2328;background:#f6f7f9;margin:0}
main{max-width:560px;margin:12vh auto;padding:0 16px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 8px;color:#57606a}
code{background:#eaeef2;padding:1px 6px;border-radius:4px}</style></head>
<body><main><h1>%s</h1><p>%s</p><p>域名 <code>%s</code>，状态码 %d，由产品工作台的内置代理返回。</p></main></body></html>
`, html.EscapeString(title), html.EscapeString(title), html.EscapeString(msg), html.EscapeString(host), status)
}
