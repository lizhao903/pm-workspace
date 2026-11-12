// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// B 站组件（TSK-0455）的测试：网页端接口全部对接本机假服务端，不用任何真实账号。

const (
	fakeSESS    = "sessdata-test-only-7f3a9c"
	fakeJCT     = "bilijct-test-only-91c2e4"
	fakeRefresh = "refresh-test-only-55aa01"
	fakeQRKey   = "qrkey-test-0001"
	fakeMID     = 4242
)

// secretsUnderTest 是不许出现在日志、响应、通知、审计、库表里的凭证。
var secretsUnderTest = []string{fakeSESS, fakeJCT, fakeRefresh, biliGoodToken, biliAppSecret}

type fakeMsg struct {
	Sender  int64
	Text    string
	Seq     int64
	Key     int64
	TS      int64
	MsgType int
}

// fakeBiliWeb 是本机假的 B 站网页端：扫码登录、账号、数据、私信。
type fakeBiliWeb struct {
	t        *testing.T
	mu       sync.Mutex
	poll     int // 下一次轮询回的状态码
	riskN    int // 接下来几个请求回风控
	riskCode int
	captcha  bool
	expired  bool // 登录失效：要登录的接口回 -101
	calls    []string
	times    []time.Time
	uas      []string
	sent     []url.Values
	talkers  map[int64][]fakeMsg
	names    map[int64]string
	seq      int64
}

func newFakeBiliWeb(t *testing.T) *fakeBiliWeb {
	return &fakeBiliWeb{t: t, poll: biliQRWaiting, riskCode: -412, talkers: map[int64][]fakeMsg{}, names: map[int64]string{777: "热心观众", 888: "品牌方小王"}}
}

func (f *fakeBiliWeb) json(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeBiliWeb) ok(w http.ResponseWriter, data any) {
	f.json(w, map[string]any{"code": 0, "message": "0", "ttl": 1, "data": data})
}

// incoming 让 who 发来一条消息。
func (f *fakeBiliWeb) incoming(who int64, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	f.talkers[who] = append(f.talkers[who], fakeMsg{Sender: who, Text: text, Seq: f.seq, Key: 9000000 + f.seq, TS: time.Now().Unix(), MsgType: 1})
}

