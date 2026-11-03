package domains

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
)

// 测试里的原型是测试二进制自己：带上这个环境变量起来时只当一个假原型，听 PORT，/ 回一行字，/ws 是回声 WebSocket。
const protoHelperEnv = "PMW_DOMAINS_PROTO_HELPER"

func TestMain(m *testing.M) {
	if os.Getenv(protoHelperEnv) == "1" {
		serveFakeProto()
		return
	}
	os.Exit(m.Run())
}

func echoMux(name string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		for {
			typ, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, append([]byte("echo:"), b...)); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "hello from %s, host=%s, xfh=%s", name, r.Host, r.Header.Get("X-Forwarded-Host"))
	})
	return mux
}

func serveFakeProto() {
	l, err := net.Listen("tcp", "127.0.0.1:"+os.Getenv("PORT"))
	if err != nil {
		os.Exit(2)
	}
	_ = http.Serve(l, echoMux("proto"))
}

type stack struct {
	r   *plugin.Registry
	bus *events.Bus
	api http.Handler // 只有插件路由
	srv *httptest.Server
}

// setupStack 装好项目和内网域名两个插件、接上事件总线，外面包一层 HostDispatch，起一个真的监听（WebSocket 要 Hijack）。
func setupStack(t *testing.T) *stack {
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
	if err := r.Add(projects.New()); err != nil {
		t.Fatal(err)
	}
	if err := r.Add(newPlugin(newFakeSys(t))); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bus.Wait(5 * time.Second) })
	t.Cleanup(r.Close)
	for id, perms := range map[string][]string{"projects": {"process:spawn"}, "domains": {"fs:read:any", "process:spawn", "network:localhost"}} {
		if err := r.Install(ctx, id, perms); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p1', 'project', 'PRJ-T1', '项目一', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "workbench") })
	srv := httptest.NewServer(r.HostDispatch(mux, "https://bro.vip"))
	t.Cleanup(srv.Close)
	return &stack{r: r, bus: bus, api: mux, srv: srv}
}

// get 经真监听带 Host 头请求，回状态码和正文。
func (s *stack) get(t *testing.T, host, path string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, s.srv.URL+path, nil)
	req.Host = host
	res, err := s.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("等不到：%s", what)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func routeList(t *testing.T, h http.Handler) []map[string]any {
	t.Helper()
	_, out := call(t, h, "GET", "/api/domains/routes", "")
	var rows []map[string]any
	for _, x := range out["data"].([]any) {
		rows = append(rows, x.(map[string]any))
	}
	return rows
}

func routeFor(t *testing.T, h http.Handler, protoID string) map[string]any {
	t.Helper()
	for _, rt := range routeList(t, h) {
		if tg := rt["target"].(map[string]any); tg["kind"] == "proto" && tg["proto_id"] == protoID {
			return rt
		}
	}
	return nil
}

