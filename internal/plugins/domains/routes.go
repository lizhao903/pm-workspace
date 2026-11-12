// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domains

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Target 同原型 RouteTarget：app 是这个工作台，proto 是项目原型，url 是任意上游地址。
type Target struct {
	Kind    string `json:"kind"`
	ProtoID string `json:"proto_id,omitempty"`
	URL     string `json:"url,omitempty"`
}

// Check 是最近一次解析测试，按完整域名另存。
type Check struct {
	OK      bool   `json:"ok"`
	At      string `json:"at"`
	Message string `json:"message"`
}

// Route 同原型 DomainRoute，多完整域名 fqdn 和时间。
type Route struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	FQDN      string `json:"fqdn"`
	Target    Target `json:"target"`
	Enabled   bool   `json:"enabled"`
	Auto      bool   `json:"auto"`
	Note      string `json:"note"`
	Check     *Check `json:"check"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`

	protoPort int // 目标是原型且原型在运行时的端口（DOM-02a），不出现在接口里
}

// fqdn：子域名为空（只有工作台那条可以）时完整域名就是后缀本身。
func fqdn(host, suffix string) string {
	if host == "" {
		return suffix
	}
	return host + "." + suffix
}

const routeCols = `id, host, target_kind, proto_id, url, enabled, auto, note, created_at, updated_at`

func scanRoute(row plugin.Row) (Route, error) {
	var rt Route
	err := row.Scan(&rt.ID, &rt.Host, &rt.Target.Kind, &rt.Target.ProtoID, &rt.Target.URL, &rt.Enabled, &rt.Auto, &rt.Note, &rt.CreatedAt, &rt.UpdatedAt)
	return rt, err
}

// loadRoutes 按创建先后取全部路由，带上完整域名和最近一次测试。
func (h *handlers) loadRoutes(ctx context.Context, s Settings) ([]Route, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+routeCols+` FROM domains_routes ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Route{}
	for rows.Next() {
		rt, err := scanRoute(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	checks, err := h.loadChecks(ctx)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].FQDN = fqdn(out[i].Host, s.Suffix)
		h.fillPort(&out[i])
		if c, ok := checks[out[i].FQDN]; ok {
			out[i].Check = &c
		}
	}
	return out, nil
}

func (h *handlers) fillPort(rt *Route) {
	if rt.Target.Kind == "proto" {
		rt.protoPort, _ = h.p.protos.running(rt.Target.ProtoID)
	}
}

func (h *handlers) loadChecks(ctx context.Context) (map[string]Check, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT fqdn, ok, at, message FROM domains_checks`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]Check{}
	for rows.Next() {
		var f string
		var c Check
		if err := rows.Scan(&f, &c.OK, &c.At, &c.Message); err != nil {
			return nil, err
		}
		out[f] = c
	}
	return out, rows.Err()
}

