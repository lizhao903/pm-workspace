// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractTarGzOK(t *testing.T) {
	entries := []tarEntry{
		{name: "plugin.json", body: []byte(`{"manifest_version":2}`)},
		{name: "bin/hello_world", body: []byte("#!/bin/sh\n"), mode: 0o755},
		{name: "web/entry.js", body: []byte("export default {};\n")},
	}
	dest := t.TempDir()
	if err := extractTarGz(buildTarGz(t, entries), dest, defaultArchiveLimits()); err != nil {
		t.Fatalf("解包合法 tar.gz 失败：%v", err)
	}
	for _, rel := range []string{"plugin.json", "bin/hello_world", "web/entry.js"} {
		if !isRegularFile(filepath.Join(dest, filepath.FromSlash(rel))) {
			t.Fatalf("解包后缺少 %s", rel)
		}
	}
	st, err := os.Stat(filepath.Join(dest, "bin", "hello_world"))
	if err != nil || st.Mode()&0o111 == 0 {
		t.Fatalf("可执行位没有保留：%v %v", err, st)
	}
}

func TestExtractTarGzUnsafe(t *testing.T) {
	cases := []struct {
		name    string
		entries []tarEntry
	}{
		{"路径逃逸", []tarEntry{{name: "../evil.txt", body: []byte("x")}}},
		{"深层路径逃逸", []tarEntry{{name: "bin/../../evil.txt", body: []byte("x")}}},
		{"绝对路径", []tarEntry{{name: "/tmp/pmw-evil.txt", body: []byte("x")}}},
		{"反斜杠路径", []tarEntry{{name: `bin\..\evil.txt`, body: []byte("x")}}},
		{"符号链接", []tarEntry{{name: "link", typeflag: tar.TypeSymlink, linkname: "/etc/passwd"}}},
		{"硬链接", []tarEntry{{name: "hard", typeflag: tar.TypeLink, linkname: "/etc/passwd"}}},
		{"设备文件", []tarEntry{{name: "dev", typeflag: tar.TypeChar}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			dest := filepath.Join(parent, "pkg")
			if err := os.MkdirAll(dest, 0o755); err != nil {
				t.Fatal(err)
			}
			err := extractTarGz(buildTarGz(t, tc.entries), dest, defaultArchiveLimits())
			if err == nil {
				t.Fatalf("不安全 tar 被接受")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("错误不是 ErrValidation：%v", err)
			}
			for _, leak := range []string{"evil.txt", "pmw-evil.txt"} {
				if _, statErr := os.Stat(filepath.Join(parent, leak)); statErr == nil {
					t.Fatalf("路径逃逸写到了包外：%s", leak)
				}
			}
			if len(tc.name) > 0 {
				if _, statErr := os.Stat(filepath.Join(parent, "link")); statErr == nil {
					t.Fatal("符号链接被写出来了")
				}
			}
		})
	}
}

func TestExtractTarGzLimits(t *testing.T) {
	dest := t.TempDir()
	// 总量超限。
	big := []tarEntry{{name: "big.bin", body: make([]byte, 100)}}
	if err := extractTarGz(buildTarGz(t, big), dest, archiveLimits{maxBytes: 10, maxFiles: 10}); err == nil {
		t.Fatal("超过解包总量上限应失败")
	}
	// 文件数超限。
	many := []tarEntry{
		{name: "a.txt", body: []byte("a")},
		{name: "b.txt", body: []byte("b")},
		{name: "c.txt", body: []byte("c")},
	}
	if err := extractTarGz(buildTarGz(t, many), t.TempDir(), archiveLimits{maxBytes: 1 << 20, maxFiles: 2}); err == nil {
		t.Fatal("超过文件数上限应失败")
	}
	// 非 gzip。
	if err := extractTarGz([]byte("not gzip"), t.TempDir(), defaultArchiveLimits()); err == nil {
		t.Fatal("非法 gzip 应失败")
	}
}