// TestPrototypeDomainEndToEnd：原型启动后自动分配域名、经内置代理拿到原型内容、WebSocket 照转；
// 停止后回 502 中文说明页；删除后自动路由也没了；工作台自己的域名照常进工作台。
func TestPrototypeDomainEndToEnd(t *testing.T) {
	t.Setenv(protoHelperEnv, "1") // 原型进程继承环境变量，起来就是假原型
	s := setupStack(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	base := "/api/projects/obj_p1/prototypes"
	body, _ := json.Marshal(map[string]any{"name": "Demo Site", "dir": t.TempDir(), "port": port, "argv": []string{exe}})
	code, out := call(t, s.api, "POST", base, string(body))
	if code != 201 {
		t.Fatalf("新建原型：%d %v", code, out)
	}
	id := out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, s.api, "POST", base+"/"+id+"/start", ""); code != 200 {
		t.Fatalf("启动原型：%d %v", code, out)
	}
	waitUntil(t, "原型在运行", func() bool {
		_, out := call(t, s.api, "GET", base+"/"+id, "")
		return out["data"].(map[string]any)["status"] == "running"
	})
	waitUntil(t, "自动路由", func() bool { return routeFor(t, s.api, id) != nil })
	rt := routeFor(t, s.api, id)
	if rt["host"] != "demo-site" || rt["fqdn"] != "demo-site.bro.vip" || rt["auto"] != true || rt["enabled"] != true ||
		!strings.Contains(rt["note"].(string), "项目一 / Demo Site") {
		t.Fatalf("自动路由：%v", rt)
	}

	// 经代理拿到原型内容；上游看到的 Host 是本机地址，原来的域名在 X-Forwarded-Host
	code, text := s.get(t, "demo-site.bro.vip", "/")
	if code != 200 || !strings.Contains(text, "hello from proto") || !strings.Contains(text, "xfh=demo-site.bro.vip") ||
		!strings.Contains(text, fmt.Sprintf("host=127.0.0.1:%d", port)) {
		t.Fatalf("经代理：%d %s", code, text)
	}
	if code, text := s.get(t, "DEMO-SITE.bro.vip:443", "/x"); code != 200 || !strings.Contains(text, "hello from proto") {
		t.Fatalf("大写带端口：%d %s", code, text)
	}

	// WebSocket 照转
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, strings.Replace(s.srv.URL, "http://", "ws://", 1)+"/ws", &websocket.DialOptions{Host: "demo-site.bro.vip"})
	if err != nil {
		t.Fatalf("经代理连 WebSocket：%v", err)
	}
	if err := c.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	if _, b, err := c.Read(ctx); err != nil || string(b) != "echo:ping" {
		t.Fatalf("WebSocket 回声：%q %v", b, err)
	}
	_ = c.Close(websocket.StatusNormalClosure, "")

	// 工作台自己的域名、IP、别名照常进工作台，插件接口也照常
	for _, host := range []string{"bro.vip", "broleez.vip", "127.0.0.1", "localhost:7777", "nope.bro.vip"} {
		if code, text := s.get(t, host, "/"); code != 200 || text != "workbench" {
			t.Fatalf("Host %s：%d %s", host, code, text)
		}
	}
	if code, text := s.get(t, "bro.vip", "/api/domains/settings"); code != 200 || !strings.Contains(text, `"suffix":"bro.vip"`) {
		t.Fatalf("工作台接口：%d %s", code, text)
	}

	// 生成的内置代理配置写上原型的上游
	_, out = call(t, s.api, "GET", "/api/domains/config?proxy=builtin", "")
	if pc := out["data"].(map[string]any)["proxy_config"].(map[string]any)["content"].(string); !strings.Contains(pc, fmt.Sprintf("demo-site.bro.vip  ->  http://127.0.0.1:%d", port)) {
		t.Fatalf("代理配置：%s", pc)
	}

	// 停止：同一请求回 502 中文说明页，路由还在
	if code, _ := call(t, s.api, "POST", base+"/"+id+"/stop", ""); code != 200 {
		t.Fatalf("停止：%d", code)
	}
	waitUntil(t, "停止后 502", func() bool {
		code, text := s.get(t, "demo-site.bro.vip", "/")
		return code == http.StatusBadGateway && strings.Contains(text, "原型没在运行")
	})
	if routeFor(t, s.api, id) == nil {
		t.Fatal("停止后自动路由不该删")
	}

	// 删除：自动路由跟着删
	if code, _ := call(t, s.api, "DELETE", base+"/"+id, ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	waitUntil(t, "删除后自动路由没了", func() bool { return routeFor(t, s.api, id) == nil })
	waitUntil(t, "删除后不再转发", func() bool {
		code, text := s.get(t, "demo-site.bro.vip", "/")
		return code == 200 && text == "workbench"
	})
}

