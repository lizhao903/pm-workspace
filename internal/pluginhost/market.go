// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 市场索引 v1（docs/plugin-spec-v2.md 第 11 节）：
// 用户给一个索引 URL，宿主拉取/校验 JSON，按当前平台和兼容性计算可安装版本。
// 索引本身不是指令：安装时仍走 Resolve/Install 校验真实包与权限。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	marketIndexMaxBytes = 2 << 20
	marketIndexTimeout  = 10 * time.Second
)

// MarketIndex 是索引文档 v1。
type MarketIndex struct {
	IndexVersion int            `json:"index_version"`
	Title        string         `json:"title"`
	Description  string         `json:"description,omitempty"`
	Plugins      []MarketPlugin `json:"plugins"`
}

// MarketPlugin 是索引里的一条插件。
type MarketPlugin struct {
	ID          string            `json:"id"`
	Title       map[string]string `json:"title,omitempty"`
	Description map[string]string `json:"description,omitempty"`
	Author      string            `json:"author,omitempty"`
	Repository  string            `json:"repository"`
	Categories  []string          `json:"categories,omitempty"`
	Labels      []string          `json:"labels,omitempty"`
	Versions    []MarketVersion   `json:"versions"`
}

// MarketVersion 是一个可安装版本。
type MarketVersion struct {
	Version     string       `json:"version"`
	PublishedAt string       `json:"published_at,omitempty"`
	API         string       `json:"api"`
	PMW         string       `json:"pmw"`
	Source      MarketSource `json:"source"`
	Permissions []string     `json:"permissions,omitempty"`
	Icon        string       `json:"icon,omitempty"`
}

// MarketSource 目前只支持 GitHub Release 资产。
type MarketSource struct {
	Type       string                 `json:"type"` // github-release
	Repository string                 `json:"repository"`
	Tag        string                 `json:"tag"`
	Commit     string                 `json:"commit,omitempty"`
	Assets     map[string]MarketAsset `json:"assets"`
}

// MarketAsset 是某平台安装包。
type MarketAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// MarketEntry 是校验/兼容计算后返回给前端的条目。
type MarketEntry struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Author      string               `json:"author,omitempty"`
	Repository  string               `json:"repository"`
	Categories  []string             `json:"categories,omitempty"`
	Labels      []string             `json:"labels,omitempty"`
	Versions    []MarketEntryVersion `json:"versions"`
}

// MarketEntryVersion 带兼容性判断和可直接安装的来源。
type MarketEntryVersion struct {
	Version     string        `json:"version"`
	PublishedAt string        `json:"published_at,omitempty"`
	Compatible  bool          `json:"compatible"`
	Reason      string        `json:"reason,omitempty"`
	Install     MarketInstall `json:"install"`
	Permissions []string      `json:"permissions,omitempty"`
}

