package terminal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
)

// setup 起项目和终端两个插件，终端用 /bin/sh、不读启动文件，提示符固定成 "$ "
func setup(t *testing.T) (*plugin.Registry, *httptest.Server) {
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
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	p := New("https://bro.vip")
	p.shell, p.shellArgs, p.env = "/bin/sh", []string{}, []string{"PS1=$ ", "ENV=", "HISTFILE=/dev/null"}
	for _, pl := range []plugin.Plugin{projects.New(), p} {
		if err := r.Add(pl); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, id := range []string{"projects", "terminal"} {
		if err := r.Install(ctx, id, []string{"process:spawn"}); err != nil {
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
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return r, srv
}

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func create(t *testing.T, srv *httptest.Server, body string) map[string]any {
	t.Helper()
	code, out := call(t, srv, "POST", "/api/terminal/sessions", body)
	if code != 201 {
		t.Fatalf("新建会话：%d %v", code, out)
	}
	return out["data"].(map[string]any)
}

// term 是测试里的一条 WebSocket 连接，输出攒在 out 里
type term struct {
	t    *testing.T
	c    *websocket.Conn
	out  bytes.Buffer
	ctls []map[string]any
}

func dial(t *testing.T, srv *httptest.Server, id, origin string) (*term, *http.Response, error) {
	t.Helper()
	opts := &websocket.DialOptions{HTTPHeader: http.Header{}}
	if origin != "" {
		opts.HTTPHeader.Set("Origin", origin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, query, _ := strings.Cut(id, "?")
	if query != "" {
		query = "?" + query
	}
	c, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/terminal/sessions/"+id+"/ws"+query, opts)
	if err != nil {
		return nil, res, err
	}
	tm := &term{t: t, c: c}
	t.Cleanup(func() { _ = c.CloseNow() })
	return tm, res, nil
}

func (tm *term) send(s string) {
	tm.t.Helper()
	if err := tm.c.Write(context.Background(), websocket.MessageBinary, []byte(s)); err != nil {
		tm.t.Fatal(err)
	}
}

func (tm *term) ctl(v any) {
	tm.t.Helper()
	b, _ := json.Marshal(v)
	if err := tm.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		tm.t.Fatal(err)
	}
}

// waitFor 一直读，直到输出匹配 re，返回第一组匹配
func (tm *term) waitFor(re string) []string {
	tm.t.Helper()
	rx := regexp.MustCompile(re)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if m := rx.FindStringSubmatch(tm.out.String()); m != nil {
			return m
		}
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		typ, msg, err := tm.c.Read(ctx)
		cancel()
		if err != nil {
			tm.t.Fatalf("等 %q 没等到（%v），已收到：%q", re, err, tm.out.String())
		}
		if typ == websocket.MessageBinary {
			tm.out.Write(msg)
		} else {
			var m map[string]any
			_ = json.Unmarshal(msg, &m)
			tm.ctls = append(tm.ctls, m)
		}
	}
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func waitDead(t *testing.T, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for _, pid := range pids {
		for alive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("进程 %d 还在", pid)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
}

// startJobs 在会话里起一个后台作业和一个前台作业，返回 shell、后台、前台三个 pid
func startJobs(t *testing.T, tm *term, shellPID int) []int {
	t.Helper()
	tm.send("sleep 300 & echo BG=$!\n")
	bg, _ := strconv.Atoi(tm.waitFor(`BG=(\d+)`)[1])
	tm.send("sh -c 'echo FG=$$; exec sleep 301'\n")
	fg, _ := strconv.Atoi(tm.waitFor(`FG=(\d+)`)[1])
	pids := []int{shellPID, bg, fg}
	for _, pid := range pids {
		if !alive(pid) {
			t.Fatalf("进程 %d 没起来", pid)
		}
	}
	return pids
}

func TestTerminalSession(t *testing.T) {
	_, srv := setup(t)
	dir := t.TempDir()

	// 校验：cwd 要是存在的绝对目录，大小有范围
	for _, body := range []string{`{"cwd":"relative"}`, `{"cwd":"` + dir + `/nope"}`, `{"cwd":"` + dir + `","cols":0}`, `{"rows":5000}`, `{`} {
		if code, out := call(t, srv, "POST", "/api/terminal/sessions", body); code != 400 {
			t.Fatalf("%s 应 400：%d %v", body, code, out)
		}
	}
	s := create(t, srv, `{"cwd":"`+dir+`","cols":80,"rows":24}`)
	id := s["id"].(string)
	if !regexp.MustCompile(`^pn_[0-9a-f]{32}$`).MatchString(id) || s["status"] != "running" || s["pid"].(float64) <= 0 {
		t.Fatalf("新建返回：%v", s)
	}
	if code, out := call(t, srv, "GET", "/api/terminal/sessions", ""); code != 200 || out["meta"].(map[string]any)["total"] != 1.0 {
		t.Fatalf("列表：%d %v", code, out)
	}

	tm, _, err := dial(t, srv, id, "http://127.0.0.1:7780")
	if err != nil {
		t.Fatal(err)
	}
	tm.send("printf hi\n")
	tm.waitFor(`\r?\nhi`)
	tm.send("pwd\n")
	tm.waitFor(regexp.QuoteMeta(dir))
	tm.ctl(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	tm.send("stty size\n")
	tm.waitFor(`30 100`)
	if tm.ctls[0]["type"] != "replay" || tm.ctls[0]["from"] != 0.0 {
		t.Fatalf("第一条控制消息：%v", tm.ctls)
	}
	_ = tm.c.Close(websocket.StatusNormalClosure, "")

	// 重连：先补发断开前的输出
	tm2, _, err := dial(t, srv, id, "https://bro.vip")
	if err != nil {
		t.Fatal(err)
	}
	tm2.waitFor(`(?s)\nhi.*30 100`)
	// after 跳过已经看过的
	_, out := call(t, srv, "GET", "/api/terminal/sessions", "")
	total := int64(out["data"].([]any)[0].(map[string]any)["output_bytes"].(float64))
	tm3, _, err := dial(t, srv, id+"?after="+strconv.FormatInt(total, 10), "")
	if err != nil {
		t.Fatal(err)
	}
	tm3.send("echo again\n")
	tm3.waitFor(`\nagain`)
	if strings.Contains(tm3.out.String(), "30 100") || tm3.ctls[0]["from"] != float64(total) {
		t.Fatalf("after 之后不该补发旧输出：%q %v", tm3.out.String(), tm3.ctls)
	}

	// shell 自己退出：发 exit 控制消息后正常关闭，会话留着显示已退出
	tm3.send("exit 3\n")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		typ, msg, err := tm3.c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
				t.Fatalf("退出后的关闭：%v", err)
			}
			break
		}
		if typ == websocket.MessageText && strings.Contains(string(msg), `"exit"`) && !strings.Contains(string(msg), `"code":3`) {
			t.Fatalf("退出码：%s", msg)
		}
	}
	_, out = call(t, srv, "GET", "/api/terminal/sessions", "")
	if v := out["data"].([]any)[0].(map[string]any); v["status"] != "exited" || v["exit_code"] != 3.0 {
		t.Fatalf("退出后的会话：%v", v)
	}
	if code, _ := call(t, srv, "DELETE", "/api/terminal/sessions/"+id, ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	if code, _ := call(t, srv, "DELETE", "/api/terminal/sessions/"+id, ""); code != 404 {
		t.Fatalf("再删应 404：%d", code)
	}
}

func TestTerminalOrigin(t *testing.T) {
	_, srv := setup(t)
	id := create(t, srv, `{"cwd":"`+t.TempDir()+`"}`)["id"].(string)
	for _, origin := range []string{"http://evil.example", "https://bro.vip.evil.example", "http://bro.vip", "null", "file://"} {
		if _, res, err := dial(t, srv, id, origin); err == nil || res == nil || res.StatusCode != http.StatusForbidden {
			t.Fatalf("Origin %s 应被拒：%v %v", origin, err, res)
		}
	}
	for _, origin := range []string{"http://localhost:5173", "http://[::1]:7796", "https://bro.vip:443", "HTTPS://BRO.VIP"} {
		if _, _, err := dial(t, srv, id, origin); err != nil {
			t.Fatalf("Origin %s 应放行：%v", origin, err)
		}
	}
	if _, res, err := dial(t, srv, "pn_nope", ""); err == nil || res.StatusCode != 404 {
		t.Fatalf("不存在的会话应 404：%v", err)
	}
}

func TestTerminalDeleteKillsGroups(t *testing.T) {
	_, srv := setup(t)
	s := create(t, srv, `{"cwd":"`+t.TempDir()+`"}`)
	tm, _, err := dial(t, srv, s["id"].(string), "")
	if err != nil {
		t.Fatal(err)
	}
	pids := startJobs(t, tm, int(s["pid"].(float64)))
	if code, _ := call(t, srv, "DELETE", "/api/terminal/sessions/"+s["id"].(string), ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	waitDead(t, pids...)
	// 连接随会话结束关闭
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for err == nil {
		_, _, err = tm.c.Read(ctx)
	}
	if st := websocket.CloseStatus(err); st != websocket.StatusGoingAway && st != websocket.StatusNormalClosure {
		t.Fatalf("删会话后连接应关闭：%v", err)
	}
}

func TestTerminalDisableKillsGroups(t *testing.T) {
	r, srv := setup(t)
	var pids []int
	for range 2 {
		s := create(t, srv, `{"cwd":"`+t.TempDir()+`"}`)
		tm, _, err := dial(t, srv, s["id"].(string), "")
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, startJobs(t, tm, int(s["pid"].(float64)))...)
	}
	if err := r.Disable(context.Background(), "terminal"); err != nil {
		t.Fatal(err)
	}
	waitDead(t, pids...)
	if code, _ := call(t, srv, "GET", "/api/terminal/sessions", ""); code != 404 {
		t.Fatalf("停用后接口应 404：%d", code)
	}
	// 再启用是一个新的空 manager
	if err := r.Enable(context.Background(), "terminal"); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, srv, "GET", "/api/terminal/sessions", ""); code != 200 || out["meta"].(map[string]any)["total"] != 0.0 {
		t.Fatalf("重新启用后的列表：%d %v", code, out)
	}
}

func TestTerminalLimit(t *testing.T) {
	_, srv := setup(t)
	dir := t.TempDir()
	for range maxSessions {
		create(t, srv, `{"cwd":"`+dir+`"}`)
	}
	if code, out := call(t, srv, "POST", "/api/terminal/sessions", `{"cwd":"`+dir+`"}`); code != 409 {
		t.Fatalf("第 %d 个应 409：%d %v", maxSessions+1, code, out)
	}
}

func TestRing(t *testing.T) {
	s := &session{subs: map[*sub]struct{}{}}
	s.push(bytes.Repeat([]byte("a"), ringBytes-1))
	s.push([]byte("中文"))
	from, data, _ := s.attach(-1)
	if int64(len(data))+from != s.total || len(data) > ringBytes || !strings.HasSuffix(string(data), "中文") || data[0] != 'a' {
		t.Fatalf("环形缓冲：from=%d len=%d", from, len(data))
	}
	// 切口落在多字节字符中间时挪到下一个字符开头
	s2 := &session{subs: map[*sub]struct{}{}}
	s2.push([]byte("中"))
	s2.push(bytes.Repeat([]byte("b"), ringBytes-1))
	_, data, _ = s2.attach(0)
	if data[0] != 'b' {
		t.Fatalf("切口没对齐：%q", data[:4])
	}
}
