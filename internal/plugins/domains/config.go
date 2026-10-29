package domains

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Section 是生成配置的一段：要写进去的内容和要用户自己执行的命令（多半要 sudo，插件不执行）。
type Section struct {
	Kind     string   `json:"kind"`
	Path     string   `json:"path,omitempty"` // 内容该写到哪个文件，没有固定位置时为空
	Content  string   `json:"content"`
	Commands []string `json:"commands"`
	Note     string   `json:"note,omitempty"`
}

// Config 是 GET /api/domains/config 的结果；cert 只在 HTTPS 打开时有。
type Config struct {
	Proxy   string   `json:"proxy"`
	Domains []string `json:"domains"`
	Resolve Section  `json:"resolve"`
	PF      Section  `json:"pf"`
	ProxyS  Section  `json:"proxy_config"`
	Cert    *Section `json:"cert"`
}

// entry 是一个要生效的完整域名和它的上游。
type entry struct {
	fqdn  string
	route *Route // 别名为 nil，按工作台处理
}

const noDomains = "没有启用的域名"

// hostsHeader 同 scripts/setup-local-domain.sh 写进 /etc/hosts 的注释行。
const hostsHeader = "# 产品工作台本地域名（scripts/setup-local-domain.sh 添加）"

// domainEntries：工作台的别名在前（同 setup-local-domain.sh 默认 DOMAINS 的顺序），再按创建先后接启用的路由；重名只留第一个。
func domainEntries(s Settings, routes []Route) []entry {
	var out []entry
	seen := map[string]bool{}
	for _, a := range s.Aliases {
		if !seen[a] {
			seen[a] = true
			out = append(out, entry{fqdn: a})
		}
	}
	for i := range routes {
		r := &routes[i]
		if !r.Enabled || seen[r.FQDN] {
			continue
		}
		seen[r.FQDN] = true
		out = append(out, entry{fqdn: r.FQDN, route: r})
	}
	return out
}

func names(es []entry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.fqdn
	}
	return out
}

// upstream：工作台转到明文口；原型在运行时转到它的端口（DOM-02a），没在运行时没有上游。
func upstream(s Settings, e entry) (string, bool) {
	if e.route == nil || e.route.Target.Kind == "app" {
		return fmt.Sprintf("http://127.0.0.1:%d", s.HTTPPort), true
	}
	if e.route.Target.Kind == "proto" && e.route.protoPort > 0 {
		return fmt.Sprintf("http://127.0.0.1:%d", e.route.protoPort), true
	}
	if e.route.Target.Kind == "url" {
		return e.route.Target.URL, true
	}
	return "", false
}

// hostsLines 是要追加进 /etc/hosts 的内容：注释行加每个域名一行（地址和域名之间是制表符，同脚本）。
func hostsLines(s Settings, es []entry) []string {
	lines := []string{hostsHeader}
	for _, e := range es {
		lines = append(lines, s.ip()+"\t"+e.fqdn)
	}
	return lines
}

// pfRules 是 anchor 文件内容，同 setup-local-domain.sh 写的两条；开了局域网访问再加发往 lan_ip 的两条。
func pfRules(s Settings) []string {
	out := []string{
		fmt.Sprintf("rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port %d", s.HTTPPort),
		fmt.Sprintf("rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port %d", s.HTTPSPort),
	}
	if s.LAN {
		out = append(out,
			fmt.Sprintf("rdr pass inet proto tcp from any to %s port 80 -> 127.0.0.1 port %d", s.LANIP, s.HTTPPort),
			fmt.Sprintf("rdr pass inet proto tcp from any to %s port 443 -> 127.0.0.1 port %d", s.LANIP, s.HTTPSPort))
	}
	return out
}

// shq 把字符串包成 shell 单引号。
func shq(v string) string { return "'" + strings.ReplaceAll(v, "'", `'\''`) + "'" }