// MarketInstall 是前端点「安装」时交给 resolve/install 的来源。
type MarketInstall struct {
	Type   string `json:"type"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// MarketView 是接口返回。
type MarketView struct {
	Title       string        `json:"title"`
	Description string        `json:"description,omitempty"`
	Entries     []MarketEntry `json:"entries"`
	// Signed 表示索引通过了 ed25519 签名校验；Publisher 是签名文件里的发布者标识。
	Signed    bool   `json:"signed"`
	Publisher string `json:"publisher,omitempty"`
}

// indexSignature 是 URL+".sig" 的内容：base64 的 ed25519 公钥与签名（对 index.json 原始字节）。
type indexSignature struct {
	Key       string `json:"key"`
	Sig       string `json:"sig"`
	Publisher string `json:"publisher,omitempty"`
}

const indexKeysTable = "plugin_index_keys"

// FetchMarketIndex 拉取并校验索引；只接受 http(s)，单次 ≤2 MiB、10s 超时。
func (h *Host) FetchMarketIndex(ctx context.Context, rawURL string) (*MarketView, error) {
	rawURL = strings.TrimSpace(rawURL)
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, wrap(ErrValidation, "索引 URL 必须是 http(s) 且不带凭证/片段：%q", rawURL)
	}
	client := *h.httpClient
	client.Timeout = marketIndexTimeout
	// 索引只允许同源重定向，避免被跳到任意地址。
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return wrap(ErrValidation, "索引重定向次数过多")
		}
		if req.URL.Host != u.Host {
			return wrap(ErrValidation, "索引不允许跨主机重定向：%s -> %s", u.Host, req.URL.Host)
		}
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, wrap(ErrValidation, "构造索引请求失败：%v", err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, wrap(ErrIncompatible, "拉取索引失败：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, wrap(ErrIncompatible, "索引返回 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, marketIndexMaxBytes+1))
	if err != nil {
		return nil, wrap(ErrIncompatible, "读取索引失败：%v", err)
	}
	if len(body) > marketIndexMaxBytes {
		return nil, wrap(ErrValidation, "索引超过 2 MiB")
	}
	var idx MarketIndex
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, wrap(ErrValidation, "索引不是合法 JSON：%v", err)
	}
	view, err := h.marketView(&idx, rawURL)
	if err != nil {
		return nil, err
	}
	signed, publisher, err := h.verifyIndexSignature(ctx, rawURL, body)
	if err != nil {
		return nil, err
	}
	view.Signed = signed
	view.Publisher = publisher
	return view, nil
}

// verifyIndexSignature 拉取 <index>.sig 并验签；一旦某 URL 有过签名，后续无签名直接拒绝（防降级）。
func (h *Host) verifyIndexSignature(ctx context.Context, indexURL string, raw []byte) (bool, string, error) {
	sigURL := strings.TrimSuffix(indexURL, "/") + ".sig"
	sigData, status, err := h.fetchOptional(ctx, sigURL)
	if err != nil {
		return false, "", err
	}
	row, known, kerr := h.lookupIndexKey(ctx, indexURL)
	if kerr != nil {
		return false, "", kerr
	}
	if status == http.StatusNotFound {
		if known {
			return false, "", wrap(ErrValidation, "索引 %s 之前是签名的，这次没有 .sig；拒绝降级到未签名索引", indexURL)
		}
		return false, "", nil
	}
	var sig indexSignature
	if err := json.Unmarshal(sigData, &sig); err != nil || sig.Key == "" || sig.Sig == "" {
		return false, "", wrap(ErrValidation, "索引签名文件不是合法 JSON（需要 key/sig）")
	}
	if err := verifyPublisherSignature(sig.Key, sig.Sig, raw); err != nil {
		return false, "", err
	}
	if known && row != sig.Key {
		return false, "", wrap(ErrConflict, "索引 %s 的签名公钥变了（旧 %s，新 %s）；确认来源后清理 %s 再重试",
			indexURL, publisherFingerprint(row), publisherFingerprint(sig.Key), indexKeysTable)
	}
	if !known {
		if err := h.rememberIndexKey(ctx, indexURL, sig.Key); err != nil {
			return false, "", err
		}
	} else {
		_ = h.touchIndexKey(ctx, indexURL)
	}
	return true, sig.Publisher, nil
}

func (h *Host) ensureIndexKeysTable(ctx context.Context) error {
	if h.opts.DB == nil {
		return wrap(ErrValidation, "宿主未配置状态库")
	}
	_, err := h.opts.DB.W.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS `+indexKeysTable+` (
			index_url TEXT PRIMARY KEY, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
			first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)`)
	if err != nil {
		return fmt.Errorf("初始化索引公钥表失败：%w", err)
	}
	return nil
}

func (h *Host) lookupIndexKey(ctx context.Context, indexURL string) (string, bool, error) {
	if h.opts.DB == nil {
		return "", false, nil
	}
	if err := h.ensureIndexKeysTable(ctx); err != nil {
		return "", false, err
	}
	var key string
	err := h.opts.DB.R.QueryRowContext(ctx,
		`SELECT public_key FROM `+indexKeysTable+` WHERE index_url = ?`, indexURL).Scan(&key)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("读取索引公钥失败：%w", err)
	}
	return key, true, nil
}

