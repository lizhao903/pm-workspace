package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Google 账号（BR-01a）：不单独存，以 Google Drive 连接器实例作为浏览器的 Google 账号（同一个 OAuth 客户端）。
// 登录转调 Drive 实例的 OAuth 授权；退出断开这个账号的 Drive 和日历实例；
// 在连接器设置页断开或删掉 Drive，这里就算没登录（SPEC-browser-4.13）。

// 连接器工具 key，同原型 gdrive、gcal（内核 connector.GoogleDriveTool；日历是 CONN-01e2）
const (
	driveTool    = "gdrive"
	calendarTool = "gcal"
	scopePrefix  = "https://www.googleapis.com/auth/"
)

// ConnRef 是账号用到的一个连接器实例的状态。
type ConnRef struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Status       string     `json:"status"`
	Error        string     `json:"error"`
	Account      string     `json:"account"`
	Scopes       []string   `json:"scopes"`
	AuthorizedAt *time.Time `json:"authorized_at"`
}

// Account 是登录着的账号，字段同原型 GoogleAccount 去掉 avatarColor（前端按邮箱算）。
type Account struct {
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	Scopes      []string   `json:"scopes"`
	ConnectedAt *time.Time `json:"connected_at"`
}

// GoogleState 是 GET /api/browser/google 的结果。
type GoogleState struct {
	// SignedIn 以 Drive 实例为准：授权过、没断开
	SignedIn bool `json:"signed_in"`
	// Configured 是有没有 Google Drive 连接器实例（OAuth 客户端填在实例的配置里）
	Configured bool     `json:"configured"`
	Account    *Account `json:"account"`
	Drive      *ConnRef `json:"drive"`
	Calendar   *ConnRef `json:"calendar"`
}

func authorized(c plugin.ConnectorInfo) bool {
	return c.AuthorizedAt != nil && c.Status != "disconnected"
}

