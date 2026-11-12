// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

// 从网站取图标（TSK-0725）：只在用户在自定义连接器的抽屉里点「从网站取图标」时由后端去取，不定时、不自动。
//
// 规则（契约「自定义连接器」的「图标」一条）：
//   - 只对自定义分类（custom_mcp、custom_openapi），只按已保存的地址：MCP 的服务地址；OpenAPI 的接口地址，没填用文档地址。
//   - 出网同自定义连接器的口径：只发到用户填的那个站点——地址的主机，以及去掉第一段的上一级域名
//     （mcp.notion.com 也试 notion.com；IP 和只有两段的不再往上）；跳转最多 3 次，只能跳到这些主机或它们的子域名；
//     页面里写的图标地址同样只认这几个站点的，别的站点（如 CDN）跳过。不带连接器的凭证。
//   - 先读首页的 <link rel="apple-touch-icon"> 和 <link rel="icon">（大的优先），都没有或取不到再试 /favicon.ico。
//   - 每次请求 5 秒、整体 12 秒超时；首页最多读 512 KB；图标只收图片（Content-Type 是 png、jpeg、gif、webp、ico、svg，
//     类型不明时按内容判断，svg 必须对方声明），转成 data URL 后不超过图标上限（同上传，512 KB）。
//   - 取到就存进实例的 icon（同上传的图标，用户之后可以换掉或移除）；取不到回 409，图标不动。

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	siteIconReqTimeout = 5 * time.Second
	siteIconTimeout    = 12 * time.Second
	maxSitePage        = 512 << 10
	maxSiteRedirects   = 3
)

// IconFetchResult 是 POST /api/connectors/{id}/icon/fetch 的结果：source 是实际取到图标的地址。
type IconFetchResult struct {
	Source    string     `json:"source"`
	Connector *Connector `json:"connector"`
}

// iconImageTypes 是收的图片类型
var iconImageTypes = []string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon", "image/svg+xml"}

// iconAddressFields 是各自定义连接器拿来取图标的地址字段，按先后试。
var iconAddressFields = map[string][]string{
	CustomMCPTool:     {"url"},
	CustomOpenAPITool: {"base_url", "spec_url"},
}

// FetchIcon 按已保存的地址去对方网站取图标，存进 icon。不是自定义分类、没填地址回 400；取不到回 409。
func (s *Store) FetchIcon(ctx context.Context, id string) (*IconFetchResult, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	d, ok := s.defs.Get(cur.Tool)
	if !ok {
		return nil, conflict("connector definition %s is not available", cur.Tool)
	}
	if d.Category != "custom" {
		return nil, invalid("only custom connectors can fetch an icon from their website")
	}
	var addrs []string
	for _, k := range iconAddressFields[cur.Tool] {
		if v := strings.TrimSpace(cur.Config[k]); v != "" {
			addrs = append(addrs, v)
		}
	}
	if len(addrs) == 0 {
		return nil, invalid("还没保存服务地址，取不到网站图标")
	}
	ctx, cancel := context.WithTimeout(ctx, siteIconTimeout)
	defer cancel()
	var lastErr error
	for _, a := range addrs {
		icon, src, err := siteIcon(ctx, s.iconClient(), a)
		if err == nil {
			c, err := s.Update(context.WithoutCancel(ctx), id, Patch{Icon: &icon})
			if err != nil {
				return nil, err
			}
			return &IconFetchResult{Source: src, Connector: c}, nil
		}
		lastErr = err
	}
	return nil, conflict("没取到图标：%v", lastErr)
}

// iconClient 是取图标用的 HTTP 客户端；测试经 SetIconTransport 换掉底层传输。
func (s *Store) iconClient() *http.Client {
	return &http.Client{Timeout: siteIconReqTimeout, Transport: s.iconTransport}
}

// SetIconTransport 换取图标用的底层传输，测试用；nil 用默认。
func (s *Store) SetIconTransport(t http.RoundTripper) { s.iconTransport = t }

// siteBase 是这个主机所在的站点：主机本身；三段以上的域名去掉第一段（mcp.notion.com -> notion.com）。
func siteBase(host string) string {
	if net.ParseIP(host) != nil {
		return host
	}
	parts := strings.Split(host, ".")
	if len(parts) >= 3 {
		return strings.Join(parts[1:], ".")
	}
	return host
}

// sameSite：主机是 base 或它的子域名。
func sameSite(host, base string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == base || strings.HasSuffix(host, "."+base)
}

// site 是一个站点：base 见 siteBase，port 是用户地址里写明的端口（没写为空）。
type site struct{ base, port string }

// allows：http(s)，主机在这个站点里；写明了端口的只能是同一个端口（本机、内网服务按端口区分）。
func (s site) allows(u *url.URL) bool {
	return (u.Scheme == "http" || u.Scheme == "https") && sameSite(u.Hostname(), s.base) && (u.Port() == "" || u.Port() == s.port)
}

