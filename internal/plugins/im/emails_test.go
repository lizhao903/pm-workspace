// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// mailSlack 在 fakeSlack 前面接管 users.info 和 auth.test 的 scope 头：
// emails 是资料里的邮箱（缺 users:read.email 时不回）；scopes 非空时 auth.test 带 X-OAuth-Scopes 头。
type mailSlack struct {
	*fakeSlack
	mu        sync.Mutex
	emails    map[string]string
	scopes    string
	noEmail   bool // 模拟缺 users:read.email：profile 里没有 email
	noUsers   bool // 模拟缺 users:read：users.info 回 missing_scope
	infoCalls int
	limitAt   int // users.info 调到第几次之后回 429；0 为不限流
}

func (m *mailSlack) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	method := strings.TrimPrefix(r.URL.Path, "/api/")
	if method == "auth.test" && m.scopes != "" {
		w.Header().Set("X-OAuth-Scopes", m.scopes)
	}
	if method != "users.info" {
		m.fakeSlack.ServeHTTP(w, r)
		return
	}
	_ = r.ParseForm()
	m.infoCalls++
	if m.limitAt > 0 && m.infoCalls > m.limitAt {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	id := r.Form.Get("user")
	if m.revoked {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid_auth"})
		return
	}
	if m.noUsers {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "missing_scope", "needed": "users:read"})
		return
	}
	email, ok := m.emails[id]
	if !ok {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "user_not_found"})
		return
	}
	profile := map[string]any{"display_name": id}
	if !m.noEmail {
		profile["email"] = email
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": map[string]any{"id": id, "name": strings.ToLower(id), "profile": profile}})
}

type mailEnv struct {
	st    *sqlite.Store
	h     http.Handler
	conns *connector.Store
	fake  *mailSlack
	sl    *Slack
}

