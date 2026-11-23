// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 安装来源解析（brief §3，docs/plugin-spec-v2.md 3 / 2.2）：
//   - "dir"     本地目录：直接读，不复制（开发者模式）；
//   - "archive" 本地 tar.gz：安全解压到临时目录；
//   - "github"  GitHub 仓库/Release/资产直链：走 API 选当前平台资产 + SHA256SUMS 校验。
//
// 解包限额：64 MiB 解包总量、500 个文件；拒绝绝对路径、`..`、反斜杠、符号链接/硬链接/设备文件。

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const (
	// maxArchiveBytes 是解包后的总大小上限。
	maxArchiveBytes = 64 << 20
	// maxArchiveFiles 是解包后的文件数上限。
	maxArchiveFiles = 500
	// maxDownloadBytes 是单个下载（tar.gz / SHA256SUMS）的上限。
	maxDownloadBytes = 128 << 20
)

// githubAPIBase 是 GitHub API 基地址；测试里替换成 httptest TLS server。
var githubAPIBase = "https://api.github.com"

// packageData 是一个已解到本地、等待校验/预览/安装的插件包。
type packageData struct {
	root     string // 包根目录（含唯一 plugin.json）
	source   Source // 规范化后的来源
	sha256   string // 包哈希；目录来源为目录内容哈希
	platform string // 当前平台键，例 darwin-arm64
	manifest *Manifest
	// publisherVerified 表示本次来源（目前只有 GitHub Release）完成了发布者签名校验。
	publisherVerified bool
	cleanup           func()
}

// resolvePackage 按来源类型拿到本地包目录并解析清单。
func (h *Host) resolvePackage(ctx context.Context, src Source) (*packageData, error) {
	src.Type = strings.ToLower(strings.TrimSpace(src.Type))
	if src.Type == "" {
		src.Type = inferSourceType(src)
	}

	var (
		pkg *packageData
		err error
	)
	switch src.Type {
	case "dir":
		pkg, err = h.resolveDir(ctx, src)
	case "archive":
		pkg, err = h.resolveArchive(ctx, src)
	case "dev":
		pkg, err = h.resolveDevDir(ctx, src)
	case "github":
		pkg, err = h.resolveGitHub(ctx, src)
	default:
		return nil, wrap(ErrValidation, "不支持的来源类型 %q（只支持 dir/archive/github）", src.Type)
	}
	if err != nil {
		return nil, err
	}

	root, err := findPackageRoot(pkg.root)
	if err != nil {
		pkg.cleanup()
		return nil, err
	}
	pkg.root = root
	manifest, err := parseManifestFile(filepath.Join(root, "plugin.json"))
	if err != nil {
		pkg.cleanup()
		return nil, err
	}
	pkg.manifest = manifest
	pkg.platform = platformKey()
	pkg.source = src
	if pkg.source.SHA256 == "" {
		pkg.source.SHA256 = pkg.sha256
	}
	return pkg, nil
}

// inferSourceType 在 Type 缺省时按 Path/URL 猜来源类型。
func inferSourceType(src Source) string {
	switch {
	case src.URL != "":
		return "github"
	case strings.HasSuffix(strings.ToLower(src.Path), ".tar.gz"), strings.HasSuffix(strings.ToLower(src.Path), ".tgz"):
		return "archive"
	case src.Path != "":
		return "dir"
	default:
		return ""
	}
}

func (h *Host) resolveDir(ctx context.Context, src Source) (*packageData, error) {
	_ = ctx
	if src.Path == "" {
		return nil, wrap(ErrValidation, "dir 来源必须提供 path")
	}
	abs, err := filepath.Abs(src.Path)
	if err != nil {
		return nil, wrap(ErrValidation, "解析目录路径失败：%v", err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, wrap(ErrNotFound, "目录不存在：%s", abs)
		}
		return nil, fmt.Errorf("读取目录失败：%w", err)
	}
	if !st.IsDir() {
		return nil, wrap(ErrValidation, "路径不是目录：%s", abs)
	}
	sum, err := hashDir(abs)
	if err != nil {
		return nil, err
	}
	if src.SHA256 != "" && !strings.EqualFold(src.SHA256, sum) {
		return nil, wrap(ErrValidation, "目录内容 SHA-256 不匹配：期望 %s，实际 %s", src.SHA256, sum)
	}
	src.Path = abs
	return &packageData{
		root:    abs,
		source:  src,
		sha256:  sum,
		cleanup: func() {},
	}, nil
}

