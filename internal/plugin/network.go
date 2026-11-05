package plugin

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
)

// 出网句柄（VID-04a，docs/plugin-api.md 2.0、3.1、3.3）：Core.HTTP(group) 只给清单声明过、用户确认过的
// network:<group>，每一跳（含重定向）发出前按内核维护的域名清单查目标。插件不要用 http.DefaultClient、http.Get，
// internal/plugins 下由 boundary_test.go 盯着。

// HostRule 是域名清单的一项。Host 是完整域名、IP，或 *.example.com（只配子域名，不含 example.com 本身）；
// Paths 不空时只放行这些路径前缀（同一个域名上公开行情和交易接口混在一起时用）。
type HostRule struct {
	Host  string
	Paths []string
}

// NetworkHosts 是各组的域名清单，由内核维护，插件改不了。any 不在这里：放行所有 http、https 地址。
// localhost 另外放行所有回环地址（127.0.0.0/8、::1）。
var NetworkHosts = map[string][]HostRule{
	"localhost": {{Host: "localhost"}, {Host: "*.localhost"}},
	"im": {
		{Host: "slack.com"}, {Host: "*.slack.com"},
		{Host: "api.telegram.org"},
		{Host: "open.feishu.cn"}, {Host: "open.larksuite.com"},
		{Host: "qyapi.weixin.qq.com"},
	},
	"media-platforms": {
		// B 站：接口、投稿和图片、视频 CDN
		{Host: "bilibili.com"}, {Host: "*.bilibili.com"}, {Host: "*.hdslb.com"}, {Host: "*.bilivideo.com"},
		// YouTube：Data API 和上传在 www.googleapis.com 上，只放行 youtube 的路径
		{Host: "youtube.com"}, {Host: "*.youtube.com"}, {Host: "youtube.googleapis.com"},
		{Host: "www.googleapis.com", Paths: []string{"/youtube/", "/upload/youtube/"}},
		{Host: "*.googlevideo.com"}, {Host: "*.ytimg.com"},
		// 抖音：开放平台和 CDN
		{Host: "douyin.com"}, {Host: "*.douyin.com"}, {Host: "*.douyinpic.com"}, {Host: "*.douyinvod.com"},
	},
	"market-data": {
		// Binance 公开行情：只行情的域名，加主域名上的公开行情路径
		{Host: "data-api.binance.vision"}, {Host: "data-stream.binance.vision"},
		{Host: "api.binance.com", Paths: []string{
			"/api/v3/ping", "/api/v3/time", "/api/v3/exchangeInfo", "/api/v3/depth", "/api/v3/trades",
			"/api/v3/aggTrades", "/api/v3/klines", "/api/v3/uiKlines", "/api/v3/avgPrice", "/api/v3/ticker",
		}},
		// Binance U 本位永续公开行情（TRD-01b，同 plugin-api.md 的清单）：同一域名上也有交易接口，只放行行情路径
		{Host: "fapi.binance.com", Paths: []string{
			"/fapi/v1/ping", "/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/depth", "/fapi/v1/klines",
			"/fapi/v1/premiumIndex", "/fapi/v1/fundingRate", "/fapi/v1/fundingInfo", "/fapi/v1/ticker",
		}},
		// OKX 公开行情
		{Host: "www.okx.com", Paths: []string{"/api/v5/market/", "/api/v5/public/"}},
		{Host: "ws.okx.com", Paths: []string{"/ws/v5/public", "/ws/v5/business"}},
		// 东方财富公开数据（A 股宽基 ETF，ETF-01a）：实时行情、历史日 K、数据中心基金份额、基金页
		{Host: "push2.eastmoney.com"}, {Host: "push2his.eastmoney.com"},
		{Host: "datacenter-web.eastmoney.com"},
		{Host: "fund.eastmoney.com"}, {Host: "fundf10.eastmoney.com"},
	},
	// 交易接口：先只列域名，实盘（trade:live、TRD-08）之前不用
	"exchanges": {
		{Host: "api.binance.com"}, {Host: "api1.binance.com"}, {Host: "api2.binance.com"}, {Host: "api3.binance.com"},
		{Host: "api4.binance.com"}, {Host: "fapi.binance.com"}, {Host: "dapi.binance.com"},
		{Host: "stream.binance.com"}, {Host: "fstream.binance.com"}, {Host: "testnet.binance.vision"},
		{Host: "www.okx.com"}, {Host: "ws.okx.com"},
	},
}

