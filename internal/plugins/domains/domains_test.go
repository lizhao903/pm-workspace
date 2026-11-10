// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domains

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "domains" || m.TablePrefix != "domains_" {
		t.Fatalf("id=%s table_prefix=%s", m.ID, m.TablePrefix)
	}
	for _, want := range []string{"fs:read:any", "process:spawn", "network:localhost"} {
		if !contains(m.Permissions, want) {
			t.Fatalf("permissions 缺 %s：%v", want, m.Permissions)
		}
	}
}

// fakeSys 是指向临时目录的系统：hosts、pf、证书都写在 dir 下，外部命令和解析由测试给。
type fakeSys struct {
	dir     string
	sys     System
	ran     []string
	mkcert  string // mkcert -CAROOT 的输出，空串表示没装
	trusted bool
	lookup  map[string][]string
}

func newFakeSys(t *testing.T) *fakeSys {
	t.Helper()
	dir := t.TempDir()
	f := &fakeSys{dir: dir, lookup: map[string][]string{}}
	f.sys = System{
		HostsFile: filepath.Join(dir, "etc", "hosts"),
		PFAnchor:  filepath.Join(dir, "etc", "pf.anchors", "broleez-local"),
		PFConf:    filepath.Join(dir, "etc", "pf.conf"),
		PFDaemon:  filepath.Join(dir, "Library", "LaunchDaemons", "vip.broleez.pf.plist"),
		CertDir:   filepath.Join(dir, "certs"),
		HTTPAddr:  "127.0.0.1:1", // 没人监听
		HTTPSAddr: "127.0.0.1:1",
		Now:       func() time.Time { return time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC) },
		Run: func(_ context.Context, name string, args ...string) (string, error) {
			f.ran = append(f.ran, name+" "+strings.Join(args, " "))
			switch name {
			case "mkcert":
				if f.mkcert == "" {
					return "", fmt.Errorf("%w: mkcert", errNoCommand)
				}
				return f.mkcert + "\n", nil
			case "security":
				if f.trusted {
					return "", nil
				}
				return "", errors.New("exit status 1")
			}
			return "", errors.New("unexpected command " + name)
		},
		Lookup: func(_ context.Context, host string) ([]string, error) {
			if ips, ok := f.lookup[host]; ok {
				return ips, nil
			}
			return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
		},
	}
	return f
}

func (f *fakeSys) write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 按 docs/local-domain.md 配好的 bro.vip：hosts、anchor、pf.conf 注册、LaunchDaemon 都在（内容同 scripts/setup-local-domain.sh 写的）
func (f *fakeSys) configured(t *testing.T) {
	f.write(t, f.sys.HostsFile, "127.0.0.1\tlocalhost\n\n"+hostsHeader+"\n127.0.0.1\tbroleez.vip\n127.0.0.1\tbro.vip\n")
	f.write(t, f.sys.PFAnchor, "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port 7777\n"+
		"rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port 7443\n")
	f.write(t, f.sys.PFConf, "scrub-anchor \"com.apple/*\"\nrdr-anchor \"com.apple/*\"\nrdr-anchor \"broleez-local\"\n"+
		"load anchor \"com.apple\" from \"/etc/pf.anchors/com.apple\"\n"+
		fmt.Sprintf("load anchor \"broleez-local\" from \"%s\"\n", f.sys.PFAnchor))
	f.write(t, f.sys.PFDaemon, "<string>/sbin/pfctl -f /etc/pf.conf; /sbin/pfctl -E</string>")
}

// 在真库上装好、启用插件，返回挂了插件路由的 handler
func setup(t *testing.T, p *Plugin) http.Handler {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "domains", []string{"network:localhost"}); err == nil {
		t.Fatal("没勾高风险权限也装上了")
	}
	if err := r.Install(ctx, "domains", []string{"fs:read:any", "process:spawn", "network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "domains"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return mux
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s 回的不是 JSON：%s", method, path, w.Body.String())
	}
	return w.Code, out
}

