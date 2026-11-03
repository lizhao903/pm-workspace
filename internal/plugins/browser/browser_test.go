package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "browser" || m.TablePrefix != "browser_" || len(m.Permissions) != 0 || len(m.Depends) != 0 {
		t.Fatalf("id=%s table_prefix=%s permissions=%v depends=%v", m.ID, m.TablePrefix, m.Permissions, m.Depends)
	}
	if New().Migrations() == nil {
		t.Fatal("Migrations() 不能是 nil")
	}
}

type env struct {
	h     http.Handler
	d     *db.DB
	conns *connector.Store
}

// 在真库上装好、启用 browser，接上真的连接器 store（Drive 用本机地址的假端点，日历借 Drive 的定义换个 key）
func setup(t *testing.T) env {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := connector.NewRegistry()
	ep := connector.GoogleEndpoints{AuthURL: "http://127.0.0.1:1/authorize", TokenURL: "http://127.0.0.1:1/token",
		UserInfoURL: "http://127.0.0.1:1/userinfo", DriveAPI: "http://127.0.0.1:1/drive"}
	cal := connector.GoogleDrive(ep)
	cal.Tool, cal.Label = calendarTool, "Google 日历"
	for _, def := range []connector.Def{connector.GoogleDrive(ep), cal} {
		if err := defs.Register(def); err != nil {
			t.Fatal(err)
		}
	}
	conns := connector.New(d, v, defs)

	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.SetConnectors(conns)
	if err := r.Add(New()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "browser", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "browser"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return env{mux, d, conns}
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func mustCall(t *testing.T, h http.Handler, method, path, body string, want int) map[string]any {
	t.Helper()
	code, out := call(t, h, method, path, body)
	if code != want {
		t.Fatalf("%s %s：要 %d，实际 %d %v", method, path, want, code, out)
	}
	return out
}

func errMsg(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["message"].(string)
	return s
}

func TestTabsRoundTrip(t *testing.T) {
	e := setup(t)
	out := mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)
	if got := out["data"].([]any); len(got) != 0 {
		t.Fatalf("新装的没有标签：%v", got)
	}
	tabs := []map[string]any{
		{"id": "bt_home1", "url": "about:home", "title": "新标签页", "kind": "home", "history": []string{"about:home"}, "cursor": 0},
		{"id": "bt_proto1", "url": "http://127.0.0.1:7790", "title": "原型", "kind": "proto",
			"history": []string{"about:home", "http://127.0.0.1:7790"}, "cursor": 1, "pinned": true, "active": true, "loading": true},
		{"id": "bt_web1", "url": "https://example.com/a?b=1", "title": "网页", "kind": "web",
			"history": []string{"https://example.com", "https://example.com/a?b=1", "https://example.com/c"}, "cursor": 1},
	}
	body, _ := json.Marshal(map[string]any{"tabs": tabs})
	mustCall(t, e.h, "PUT", "/api/browser/tabs", string(body), 200)
	got := mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any)
	if len(got) != 3 {
		t.Fatalf("要 3 个，实际 %v", got)
	}
	for i, want := range tabs {
		g := got[i].(map[string]any)
		for _, k := range []string{"id", "url", "title", "kind"} {
			if g[k] != want[k] {
				t.Errorf("第 %d 个 %s：要 %v，实际 %v", i, k, want[k], g[k])
			}
		}
		wh, _ := json.Marshal(want["history"])
		gh, _ := json.Marshal(g["history"])
		if string(wh) != string(gh) || g["cursor"] != float64(want["cursor"].(int)) || g["position"] != float64(i) {
			t.Errorf("第 %d 个 history/cursor/position 不对：%v", i, g)
		}
		if g["pinned"] != (want["pinned"] == true) || g["active"] != (want["active"] == true) {
			t.Errorf("第 %d 个 pinned/active 不对：%v", i, g)
		}
		if _, has := g["loading"]; has {
			t.Errorf("loading 不该存：%v", g)
		}
	}

	// 整体替换：去掉一个、换顺序、改地址
	tabs = []map[string]any{
		{"id": "bt_web1", "url": "https://example.com/c", "title": "网页 2", "kind": "web", "history": []string{"https://example.com/c"}, "active": true},
		{"id": "bt_home1", "url": "about:home", "kind": "home"},
	}
	body, _ = json.Marshal(map[string]any{"tabs": tabs})
	mustCall(t, e.h, "PUT", "/api/browser/tabs", string(body), 200)
	got = mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any)
	if len(got) != 2 || got[0].(map[string]any)["id"] != "bt_web1" || got[1].(map[string]any)["id"] != "bt_home1" ||
		got[0].(map[string]any)["title"] != "网页 2" {
		t.Fatalf("替换后：%v", got)
	}
	if h := got[1].(map[string]any)["history"].([]any); len(h) != 1 || h[0] != "about:home" {
		t.Fatalf("没给历史时用当前地址：%v", got[1])
	}

	// 没给 id 的由后端生成
	mustCall(t, e.h, "PUT", "/api/browser/tabs", `{"tabs":[{"url":"about:home","kind":"home"}]}`, 200)
	got = mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any)
	if id, _ := got[0].(map[string]any)["id"].(string); len(got) != 1 || !strings.HasPrefix(id, "bt_") {
		t.Fatalf("生成的 id：%v", got)
	}

	// 清空
	mustCall(t, e.h, "PUT", "/api/browser/tabs", `{"tabs":[]}`, 200)
	if got = mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any); len(got) != 0 {
		t.Fatalf("清空后：%v", got)
	}
}

