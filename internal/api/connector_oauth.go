package api

import (
	"encoding/json"
	"errors"
	"html"
	"net/http"
	"net/url"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
)

// --- 连接器的 OAuth 授权、令牌刷新和断开（CONN-01b，0030） ---

// handleStartConnectorOAuth 发起授权，body 可空或 {return_to}；回 {authorize_url, redirect_uri, expires_at}。
func (s *Server) handleStartConnectorOAuth(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req struct {
		ReturnTo string `json:"return_to"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			s.fail(w, r, validationf("malformed JSON body: %v", err))
			return
		}
	}
	out, err := s.opt.Connectors.StartOAuth(r.Context(), r.PathValue("id"), req.ReturnTo)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// handleConnectorOAuthCallback 是对方授权后浏览器回到的地址。给过 return_to 时 302 回去并带上
// oauth=ok|error、connector、message；没给时直接显示一个结果页。state 不对一律 400，不跳转。
func (s *Server) handleConnectorOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	q := r.URL.Query()
	res, err := s.opt.Connectors.CompleteOAuth(r.Context(), q.Get("state"), q.Get("code"),
		q.Get("error"), q.Get("error_description"))
	if errors.Is(err, connector.ErrOAuthState) {
		s.log.Warn("connector oauth callback rejected", "reason", err)
		oauthPage(w, http.StatusBadRequest, "授权链接无效", "这次授权已经用过、过期或不是从工作台发起的，请回到工作台重新点一次授权。")
		return
	}
	if err != nil {
		s.log.Error("connector oauth callback", "err", err)
		oauthPage(w, http.StatusInternalServerError, "授权没有完成", "工作台处理回调时出错，请回到工作台重试。")
		return
	}
	c := res.Connector
	if res.OK {
		secrets := map[string]string{"access_token": audit.SecretSet}
		if res.Refresh {
			secrets["refresh_token"] = audit.SecretSet
		}
		s.auditConfig(r, "oauth_authorize", "connector", c.ID, "授权连接器「"+c.Name+"」",
			map[string]any{"tool": c.Tool, "secrets": secrets, "scope": c.OAuth.Scope})
	} else {
		s.log.Warn("connector oauth failed", "connector", c.ID, "tool", c.Tool, "reason", res.Message)
	}
	if res.ReturnTo != "" {
		u, perr := url.Parse(res.ReturnTo)
		if perr == nil {
			v := u.Query()
			v.Set("oauth", map[bool]string{true: "ok", false: "error"}[res.OK])
			v.Set("connector", c.ID)
			v.Set("message", res.Message)
			u.RawQuery = v.Encode()
			http.Redirect(w, r, u.String(), http.StatusFound)
			return
		}
	}
	title := "授权完成"
	if !res.OK {
		title = "授权没有完成"
	}
	oauthPage(w, http.StatusOK, title, "「"+c.Name+"」："+res.Message+"。可以关掉这个页面回到工作台。")
}

// oauthPage 是回调的结果页，不引用任何外部资源。
func oauthPage(w http.ResponseWriter, code int, title, msg string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1"><title>` + html.EscapeString(title) +
		`</title><style>body{font:15px/1.6 -apple-system,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1f2937}` +
		`h1{font-size:20px}</style></head><body><h1>` + html.EscapeString(title) + `</h1><p>` +
		strings.ReplaceAll(html.EscapeString(msg), "\n", "<br>") + `</p></body></html>`))
}

// handleRefreshConnectorOAuth 手动刷新令牌，回 {ok, message, connector}；刷新失败不是接口错误：200 + ok=false，连接器置为 error。
func (s *Server) handleRefreshConnectorOAuth(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	res, err := s.opt.Connectors.RefreshOAuth(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, res)
}

// handleDisconnectConnector 人主动断开：状态置为 disconnected；OAuth 的令牌一起删掉。
func (s *Server) handleDisconnectConnector(w http.ResponseWriter, r *http.Request) {
	if !s.connectorsConfigured(w) {
		return
	}
	c, cleared, err := s.opt.Connectors.Disconnect(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	detail := map[string]any{"tool": c.Tool}
	if cleared {
		detail["secrets"] = map[string]string{"access_token": audit.SecretCleared, "refresh_token": audit.SecretCleared}
	}
	s.auditConfig(r, "disconnect", "connector", c.ID, "断开连接器「"+c.Name+"」", detail)
	respondData(w, http.StatusOK, c)
}