// TestAutoRouteRules：中文名用 proto-<端口>，重名接 -<端口>；auto_proto 关着不建；已有手动路由不另建；
// 删除原型只删自动的，手动的留着；晚到的启动事件不复活已删的原型；关掉 auto_proto 删掉全部自动路由。
func TestAutoRouteRules(t *testing.T) {
	s := setupStack(t)
	ctx := context.Background()
	at := time.Now().UTC()
	pub := func(typ, id, name string, port int, d time.Duration) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"id": id, "name": name, "project_id": "obj_p1", "project_name": "项目一", "port": port})
		for _, sub := range s.r.Subscribers(typ) {
			if err := sub.Handle(ctx, plugin.Event{Type: typ, At: at.Add(d), Payload: b}); err != nil {
				t.Fatal(err)
			}
		}
	}
	hostOf := func(id string) string {
		if rt := routeFor(t, s.api, id); rt != nil {
			return rt["host"].(string)
		}
		return ""
	}
	pub(evStarted, "pt_a", "状态看板", 5173, 0)
	pub(evStarted, "pt_b", "App", 5174, 0)
	pub(evStarted, "pt_c", "app", 5175, 0)
	if hostOf("pt_a") != "proto-5173" || hostOf("pt_b") != "app" || hostOf("pt_c") != "app-5175" {
		t.Fatalf("子域名：%q %q %q", hostOf("pt_a"), hostOf("pt_b"), hostOf("pt_c"))
	}
	// 再启动一次不重复建
	pub(evStarted, "pt_b", "App", 5174, time.Second)
	if n := len(routeList(t, s.api)); n != 4 {
		t.Fatalf("重复建了：%d 条", n)
	}

	// 手动指向原型的路由：不另建，删原型时留着；停用的路由不转发
	data(t, s.api, "POST", "/api/domains/routes", `{"host":"manual","target":{"kind":"proto","proto_id":"pt_m"}}`)
	pub(evStarted, "pt_m", "Manual", 5176, 0)
	if hostOf("pt_m") != "manual" {
		t.Fatalf("手动路由被换掉了：%q", hostOf("pt_m"))
	}
	pub(evDeleted, "pt_m", "Manual", 5176, time.Second)
	if hostOf("pt_m") != "manual" {
		t.Fatal("手动路由不该跟着删")
	}

	// 删除后晚到的启动事件不复活
	pub(evDeleted, "pt_c", "app", 5175, 2*time.Second)
	pub(evStarted, "pt_c", "app", 5175, time.Second)
	if hostOf("pt_c") != "" {
		t.Fatal("晚到的启动事件复活了已删的原型")
	}

	// 自动建的改过就转成手动，关掉自动分配时留着
	data(t, s.api, "PATCH", "/api/domains/routes/"+routeFor(t, s.api, "pt_b")["id"].(string), `{"note":"改过"}`)

	// 关掉 auto_proto：删掉全部自动路由，手动的留着，原来的自动域名回到工作台；关着不建；打开时给在跑的补上
	data(t, s.api, "PUT", "/api/domains/settings", `{"auto_proto":false}`)
	for _, rt := range routeList(t, s.api) {
		if rt["auto"] == true {
			t.Fatalf("关掉后还有自动路由：%v", rt["host"])
		}
	}
	if hostOf("pt_a") != "" || hostOf("pt_b") != "app" || hostOf("pt_m") != "manual" {
		t.Fatalf("关掉后：%q %q %q", hostOf("pt_a"), hostOf("pt_b"), hostOf("pt_m"))
	}
	if code, text := s.get(t, "proto-5173.bro.vip", "/"); code != 200 || text != "workbench" {
		t.Fatalf("关掉后原来的自动域名：%d %s", code, text)
	}
	pub(evStarted, "pt_d", "Docs", 5177, 0)
	if hostOf("pt_d") != "" {
		t.Fatal("auto_proto 关着也建了")
	}
	data(t, s.api, "PUT", "/api/domains/settings", `{"auto_proto":true}`)
	if hostOf("pt_d") != "docs" || hostOf("pt_a") != "proto-5173" || hostOf("pt_b") != "app" {
		t.Fatalf("打开后没补上：%q %q %q", hostOf("pt_d"), hostOf("pt_a"), hostOf("pt_b"))
	}
	if rt := routeFor(t, s.api, "pt_a"); rt["auto"] != true {
		t.Fatal("重新建的应该是自动路由")
	}

	// 在跑但端口上没人听：502 连不上；总开关关了就不接，进工作台
	if code, text := s.get(t, "docs.bro.vip", "/"); code != http.StatusBadGateway || !strings.Contains(text, "连不上") {
		t.Fatalf("连不上：%d %s", code, text)
	}
	data(t, s.api, "PUT", "/api/domains/settings", `{"enabled":false}`)
	if code, text := s.get(t, "docs.bro.vip", "/"); code != 200 || text != "workbench" {
		t.Fatalf("总开关关了：%d %s", code, text)
	}
}

// TestProxyURLTargets：地址目标是本机的照转（WebSocket 也行），外部地址不转、回 502。
func TestProxyURLTargets(t *testing.T) {
	s := setupStack(t)
	up := httptest.NewServer(echoMux("upstream"))
	defer up.Close()
	data(t, s.api, "POST", "/api/domains/routes", fmt.Sprintf(`{"host":"local","target":{"kind":"url","url":%q}}`, up.URL))
	data(t, s.api, "POST", "/api/domains/routes", `{"host":"outside","target":{"kind":"url","url":"https://example.com"}}`)
	if code, text := s.get(t, "local.bro.vip", "/"); code != 200 || !strings.Contains(text, "hello from upstream") {
		t.Fatalf("本机地址：%d %s", code, text)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, strings.Replace(s.srv.URL, "http://", "ws://", 1)+"/ws", &websocket.DialOptions{Host: "local.bro.vip"})
	if err != nil {
		t.Fatalf("WebSocket：%v", err)
	}
	_ = c.Write(ctx, websocket.MessageText, []byte("hi"))
	if _, b, err := c.Read(ctx); err != nil || string(b) != "echo:hi" {
		t.Fatalf("WebSocket 回声：%q %v", b, err)
	}
	_ = c.Close(websocket.StatusNormalClosure, "")
	if code, text := s.get(t, "outside.bro.vip", "/"); code != http.StatusBadGateway || !strings.Contains(text, "不转发到外部地址") {
		t.Fatalf("外部地址：%d %s", code, text)
	}
}

func TestSlugHost(t *testing.T) {
	for in, want := range map[string]string{
		"Demo Site":     "demo-site",
		"状态看板":          "proto-5173",
		"--Admin__UI--": "admin-ui",
		"a":             "proto-5173",
		"Web 前端 v2":     "web-v2",
	} {
		if got := slugHost(in, 5173); got != want || !validHost(got) {
			t.Errorf("slugHost(%q) = %q，应为 %q", in, got, want)
		}
	}
	if got := slugHost(strings.Repeat("abc-", 30), 1); len(got) > 50 || !validHost(got) {
		t.Errorf("长名字：%q", got)
	}
}
