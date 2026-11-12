// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// 按 Host 分发的扩展点（DOM-02a），见 docs/plugin-api.md 2.11。
// 内核在接口层外面包一层（HostDispatch）：请求的主机落在某个插件声明的后缀下、插件也认它时交给插件，
// 其余照常进工作台。IP、localhost、不带点的主机和 cmd/pmw 给的保留主机（--public-url 的主机）永远不交给插件。

// HostPermission 是登记 Host 处理器要声明的权限：转发只能到本机。
const HostPermission = "network:localhost"

// HostHandlerDef 是插件登记的 Host 处理器，每个插件最多一个。
type HostHandlerDef struct {
	// Suffix 返回现在接的域名后缀（不带开头的点，比如 bro.vip），空串表示现在不接。每个请求都调，要快。
	Suffix func() string
	// Match 看要不要接这个主机。host 已转小写、去掉端口和末尾的点，一定是 Suffix 下的子域名（不等于后缀本身）。
	Match func(host string) bool
	// Handler 处理接下来的请求，拿到的是未经接口层包装的 ResponseWriter（WebSocket 升级要 Hijack）。
	Handler http.Handler
}

func (c *collector) HostHandler(d HostHandlerDef) {
	switch {
	case !slices.Contains(c.e.m.Permissions, HostPermission):
		c.add("登记 Host 处理器要在清单 permissions 里声明 %s", HostPermission)
	case d.Suffix == nil || d.Match == nil || d.Handler == nil:
		c.add("Host 处理器的 Suffix、Match、Handler 都不能为空")
	case c.a.host != nil:
		c.add("Host 处理器只能登记一个")
	default:
		c.a.host = &d
	}
}

// HostName 把请求的 Host 规整成小写、不带端口和末尾的点。
func HostName(hostport string) string {
	h := hostport
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		h = host
	}
	h = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSuffix(h, "]"), "["), ".")
	return strings.ToLower(h)
}

// reservedHost：永远进工作台的主机。
func reservedHost(h string, reserved []string) bool {
	return h == "" || h == "localhost" || strings.HasSuffix(h, ".localhost") || !strings.Contains(h, ".") ||
		net.ParseIP(h) != nil || slices.Contains(reserved, h)
}

// HostDispatch 包住接口层：Host 命中在跑插件的 Host 处理器时交给插件，否则交给 next。
// reserved 是额外永远进工作台的主机，可以直接给地址（cmd/pmw 传 --public-url），比较时不分大小写。
// 不拿 r.mu，理由同 Subscribers；插件停用后它的处理器立刻不再收到请求，用户没确认 network:localhost 也不收。
func (r *Registry) HostDispatch(next http.Handler, reserved ...string) http.Handler {
	res := make([]string, 0, len(reserved))
	for _, h := range reserved {
		if u, err := url.Parse(h); err == nil && u.Host != "" {
			h = u.Host
		}
		if h = HostName(h); h != "" {
			res = append(res, h)
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if h := r.hostHandler(HostName(req.Host), res); h != nil {
			h.ServeHTTP(w, req)
			return
		}
		next.ServeHTTP(w, req)
	})
}

func (r *Registry) hostHandler(host string, reserved []string) http.Handler {
	if reservedHost(host, reserved) {
		return nil
	}
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil || a.host == nil || !e.core.Granted(HostPermission) {
			continue
		}
		suf := strings.ToLower(strings.Trim(a.host.Suffix(), "."))
		if suf == "" || !strings.HasSuffix(host, "."+suf) {
			continue
		}
		if a.host.Match(host) {
			return a.host.Handler
		}
	}
	return nil
}
