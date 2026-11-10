// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package oauthfake 是测试用的假 OAuth 2.0 服务（CONN-01b）：授权码 + PKCE（S256）+ refresh_token 轮换，
// 配合内置的 fake_oauth 连接器（config.base_url 填它的地址）。只给测试用，不进正式路由。
package oauthfake

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
)

// Server 是一个跑着的假授权服务。字段在锁内读写，测试直接改 FailRefresh 之类时用 Set 方法。
type Server struct {
	*httptest.Server
	ClientID, ClientSecret, Login string

	mu          sync.Mutex
	codes       map[string]grant // 授权码 -> 发起时的 PKCE 和回调地址，用一次就删
	access      string
	refresh     string
	seq         int
	expiresIn   int
	failRefresh bool
	noRefresh   bool
	// Refreshes 是成功刷新的次数
	Refreshes int
}

type grant struct{ challenge, redirect string }

// New 起一个假服务，签出的 access_token 有效期 expiresIn 秒（0 表示不给有效期）。
func New(expiresIn int) *Server {
	s := &Server{ClientID: "cid-test", ClientSecret: "csecret-test-0123456789", Login: "octo",
		codes: map[string]grant{}, expiresIn: expiresIn}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /authorize", s.authorize)
	mux.HandleFunc("POST /token", s.token)
	mux.HandleFunc("GET /userinfo", s.userinfo)
	s.Server = httptest.NewServer(mux)
	return s
}

// SetFailRefresh 让之后的刷新一律回 invalid_grant。
func (s *Server) SetFailRefresh(v bool) { s.mu.Lock(); s.failRefresh = v; s.mu.Unlock() }

// SetNoRefreshToken 让换令牌时不发 refresh_token。
func (s *Server) SetNoRefreshToken(v bool) { s.mu.Lock(); s.noRefresh = v; s.mu.Unlock() }

// Tokens 是当前有效的 access_token 和 refresh_token。
func (s *Server) Tokens() (access, refresh string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.access, s.refresh
}

// authorize 模拟用户点了同意：直接 302 回 redirect_uri，带上授权码和原样的 state。
func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != s.ClientID || q.Get("redirect_uri") == "" ||
		q.Get("state") == "" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		http.Error(w, "bad authorize request", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	s.seq++
	code := fmt.Sprintf("code-%d", s.seq)
	s.codes[code] = grant{challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri")}
	s.mu.Unlock()
	u, _ := url.Parse(q.Get("redirect_uri"))
	v := u.Query()
	v.Set("code", code)
	v.Set("state", q.Get("state"))
	u.RawQuery = v.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func oauthErr(w http.ResponseWriter, code, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		oauthErr(w, "invalid_request", err.Error())
		return
	}
	f := r.PostForm
	if f.Get("client_id") != s.ClientID || f.Get("client_secret") != s.ClientSecret {
		oauthErr(w, "invalid_client", "bad client credentials")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch f.Get("grant_type") {
	case "authorization_code":
		g, ok := s.codes[f.Get("code")]
		delete(s.codes, f.Get("code"))
		sum := sha256.Sum256([]byte(f.Get("code_verifier")))
		switch {
		case !ok:
			oauthErr(w, "invalid_grant", "unknown or used code")
			return
		case g.redirect != f.Get("redirect_uri"):
			oauthErr(w, "invalid_grant", "redirect_uri mismatch")
			return
		case base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge:
			oauthErr(w, "invalid_grant", "PKCE verification failed")
			return
		}
	case "refresh_token":
		if s.failRefresh || f.Get("refresh_token") == "" || f.Get("refresh_token") != s.refresh {
			oauthErr(w, "invalid_grant", "refresh token "+f.Get("refresh_token")+" is revoked")
			return
		}
		s.Refreshes++
	default:
		oauthErr(w, "unsupported_grant_type", f.Get("grant_type"))
		return
	}
	s.seq++
	s.access = fmt.Sprintf("at-%d-abcdefghijklmnop", s.seq)
	out := map[string]any{"access_token": s.access, "token_type": "bearer", "scope": "read write"}
	if !s.noRefresh {
		s.refresh = fmt.Sprintf("rt-%d-qrstuvwxyz012345", s.seq)
		out["refresh_token"] = s.refresh
	}
	if s.expiresIn > 0 {
		out["expires_in"] = s.expiresIn
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) userinfo(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	ok := s.access != "" && strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == s.access
	s.mu.Unlock()
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"login": s.Login})
}

// Authorize 模拟浏览器打开授权地址：不跟随跳转，回对方给的回调地址（含 code 和 state）。
func Authorize(authorizeURL string) (*url.URL, error) {
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Get(authorizeURL)
	if err != nil {
		return nil, err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		return nil, fmt.Errorf("authorize returned %d", resp.StatusCode)
	}
	return url.Parse(resp.Header.Get("Location"))
}