func (f *fakeBiliWeb) set(fn func(f *fakeBiliWeb)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeBiliWeb) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeBiliWeb) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	f.times = append(f.times, time.Now())
	f.uas = append(f.uas, r.Header.Get("User-Agent")+" | "+r.Header.Get("Referer"))
	if f.riskN > 0 {
		f.riskN--
		if f.captcha {
			f.json(w, map[string]any{"code": -352, "message": "风控校验失败", "data": map[string]any{"v_voucher": "voucher-test"}})
			return
		}
		f.json(w, map[string]any{"code": f.riskCode, "message": "请求被拦截"})
		return
	}
	switch r.URL.Path {
	case "/x/passport-login/web/qrcode/generate":
		f.ok(w, map[string]any{"url": "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=" + fakeQRKey + "&from=", "qrcode_key": fakeQRKey})
		return
	case "/x/passport-login/web/qrcode/poll":
		if r.URL.Query().Get("qrcode_key") != fakeQRKey {
			f.ok(w, map[string]any{"code": biliQRExpired, "message": "二维码已失效"})
			return
		}
		if f.poll != biliQRDone {
			f.ok(w, map[string]any{"code": f.poll, "message": "未扫码"})
			return
		}
		for k, v := range map[string]string{"SESSDATA": fakeSESS, "bili_jct": fakeJCT, "DedeUserID": strconv.Itoa(fakeMID), "DedeUserID__ckMd5": "ckmd5-test", "sid": "sid-test"} {
			http.SetCookie(w, &http.Cookie{Name: k, Value: v, Path: "/", Domain: ".bilibili.com"})
		}
		f.ok(w, map[string]any{"code": 0, "message": "", "refresh_token": fakeRefresh,
			"url": "https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=4242&SESSDATA=" + fakeSESS + "&bili_jct=" + fakeJCT})
		return
	}
	if f.expired || !strings.Contains(r.Header.Get("Cookie"), "SESSDATA="+fakeSESS) {
		f.json(w, map[string]any{"code": -101, "message": "账号未登录"})
		return
	}
	switch r.URL.Path {
	case "/x/web-interface/nav":
		f.ok(w, map[string]any{"isLogin": true, "mid": fakeMID, "uname": "测试UP主", "face": "https://i0.hdslb.com/bfs/face/test.jpg"})
	case "/x/relation/stat":
		f.ok(w, map[string]any{"mid": fakeMID, "following": 12, "follower": 3456})
	case "/x/web/index/stat":
		f.ok(w, map[string]any{"total_fans": 3456, "total_click": 120000, "total_like": 8800, "total_coin": 1200, "total_fav": 2300,
			"total_reply": 640, "total_dm": 990, "total_share": 310, "total_elec": 15, "incr_fans": 21, "incr_click": 1500})
	case "/x/web/data/pandect":
		typ, _ := strconv.Atoi(r.URL.Query().Get("type"))
		day := time.Date(2026, 11, 3, 0, 0, 0, 0, biliTZ).Unix()
		f.ok(w, []map[string]any{{"date_key": day, "total_inc": typ * 100}, {"date_key": day + 86400, "total_inc": typ * 110}})
	case "/session_svr/v1/session_svr/get_sessions":
		var list []map[string]any
		for who, ms := range f.talkers {
			s := map[string]any{"talker_id": who, "session_type": 1, "unread_count": 0, "max_seqno": 0, "session_ts": time.Now().UnixMicro()}
			if n := len(ms); n > 0 {
				last := ms[n-1]
				c, _ := json.Marshal(map[string]string{"content": last.Text})
				s["last_msg"] = map[string]any{"sender_uid": last.Sender, "receiver_id": fakeMID, "msg_type": 1, "content": string(c),
					"msg_seqno": last.Seq, "timestamp": last.TS, "msg_key": last.Key}
				s["max_seqno"] = last.Seq
				for _, m := range ms {
					if m.Sender != fakeMID {
						s["unread_count"] = s["unread_count"].(int) + 1
					}
				}
			}
			list = append(list, s)
		}
		// 群消息会话（session_type 2）不收
		list = append(list, map[string]any{"talker_id": 5, "session_type": 2, "unread_count": 3})
		f.ok(w, map[string]any{"session_list": list, "has_more": 0})
	case "/account/v1/user/cards":
		var out []map[string]any
		for _, s := range strings.Split(r.URL.Query().Get("uids"), ",") {
			id, _ := strconv.ParseInt(s, 10, 64)
			out = append(out, map[string]any{"mid": id, "name": f.names[id], "face": "https://i0.hdslb.com/bfs/face/" + s + ".jpg"})
		}
		f.ok(w, out)
	case "/svr_sync/v1/svr_sync/fetch_session_msgs":
		who, _ := strconv.ParseInt(r.URL.Query().Get("talker_id"), 10, 64)
		begin, _ := strconv.ParseInt(r.URL.Query().Get("begin_seqno"), 10, 64)
		var out []map[string]any
		for _, m := range f.talkers[who] {
			if m.Seq > begin {
				c, _ := json.Marshal(map[string]string{"content": m.Text})
				out = append(out, map[string]any{"sender_uid": m.Sender, "receiver_id": who, "msg_type": m.MsgType, "content": string(c),
					"msg_seqno": m.Seq, "timestamp": m.TS, "msg_key": m.Key})
			}
		}
		f.ok(w, map[string]any{"messages": out, "has_more": 0})
	case "/web_im/v1/web_im/send_msg":
		if r.Method != http.MethodPost || r.PostForm.Get("csrf") != fakeJCT || r.Header.Get("Origin") != "https://message.bilibili.com" {
			f.json(w, map[string]any{"code": -111, "message": "csrf 校验失败"})
			return
		}
		f.sent = append(f.sent, r.PostForm)
		who, _ := strconv.ParseInt(r.PostForm.Get("msg[receiver_id]"), 10, 64)
		var c struct {
			Content string `json:"content"`
		}
		_ = json.Unmarshal([]byte(r.PostForm.Get("msg[content]")), &c)
		f.seq++
		key := 9000000 + f.seq
		f.talkers[who] = append(f.talkers[who], fakeMsg{Sender: fakeMID, Text: c.Content, Seq: f.seq, Key: key, TS: time.Now().Unix(), MsgType: 1})
		f.ok(w, map[string]any{"msg_key": key, "msg_content": r.PostForm.Get("msg[content]")})
	default:
		w.WriteHeader(http.StatusNotFound)
		f.json(w, map[string]any{"code": -404, "message": "啥都木有"})
	}
}

// biliSplit 把网页端域名的请求投到假网页端，开放平台（member.bilibili.com/arcopen）投到假开放平台。
type biliSplit struct{ web, open *url.URL }

func (s biliSplit) RoundTrip(r *http.Request) (*http.Response, error) {
	to := s.web
	if strings.HasPrefix(r.URL.Path, "/arcopen/") {
		to = s.open
	}
	return biliRewrite{to}.RoundTrip(r)
}