// printfArg 把多行内容转成 printf 的格式串：换行写 \n、制表符写 \t、% 写 %%。
func printfArg(lines []string) string {
	s := strings.Join(lines, "\n") + "\n"
	s = strings.NewReplacer("%", "%%", `\`, `\\`, "\n", `\n`, "\t", `\t`).Replace(s)
	return shq(s)
}

func (p *Plugin) cdRepo() string { return "cd " + shq(p.opt.RepoDir) }

// setupDomainCmd 是 scripts/setup-local-domain.sh 带上当前域名和端口；sudo 默认清环境变量，所以用 env 传。
func (p *Plugin) setupDomainCmd(s Settings, es []entry) string {
	return fmt.Sprintf("sudo env DOMAINS=%s PORT=%d TLS_PORT=%d ./scripts/setup-local-domain.sh",
		shq(strings.Join(names(es), " ")), s.HTTPPort, s.HTTPSPort)
}

// setupTLSCmd 是 scripts/setup-tls.sh 带上要签的域名（脚本默认还签 localhost 和回环地址）。
func (p *Plugin) setupTLSCmd(es []entry) string {
	hosts := append(names(es), "localhost", "127.0.0.1", "::1")
	return fmt.Sprintf("HOSTS=%s ./scripts/setup-tls.sh", shq(strings.Join(hosts, " ")))
}

func (p *Plugin) render(s Settings, routes []Route, proxy string) Config {
	es := domainEntries(s, routes)
	cfg := Config{Proxy: proxy, Domains: names(es)}
	if cfg.Domains == nil {
		cfg.Domains = []string{}
	}
	cfg.Resolve = p.renderResolve(s, es)
	cfg.PF = p.renderPF(s, es, proxy)
	cfg.ProxyS = renderProxy(s, es, proxy)
	if s.HTTPS {
		c := p.renderCert(es)
		cfg.Cert = &c
	}
	return cfg
}

func (p *Plugin) renderResolve(s Settings, es []entry) Section {
	ip := s.ip()
	switch s.Resolve {
	case "local_dns":
		return Section{
			Kind:    "local_dns",
			Content: fmt.Sprintf("# /opt/homebrew/etc/dnsmasq.conf\naddress=/%s/%s\n\n# /etc/resolver/%s\nnameserver 127.0.0.1", s.Suffix, ip, s.Suffix),
			Commands: []string{
				"brew install dnsmasq",
				fmt.Sprintf(`echo %s >> "$(brew --prefix)/etc/dnsmasq.conf"`, shq("address=/"+s.Suffix+"/"+ip)),
				"sudo mkdir -p /etc/resolver",
				fmt.Sprintf("echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/%s >/dev/null", s.Suffix),
				"sudo brew services restart dnsmasq",
			},
			Note: "整个后缀泛解析到 " + ip + "；局域网设备把 DNS 指到这台电脑也能用",
		}
	case "router_dns":
		return Section{
			Kind:     "router_dns",
			Content:  fmt.Sprintf("# 在路由器的 DNS 设置里加一条泛解析\n*.%s  A  %s", s.Suffix, s.LANIP),
			Commands: []string{},
			Note:     "在路由器或内网 DNS 的管理页里加，本机不用执行命令",
		}
	}
	sec := Section{Kind: "hosts", Path: "/etc/hosts", Commands: []string{}}
	if len(es) == 0 {
		sec.Content = noDomains
		return sec
	}
	lines := hostsLines(s, es)
	sec.Content = strings.Join(lines, "\n")
	sec.Commands = []string{
		"sudo cp /etc/hosts /etc/hosts.bak.$(date +%Y%m%d%H%M%S)",
		"printf " + printfArg(append([]string{""}, lines...)) + " | sudo tee -a /etc/hosts >/dev/null",
		"sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder",
	}
	sec.Note = "追加前先看 /etc/hosts 里有没有这些域名，有的先删掉；只补缺的可以直接用 pf 那段的 setup-local-domain.sh（指到 127.0.0.1）"
	if s.LAN {
		sec.Note = "hosts 文件只对这台电脑生效，局域网访问建议改用本机 DNS 或路由器 DNS；" + sec.Note
	}
	return sec
}

func (p *Plugin) renderPF(s Settings, es []entry, proxy string) Section {
	sec := Section{Kind: "pf", Path: "/etc/pf.anchors/broleez-local", Commands: []string{}}
	if proxy != "builtin" {
		sec.Content = ""
		sec.Note = "Caddy、Nginx 自己监听 80、443，不需要 pf 转发；以前配过 pf 的要先撤掉（sudo ./scripts/teardown-local-domain.sh），不然 80、443 会被转走"
		return sec
	}
	rules := pfRules(s)
	sec.Content = strings.Join(rules, "\n")
	sec.Commands = []string{p.cdRepo(), p.setupDomainCmd(s, es)}
	if s.LAN {
		sec.Commands = append(sec.Commands,
			"printf "+printfArg(rules)+" | sudo tee /etc/pf.anchors/broleez-local >/dev/null",
			"sudo pfctl -f /etc/pf.conf")
	}
	sec.Commands = append(sec.Commands, "sudo pfctl -a broleez-local -s nat")
	sec.Note = fmt.Sprintf("脚本写 anchor、在 /etc/pf.conf 注册、装开机自启（/Library/LaunchDaemons/vip.broleez.pf.plist）并启用 pf，重复执行只补缺的；"+
		"生效后直接访问 127.0.0.1:%d 会被遮蔽，一律用域名", s.HTTPPort)
	if s.LAN {
		sec.Note += "；脚本只写回环那两条，局域网的两条由后面的 tee 覆盖写入"
	}
	return sec
}

// renderProxy 同原型 renderConfig 的 proxy 段。
func renderProxy(s Settings, es []entry, proxy string) Section {
	sec := Section{Kind: proxy, Commands: []string{}}
	if len(es) == 0 {
		sec.Content = noDomains
		return sec
	}
	listen := "127.0.0.1"
	if s.LAN {
		listen = "0.0.0.0"
	}
	var parts []string
	switch proxy {
	case "caddy":
		sec.Path = "Caddyfile"
		for _, e := range es {
			up, ok := upstream(s, e)
			if !ok {
				up = "127.0.0.1:0"
			}
			up = strings.TrimPrefix(strings.TrimPrefix(up, "http://"), "https://")
			scheme, tlsLine := "http://", ""
			if s.HTTPS {
				scheme, tlsLine = "", "tls internal\n  "
			}
			parts = append(parts, fmt.Sprintf("%s%s {\n  bind %s\n  %sreverse_proxy %s\n}", scheme, e.fqdn, listen, tlsLine, up))
		}
		sec.Content = strings.Join(parts, "\n\n")
		sec.Commands = []string{"caddy validate --config ./Caddyfile", "sudo caddy run --config ./Caddyfile"}
		sec.Note = "监听 80、443 要 root；HTTPS 时 Caddy 用自己的本地 CA 签证书（tls internal），第一次要 sudo caddy trust"
	case "nginx":
		port := "80"
		if s.HTTPS {
			port = "443 ssl"
		}
		for _, e := range es {
			up, ok := upstream(s, e)
			if !ok {
				up = "http://127.0.0.1:0"
			}
			parts = append(parts, fmt.Sprintf("server {\n  listen %s:%s;\n  server_name %s;\n  location / {\n    proxy_pass %s;\n"+
				"    proxy_set_header Host $host;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection \"upgrade\";\n  }\n}",
				listen, port, e.fqdn, up))
		}
		sec.Content = strings.Join(parts, "\n\n")
		sec.Commands = []string{"sudo nginx -t", "sudo nginx -s reload"}
		sec.Note = "放进 nginx 的 servers 目录（Homebrew 是 $(brew --prefix)/etc/nginx/servers/）；HTTPS 时每个 server 还要补 ssl_certificate、ssl_certificate_key"
	default:
		for _, e := range es {
			up, ok := upstream(s, e)
			if !ok {
				up = "未运行"
			}
			parts = append(parts, fmt.Sprintf("%s  ->  %s", e.fqdn, up))
		}
		sec.Content = strings.Join(parts, "\n")
		sec.Note = "内置代理会自动应用：经 pf 进来的请求由工作台按域名转发；原型没在运行时回 502 说明页，地址目标只转发本机和局域网地址"
	}
	return sec
}

func (p *Plugin) renderCert(es []entry) Section {
	return Section{
		Kind:    "cert",
		Path:    "certs/pmw.pem",
		Content: "证书要覆盖：" + strings.Join(names(es), " "),
		Commands: []string{
			"brew install mkcert",
			"mkcert -install",
			p.cdRepo(),
			p.setupTLSCmd(es),
			"./scripts/install-autostart.sh",
		},
		Note: "mkcert -install 会弹系统密码框，装过一次就不用再装；签完证书重跑 install-autostart.sh 让常驻进程带上证书",
	}
}

func (h *handlers) config(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s, err := h.loadSettings(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	proxy := s.Proxy
	if v := r.URL.Query().Get("proxy"); v != "" {
		if !contains(proxyKinds, v) {
			h.fail(w, r, apiErr(errValidation, "proxy 只能是 builtin、caddy、nginx"))
			return
		}
		proxy = v
	}
	routes, err := h.loadRoutes(ctx, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": h.p.render(s, routes, proxy)})
}

// isLocalURL：上游是本机或局域网地址（插件只申请了 network:localhost，别的不去请求）。
func isLocalURL(raw, lanIP string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return h == "127.0.0.1" || h == "localhost" || h == "::1" || (lanIP != "" && h == lanIP)
}