func TestFindPackageRoot(t *testing.T) {
	t.Run("包根", func(t *testing.T) {
		dir := t.TempDir()
		writeTestManifest(t, dir, testManifestObj(platformKey(), "bin/x"))
		got, err := findPackageRoot(dir)
		if err != nil || got != dir {
			t.Fatalf("找包根失败：%v %q", err, got)
		}
	})
	t.Run("唯一一层顶级目录", func(t *testing.T) {
		dir := t.TempDir()
		sub := filepath.Join(dir, "pkg")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		writeTestManifest(t, sub, testManifestObj(platformKey(), "bin/x"))
		got, err := findPackageRoot(dir)
		if err != nil || got != sub {
			t.Fatalf("找包根失败：%v %q", err, got)
		}
	})
	t.Run("多份清单", func(t *testing.T) {
		dir := t.TempDir()
		writeTestManifest(t, dir, testManifestObj(platformKey(), "bin/x"))
		sub := filepath.Join(dir, "other")
		_ = os.MkdirAll(sub, 0o755)
		writeTestManifest(t, sub, testManifestObj(platformKey(), "bin/x"))
		if _, err := findPackageRoot(dir); err == nil {
			t.Fatal("多份 plugin.json 应被拒绝")
		}
	})
	t.Run("没有清单", func(t *testing.T) {
		if _, err := findPackageRoot(t.TempDir()); err == nil {
			t.Fatal("没有 plugin.json 应被拒绝")
		}
	})
}

func TestResolveDirPreview(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	h := newTestHost(t, Options{})
	pv, err := h.Resolve(context.Background(), Source{Type: "dir", Path: dir})
	if err != nil {
		t.Fatalf("Resolve 失败：%v", err)
	}
	if !pv.Compatible {
		t.Fatalf("应兼容，checks=%+v", pv.Checks)
	}
	if pv.Platform != platformKey() || pv.Entry != "bin/hello_world" || pv.WebEntry != "web/entry.js" {
		t.Fatalf("预览字段不对：%+v", pv)
	}
	if pv.PackageSHA256 == "" || len(pv.PackageSHA256) != 64 {
		t.Fatalf("包哈希不对：%q", pv.PackageSHA256)
	}
	if len(pv.Permissions) != 2 {
		t.Fatalf("权限条数不对：%+v", pv.Permissions)
	}
	for _, p := range pv.Permissions {
		if p.Reason == "" || p.Risk != "normal" || p.Granted {
			t.Fatalf("权限项不对：%+v", p)
		}
	}
	if len(pv.Checks) == 0 {
		t.Fatal("检查项为空")
	}
	for _, c := range pv.Checks {
		if !c.OK {
			t.Fatalf("检查项失败：%+v", c)
		}
	}
}