func (h *handlers) getRoute(ctx context.Context, id string, s Settings) (Route, error) {
	rt, err := scanRoute(h.c.Store().QueryRow(ctx, `SELECT `+routeCols+` FROM domains_routes WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return rt, apiErr(errNotFound, "域名 %s 不存在", id)
	}
	if err != nil {
		return rt, err
	}
	rt.FQDN = fqdn(rt.Host, s.Suffix)
	h.fillPort(&rt)
	checks, err := h.loadChecks(ctx)
	if err != nil {
		return rt, err
	}
	if c, ok := checks[rt.FQDN]; ok {
		rt.Check = &c
	}
	return rt, nil
}

func (h *handlers) listRoutes(w http.ResponseWriter, r *http.Request) {
	s, err := h.loadSettings(r.Context())
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.loadRoutes(r.Context(), s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handlers) addRoute(w http.ResponseWriter, r *http.Request) {
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
	rt := Route{Enabled: true}
	if err := applyRoute(&rt, raw, true); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.checkUnique(ctx, rt.Host, ""); err != nil {
		h.fail(w, r, err)
		return
	}
	rt.ID = idgen.Prefixed("dm")
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO domains_routes (`+routeCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rt.ID, rt.Host, rt.Target.Kind, rt.Target.ProtoID, rt.Target.URL, rt.Enabled, rt.Auto, rt.Note, now, now); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.snap.invalidate()
	out, err := h.getRoute(ctx, rt.ID, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

// updateRoute 只改 body 里出现的字段；自动分配的改了就转成手动（auto 置假，SPEC-settings-20.16）。
func (h *handlers) updateRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
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
	rt, err := h.getRoute(ctx, id, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if err := applyRoute(&rt, raw, false); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := h.checkUnique(ctx, rt.Host, id); err != nil {
		h.fail(w, r, err)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := h.c.Store().Exec(ctx, `UPDATE domains_routes SET host = ?, target_kind = ?, proto_id = ?, url = ?, enabled = ?,
		auto = 0, note = ?, updated_at = ? WHERE id = ?`,
		rt.Host, rt.Target.Kind, rt.Target.ProtoID, rt.Target.URL, rt.Enabled, rt.Note, now, id); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.snap.invalidate()
	out, err := h.getRoute(ctx, id, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handlers) removeRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	s, err := h.loadSettings(ctx)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	rt, err := h.getRoute(ctx, id, s)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if rt.Target.Kind == "app" {
		h.fail(w, r, apiErr(errConflict, "工作台自己的域名不能删，不用可以停用"))
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM domains_routes WHERE id = ?`, id); err != nil {
		h.fail(w, r, err)
		return
	}
	h.p.snap.invalidate()
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// checkUnique：子域名不能和别的路由重名（含停用的），except 是正在改的那条。
func (h *handlers) checkUnique(ctx context.Context, host, except string) error {
	var n int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM domains_routes WHERE host = ? AND id <> ?`, host, except).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		if host == "" {
			return apiErr(errConflict, "已经有一条不带子域名的了")
		}
		return apiErr(errConflict, "已经有这个域名了")
	}
	return nil
}

func applyRoute(rt *Route, raw map[string]json.RawMessage, create bool) error {
	for k, v := range raw {
		var err error
		switch k {
		case "host":
			err = json.Unmarshal(v, &rt.Host)
			rt.Host = strings.ToLower(strings.TrimSpace(rt.Host))
		case "target":
			rt.Target = Target{}
			err = json.Unmarshal(v, &rt.Target)
		case "enabled":
			err = json.Unmarshal(v, &rt.Enabled)
		case "note":
			err = json.Unmarshal(v, &rt.Note)
		case "auto":
			// 只在新建时认，DOM-02a 建自动分配的路由用
			if create {
				err = json.Unmarshal(v, &rt.Auto)
			}
		case "id", "fqdn", "check", "created_at", "updated_at":
			continue
		default:
			return apiErr(errValidation, "不认识的字段 %s", k)
		}
		if err != nil {
			return apiErr(errValidation, "%s 的类型不对", k)
		}
	}
	return checkRoute(*rt)
}

func checkRoute(rt Route) error {
	switch rt.Target.Kind {
	case "app":
	case "proto":
		if strings.TrimSpace(rt.Target.ProtoID) == "" {
			return apiErr(errValidation, "目标是项目原型时要选一个原型")
		}
	case "url":
		u, err := url.Parse(strings.TrimSpace(rt.Target.URL))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return apiErr(errValidation, "目标地址要是 http:// 或 https:// 开头的完整地址")
		}
	case "":
		return apiErr(errValidation, "缺少 target")
	default:
		return apiErr(errValidation, "target.kind 只能是 app、proto、url")
	}
	if rt.Host == "" {
		if rt.Target.Kind != "app" {
			return apiErr(errValidation, "只有工作台自己的域名可以不带子域名")
		}
	} else if !validHost(rt.Host) {
		return apiErr(errValidation, "子域名只能用小写字母、数字和连字符")
	}
	if len([]rune(rt.Note)) > 200 {
		return apiErr(errValidation, "备注最多 200 字")
	}
	return nil
}