func (h *Host) rememberIndexKey(ctx context.Context, indexURL, key string) error {
	now := formatStateTime(nowUTC())
	_, err := h.opts.DB.W.ExecContext(ctx,
		`INSERT INTO `+indexKeysTable+` (index_url, public_key, fingerprint, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`,
		indexURL, key, publisherFingerprint(key), now, now)
	if err != nil {
		return fmt.Errorf("记录索引公钥失败：%w", err)
	}
	return nil
}

func (h *Host) touchIndexKey(ctx context.Context, indexURL string) error {
	_, err := h.opts.DB.W.ExecContext(ctx,
		`UPDATE `+indexKeysTable+` SET last_seen = ? WHERE index_url = ?`, formatStateTime(nowUTC()), indexURL)
	return err
}

// fetchOptional 拉一个可选的小文件：404 返回 (nil, 404, nil)，其它错误返回 error。
func (h *Host) fetchOptional(ctx context.Context, rawURL string) ([]byte, int, error) {
	client := *h.httpClient
	client.Timeout = marketIndexTimeout
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, wrap(ErrValidation, "构造请求失败：%v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, wrap(ErrIncompatible, "拉取 %s 失败：%v", rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, http.StatusNotFound, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, wrap(ErrIncompatible, "%s 返回 HTTP %d", rawURL, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, 0, wrap(ErrIncompatible, "读取 %s 失败：%v", rawURL, err)
	}
	return data, http.StatusOK, nil
}

func (h *Host) marketView(idx *MarketIndex, source string) (*MarketView, error) {
	if idx.IndexVersion != 1 {
		return nil, wrap(ErrValidation, "索引 index_version 必须是 1，收到 %d", idx.IndexVersion)
	}
	view := &MarketView{Title: idx.Title, Description: idx.Description}
	platform := platformKey()
	seen := map[string]bool{}
	for _, p := range idx.Plugins {
		if !idRe.MatchString(p.ID) || seen[p.ID] {
			return nil, wrap(ErrValidation, "索引里插件 id 非法或重复：%q（%s）", p.ID, source)
		}
		seen[p.ID] = true
		entry := MarketEntry{
			ID:          p.ID,
			Title:       firstLocalized(p.Title),
			Description: firstLocalized(p.Description),
			Author:      p.Author,
			Repository:  p.Repository,
			Categories:  p.Categories,
			Labels:      p.Labels,
		}
		if entry.Title == "" {
			entry.Title = p.ID
		}
		for _, v := range p.Versions {
			if v.Version == "" || v.Source.Type != "github-release" {
				continue
			}
			asset, ok := v.Source.Assets[platform]
			if !ok || asset.URL == "" || !isHex64(asset.SHA256) {
				continue
			}
			mv := MarketEntryVersion{
				Version:     v.Version,
				PublishedAt: v.PublishedAt,
				Permissions: v.Permissions,
				Install:     MarketInstall{Type: "github", URL: asset.URL, SHA256: strings.ToLower(asset.SHA256)},
			}
			if !plugin.Satisfies(ExternalAPIVersion, v.API) {
				mv.Reason = "插件 API 范围 " + v.API + " 不包含宿主 " + ExternalAPIVersion
			} else if v.PMW != "" && !pmwVersionMatches(h.opts.Version, v.PMW) {
				mv.Reason = "PMW 版本范围 " + v.PMW + " 不包含当前 " + h.opts.Version
			} else {
				mv.Compatible = true
			}
			entry.Versions = append(entry.Versions, mv)
		}
		if len(entry.Versions) == 0 {
			continue
		}
		// 版本按 SemVer 降序；默认版本 = 最高兼容稳定版（没有则最高兼容预发布，再没有就是最高版本）。
		sort.SliceStable(entry.Versions, func(i, j int) bool {
			a, _ := plugin.ParseVersion(entry.Versions[i].Version)
			b, _ := plugin.ParseVersion(entry.Versions[j].Version)
			return a[0] > b[0] || (a[0] == b[0] && (a[1] > b[1] || (a[1] == b[1] && a[2] > b[2])))
		})
		view.Entries = append(view.Entries, entry)
	}
	return view, nil
}

func firstLocalized(m map[string]string) string {
	if v := strings.TrimSpace(m["zh"]); v != "" {
		return v
	}
	for _, v := range m {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range strings.ToLower(s) {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