func TestTabsValidation(t *testing.T) {
	e := setup(t)
	mustCall(t, e.h, "PUT", "/api/browser/tabs", `{"tabs":[{"id":"bt_keep","url":"about:home","kind":"home"}]}`, 200)
	many := make([]map[string]any, MaxTabs+1)
	for i := range many {
		many[i] = map[string]any{"id": fmt.Sprintf("bt_%d", i), "url": "about:home", "kind": "home"}
	}
	b51, _ := json.Marshal(map[string]any{"tabs": many})
	b50, _ := json.Marshal(map[string]any{"tabs": many[:MaxTabs]})
	cases := map[string]string{
		"超过 50 个":   string(b51),
		"不是数组":      `{"tabs":{}}`,
		"缺 tabs":    `{}`,
		"多余字段":      `{"tabs":[],"x":1}`,
		"标签多余字段":    `{"tabs":[{"url":"about:home","kind":"home","foo":1}]}`,
		"种类不对":      `{"tabs":[{"url":"about:home","kind":"file"}]}`,
		"地址不认":      `{"tabs":[{"url":"javascript:alert(1)","kind":"web"}]}`,
		"缺地址":       `{"tabs":[{"kind":"web"}]}`,
		"历史里地址不认":   `{"tabs":[{"url":"about:home","kind":"home","history":["file:///etc/passwd"]}]}`,
		"游标越界":      `{"tabs":[{"url":"about:home","kind":"home","history":["about:home"],"cursor":1}]}`,
		"id 不是 bt_": `{"tabs":[{"id":"x1","url":"about:home","kind":"home"}]}`,
		"id 重复":     `{"tabs":[{"id":"bt_a","url":"about:home","kind":"home"},{"id":"bt_a","url":"about:home","kind":"home"}]}`,
		"两个当前":      `{"tabs":[{"url":"about:home","kind":"home","active":true},{"url":"about:home","kind":"home","active":true}]}`,
	}
	for name, body := range cases {
		code, out := call(t, e.h, "PUT", "/api/browser/tabs", body)
		if code != 400 {
			t.Errorf("%s：要 400，实际 %d %v", name, code, out)
		}
	}
	if code, out := call(t, e.h, "PUT", "/api/browser/tabs", string(b51)); !strings.Contains(errMsg(out), "最多 50 个") {
		t.Errorf("超过 50 个的说明：%d %v", code, out)
	}
	// 失败的 PUT 不动已有的
	got := mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any)
	if len(got) != 1 || got[0].(map[string]any)["id"] != "bt_keep" {
		t.Fatalf("失败的 PUT 改了数据：%v", got)
	}
	// 正好 50 个可以
	mustCall(t, e.h, "PUT", "/api/browser/tabs", string(b50), 200)
	if got = mustCall(t, e.h, "GET", "/api/browser/tabs", "", 200)["data"].([]any); len(got) != MaxTabs {
		t.Fatalf("50 个：%d", len(got))
	}
}

