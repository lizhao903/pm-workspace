// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// --dev-upstream（IM-01c）：把插件发往某个域名的请求改投到本机假服务，只给测试实例联调用（假 Telegram、假 Slack）。
// 插件的权限和域名清单检查照常按原地址做，改投发生在它们之后。正式运行不要带。

type upstreams map[string]*url.URL

func (u upstreams) String() string {
	parts := []string{}
	for h, to := range u {
		parts = append(parts, h+"="+to.String())
	}
	return strings.Join(parts, ",")
}

// Set 收 host=URL，可以重复给、也可以逗号分隔。
func (u upstreams) Set(v string) error {
	for _, item := range strings.Split(v, ",") {
		host, to, ok := strings.Cut(strings.TrimSpace(item), "=")
		if !ok || host == "" {
			return fmt.Errorf("--dev-upstream 要写成 域名=地址：%q", item)
		}
		p, err := url.Parse(to)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return fmt.Errorf("--dev-upstream 的地址不对：%q", to)
		}
		u[strings.ToLower(host)] = p
	}
	return nil
}

var devUpstreams = upstreams{}

func init() {
	flag.Var(devUpstreams, "dev-upstream", "把插件发往某域名的请求改投到本机假服务，例 api.telegram.org=http://127.0.0.1:8081（只用于联调）")
}

type upstreamTransport struct {
	to   upstreams
	base http.RoundTripper
}

func (t upstreamTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if to := t.to[strings.ToLower(r.URL.Hostname())]; to != nil {
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host, r.Host = to.Scheme, to.Host, to.Host
	}
	return t.base.RoundTrip(r)
}

// applyDevUpstreams 给了 --dev-upstream 时换掉插件出网的底层连接。
func applyDevUpstreams(r *plugin.Registry) {
	if len(devUpstreams) == 0 {
		return
	}
	r.SetHTTPTransport(upstreamTransport{to: devUpstreams, base: http.DefaultTransport})
}