func data(t *testing.T, h http.Handler, method, path, body string) map[string]any {
	t.Helper()
	code, out := call(t, h, method, path, body)
	if code/100 != 2 {
		t.Fatalf("%s %s = %d %v", method, path, code, out)
	}
	m, _ := out["data"].(map[string]any)
	return m
}

func newPlugin(f *fakeSys) *Plugin {
	return New(Options{Addr: "127.0.0.1:7777", RepoDir: "/repo"}).WithSystem(f.sys)
}

func TestDefaultsAreBroVip(t *testing.T) {
	h := setup(t, newPlugin(newFakeSys(t)))
	s := data(t, h, "GET", "/api/domains/settings", "")
	if s["suffix"] != "bro.vip" || s["resolve"] != "hosts" || s["proxy"] != "builtin" || s["https"] != true {
		t.Fatalf("默认设置不是 bro.vip 方案：%v", s)
	}
	if fmt.Sprint(s["aliases"]) != "[broleez.vip]" || s["http_port"] != float64(7777) || s["https_port"] != float64(7443) {
		t.Fatalf("别名或端口不对：%v", s)
	}
	_, out := call(t, h, "GET", "/api/domains/routes", "")
	rows := out["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("默认路由 %v", rows)
	}
	app := rows[0].(map[string]any)
	if app["id"] != "dm_app" || app["host"] != "" || app["fqdn"] != "bro.vip" || app["target"].(map[string]any)["kind"] != "app" {
		t.Fatalf("工作台那条不对：%v", app)
	}
}

func TestSuffixLocalRejected(t *testing.T) {
	h := setup(t, newPlugin(newFakeSys(t)))
	for _, sfx := range []string{"pmw.local", "local", "PMW.LOCAL", "bad_suffix", ""} {
		code, out := call(t, h, "PUT", "/api/domains/settings", fmt.Sprintf(`{"suffix":%q}`, sfx))
		if code != http.StatusBadRequest {
			t.Fatalf("后缀 %q 回 %d %v", sfx, code, out)
		}
	}
	code, out := call(t, h, "PUT", "/api/domains/settings", `{"suffix":"pmw.local"}`)
	msg := out["error"].(map[string]any)["message"].(string)
	if code != 400 || !strings.Contains(msg, ".local") {
		t.Fatalf("%d %s", code, msg)
	}
	if code, _ := call(t, h, "PUT", "/api/domains/settings", `{"aliases":["x.local"]}`); code != 400 {
		t.Fatalf("别名 .local 回 %d", code)
	}
	// 合法的后缀：去空格、转小写
	s := data(t, h, "PUT", "/api/domains/settings", `{"suffix":" PMW.lan "}`)
	if s["suffix"] != "pmw.lan" {
		t.Fatalf("suffix=%v", s["suffix"])
	}
	if code, _ := call(t, h, "PUT", "/api/domains/settings", `{"lan":true,"lan_ip":"abc"}`); code != 400 {
		t.Fatalf("lan_ip 不合法回 %d", code)
	}
	if code, _ := call(t, h, "PUT", "/api/domains/settings", `{"resolve":"mdns"}`); code != 400 {
		t.Fatalf("resolve 不合法回 %d", code)
	}
}

