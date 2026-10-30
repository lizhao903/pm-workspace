package connector

// OAuth 2.0 授权码流程（CONN-01b）：state 防伪（一次性、10 分钟有效）、PKCE（S256）、回调换令牌、
// 令牌合进连接器原有的保险箱条目、到期前后台刷新、刷新失败把连接器置为 error。
// state 和 PKCE 校验码只放进程内存：进程重启后进行中的授权作废，重新点一次授权即可。

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

const (
	// CallbackPath 是 OAuth 回调的路径，接在 --public-url 后面就是要在对方 OAuth 应用里登记的回调地址
	CallbackPath = "/api/connectors/oauth/callback"
	// DefaultPublicURL 是浏览器访问工作台的地址（docs/local-domain.md）
	DefaultPublicURL = "https://bro.vip"
	// StateTTL 是一次授权从发起到回调的有效期
	StateTTL = 10 * time.Minute
	// RefreshAhead 是提前多久刷新：到期前这么久以内就刷
	RefreshAhead = 5 * time.Minute
	// RefreshEvery 是后台检查到期的间隔
	RefreshEvery = time.Minute
	// RefreshBackoff 是刷新失败后多久再自动试一次（网络抖动不该让连接器永远停在异常）
	RefreshBackoff = 30 * time.Minute

	maxPending   = 200
	maxReturnTo  = 500
	maxTokenBody = 1 << 20

	// 令牌在保险箱条目里的键：字段 key 必须小写字母开头，_ 开头的不会和字段撞
	keyAccessToken  = "_access_token"
	keyRefreshToken = "_refresh_token"
	keyTokenType    = "_token_type"
)

func isTokenKey(k string) bool { return strings.HasPrefix(k, "_") }

// OAuthSpec 是定义里声明的 OAuth 配置。client_id 内置（ClientID）或从配置字段取（ClientIDField）；
// client_secret 要的话是一个 secret 字段，跟别的凭证一起进保险箱。
type OAuthSpec struct {
	AuthURL  string   `json:"auth_url"`
	TokenURL string   `json:"token_url"`
	Scopes   []string `json:"scopes"`
	// BaseURLField 非空时 AuthURL、TokenURL 是以 / 开头的路径，接在这个配置字段的值后面（自建实例用）
	BaseURLField string `json:"base_url_field,omitempty"`
	// AuthURLField、TokenURLField、ScopesField 非空时授权地址、令牌地址、范围由用户填在这几个配置字段里
	// （自定义 MCP、OpenAPI，CONN-04）；范围用空格或逗号隔开
	AuthURLField      string `json:"auth_url_field,omitempty"`
	TokenURLField     string `json:"token_url_field,omitempty"`
	ScopesField       string `json:"scopes_field,omitempty"`
	ClientIDField     string `json:"client_id_field,omitempty"`
	ClientSecretField string `json:"client_secret_field,omitempty"`
	// Builtin 是内置了 client_id，用户只需要点授权；登记时按 ClientID 算出来
	Builtin bool `json:"builtin"`
	// ClientID 是内置的 client_id，不出接口
	ClientID string `json:"-"`
	// AuthParams 是授权地址上额外带的参数（如 Google 的 access_type=offline、prompt=consent），
	// 不能覆盖流程自己的参数（client_id、redirect_uri、scope、state、PKCE 等）
	AuthParams map[string]string `json:"auth_params,omitempty"`
}

// reservedAuthParams 是授权地址上由流程自己填的参数，AuthParams 不能带
var reservedAuthParams = []string{"response_type", "client_id", "redirect_uri", "scope", "state",
	"code_challenge", "code_challenge_method"}