func TestResolveDirMissingLicenseIsIncompatible(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	if err := os.Remove(filepath.Join(dir, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	h := newTestHost(t, Options{})
	pv, err := h.Resolve(context.Background(), Source{Type: "dir", Path: dir})
	if err != nil {
		t.Fatalf("Resolve 不应直接失败（应给预览+检查项）：%v", err)
	}
	if pv.Compatible {
		t.Fatal("缺 LICENSE 应判不兼容")
	}
	found := false
	for _, c := range pv.Checks {
		if c.Name == "license" && !c.OK {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺少 license 检查项：%+v", pv.Checks)
	}
}

func TestResolveIncompatiblePlatform(t *testing.T) {
	dir := t.TempDir()
	writeTestPackage(t, dir, testManifestObj("windows-arm64", "bin/hello_world"))
	h := newTestHost(t, Options{})
	pv, err := h.Resolve(context.Background(), Source{Type: "dir", Path: dir})
	if err != nil {
		t.Fatalf("Resolve 失败：%v", err)
	}
	if pv.Compatible {
		t.Fatal("没有当前平台二进制应判不兼容")
	}
}

func TestResolveArchive(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	data := packTestPackage(t, dir)
	archive := filepath.Join(t.TempDir(), "hello_world-0.1.0-"+platformKey()+".tar.gz")
	if err := os.WriteFile(archive, data, 0o644); err != nil {
		t.Fatal(err)
	}
	h := newTestHost(t, Options{})
	pv, err := h.Resolve(context.Background(), Source{Type: "archive", Path: archive})
	if err != nil {
		t.Fatalf("Resolve archive 失败：%v", err)
	}
	if !pv.Compatible {
		t.Fatalf("应兼容：%+v", pv.Checks)
	}
	if pv.PackageSHA256 != sha256Hex(data) {
		t.Fatalf("包哈希应等于 tar.gz 的 sha256")
	}
	// 错误的期望哈希要拒绝。
	_, err = h.Resolve(context.Background(), Source{Type: "archive", Path: archive, SHA256: strings.Repeat("0", 64)})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("哈希不匹配应返回 ErrValidation：%v", err)
	}
}

func TestParseSHA256SUMS(t *testing.T) {
	sums, err := parseSHA256SUMS("# comment\n" + strings.Repeat("a", 64) + "  pkg.tar.gz\n" + strings.Repeat("b", 64) + " *other.tar.gz\n")
	if err != nil {
		t.Fatalf("解析 SHA256SUMS 失败：%v", err)
	}
	if sums["pkg.tar.gz"] != strings.Repeat("a", 64) || sums["other.tar.gz"] != strings.Repeat("b", 64) {
		t.Fatalf("解析结果不对：%+v", sums)
	}
	if _, err := parseSHA256SUMS("bad"); err == nil {
		t.Fatal("非法 SHA256SUMS 应失败")
	}
}

func TestSelectPlatformAsset(t *testing.T) {
	rel := &githubRelease{TagName: "v0.1.0"}
	rel.Assets = append(rel.Assets, struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	}{Name: "hello_world-0.1.0-" + platformKey() + ".tar.gz", BrowserDownloadURL: "https://github.com/o/r/releases/download/v0.1.0/x.tar.gz"})
	rel.Assets = append(rel.Assets, struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	}{Name: "hello_world-0.1.0-linux-amd64.tar.gz", BrowserDownloadURL: "https://github.com/o/r/releases/download/v0.1.0/y.tar.gz"})
	asset, err := selectPlatformAsset(rel, platformKey())
	if err != nil {
		t.Fatalf("选平台资产失败：%v", err)
	}
	if !strings.Contains(asset.Name, platformKey()) {
		t.Fatalf("选错资产：%s", asset.Name)
	}
	if _, err := selectPlatformAsset(rel, "freebsd-riscv64"); err == nil {
		t.Fatal("没有匹配资产时应失败")
	}
}

// rewriteTransport 把 github.com 的请求转到 httptest TLS server，其它请求正常走。
type rewriteTransport struct {
	base   http.RoundTripper
	server *url.URL
}

func (rt rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	if clone.URL.Host == "github.com" {
		clone.URL.Scheme = rt.server.Scheme
		clone.URL.Host = rt.server.Host
	}
	return rt.base.RoundTrip(clone)
}

// githubFixture 搭一个模拟 GitHub Release 的 TLS server。
type githubFixture struct {
	srv      *httptest.Server
	tarball  []byte
	sums     string
	tag      string
	asset    string
	releaseP string // release JSON（可被测试改坏）
	sigB64   string // 非空时提供 SHA256SUMS.sig 资产
}

func newGithubFixture(t *testing.T, pkgDir string) *githubFixture {
	t.Helper()
	f := &githubFixture{
		tarball: packTestPackage(t, pkgDir),
		tag:     "v0.1.0",
		asset:   "hello_world-0.1.0-" + platformKey() + ".tar.gz",
	}
	f.sums = sha256Hex(f.tarball) + "  " + f.asset + "\n"
	mux := http.NewServeMux()
	f.srv = httptest.NewTLSServer(mux)
	t.Cleanup(f.srv.Close)

	releaseJSON := func(w http.ResponseWriter, _ *http.Request) {
		base := "https://github.com/o/r/releases/download/" + f.tag
		assets := []map[string]any{
			{"name": f.asset, "browser_download_url": base + "/" + f.asset, "size": len(f.tarball)},
			{"name": "SHA256SUMS", "browser_download_url": base + "/SHA256SUMS", "size": len(f.sums)},
		}
		if f.sigB64 != "" {
			assets = append(assets, map[string]any{"name": "SHA256SUMS.sig", "browser_download_url": base + "/SHA256SUMS.sig", "size": len(f.sigB64)})
		}
		payload := map[string]any{"tag_name": f.tag, "assets": assets}
		_ = json.NewEncoder(w).Encode(payload)
	}
	mux.HandleFunc("/repos/o/r/releases/latest", releaseJSON)
	mux.HandleFunc("/repos/o/r/releases/tags/"+f.tag, releaseJSON)
	mux.HandleFunc("/repos/o/r/releases/tags/bad", func(w http.ResponseWriter, _ *http.Request) {
		http.NotFound(w, nil)
	})
	mux.HandleFunc("/o/r/releases/download/"+f.tag+"/"+f.asset, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(f.tarball)
	})
	mux.HandleFunc("/o/r/releases/download/"+f.tag+"/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(f.sums))
	})
	mux.HandleFunc("/o/r/releases/download/"+f.tag+"/SHA256SUMS.sig", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(f.sigB64))
	})
	return f
}