func TestRoutesCRUD(t *testing.T) {
	h := setup(t, newPlugin(newFakeSys(t)))
	data(t, h, "PUT", "/api/domains/settings", `{"suffix":"pmw.lan","aliases":[]}`)
	r := data(t, h, "POST", "/api/domains/routes", `{"host":"Video","target":{"kind":"url","url":"http://127.0.0.1:7801"},"note":"视频"}`)
	id := r["id"].(string)
	if !regexp.MustCompile(`^dm_`).MatchString(id) || r["fqdn"] != "video.pmw.lan" || r["enabled"] != true || r["auto"] != false {
		t.Fatalf("新建 %v", r)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes", `{"host":"video","target":{"kind":"app"}}`); code != 409 {
		t.Fatalf("重名回 %d", code)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes", `{"host":"","target":{"kind":"url","url":"http://127.0.0.1:1"}}`); code != 400 {
		t.Fatalf("非工作台空子域名回 %d", code)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes", `{"host":"a_b","target":{"kind":"app"}}`); code != 400 {
		t.Fatalf("子域名不合法回 %d", code)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes", `{"host":"p","target":{"kind":"proto"}}`); code != 400 {
		t.Fatalf("原型没选回 %d", code)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes", `{"host":"p","target":{"kind":"url","url":"ftp://x"}}`); code != 400 {
		t.Fatalf("地址不合法回 %d", code)
	}
	r = data(t, h, "PATCH", "/api/domains/routes/"+id, `{"enabled":false}`)
	if r["enabled"] != false || r["host"] != "video" {
		t.Fatalf("改后 %v", r)
	}
	if code, _ := call(t, h, "DELETE", "/api/domains/routes/dm_app", ""); code != 409 {
		t.Fatalf("删工作台那条回 %d", code)
	}
	if code, _ := call(t, h, "DELETE", "/api/domains/routes/"+id, ""); code != 200 {
		t.Fatalf("删除回 %d", code)
	}
	if code, _ := call(t, h, "PATCH", "/api/domains/routes/"+id, `{"enabled":true}`); code != 404 {
		t.Fatalf("删后改回 %d", code)
	}
}

// 对 bro.vip 生成的 hosts 行和 pf 规则要和 docs/local-domain.md 逐行一致
func TestConfigMatchesLocalDomainDoc(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/local-domain.md")
	if err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile("../../../scripts/setup-local-domain.sh")
	if err != nil {
		t.Fatal(err)
	}
	h := setup(t, newPlugin(newFakeSys(t)))
	cfg := data(t, h, "GET", "/api/domains/config", "")
	if fmt.Sprint(cfg["domains"]) != "[broleez.vip bro.vip]" {
		t.Fatalf("domains=%v", cfg["domains"])
	}

	// hosts：文档写的是「加 `127.0.0.1 broleez.vip` 和 `127.0.0.1 bro.vip`」，脚本按 127.0.0.1<TAB>域名 写，先写注释行
	resolve := cfg["resolve"].(map[string]any)
	gotHosts := strings.Split(resolve["content"].(string), "\n")
	wantHosts := []string{hostsHeader, "127.0.0.1\tbroleez.vip", "127.0.0.1\tbro.vip"}
	if strings.Join(gotHosts, "\n") != strings.Join(wantHosts, "\n") {
		t.Fatalf("hosts 片段：\n%q\n要：\n%q", gotHosts, wantHosts)
	}
	for _, l := range wantHosts[1:] {
		if !strings.Contains(string(doc), "`"+strings.ReplaceAll(l, "\t", " ")+"`") {
			t.Fatalf("文档里没有 %q", l)
		}
	}
	if !strings.Contains(string(script), strings.TrimPrefix(hostsHeader, "# ")) || !strings.Contains(string(script), `printf '127.0.0.1\t%s\n'`) {
		t.Fatal("脚本写 hosts 的格式变了，生成的片段要跟着改")
	}

	// pf：文档代码块里的两条规则（文档为了对齐多空了一格，pf 不在乎空白，按空白归一后比）
	norm := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	var docRules []string
	for _, l := range strings.Split(string(doc), "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "rdr pass ") {
			docRules = append(docRules, norm(l))
		}
	}
	pf := cfg["pf"].(map[string]any)
	gotPF := strings.Split(pf["content"].(string), "\n")
	if len(docRules) != 2 || len(gotPF) != 2 {
		t.Fatalf("文档 %d 条、生成 %d 条", len(docRules), len(gotPF))
	}
	for i := range gotPF {
		if norm(gotPF[i]) != docRules[i] {
			t.Fatalf("第 %d 条：生成 %q，文档 %q", i+1, gotPF[i], docRules[i])
		}
		// 和脚本写进 anchor 的那两行一字不差（脚本里端口是变量）
		scriptLine := strings.NewReplacer("7777", "${PORT}", "7443", "${TLS_PORT}").Replace(gotPF[i])
		if !strings.Contains(string(script), scriptLine+"\n") {
			t.Fatalf("脚本里没有 %q", scriptLine)
		}
	}
	cmds := strings.Join(toStrings(pf["commands"]), "\n")
	if !strings.Contains(cmds, `sudo env DOMAINS='broleez.vip bro.vip' PORT=7777 TLS_PORT=7443 ./scripts/setup-local-domain.sh`) ||
		!strings.Contains(cmds, "cd '/repo'") {
		t.Fatalf("pf 命令 %s", cmds)
	}
	cert := cfg["cert"].(map[string]any)
	if !strings.Contains(strings.Join(toStrings(cert["commands"]), "\n"), `HOSTS='broleez.vip bro.vip localhost 127.0.0.1 ::1' ./scripts/setup-tls.sh`) {
		t.Fatalf("证书命令 %v", cert["commands"])
	}
	// 内置代理：域名 -> 上游
	if got := cfg["proxy_config"].(map[string]any)["content"]; got != "broleez.vip  ->  http://127.0.0.1:7777\nbro.vip  ->  http://127.0.0.1:7777" {
		t.Fatalf("内置代理 %q", got)
	}
}

