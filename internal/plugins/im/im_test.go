package im

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "im" || m.TablePrefix != "im_" || len(m.Emits) != 1 || m.Emits[0] != EventReceived {
		t.Fatalf("id=%s table_prefix=%s emits=%v", m.ID, m.TablePrefix, m.Emits)
	}
	for _, id := range plugin.ReservedIDs {
		if id == "im" {
			t.Fatal("im 是内核保留 id")
		}
	}
}

func TestMigrationsEmbedded(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 || New().Migrations() == nil {
		t.Fatalf("migrations/ 里有 %d 条迁移，Migrations() 要能取到", len(files))
	}
	if _, err := os.Stat("migrations"); err != nil {
		t.Fatalf("迁移目录要在：%v", err)
	}
}

// watcher 是订阅 im.message_received 的测试插件，记下收到的事件。
type watcher struct {
	mu  sync.Mutex
	got []Received
}

var watcherManifest = []byte(`{
  "id": "imwatch", "name": "消息订阅（测试）", "description": "", "version": "0.1.0", "core": ">=1.0.0 <2.0.0",
  "depends": {"im": ">=0.1.0 <1.0.0"}, "optional_depends": {},
  "provides": {"modules": [], "settings": [], "object_types": [], "connectors": [], "skills": [], "agent_tools": [],
    "sop_nodes": [], "today_cards": [], "commands": [], "search": []},
  "emits": [], "subscribes": ["im.message_received"], "permissions": [], "migrations": "migrations", "table_prefix": "imwatch_"
}`)

func (w *watcher) Manifest() plugin.Manifest { return plugin.MustParse(watcherManifest) }
func (w *watcher) Migrations() fs.FS         { return nil }
func (w *watcher) Register(r plugin.Registrar) error {
	r.Subscribe(EventReceived, func(_ context.Context, _ plugin.Core, e plugin.Event) error {
		var p Received
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return err
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		w.got = append(w.got, p)
		return nil
	})
	return nil
}

func (w *watcher) events() []Received {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]Received(nil), w.got...)
}

type env struct {
	r     *plugin.Registry
	h     http.Handler
	d     *db.DB
	bus   *events.Bus
	fake  *Fake
	watch *watcher
}

// 在真库上装好 im 插件和订阅它事件的测试插件，灌一个联系人、一个身份、一个会话
func setup(t *testing.T) env {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), log)
	r.Migrations = plugin.NewSQLMigrationStore(d)
	bus := events.New(r, log)
	r.Events = bus
	e := env{r: r, d: d, bus: bus, fake: NewFake("fake", "slack", 10*time.Millisecond, "Broleez"), watch: &watcher{}}
	if err := r.Add(New(e.fake)); err != nil {
		t.Fatal(err)
	}
	if err := r.Add(e.watch); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, id := range []string{"im", "imwatch"} {
		if err := r.Install(ctx, id, nil); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	e.h = mux
	exec(t, d,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_lin', '林原', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_lin', 'stk_lin', 'slack', 'U04LIN', 'x', 'x')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_prod', 'slack', 'C01', 'group', '#product', 'x', 'x')`,
	)
	return e
}