func (f *githubFixture) client() *http.Client {
	u, _ := url.Parse(f.srv.URL)
	return &http.Client{Transport: rewriteTransport{base: f.srv.Client().Transport, server: u}}
}

// withGithubAPIBase 临时替换全局 GitHub API 基地址。
func withGithubAPIBase(t *testing.T, base string) {
	t.Helper()
	old := githubAPIBase
	githubAPIBase = base
	t.Cleanup(func() { githubAPIBase = old })
}

func TestResolveGitHubRepo(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	fx := newGithubFixture(t, dir)
	withGithubAPIBase(t, fx.srv.URL)

	h := newTestHost(t, Options{HTTPClient: fx.client()})
	pv, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"})
	if err != nil {
		t.Fatalf("Resolve github 失败：%v", err)
	}
	if !pv.Compatible {
		t.Fatalf("应兼容：%+v", pv.Checks)
	}
	if pv.PackageSHA256 != sha256Hex(fx.tarball) {
		t.Fatalf("包哈希不对：%s", pv.PackageSHA256)
	}
	if pv.Source.Type != "github" || pv.Source.URL == "" {
		t.Fatalf("规范化来源不对：%+v", pv.Source)
	}

	// Release 页形式。
	pv2, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r/releases/tag/v0.1.0"})
	if err != nil || !pv2.Compatible {
		t.Fatalf("Resolve release 页失败：%v", err)
	}

	// 资产直链 + 从同 Release 的 SHA256SUMS 校验（不给 sha256）。
	direct := "https://github.com/o/r/releases/download/v0.1.0/" + fx.asset
	pv3, err := h.Resolve(context.Background(), Source{Type: "github", URL: direct})
	if err != nil {
		t.Fatalf("Resolve 资产直链失败：%v", err)
	}
	if !pv3.Compatible || pv3.PackageSHA256 != sha256Hex(fx.tarball) {
		t.Fatalf("资产直链预览不对：%+v", pv3)
	}

	// 指定的 sha256 不匹配要拒绝。
	_, err = h.Resolve(context.Background(), Source{Type: "github", URL: direct, SHA256: strings.Repeat("0", 64)})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("哈希不匹配应返回 ErrValidation：%v", err)
	}
}

func TestResolveGitHubChecksumTampered(t *testing.T) {
	dir, _ := newTestPackageDir(t)
	fx := newGithubFixture(t, dir)
	withGithubAPIBase(t, fx.srv.URL)
	fx.sums = strings.Repeat("0", 64) + "  " + fx.asset + "\n"

	h := newTestHost(t, Options{HTTPClient: fx.client()})
	_, err := h.Resolve(context.Background(), Source{Type: "github", URL: "https://github.com/o/r"})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("SHA256SUMS 不匹配应返回 ErrValidation：%v", err)
	}
}

func TestResolveGitHubErrors(t *testing.T) {
	h := newTestHost(t, Options{})
	if _, err := h.Resolve(context.Background(), Source{Type: "github", URL: "ftp://example.com/x"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("不支持的地址应返回 ErrValidation：%v", err)
	}
	if _, err := h.Resolve(context.Background(), Source{Type: "weird", URL: "x"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("未知来源类型应返回 ErrValidation：%v", err)
	}
}

// GitHub Release 资产现在重定向到 release-assets.githubusercontent.com；不在白名单里时从 GitHub 安装全部失败（2026-11-23）。
func TestRedirectAllowedHostsGitHubAssets(t *testing.T) {
	for _, h := range []string{"release-assets.githubusercontent.com", "objects.githubusercontent.com", "github.com"} {
		if !redirectAllowedHosts[h] {
			t.Fatalf("%s 应在重定向白名单里", h)
		}
	}
	if redirectAllowedHosts["evil.example.com"] {
		t.Fatal("未知域名不应放行")
	}
}