// setupMail 同 setupSlack，另外接上内核 store（ContactWriter 写联系人要它），建三个联系人和 Slack 身份：
// 林原（没邮箱）、周宇（已有同一个邮箱，大小写不同）、陈晨（已有别的邮箱），外加一个不在这个工作区的人。
func setupMail(t *testing.T) mailEnv {
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
	defs := connector.NewRegistry()
	conns := connector.New(st.DB(), v, defs)
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	r.SetConnectors(conns)
	r.DataDir = t.TempDir()
	defs.SetPluginDefs(r.ConnectorDefs)
	fake := &mailSlack{fakeSlack: newFakeSlack(), emails: map[string]string{
		"U04LIN": "lin@acme.com", "U09ZHOU": "zhou@acme.com", "U05CHEN": "chen@acme.com"}}
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	r.SetHTTPTransport(slackRewrite{u})
	sl := NewSlack(SlackOptions{})
	if err := r.Add(New(sl)); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	r.SetObjectCreator(st)
	if err := r.Install(ctx, "im", []string{"network:im"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "im"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	exec(t, st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_lin', '林原', 'x', 'x')`,
		`INSERT INTO stakeholders (id, name, email, created_at, updated_at) VALUES ('stk_zhou', '周宇', 'Zhou@Acme.com', 'x', 'x')`,
		`INSERT INTO stakeholders (id, name, email, created_at, updated_at) VALUES ('stk_chen', '陈晨', 'chen@old.com', 'x', 'x')`,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_out', '外人', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_lin', 'stk_lin', 'slack', 'U04LIN', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_zhou', 'stk_zhou', 'slack', 'U09ZHOU', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_chen', 'stk_chen', 'slack', 'U05CHEN', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_out', 'stk_out', 'slack', 'U99OUT', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_tg', 'stk_out', 'telegram', 'outsider', 'x', 'x')`,
	)
	return mailEnv{st: st, h: mux, conns: conns, fake: fake, sl: sl}
}

func (e mailEnv) connect(t *testing.T) *connector.Connector {
	t.Helper()
	interval := 0
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &interval,
		Secrets: map[string]string{"bot_token": "xoxb-good"}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (e mailEnv) email(t *testing.T, id string) string {
	t.Helper()
	var s string
	if err := e.st.DB().R.QueryRow(`SELECT email FROM stakeholders WHERE id = ?`, id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func backfill(t *testing.T, h http.Handler, id string) (int, map[string]any) {
	t.Helper()
	code, out := call(t, h, "POST", "/api/im/connectors/"+id+"/backfill-emails", "")
	data, _ := out["data"].(map[string]any)
	if code == 200 {
		return code, data
	}
	return code, out
}

func TestEmailBackfill(t *testing.T) {
	e := setupMail(t)
	e.fake.scopes = "chat:write,users:read,users:read.email"
	c := e.connect(t)
	code, res := backfill(t, e.h, c.ID)
	if code != 200 {
		t.Fatalf("补邮箱：%d %v", code, res)
	}
	// 4 个 Slack 身份都查；林原补上，周宇一致（大小写不同）跳过，陈晨不同列进差异不改，外人不在工作区跳过
	if res["checked"] != 4.0 || res["filled"] != 1.0 || res["skipped"] != 2.0 || res["missing_scope"] != false {
		t.Fatalf("结果：%v", res)
	}
	conf := res["conflicts"].([]any)
	if len(conf) != 1 || conf[0].(map[string]any)["current"] != "chen@old.com" || conf[0].(map[string]any)["found"] != "chen@acme.com" {
		t.Fatalf("差异：%v", conf)
	}
	if e.email(t, "stk_lin") != "lin@acme.com" || e.email(t, "stk_chen") != "chen@old.com" || e.email(t, "stk_zhou") != "Zhou@Acme.com" {
		t.Fatalf("写入不对：%s %s %s", e.email(t, "stk_lin"), e.email(t, "stk_chen"), e.email(t, "stk_zhou"))
	}
	// 写入带操作者和审计
	var actor, detail string
	if err := e.st.DB().R.QueryRow(`SELECT actor, detail FROM audits WHERE target_type = 'stakeholder' AND target_id = 'stk_lin'`).Scan(&actor, &detail); err != nil {
		t.Fatalf("审计：%v", err)
	}
	if actor != "im#email_backfill" || !strings.Contains(detail, "idn_lin") {
		t.Fatalf("审计：%s %s", actor, detail)
	}
	// 再点一次：已有的不覆盖，林原这回一致
	_, res = backfill(t, e.h, c.ID)
	if res["filled"] != 0.0 || len(res["conflicts"].([]any)) != 1 {
		t.Fatalf("再点一次：%v", res)
	}
}

func TestEmailBackfillMissingScope(t *testing.T) {
	e := setupMail(t)
	c := e.connect(t)

	// 响应头写明没有 users:read.email：不调 users.info，200 带提示
	e.fake.scopes = "chat:write,users:read"
	code, res := backfill(t, e.h, c.ID)
	if code != 200 || res["missing_scope"] != true || !strings.Contains(res["hint"].(string), "users:read.email") || res["filled"] != 0.0 {
		t.Fatalf("缺 scope：%d %v", code, res)
	}
	if e.fake.infoCalls != 0 {
		t.Fatalf("缺 scope 不该调 users.info，调了 %d 次", e.fake.infoCalls)
	}

	// 没有 scope 头时：查到的人都没有邮箱，当缺权限
	e.fake.scopes = ""
	e.fake.noEmail = true
	_, res = backfill(t, e.h, c.ID)
	if res["missing_scope"] != true || e.email(t, "stk_lin") != "" {
		t.Fatalf("资料里没邮箱：%v", res)
	}

	// 连 users:read 都没有：Slack 回 missing_scope，提示两个一起加
	e.fake.noUsers = true
	_, res = backfill(t, e.h, c.ID)
	if res["missing_scope"] != true || !strings.Contains(res["hint"].(string), "users:read 和 users:read.email") {
		t.Fatalf("缺 users:read：%v", res)
	}

	// 加上权限后再点一次就能补
	e.fake.noUsers, e.fake.noEmail = false, false
	e.fake.scopes = "users:read,users:read.email"
	_, res = backfill(t, e.h, c.ID)
	if res["missing_scope"] != false || res["filled"] != 1.0 || e.email(t, "stk_lin") != "lin@acme.com" {
		t.Fatalf("加权限后：%v", res)
	}
}

func TestEmailBackfillErrors(t *testing.T) {
	e := setupMail(t)
	if code, _ := backfill(t, e.h, "conn_none"); code != 404 {
		t.Fatalf("没有的连接器：%d", code)
	}
	c := e.connect(t)
	e.fake.setRevoked(true)
	if code, out := backfill(t, e.h, c.ID); code != 502 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "补邮箱失败") {
		t.Fatalf("Token 失效：%d %v", code, out)
	}
}

// 后台顺带补：只查邮箱为空的，查过的一天内不再查；收消息时查名字顺手记下的邮箱直接用，不另调 users.info。
func TestEmailBackfillAuto(t *testing.T) {
	e := setupMail(t)
	e.fake.scopes = "users:read,users:read.email"
	c := e.connect(t)
	e.sl.mail.remember("U04LIN", "lin@acme.com")
	f := newEmailFiller(&inbox{c: e.sl.core(), adapters: []Adapter{e.sl}})
	if err := f.job(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	// 林原用缓存补上；外人查了不在工作区；周宇、陈晨已有邮箱不查
	if e.email(t, "stk_lin") != "lin@acme.com" || e.fake.infoCalls != 1 {
		t.Fatalf("自动补：%s，users.info %d 次", e.email(t, "stk_lin"), e.fake.infoCalls)
	}
	if err := f.job(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if e.fake.infoCalls != 1 {
		t.Fatalf("查过的不该再查，users.info %d 次", e.fake.infoCalls)
	}
	// 新登记的身份下一轮查到
	exec(t, e.st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_new', '新人', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_new', 'stk_new', 'slack', 'U06NEW', 'x', 'x')`)
	e.fake.mu.Lock()
	e.fake.emails["U06NEW"] = "new@acme.com"
	e.fake.mu.Unlock()
	if err := f.job(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if e.email(t, "stk_new") != "new@acme.com" {
		t.Fatalf("新身份没补上：%q", e.email(t, "stk_new"))
	}
	// 暂停的实例不查
	off := false
	if _, err := e.conns.Update(context.Background(), c.ID, connector.Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	n := e.fake.infoCalls
	exec(t, e.st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_new2', '新人二', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_new2', 'stk_new2', 'slack', 'U06NEW2', 'x', 'x')`)
	_ = f.job(context.Background(), nil)
	if e.fake.infoCalls != n {
		t.Fatal("暂停的实例不该查")
	}
}

// 被限流时停下：查到的照补，剩下的记进 pending，再点一次接着查
func TestEmailBackfillRateLimited(t *testing.T) {
	e := setupMail(t)
	e.fake.scopes = "users:read,users:read.email"
	e.fake.limitAt = 1
	c := e.connect(t)
	// 身份按编号排：U04LIN、U05CHEN、U09ZHOU、U99OUT；只查到第一个
	code, res := backfill(t, e.h, c.ID)
	if code != 200 || res["filled"] != 1.0 || res["pending"] != 3.0 || e.email(t, "stk_lin") != "lin@acme.com" {
		t.Fatalf("限流：%d %v", code, res)
	}
	e.fake.limitAt = 0
	_, res = backfill(t, e.h, c.ID)
	if res["pending"] != 0.0 || len(res["conflicts"].([]any)) != 1 {
		t.Fatalf("再点一次：%v", res)
	}
}