// shortScopes 把 Google 的范围地址换成原型 GOOGLE_SCOPES 的 key（drive.readonly 之类），openid、email 不算。
func shortScopes(scope string) []string {
	out := []string{}
	for _, s := range strings.Fields(scope) {
		if k, ok := strings.CutPrefix(s, scopePrefix); ok && k != "" && !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	return out
}

func ref(c plugin.ConnectorInfo) *ConnRef {
	return &ConnRef{ID: c.ID, Name: c.Name, Status: c.Status, Error: c.Error, Account: c.Account,
		Scopes: shortScopes(c.Scope), AuthorizedAt: c.AuthorizedAt}
}

// pick 挑浏览器用的实例：先挑授权着的（account 非空时要同一个账号），再退到最新建的。
func pick(list []plugin.ConnectorInfo, account string) (plugin.ConnectorInfo, bool) {
	for _, c := range list {
		if authorized(c) && (account == "" || strings.EqualFold(c.Account, account)) {
			return c, true
		}
	}
	if len(list) > 0 && account == "" {
		return list[0], true
	}
	return plugin.ConnectorInfo{}, false
}

type googleConns struct {
	drives, calendars []plugin.ConnectorInfo
	drive             *plugin.ConnectorInfo
}

func (h *handler) googleConns(ctx context.Context) (googleConns, error) {
	cs := h.c.Connectors()
	var g googleConns
	var err error
	if g.drives, err = cs.List(ctx, driveTool); err != nil {
		return g, err
	}
	if g.calendars, err = cs.List(ctx, calendarTool); err != nil {
		return g, err
	}
	if d, ok := pick(g.drives, ""); ok {
		g.drive = &d
	}
	return g, nil
}

func (h *handler) googleState(ctx context.Context) (GoogleState, error) {
	g, err := h.googleConns(ctx)
	if err != nil {
		return GoogleState{}, err
	}
	st := GoogleState{Configured: len(g.drives) > 0}
	if g.drive == nil {
		return st, nil
	}
	d := *g.drive
	st.Drive = ref(d)
	if !authorized(d) {
		if c, ok := pick(g.calendars, ""); ok {
			st.Calendar = ref(c)
		}
		return st, nil
	}
	st.SignedIn = true
	acc := &Account{Email: d.Account, Scopes: shortScopes(d.Scope), ConnectedAt: d.AuthorizedAt}
	acc.Name, _, _ = strings.Cut(d.Account, "@")
	if c, ok := pick(g.calendars, d.Account); ok {
		st.Calendar = ref(c)
		if authorized(c) {
			for _, s := range shortScopes(c.Scope) {
				if !slices.Contains(acc.Scopes, s) {
					acc.Scopes = append(acc.Scopes, s)
				}
			}
		}
	}
	st.Account = acc
	return st, nil
}

func (h *handler) google(w http.ResponseWriter, r *http.Request) {
	st, err := h.googleState(r.Context())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": st})
}

// googleLogin 转调 Drive 实例的 OAuth 授权：body 可空或 {return_to}，回 {connector_id, authorize_url, redirect_uri, expires_at, calendar}。
// 有日历实例时顺带给它也发起一次（calendar 是它的授权地址，发起失败为 null），前端授权完 Drive 再打开它。
func (h *handler) googleLogin(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r, true, "return_to")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var returnTo string
	if v, ok := raw["return_to"]; ok && !isNull(v) {
		if json.Unmarshal(v, &returnTo) != nil {
			fail(w, r, h.c, apiErr(errValidation, "return_to 必须是字符串"))
			return
		}
	}
	ctx := r.Context()
	g, err := h.googleConns(ctx)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if g.drive == nil {
		fail(w, r, h.c, apiErr(errConflict, "先在设置 / 连接器里配好 Google Drive 的 OAuth 客户端"))
		return
	}
	start, err := h.c.Connectors().StartOAuth(ctx, g.drive.ID, returnTo)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out := map[string]any{"connector_id": g.drive.ID, "authorize_url": start.AuthorizeURL,
		"redirect_uri": start.RedirectURI, "expires_at": start.ExpiresAt, "calendar": nil}
	if c, ok := pick(g.calendars, ""); ok {
		if cs, err := h.c.Connectors().StartOAuth(ctx, c.ID, returnTo); err == nil {
			out["calendar"] = map[string]any{"connector_id": c.ID, "authorize_url": cs.AuthorizeURL,
				"redirect_uri": cs.RedirectURI, "expires_at": cs.ExpiresAt}
		} else {
			h.c.Log().Info("calendar oauth not started", "connector", c.ID, "err", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// googleLogout 断开这个账号的 Drive 和日历实例：Drive 用的那个一定断开，其余 Drive、日历实例账号相同且没断开的一起断。
// Drive 实例没有账号时，日历实例里授权着的都断。回 {disconnected: [id], google: GoogleState}。
func (h *handler) googleLogout(w http.ResponseWriter, r *http.Request) {
	if _, err := readBody(r, true); err != nil {
		fail(w, r, h.c, err)
		return
	}
	ctx := r.Context()
	g, err := h.googleConns(ctx)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var ids []string
	if g.drive != nil {
		email := g.drive.Account
		if g.drive.Status != "disconnected" {
			ids = append(ids, g.drive.ID)
		}
		for _, c := range append(append([]plugin.ConnectorInfo{}, g.drives...), g.calendars...) {
			if c.ID == g.drive.ID || c.Status == "disconnected" {
				continue
			}
			same := email != "" && strings.EqualFold(c.Account, email)
			if same || (email == "" && c.Tool == calendarTool && authorized(c)) {
				ids = append(ids, c.ID)
			}
		}
	}
	done := []string{}
	for _, id := range ids {
		if _, err := h.c.Connectors().Disconnect(ctx, id); err != nil {
			fail(w, r, h.c, err)
			return
		}
		done = append(done, id)
	}
	st, err := h.googleState(ctx)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"disconnected": done, "google": st}})
}