// resolveDevDir 把 --plugin-dev-dir 下的源码目录作为「链接」安装：不复制、不签名，
// 每次 Reload/重启时重新读清单与产物（开发者先 make build 出 bin/web）。
func (h *Host) resolveDevDir(ctx context.Context, src Source) (*packageData, error) {
	_ = ctx
	if src.Path == "" {
		return nil, wrap(ErrValidation, "dev 来源必须提供 path")
	}
	abs, err := filepath.Abs(src.Path)
	if err != nil {
		return nil, wrap(ErrValidation, "解析开发目录失败：%v", err)
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, wrap(ErrNotFound, "开发目录不存在：%s", abs)
	}
	sum, err := hashDir(abs)
	if err != nil {
		return nil, err
	}
	src.Path = abs
	return &packageData{root: abs, source: src, sha256: sum, cleanup: func() {}}, nil
}

func (h *Host) resolveArchive(ctx context.Context, src Source) (*packageData, error) {
	_ = ctx
	if src.Path == "" {
		return nil, wrap(ErrValidation, "archive 来源必须提供 path")
	}
	abs, err := filepath.Abs(src.Path)
	if err != nil {
		return nil, wrap(ErrValidation, "解析包路径失败：%v", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, wrap(ErrNotFound, "安装包不存在：%s", abs)
		}
		return nil, fmt.Errorf("读取安装包失败：%w", err)
	}
	if len(data) > maxDownloadBytes {
		return nil, wrap(ErrValidation, "安装包超过上限 %d 字节", maxDownloadBytes)
	}
	sum := sha256Hex(data)
	if src.SHA256 != "" && !strings.EqualFold(src.SHA256, sum) {
		return nil, wrap(ErrValidation, "安装包 SHA-256 不匹配：期望 %s，实际 %s", src.SHA256, sum)
	}
	tmp, err := os.MkdirTemp("", "pmw-plugin-archive-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败：%w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	if err := extractTarGz(data, tmp, defaultArchiveLimits()); err != nil {
		cleanup()
		return nil, err
	}
	src.Path = abs
	return &packageData{root: tmp, source: src, sha256: sum, cleanup: cleanup}, nil
}

// githubRelease 是 GitHub API release 里用得到的字段。
type githubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

