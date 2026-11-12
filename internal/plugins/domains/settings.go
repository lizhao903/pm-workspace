// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domains

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Settings 同原型 DomainSettings，多 aliases、http_port、https_port。
type Settings struct {
	Enabled     bool     `json:"enabled"`
	Suffix      string   `json:"suffix"`
	Resolve     string   `json:"resolve"`
	Proxy       string   `json:"proxy"`
	HTTPS       bool     `json:"https"`
	CAInstalled bool     `json:"ca_installed"`
	LAN         bool     `json:"lan"`
	LANIP       string   `json:"lan_ip"`
	AutoProto   bool     `json:"auto_proto"`
	Aliases     []string `json:"aliases"`
	HTTPPort    int      `json:"http_port"`
	HTTPSPort   int      `json:"https_port"`
	UpdatedAt   string   `json:"updated_at"`
}

var (
	resolveModes = []string{"hosts", "local_dns", "router_dns"}
	proxyKinds   = []string{"builtin", "caddy", "nginx"}
	suffixRe     = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)*$`)
	hostRe       = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
)

// validSuffix 同原型：小写字母数字连字符，点隔开；.local 被 mDNS 占用，不能用。
func validSuffix(s string) bool {
	return len(s) <= 200 && suffixRe.MatchString(s) && s != "local" && !strings.HasSuffix(s, ".local")
}

func validHost(h string) bool { return hostRe.MatchString(h) }

// ip 是域名应该解析到的地址：开了局域网访问是 lan_ip，否则 127.0.0.1。
func (s Settings) ip() string {
	if s.LAN {
		return s.LANIP
	}
	return "127.0.0.1"
}

const settingsCols = `enabled, suffix, resolve, proxy, https, ca_installed, lan, lan_ip, auto_proto, aliases, http_port, https_port, updated_at`

// ensureDefaults 写默认设置和工作台那条路由，已有的不动；安装时调，读设置读不到时再补一次。
func ensureDefaults(ctx context.Context, st plugin.Store) error {
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := st.Exec(ctx, `INSERT OR IGNORE INTO domains_settings (id, suffix, aliases, updated_at) VALUES (1, 'bro.vip', '["broleez.vip"]', ?)`, now); err != nil {
		return err
	}
	_, err := st.Exec(ctx, `INSERT OR IGNORE INTO domains_routes (id, host, target_kind, note, created_at, updated_at) VALUES ('dm_app', '', 'app', '这个工作台', ?, ?)`, now, now)
	return err
}

func (h *handlers) loadSettings(ctx context.Context) (Settings, error) {
	s, err := h.readSettings(ctx)
	if errors.Is(err, plugin.ErrNoRows) {
		if err := ensureDefaults(ctx, h.c.Store()); err != nil {
			return s, err
		}
		return h.readSettings(ctx)
	}
	return s, err
}

func (h *handlers) readSettings(ctx context.Context) (Settings, error) {
	var s Settings
	var aliases string
	err := h.c.Store().QueryRow(ctx, `SELECT `+settingsCols+` FROM domains_settings WHERE id = 1`).Scan(
		&s.Enabled, &s.Suffix, &s.Resolve, &s.Proxy, &s.HTTPS, &s.CAInstalled, &s.LAN, &s.LANIP, &s.AutoProto,
		&aliases, &s.HTTPPort, &s.HTTPSPort, &s.UpdatedAt)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal([]byte(aliases), &s.Aliases); err != nil || s.Aliases == nil {
		s.Aliases = []string{}
	}
	return s, nil
}

func (h *handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	s, err := h.loadSettings(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	// 可达检测带 Host 头请求这个接口，认这个头判断回到的是不是本服务
	w.Header().Set(instanceHeader, h.p.inst)
	writeJSON(w, http.StatusOK, map[string]any{"data": s})
}

// putSettings 只改 body 里出现的字段，没出现的保持原样。
func (h *handlers) putSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	s, err := h.loadSettings(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := applySettings(&s, raw); err != nil {
		h.fail(w, r, err)
		return
	}
	aliases, _ := json.Marshal(s.Aliases)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE domains_settings SET enabled = ?, suffix = ?, resolve = ?, proxy = ?, https = ?,
		ca_installed = ?, lan = ?, lan_ip = ?, auto_proto = ?, aliases = ?, http_port = ?, https_port = ?, updated_at = ? WHERE id = 1`,
		s.Enabled, s.Suffix, s.Resolve, s.Proxy, s.HTTPS, s.CAInstalled, s.LAN, s.LANIP, s.AutoProto,
		string(aliases), s.HTTPPort, s.HTTPSPort, now); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.snap.invalidate()
	// 关掉自动分配：删掉全部自动路由，手动的不动（DOM-02c）
	if !s.AutoProto {
		if err := h.deleteAutoRoutes(ctx); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	// 刚打开自动分配：给已经在跑的原型补上域名（DOM-02a）
	if s.AutoProto {
		for _, ev := range h.p.protos.runningEvents() {
			if err := h.ensureAuto(ctx, ev); err != nil {
				h.c.Log().Warn("auto route not created", "prototype", ev.ID, "err", err)
			}
		}
		h.p.snap.invalidate()
	}
	h.getSettings(w, r)
}