func TestConfigProxyVariants(t *testing.T) {
	h := setup(t, newPlugin(newFakeSys(t)))
	data(t, h, "PUT", "/api/domains/settings", `{"suffix":"pmw.lan","aliases":[],"https":false}`)
	data(t, h, "POST", "/api/domains/routes", `{"host":"video","target":{"kind":"url","url":"http://127.0.0.1:7801"}}`)
	cfg := data(t, h, "GET", "/api/domains/config?proxy=caddy", "")
	want := "http://pmw.lan {\n  bind 127.0.0.1\n  reverse_proxy 127.0.0.1:7777\n}\n\nhttp://video.pmw.lan {\n  bind 127.0.0.1\n  reverse_proxy 127.0.0.1:7801\n}"
	if got := cfg["proxy_config"].(map[string]any)["content"]; got != want {
		t.Fatalf("caddy:\n%s", got)
	}
	if cfg["cert"] != nil {
		t.Fatal("HTTPS 关着不该有证书段")
	}
	if cfg["pf"].(map[string]any)["content"] != "" {
		t.Fatal("Caddy 不需要 pf")
	}
	cfg = data(t, h, "GET", "/api/domains/config?proxy=nginx", "")
	if got := cfg["proxy_config"].(map[string]any)["content"].(string); !strings.Contains(got, "  listen 127.0.0.1:80;\n  server_name video.pmw.lan;\n  location / {\n    proxy_pass http://127.0.0.1:7801;") {
		t.Fatalf("nginx:\n%s", got)
	}
	if code, _ := call(t, h, "GET", "/api/domains/config?proxy=apache", ""); code != 400 {
		t.Fatalf("proxy 不合法回 %d", code)
	}
	// 本机 DNS、局域网
	data(t, h, "PUT", "/api/domains/settings", `{"resolve":"local_dns","lan":true,"lan_ip":"192.168.1.23"}`)
	cfg = data(t, h, "GET", "/api/domains/config", "")
	if got := cfg["resolve"].(map[string]any)["content"]; got != "# /opt/homebrew/etc/dnsmasq.conf\naddress=/pmw.lan/192.168.1.23\n\n# /etc/resolver/pmw.lan\nnameserver 127.0.0.1" {
		t.Fatalf("dnsmasq %q", got)
	}
	if got := cfg["pf"].(map[string]any)["content"].(string); !strings.Contains(got, "to 192.168.1.23 port 80 -> 127.0.0.1 port 7777") {
		t.Fatalf("局域网 pf %q", got)
	}
	// 没有启用的域名
	_, out := call(t, h, "GET", "/api/domains/routes", "")
	for _, row := range out["data"].([]any) {
		id := row.(map[string]any)["id"].(string)
		data(t, h, "PATCH", "/api/domains/routes/"+id, `{"enabled":false}`)
	}
	data(t, h, "PUT", "/api/domains/settings", `{"resolve":"hosts","lan":false}`)
	cfg = data(t, h, "GET", "/api/domains/config", "")
	if cfg["resolve"].(map[string]any)["content"] != noDomains || cfg["proxy_config"].(map[string]any)["content"] != noDomains {
		t.Fatalf("没有启用的域名：%v", cfg)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func items(t *testing.T, st map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, x := range st["items"].([]any) {
		it := x.(map[string]any)
		out[it["key"].(string)] = it
	}
	return out
}

// 没配过：hosts、pf、证书都报有问题，并给出命令；系统路径都在临时目录
func TestStatusNothingConfigured(t *testing.T) {
	f := newFakeSys(t)
	f.write(t, f.sys.HostsFile, "127.0.0.1\tlocalhost\n10.0.0.9 bro.vip\n")
	h := setup(t, newPlugin(f))
	st := data(t, h, "GET", "/api/domains/status", "")
	it := items(t, st)
	want := map[string]string{
		"hosts:broleez.vip": "hosts 里没有 broleez.vip",
		"hosts:bro.vip":     "bro.vip 指到了 10.0.0.9",
		"pf_anchor":         "没有 ",
		"pf_autostart":      "重启后域名会失效",
		"reach_http":        "连不上",
		"reach_https":       "连不上",
		"ca":                "没装 mkcert",
		"cert":              "下没有证书",
	}
	for k, msg := range want {
		x, ok := it[k]
		if !ok {
			t.Fatalf("没有 %s：%v", k, st["items"])
		}
		if x["state"] != stProblem || !strings.Contains(x["message"].(string), msg) || x["fix"] == nil {
			t.Fatalf("%s = %v", k, x)
		}
	}
	if len(it) != len(want) {
		t.Fatalf("多了检测项：%v", st["items"])
	}
	fix := it["hosts:broleez.vip"]["fix"].(map[string]any)
	if !strings.Contains(strings.Join(toStrings(fix["commands"]), "\n"), `printf '127.0.0.1\tbroleez.vip\n' | sudo tee -a /etc/hosts`) {
		t.Fatalf("hosts 修法 %v", fix)
	}
}

// 按 local-domain.md 配好：hosts、pf、开机自启、证书都正常；80 回到本服务
func TestStatusConfigured(t *testing.T) {
	f := newFakeSys(t)
	f.configured(t)
	caDir := filepath.Join(f.dir, "mkcert")
	f.write(t, filepath.Join(caDir, "rootCA.pem"), "x")
	f.mkcert, f.trusted = caDir, true
	writeCert(t, filepath.Join(f.sys.CertDir, "pmw.pem"), []string{"broleez.vip", "bro.vip", "localhost"}, f.sys.Now().Add(800*24*time.Hour))
	f.write(t, filepath.Join(f.sys.CertDir, "pmw-key.pem"), "not a cert")
	p := newPlugin(f)
	h := setup(t, p)
	// 80 上放一个本服务（同一个 handler），443 上放一个别的服务
	self := httptest.NewServer(h)
	defer self.Close()
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
	defer other.Close()
	p.sys.HTTPAddr = strings.TrimPrefix(self.URL, "http://")
	p.sys.HTTPSAddr = strings.TrimPrefix(other.URL, "https://")

	it := items(t, data(t, h, "GET", "/api/domains/status", ""))
	for _, k := range []string{"hosts:broleez.vip", "hosts:bro.vip", "pf_anchor", "pf_autostart", "reach_http", "ca", "cert"} {
		if it[k]["state"] != stOK {
			t.Fatalf("%s = %v", k, it[k])
		}
	}
	if !strings.Contains(it["cert"]["message"].(string), "覆盖 broleez.vip、bro.vip") {
		t.Fatalf("cert %v", it["cert"])
	}
	if x := it["reach_https"]; x["state"] != stProblem || !strings.Contains(x["message"].(string), "不是本服务") {
		t.Fatalf("443 转到别的服务 %v", x)
	}
	wantRan := []string{"mkcert -CAROOT", "security verify-cert -c " + filepath.Join(caDir, "rootCA.pem") + " -l -L -q"}
	if strings.Join(f.ran, "|") != strings.Join(wantRan, "|") {
		t.Fatalf("调了 %v", f.ran)
	}

	// 本机现状那种：anchor 只有 80 一条，pf.conf 没注册
	f.write(t, f.sys.PFAnchor, "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port 7777\n")
	f.write(t, f.sys.PFConf, "rdr-anchor \"com.apple/*\"\n")
	it = items(t, data(t, h, "GET", "/api/domains/status", ""))
	msg := it["pf_anchor"]["message"].(string)
	if it["pf_anchor"]["state"] != stProblem || !strings.Contains(msg, "缺 443 的转发规则") || !strings.Contains(msg, "没注册这个 anchor") {
		t.Fatalf("pf_anchor %v", it["pf_anchor"])
	}
	// 证书没覆盖新加的域名、快到期
	writeCert(t, filepath.Join(f.sys.CertDir, "pmw.pem"), []string{"bro.vip"}, f.sys.Now().Add(10*24*time.Hour))
	it = items(t, data(t, h, "GET", "/api/domains/status", ""))
	msg = it["cert"]["message"].(string)
	if !strings.Contains(msg, "没覆盖：broleez.vip") || !strings.Contains(msg, "30 天内到期") {
		t.Fatalf("cert %v", it["cert"])
	}
	// 根证书没受信任
	f.trusted = false
	it = items(t, data(t, h, "GET", "/api/domains/status", ""))
	if it["ca"]["state"] != stProblem || !strings.Contains(it["ca"]["message"].(string), "还没装进系统钥匙串") {
		t.Fatalf("ca %v", it["ca"])
	}
}

func TestRouteCheck(t *testing.T) {
	f := newFakeSys(t)
	f.configured(t)
	p := newPlugin(f)
	h := setup(t, p)
	self := httptest.NewServer(h)
	defer self.Close()
	p.sys.HTTPAddr = strings.TrimPrefix(self.URL, "http://")
	data(t, h, "PUT", "/api/domains/settings", `{"https":false}`)

	// 解析不了
	c := data(t, h, "POST", "/api/domains/routes/dm_app/check", "")["check"].(map[string]any)
	if c["ok"] != false || !strings.Contains(c["message"].(string), "解析不了") {
		t.Fatalf("check %v", c)
	}
	f.lookup["bro.vip"] = []string{"127.0.0.1"}
	c = data(t, h, "POST", "/api/domains/routes/dm_app/check", "")["check"].(map[string]any)
	if c["ok"] != true || c["message"] != "bro.vip 解析到 127.0.0.1，转发到 http://127.0.0.1:7777" {
		t.Fatalf("check %v", c)
	}
	// 结果按域名另存：列表里带上，路由本身没改
	_, out := call(t, h, "GET", "/api/domains/routes", "")
	app := out["data"].([]any)[0].(map[string]any)
	if app["check"].(map[string]any)["ok"] != true || app["auto"] != false || app["updated_at"] != app["created_at"] {
		t.Fatalf("app %v", app)
	}
	// 上游没回应
	r := data(t, h, "POST", "/api/domains/routes", `{"host":"video","target":{"kind":"url","url":"http://127.0.0.1:1"}}`)
	f.lookup["video.bro.vip"] = []string{"127.0.0.1"}
	c = data(t, h, "POST", "/api/domains/routes/"+r["id"].(string)+"/check", "")["check"].(map[string]any)
	if c["ok"] != false || !strings.Contains(c["message"].(string), "没有回应") {
		t.Fatalf("check %v", c)
	}
	// HTTPS 开着但根证书没装
	data(t, h, "PUT", "/api/domains/settings", `{"https":true}`)
	c = data(t, h, "POST", "/api/domains/routes/dm_app/check", "")["check"].(map[string]any)
	if c["ok"] != false || c["message"] != "HTTPS 开着但本地根证书没装" {
		t.Fatalf("check %v", c)
	}
	if code, _ := call(t, h, "POST", "/api/domains/routes/dm_nope/check", ""); code != 404 {
		t.Fatalf("不存在回 %d", code)
	}
}

// 系统路径都指向临时目录：跑完整套检测和生成后，真实 /etc 下文件的修改时间不变
func TestRealSystemFilesUntouched(t *testing.T) {
	real := []string{"/etc/hosts", "/etc/pf.conf", "/etc/pf.anchors/broleez-local", "/Library/LaunchDaemons/vip.broleez.pf.plist"}
	before := map[string]time.Time{}
	for _, p := range real {
		if st, err := os.Stat(p); err == nil {
			before[p] = st.ModTime()
		}
	}
	f := newFakeSys(t)
	f.configured(t)
	h := setup(t, newPlugin(f))
	data(t, h, "GET", "/api/domains/status", "")
	data(t, h, "GET", "/api/domains/config", "")
	data(t, h, "POST", "/api/domains/routes/dm_app/check", "")
	data(t, h, "PUT", "/api/domains/settings", `{"https":false}`)
	for p, mt := range before {
		st, err := os.Stat(p)
		if err != nil || !st.ModTime().Equal(mt) {
			t.Fatalf("%s 被改了：%v -> %v（%v）", p, mt, st, err)
		}
	}
	for _, c := range f.ran {
		if strings.HasPrefix(c, "sudo") || strings.Contains(c, "-install") {
			t.Fatalf("执行了不该执行的命令 %s", c)
		}
	}
}

func TestParsers(t *testing.T) {
	m := parseHosts("127.0.0.1 a.vip b.vip # c.vip\n# 127.0.0.1 d.vip\n::1 a.vip\n")
	if fmt.Sprint(m["a.vip"]) != "[127.0.0.1 ::1]" || m["c.vip"] != nil || m["d.vip"] != nil {
		t.Fatalf("hosts %v", m)
	}
	rs := parsePF("rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80  -> 127.0.0.1 port 7777\n# x\n")
	if len(rs) != 1 || rs[0].port != 80 || rs[0].toPort != 7777 {
		t.Fatalf("pf %v", rs)
	}
	if !covers([]string{"*.pmw.lan"}, "app.pmw.lan") || covers([]string{"*.pmw.lan"}, "a.b.pmw.lan") || covers([]string{"*.pmw.lan"}, "pmw.lan") {
		t.Fatal("通配符")
	}
	for s, ok := range map[string]bool{"bro.vip": true, "pmw.lan": true, "pmw.local": false, "local": false, "glocal": true, "a..b": false, "A.b": false} {
		if validSuffix(s) != ok {
			t.Fatalf("validSuffix(%q) != %v", s, ok)
		}
	}
}

func writeCert(t *testing.T, path string, names []string, notAfter time.Time) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test"}, DNSNames: names,
		NotBefore: notAfter.Add(-900 * 24 * time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
}