var (
	// ErrNetworkNotDeclared：清单 permissions 里没声明这个 network:<group>，或组不存在。
	ErrNetworkNotDeclared = errors.New("plugin network group not declared")
	// ErrHostNotAllowed：目标不在这个组的域名清单里。
	ErrHostNotAllowed = errors.New("plugin network host not allowed")
)

// HostNotAllowedError 是请求清单外地址时的错误，Error() 直接给用户看。客户端会再包一层 *url.Error，用 errors.Is 认。
type HostNotAllowedError struct {
	ID    string
	Group string
	URL   string // 去掉了查询串和用户信息
}

func (e *HostNotAllowedError) Error() string {
	return fmt.Sprintf("插件 %s 的 network:%s 不允许访问 %s", e.ID, e.Group, e.URL)
}

func (e *HostNotAllowedError) Unwrap() error { return ErrHostNotAllowed }

// NetworkAllows 看 u 在不在 group 的域名清单里。只认 http、https；端口不管。
func NetworkAllows(group string, u *url.URL) bool {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return false
	}
	if group == "any" {
		return true
	}
	if group == "localhost" {
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return true
		}
	}
	p := u.EscapedPath()
	if p == "" {
		p = "/"
	}
	for _, r := range NetworkHosts[group] {
		if !hostMatches(r.Host, host) {
			continue
		}
		if len(r.Paths) == 0 || slices.ContainsFunc(r.Paths, func(pre string) bool { return strings.HasPrefix(p, pre) }) {
			return true
		}
	}
	return false
}

func hostMatches(pattern, host string) bool {
	if rest, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(host, "."+rest)
	}
	return host == pattern
}

func knownGroup(group string) bool {
	_, ok := NetworkHosts[group]
	return ok || group == "any"
}

// defaultBase 是各插件出网共用的底层连接池。
var defaultBase = sync.OnceValue(func() http.RoundTripper { return http.DefaultTransport.(*http.Transport).Clone() })

type transportBox struct{ rt http.RoundTripper }

// SetHTTPTransport 换掉插件出网用的底层 RoundTripper，测试用它接本机假服务；nil 恢复默认。
// 域名和权限检查在它外面，换了照样查。
func (r *Registry) SetHTTPTransport(rt http.RoundTripper) { r.httpBase.Store(&transportBox{rt}) }

func (r *Registry) httpTransport() http.RoundTripper {
	if r != nil {
		if b := r.httpBase.Load(); b != nil && b.rt != nil {
			return b.rt
		}
	}
	return defaultBase()
}

// HTTP 回只能访问 group 域名清单的客户端。清单没声明 network:<group> 回 ErrNetworkNotDeclared，
// 声明了但用户没确认回 *NotGrantedError。每次请求时再查一次确认状态，升级、收回权限后立刻生效。
// 客户端没设总超时，请求用 NewRequestWithContext 带上期限。
func (c *core) HTTP(group string) (*http.Client, error) {
	perm := "network:" + group
	var declared []string
	if c.reg != nil {
		if e := c.reg.entries[c.id]; e != nil {
			declared = e.m.Permissions
		}
	}
	if !knownGroup(group) || !slices.Contains(declared, perm) {
		return nil, fmt.Errorf("%w：插件 %s 的清单没声明 %s", ErrNetworkNotDeclared, c.id, perm)
	}
	if err := Require(c, perm); err != nil {
		return nil, err
	}
	return &http.Client{Transport: guardTransport{c: c, group: group}}, nil
}

type guardTransport struct {
	c     *core
	group string
}

func (t guardTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	err := Require(t.c, "network:"+t.group)
	if err == nil && !NetworkAllows(t.group, req.URL) {
		shown := url.URL{Scheme: req.URL.Scheme, Host: req.URL.Host, Path: req.URL.Path}
		err = &HostNotAllowedError{ID: t.c.id, Group: t.group, URL: shown.String()}
	}
	if err != nil {
		// RoundTripper 出错时也要关掉请求体
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	return t.c.reg.httpTransport().RoundTrip(req)
}