type biliWebEnv struct {
	env
	conns *connector.Store
	web   *fakeBiliWeb
	open  *fakeBilibili
	logs  *syncBuf
	notes *fakeNotifier
	// 所有接口响应的原文，扫凭证用
	bodies *syncBuf
	plugin *Plugin
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func setupBiliWeb(t *testing.T) biliWebEnv {
	t.Helper()
	oldGap, oldRefresh, oldInbox := biliWebGap, biliRefreshMin, biliInboxMin
	biliWebGap, biliRefreshMin, biliInboxMin = 0, time.Hour, 0
	t.Cleanup(func() { biliWebGap, biliRefreshMin, biliInboxMin = oldGap, oldRefresh, oldInbox })
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
	logs := &syncBuf{}
	defs := connector.NewRegistry()
	conns := connector.New(d, v, defs)
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.SetConnectors(conns)
	defs.SetPluginDefs(r.ConnectorDefs)
	notes := &fakeNotifier{}
	r.SetNotifier(notes)
	web := newFakeBiliWeb(t)
	open := newFakeBilibili(t)
	ws, os := httptest.NewServer(web), httptest.NewServer(open)
	t.Cleanup(ws.Close)
	t.Cleanup(os.Close)
	wu, _ := url.Parse(ws.URL)
	ou, _ := url.Parse(os.URL)
	r.SetHTTPTransport(biliSplit{web: wu, open: ou})
	vp := New()
	for _, p := range []plugin.Plugin{projects.New(), vp} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, id := range []string{"projects", "video"} {
		ps := perms
		if id == "projects" {
			ps = []string{"process:spawn"}
		}
		if err := r.Install(ctx, id, ps); err != nil {
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
	bodies := &syncBuf{}
	h := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		_, _ = bodies.Write(rec.Body.Bytes())
		for k, v := range rec.Header() {
			w.Header()[k] = v
			_, _ = fmt.Fprintf(bodies, "%s: %s\n", k, strings.Join(v, ","))
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	})
	return biliWebEnv{env: env{r, h, d}, conns: conns, web: web, open: open, logs: logs, notes: notes, bodies: bodies, plugin: vp}
}

func (e biliWebEnv) addWebConnector(t *testing.T) string {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: BiliWebTool})
	if err != nil {
		t.Fatal(err)
	}
	return c.ID
}

// login 走一遍扫码登录：生成二维码、轮询到成功。
func (e biliWebEnv) login(t *testing.T, cid string) map[string]any {
	t.Helper()
	q := mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/login/qrcode", "", 200)
	e.web.set(func(f *fakeBiliWeb) { f.poll = biliQRDone })
	return mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/login/poll", `{"login_id":"`+q["login_id"].(string)+`"}`, 200)
}

func errOf(out map[string]any) map[string]any { m, _ := out["error"].(map[string]any); return m }

