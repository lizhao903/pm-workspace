// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector/oauthfake"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// fakeGoogleAPI 是假的 userinfo 和 Drive v3：只认 oauthfake 当前签出的 access_token。
type fakeGoogleAPI struct {
	*httptest.Server
	auth *oauthfake.Server

	mu     sync.Mutex
	lastQ  url.Values
	tokens []string // 收到过的 Authorization
}

func newFakeGoogleAPI(auth *oauthfake.Server) *fakeGoogleAPI {
	g := &fakeGoogleAPI{auth: auth}
	files := map[string]map[string]any{
		"doc1":  {"id": "doc1", "name": "任务流转 v3 需求文档", "mimeType": "application/vnd.google-apps.document", "parents": []string{"root"}, "owners": []map[string]string{{"displayName": "我", "emailAddress": "pm@example.com"}}},
		"sheet": {"id": "sheet", "name": "竞品对比表", "mimeType": "application/vnd.google-apps.spreadsheet"},
		"note":  {"id": "note", "name": "readme.md", "mimeType": "text/markdown", "size": "12"},
		"pdf1":  {"id": "pdf1", "name": "消息中心改版 PRD.pdf", "mimeType": "application/pdf", "size": "2400000"},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /userinfo", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sub": "10001", "email": "pm@example.com", "email_verified": true})
	})
	mux.HandleFunc("GET /drive/v3/files", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.lastQ = r.URL.Query()
		g.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"nextPageToken": "p2",
			"files": []map[string]any{files["doc1"], files["sheet"]}})
	})
	mux.HandleFunc("GET /drive/v3/files/{id}", func(w http.ResponseWriter, r *http.Request) {
		f, ok := files[r.PathValue("id")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":404,"message":"File not found: ` + r.PathValue("id") + `."}}`))
			return
		}
		if r.URL.Query().Get("alt") == "media" {
			_, _ = w.Write([]byte("# 说明\n正文"))
			return
		}
		_ = json.NewEncoder(w).Encode(f)
	})
	mux.HandleFunc("GET /drive/v3/files/{id}/export", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("mimeType") {
		case "text/plain":
			_, _ = w.Write([]byte("任务流转需求：从待办到完成一共五个状态。"))
		case "text/csv":
			_, _ = w.Write([]byte("功能,我们,对手\n看板,有,无\n"))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		access, _ := auth.Tokens()
		got := r.Header.Get("Authorization")
		g.mu.Lock()
		g.tokens = append(g.tokens, got)
		g.mu.Unlock()
		if access == "" || got != "Bearer "+access {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":401,"message":"Request had invalid authentication credentials."}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		mux.ServeHTTP(w, r)
	}))
	return g
}

func (g *fakeGoogleAPI) query() url.Values {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lastQ
}

// newGoogleStore 登记 gdrive（地址指向假服务）和 fake_oauth，日志写进 buf。
func newGoogleStore(t *testing.T, fs *oauthfake.Server, api *fakeGoogleAPI) (*Store, *bytes.Buffer) {
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
	for _, d := range []Def{GoogleDrive(GoogleEndpoints{AuthURL: fs.URL + "/authorize", TokenURL: fs.URL + "/token",
		UserInfoURL: api.URL + "/userinfo", DriveAPI: api.URL + "/drive/v3/"}), FakeOAuth()} {
		if err := defs.Register(d); err != nil {
			t.Fatal(err)
		}
	}
	s := New(st.DB(), v, defs)
	buf := &bytes.Buffer{}
	s.log = slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	c := &clock{t: time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)}
	s.now = c.now
	return s, buf
}