func TestAllowlist(t *testing.T) {
	e := setup(t)
	list := func() []any { return mustCall(t, e.h, "GET", "/api/browser/allowlist", "", 200)["data"].([]any) }
	got := list()
	if len(got) != 2 || got[0].(map[string]any)["host"] != "127.0.0.1" || got[1].(map[string]any)["host"] != "localhost" ||
		got[0].(map[string]any)["builtin"] != true {
		t.Fatalf("默认带本机地址：%v", got)
	}
	out := mustCall(t, e.h, "POST", "/api/browser/allowlist", `{"host":"https://Docs.Example.com:8443/x","note":"文档站"}`, 201)
	if d := out["data"].(map[string]any); d["host"] != "docs.example.com" || d["note"] != "文档站" || d["builtin"] != false {
		t.Fatalf("加一项：%v", d)
	}
	mustCall(t, e.h, "POST", "/api/browser/allowlist", `{"host":"*.bro.vip"}`, 201)
	if code, _ := call(t, e.h, "POST", "/api/browser/allowlist", `{"host":"docs.example.com"}`); code != 409 {
		t.Errorf("重复要 409，实际 %d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/browser/allowlist", `{"host":"localhost"}`); code != 409 {
		t.Errorf("内置的要 409，实际 %d", code)
	}
	for _, bad := range []string{`{"host":""}`, `{"host":"a b"}`, `{"host":"-x.com"}`, `{}`, `{"host":"x.com","y":1}`} {
		if code, _ := call(t, e.h, "POST", "/api/browser/allowlist", bad); code != 400 {
			t.Errorf("%s：要 400，实际 %d", bad, code)
		}
	}
	if got = list(); len(got) != 4 || got[2].(map[string]any)["host"] != "docs.example.com" {
		t.Fatalf("加了两项后：%v", got)
	}
	mustCall(t, e.h, "DELETE", "/api/browser/allowlist?host="+url.QueryEscape("docs.example.com"), "", 200)
	if code, _ := call(t, e.h, "DELETE", "/api/browser/allowlist?host=docs.example.com", ""); code != 404 {
		t.Errorf("删过的要 404，实际 %d", code)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/browser/allowlist?host=127.0.0.1", ""); code != 409 {
		t.Errorf("内置的不能删，要 409，实际 %d", code)
	}
	if got = list(); len(got) != 3 || got[2].(map[string]any)["host"] != "*.bro.vip" {
		t.Fatalf("删一项后：%v", got)
	}
}

// newConn 建一个实例并模拟授权完成：状态、账号、范围、授权时间都写上（真授权要连 Google）
func newConn(t *testing.T, e env, tool, account, scope string) string {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: tool,
		Config: map[string]string{"client_id": "cid.apps.googleusercontent.com"}, Secrets: map[string]string{"client_secret": "s"}})
	if err != nil {
		t.Fatal(err)
	}
	if account != "" {
		at := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		if _, err := e.d.W.Exec(`UPDATE connectors SET status = 'connected', account = ?, oauth_scope = ?, oauth_authorized_at = ? WHERE id = ?`,
			account, scope, at, c.ID); err != nil {
			t.Fatal(err)
		}
	}
	return c.ID
}

func connStatus(t *testing.T, e env, id string) string {
	t.Helper()
	c, err := e.conns.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return c.Status
}

func googleState(t *testing.T, e env) map[string]any {
	t.Helper()
	return mustCall(t, e.h, "GET", "/api/browser/google", "", 200)["data"].(map[string]any)
}

func TestGoogleNotConfigured(t *testing.T) {
	e := setup(t)
	st := googleState(t, e)
	if st["signed_in"] != false || st["configured"] != false || st["account"] != nil || st["drive"] != nil {
		t.Fatalf("没有 Drive 实例：%v", st)
	}
	code, out := call(t, e.h, "POST", "/api/browser/google/login", "")
	if code != 409 || !strings.Contains(errMsg(out), "OAuth 客户端") {
		t.Fatalf("没配 Drive 时登录：%d %v", code, out)
	}
	// 没登录时退出什么都不做
	out = mustCall(t, e.h, "POST", "/api/browser/google/logout", "", 200)
	if d := out["data"].(map[string]any); len(d["disconnected"].([]any)) != 0 {
		t.Fatalf("退出：%v", d)
	}
}

func TestGoogleLoginStartsDriveOAuth(t *testing.T) {
	e := setup(t)
	drive := newConn(t, e, driveTool, "", "")
	cal := newConn(t, e, calendarTool, "", "")
	if st := googleState(t, e); st["signed_in"] != false || st["configured"] != true || st["drive"].(map[string]any)["id"] != drive {
		t.Fatalf("配了没授权：%v", st)
	}
	out := mustCall(t, e.h, "POST", "/api/browser/google/login", `{"return_to":"/browser"}`, 200)["data"].(map[string]any)
	u, err := url.Parse(out["authorize_url"].(string))
	if err != nil || out["connector_id"] != drive || u.Host != "127.0.0.1:1" || u.Query().Get("client_id") != "cid.apps.googleusercontent.com" ||
		!strings.Contains(u.Query().Get("scope"), "drive.readonly") {
		t.Fatalf("登录要转调 Drive 实例的授权：%v", out)
	}
	if c, _ := out["calendar"].(map[string]any); c == nil || c["connector_id"] != cal {
		t.Fatalf("有日历实例时顺带发起：%v", out)
	}
	if code, _ := call(t, e.h, "POST", "/api/browser/google/login", `{"return_to":"https://evil.example.com/"}`); code != 400 {
		t.Fatalf("回跳到外站要 400，实际 %d", code)
	}
}