// 扫码登录：二维码是 SVG、轮询三种状态；成功后凭证进保险箱，连接器记下昵称，对外只给登录状态、昵称、头像
func TestBiliLogin(t *testing.T) {
	e := setupBiliWeb(t)
	ctx := context.Background()
	cid := e.addWebConnector(t)
	accs := mustCall(t, e.h, "GET", "/api/video/bili/accounts", "", 200)
	_ = accs
	_, out := call(t, e.h, "GET", "/api/video/bili/accounts", "")
	list := out["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["login"] != "logged_out" {
		t.Fatalf("没登录时：%v", list)
	}
	q := mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/login/qrcode", "", 200)
	svg, _ := q["qr_svg"].(string)
	if !strings.HasPrefix(svg, "<svg") || q["login_id"] == "" || strings.Contains(fmt.Sprint(q), "qrcode_key") {
		t.Fatalf("二维码：%v", q)
	}
	poll := func(id string) map[string]any {
		return mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/login/poll", `{"login_id":"`+id+`"}`, 200)
	}
	id := q["login_id"].(string)
	if got := poll(id); got["state"] != "waiting" {
		t.Fatalf("未扫码：%v", got)
	}
	e.web.set(func(f *fakeBiliWeb) { f.poll = biliQRScanned })
	if got := poll(id); got["state"] != "scanned" {
		t.Fatalf("已扫码：%v", got)
	}
	if got := poll("nope"); got["state"] != "expired" {
		t.Fatalf("不认识的 login_id：%v", got)
	}
	e.web.set(func(f *fakeBiliWeb) { f.poll = biliQRDone })
	got := poll(id)
	acc, _ := got["account"].(map[string]any)
	if got["state"] != "done" || acc["login"] != "logged_in" || acc["uname"] != "测试UP主" || acc["mid"] != "4242" {
		t.Fatalf("登录成功：%v", got)
	}
	// 用过的 login_id 作废
	if got := poll(id); got["state"] != "expired" {
		t.Fatalf("用过的 login_id：%v", got)
	}
	cn, _ := e.conns.Get(ctx, cid)
	if cn.Account != "测试UP主" || cn.Status != connector.StatusConnected || len(cn.SecretHints) != 0 {
		t.Fatalf("连接器：%+v", cn)
	}
	var cookie, csrf string
	if err := e.conns.WithConfig(ctx, cid, "video", func(cfg connector.Config) error {
		cookie, csrf = cfg.Secret(biliKeyCookie), cfg.Secret(biliKeyCSRF)
		return nil
	}); err != nil || !strings.Contains(cookie, "SESSDATA="+fakeSESS) || csrf != fakeJCT {
		t.Fatalf("保险箱里的登录态：%q %q %v", cookie, csrf, err)
	}
	// 连通测试用登录态查账号
	if res, err := e.conns.Test(ctx, cid); err != nil || !res.OK || res.Account != "测试UP主" {
		t.Fatalf("连通测试：%+v %v", res, err)
	}
	// 退出：凭证清掉，连接器异常提示扫码
	a := mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/logout", "", 200)
	if a["login"] != "logged_out" || !strings.Contains(fmt.Sprint(a["error"]), "扫码") {
		t.Fatalf("退出：%v", a)
	}
	_ = e.conns.WithConfig(ctx, cid, "video", func(cfg connector.Config) error { cookie = cfg.Secret(biliKeyCookie); return nil })
	if cookie != "" {
		t.Fatal("退出后 Cookie 应清掉")
	}
	code, out := call(t, e.h, "POST", "/api/video/bili/"+cid+"/overview/refresh", "")
	if code != 409 || errOf(out)["code"] != "bili_login_required" {
		t.Fatalf("退出后拉数据：%d %v", code, out)
	}
	// 别的工具的实例不认
	if code, _ := call(t, e.h, "GET", "/api/video/bili/cn_nope/overview", ""); code != 404 {
		t.Fatalf("没有的实例：%d", code)
	}
	// 请求头只有常规 UA 和 Referer
	for _, s := range e.web.uas {
		if !strings.HasPrefix(s, biliUA+" | https://") {
			t.Fatalf("请求头：%s", s)
		}
	}
}

// 账户概览：网页端拿全量；接了同一个账号的开放平台时粉丝、关注、稿件数取开放平台；当天只一行；刚刷新过 409
func TestBiliOverview(t *testing.T) {
	e := setupBiliWeb(t)
	cid := e.addWebConnector(t)
	e.login(t, cid)
	biliRefreshMin = 0
	ov := mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/overview/refresh", "", 200)
	latest, _ := ov["latest"].(map[string]any)
	if latest["source"] != "web" || latest["followers"] != 3456.0 || latest["total_click"] != 120000.0 || latest["total_elec"] != 15.0 ||
		latest["incr_fans"] != 21.0 || latest["archives"] != nil {
		t.Fatalf("网页端快照：%v", latest)
	}
	trends := ov["trends"].([]any)
	if len(trends) != len(BiliTrendMetrics) {
		t.Fatalf("趋势：%v", trends)
	}
	first := trends[0].(map[string]any)
	pts := first["points"].([]any)
	if first["metric"] != "click" || len(pts) != 2 || pts[0].(map[string]any)["date"] != "2026-11-03" || pts[1].(map[string]any)["value"] != 110.0 {
		t.Fatalf("播放趋势：%v", first)
	}
	// 接上开放平台（昵称同一个账号）：粉丝、关注、稿件数换成开放平台的
	if _, err := e.conns.Create(context.Background(), connector.Input{Tool: BilibiliTool, Config: map[string]string{"client_id": biliClientID},
		Secrets: map[string]string{"app_secret": biliAppSecret, "access_token": biliGoodToken}}); err != nil {
		t.Fatal(err)
	}
	ov = mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/overview/refresh", "", 200)
	latest = ov["latest"].(map[string]any)
	if latest["source"] != "open+web" || latest["followers"] != 3450.0 || latest["archives"] != 7.0 || latest["total_like"] != 8800.0 {
		t.Fatalf("开放平台加网页端：%v", latest)
	}
	if days := ov["days"].([]any); len(days) != 1 {
		t.Fatalf("同一天只一行：%v", days)
	}
	biliRefreshMin = time.Hour
	code, out := call(t, e.h, "POST", "/api/video/bili/"+cid+"/overview/refresh", "")
	if code != 409 || !strings.Contains(errMsg(out), "刚刷新过") {
		t.Fatalf("刚刷新过：%d %v", code, out)
	}
	// 每天的后台任务：当天有了就不拉
	before := e.web.callCount()
	h := e.handler(t)
	if err := h.biliDailyJob(context.Background(), nil); err != nil || e.web.callCount() != before {
		t.Fatalf("当天拉过不再拉：%v %d→%d", err, before, e.web.callCount())
	}
}

