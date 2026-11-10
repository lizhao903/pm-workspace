// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"
	"encoding/json"
	"io"
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

// fakeCalendarAPI 是假的 userinfo 和日历 v3：只认 oauthfake 当前签出的 access_token。
type fakeCalendarAPI struct {
	*httptest.Server

	mu       sync.Mutex
	lastPath string
	lastQ    url.Values
	lastBody map[string]any
	tokens   []string
}

func newFakeCalendarAPI(auth *oauthfake.Server) *fakeCalendarAPI {
	g := &fakeCalendarAPI{}
	record := func(r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		g.lastPath, g.lastQ, g.lastBody = r.URL.EscapedPath(), r.URL.Query(), nil
		if r.Body != nil {
			b, _ := io.ReadAll(r.Body)
			if len(b) > 0 {
				_ = json.Unmarshal(b, &g.lastBody)
			}
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /userinfo", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"sub": "10001", "email": "pm@example.com"})
	})
	mux.HandleFunc("GET /calendar/v3/users/me/calendarList", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		_ = json.NewEncoder(w).Encode(map[string]any{"nextPageToken": "c2", "items": []map[string]any{
			{"id": "pm@example.com", "summary": "pm@example.com", "primary": true, "accessRole": "owner", "timeZone": "Asia/Shanghai"},
			{"id": "zh.china#holiday@group.v.calendar.google.com", "summary": "中国的节假日", "accessRole": "reader"},
		}})
	})
	mux.HandleFunc("GET /calendar/v3/calendars/{cal}/events", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		_ = json.NewEncoder(w).Encode(map[string]any{"timeZone": "Asia/Shanghai", "items": []map[string]any{
			{"id": "ev1", "status": "confirmed", "summary": "需求评审", "start": map[string]string{"dateTime": "2026-10-30T10:00:00+08:00"},
				"end": map[string]string{"dateTime": "2026-10-30T11:00:00+08:00"}, "htmlLink": "https://calendar.google.com/event?eid=ev1",
				"organizer": map[string]any{"email": "pm@example.com", "self": true},
				"attendees": []map[string]any{{"email": "dev@example.com", "displayName": "开发", "responseStatus": "accepted"}}},
			{"id": "ev2", "summary": "国庆", "start": map[string]string{"date": "2026-10-01"}, "end": map[string]string{"date": "2026-10-08"}},
		}})
	})
	mux.HandleFunc("POST /calendar/v3/calendars/{cal}/events", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		if r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		g.mu.Lock()
		ev := map[string]any{"id": "new1", "status": "confirmed", "htmlLink": "https://calendar.google.com/event?eid=new1"}
		for k, v := range g.lastBody {
			ev[k] = v
		}
		g.mu.Unlock()
		_ = json.NewEncoder(w).Encode(ev)
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
		if strings.Contains(r.URL.EscapedPath(), "/calendars/missing") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":404,"message":"Not Found"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		mux.ServeHTTP(w, r)
	}))
	return g
}

func (g *fakeCalendarAPI) last() (string, url.Values, map[string]any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lastPath, g.lastQ, g.lastBody
}

func newCalendarStore(t *testing.T, fs *oauthfake.Server, api *fakeCalendarAPI) *Store {
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
	d := GoogleCalendar(GoogleCalendarEndpoints{GoogleEndpoints: GoogleEndpoints{AuthURL: fs.URL + "/authorize",
		TokenURL: fs.URL + "/token", UserInfoURL: api.URL + "/userinfo"}, CalendarAPI: api.URL + "/calendar/v3/"})
	if err := defs.Register(d); err != nil {
		t.Fatal(err)
	}
	s := New(st.DB(), v, defs)
	c := &clock{t: time.Date(2026, 10, 29, 8, 0, 0, 0, time.UTC)}
	s.now = c.now
	return s
}