var (
	githubRepoRe       = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$`)
	githubReleaseTagRe = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases/tag/([^/]+)$`)
	githubAssetURLRe   = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/releases/download/([^/]+)/(.+)$`)
	githubShorthandRe  = regexp.MustCompile(`^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`)
)

func (h *Host) resolveGitHub(ctx context.Context, src Source) (*packageData, error) {
	raw := strings.TrimSpace(src.URL)
	if raw == "" {
		raw = strings.TrimSpace(src.Path)
	}
	if raw == "" {
		return nil, wrap(ErrValidation, "github 来源必须提供 url")
	}
	// 省略协议与 owner/repo 简写。
	if githubShorthandRe.MatchString(raw) && !strings.Contains(raw, "://") {
		raw = "https://github.com/" + raw
	}
	if !strings.HasPrefix(raw, "https://") && !strings.HasPrefix(raw, "http://") {
		raw = "https://" + raw
	}
	// 允许用户粘贴带结尾斜杠的仓库地址。
	raw = strings.TrimRight(raw, "/")

	switch {
	case githubAssetURLRe.MatchString(raw):
		return h.resolveGitHubAsset(ctx, src, raw)
	case githubReleaseTagRe.MatchString(raw):
		m := githubReleaseTagRe.FindStringSubmatch(raw)
		return h.resolveGitHubRelease(ctx, src, m[1], m[2], m[3], raw)
	case githubRepoRe.MatchString(raw):
		m := githubRepoRe.FindStringSubmatch(raw)
		return h.resolveGitHubRelease(ctx, src, m[1], m[2], "", raw)
	default:
		return nil, wrap(ErrValidation,
			"无法识别的 GitHub 地址 %q（支持仓库页、releases/tag/<tag>、releases/download/<tag>/<asset>）", raw)
	}
}

// resolveGitHubRelease 取指定（或 latest）Release，选当前平台 tar.gz + SHA256SUMS 并校验。
func (h *Host) resolveGitHubRelease(ctx context.Context, src Source, owner, repo, tag, pageURL string) (*packageData, error) {
	rel, err := h.fetchGitHubRelease(ctx, owner, repo, tag)
	if err != nil {
		return nil, err
	}
	asset, err := selectPlatformAsset(rel, platformKey())
	if err != nil {
		return nil, err
	}
	sumsRaw, err := h.fetchSHA256SUMSRaw(ctx, rel)
	if err != nil {
		return nil, err
	}
	sums, err := parseSHA256SUMS(string(sumsRaw))
	if err != nil {
		return nil, err
	}
	data, err := h.download(ctx, asset.URL)
	if err != nil {
		return nil, err
	}
	sum := sha256Hex(data)
	if err := verifyChecksum(asset.Name, sum, sums, src.SHA256); err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp("", "pmw-plugin-github-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败：%w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	if err := extractTarGz(data, tmp, defaultArchiveLimits()); err != nil {
		cleanup()
		return nil, err
	}
	src.Type = "github"
	src.URL = pageURL
	src.SHA256 = sum
	verified, err := h.verifyReleasePublisher(ctx, rel, tmp)
	if err != nil {
		cleanup()
		return nil, err
	}
	return &packageData{root: tmp, source: src, sha256: sum, publisherVerified: verified, cleanup: cleanup}, nil
}

// resolveGitHubAsset 处理 releases/download/<tag>/<asset> 直链：下载资产并校验 SHA-256。
// 用户没给 sha256 时，尝试从同 Release 的 SHA256SUMS 取。
func (h *Host) resolveGitHubAsset(ctx context.Context, src Source, assetURL string) (*packageData, error) {
	m := githubAssetURLRe.FindStringSubmatch(assetURL)
	owner, repo, tag, name := m[1], m[2], m[3], m[4]

	var (
		data []byte
		err  error
	)
	if strings.HasPrefix(assetURL, "http://") {
		// 只测试会走到这里（httptest 默认 http）；生产输入一律 https。
		data, err = h.downloadHTTP(ctx, assetURL)
	} else {
		data, err = h.download(ctx, assetURL)
	}
	if err != nil {
		return nil, err
	}
	sum := sha256Hex(data)

	relForVerify, relErr := h.fetchGitHubRelease(ctx, owner, repo, tag)
	expected := src.SHA256
	if expected == "" {
		if relErr == nil {
			if sums, sumErr := h.fetchSHA256SUMS(ctx, relForVerify); sumErr == nil {
				expected = sums[name]
			}
		}
	}
	if expected == "" {
		return nil, wrap(ErrValidation, "资产直链来源必须提供 sha256（或同 Release 提供 SHA256SUMS）：%s", name)
	}
	if !strings.EqualFold(expected, sum) {
		return nil, wrap(ErrValidation, "安装包 SHA-256 不匹配：期望 %s，实际 %s", expected, sum)
	}
	if !strings.HasSuffix(name, ".tar.gz") && !strings.HasSuffix(name, ".tgz") {
		return nil, wrap(ErrValidation, "只支持 tar.gz 安装包：%s", name)
	}
	tmp, err := os.MkdirTemp("", "pmw-plugin-github-*")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败：%w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	if err := extractTarGz(data, tmp, defaultArchiveLimits()); err != nil {
		cleanup()
		return nil, err
	}
	src.Type = "github"
	src.URL = assetURL
	src.SHA256 = sum
	if relErr != nil {
		cleanup()
		return nil, wrap(ErrValidation, "无法读取 Release 校验签名：%v", relErr)
	}
	verified, verr := h.verifyReleasePublisher(ctx, relForVerify, tmp)
	if verr != nil {
		cleanup()
		return nil, verr
	}
	return &packageData{root: tmp, source: src, sha256: sum, publisherVerified: verified, cleanup: cleanup}, nil
}

func (h *Host) fetchGitHubRelease(ctx context.Context, owner, repo, tag string) (*githubRelease, error) {
	path := fmt.Sprintf("/repos/%s/%s/releases/latest", owner, repo)
	if tag != "" {
		path = fmt.Sprintf("/repos/%s/%s/releases/tags/%s", owner, repo, url.PathEscape(tag))
	}
	var rel githubRelease
	if err := h.githubGetJSON(ctx, path, &rel); err != nil {
		return nil, err
	}
	if rel.TagName == "" {
		return nil, wrap(ErrValidation, "GitHub Release 响应缺少 tag_name")
	}
	return &rel, nil
}

func (h *Host) githubGetJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubAPIBase+path, nil)
	if err != nil {
		return wrap(ErrValidation, "构造 GitHub 请求失败：%v", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pmw-pluginhost")
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return wrap(ErrNotFound, "请求 GitHub 失败：%v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return wrap(ErrNotFound, "读取 GitHub 响应失败：%v", err)
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return wrap(ErrNotFound, "GitHub 上找不到该 Release（仓库需要发布 Release，tag 形如 v0.1.0）")
	default:
		return wrap(ErrNotFound, "GitHub API 返回 %d：%s", resp.StatusCode, truncateForLog(string(body), 200))
	}
	if err := json.Unmarshal(body, out); err != nil {
		return wrap(ErrValidation, "解析 GitHub 响应失败：%v", err)
	}
	return nil
}

// selectPlatformAsset 从 Release 资产里挑当前平台的 tar.gz。
func selectPlatformAsset(rel *githubRelease, platform string) (*githubReleaseAsset, error) {
	want := []string{"-" + platform + ".tar.gz", "-" + platform + ".tgz"}
	for i := range rel.Assets {
		a := &rel.Assets[i]
		for _, suffix := range want {
			if strings.HasSuffix(strings.ToLower(a.Name), suffix) {
				return &githubReleaseAsset{Name: a.Name, URL: a.BrowserDownloadURL, Size: a.Size}, nil
			}
		}
	}
	names := make([]string, 0, len(rel.Assets))
	for _, a := range rel.Assets {
		names = append(names, a.Name)
	}
	return nil, wrap(ErrIncompatible, "Release %s 没有当前平台 %s 的 tar.gz 资产（现有：%s）",
		rel.TagName, platform, strings.Join(names, ", "))
}

// githubReleaseAsset 是选中的资产（抽出来方便测试）。
type githubReleaseAsset struct {
	Name string
	URL  string
	Size int64
}

// fetchSHA256SUMSRaw 下载 Release 的 SHA256SUMS 原始字节（签名要验的就是这些字节）。
func (h *Host) fetchSHA256SUMSRaw(ctx context.Context, rel *githubRelease) ([]byte, error) {
	for _, a := range rel.Assets {
		if a.Name != "SHA256SUMS" {
			continue
		}
		data, err := h.download(ctx, a.BrowserDownloadURL)
		if err != nil {
			return nil, err
		}
		return data, nil
	}
	return nil, wrap(ErrValidation, "Release %s 缺少 SHA256SUMS 资产", rel.TagName)
}

// findReleaseAsset 按名字找 Release 资产。
func findReleaseAsset(rel *githubRelease, name string) *githubReleaseAsset {
	for i := range rel.Assets {
		if rel.Assets[i].Name == name {
			return &githubReleaseAsset{Name: rel.Assets[i].Name, URL: rel.Assets[i].BrowserDownloadURL, Size: rel.Assets[i].Size}
		}
	}
	return nil
}

// fetchSHA256SUMS 下载并解析成 文件名 → 哈希。
func (h *Host) fetchSHA256SUMS(ctx context.Context, rel *githubRelease) (map[string]string, error) {
	data, err := h.fetchSHA256SUMSRaw(ctx, rel)
	if err != nil {
		return nil, err
	}
	return parseSHA256SUMS(string(data))
}

// verifyReleasePublisher 在包内清单声明 publisher.key 时强制校验 SHA256SUMS.sig。
// 返回 true 表示验签通过；清单没有 key 时返回 false（community）。
func (h *Host) verifyReleasePublisher(ctx context.Context, rel *githubRelease, pkgRoot string) (bool, error) {
	root, err := findPackageRoot(pkgRoot)
	if err != nil {
		return false, err
	}
	m, err := parseManifestFile(filepath.Join(root, "plugin.json"))
	if err != nil {
		return false, err
	}
	if m.Publisher == nil || strings.TrimSpace(m.Publisher.Key) == "" {
		return false, nil
	}
	sigAsset := findReleaseAsset(rel, "SHA256SUMS.sig")
	if sigAsset == nil {
		return false, wrap(ErrValidation, "清单声明了 publisher.key，但 Release %s 缺少 SHA256SUMS.sig", rel.TagName)
	}
	sumsRaw, err := h.fetchSHA256SUMSRaw(ctx, rel)
	if err != nil {
		return false, err
	}
	sigRaw, err := h.download(ctx, sigAsset.URL)
	if err != nil {
		return false, err
	}
	if err := verifyPublisherSignature(m.Publisher.Key, string(sigRaw), sumsRaw); err != nil {
		return false, err
	}
	return true, nil
}

// parseSHA256SUMS 解析 `sha256sum` 格式：<64 位十六进制>  <文件名>。
func parseSHA256SUMS(s string) (map[string]string, error) {
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 {
			continue
		}
		name := strings.TrimPrefix(strings.Join(fields[1:], " "), "*")
		name = strings.TrimPrefix(name, "./")
		out[name] = sum
	}
	if len(out) == 0 {
		return nil, wrap(ErrValidation, "SHA256SUMS 格式不合法或为空")
	}
	return out, nil
}

// verifyChecksum 校验资产哈希：优先用用户给的 sha256，否则用 SHA256SUMS。
func verifyChecksum(assetName, actual string, sums map[string]string, want string) error {
	expected := strings.ToLower(strings.TrimSpace(want))
	if expected == "" {
		expected = sums[assetName]
		if expected == "" {
			return wrap(ErrValidation, "SHA256SUMS 里没有资产 %s 的校验和", assetName)
		}
	}
	if expected != actual {
		return wrap(ErrValidation, "安装包 SHA-256 不匹配：期望 %s，实际 %s", expected, actual)
	}
	return nil
}

// download 下载 https URL（大小受限）。
func (h *Host) download(ctx context.Context, rawURL string) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, wrap(ErrValidation, "下载地址不合法：%v", err)
	}
	if u.Scheme != "https" {
		return nil, wrap(ErrValidation, "只允许 https 下载地址：%s", rawURL)
	}
	return h.downloadHTTP(ctx, rawURL)
}

// mirrorDownloadURL 按 --plugin-mirror 改写下载地址；镜像只改地址，不改校验和/commit。
func mirrorDownloadURL(mirror, rawURL string) string {
	mirror = strings.TrimSpace(mirror)
	if mirror == "" {
		return rawURL
	}
	if strings.Contains(mirror, "{url}") {
		return strings.ReplaceAll(mirror, "{url}", rawURL)
	}
	return strings.TrimRight(mirror, "/") + "/" + rawURL
}

// redirectAllowedHosts 是 GitHub 下载/API 正常会跳到的域名（外加入口域名与镜像域名）。
var redirectAllowedHosts = map[string]bool{
	"github.com":                            true,
	"api.github.com":                        true,
	"objects.githubusercontent.com":         true,
	"github-releases.githubusercontent.com": true,
	// 2026 起 GitHub Release 资产下载跳到这个域名（SAS 签名的 blob 地址），旧的 objects.githubusercontent.com 保留
	"release-assets.githubusercontent.com": true,
	"codeload.github.com":                  true,
	"raw.githubusercontent.com":            true,
}

// downloadHTTP 下载并限制大小；按 docs/plugin-spec-v2.md 3.5 校验重定向目标域名，
// 并按 Options.Mirror 改写 GitHub 下载地址（镜像只改地址，SHA-256 校验照旧）。
func (h *Host) downloadHTTP(ctx context.Context, rawURL string) ([]byte, error) {
	if u, err := url.Parse(rawURL); err == nil && (u.Hostname() == "github.com" || u.Hostname() == "api.github.com") {
		rawURL = mirrorDownloadURL(h.opts.Mirror, rawURL)
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, wrap(ErrValidation, "下载地址不合法：%v", err)
	}
	client := *h.httpClient
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return wrap(ErrValidation, "下载重定向次数过多")
		}
		host := strings.ToLower(req.URL.Hostname())
		if host == strings.ToLower(u.Hostname()) || redirectAllowedHosts[host] {
			return nil
		}
		if m, err := url.Parse(h.opts.Mirror); err == nil && m.Hostname() != "" && strings.EqualFold(m.Hostname(), host) {
			return nil
		}
		return wrap(ErrValidation, "下载被重定向到未授权的域名：%s", host)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, wrap(ErrValidation, "构造下载请求失败：%v", err)
	}
	req.Header.Set("User-Agent", "pmw-pluginhost")
	resp, err := client.Do(req)
	if err != nil {
		return nil, wrap(ErrNotFound, "下载安装包失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, wrap(ErrNotFound, "下载安装包失败：HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, wrap(ErrNotFound, "读取安装包失败：%v", err)
	}
	if len(data) > maxDownloadBytes {
		return nil, wrap(ErrValidation, "安装包超过上限 %d 字节", maxDownloadBytes)
	}
	return data, nil
}

// archiveLimits 是解包限额（测试可以调小）。
type archiveLimits struct {
	maxBytes int64
	maxFiles int
}

func defaultArchiveLimits() archiveLimits {
	return archiveLimits{maxBytes: maxArchiveBytes, maxFiles: maxArchiveFiles}
}

// extractTarGz 安全解压 tar.gz 到 dest：拒绝路径逃逸、符号链接/硬链接/设备文件，限制总量与文件数。
func extractTarGz(data []byte, dest string, limits archiveLimits) error {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return wrap(ErrValidation, "安装包不是合法的 gzip：%v", err)
	}
	defer gz.Close()
	if err := extractTar(gz, dest, limits); err != nil {
		return err
	}
	return nil
}

// extractTar 解 tar 流。字节流单独拆出来便于测试直接喂 tar.Reader。
func extractTar(r io.Reader, dest string, limits archiveLimits) error {
	tr := tar.NewReader(r)
	var (
		total int64
		files int
	)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return wrap(ErrValidation, "解包失败：%v", err)
		}
		name := strings.TrimPrefix(filepath.ToSlash(hdr.Name), "./")
		if name == "" || name == "." {
			continue
		}
		if !archivePathSafe(name) {
			return wrap(ErrValidation, "安装包含有不安全路径：%s", hdr.Name)
		}
		target, err := safeJoin(dest, name)
		if err != nil {
			return wrap(ErrValidation, "安装包含有不安全路径：%s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("创建目录失败：%w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			files++
			if files > limits.maxFiles {
				return wrap(ErrValidation, "安装包文件数超过上限 %d", limits.maxFiles)
			}
			if hdr.Size < 0 || total+hdr.Size > limits.maxBytes {
				return wrap(ErrValidation, "安装包解包后超过上限 %d 字节", limits.maxBytes)
			}
			total += hdr.Size
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("创建目录失败：%w", err)
			}
			mode := os.FileMode(0o644)
			if hdr.Mode&0o111 != 0 {
				mode = 0o755
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return fmt.Errorf("写入文件失败：%w", err)
			}
			n, copyErr := io.Copy(f, io.LimitReader(tr, hdr.Size))
			closeErr := f.Close()
			if copyErr != nil {
				return fmt.Errorf("写入文件失败：%w", copyErr)
			}
			if closeErr != nil {
				return fmt.Errorf("写入文件失败：%w", closeErr)
			}
			if n != hdr.Size {
				return wrap(ErrValidation, "文件 %s 数据不完整", name)
			}
			_ = os.Chmod(target, mode)
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			// PAX 元数据，忽略。
		default:
			return wrap(ErrValidation, "安装包不允许的文件类型（符号链接/设备等）：%s", hdr.Name)
		}
	}
}

// archivePathSafe 校验包内路径：相对、无反斜杠、无 .. 段、无盘符。
func archivePathSafe(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, `\`) {
		return false
	}
	if len(name) >= 2 && name[1] == ':' {
		return false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

// findPackageRoot 定位包根：plugin.json 在根或唯一一层顶级目录内；多份直接拒绝。
func findPackageRoot(dir string) (string, error) {
	var found []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" || d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() != "plugin.json" {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		// 只认包根或唯一一层子目录：更深的结构 export zip 时容易把多套东西混在一起。
		if depth := strings.Count(filepath.ToSlash(rel), "/"); depth > 1 {
			return wrap(ErrValidation, "plugin.json 在 %s，包根只允许根目录或一层子目录", filepath.ToSlash(rel))
		}
		found = append(found, rel)
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("扫描安装包失败：%w", err)
	}
	switch len(found) {
	case 0:
		return "", wrap(ErrValidation, "安装包里没有 plugin.json")
	case 1:
		rel := filepath.ToSlash(found[0])
		if strings.Count(rel, "/") == 0 {
			return dir, nil
		}
		return filepath.Join(dir, filepath.FromSlash(strings.TrimSuffix(rel, "/plugin.json"))), nil
	default:
		return "", wrap(ErrValidation, "安装包里有多份 plugin.json（%s），包根必须唯一", strings.Join(found, ", "))
	}
}

func parseManifestFile(path string) (*Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, wrap(ErrValidation, "安装包里没有 plugin.json")
		}
		return nil, fmt.Errorf("读取 plugin.json 失败：%w", err)
	}
	if len(data) > 1<<20 {
		return nil, wrap(ErrValidation, "plugin.json 超过 1 MiB")
	}
	return Parse(data)
}

// preview 基于 packageData 组装安全预览（不落盘）。
func (h *Host) preview(ctx context.Context, pkg *packageData) (*Preview, error) {
	m := pkg.manifest
	pv := &Preview{
		Manifest:      *m,
		Tier:          tierOf(pkg.publisherVerified),
		Source:        pkg.source,
		PackageSHA256: pkg.sha256,
		Platform:      pkg.platform,
		Compatible:    false,
	}
	pv.Checks = append(pv.Checks, Check{Name: "manifest", OK: true, Detail: "清单 v2 校验通过"})

	compatible := true
	if err := CheckCompatibility(m, h.opts.Version); err != nil {
		compatible = false
		pv.Checks = append(pv.Checks, Check{Name: "compatible", OK: false, Detail: err.Error()})
	} else {
		pv.Checks = append(pv.Checks, Check{Name: "compatible", OK: true,
			Detail: "api " + m.API + " 包含 " + ExternalAPIVersion})
	}

	pv.Checks = append(pv.Checks, Check{Name: "hash", OK: true, Detail: pkg.sha256})

	licenseOK := hasLicense(pkg.root)
	pv.Checks = append(pv.Checks, Check{Name: "license", OK: licenseOK, Detail: licenseDetail(licenseOK)})
	compatible = compatible && licenseOK

	// 后端入口：清单 platforms 里必须有当前平台，且文件真的在包里。
	if m.Runtime.Backend != nil {
		entry, ok := m.Runtime.Backend.Entry[pkg.platform]
		if !ok {
			compatible = false
			pv.Checks = append(pv.Checks, Check{Name: "platform_entry", OK: false,
				Detail: "清单没有当前平台 " + pkg.platform + " 的 backend.entry"})
		} else {
			pv.Entry = entry
			full, joinErr := safeJoin(pkg.root, entry)
			exists := joinErr == nil && isRegularFile(full)
			if !exists {
				compatible = false
			}
			pv.Checks = append(pv.Checks, Check{Name: "platform_entry", OK: exists,
				Detail: entry + " " + existsDetail(exists)})
		}
	}

	if m.Runtime.Web != nil {
		pv.WebEntry = m.Runtime.Web.Entry
		full, joinErr := safeJoin(pkg.root, m.Runtime.Web.Entry)
		exists := joinErr == nil && isRegularFile(full)
		if !exists {
			compatible = false
		}
		pv.Checks = append(pv.Checks, Check{Name: "web_entry", OK: exists,
			Detail: m.Runtime.Web.Entry + " " + existsDetail(exists)})
		for _, style := range m.Runtime.Web.Styles {
			full, joinErr := safeJoin(pkg.root, style)
			if joinErr != nil || !isRegularFile(full) {
				compatible = false
				pv.Checks = append(pv.Checks, Check{Name: "style", OK: false,
					Detail: style + " 不存在"})
			}
		}
	}

	if m.Icon != "" {
		full, joinErr := safeJoin(pkg.root, m.Icon)
		exists := joinErr == nil && isRegularFile(full)
		if !exists {
			compatible = false
		}
		pv.Checks = append(pv.Checks, Check{Name: "icon", OK: exists,
			Detail: m.Icon + " " + existsDetail(exists)})
	}

	if m.Migrations != "" {
		full, joinErr := safeJoin(pkg.root, m.Migrations)
		exists := joinErr == nil && isDir(full)
		if !exists {
			compatible = false
		}
		pv.Checks = append(pv.Checks, Check{Name: "migrations", OK: exists,
			Detail: m.Migrations + " " + existsDetail(exists)})
	}

	pv.Compatible = compatible
	for _, p := range m.Permissions {
		pv.Permissions = append(pv.Permissions, PermissionInfo{
			Name:    p,
			Reason:  m.PermissionsReason[p],
			Risk:    PermissionRisk(p),
			Granted: false,
		})
	}
	if existing, err := h.loadState(ctx, m.ID); err == nil {
		info := h.infoFromRow(existing)
		pv.Existing = &info
	}
	return pv, nil
}

func hasLicense(root string) bool {
	for _, name := range []string{"LICENSE", "LICENSE.md", "LICENSE.txt"} {
		if isRegularFile(filepath.Join(root, name)) {
			return true
		}
	}
	return false
}

func licenseDetail(ok bool) string {
	if ok {
		return "LICENSE 存在"
	}
	return "包内缺少 LICENSE 文件"
}

func existsDetail(ok bool) string {
	if ok {
		return "存在"
	}
	return "不存在"
}

func isRegularFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// copyPackageDir 把包内容复制到安装目录：先写 .tmp-* 再 rename，避免半截目录。
func copyPackageDir(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("创建安装父目录失败：%w", err)
	}
	tmp, err := os.MkdirTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时安装目录失败：%w", err)
	}
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.RemoveAll(tmp)
		}
	}()

	err = filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		// 开发目录里的 .git 不复制进安装目录。
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") {
			return filepath.SkipDir
		}
		target := filepath.Join(tmp, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return wrap(ErrValidation, "安装包不允许符号链接：%s", rel)
		}
		if !d.Type().IsRegular() {
			return wrap(ErrValidation, "安装包不允许特殊文件：%s", rel)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if info.Mode()&0o111 != 0 {
			mode = 0o755
		}
		if err := copyFile(path, target, mode); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dst); err != nil {
		return fmt.Errorf("清理旧安装目录失败：%w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return fmt.Errorf("落盘安装目录失败：%w", err)
	}
	cleanupTmp = false
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("读取包文件失败：%w", err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("写入安装目录失败：%w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("复制包文件失败：%w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("复制包文件失败：%w", err)
	}
	return os.Chmod(dst, mode)
}

// hashDir 对目录内容做确定性 sha256：按相对路径排序，逐个写入路径 + 内容。
func hashDir(root string) (string, error) {
	var files []string
	var total int64
	limit := defaultArchiveLimits()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" || d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		// 目录来源也按安装包限额收口：不跟符号链接、不无限收集。
		if d.Type()&os.ModeSymlink != 0 {
			return wrap(ErrValidation, "安装目录里不允许符号链接：%s", path)
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			total += info.Size()
			if total > int64(limit.maxBytes) {
				return wrap(ErrValidation, "安装目录超过上限 %d 字节", limit.maxBytes)
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			files = append(files, rel)
			if len(files) > limit.maxFiles {
				return wrap(ErrValidation, "安装目录文件数超过上限 %d", limit.maxFiles)
			}
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("扫描目录失败：%w", err)
	}
	slices.Sort(files)
	sum := sha256.New()
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			return "", fmt.Errorf("读取 %s 失败：%w", rel, err)
		}
		fmt.Fprintf(sum, "%s\x00%d\x00", filepath.ToSlash(rel), len(data))
		sum.Write(data)
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// safeRemoveAll 删除 root 内的 target；target 不在 root 内或等于 root 时拒绝。
func safeRemoveAll(root, target string) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	if absRoot == absTarget || !withinDir(absRoot, absTarget) {
		return wrap(ErrValidation, "拒绝删除安装目录以外的路径：%s", absTarget)
	}
	if err := os.RemoveAll(absTarget); err != nil {
		return fmt.Errorf("删除 %s 失败：%w", absTarget, err)
	}
	return nil
}

// safeJoin 把包内相对路径拼到 root 下，拒绝逃逸。
func safeJoin(root, rel string) (string, error) {
	if !relPath(rel) {
		return "", wrap(ErrNotFound, "非法路径：%s", rel)
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	full := filepath.Join(rootAbs, filepath.FromSlash(rel))
	if !withinDir(rootAbs, full) {
		return "", wrap(ErrNotFound, "路径逃逸：%s", rel)
	}
	return full, nil
}

// withinDir 判断 target 是否在 dir 内（不包含 dir 本身）。
func withinDir(dir, target string) bool {
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absDir, absTarget)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// readStaticFile 读静态文件（限 64 MiB）并推断 Content-Type。
func readStaticFile(path string) ([]byte, string, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", wrap(ErrNotFound, "文件不存在")
		}
		return nil, "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	if !st.Mode().IsRegular() {
		return nil, "", wrap(ErrNotFound, "文件不存在")
	}
	if st.Size() > maxArchiveBytes {
		return nil, "", wrap(ErrValidation, "静态文件超过上限 %d 字节", maxArchiveBytes)
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, "", err
	}
	return data, contentTypeByExt(filepath.Ext(path)), nil
}

// contentTypeByExt 按扩展名给前端静态资源定 Content-Type。
func contentTypeByExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	case ".wasm":
		return "application/wasm"
	default:
		return "application/octet-stream"
	}
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