func (o *OAuthSpec) check(d *Def) error {
	for _, k := range []string{o.AuthURLField, o.TokenURLField, o.ScopesField} {
		if f := d.field(k); k != "" && (f == nil || f.Kind != "text") {
			return fmt.Errorf("oauth field %q must be a text field", k)
		}
	}
	if (o.AuthURLField == "") != (o.TokenURLField == "") || o.AuthURLField != "" && o.BaseURLField != "" {
		return errors.New("oauth auth_url_field and token_url_field go together, without base_url_field")
	}
	switch {
	case o.AuthURLField != "":
		// 地址由用户填，登记时没得查
	case o.AuthURL == "" || o.TokenURL == "":
		return errors.New("oauth auth_url and token_url are required")
	case o.BaseURLField != "":
		if f := d.field(o.BaseURLField); f == nil || f.Kind != "text" {
			return fmt.Errorf("oauth base_url_field %q must be a text field", o.BaseURLField)
		}
		if !strings.HasPrefix(o.AuthURL, "/") || !strings.HasPrefix(o.TokenURL, "/") {
			return errors.New("oauth urls must be paths starting with / when base_url_field is set")
		}
	case !isHTTPURL(o.AuthURL) || !isHTTPURL(o.TokenURL):
		return errors.New("oauth auth_url and token_url must be http(s) URLs")
	}
	if o.ClientID == "" {
		if f := d.field(o.ClientIDField); f == nil || f.Kind != "text" {
			return fmt.Errorf("oauth needs a built-in client_id or a text field for it (client_id_field %q)", o.ClientIDField)
		}
	}
	if o.ClientSecretField != "" {
		if f := d.field(o.ClientSecretField); f == nil || f.Kind != "secret" {
			return fmt.Errorf("oauth client_secret_field %q must be a secret field", o.ClientSecretField)
		}
	}
	for k := range o.AuthParams {
		if k == "" || slices.Contains(reservedAuthParams, k) {
			return fmt.Errorf("oauth auth_params cannot set %q", k)
		}
	}
	return nil
}

func isHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// OAuthStatus 是实例的授权状态，不含令牌。
type OAuthStatus struct {
	AuthorizedAt    *time.Time `json:"authorized_at"`
	ExpiresAt       *time.Time `json:"expires_at"`
	RefreshedAt     *time.Time `json:"refreshed_at"`
	RefreshFailedAt *time.Time `json:"refresh_failed_at"`
	Scope           string     `json:"scope"`
}