func exec(t *testing.T, d *db.DB, qs ...string) {
	t.Helper()
	for _, q := range qs {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
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

// list 取列表，按消息编号索引
func list(t *testing.T, h http.Handler, query string) (int, map[string]map[string]any) {
	t.Helper()
	code, out := call(t, h, "GET", "/api/im/messages"+query, "")
	if code != 200 {
		t.Fatalf("列表 %s：%d %v", query, code, out)
	}
	byExt := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		byExt[m["external_id"].(string)] = m
	}
	if total := int(out["meta"].(map[string]any)["total"].(float64)); total != len(byExt) {
		t.Fatalf("total %d 和条数 %d 不一致", total, len(byExt))
	}
	return len(byExt), byExt
}

const batch = `{"messages":[
  {"external_id":"C01:1","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"Lin Yuan",
   "text":"@Broleez 权限点清单整理了一版","at":"2026-10-29T01:00:00Z",
   "attachments":[{"id":"att1","name":"权限点清单.xlsx","kind":"file","size":48213}]},
  {"external_id":"D09:1","conversation_id":"D09","conversation_kind":"direct","sender_id":"U09ZHOU","sender_name":"Zhou Yu",
   "text":"预发好了","at":"2026-10-29T01:01:00Z"},
  {"external_id":"C99:1","conversation_id":"C99","conversation_name":"#ops","sender_id":"U04LIN","sender_name":"Lin Yuan",
   "text":"@here 发版，@我们 别动","at":"2026-10-29T01:02:00Z"}
]}`

func TestCallbackResolvesAndFilters(t *testing.T) {
	e := setup(t)
	code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", batch)
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 3 {
		t.Fatalf("回调：%d %v", code, out)
	}

	n, got := list(t, e.h, "")
	if n != 3 {
		t.Fatalf("应有 3 条：%d", n)
	}
	m := got["C01:1"]
	if m["identity_id"] != "idn_lin" || m["stakeholder_id"] != "stk_lin" || m["contact_name"] != "林原" {
		t.Fatalf("发送人应按 IM 身份认到林原：%v", m)
	}
	if m["conversation_id"] != "cv_prod" || m["conversation"] != "#product" || m["relevance"] != "me" || m["status"] != "pending" || m["read"] != false {
		t.Fatalf("会话应按编号认到 cv_prod，@我：%v", m)
	}
	if a := m["attachments"].([]any); len(a) != 1 {
		t.Fatalf("附件原样存：%v", m["attachments"])
	}
	if dm := got["D09:1"]; dm["relevance"] != "dm" || dm["identity_id"] != nil || dm["conversation_id"] != nil || dm["conversation"] != "" {
		t.Fatalf("没登记的私聊：%v", dm)
	}
	if ops := got["C99:1"]; ops["relevance"] != "all" || ops["conversation_id"] != nil || ops["conversation"] != "#ops" || ops["identity_id"] != "idn_lin" {
		t.Fatalf("没登记的群、@所有人：%v", ops)
	}
	// 按时间倒序
	_, raw := call(t, e.h, "GET", "/api/im/messages", "")
	if first := raw["data"].([]any)[0].(map[string]any); first["external_id"] != "C99:1" {
		t.Fatalf("最新的在前：%v", first["external_id"])
	}

	// 重复到达去重
	if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", batch); code != 200 || out["data"].(map[string]any)["duplicates"] != 3.0 {
		t.Fatalf("重复回调：%d %v", code, out)
	}

	// 筛选
	for q, want := range map[string]int{
		"?status=pending": 3, "?status=done": 0, "?channel=slack": 3, "?channel=Slack": 3, "?channel=lark": 0,
		"?conversation_id=cv_prod": 1, "?mine=any": 3, "?mine=at": 1, "?unread=true": 3,
		"?mine=any&conversation_id=cv_prod": 1, "?limit=2": 2,
	} {
		if q == "?limit=2" {
			_, out := call(t, e.h, "GET", "/api/im/messages"+q, "")
			if len(out["data"].([]any)) != want || out["meta"].(map[string]any)["total"] != 3.0 {
				t.Errorf("%s：%v", q, out["meta"])
			}
			continue
		}
		if n, _ := list(t, e.h, q); n != want {
			t.Errorf("%s 应 %d 条，实际 %d", q, want, n)
		}
	}
	for _, q := range []string{"?status=snoozed", "?mine=me", "?conversation_id=cv_none", "?limit=0", "?unread=no"} {
		if code, _ := call(t, e.h, "GET", "/api/im/messages"+q, ""); code != 400 {
			t.Errorf("%s 应 400：%d", q, code)
		}
	}

	// 事件：每条新消息一次，重复到达不再发
	e.bus.Wait(time.Second)
	evs := e.watch.events()
	if len(evs) != 3 {
		t.Fatalf("订阅者应收到 3 条事件：%v", evs)
	}
	ids := map[string]Received{}
	for _, ev := range evs {
		ids[ev.MessageID] = ev
	}
	found := false
	for _, ev := range ids {
		if ev.IdentityID != nil && *ev.IdentityID == "idn_lin" && ev.ConversationID != nil && *ev.ConversationID == "cv_prod" {
			found = ev.Relevance == "me" && ev.Channel == "slack" && *ev.StakeholderID == "stk_lin"
		}
	}
	if !found || len(ids) != 3 {
		t.Fatalf("事件 payload 带身份和会话 id：%v", evs)
	}

	// 后登记的身份和会话，读的时候按编号补认；改群名后显示新名字
	exec(t, e.d,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_zhou', '周宇', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_zhou', 'stk_zhou', 'slack', 'U09ZHOU', 'x', 'x')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_ops', 'slack', 'C99', 'group', '#ops-new', 'x', 'x')`,
		`UPDATE conversations SET name = '#product-v2' WHERE id = 'cv_prod'`,
	)
	_, got = list(t, e.h, "")
	if dm := got["D09:1"]; dm["identity_id"] != "idn_zhou" || dm["contact_name"] != "周宇" {
		t.Fatalf("补认发送人：%v", dm)
	}
	if ops := got["C99:1"]; ops["conversation_id"] != "cv_ops" || ops["conversation"] != "#ops-new" {
		t.Fatalf("补认会话：%v", ops)
	}
	if got["C01:1"]["conversation"] != "#product-v2" {
		t.Fatalf("改群名不断：%v", got["C01:1"])
	}
	if n, got := list(t, e.h, "?conversation_id=cv_ops"); n != 1 || got["C99:1"] == nil {
		t.Fatalf("按会话筛时算上到达时没认上的：%d", n)
	}

	// 删身份：消息保留，id 置空
	exec(t, e.d, `DELETE FROM contact_identities WHERE id = 'idn_lin'`)
	if _, got := list(t, e.h, ""); got["C01:1"]["identity_id"] != nil || got["C01:1"]["sender_id"] != "U04LIN" {
		t.Fatalf("删身份后：%v", got["C01:1"])
	}
}