// siteIcon 按一个地址取图标，回 data URL 和取到的地址。
func siteIcon(ctx context.Context, hc *http.Client, raw string) (string, string, error) {
	u, err := parseCustomURL("服务地址", raw)
	if err != nil {
		return "", "", err
	}
	host := strings.ToLower(u.Hostname())
	base := siteBase(host)
	st := site{base: base, port: u.Port()}
	c := *hc
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) > maxSiteRedirects {
			return errors.New("跳转太多")
		}
		if !st.allows(req.URL) {
			return fmt.Errorf("跳到了别的网站 %s", req.URL.Host)
		}
		return nil
	}
	origins := []string{u.Scheme + "://" + u.Host}
	if base != host {
		origins = append(origins, u.Scheme+"://"+base)
	}
	var lastErr error
	tried := map[string]bool{}
	for _, o := range origins {
		cands, err := pageIcons(ctx, &c, o+"/", st)
		if err != nil {
			lastErr = err
		}
		cands = append(cands, o+"/favicon.ico")
		for _, ic := range cands {
			if tried[ic] {
				continue
			}
			tried[ic] = true
			data, err := fetchImage(ctx, &c, ic)
			if err == nil {
				return data, ic, nil
			}
			lastErr = err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("网站上没有图标")
	}
	return "", "", lastErr
}

var (
	linkTagRe = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	attrRe    = regexp.MustCompile(`(?is)([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	sizeRe    = regexp.MustCompile(`(?i)(\d+)x(\d+)`)
)

// pageIcons 读首页，按优先顺序回页面里写的图标地址（只留同站点的）。
func pageIcons(ctx context.Context, hc *http.Client, page string, st site) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, page, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "pmw-icon-fetch/1")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("打不开 %s：%w", page, unwrapURLErr(err))
	}
	defer resp.Body.Close()
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode != http.StatusOK || ct != "text/html" {
		return nil, fmt.Errorf("%s 不是网页（%d %s）", page, resp.StatusCode, ct)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSitePage))
	if err != nil {
		return nil, err
	}
	type cand struct {
		href  string
		score int
	}
	var cs []cand
	for _, tag := range linkTagRe.FindAllString(string(body), -1) {
		attrs := map[string]string{}
		for _, m := range attrRe.FindAllStringSubmatch(tag, -1) {
			attrs[strings.ToLower(m[1])] = html.UnescapeString(m[2] + m[3] + m[4])
		}
		rels := strings.Fields(strings.ToLower(attrs["rel"]))
		href := strings.TrimSpace(attrs["href"])
		if href == "" || strings.HasPrefix(href, "data:") {
			continue
		}
		var score int
		switch {
		case slices.Contains(rels, "apple-touch-icon"), slices.Contains(rels, "apple-touch-icon-precomposed"):
			score = 3000
		case slices.Contains(rels, "icon"):
			score = 1000
		default:
			continue
		}
		if m := sizeRe.FindStringSubmatch(attrs["sizes"]); m != nil {
			n, _ := strconv.Atoi(m[1])
			score += min(n, 512)
		} else if strings.Contains(strings.ToLower(attrs["type"]), "svg") || strings.EqualFold(attrs["sizes"], "any") {
			score += 256
		}
		ref, err := resp.Request.URL.Parse(href)
		if err != nil || !st.allows(ref) {
			continue
		}
		cs = append(cs, cand{ref.String(), score})
	}
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].score > cs[j].score })
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.href)
	}
	return out, nil
}

// maxIconBytes 是图片本身的上限：转成 base64 加前缀后不超过 maxIcon
const maxIconBytes = (maxIcon - 64) / 4 * 3

// fetchImage 取一张图，回 data URL。
func fetchImage(ctx context.Context, hc *http.Client, raw string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "image/*")
	req.Header.Set("User-Agent", "pmw-icon-fetch/1")
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("取 %s 失败：%w", raw, unwrapURLErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s 回了 %d", raw, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxIconBytes+1))
	if err != nil {
		return "", err
	}
	if len(b) > maxIconBytes {
		return "", fmt.Errorf("%s 超过 %d KB", raw, maxIconBytes>>10)
	}
	if len(b) == 0 {
		return "", fmt.Errorf("%s 是空的", raw)
	}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if !slices.Contains(iconImageTypes, ct) {
		// 没声明或声明得不准时按内容判断；svg 判断不出来，必须对方声明
		sniff, _, _ := mime.ParseMediaType(http.DetectContentType(b))
		if !slices.Contains(iconImageTypes, sniff) || sniff == "image/svg+xml" {
			return "", fmt.Errorf("%s 不是图片（%s）", raw, firstNonEmpty(ct, sniff))
		}
		ct = sniff
	}
	return "data:" + ct + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

// unwrapURLErr 去掉 *url.Error 的「Get "…": 」前缀，地址前面已经写了。
func unwrapURLErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