// OAuthStart 是发起授权的结果：浏览器打开 AuthorizeURL。
type OAuthStart struct {
	AuthorizeURL string    `json:"authorize_url"`
	RedirectURI  string    `json:"redirect_uri"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// OAuthResult 是回调或刷新的结论。对方拒绝、换令牌失败不是接口错误，ok 为 false。
type OAuthResult struct {
	OK        bool       `json:"ok"`
	Message   string     `json:"message"`
	Connector *Connector `json:"connector"`
	// ReturnTo 是发起时给的回跳地址，回调用；Refresh 为 true 时这次拿到了 refresh_token
	ReturnTo string `json:"-"`
	Refresh  bool   `json:"-"`
}

// ErrOAuthState：回调的 state 不认识、已经用过或过期了。
var ErrOAuthState = errors.New("oauth state is invalid")

type pending struct {
	connID, verifier, redirectURI, returnTo, scope string
	exp                                            time.Time
}

type oauthRuntime struct {
	mu        sync.Mutex
	pending   map[string]pending
	publicURL string
	client    *http.Client
	// refreshMu 让刷新一个一个来：对方轮换 refresh_token 时，并发的两次刷新后一次会拿旧令牌失败
	refreshMu sync.Mutex
	stop      context.CancelFunc
	done      chan struct{}
}

func newOAuthRuntime() oauthRuntime {
	return oauthRuntime{pending: map[string]pending{}, publicURL: DefaultPublicURL,
		client: &http.Client{Timeout: callTimeout}}
}

// SetPublicURL 改浏览器访问工作台的地址（回调地址 = 它 + CallbackPath）；空串恢复默认。
func (s *Store) SetPublicURL(raw string) error {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		raw = DefaultPublicURL
	}
	if u, err := url.Parse(raw); err != nil || !isHTTPURL(raw) || u.Path != "" || u.RawQuery != "" {
		return fmt.Errorf("public url %q must be like https://bro.vip (scheme and host only)", raw)
	}
	s.oauth.mu.Lock()
	s.oauth.publicURL = raw
	s.oauth.mu.Unlock()
	return nil
}

// SetHTTPClient 换对外请求令牌用的 client，测试用。
func (s *Store) SetHTTPClient(c *http.Client) { s.oauth.client = c }

// CallbackURL 是要在对方 OAuth 应用里登记的回调地址。
func (s *Store) CallbackURL() string {
	s.oauth.mu.Lock()
	defer s.oauth.mu.Unlock()
	return s.oauth.publicURL + CallbackPath
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand 失败时没有安全的退路
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// checkReturnTo 只放行站内路径和本机地址，免得回调变成开放跳转。
func (s *Store) checkReturnTo(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > maxReturnTo || strings.ContainsAny(raw, "\\\r\n") {
		return "", invalid("return_to is too long or has invalid characters")
	}
	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil || !isHTTPURL(raw) {
		return "", invalid("return_to must be a path starting with / or a local http(s) URL")
	}
	pub, _ := url.Parse(s.CallbackURL())
	host := u.Hostname()
	if ip := net.ParseIP(host); (ip != nil && ip.IsLoopback()) || host == "localhost" || strings.EqualFold(u.Host, pub.Host) {
		return raw, nil
	}
	return "", invalid("return_to must point to this workspace or a loopback address")
}

// endpoints 是这个实例的授权地址和令牌地址。
func endpoints(o *OAuthSpec, cfg Config) (authURL, tokenURL string, err error) {
	if o.AuthURLField != "" {
		authURL, tokenURL = cfg.Get(o.AuthURLField), cfg.Get(o.TokenURLField)
		if !isHTTPURL(authURL) || !isHTTPURL(tokenURL) {
			return "", "", invalid("config.%s and config.%s must be http(s) URLs before authorizing", o.AuthURLField, o.TokenURLField)
		}
		return authURL, tokenURL, nil
	}
	if o.BaseURLField == "" {
		return o.AuthURL, o.TokenURL, nil
	}
	base := strings.TrimRight(cfg.Get(o.BaseURLField), "/")
	if !isHTTPURL(base) {
		return "", "", invalid("config.%s must be an http(s) URL before authorizing", o.BaseURLField)
	}
	return base + o.AuthURL, base + o.TokenURL, nil
}

// scopesOf 是要请求的范围：定义写死的，或 ScopesField 里用户填的（空格或逗号隔开）。
func scopesOf(o *OAuthSpec, cfg Config) []string {
	if o.ScopesField == "" {
		return o.Scopes
	}
	return strings.FieldsFunc(cfg.Get(o.ScopesField), func(r rune) bool { return r == ' ' || r == ',' || r == '，' })
}

func clientCreds(o *OAuthSpec, cfg Config) (id, secret string, err error) {
	id = o.ClientID
	if id == "" {
		id = cfg.Get(o.ClientIDField)
	}
	if id == "" {
		return "", "", invalid("config.%s (client_id) is required before authorizing", o.ClientIDField)
	}
	if o.ClientSecretField != "" {
		secret = cfg.Secret(o.ClientSecretField)
	}
	return id, secret, nil
}

// oauthConfig 是做 OAuth 要的定义和配置；实例不是 oauth2 认证回 400。
func (s *Store) oauthConfig(ctx context.Context, cur *Connector) (*OAuthSpec, Config, error) {
	if cur.AuthMode != AuthOAuth2 {
		return nil, Config{}, invalid("connector %s uses auth_mode %s, not oauth2", cur.ID, cur.AuthMode)
	}
	d, cfg, err := s.callConfig(ctx, cur)
	if err != nil {
		return nil, Config{}, err
	}
	if d.OAuth == nil {
		return nil, Config{}, conflict("connector definition %s has no OAuth spec", d.Tool)
	}
	return d.OAuth, cfg, nil
}

// StartOAuth 发起一次授权：生成一次性 state 和 PKCE 校验码，回对方的授权地址。
// returnTo 是授权结束后浏览器回到哪（站内路径或本机地址），空串时回调页自己显示结果。
func (s *Store) StartOAuth(ctx context.Context, id, returnTo string) (*OAuthStart, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	o, cfg, err := s.oauthConfig(ctx, cur)
	if err != nil {
		return nil, err
	}
	authURL, _, err := endpoints(o, cfg)
	if err != nil {
		return nil, err
	}
	clientID, _, err := clientCreds(o, cfg)
	if err != nil {
		return nil, err
	}
	if returnTo, err = s.checkReturnTo(returnTo); err != nil {
		return nil, err
	}
	u, err := url.Parse(authURL)
	if err != nil {
		return nil, conflict("oauth auth_url is not a valid URL")
	}
	state, verifier := randomToken(32), randomToken(48)
	redirect := s.CallbackURL()
	scope := strings.Join(scopesOf(o, cfg), " ")
	q := u.Query()
	for k, v := range o.AuthParams {
		q.Set(k, v)
	}
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirect)
	if scope != "" {
		q.Set("scope", scope)
	}
	q.Set("state", state)
	q.Set("code_challenge", pkceChallenge(verifier))
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()

	now := s.now()
	exp := now.Add(StateTTL)
	s.oauth.mu.Lock()
	defer s.oauth.mu.Unlock()
	for k, p := range s.oauth.pending {
		if !now.Before(p.exp) {
			delete(s.oauth.pending, k)
		}
	}
	if len(s.oauth.pending) >= maxPending {
		return nil, conflict("too many authorizations in progress; try again in a few minutes")
	}
	s.oauth.pending[state] = pending{connID: id, verifier: verifier, redirectURI: redirect, returnTo: returnTo,
		scope: scope, exp: exp}
	return &OAuthStart{AuthorizeURL: u.String(), RedirectURI: redirect, ExpiresAt: exp.UTC().Truncate(time.Millisecond)}, nil
}

// takeState 取出并作废一个 state：不认识、用过、过期都回 ErrOAuthState。
func (s *Store) takeState(state string) (pending, error) {
	s.oauth.mu.Lock()
	defer s.oauth.mu.Unlock()
	p, ok := s.oauth.pending[state]
	if state == "" || !ok {
		return pending{}, fmt.Errorf("%w: unknown or already used", ErrOAuthState)
	}
	delete(s.oauth.pending, state)
	if !s.now().Before(p.exp) {
		return pending{}, fmt.Errorf("%w: expired", ErrOAuthState)
	}
	return p, nil
}

type tokenResp struct {
	access, refresh, tokenType, scope string
	expiresIn                         int64
}

// requestToken 向令牌地址发一次表单请求（client_secret 放在表单里，同 GitHub、Google 的做法）。
func (s *Store) requestToken(ctx context.Context, tokenURL string, form url.Values) (*tokenResp, error) {
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.oauth.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxTokenBody))
	if err != nil {
		return nil, err
	}
	vals := map[string]string{}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if ct == "application/json" || strings.HasPrefix(strings.TrimSpace(string(body)), "{") {
		raw := map[string]any{}
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, fmt.Errorf("token endpoint returned %d with invalid JSON", resp.StatusCode)
		}
		for k, v := range raw {
			switch x := v.(type) {
			case string:
				vals[k] = x
			case float64:
				vals[k] = strconv.FormatInt(int64(x), 10)
			}
		}
	} else if q, err := url.ParseQuery(string(body)); err == nil {
		for k := range q {
			vals[k] = q.Get(k)
		}
	}
	if e := vals["error"]; e != "" {
		if d := vals["error_description"]; d != "" {
			e += ": " + d
		}
		return nil, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, e)
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("token endpoint returned %d", resp.StatusCode)
	}
	if vals["access_token"] == "" {
		return nil, errors.New("token endpoint returned no access_token")
	}
	t := &tokenResp{access: vals["access_token"], refresh: vals["refresh_token"], tokenType: vals["token_type"], scope: vals["scope"]}
	if n, err := strconv.ParseInt(vals["expires_in"], 10, 64); err == nil && n > 0 {
		t.expiresIn = n
	}
	return t, nil
}

func addSecrets(secrets map[string]string, more ...string) map[string]string {
	out := map[string]string{}
	for k, v := range secrets {
		out[k] = v
	}
	for i := 0; i+1 < len(more); i += 2 {
		if more[i+1] != "" {
			out[more[i]] = more[i+1]
		}
	}
	return out
}

// CompleteOAuth 处理回调：校验并作废 state，拿授权码加 PKCE 校验码换令牌，令牌存进保险箱，再做一次连通测试记下账号。
// state 不对回 ErrOAuthState；对方拒绝或换令牌失败回 ok=false，连接器状态不变。
func (s *Store) CompleteOAuth(ctx context.Context, state, code, oauthErr, oauthErrDesc string) (*OAuthResult, error) {
	p, err := s.takeState(state)
	if err != nil {
		return nil, err
	}
	res := &OAuthResult{ReturnTo: p.returnTo}
	cur, err := s.Get(ctx, p.connID)
	if err != nil {
		return nil, err
	}
	res.Connector = cur
	fail := func(msg string) (*OAuthResult, error) {
		res.Message = msg
		return res, nil
	}
	if oauthErr != "" {
		if oauthErrDesc != "" {
			oauthErr += ": " + oauthErrDesc
		}
		return fail(scrub("对方没有授权："+oauthErr, nil))
	}
	if code == "" {
		return fail("回调里没有授权码")
	}
	o, cfg, err := s.oauthConfig(ctx, cur)
	if err != nil {
		return nil, err
	}
	_, tokenURL, err := endpoints(o, cfg)
	if err != nil {
		return nil, err
	}
	clientID, clientSecret, err := clientCreds(o, cfg)
	if err != nil {
		return nil, err
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {p.redirectURI},
		"client_id": {clientID}, "code_verifier": {p.verifier}}
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	tok, err := s.requestToken(ctx, tokenURL, form)
	if err != nil {
		return fail(scrub("换取令牌失败："+err.Error(), addSecrets(cfg.secrets, "code", code)))
	}
	scope := tok.scope
	if scope == "" {
		scope = p.scope
	}

	s.mu.Lock()
	cur, err = s.get(ctx, s.db.W, p.connID)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	old, err := s.resolveSecrets(ctx, cur)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	secrets := addSecrets(old, keyAccessToken, tok.access, keyTokenType, tok.tokenType)
	delete(secrets, keyRefreshToken)
	if tok.refresh != "" {
		secrets[keyRefreshToken] = tok.refresh
	}
	secretID, created, err := s.saveSecrets(ctx, cur.ID, cur.SecretID, secrets)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	now := s.stamp()
	if _, err := s.db.W.ExecContext(ctx, `UPDATE connectors SET secret_id = ?, oauth_authorized_at = ?,
		oauth_expires_at = ?, oauth_refreshed_at = NULL, oauth_refresh_failed_at = NULL, oauth_scope = ?, updated_at = ?
		WHERE id = ?`, secretID, now, s.expiresAt(tok.expiresIn), scope, now, cur.ID); err != nil {
		if created {
			_ = s.sec.Delete(context.WithoutCancel(ctx), secretID)
		}
		s.mu.Unlock()
		return nil, fmt.Errorf("record connector oauth: %w", err)
	}
	s.mu.Unlock()

	// 拿到令牌后测一次，成功置 connected 并记下账号，失败置 error（同 POST /test）
	tr, err := s.Test(ctx, cur.ID)
	if err != nil {
		return nil, err
	}
	res.OK, res.Connector, res.Refresh = true, tr.Connector, tok.refresh != ""
	res.Message = "授权完成"
	if !tr.OK {
		res.Message = "授权完成，但连通测试失败：" + tr.Message
	}
	return res, nil
}

// expiresAt 是 expires_in 秒之后的时间；0 表示对方没给有效期，回 nil（存 NULL）。
func (s *Store) expiresAt(sec int64) any {
	if sec <= 0 {
		return nil
	}
	return s.now().Add(time.Duration(sec) * time.Second).UTC().Truncate(time.Millisecond).Format(timeLayout)
}

// RefreshOAuth 用 refresh_token 换新的 access_token。失败把连接器置为 error、记下原因和失败时间，回 ok=false；
// 对方没给 refresh_token 也算失败。暂停、断开的实例照样能手动刷，状态保持不变。
func (s *Store) RefreshOAuth(ctx context.Context, id string) (*OAuthResult, error) {
	s.oauth.refreshMu.Lock()
	defer s.oauth.refreshMu.Unlock()
	cur, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	o, cfg, err := s.oauthConfig(ctx, cur)
	if err != nil {
		return nil, err
	}
	var tok *tokenResp
	refresh := cfg.secrets[keyRefreshToken]
	_, tokenURL, rerr := endpoints(o, cfg)
	clientID, clientSecret, cerr := clientCreds(o, cfg)
	switch {
	case refresh == "":
		rerr = errors.New("没有 refresh_token，需要重新授权")
	case rerr != nil:
	case cerr != nil:
		rerr = cerr
	default:
		form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}}
		if clientSecret != "" {
			form.Set("client_secret", clientSecret)
		}
		tok, rerr = s.requestToken(ctx, tokenURL, form)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.stamp()
	res := &OAuthResult{OK: rerr == nil}
	if rerr != nil {
		res.Message = scrub("令牌刷新失败："+strings.TrimPrefix(rerr.Error(), domain.ErrValidation.Error()+": "), cfg.secrets)
		if _, err := s.db.W.ExecContext(ctx, `UPDATE connectors SET error = ?, oauth_refresh_failed_at = ?, updated_at = ?,
			status = CASE WHEN status IN ('paused', 'disconnected') THEN status ELSE ? END WHERE id = ?`,
			res.Message, now, now, StatusError, id); err != nil {
			return nil, fmt.Errorf("record connector refresh: %w", err)
		}
		s.log.Warn("connector token refresh failed", "connector", id, "tool", cur.Tool, "reason", res.Message)
		s.noteIncident(ctx, cur, "auth", res.Message)
	} else {
		cur, err = s.get(ctx, s.db.W, id)
		if err != nil {
			return nil, err
		}
		old, err := s.resolveSecrets(ctx, cur)
		if err != nil {
			return nil, err
		}
		// 对方没轮换 refresh_token 时沿用旧的
		secrets := addSecrets(old, keyAccessToken, tok.access, keyRefreshToken, tok.refresh, keyTokenType, tok.tokenType)
		secretID, created, err := s.saveSecrets(ctx, id, cur.SecretID, secrets)
		if err != nil {
			return nil, err
		}
		q := `UPDATE connectors SET secret_id = ?, oauth_expires_at = ?, oauth_refreshed_at = ?, oauth_refresh_failed_at = NULL,
			updated_at = ?, error = CASE WHEN status = 'error' THEN '' ELSE error END,
			status = CASE WHEN status = 'error' THEN 'connected' ELSE status END`
		args := []any{secretID, s.expiresAt(tok.expiresIn), now, now}
		if tok.scope != "" {
			q += `, oauth_scope = ?`
			args = append(args, tok.scope)
		}
		if _, err := s.db.W.ExecContext(ctx, q+` WHERE id = ?`, append(args, id)...); err != nil {
			if created {
				_ = s.sec.Delete(context.WithoutCancel(ctx), secretID)
			}
			return nil, fmt.Errorf("record connector refresh: %w", err)
		}
		res.Message = "令牌已刷新"
	}
	if res.Connector, err = s.get(ctx, s.db.W, id); err != nil {
		return nil, err
	}
	return res, nil
}

// Disconnect 人主动断开：状态置为 disconnected，配置保留；OAuth 的令牌从保险箱里删掉、授权状态清空，
// 重新连接要再授权一次。Token 认证的凭证保留，重新启用（PATCH enabled: true）后测一次即可。
// 返回断开后的实例和是否清掉了令牌（审计要用）。
func (s *Store) Disconnect(ctx context.Context, id string) (*Connector, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.get(ctx, s.db.W, id)
	if err != nil {
		return nil, false, err
	}
	old, err := s.resolveSecrets(ctx, cur)
	if err != nil {
		return nil, false, err
	}
	secrets, cleared := map[string]string{}, false
	for k, v := range old {
		if isTokenKey(k) {
			cleared = true
		} else {
			secrets[k] = v
		}
	}
	secretID := cur.SecretID
	if cleared {
		if secretID, _, err = s.saveSecrets(ctx, id, cur.SecretID, secrets); err != nil {
			return nil, false, err
		}
	}
	if _, err := s.db.W.ExecContext(ctx, `UPDATE connectors SET status = ?, error = '', secret_id = ?,
		oauth_authorized_at = NULL, oauth_expires_at = NULL, oauth_refreshed_at = NULL, oauth_refresh_failed_at = NULL,
		oauth_scope = '', updated_at = ? WHERE id = ?`, StatusDisconnected, secretID, s.stamp(), id); err != nil {
		return nil, false, fmt.Errorf("disconnect connector: %w", err)
	}
	c, err := s.get(ctx, s.db.W, id)
	return c, cleared, err
}

// dueForRefresh 是快到期、该刷新的实例：oauth2、有到期时间、到期前 RefreshAhead 以内，
// 不在暂停或断开，最近一次失败已过了退避时间。
func (s *Store) dueForRefresh(ctx context.Context) ([]string, error) {
	now := s.now().UTC()
	rows, err := s.db.R.QueryContext(ctx, `SELECT id FROM connectors WHERE auth_mode = 'oauth2'
		AND oauth_authorized_at IS NOT NULL AND oauth_expires_at IS NOT NULL AND oauth_expires_at <= ?
		AND status NOT IN ('paused', 'disconnected')
		AND (oauth_refresh_failed_at IS NULL OR oauth_refresh_failed_at <= ?)
		ORDER BY oauth_expires_at`,
		now.Add(RefreshAhead).Format(timeLayout), now.Add(-RefreshBackoff).Format(timeLayout))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// RefreshDue 刷新所有快到期的实例，回刷了几个、失败几个。后台任务每 RefreshEvery 调一次，测试也直接调。
func (s *Store) RefreshDue(ctx context.Context) (refreshed, failed int, err error) {
	ids, err := s.dueForRefresh(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("list connectors due for refresh: %w", err)
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		res, err := s.RefreshOAuth(ctx, id)
		switch {
		case errors.Is(err, domain.ErrNotFound):
		case err != nil:
			// 定义不在了之类：记日志，不置异常（不是令牌的问题）
			s.log.Warn("connector token refresh skipped", "connector", id, "err", err)
		case res.OK:
			refreshed++
		default:
			failed++
		}
	}
	return refreshed, failed, ctx.Err()
}

// StartRefresher 起后台刷新：启动时先查一次，之后每 RefreshEvery 查一次。StopRefresher 停掉并等它退出。
func (s *Store) StartRefresher(ctx context.Context) {
	s.oauth.mu.Lock()
	defer s.oauth.mu.Unlock()
	if s.oauth.stop != nil {
		return
	}
	ctx, s.oauth.stop = context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})
	s.oauth.done = done
	go func() {
		defer close(done)
		t := time.NewTicker(RefreshEvery)
		defer t.Stop()
		for {
			if _, _, err := s.RefreshDue(ctx); err != nil && ctx.Err() == nil {
				s.log.Error("connector token refresh", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// StopRefresher 停掉后台刷新，没起过时什么都不做。
func (s *Store) StopRefresher() {
	s.oauth.mu.Lock()
	stop, done := s.oauth.stop, s.oauth.done
	s.oauth.stop, s.oauth.done = nil, nil
	s.oauth.mu.Unlock()
	if stop != nil {
		stop()
		<-done
	}
}
