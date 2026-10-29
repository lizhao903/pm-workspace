package domains

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// System 是插件要读的系统路径和要调的外部命令，全部只读。默认指向真实系统，测试换成临时目录。
type System struct {
	HostsFile string // /etc/hosts
	PFAnchor  string // /etc/pf.anchors/broleez-local，anchor 名取文件名
	PFConf    string // /etc/pf.conf，看 anchor 有没有注册
	PFDaemon  string // /Library/LaunchDaemons/vip.broleez.pf.plist，开机重新加载 pf
	CertDir   string // 站点证书目录，默认仓库的 certs/
	HTTPAddr  string // 可达检测连的明文口，默认 127.0.0.1:80
	HTTPSAddr string // 可达检测连的 TLS 口，默认 127.0.0.1:443
	// Run 跑外部命令（mkcert -CAROOT、security verify-cert），返回标准输出
	Run func(ctx context.Context, name string, args ...string) (string, error)
	// Lookup 解析域名，走系统解析器（会读 /etc/hosts）
	Lookup func(ctx context.Context, host string) ([]string, error)
	Now    func() time.Time
}

func defaultSystem(certDir string) System {
	return System{
		HostsFile: "/etc/hosts",
		PFAnchor:  "/etc/pf.anchors/broleez-local",
		PFConf:    "/etc/pf.conf",
		PFDaemon:  "/Library/LaunchDaemons/vip.broleez.pf.plist",
		CertDir:   certDir,
		HTTPAddr:  "127.0.0.1:80",
		HTTPSAddr: "127.0.0.1:443",
		Run:       runCommand,
		Lookup:    net.DefaultResolver.LookupHost,
		Now:       time.Now,
	}
}

func (s System) anchorName() string { return filepath.Base(s.PFAnchor) }

// errNoCommand：PATH 和 Homebrew 的目录里都找不到这个命令。
var errNoCommand = errors.New("command not found")

// runCommand 先按 PATH 找，再试 Homebrew 的两个目录（LaunchAgent 里 PATH 常常不含它们）。
func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	bin, err := exec.LookPath(name)
	if err != nil {
		for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
			if st, e := os.Stat(filepath.Join(dir, name)); e == nil && !st.IsDir() {
				bin, err = filepath.Join(dir, name), nil
				break
			}
		}
	}
	if err != nil {
		return "", fmt.Errorf("%w: %s", errNoCommand, name)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).Output()
	return string(out), err
}

// readFile 读系统文件；不存在返回 fs.ErrNotExist，读不了（没权限）原样返回。最多读 1MB。
func readFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, 1<<20))
	return string(b), err
}

// parseHosts 返回每个主机名对应的地址，按文件里出现的先后。
func parseHosts(body string) map[string][]string {
	out := map[string][]string{}
	for _, line := range strings.Split(body, "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		for _, name := range f[1:] {
			name = strings.ToLower(name)
			out[name] = append(out[name], f[0])
		}
	}
	return out
}

var rdrRe = regexp.MustCompile(`^rdr\s+pass\s+(?:on\s+\S+\s+)?inet\s+proto\s+tcp\s+from\s+any\s+to\s+(\S+)\s+port\s+(\d+)\s+->\s+(\S+)\s+port\s+(\d+)$`)

// pfRule 是 anchor 里的一条 rdr：发往 dst:port 的转到 to:toPort。
type pfRule struct {
	dst    string
	port   int
	to     string
	toPort int
}

func parsePF(body string) []pfRule {
	var out []pfRule
	for _, line := range strings.Split(body, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		m := rdrRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		p, _ := strconv.Atoi(m[2])
		tp, _ := strconv.Atoi(m[4])
		out = append(out, pfRule{dst: m[1], port: p, to: m[3], toPort: tp})
	}
	return out
}

// pfRegistered：/etc/pf.conf 里有 rdr-anchor 挂载点和 load anchor 两行（缺一行规则都不会生效）。
func pfRegistered(conf, anchor, path string) (mount, load bool) {
	for _, line := range strings.Split(conf, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if strings.HasPrefix(line, "#") {
			continue
		}
		if line == fmt.Sprintf(`rdr-anchor "%s"`, anchor) {
			mount = true
		}
		if line == fmt.Sprintf(`load anchor "%s" from "%s"`, anchor, path) {
			load = true
		}
	}
	return mount, load
}

// siteCert 是证书目录里一张站点证书。
type siteCert struct {
	File     string    `json:"file"`
	DNSNames []string  `json:"dns_names"`
	NotAfter time.Time `json:"not_after"`
}

// readCerts 读证书目录下的 .pem（跳过 -key.pem），每个文件取第一张证书。
func readCerts(dir string) ([]siteCert, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []siteCert
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".pem") || strings.HasSuffix(n, "-key.pem") {
			continue
		}
		body, err := readFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		for rest := []byte(body); ; {
			var b *pem.Block
			b, rest = pem.Decode(rest)
			if b == nil {
				break
			}
			if b.Type != "CERTIFICATE" {
				continue
			}
			c, err := x509.ParseCertificate(b.Bytes)
			if err != nil {
				break
			}
			names := append([]string{}, c.DNSNames...)
			sort.Strings(names)
			out = append(out, siteCert{File: filepath.Join(dir, n), DNSNames: names, NotAfter: c.NotAfter.UTC()})
			break
		}
	}
	return out, nil
}

// covers：SAN 里有这个域名，或有一条只差最左一级的通配符。
func covers(names []string, host string) bool {
	for _, n := range names {
		n = strings.ToLower(n)
		if n == host {
			return true
		}
		if strings.HasPrefix(n, "*.") {
			if i := strings.IndexByte(host, '.'); i > 0 && host[i+1:] == n[2:] {
				return true
			}
		}
	}
	return false
}

// probe 带 Host 头请求 addr 上的 GET /api/domains/settings，看回来的是不是本服务（认实例头）。
// 返回 HTTP 状态码、对面的实例标记；连不上返回 err。证书对不对另有检测，这里不校验。
func probe(ctx context.Context, addr, host string, useTLS bool) (int, string, error) {
	d := &net.Dialer{Timeout: 2 * time.Second}
	tr := &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return d.DialContext(ctx, "tcp", addr) },
		TLSClientConfig:   &tls.Config{ServerName: host, InsecureSkipVerify: true}, //nolint:gosec // 只看通不通，证书单独检测
		DisableKeepAlives: true,
		Proxy:             nil,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+host+"/api/domains/settings", nil)
	if err != nil {
		return 0, "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, resp.Header.Get(instanceHeader), nil
}

// probeURL 对上游地址发一次 GET，有 HTTP 回应就算回了。
func probeURL(ctx context.Context, raw string) (int, error) {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, DisableKeepAlives: true} //nolint:gosec // 只看通不通
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }

// instanceHeader 是 GET /api/domains/settings 回的实例标记头。
const instanceHeader = "X-Pmw-Instance"