func TestGoogleCalendarAuthorizeAndTools(t *testing.T) {
	ctx := context.Background()
	fs := oauthfake.New(3600)
	defer fs.Close()
	api := newFakeCalendarAPI(fs)
	defer api.Close()
	s := newCalendarStore(t, fs, api)
	var seen []string

	d, ok := s.Defs().Get(GoogleCalendarTool)
	if !ok {
		t.Fatal("gcal 没登记")
	}
	if d.Category != "office" || d.OAuth.Builtin || d.OAuth.ClientIDField != "client_id" || d.OAuth.ClientSecretField != "client_secret" {
		t.Fatalf("定义 = %+v %+v", d, d.OAuth)
	}

	c, err := s.Create(ctx, Input{Tool: GoogleCalendarTool, Config: map[string]string{"client_id": fs.ClientID},
		Secrets: map[string]string{"client_secret": fs.ClientSecret}})
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.StartOAuth(ctx, c.ID, "/settings/connectors")
	if err != nil {
		t.Fatal(err)
	}
	q, _ := url.Parse(st.AuthorizeURL)
	if got := q.Query().Get("scope"); got != "openid email "+calendarReadScope+" "+calendarEventsScope ||
		q.Query().Get("access_type") != "offline" || q.Query().Get("prompt") != "consent" {
		t.Fatalf("授权地址参数不对：%s", st.AuthorizeURL)
	}
	loc, err := oauthfake.Authorize(st.AuthorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.CompleteOAuth(ctx, loc.Query().Get("state"), loc.Query().Get("code"), "", "")
	if err != nil || !res.OK || res.Connector.Status != StatusConnected || res.Connector.Account != "pm@example.com" {
		t.Fatalf("回调 = %+v %v", res, err)
	}
	seen = append(seen, mustJSONText(t, res))
	tr, err := s.Test(ctx, c.ID)
	if err != nil || !tr.OK || tr.Account != "pm@example.com" {
		t.Fatalf("连通测试 = %+v %v", tr, err)
	}

	// 工具清单：新建日程是写工具、默认需确认，其余只读、自动
	tl, err := s.RefreshTools(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tl.Connector.Tools {
		names = append(names, tool.Name)
		wantWrite := tool.Name == "create_event"
		wantMode := ModeAuto
		if wantWrite {
			wantMode = ModeConfirm
		}
		if tool.Write != wantWrite || tool.Mode != wantMode {
			t.Errorf("工具 %s = %+v", tool.Name, tool)
		}
	}
	if strings.Join(names, ",") != "list_calendars,list_events,create_event" {
		t.Fatalf("工具清单 = %v", names)
	}

	call := func(tool, args string) string {
		t.Helper()
		out, err := s.CallTool(ctx, c.ID, tool, json.RawMessage(args))
		if err != nil {
			t.Fatalf("%s(%s) = %v", tool, args, err)
		}
		seen = append(seen, out)
		return out
	}

	out := call("list_calendars", `{"page_size":999}`)
	if _, lq, _ := api.last(); lq.Get("maxResults") != "250" {
		t.Fatalf("列日历参数 = %v", lq)
	}
	if !strings.Contains(out, `"next_page_token":"c2"`) || !strings.Contains(out, `"id":"zh.china#holiday@group.v.calendar.google.com"`) ||
		!strings.Contains(out, `"primary":true`) || !strings.Contains(out, `"time_zone":"Asia/Shanghai"`) {
		t.Fatalf("列日历 = %s", out)
	}

	out = call("list_events", `{"time_min":"2026-10-29T00:00:00+08:00","time_max":"2026-11-05T00:00:00+08:00","query":"评审"}`)
	p, lq, _ := api.last()
	if p != "/calendar/v3/calendars/primary/events" || lq.Get("timeMin") != "2026-10-29T00:00:00+08:00" ||
		lq.Get("timeMax") != "2026-11-05T00:00:00+08:00" || lq.Get("q") != "评审" || lq.Get("singleEvents") != "true" ||
		lq.Get("orderBy") != "startTime" || lq.Get("maxResults") != "50" {
		t.Fatalf("查日程请求 = %s %v", p, lq)
	}
	if !strings.Contains(out, `"start":"2026-10-30T10:00:00+08:00"`) || !strings.Contains(out, `"attendees":["开发 <dev@example.com> (accepted)"]`) ||
		!strings.Contains(out, `"organizer":"pm@example.com"`) || !strings.Contains(out, `"start":"2026-10-01","end":"2026-10-08","all_day":true`) {
		t.Fatalf("查日程 = %s", out)
	}
	// 节假日日历的 # 要转义进路径；不给 time_min 时从现在查起
	call("list_events", `{"calendar_id":"zh.china#holiday@group.v.calendar.google.com"}`)
	p, lq, _ = api.last()
	if p != "/calendar/v3/calendars/zh.china%23holiday@group.v.calendar.google.com/events" || lq.Get("timeMin") == "" || lq.Has("timeMax") {
		t.Fatalf("查节假日请求 = %s %v", p, lq)
	}

	out = call("create_event", `{"summary":"迭代评审 <v3>","start":"2026-10-30T14:00:00+08:00","end":"2026-10-30T15:00:00+08:00",
		"time_zone":"Asia/Shanghai","location":"3 楼","attendees":["dev@example.com"," DEV@example.com","qa@example.com"]}`)
	p, lq, body := api.last()
	if p != "/calendar/v3/calendars/primary/events" || lq.Get("sendUpdates") != "all" {
		t.Fatalf("建日程请求 = %s %v", p, lq)
	}
	if mustJSONText(t, body["start"]) != `{"dateTime":"2026-10-30T14:00:00+08:00","timeZone":"Asia/Shanghai"}` ||
		mustJSONText(t, body["attendees"]) != `[{"email":"dev@example.com"},{"email":"qa@example.com"}]` || body["location"] != "3 楼" {
		t.Fatalf("建日程请求体 = %v", body)
	}
	if !strings.Contains(out, `"id":"new1"`) || !strings.Contains(out, `"summary":"迭代评审 <v3>"`) || !strings.Contains(out, `"all_day":false`) {
		t.Fatalf("建日程 = %s", out)
	}
	// 全天日程、没有参与人不发邀请
	out = call("create_event", `{"summary":"团建","start":"2026-11-06","end":"2026-11-07"}`)
	_, lq, body = api.last()
	if lq.Get("sendUpdates") != "none" || mustJSONText(t, body["start"]) != `{"date":"2026-11-06"}` || body["attendees"] != nil {
		t.Fatalf("全天日程请求 = %v %v", lq, body)
	}
	if !strings.Contains(out, `"all_day":true`) {
		t.Fatalf("全天日程 = %s", out)
	}

	for _, bad := range []struct{ tool, args, want string }{
		{"create_event", `{"start":"2026-11-06","end":"2026-11-07"}`, "summary 必填"},
		{"create_event", `{"summary":"x","start":"明天","end":"2026-11-07"}`, "start 要是"},
		{"create_event", `{"summary":"x","start":"2026-11-06T10:00:00+08:00","end":"2026-11-06"}`, "要么都是"},
		{"create_event", `{"summary":"x","start":"2026-11-06T10:00:00+08:00","end":"2026-11-06T09:00:00+08:00"}`, "end 要晚于 start"},
		{"create_event", `{"summary":"x","start":"2026-11-06","end":"2026-11-07","time_zone":"火星"}`, "time_zone"},
		{"create_event", `{"summary":"x","start":"2026-11-06","end":"2026-11-07","attendees":["张三"]}`, "不是邮箱"},
		{"list_events", `{"calendar_id":"../users"}`, "calendar_id 不合法"},
		{"list_events", `{"time_max":"2026-11-05"}`, "time_max 要是 RFC3339"},
		{"list_events", `{"calendar_id":"missing"}`, "Google 返回 404：Not Found"},
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
	access, refresh := fs.Tokens()
	text := strings.Join(seen, "\n")
	for _, secret := range []string{access, refresh, fs.ClientSecret} {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("响应里出现了凭证 %s", secret)
		}
	}
}

func TestGoogleCalendarDefaults(t *testing.T) {
	d := GoogleCalendar(GoogleCalendarEndpoints{})
	if _, err := Prepare(d); err != nil {
		t.Fatalf("正式地址的定义应合法：%v", err)
	}
	if d.OAuth.AuthURL != googleAuthURL || d.OAuth.TokenURL != googleTokenURL {
		t.Fatalf("默认地址 = %s %s", d.OAuth.AuthURL, d.OAuth.TokenURL)
	}
	if e := (GoogleCalendarEndpoints{}).withDefaults(); e.CalendarAPI != googleCalendarAPI || e.UserInfoURL != googleUserInfoURL {
		t.Fatalf("默认地址 = %+v", e)
	}
}