func TestGoogleLogoutDisconnectsDriveAndCalendar(t *testing.T) {
	e := setup(t)
	drive := newConn(t, e, driveTool, "chen.yi.pm@gmail.com", "openid email https://www.googleapis.com/auth/drive.readonly")
	cal := newConn(t, e, calendarTool, "Chen.Yi.PM@gmail.com", "openid email https://www.googleapis.com/auth/calendar.events")

	st := googleState(t, e)
	acc, _ := st["account"].(map[string]any)
	if st["signed_in"] != true || acc == nil || acc["email"] != "chen.yi.pm@gmail.com" || acc["name"] != "chen.yi.pm" ||
		acc["connected_at"] == nil || st["calendar"].(map[string]any)["id"] != cal {
		t.Fatalf("登录着：%v", st)
	}
	if !reflect.DeepEqual(acc["scopes"], []any{"drive.readonly", "calendar.events"}) {
		t.Fatalf("授权范围要是原型 GOOGLE_SCOPES 的 key：%v", acc["scopes"])
	}

	out := mustCall(t, e.h, "POST", "/api/browser/google/logout", "", 200)["data"].(map[string]any)
	if !reflect.DeepEqual(out["disconnected"], []any{drive, cal}) {
		t.Fatalf("断开的：%v", out["disconnected"])
	}
	if s := connStatus(t, e, drive); s != connector.StatusDisconnected {
		t.Errorf("Drive：%s", s)
	}
	if s := connStatus(t, e, cal); s != connector.StatusDisconnected {
		t.Errorf("日历：%s", s)
	}
	if g := out["google"].(map[string]any); g["signed_in"] != false || g["account"] != nil {
		t.Fatalf("退出后：%v", g)
	}
	// 断开记了审计，操作者是插件
	var n int
	if err := e.d.R.QueryRow(`SELECT COUNT(*) FROM audits WHERE action = 'disconnect' AND target_type = 'connector' AND actor LIKE 'browser%'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("审计 %d 条，err=%v", n, err)
	}
}

func TestDriveDisconnectedInSettingsMeansSignedOut(t *testing.T) {
	e := setup(t)
	drive := newConn(t, e, driveTool, "chen.yi.pm@gmail.com", "openid email https://www.googleapis.com/auth/drive.readonly")
	cal := newConn(t, e, calendarTool, "chen.yi.pm@gmail.com", "openid email https://www.googleapis.com/auth/calendar.events")
	if googleState(t, e)["signed_in"] != true {
		t.Fatal("要先登录着")
	}
	// 连接器设置页的断开走内核 POST /api/connectors/{id}/disconnect，就是 Store.Disconnect
	if _, _, err := e.conns.Disconnect(context.Background(), drive); err != nil {
		t.Fatal(err)
	}
	st := googleState(t, e)
	if st["signed_in"] != false || st["account"] != nil || st["drive"].(map[string]any)["status"] != "disconnected" {
		t.Fatalf("Drive 断开后要算没登录：%v", st)
	}
	if s := connStatus(t, e, cal); s != connector.StatusConnected {
		t.Fatalf("日历不受影响：%s", s)
	}
	// 删掉 Drive 实例也一样
	if _, err := e.conns.Delete(context.Background(), drive); err != nil {
		t.Fatal(err)
	}
	if st = googleState(t, e); st["signed_in"] != false || st["configured"] != false {
		t.Fatalf("删掉 Drive 后：%v", st)
	}
}

// 原型 browserdata.ts 里 BrowserTab 的字段，Tab 里都要有（loading 只在前端内存）
func TestTabFieldsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "browserdata.ts"))
	if err != nil {
		t.Skip("没有原型 browserdata.ts：", err)
	}
	src := string(b)
	i := strings.Index(src, "export interface BrowserTab {")
	if i < 0 {
		t.Fatal("原型里找不到 BrowserTab")
	}
	body := src[i:]
	body = body[:strings.Index(body, "}")]
	have := map[string]bool{}
	ty := reflect.TypeOf(Tab{})
	for j := 0; j < ty.NumField(); j++ {
		have[strings.Split(ty.Field(j).Tag.Get("json"), ",")[0]] = true
	}
	for _, m := range regexp.MustCompile(`(?m)^\s*(\w+)\??:`).FindAllStringSubmatch(body, -1) {
		if f := m[1]; f != "loading" && !have[f] {
			t.Errorf("Tab 少了原型的字段 %s", f)
		}
	}
}
