package connector

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector/oauthfake"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

// newOAuthStore 用真库、真保险箱，登记 fake_oauth，时钟可拨。
func newOAuthStore(t *testing.T) (*Store, *vault.Vault, *clock) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := NewRegistry()
	if err := defs.Register(FakeOAuth()); err != nil {
		t.Fatal(err)
	}
	s := New(st.DB(), v, defs)
	s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	c := &clock{t: time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)}
	s.now = c.now
	return s, v, c
}

func newOAuthConnector(t *testing.T, s *Store, fs *oauthfake.Server) *Connector {
	t.Helper()
	c, err := s.Create(context.Background(), Input{Tool: FakeOAuthTool,
		Config:  map[string]string{"base_url": fs.URL, "client_id": fs.ClientID},
		Secrets: map[string]string{"client_secret": fs.ClientSecret}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// authorize 发起一次授权并模拟浏览器走到回调，回 state 和 code。
func authorize(t *testing.T, s *Store, id string) (state, code string) {
	t.Helper()
	st, err := s.StartOAuth(context.Background(), id, "")
	if err != nil {
		t.Fatal(err)
	}
	loc, err := oauthfake.Authorize(st.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != s.CallbackURL() {
		t.Fatalf("回调地址 %s，期望 %s", got, s.CallbackURL())
	}
	return loc.Query().Get("state"), loc.Query().Get("code")
}

func mustSecrets(t *testing.T, s *Store, id string) map[string]string {
	t.Helper()
	c, err := s.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.resolveSecrets(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestOAuthAuthorizeRefreshAndFail(t *testing.T) {
	ctx := context.Background()
	s, _, clk := newOAuthStore(t)
	fs := oauthfake.New(3600)
	defer fs.Close()
	c := newOAuthConnector(t, s, fs)
	if c.Status != StatusConnecting || c.OAuth == nil || c.OAuth.AuthorizedAt != nil {
		t.Fatalf("新建后应为 connecting、未授权：%+v %+v", c.Status, c.OAuth)
	}
	if s.CallbackURL() != "https://bro.vip"+CallbackPath {
		t.Fatalf("默认回调地址 = %s", s.CallbackURL())
	}

	// 授权地址带上 PKCE S256、scope、state
	st, err := s.StartOAuth(ctx, c.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"code_challenge_method=S256", "code_challenge=", "scope=read+write", "state=", "client_id=cid-test"} {
		if !strings.Contains(st.AuthorizeURL, want) {
			t.Errorf("授权地址缺 %s：%s", want, st.AuthorizeURL)
		}
	}

	// state 不匹配：拒绝，连接器不变
	if _, err := s.CompleteOAuth(ctx, "forged-state", "code-1", "", ""); !errors.Is(err, ErrOAuthState) {
		t.Fatalf("伪造的 state 应拒绝，得到 %v", err)
	}
	if _, err := s.CompleteOAuth(ctx, "", "code-1", "", ""); !errors.Is(err, ErrOAuthState) {
		t.Fatalf("空 state 应拒绝，得到 %v", err)
	}

	// 走完授权、回调
	state, code := authorize(t, s, c.ID)
	res, err := s.CompleteOAuth(ctx, state, code, "", "")
	if err != nil || !res.OK || !res.Refresh {
		t.Fatalf("回调 = %+v %v", res, err)
	}
	got := res.Connector
	if got.Status != StatusConnected || got.Account != "octo" || got.OAuth.AuthorizedAt == nil || got.OAuth.Scope != "read write" {
		t.Fatalf("授权后 = %s %s %+v", got.Status, got.Account, got.OAuth)
	}
	if want := clk.now().Add(time.Hour); !got.OAuth.ExpiresAt.Equal(want) {
		t.Fatalf("到期时间 = %v，期望 %v", got.OAuth.ExpiresAt, want)
	}
	access, refresh := fs.Tokens()
	sec := mustSecrets(t, s, c.ID)
	if sec[keyAccessToken] != access || sec[keyRefreshToken] != refresh || sec["client_secret"] != fs.ClientSecret {
		t.Fatalf("令牌应和 client_secret 存在同一条保险箱条目里：%v", sec)
	}
	if len(got.SecretHints) != 1 || got.SecretHints["client_secret"] == "" {
		t.Fatalf("secret_hints 只该有 client_secret：%v", got.SecretHints)
	}

	// 重放：同一个 state 第二次用拒绝
	if _, err := s.CompleteOAuth(ctx, state, code, "", ""); !errors.Is(err, ErrOAuthState) {
		t.Fatalf("重放应拒绝，得到 %v", err)
	}
	// 过期：发起 10 分钟后才回调，拒绝
	state2, code2 := authorize(t, s, c.ID)
	clk.add(StateTTL)
	if _, err := s.CompleteOAuth(ctx, state2, code2, "", ""); !errors.Is(err, ErrOAuthState) || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("过期应拒绝，得到 %v", err)
	}
	// 对方拒绝授权：ok=false，状态不变
	state3, _ := authorize(t, s, c.ID)
	res, err = s.CompleteOAuth(ctx, state3, "", "access_denied", "user said no")
	if err != nil || res.OK || !strings.Contains(res.Message, "access_denied") || res.Connector.Status != StatusConnected {
		t.Fatalf("拒绝授权 = %+v %v", res, err)
	}

	// 离到期还远：不刷新
	if n, f, err := s.RefreshDue(ctx); n != 0 || f != 0 || err != nil {
		t.Fatalf("未到期不该刷新：%d %d %v", n, f, err)
	}
	// 到期前 4 分钟：后台刷新，令牌轮换
	clk.add(time.Hour - StateTTL - 4*time.Minute)
	if n, f, err := s.RefreshDue(ctx); n != 1 || f != 0 || err != nil {
		t.Fatalf("快到期应刷新：%d %d %v", n, f, err)
	}
	access2, refresh2 := fs.Tokens()
	if access2 == access || refresh2 == refresh {
		t.Fatal("假服务应已轮换令牌")
	}
	sec = mustSecrets(t, s, c.ID)
	if sec[keyAccessToken] != access2 || sec[keyRefreshToken] != refresh2 {
		t.Fatalf("刷新后保险箱里应是新令牌：%v", sec)
	}
	got, _ = s.Get(ctx, c.ID)
	if got.OAuth.RefreshedAt == nil || !got.OAuth.ExpiresAt.Equal(clk.now().Add(time.Hour)) {
		t.Fatalf("刷新后 = %+v", got.OAuth)
	}

	// 刷新失败：状态变 error，原因里没有令牌原文
	fs.SetFailRefresh(true)
	clk.add(57 * time.Minute)
	if n, f, err := s.RefreshDue(ctx); n != 0 || f != 1 || err != nil {
		t.Fatalf("刷新应失败一次：%d %d %v", n, f, err)
	}
	got, _ = s.Get(ctx, c.ID)
	if got.Status != StatusError || !strings.Contains(got.Error, "令牌刷新失败") || !strings.Contains(got.Error, "invalid_grant") ||
		got.OAuth.RefreshFailedAt == nil {
		t.Fatalf("刷新失败后 = %s %q %+v", got.Status, got.Error, got.OAuth)
	}
	if strings.Contains(got.Error, refresh2) {
		t.Fatalf("错误说明里不该有 refresh_token 原文：%q", got.Error)
	}
	// 退避：刚失败过不再自动试；过了退避时间再试
	if n, f, _ := s.RefreshDue(ctx); n+f != 0 {
		t.Fatal("退避期内不该再试")
	}
	clk.add(RefreshBackoff)
	if _, f, _ := s.RefreshDue(ctx); f != 1 {
		t.Fatal("过了退避时间应再试一次")
	}
	// 对方恢复后手动刷新：回到 connected，清掉错误
	fs.SetFailRefresh(false)
	res, err = s.RefreshOAuth(ctx, c.ID)
	if err != nil || !res.OK || res.Connector.Status != StatusConnected || res.Connector.Error != "" || res.Connector.OAuth.RefreshFailedAt != nil {
		t.Fatalf("手动刷新 = %+v %v", res, err)
	}

	// 断开：令牌删掉、client_secret 保留，授权状态清空，后台不再刷
	d, cleared, err := s.Disconnect(ctx, c.ID)
	if err != nil || !cleared || d.Status != StatusDisconnected || d.OAuth.AuthorizedAt != nil || d.OAuth.ExpiresAt != nil {
		t.Fatalf("断开 = %+v %v %v", d, cleared, err)
	}
	sec = mustSecrets(t, s, c.ID)
	if sec[keyAccessToken] != "" || sec[keyRefreshToken] != "" || sec["client_secret"] != fs.ClientSecret {
		t.Fatalf("断开后保险箱 = %v", sec)
	}
	clk.add(2 * time.Hour)
	if n, f, _ := s.RefreshDue(ctx); n+f != 0 {
		t.Fatal("断开的不该刷新")
	}
	if tr, _ := s.Test(ctx, c.ID); tr.OK || !strings.Contains(tr.Message, "OAuth") {
		t.Fatalf("没授权的 OAuth 连接器测试应失败：%+v", tr)
	}
}

func TestOAuthRefreshWithoutRefreshToken(t *testing.T) {
	ctx := context.Background()
	s, _, clk := newOAuthStore(t)
	fs := oauthfake.New(600)
	defer fs.Close()
	fs.SetNoRefreshToken(true)
	c := newOAuthConnector(t, s, fs)
	state, code := authorize(t, s, c.ID)
	if res, err := s.CompleteOAuth(ctx, state, code, "", ""); err != nil || !res.OK || res.Refresh {
		t.Fatalf("回调 = %+v %v", res, err)
	}
	clk.add(8 * time.Minute)
	if _, f, _ := s.RefreshDue(ctx); f != 1 {
		t.Fatal("没有 refresh_token 时到期应算刷新失败")
	}
	got, _ := s.Get(ctx, c.ID)
	if got.Status != StatusError || !strings.Contains(got.Error, "重新授权") {
		t.Fatalf("= %s %q", got.Status, got.Error)
	}
	// 暂停中的照样手动刷，但状态保持 paused
	off := false
	if _, err := s.Update(ctx, c.ID, Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if res, _ := s.RefreshOAuth(ctx, c.ID); res.OK || res.Connector.Status != StatusPaused {
		t.Fatalf("暂停时刷新 = %+v", res)
	}
}

func TestOAuthTokenExchangeFails(t *testing.T) {
	ctx := context.Background()
	s, _, _ := newOAuthStore(t)
	fs := oauthfake.New(3600)
	defer fs.Close()
	c := newOAuthConnector(t, s, fs)
	// client_secret 不对：换令牌失败，ok=false，状态不变，说明里没有 secret 原文
	wrong := "wrong-secret-abcdefghijkl"
	if _, err := s.Update(ctx, c.ID, Patch{Secrets: map[string]string{"client_secret": wrong}}); err != nil {
		t.Fatal(err)
	}
	state, code := authorize(t, s, c.ID)
	res, err := s.CompleteOAuth(ctx, state, code, "", "")
	if err != nil || res.OK || !strings.Contains(res.Message, "invalid_client") || res.Connector.Status != StatusConnecting {
		t.Fatalf("换令牌失败 = %+v %v", res, err)
	}
	if strings.Contains(res.Message, wrong) {
		t.Fatal("说明里不该有 client_secret")
	}
	// PKCE 校验码对不上：假服务拒绝（框架拿的是发起时那一个，这里篡改内存里的校验码模拟）
	state, code = authorize(t, s, c.ID)
	s.oauth.mu.Lock()
	p := s.oauth.pending[state]
	p.verifier = "tampered"
	s.oauth.pending[state] = p
	s.oauth.mu.Unlock()
	if _, err := s.Update(ctx, c.ID, Patch{Secrets: map[string]string{"client_secret": fs.ClientSecret}}); err != nil {
		t.Fatal(err)
	}
	if res, _ := s.CompleteOAuth(ctx, state, code, "", ""); res.OK || !strings.Contains(res.Message, "PKCE") {
		t.Fatalf("PKCE 不对应失败：%+v", res)
	}
}

func TestOAuthStartChecks(t *testing.T) {
	ctx := context.Background()
	s, _, _ := newOAuthStore(t)
	if err := s.Defs().Register(Fake()); err != nil {
		t.Fatal(err)
	}
	tok, err := s.Create(ctx, Input{Tool: FakeTool, Secrets: map[string]string{"token": "good-token"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartOAuth(ctx, tok.ID, ""); err == nil {
		t.Fatal("token 认证的实例不能发起 OAuth")
	}
	if tok.OAuth != nil {
		t.Fatal("非 oauth2 的实例 oauth 应为 null")
	}
	fs := oauthfake.New(0)
	defer fs.Close()
	c := newOAuthConnector(t, s, fs)
	for _, bad := range []string{"//evil.test/x", "https://evil.test/cb", "javascript:alert(1)", "/a\\b"} {
		if _, err := s.StartOAuth(ctx, c.ID, bad); err == nil {
			t.Errorf("return_to %q 应拒绝", bad)
		}
	}
	for _, ok := range []string{"/settings/connectors", "http://127.0.0.1:7780/settings", "http://localhost:5173/", "https://bro.vip/x"} {
		if _, err := s.StartOAuth(ctx, c.ID, ok); err != nil {
			t.Errorf("return_to %q 应放行：%v", ok, err)
		}
	}
	if err := s.SetPublicURL("http://127.0.0.1:7797/"); err != nil || s.CallbackURL() != "http://127.0.0.1:7797"+CallbackPath {
		t.Fatalf("SetPublicURL = %v %s", err, s.CallbackURL())
	}
	for _, bad := range []string{"bro.vip", "https://bro.vip/app", "ftp://x"} {
		if err := s.SetPublicURL(bad); err == nil {
			t.Errorf("public url %q 应拒绝", bad)
		}
	}
	// 对方没给有效期：不记到期时间，后台不刷
	state, code := authorize(t, s, c.ID)
	res, err := s.CompleteOAuth(ctx, state, code, "", "")
	if err != nil || !res.OK || res.Connector.OAuth.ExpiresAt != nil {
		t.Fatalf("无有效期 = %+v %v", res, err)
	}
	// 后台任务能起能停
	s.StartRefresher(ctx)
	s.StartRefresher(ctx)
	s.StopRefresher()
	s.StopRefresher()
}

func TestOAuthSpecCheck(t *testing.T) {
	base := FakeOAuth()
	cases := map[string]func(d *Def){
		"oauth2 没有 spec":      func(d *Def) { d.OAuth = nil },
		"token 带 spec":        func(d *Def) { d.Auth = []AuthMode{AuthToken} },
		"缺令牌地址":               func(d *Def) { d.OAuth.TokenURL = "" },
		"base_url_field 不是字段": func(d *Def) { d.OAuth.BaseURLField = "nope" },
		"相对路径没有 base":         func(d *Def) { d.OAuth.BaseURLField = "" },
		"client_id 字段是凭证":     func(d *Def) { d.OAuth.ClientIDField = "client_secret" },
		"client_secret 字段是文本": func(d *Def) { d.OAuth.ClientSecretField = "client_id" },
	}
	for name, mut := range cases {
		d := base
		o := *base.OAuth
		d.OAuth = &o
		mut(&d)
		if err := NewRegistry().Register(d); err == nil {
			t.Errorf("%s：应登记失败", name)
		}
	}
	builtin := base
	o := *base.OAuth
	o.ClientID, o.ClientIDField = "builtin-id", ""
	builtin.OAuth = &o
	r := NewRegistry()
	if err := r.Register(builtin); err != nil {
		t.Fatal(err)
	}
	if d, _ := r.Get(FakeOAuthTool); !d.OAuth.Builtin || o.Builtin {
		t.Fatal("内置 client_id 时 builtin 为 true，且不改调用方的 spec")
	}
}
