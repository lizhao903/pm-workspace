package domains

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Item 是本机状态的一行：ok 正常、problem 有问题、unknown 没检测到（读不了、命令不在）。
type Item struct {
	Key     string         `json:"key"`
	Group   string         `json:"group"`
	Name    string         `json:"name"`
	State   string         `json:"state"`
	Message string         `json:"message"`
	Fix     *Fix           `json:"fix,omitempty"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// Fix 是有问题时怎么修：一句话加要用户自己执行的命令。
type Fix struct {
	Text     string   `json:"text"`
	Commands []string `json:"commands"`
}

const (
	stOK      = "ok"
	stProblem = "problem"
	stUnknown = "unknown"
)

// Status 是 GET /api/domains/status 的结果。
type Status struct {
	CheckedAt string            `json:"checked_at"`
	Enabled   bool              `json:"enabled"`
	Domains   []string          `json:"domains"`
	Service   map[string]string `json:"service"`
	Items     []Item            `json:"items"`
	Summary   map[string]int    `json:"summary"`
}

func (h *handlers) status(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s, err := h.loadSettings(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	routes, err := h.loadRoutes(ctx, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": h.p.detect(ctx, s, routes)})
}

func (p *Plugin) detect(ctx context.Context, s Settings, routes []Route) Status {
	es := domainEntries(s, routes)
	st := Status{
		CheckedAt: p.sys.Now().UTC().Format(time.RFC3339),
		Enabled:   s.Enabled,
		Domains:   names(es),
		Service:   map[string]string{"addr": p.opt.Addr, "tls_addr": p.opt.TLSAddr},
		Items:     []Item{},
		Summary:   map[string]int{stOK: 0, stProblem: 0, stUnknown: 0},
	}
	if st.Domains == nil {
		st.Domains = []string{}
	}
	if s.Resolve == "hosts" {
		st.Items = append(st.Items, p.checkHosts(s, es)...)
	} else {
		st.Items = append(st.Items, p.checkResolve(ctx, s))
	}
	if s.Proxy == "builtin" {
		st.Items = append(st.Items, p.checkAnchor(s, es), p.checkDaemon(s, es))
	}
	st.Items = append(st.Items, p.checkReach(ctx, s, es, false))
	if s.HTTPS {
		st.Items = append(st.Items, p.checkReach(ctx, s, es, true))
		ca, _ := p.checkCA(ctx)
		st.Items = append(st.Items, ca, p.checkCert(es))
	}
	for _, it := range st.Items {
		st.Summary[it.State]++
	}
	return st
}

// checkHosts：每个启用的域名一行，/etc/hosts 里要指到本机（开了局域网访问是 lan_ip）。
func (p *Plugin) checkHosts(s Settings, es []entry) []Item {
	body, err := readFile(p.sys.HostsFile)
	var out []Item
	if err != nil {
		for _, e := range es {
			out = append(out, Item{Key: "hosts:" + e.fqdn, Group: "hosts", Name: e.fqdn, State: stUnknown,
				Message: fmt.Sprintf("读不了 %s：%v", p.sys.HostsFile, err)})
		}
		return out
	}
	m := parseHosts(body)
	want := s.ip()
	for _, e := range es {
		it := Item{Key: "hosts:" + e.fqdn, Group: "hosts", Name: e.fqdn}
		ips := m[e.fqdn]
		line := want + "\t" + e.fqdn
		switch {
		case slices.Contains(ips, want):
			it.State, it.Message = stOK, fmt.Sprintf("%s 指到 %s", e.fqdn, want)
		case len(ips) == 0:
			it.State, it.Message = stProblem, fmt.Sprintf("hosts 里没有 %s", e.fqdn)
			it.Fix = &Fix{Text: "在 /etc/hosts 末尾追加一行：" + strings.ReplaceAll(line, "\t", " "),
				Commands: []string{"printf " + printfArg([]string{line}) + " | sudo tee -a /etc/hosts >/dev/null",
					"sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder"}}
		default:
			it.State, it.Message = stProblem, fmt.Sprintf("%s 指到了 %s", e.fqdn, ips[0])
			it.Fix = &Fix{Text: fmt.Sprintf("把 /etc/hosts 里 %s 那一行的地址改成 %s", e.fqdn, want),
				Commands: []string{"sudo nano /etc/hosts", "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder"}}
		}
		out = append(out, it)
	}
	return out
}

// checkResolve：解析方式不是 hosts 时，看后缀下随便一个名字能不能解析到本机。
func (p *Plugin) checkResolve(ctx context.Context, s Settings) Item {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	name := "pmw-check-" + hex.EncodeToString(b) + "." + s.Suffix
	want := s.ip()
	if s.Resolve == "router_dns" {
		want = s.LANIP
	}
	it := Item{Key: "resolve", Group: "resolve", Name: s.Suffix + " 能不能解析到本机"}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ips, err := p.sys.Lookup(ctx, name)
	switch {
	case err != nil || len(ips) == 0:
		it.State, it.Message = stProblem, fmt.Sprintf("%s 下的名字解析不了", s.Suffix)
	case slices.Contains(ips, want):
		it.State, it.Message = stOK, fmt.Sprintf("%s 下的名字解析到 %s", s.Suffix, want)
	default:
		it.State, it.Message = stProblem, fmt.Sprintf("%s 下的名字解析到了 %s，不是 %s", s.Suffix, ips[0], want)
	}
	if it.State == stProblem {
		sec := p.renderResolve(s, nil)
		it.Fix = &Fix{Text: "按生成的配置加泛解析", Commands: sec.Commands}
	}
	return it
}

// checkAnchor：anchor 文件在、80 和 443 的 rdr 转到工作台的明文口和 TLS 口、/etc/pf.conf 里注册了。
func (p *Plugin) checkAnchor(s Settings, es []entry) Item {
	it := Item{Key: "pf_anchor", Group: "pf", Name: "pf 端口转发"}
	fix := &Fix{Text: "重跑 setup-local-domain.sh（写 anchor、注册 pf.conf、装开机自启，重复执行只补缺的）",
		Commands: []string{p.cdRepo(), p.setupDomainCmd(s, es), "sudo pfctl -a " + p.sys.anchorName() + " -s nat"}}
	body, err := readFile(p.sys.PFAnchor)
	if isNotExist(err) {
		it.State, it.Message, it.Fix = stProblem, "没有 "+p.sys.PFAnchor+"，80、443 不会转到工作台", fix
		return it
	}
	if err != nil {
		it.State, it.Message = stUnknown, fmt.Sprintf("读不了 %s：%v", p.sys.PFAnchor, err)
		return it
	}
	rules := parsePF(body)
	got := map[int]int{}
	for _, r := range rules {
		if r.dst == "127.0.0.1" && r.to == "127.0.0.1" {
			got[r.port] = r.toPort
		}
	}
	it.Detail = map[string]any{"http_to": got[80], "https_to": got[443]}
	var bad []string
	want := map[int]int{80: s.HTTPPort}
	if s.HTTPS {
		want[443] = s.HTTPSPort
	}
	for _, port := range []int{80, 443} {
		w, need := want[port]
		if !need {
			continue
		}
		switch g := got[port]; {
		case g == 0:
			bad = append(bad, fmt.Sprintf("缺 %d 的转发规则", port))
		case g != w:
			bad = append(bad, fmt.Sprintf("%d 转到了 %d，应该是 %d", port, g, w))
		}
	}
	mount, load := pfRegistered(readOrEmpty(p.sys.PFConf), p.sys.anchorName(), p.sys.PFAnchor)
	if !mount || !load {
		bad = append(bad, p.sys.PFConf+" 没注册这个 anchor，规则不会加载（系统升级可能重置了 pf.conf）")
	}
	if len(bad) > 0 {
		it.State, it.Message, it.Fix = stProblem, strings.Join(bad, "；"), fix
		return it
	}
	it.State = stOK
	it.Message = fmt.Sprintf("80 转到 %d", s.HTTPPort)
	if s.HTTPS {
		it.Message += fmt.Sprintf("，443 转到 %d", s.HTTPSPort)
	}
	if p.opt.Addr != "" && portOf(p.opt.Addr) != s.HTTPPort {
		it.Message += fmt.Sprintf("（本服务明文口是 %s，经域名访问到的不是本服务）", p.opt.Addr)
	}
	return it
}

func readOrEmpty(path string) string {
	b, _ := readFile(path)
	return b
}

func portOf(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	var n int
	_, _ = fmt.Sscanf(port, "%d", &n)
	return n
}

// checkDaemon：开机重新加载 pf 的 LaunchDaemon 在不在（macOS 上 pf 默认不开机自启）。
func (p *Plugin) checkDaemon(s Settings, es []entry) Item {
	it := Item{Key: "pf_autostart", Group: "pf", Name: "开机自启"}
	body, err := readFile(p.sys.PFDaemon)
	switch {
	case isNotExist(err):
		it.State, it.Message = stProblem, "没有 "+p.sys.PFDaemon+"，重启后域名会失效"
	case err != nil:
		it.State, it.Message = stUnknown, fmt.Sprintf("读不了 %s：%v", p.sys.PFDaemon, err)
	case !strings.Contains(body, "pfctl"):
		it.State, it.Message = stProblem, p.sys.PFDaemon+" 里没有重新加载 pf 的命令"
	default:
		it.State, it.Message = stOK, "开机会重新加载并启用 pf"
	}
	if it.State == stProblem {
		it.Fix = &Fix{Text: "重跑 setup-local-domain.sh 装开机自启", Commands: []string{p.cdRepo(), p.setupDomainCmd(s, es)}}
	}
	return it
}

// mainDomain 是可达检测用的域名：第一条启用的工作台路由，没有就第一个别名，再没有用后缀。
func mainDomain(s Settings, es []entry) string {
	for _, e := range es {
		if e.route != nil && e.route.Target.Kind == "app" {
			return e.fqdn
		}
	}
	if len(es) > 0 {
		return es[0].fqdn
	}
	return s.Suffix
}

// checkReach：带 Host 头请求 127.0.0.1:80（或 443），看能不能回到本服务。
func (p *Plugin) checkReach(ctx context.Context, s Settings, es []entry, useTLS bool) Item {
	addr, key, name := p.sys.HTTPAddr, "reach_http", "80 可达"
	if useTLS {
		addr, key, name = p.sys.HTTPSAddr, "reach_https", "443 可达"
	}
	host := mainDomain(s, es)
	it := Item{Key: key, Group: "reach", Name: name, Detail: map[string]any{"host": host, "addr": addr}}
	code, inst, err := probe(ctx, addr, host, useTLS)
	switch {
	case err != nil:
		it.State = stProblem
		it.Message = fmt.Sprintf("带 Host: %s 连 %s 连不上", host, addr)
		if s.Proxy == "builtin" {
			it.Message += "：pf 没加载、规则没生效，或者工作台没在对应端口监听"
			if useTLS {
				it.Message += "（要带 --tls-addr 和证书启动）"
			}
		}
	case inst == p.inst:
		it.State, it.Message = stOK, fmt.Sprintf("带 Host: %s 请求 %s 回到了本服务", host, addr)
	default:
		it.State = stProblem
		it.Message = fmt.Sprintf("%s 有回应（HTTP %d），但不是本服务：多半转到了另一个工作台实例", addr, code)
		if p.opt.Addr != "" {
			it.Message += "，本服务明文口是 " + p.opt.Addr
		}
	}
	if it.State == stProblem && s.Proxy == "builtin" {
		it.Fix = &Fix{Text: fmt.Sprintf("确认 pf 规则已加载，工作台在 %d、%d 上监听", s.HTTPPort, s.HTTPSPort),
			Commands: []string{p.cdRepo(), p.setupDomainCmd(s, es), "./scripts/install-autostart.sh"}}
	}
	return it
}

// checkCA：mkcert 的根证书在不在、系统钥匙串信不信它。第二个返回值是「已装并受信任」。
func (p *Plugin) checkCA(ctx context.Context) (Item, bool) {
	it := Item{Key: "ca", Group: "cert", Name: "本地根证书"}
	installFix := &Fix{Text: "装一次本地根证书（会弹系统密码框）", Commands: []string{"mkcert -install"}}
	out, err := p.sys.Run(ctx, "mkcert", "-CAROOT")
	if err != nil {
		if errors.Is(err, errNoCommand) {
			it.State, it.Message = stProblem, "没装 mkcert"
			it.Fix = &Fix{Text: "先装 mkcert，再装本地根证书", Commands: []string{"brew install mkcert", "mkcert -install"}}
			return it, false
		}
		it.State, it.Message = stUnknown, fmt.Sprintf("mkcert -CAROOT 失败：%v", err)
		return it, false
	}
	root := filepath.Join(strings.TrimSpace(out), "rootCA.pem")
	it.Detail = map[string]any{"path": root}
	if _, err := readFile(root); err != nil {
		it.State, it.Message, it.Fix = stProblem, "本地根证书还没生成："+root+" 不在", installFix
		return it, false
	}
	if _, err := p.sys.Run(ctx, "security", "verify-cert", "-c", root, "-l", "-L", "-q"); err != nil {
		it.State, it.Message, it.Fix = stProblem, "本地根证书还没装进系统钥匙串，浏览器会提示连接不安全", installFix
		return it, false
	}
	it.State, it.Message = stOK, "本地根证书已装进系统钥匙串"
	return it, true
}

// checkCert：证书目录下的站点证书覆盖了哪些启用的域名、哪天到期；30 天内到期算有问题。
func (p *Plugin) checkCert(es []entry) Item {
	it := Item{Key: "cert", Group: "cert", Name: "站点证书"}
	fix := &Fix{Text: "重新签发覆盖全部域名的证书，再重启常驻服务", Commands: []string{p.cdRepo(), p.setupTLSCmd(es), "./scripts/install-autostart.sh"}}
	certs, err := readCerts(p.sys.CertDir)
	if err != nil && !isNotExist(err) {
		it.State, it.Message = stUnknown, fmt.Sprintf("读不了 %s：%v", p.sys.CertDir, err)
		return it
	}
	if len(certs) == 0 {
		it.State, it.Message, it.Fix = stProblem, p.sys.CertDir+" 下没有证书", fix
		return it
	}
	now := p.sys.Now()
	var covered, missing []string
	var expiry time.Time
	for _, e := range es {
		ok := false
		for _, c := range certs {
			if covers(c.DNSNames, e.fqdn) {
				ok = true
				if expiry.IsZero() || c.NotAfter.Before(expiry) {
					expiry = c.NotAfter
				}
			}
		}
		if ok {
			covered = append(covered, e.fqdn)
		} else {
			missing = append(missing, e.fqdn)
		}
	}
	it.Detail = map[string]any{"certs": certs, "covered": nonNil(covered), "missing": nonNil(missing)}
	if !expiry.IsZero() {
		it.Detail["not_after"] = expiry.UTC().Format(time.RFC3339)
	}
	var bad []string
	if len(missing) > 0 {
		bad = append(bad, "没覆盖："+strings.Join(missing, "、"))
	}
	switch {
	case expiry.IsZero():
	case !expiry.After(now):
		bad = append(bad, "已经过期（"+expiry.Format("2006-01-02")+"）")
	case expiry.Sub(now) < 30*24*time.Hour:
		bad = append(bad, "30 天内到期（"+expiry.Format("2006-01-02")+"）")
	}
	if len(bad) > 0 {
		it.State, it.Message, it.Fix = stProblem, strings.Join(bad, "；"), fix
		return it
	}
	it.State = stOK
	it.Message = fmt.Sprintf("覆盖 %s，%s 到期", strings.Join(covered, "、"), expiry.Format("2006-01-02"))
	return it
}

func nonNil(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

// checkRoute 是 POST /api/domains/routes/{id}/check：原型「测试」的检查之外，真的解析一次、带 Host 头请求一次，
// HTTPS 开着时看站点证书覆盖没有。结果按完整域名另存，不改路由。
func (h *handlers) checkRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s, err := h.loadSettings(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	rt, err := h.getRoute(ctx, r.PathValue("id"), s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	routes, err := h.loadRoutes(ctx, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ok, msg := h.p.testRoute(ctx, s, rt, routes)
	c := Check{OK: ok, At: h.p.sys.Now().UTC().Format(time.RFC3339), Message: msg}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO domains_checks (fqdn, ok, at, message) VALUES (?, ?, ?, ?)
		ON CONFLICT(fqdn) DO UPDATE SET ok = excluded.ok, at = excluded.at, message = excluded.message`,
		rt.FQDN, c.OK, c.At, c.Message); err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"id": rt.ID, "fqdn": rt.FQDN, "check": c}})
}