func TestCallbackRejectsBadBatch(t *testing.T) {
	e := setup(t)
	for _, body := range []string{
		`{"messages":[{"external_id":"1","sender_id":"U1"},{"external_id":"2"}]}`,
		`{"messages":[{"external_id":"1","sender_id":"U1","conversation_kind":"channel"}]}`,
		`{"messages":[{"external_id":"1","sender_id":"U1","mention":"you"}]}`,
		`{"messages":[{"external_id":"1","sender_id":"U1","attachments":{"a":1}}]}`,
		`not json`,
	} {
		if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", body); code != 400 {
			t.Errorf("%s 应 400：%d %v", body, code, out)
		}
	}
	if n, _ := list(t, e.h, ""); n != 0 {
		t.Fatalf("不合法的整批不落库：%d", n)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/callbacks/nope", `{"messages":[]}`); code != 404 {
		t.Fatalf("没有这个适配器应 404：%d", code)
	}
}

func TestPullAndDisable(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	e.fake.Push(Incoming{ExternalID: "C01:9", ConversationID: "C01", ConversationName: "#product", SenderID: "U04LIN", Text: "拉取来的"},
		Incoming{ExternalID: "bad"}) // 拉取时不合法的跳过，不卡进度
	deadline := time.Now().Add(3 * time.Second)
	for {
		// 后台任务在写，count 和列表之间可能差一条，列表里有了再细看
		if _, out := call(t, e.h, "GET", "/api/im/messages", ""); len(out["data"].([]any)) > 0 {
			_, got := list(t, e.h, "")
			if m := got["C01:9"]; m["identity_id"] != "idn_lin" || m["conversation_id"] != "cv_prod" {
				t.Fatalf("拉取的消息也认人认会话：%v", got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("等不到拉取的消息")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var cursor string
	for time.Now().Before(deadline) {
		_ = e.d.R.QueryRow(`SELECT cursor FROM im_cursors WHERE adapter = 'fake'`).Scan(&cursor)
		if cursor == "2" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if cursor != "2" {
		t.Fatalf("进度：%q", cursor)
	}
	if code, out := call(t, e.h, "GET", "/api/im/adapters", ""); code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("适配器列表：%d %v", code, out)
	}

	// 停用后接口 404，拉取停下；启用后恢复
	if err := e.r.Disable(ctx, "imwatch"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Disable(ctx, "im"); err != nil {
		t.Fatal(err)
	}
	for _, rt := range [][2]string{{"GET", "/api/im/messages"}, {"GET", "/api/im/adapters"}, {"POST", "/api/im/callbacks/fake"}} {
		if code, _ := call(t, e.h, rt[0], rt[1], `{"messages":[]}`); code != 404 {
			t.Errorf("停用后 %s %s 应 404：%d", rt[0], rt[1], code)
		}
	}
	pulls := e.fake.Pulls()
	time.Sleep(50 * time.Millisecond)
	if e.fake.Pulls() != pulls {
		t.Fatal("停用后不该再拉")
	}
	if err := e.r.Enable(ctx, "im"); err != nil {
		t.Fatal(err)
	}
	if n, _ := list(t, e.h, ""); n != 1 {
		t.Fatalf("重新启用后数据还在：%d", n)
	}
}

func TestRelevance(t *testing.T) {
	self := []string{"Broleez", "我"}
	for _, c := range []struct {
		mention, text, kind, want string
	}{
		{"", "@broleez, 看下", "group", "me"},
		{"", "@我 看下", "group", "me"},
		{"", "@我们 看下", "group", ""},
		{"", "@Broleez2 看下", "group", ""},
		{"", "@所有人 @我 看下", "group", "me"},
		{"", "@所有人 开会", "group", "all"},
		{"", "末尾 @here", "group", "all"},
		{"", "随便说说", "direct", "dm"},
		{"me", "随便说说", "group", "me"},
		{"all", "随便说说", "direct", "all"},
		{"", "email a@b.com", "group", ""},
	} {
		if got := relevance(c.mention, c.text, self, c.kind); got != c.want {
			t.Errorf("%q %q %s：%q，应为 %q", c.mention, c.text, c.kind, got, c.want)
		}
	}
}