// handler 是视频插件启用时建的 handler，直接调后台任务用。
func (e biliWebEnv) handler(t *testing.T) *handler {
	t.Helper()
	if e.plugin.last == nil {
		t.Fatal("视频插件还没注册")
	}
	return e.plugin.last
}

// 私信：首次只记基线不通知；对方发来新消息落库并通知（不带内容和凭证）；发送带 client_msg_id 只发一次
func TestBiliInboxAndSend(t *testing.T) {
	e := setupBiliWeb(t)
	cid := e.addWebConnector(t)
	e.web.incoming(777, "老消息，基线之前的")
	e.login(t, cid)
	base := "/api/video/bili/" + cid
	_, out := call(t, e.h, "POST", base+"/sessions/refresh", "")
	list, _ := out["data"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["talker_name"] != "热心观众" || list[0].(map[string]any)["unread"] != 1.0 {
		t.Fatalf("基线会话：%v", out)
	}
	if n := len(e.notes.list()); n != 0 {
		t.Fatalf("基线不发通知：%d", n)
	}
	_, out = call(t, e.h, "GET", base+"/sessions/777/messages", "")
	if msgs := out["data"].([]any); len(msgs) != 0 {
		t.Fatalf("基线不拉历史：%v", msgs)
	}
	// 对方发来两条，新人也发来一条
	e.web.incoming(777, "请问合作怎么联系")
	e.web.incoming(777, "在吗")
	e.web.incoming(888, "商单报价")
	_, out = call(t, e.h, "POST", base+"/sessions/refresh", "")
	if meta := out["meta"].(map[string]any); meta["unread"] != 4.0 || meta["total"] != 2.0 {
		t.Fatalf("刷新后：%v", meta)
	}
	notes := e.notes.list()
	if len(notes) != 1 || notes[0].Title != "B 站新私信" || !strings.Contains(notes[0].Body, "3 条") || strings.Contains(notes[0].Body, "合作") {
		t.Fatalf("通知：%+v", notes)
	}
	_, out = call(t, e.h, "GET", base+"/sessions/777/messages", "")
	msgs := out["data"].([]any)
	if len(msgs) != 2 || msgs[0].(map[string]any)["text"] != "请问合作怎么联系" || msgs[1].(map[string]any)["direction"] != "in" {
		t.Fatalf("消息：%v", msgs)
	}
	// 没有新消息：再拉一轮不通知
	_, _ = call(t, e.h, "POST", base+"/sessions/refresh", "")
	if len(e.notes.list()) != 1 {
		t.Fatal("没有新消息不该再通知")
	}

	// 发送
	send := func(body string) (int, map[string]any) {
		return call(t, e.h, "POST", base+"/sessions/777/messages", body)
	}
	code, out := send(`{"client_msg_id":"cm-0001-abcd","text":"您好，商务合作请发邮件"}`)
	m := data(out)
	if code != 201 || m["status"] != "sent" || m["direction"] != "out" || m["client_msg_id"] != "cm-0001-abcd" {
		t.Fatalf("发送：%d %v", code, out)
	}
	if len(e.web.sent) != 1 || e.web.sent[0].Get("msg[sender_uid]") != "4242" || e.web.sent[0].Get("msg[receiver_id]") != "777" ||
		e.web.sent[0].Get("msg[content]") != `{"content":"您好，商务合作请发邮件"}` || e.web.sent[0].Get("msg[dev_id]") == "" {
		t.Fatalf("发出去的表单：%v", e.web.sent)
	}
	// 同一个 client_msg_id 再点一次：原样回、不再发
	code, out = send(`{"client_msg_id":"cm-0001-abcd","text":"您好，商务合作请发邮件"}`)
	if code != 200 || data(out)["id"] != m["id"] || out["meta"].(map[string]any)["duplicate"] != true || len(e.web.sent) != 1 {
		t.Fatalf("重复提交：%d %v，发了 %d 次", code, out, len(e.web.sent))
	}
	if code, _ := send(`{"client_msg_id":"cm-0001-abcd","text":"换了内容"}`); code != 409 {
		t.Fatalf("同一个键换内容：%d", code)
	}
	for _, bad := range []string{`{"client_msg_id":"cm-0002-abcd","text":"  "}`, `{"client_msg_id":"short","text":"x"}`, `{"text":"x"}`,
		`{"client_msg_id":"cm-0003-abcd","text":"` + strings.Repeat("长", 501) + `"}`, `{"client_msg_id":"cm-0004-abcd","text":"x","to":["1","2"]}`} {
		if code, _ := send(bad); code != 400 {
			t.Fatalf("%s 应 400，得到 %d", bad, code)
		}
	}
	// 不在会话列表里的对方不能发
	if code, _ := call(t, e.h, "POST", base+"/sessions/999/messages", `{"client_msg_id":"cm-0005-abcd","text":"x"}`); code != 404 {
		t.Fatalf("陌生 UID：%d", code)
	}
	// 拉这个会话：自己发的那条按 msg_key 不重复落库
	_, out = call(t, e.h, "POST", base+"/sessions/777/sync", "")
	msgs = out["data"].([]any)
	if len(msgs) != 3 || msgs[2].(map[string]any)["status"] != "sent" {
		t.Fatalf("同步后：%v", msgs)
	}
	// 发送失败：记成 failed，不自动重试
	e.web.set(func(f *fakeBiliWeb) { f.riskN, f.riskCode = 1, -509 })
	code, out = send(`{"client_msg_id":"cm-0006-abcd","text":"第二条"}`)
	if code != 429 || errOf(out)["code"] != "bili_guarded" || errOf(out)["message_id"] == nil {
		t.Fatalf("被限频：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", base+"/sessions/777/messages", "")
	msgs = out["data"].([]any)
	if last := msgs[len(msgs)-1].(map[string]any); last["status"] != "failed" || !strings.Contains(last["error"].(string), "-509") {
		t.Fatalf("失败的消息：%v", last)
	}
	if len(e.web.sent) != 1 {
		t.Fatalf("失败不重试：发了 %d 次", len(e.web.sent))
	}
}

// 风控：被拦后退避，退避期内不发请求、界面拿得到原因；要验证码的说明不绕过；过了退避期成功一次清掉
func TestBiliRiskBackoff(t *testing.T) {
	e := setupBiliWeb(t)
	cid := e.addWebConnector(t)
	e.login(t, cid)
	base := "/api/video/bili/" + cid
	e.web.set(func(f *fakeBiliWeb) { f.riskN = 5 })
	code, out := call(t, e.h, "POST", base+"/sessions/refresh", "")
	g, _ := errOf(out)["guard"].(map[string]any)
	if code != 429 || g == nil || g["code"] != -412.0 || !strings.Contains(g["reason"].(string), "限频或风控") {
		t.Fatalf("被拦：%d %v", code, out)
	}
	n := e.web.callCount()
	for i := 0; i < 3; i++ {
		if code, _ := call(t, e.h, "POST", base+"/sessions/refresh", ""); code != 429 {
			t.Fatalf("退避期内：%d", code)
		}
	}
	if e.web.callCount() != n {
		t.Fatalf("退避期内不该发请求：%d→%d", n, e.web.callCount())
	}
	_, out = call(t, e.h, "GET", "/api/video/bili/accounts", "")
	acc := out["data"].([]any)[0].(map[string]any)
	if acc["guard"] == nil {
		t.Fatalf("账号上看得到退避：%v", acc)
	}
	until1 := parseTime(acc["guard"].(map[string]any)["until"].(string))
	// 后台任务跳过退避中的实例
	if h := e.handler(t); h.biliInboxJob(context.Background(), nil) != nil || e.web.callCount() != n {
		t.Fatal("后台任务不该在退避期发请求")
	}
	// 退避到期再被拦：翻倍
	expire := func() {
		if _, err := e.d.W.Exec(`UPDATE video_bili_profiles SET guard_until = ? WHERE connector_id = ?`, time.Now().Add(-time.Second).UTC().Format(time.RFC3339), cid); err != nil {
			t.Fatal(err)
		}
	}
	expire()
	_, _ = call(t, e.h, "POST", base+"/sessions/refresh", "")
	_, out = call(t, e.h, "GET", "/api/video/bili/accounts", "")
	until2 := parseTime(out["data"].([]any)[0].(map[string]any)["guard"].(map[string]any)["until"].(string))
	if d1, d2 := time.Until(until1), time.Until(until2); d2 < d1+biliGuardBase/2 {
		t.Fatalf("第二次应退避更久：%v %v", d1, d2)
	}
	// 要验证码：说明里写不绕过，至少 30 分钟
	expire()
	e.web.set(func(f *fakeBiliWeb) { f.riskN, f.captcha = 1, true })
	_, out = call(t, e.h, "POST", base+"/sessions/refresh", "")
	g = errOf(out)["guard"].(map[string]any)
	if !strings.Contains(g["reason"].(string), "不绕过验证码") || time.Until(parseTime(g["until"].(string))) < 29*time.Minute {
		t.Fatalf("验证码：%v", g)
	}
	// 过了退避期，成功一次清掉
	expire()
	e.web.set(func(f *fakeBiliWeb) { f.riskN, f.captcha = 0, false })
	if code, out := call(t, e.h, "POST", base+"/sessions/refresh", ""); code != 200 {
		t.Fatalf("恢复：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/video/bili/accounts", "")
	if acc := out["data"].([]any)[0].(map[string]any); acc["guard"] != nil {
		t.Fatalf("成功后清掉退避：%v", acc)
	}
	var strikes int
	_ = e.d.R.QueryRow(`SELECT guard_strikes FROM video_bili_profiles WHERE connector_id = ?`, cid).Scan(&strikes)
	if strikes != 0 {
		t.Fatalf("连续次数应清零：%d", strikes)
	}
}

// 登录失效：账号标成过期，连接器置为异常并提示重新扫码
func TestBiliLoginExpired(t *testing.T) {
	e := setupBiliWeb(t)
	cid := e.addWebConnector(t)
	e.login(t, cid)
	e.web.set(func(f *fakeBiliWeb) { f.expired = true })
	code, out := call(t, e.h, "POST", "/api/video/bili/"+cid+"/sessions/refresh", "")
	if code != 409 || errOf(out)["code"] != "bili_login_required" || !strings.Contains(errMsg(out), "重新扫码") {
		t.Fatalf("登录失效：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/video/bili/accounts", "")
	acc := out["data"].([]any)[0].(map[string]any)
	if acc["login"] != "expired" || acc["status"] != "error" || !strings.Contains(acc["error"].(string), "重新扫码") {
		t.Fatalf("账号：%v", acc)
	}
	// 后台任务不再拉过期的
	n := e.web.callCount()
	if h := e.handler(t); h.biliInboxJob(context.Background(), nil) != nil || e.web.callCount() != n {
		t.Fatal("过期的不该再拉")
	}
	// 重新扫码恢复
	e.web.set(func(f *fakeBiliWeb) { f.expired = false })
	got := e.login(t, cid)
	if got["state"] != "done" || got["account"].(map[string]any)["status"] != "connected" {
		t.Fatalf("重新登录：%v", got)
	}
}

// 所有网页接口共用一个限频：两次请求之间至少隔 biliWebGap
func TestBiliRateLimit(t *testing.T) {
	e := setupBiliWeb(t)
	cid := e.addWebConnector(t)
	e.login(t, cid)
	biliWebGap = 40 * time.Millisecond
	biliRefreshMin = 0
	mustCall(t, e.h, "POST", "/api/video/bili/"+cid+"/overview/refresh", "", 200)
	e.web.mu.Lock()
	ts := append([]time.Time(nil), e.web.times...)
	e.web.mu.Unlock()
	// 登录那几个请求不算（当时间隔是 0），只看刷新的 8 个
	ts = ts[len(ts)-8:]
	for i := 1; i < len(ts); i++ {
		if d := ts[i].Sub(ts[i-1]); d < 35*time.Millisecond {
			t.Fatalf("第 %d 个请求只隔了 %v", i, d)
		}
	}
	// 排队太久的直接不发
	w := newBiliWeb()
	biliWebGap = time.Minute
	_ = w.wait(context.Background())
	if err := w.wait(context.Background()); err == nil || !strings.Contains(err.Error(), "排队") {
		t.Fatalf("排太久：%v", err)
	}
}

// 凭证不外泄：Cookie、csrf、refresh_token、开放平台令牌不出现在日志、接口响应、通知、审计、连接器表和插件表里
func TestBiliSecretsNeverLeak(t *testing.T) {
	e := setupBiliWeb(t)
	if _, err := e.conns.Create(context.Background(), connector.Input{Tool: BilibiliTool, Config: map[string]string{"client_id": biliClientID},
		Secrets: map[string]string{"app_secret": biliAppSecret, "access_token": biliGoodToken}}); err != nil {
		t.Fatal(err)
	}
	cid := e.addWebConnector(t)
	e.web.incoming(777, "基线")
	e.login(t, cid)
	base := "/api/video/bili/" + cid
	biliRefreshMin = 0
	mustCall(t, e.h, "POST", base+"/overview/refresh", "", 200)
	mustCall(t, e.h, "POST", base+"/sessions/refresh", "", 200)
	e.web.incoming(777, "新消息")
	mustCall(t, e.h, "POST", base+"/sessions/refresh", "", 200)
	mustCall(t, e.h, "POST", base+"/sessions/777/messages", `{"client_msg_id":"cm-leak-0001","text":"回复"}`, 201)
	mustCall(t, e.h, "POST", base+"/sessions/777/sync", "", 200)
	mustCall(t, e.h, "GET", base+"/overview", "", 200)
	mustCall(t, e.h, "GET", base+"/sessions/777/messages", "", 200)
	call(t, e.h, "GET", "/api/video/bili/accounts", "")
	// 出错的路径也扫：风控、登录失效、发送失败
	e.web.set(func(f *fakeBiliWeb) { f.riskN = 1 })
	call(t, e.h, "POST", base+"/sessions/777/messages", `{"client_msg_id":"cm-leak-0002","text":"再回"}`)
	_, _ = e.d.W.Exec(`UPDATE video_bili_profiles SET guard_until = NULL`)
	e.web.set(func(f *fakeBiliWeb) { f.expired = true })
	call(t, e.h, "POST", base+"/sessions/refresh", "")
	call(t, e.h, "POST", base+"/logout", "")
	_, _ = e.conns.Test(context.Background(), cid)

	var tables strings.Builder
	dump := func(q string) {
		rows, err := e.d.R.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			_ = rows.Scan(ptrs...)
			_, _ = fmt.Fprintln(&tables, vals...)
		}
	}
	for _, q := range []string{`SELECT * FROM audits`, `SELECT * FROM connectors`, `SELECT * FROM video_bili_profiles`, `SELECT * FROM video_bili_sessions`,
		`SELECT * FROM video_bili_messages`, `SELECT * FROM video_bili_snapshots`, `SELECT * FROM incidents`} {
		dump(q)
	}
	var notes strings.Builder
	for _, n := range e.notes.list() {
		_, _ = fmt.Fprintf(&notes, "%+v\n", n)
	}
	places := map[string]string{"日志": e.logs.String(), "接口响应": e.bodies.String(), "通知": notes.String(), "库表（含审计）": tables.String()}
	for where, text := range places {
		if text == "" && where != "通知" {
			t.Fatalf("%s是空的，扫描没起作用", where)
		}
		for _, s := range secretsUnderTest {
			if strings.Contains(text, s) {
				t.Errorf("%s里出现了凭证 %s", where, s)
			}
		}
	}
	// 审计里有登录态变化，只记键名
	if !strings.Contains(tables.String(), "connector_session") || !strings.Contains(tables.String(), biliKeyCookie) {
		t.Errorf("审计里应记登录态更新（只有键名）")
	}
	if !strings.Contains(e.logs.String(), "backing off") {
		t.Errorf("被限频应记一条日志，扫描才有意义")
	}
}

// 二维码编码：纠错码对得上标准里的例子，矩阵大小和定位图形对
func TestQREncode(t *testing.T) {
	// ISO 18004 / thonky 的例子：HELLO WORLD 1-M 的 16 个数据码字 → 10 个纠错码字
	data := []byte{32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17}
	want := []byte{196, 35, 39, 119, 235, 215, 231, 226, 93, 23}
	if got := rsRemainder(data, rsGenerator(10)); !bytes.Equal(got, want) {
		t.Fatalf("纠错码：%v", got)
	}
	u := "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from="
	m, err := qrEncode(u)
	if err != nil || len(m) != 8*4+17 {
		t.Fatalf("131 个字节落在版本 8：%d %v", len(m), err)
	}
	n := len(m)
	for _, c := range [][2]int{{0, 0}, {n - 7, 0}, {0, n - 7}} {
		for i := 0; i < 7; i++ {
			if !m[c[1]][c[0]+i] || !m[c[1]+6][c[0]+i] || !m[c[1]+i][c[0]] || !m[c[1]+i][c[0]+6] || !m[c[1]+3][c[0]+3] || m[c[1]+1][c[0]+1] {
				t.Fatalf("定位图形 %v 不对", c)
			}
		}
	}
	if _, err := qrEncode(strings.Repeat("x", 300)); err == nil {
		t.Fatal("太长应报错")
	}
	svg, _ := qrSVG("hi")
	if !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, `viewBox="0 0 29 29"`) {
		t.Fatalf("SVG：%s", svg[:80])
	}
}

var _ = io.Discard