func (p *Plugin) testRoute(ctx context.Context, s Settings, rt Route, routes []Route) (bool, string) {
	if !validSuffix(s.Suffix) {
		return false, "后缀不合法"
	}
	for _, o := range routes {
		if o.ID != rt.ID && o.Enabled && rt.Enabled && o.FQDN == rt.FQDN {
			return false, "和另一条同名"
		}
	}
	if slices.Contains(s.Aliases, rt.FQDN) && rt.Target.Kind != "app" {
		return false, "和工作台的别名同名"
	}
	if rt.Target.Kind == "proto" {
		return false, "目标是项目原型，要等原型联动（DOM-02a）接上才能测"
	}
	var caOK bool
	if s.HTTPS {
		if _, caOK = p.checkCA(ctx); !caOK {
			return false, "HTTPS 开着但本地根证书没装"
		}
	}
	lctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	ips, err := p.sys.Lookup(lctx, rt.FQDN)
	cancel()
	want := s.ip()
	if err != nil || len(ips) == 0 {
		return false, fmt.Sprintf("%s 解析不了", rt.FQDN)
	}
	if !slices.Contains(ips, want) {
		return false, fmt.Sprintf("%s 解析到 %s，不是 %s", rt.FQDN, ips[0], want)
	}
	up, _ := upstream(s, entry{fqdn: rt.FQDN, route: &rt})
	if rt.Target.Kind == "app" {
		// 工作台：走一遍 pf，带 Host 头看能不能回到本服务
		addr := p.sys.HTTPAddr
		_, inst, err := probe(ctx, addr, rt.FQDN, false)
		if err != nil {
			return false, fmt.Sprintf("%s 解析到 %s，但带 Host 头连 %s 连不上", rt.FQDN, want, addr)
		}
		if inst != p.inst {
			return false, fmt.Sprintf("%s 解析到 %s，但 %s 回来的不是本服务", rt.FQDN, want, addr)
		}
	} else if isLocalURL(up, s.LANIP) {
		if _, err := probeURL(ctx, up); err != nil {
			return false, fmt.Sprintf("%s 解析到 %s，但上游 %s 没有回应", rt.FQDN, want, up)
		}
	}
	if s.HTTPS {
		certs, _ := readCerts(p.sys.CertDir)
		covered := false
		for _, c := range certs {
			if covers(c.DNSNames, rt.FQDN) && c.NotAfter.After(p.sys.Now()) {
				covered = true
			}
		}
		if !covered {
			return false, fmt.Sprintf("站点证书没覆盖 %s", rt.FQDN)
		}
	}
	return true, fmt.Sprintf("%s 解析到 %s，转发到 %s", rt.FQDN, want, up)
}