func applySettings(s *Settings, raw map[string]json.RawMessage) error {
	for k, v := range raw {
		var err error
		switch k {
		case "enabled":
			err = json.Unmarshal(v, &s.Enabled)
		case "suffix":
			err = json.Unmarshal(v, &s.Suffix)
			s.Suffix = strings.ToLower(strings.Join(strings.Fields(s.Suffix), ""))
		case "resolve":
			err = json.Unmarshal(v, &s.Resolve)
		case "proxy":
			err = json.Unmarshal(v, &s.Proxy)
		case "https":
			err = json.Unmarshal(v, &s.HTTPS)
		case "ca_installed":
			err = json.Unmarshal(v, &s.CAInstalled)
		case "lan":
			err = json.Unmarshal(v, &s.LAN)
		case "lan_ip":
			err = json.Unmarshal(v, &s.LANIP)
			s.LANIP = strings.TrimSpace(s.LANIP)
		case "auto_proto":
			err = json.Unmarshal(v, &s.AutoProto)
		case "aliases":
			err = json.Unmarshal(v, &s.Aliases)
			for i, a := range s.Aliases {
				s.Aliases[i] = strings.ToLower(strings.TrimSpace(a))
			}
		case "http_port":
			err = json.Unmarshal(v, &s.HTTPPort)
		case "https_port":
			err = json.Unmarshal(v, &s.HTTPSPort)
		case "updated_at":
			continue
		default:
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
		if err != nil {
			return apiErr(errValidation, "%s 的类型不对", k)
		}
	}
	if s.Aliases == nil {
		s.Aliases = []string{}
	}
	return checkSettings(*s)
}

func checkSettings(s Settings) error {
	if !validSuffix(s.Suffix) {
		return apiErr(errValidation, "后缀不合法；也别用 .local，它被系统的 mDNS 占用了")
	}
	if !contains(resolveModes, s.Resolve) {
		return apiErr(errValidation, "resolve 只能是 hosts、local_dns、router_dns")
	}
	if !contains(proxyKinds, s.Proxy) {
		return apiErr(errValidation, "proxy 只能是 builtin、caddy、nginx")
	}
	if s.LAN || s.Resolve == "router_dns" {
		if ip := net.ParseIP(s.LANIP); ip == nil || ip.To4() == nil {
			return apiErr(errValidation, "本机局域网地址要是 IPv4，比如 192.168.1.23")
		}
	} else if s.LANIP != "" && net.ParseIP(s.LANIP) == nil {
		return apiErr(errValidation, "本机局域网地址不合法：%s", s.LANIP)
	}
	seen := map[string]bool{s.Suffix: true}
	for _, a := range s.Aliases {
		if !validSuffix(a) || !strings.Contains(a, ".") {
			return apiErr(errValidation, "别名 %q 不合法；要是完整域名，也别用 .local", a)
		}
		if seen[a] {
			return apiErr(errValidation, "别名 %s 重复了", a)
		}
		seen[a] = true
	}
	for _, p := range []int{s.HTTPPort, s.HTTPSPort} {
		if p < 1 || p > 65535 {
			return apiErr(errValidation, "端口要在 1 到 65535 之间：%d", p)
		}
	}
	if s.HTTPPort == s.HTTPSPort {
		return apiErr(errValidation, "明文口和 TLS 口不能相同")
	}
	return nil
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