func mustJSONText(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestGoogleDriveAuthorizeRefreshAndTools(t *testing.T) {
	ctx := context.Background()
	fs := oauthfake.New(3600)
	defer fs.Close()
	api := newFakeGoogleAPI(fs)
	defer api.Close()
	s, logs := newGoogleStore(t, fs, api)
	var seen []string // 所有响应的 JSON，最后查有没有令牌和 client_secret
	keep := func(v any) { seen = append(seen, mustJSONText(t, v)) }

	d, ok := s.Defs().Get(GoogleDriveTool)
	if !ok {
		t.Fatal("gdrive 没登记")
	}
	keep(s.Defs().List())
	if d.Category != "docs" || d.OAuth.Builtin || d.OAuth.ClientIDField != "client_id" || d.OAuth.ClientSecretField != "client_secret" {
		t.Fatalf("定义 = %+v %+v", d, d.OAuth)
	}
	if !strings.Contains(mustJSONText(t, d), `"auth_params":{"access_type":"offline","prompt":"consent"}`) {
		t.Fatalf("定义 JSON 应带 auth_params：%s", mustJSONText(t, d))
	}

	c, err := s.Create(ctx, Input{Tool: GoogleDriveTool, Config: map[string]string{"client_id": fs.ClientID},
		Secrets: map[string]string{"client_secret": fs.ClientSecret}})
	if err != nil {
		t.Fatal(err)
	}
	keep(c)

	// 授权地址：Google 要的附加参数 + openid email + drive.readonly
	st, err := s.StartOAuth(ctx, c.ID, "/settings/connectors")
	if err != nil {
		t.Fatal(err)
	}
	keep(st)
	u, _ := url.Parse(st.AuthorizeURL)
	q := u.Query()
	if q.Get("access_type") != "offline" || q.Get("prompt") != "consent" || q.Get("client_id") != fs.ClientID ||
		q.Get("scope") != "openid email "+driveScope || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("授权地址参数不对：%s", st.AuthorizeURL)
	}
	if !strings.HasPrefix(st.AuthorizeURL, fs.URL+"/authorize?") {
		t.Fatalf("授权地址 = %s", st.AuthorizeURL)
	}

	// 旧定义（fake_oauth）不带附加参数
	fc, err := s.Create(ctx, Input{Tool: FakeOAuthTool, Config: map[string]string{"base_url": fs.URL, "client_id": fs.ClientID},
		Secrets: map[string]string{"client_secret": fs.ClientSecret}})
	if err != nil {
		t.Fatal(err)
	}
	fst, err := s.StartOAuth(ctx, fc.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if fq, _ := url.Parse(fst.AuthorizeURL); fq.Query().Has("access_type") || fq.Query().Has("prompt") {
		t.Fatalf("fake_oauth 的授权地址不该有附加参数：%s", fst.AuthorizeURL)
	}
	if strings.Contains(mustJSONText(t, FakeOAuth()), "auth_params") {
		t.Fatal("没有附加参数的定义 JSON 里不该出现 auth_params")
	}

	// 走完授权：账号是邮箱
	loc, err := oauthfake.Authorize(st.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.CompleteOAuth(ctx, loc.Query().Get("state"), loc.Query().Get("code"), "", "")
	if err != nil || !res.OK || !res.Refresh {
		t.Fatalf("回调 = %+v %v", res, err)
	}
	keep(res)
	if res.Connector.Status != StatusConnected || res.Connector.Account != "pm@example.com" {
		t.Fatalf("授权后 = %s %q %s", res.Connector.Status, res.Connector.Account, res.Connector.Error)
	}
	access1, refresh1 := fs.Tokens()

	// 刷新令牌后连通测试用新令牌
	rr, err := s.RefreshOAuth(ctx, c.ID)
	if err != nil || !rr.OK {
		t.Fatalf("刷新 = %+v %v", rr, err)
	}
	keep(rr)
	access2, refresh2 := fs.Tokens()
	if access2 == access1 || fs.Refreshes != 1 {
		t.Fatalf("刷新后令牌没换：%s", access2)
	}
	tr, err := s.Test(ctx, c.ID)
	if err != nil || !tr.OK || tr.Account != "pm@example.com" {
		t.Fatalf("刷新后测试 = %+v %v", tr, err)
	}
	keep(tr)

	// 工具清单：全是只读，默认自动
	tl, err := s.RefreshTools(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	keep(tl)
	names := []string{}
	for _, tool := range tl.Connector.Tools {
		names = append(names, tool.Name)
		if tool.Write || tool.Mode != ModeAuto {
			t.Errorf("工具 %s 应为只读、自动：%+v", tool.Name, tool)
		}
	}
	if strings.Join(names, ",") != "search_files,list_folder,get_file,read_file" {
		t.Fatalf("工具清单 = %v", names)
	}

	// 调工具
	call := func(tool, args string) string {
		t.Helper()
		out, err := s.CallTool(ctx, c.ID, tool, json.RawMessage(args))
		if err != nil {
			t.Fatalf("%s(%s) = %v", tool, args, err)
		}
		seen = append(seen, out)
		return out
	}
	out := call("search_files", `{"query":"Bob's \\ 需求","page_size":500}`)
	if aq := api.query(); aq.Get("q") != `(name contains 'Bob\'s \\ 需求' or fullText contains 'Bob\'s \\ 需求') and trashed = false` ||
		aq.Get("pageSize") != "100" {
		t.Fatalf("搜索参数 = %v", aq)
	}
	if !strings.Contains(out, `"next_page_token":"p2"`) || !strings.Contains(out, `"mime_type":"application/vnd.google-apps.document"`) ||
		!strings.Contains(out, `"owners":["我 <pm@example.com>"]`) {
		t.Fatalf("搜索结果 = %s", out)
	}
	call("list_folder", `{}`)
	if aq := api.query(); aq.Get("q") != "'root' in parents and trashed = false" || aq.Get("pageSize") != "20" {
		t.Fatalf("列目录参数 = %v", aq)
	}
	call("list_folder", `{"folder_id":"fd0PrdReqs7Qm","page_token":"p2"}`)
	if aq := api.query(); aq.Get("q") != "'fd0PrdReqs7Qm' in parents and trashed = false" || aq.Get("pageToken") != "p2" {
		t.Fatalf("列目录参数 = %v", aq)
	}
	if out := call("get_file", `{"file_id":"pdf1"}`); !strings.Contains(out, `"size":"2400000"`) {
		t.Fatalf("文件信息 = %s", out)
	}
	if out := call("read_file", `{"file_id":"doc1"}`); !strings.Contains(out, `"content":"任务流转需求：从待办到完成一共五个状态。"`) ||
		!strings.Contains(out, `"format":"text/plain"`) || !strings.Contains(out, `"truncated":false`) {
		t.Fatalf("读文档 = %s", out)
	}
	if out := call("read_file", `{"file_id":"sheet","max_chars":5}`); !strings.Contains(out, `"content":"功能,我们"`) ||
		!strings.Contains(out, `"format":"text/csv"`) || !strings.Contains(out, `"truncated":true`) {
		t.Fatalf("读表格 = %s", out)
	}
	if out := call("read_file", `{"file_id":"note"}`); !strings.Contains(out, `"content":"# 说明\n正文"`) {
		t.Fatalf("读文本 = %s", out)
	}
	for _, bad := range []struct{ tool, args, want string }{
		{"read_file", `{"file_id":"pdf1"}`, "读不了正文"},
		{"get_file", `{"file_id":"../about"}`, "file_id"},
		{"get_file", `{"file_id":"missing"}`, "Google 返回 404：File not found: missing."},
		{"search_files", `{"query":" "}`, "query 必填"},
		{"list_folder", `{"folder_id":"a b"}`, "folder_id 不合法"},
	} {
		if _, err := s.CallTool(ctx, c.ID, bad.tool, json.RawMessage(bad.args)); err == nil || !strings.Contains(err.Error(), bad.want) {
			t.Errorf("%s(%s) 应失败含 %q，得到 %v", bad.tool, bad.args, bad.want, err)
		}
	}
	for _, h := range api.tokens {
		if h != "" && !strings.HasPrefix(h, "Bearer at-") {
			t.Fatalf("对 Google 的请求带了别的凭证：%s", h)
		}
	}

	// 刷新失败：对方的错误里带 refresh_token 原文，响应和日志里都要抹掉
	fs.SetFailRefresh(true)
	rf, err := s.RefreshOAuth(ctx, c.ID)
	if err != nil || rf.OK || rf.Connector.Status != StatusError || !strings.Contains(rf.Message, "***") {
		t.Fatalf("刷新失败 = %+v %v", rf, err)
	}
	keep(rf)
	// 刷新失败只置异常，没过期的 access_token 照样能调
	if _, err := s.CallTool(ctx, c.ID, "get_file", json.RawMessage(`{"file_id":"doc1"}`)); err != nil {
		t.Fatalf("access_token 还有效时应能调：%v", err)
	}
	all, err := s.List(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	keep(all)

	text := strings.Join(seen, "\n") + "\n" + logs.String()
	if !strings.Contains(logs.String(), "connector token refresh failed") {
		t.Fatalf("刷新失败应记日志：%s", logs.String())
	}
	for _, secret := range []string{access1, refresh1, access2, refresh2, fs.ClientSecret} {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("响应或日志里出现了凭证 %s", secret)
		}
	}
}

func TestGoogleTestNeedsEmail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok-ok" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_token","error_description":"Invalid Credentials"}`))
			return
		}
		_, _ = w.Write([]byte(`{"sub":"1"}`))
	}))
	defer srv.Close()
	test := googleTest(GoogleEndpoints{UserInfoURL: srv.URL}.withDefaults())
	ctx := context.Background()
	if _, err := test(ctx, NewConfig(AuthOAuth2, nil, map[string]string{keyAccessToken: "tok-ok"})); err == nil || !strings.Contains(err.Error(), "邮箱") {
		t.Fatalf("没有邮箱应失败：%v", err)
	}
	_, err := test(ctx, NewConfig(AuthOAuth2, nil, map[string]string{keyAccessToken: "tok-bad"}))
	if err == nil || !strings.Contains(err.Error(), "401：invalid_token: Invalid Credentials") || strings.Contains(err.Error(), "tok-bad") {
		t.Fatalf("令牌无效 = %v", err)
	}
}

func TestOAuthAuthParamsCannotOverrideFlow(t *testing.T) {
	for _, k := range []string{"state", "redirect_uri", "client_id", "scope", "code_challenge", ""} {
		d := GoogleDrive(GoogleEndpoints{})
		d.OAuth.AuthParams = map[string]string{k: "x"}
		if _, err := Prepare(d); err == nil {
			t.Errorf("auth_params 带 %q 应拒绝", k)
		}
	}
	if _, err := Prepare(GoogleDrive(GoogleEndpoints{})); err != nil {
		t.Fatalf("正式地址的定义应合法：%v", err)
	}
	if d := GoogleDrive(GoogleEndpoints{}); d.OAuth.AuthURL != googleAuthURL || d.OAuth.TokenURL != googleTokenURL {
		t.Fatalf("默认地址 = %s %s", d.OAuth.AuthURL, d.OAuth.TokenURL)
	}
}
