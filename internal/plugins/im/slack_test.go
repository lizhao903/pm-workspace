package im

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
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
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// fakeSlack 是本机假 Slack Web API：认一个 Bot Token，Bot 在 #product（C01）、#random（C02）和一个私信（D01）里；
// 也认本人的 User Token（xoxp-me，IM-06），auth.test 回本人 U0EXAMPLE，会话同上。
type fakeSlack struct {
	mu      sync.Mutex
	token   string
	user    string           // 本人的 User Token
	team    string           // 空为 T1
	convs   []map[string]any // Bot 所在的会话，空为 #product、#random 和一个私信
	revoked bool
	// noFiles 模拟 Token 缺 files:read：下载附件回 200 的网页登录页
	noFiles  bool
	history  map[string][]map[string]any // 会话 -> 消息（正序）
	broken   map[string]bool             // 读历史回 channel_not_found 的会话
	posted   []url.Values
	postedBy []string // 每次 chat.postMessage 用的 Token
	calls    map[string]int
	onPost   func() // chat.postMessage 回结果之前调（不持锁），模拟回复还没落库时事件已经推过来
	postTS   string // chat.postMessage 回的 ts，空为 1761709999.000100
	limitAt  int    // conversations.history 累计调到第几次之后回 429；0 为不限流
	// 串（0010）：「频道:父消息 ts」-> 串里的回复（正序，不含父消息）。history 回父消息时按它补上 reply_count、latest_reply
	threads        map[string][]map[string]any
	repliesLimitAt int      // conversations.replies 累计调到第几次之后回 429；0 为不限流
	repliesOldest  []string // 每次 conversations.replies 带的 oldest
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{token: "xoxb-good", user: "xoxp-me", calls: map[string]int{}, history: map[string][]map[string]any{
		"C01": {
			{"type": "message", "user": "U04LIN", "text": "<@UBOT> 权限点清单看下 <https://x.example|清单>", "ts": "1761700000.000100",
				"files": []map[string]any{{"id": "F1", "name": "清单.xlsx", "mimetype": "application/vnd.ms-excel", "size": 12,
					"url_private_download": "https://files.slack.com/files-pri/T1-F1/qd.xlsx", "permalink": "https://acme.slack.com/f/F1"}}},
			{"type": "message", "subtype": "channel_join", "user": "U09ZHOU", "text": "joined", "ts": "1761700001.000100"},
			{"type": "message", "user": "UBOT", "bot_id": "BBOT", "text": "Bot 自己发的", "ts": "1761700002.000100"},
		},
		"C02": {{"type": "message", "user": "U04LIN", "text": "不监听的频道", "ts": "1761700003.000100"}},
		"D01": {{"type": "message", "user": "U09ZHOU", "text": "预发好了", "ts": "1761700004.000100"}},
	}}
}

func (f *fakeSlack) channels() []map[string]any {
	if f.convs != nil {
		return f.convs
	}
	return []map[string]any{{"id": "C01", "name": "product"}, {"id": "C02", "name": "random"}, {"id": "D01", "is_im": true, "user": "U09ZHOU"}}
}

func (f *fakeSlack) add(ch string, m map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.history[ch] = append(f.history[ch], m)
}

func (f *fakeSlack) setRevoked(v bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = v
}

func (f *fakeSlack) sent() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]url.Values(nil), f.posted...)
}

func (f *fakeSlack) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	auth := r.Header.Get("Authorization")
	tok := strings.TrimPrefix(auth, "Bearer ")
	known := tok == f.token || (f.user != "" && tok == f.user)
	if strings.HasPrefix(r.URL.Path, "/files-pri/") {
		if !known || f.revoked {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if f.noFiles {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<!DOCTYPE html><html>登录 Slack</html>"))
			return
		}
		_, _ = w.Write([]byte("xlsx bytes"))
		return
	}
	_ = r.ParseForm()
	method := strings.TrimPrefix(r.URL.Path, "/api/")
	f.calls[method]++
	reply := func(v map[string]any) {
		v["ok"] = true
		_ = json.NewEncoder(w).Encode(v)
	}
	if !known || f.revoked {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid_auth"})
		return
	}
	switch method {
	case "auth.test":
		team := f.team
		if team == "" {
			team = "T1"
		}
		if tok == f.user {
			reply(map[string]any{"user_id": "U0EXAMPLE", "user": "broleez", "team": "Acme", "team_id": team, "url": "https://acme.slack.com/"})
			return
		}
		reply(map[string]any{"user_id": "UBOT", "bot_id": "BBOT", "user": "pmw", "team": "Acme", "team_id": team, "url": "https://acme.slack.com/"})
	case "users.conversations":
		reply(map[string]any{"channels": f.channels()})
	case "conversations.info":
		name := ""
		for _, cv := range f.channels() {
			if cv["id"] == r.Form.Get("channel") {
				name, _ = cv["name"].(string)
			}
		}
		reply(map[string]any{"channel": map[string]any{"id": r.Form.Get("channel"), "name": name}})
	case "users.info":
		names := map[string]string{"U04LIN": "Lin Yuan", "U09ZHOU": "Zhou Yu", "UBOT": "pmw", "U0EXAMPLE": "Broleez"}
		reply(map[string]any{"user": map[string]any{"name": strings.ToLower(r.Form.Get("user")), "profile": map[string]any{"display_name": names[r.Form.Get("user")]}}})
	case "conversations.history":
		if f.limitAt > 0 && f.calls[method] > f.limitAt {
			w.Header().Set("Retry-After", "10")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		if f.broken[r.Form.Get("channel")] {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "channel_not_found"})
			return
		}
		oldest, _ := strconv.ParseFloat(r.Form.Get("oldest"), 64)
		latest, _ := strconv.ParseFloat(r.Form.Get("latest"), 64)
		inclusive := r.Form.Get("inclusive") == "true"
		limit, _ := strconv.Atoi(r.Form.Get("limit"))
		var out []map[string]any
		h := f.history[r.Form.Get("channel")]
		more := false // 这一页满了、后面还有（补全消息 TSK-0724 按 has_more 往前翻）
		for i := len(h) - 1; i >= 0; i-- {
			ts, _ := strconv.ParseFloat(h[i]["ts"].(string), 64)
			after := ts > oldest || (inclusive && ts == oldest)
			before := latest == 0 || ts < latest || (inclusive && ts == latest)
			if after && before && len(out) >= limit {
				more = true
				break
			}
			if after && before {
				m := h[i]
				if rs := f.threads[r.Form.Get("channel")+":"+m["ts"].(string)]; len(rs) > 0 {
					m = maps.Clone(m)
					m["thread_ts"], m["reply_count"], m["latest_reply"] = m["ts"], len(rs), rs[len(rs)-1]["ts"]
				}
				out = append(out, m)
			}
		}
		reply(map[string]any{"messages": out, "has_more": more})
	case "conversations.replies":
		if f.repliesLimitAt > 0 && f.calls[method] > f.repliesLimitAt {
			w.Header().Set("Retry-After", "10")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		ch, ts := r.Form.Get("channel"), r.Form.Get("ts")
		f.repliesOldest = append(f.repliesOldest, r.Form.Get("oldest"))
		var parent map[string]any
		for _, m := range f.history[ch] {
			if m["ts"] == ts {
				parent = maps.Clone(m)
			}
		}
		rs := f.threads[ch+":"+ts]
		if parent == nil || len(rs) == 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "thread_not_found"})
			return
		}
		parent["thread_ts"], parent["reply_count"], parent["latest_reply"] = ts, len(rs), rs[len(rs)-1]["ts"]
		oldest, _ := strconv.ParseFloat(r.Form.Get("oldest"), 64)
		out := []map[string]any{parent} // 对方总把父消息放第一条
		for _, m := range rs {
			if x, _ := strconv.ParseFloat(m["ts"].(string), 64); x > oldest {
				out = append(out, m)
			}
		}
		reply(map[string]any{"messages": out, "has_more": false})
	case "chat.postMessage":
		f.posted = append(f.posted, r.Form)
		f.postedBy = append(f.postedBy, tok)
		if hook := f.onPost; hook != nil {
			f.mu.Unlock()
			hook()
			f.mu.Lock()
		}
		ts := f.postTS
		if ts == "" {
			ts = "1761709999.000100"
		}
		reply(map[string]any{"channel": r.Form.Get("channel"), "ts": ts})
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "unknown_method"})
	}
}

// slackRewrite 把发往 slack.com、files.slack.com 的请求改投到本机假服务；域名检查在它外面照常做。
type slackRewrite struct{ to *url.URL }

func (rw slackRewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.URL.Scheme, r2.URL.Host, r2.Host = rw.to.Scheme, rw.to.Host, rw.to.Host
	return http.DefaultTransport.RoundTrip(r2)
}

type slackEnv struct {
	d     *db.DB
	h     http.Handler
	conns *connector.Store
	fake  *fakeSlack
	sl    *Slack
}

// setupSlack 在真库上装好 im（带 Slack 适配器、确认 network:im），接上真的连接器 store 和本机假 Slack。
func setupSlack(t *testing.T) slackEnv {
	t.Helper()
	fake := newFakeSlack()
	return setupSlackOn(t, fake, fake)
}

// setupSlackOn 同 setupSlack，假 Slack 换成 h（多个工作区时按 Token 分派）。
func setupSlackOn(t *testing.T, fake *fakeSlack, h http.Handler) slackEnv {
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
	conns := connector.New(d, v, defs)
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.SetConnectors(conns)
	r.DataDir = t.TempDir()
	defs.SetPluginDefs(r.ConnectorDefs)
	srv := httptest.NewServer(h)
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
	return slackEnv{d: d, h: mux, conns: conns, fake: fake, sl: sl}
}

func (e slackEnv) connect(t *testing.T, interval int) *connector.Connector {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &interval,
		Config:  map[string]string{"channels": "#product", "self_user_id": "U0EXAMPLE"},
		Secrets: map[string]string{"bot_token": "xoxb-good", "signing_secret": "sig-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// signed 发一次签过名的事件回调；sig 非空时用它代替正确的签名。
func (e slackEnv) signed(t *testing.T, body, sig string) (int, map[string]any) {
	t.Helper()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	if sig == "" {
		sig = connector.SlackSign("sig-secret", ts, []byte(body))
	}
	req := httptest.NewRequest("POST", "/api/im/callbacks/slack", strings.NewReader(body))
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", sig)
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestSlackConnectorTest(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 0)
	res, err := e.conns.Test(context.Background(), c.ID)
	if err != nil || !res.OK || res.Account != "pmw（UBOT）" || res.Connector.Status != "connected" {
		t.Fatalf("连通测试：%+v %v", res, err)
	}
	// 不是 xoxb- 开头的不调对方
	if _, err := e.conns.Update(context.Background(), c.ID, connector.Patch{Secrets: map[string]string{"bot_token": "xoxp-user"}}); err != nil {
		t.Fatal(err)
	}
	n := e.fake.calls["auth.test"]
	res, _ = e.conns.Test(context.Background(), c.ID)
	if res.OK || !strings.Contains(res.Message, "xoxb-") || e.fake.calls["auth.test"] != n {
		t.Fatalf("用户 Token：%+v", res)
	}
}

func TestSlackCallbackSignature(t *testing.T) {
	e := setupSlack(t)
	e.connect(t, 0)

	// 握手：签名对的原样回 challenge
	code, out := e.signed(t, `{"type":"url_verification","challenge":"abc123"}`, "")
	if code != 200 || out["challenge"] != "abc123" {
		t.Fatalf("握手：%d %v", code, out)
	}
	ev := `{"type":"event_callback","event":{"type":"message","channel":"C01","channel_type":"channel","user":"U04LIN",
		"text":"<!here> 发版了 <@U0EXAMPLE>","ts":"1761700100.000200"}}`
	// 签名不对 401，不落库
	if code, out := e.signed(t, ev, "v0=deadbeef"); code != 401 || out["error"].(map[string]any)["code"] != "unauthorized" {
		t.Fatalf("签名不对：%d %v", code, out)
	}
	if n, _ := list(t, e.h, ""); n != 0 {
		t.Fatalf("签名不对不该落库，有 %d 条", n)
	}
	code, out = e.signed(t, ev, "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 1 {
		t.Fatalf("回调落库：%d %v", code, out)
	}
	// 重试（同一条）去重；不监听的频道、Bot 自己的不收
	e.signed(t, ev, "")
	e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"C02","channel_type":"channel","user":"U04LIN","text":"x","ts":"1761700101.0"}}`, "")
	e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"C01","channel_type":"channel","user":"UBOT","bot_id":"BBOT","text":"x","ts":"1761700102.0"}}`, "")
	n, got := list(t, e.h, "")
	m := got["C01:1761700100.000200"]
	if n != 1 || m == nil {
		t.Fatalf("应只有 1 条：%d %v", n, got)
	}
	if m["text"] != "@here 发版了 @Broleez" || m["relevance"] != "me" || m["conversation"] != "#product" || m["sender_name"] != "Lin Yuan" || m["adapter"] != "slack" {
		t.Fatalf("消息：%v", m)
	}
}

func TestSlackPullAndReply(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 5)
	ctx := context.Background()
	if !e.sl.Due(ctx, time.Now()) {
		t.Fatal("没拉过、间隔 5 分钟，应该到点")
	}
	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 2 {
		t.Fatalf("立即同步：%d %v", code, out)
	}
	if e.sl.Due(ctx, time.Now()) {
		t.Fatal("刚拉过不该到点")
	}
	n, got := list(t, e.h, "")
	ch, dm := got["C01:1761700000.000100"], got["D01:1761700004.000100"]
	if n != 2 || ch == nil || dm == nil {
		t.Fatalf("应收 #product 一条、私信一条：%v", got)
	}
	if ch["text"] != "@pmw 权限点清单看下 清单 (https://x.example)" || ch["relevance"] != "me" || ch["sender_name"] != "Lin Yuan" {
		t.Fatalf("频道消息：%v", ch)
	}
	atts := ch["attachments"].([]any)
	if len(atts) != 1 || atts[0].(map[string]any)["name"] != "清单.xlsx" {
		t.Fatalf("附件：%v", atts)
	}
	if dm["conversation_kind"] != "direct" || dm["conversation"] != "" || dm["relevance"] != "dm" {
		t.Fatalf("私信：%v", dm)
	}
	cn, _ := e.conns.Get(ctx, c.ID)
	if cn.LastSyncAt == nil || cn.Status != "connected" {
		t.Fatalf("同步后连接器：%+v", cn)
	}

	// 再拉只拿新的
	e.fake.add("C01", map[string]any{"type": "message", "user": "U09ZHOU", "text": "补一条", "ts": "1761700200.000100"})
	_, out = call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if d := out["data"].(map[string]any); len(d["ids"].([]any)) != 1 || d["duplicates"].(float64) != 0 {
		t.Fatalf("第二次同步：%v", out)
	}

	// 回复：频道里串在原消息下面
	code, out = call(t, e.h, "POST", "/api/im/messages/"+ch["id"].(string)+"/reply", `{"text":"收到"}`)
	if code != 200 {
		t.Fatalf("回复：%d %v", code, out)
	}
	sent := e.fake.sent()
	if len(sent) != 1 || sent[0].Get("channel") != "C01" || sent[0].Get("thread_ts") != "1761700000.000100" || sent[0].Get("text") != "收到" {
		t.Fatalf("chat.postMessage：%v", sent)
	}
	rp := out["data"].(map[string]any)["replies"].([]any)[0].(map[string]any)
	if rp["external_id"] != "C01:1761709999.000100" || rp["status"] != "sent" {
		t.Fatalf("回复记录：%v", rp)
	}
	// 私信直接发，不串
	call(t, e.h, "POST", "/api/im/messages/"+dm["id"].(string)+"/reply", `{"text":"好"}`)
	if sent = e.fake.sent(); len(sent) != 2 || sent[1].Get("channel") != "D01" || sent[1].Has("thread_ts") {
		t.Fatalf("私信回复：%v", sent)
	}
	// @（0.18.0）：mentions 里的「@名字」发出去换成 <@MemberID>，手打的照原样；工作台里记的仍是「@名字」
	code, out = call(t, e.h, "POST", "/api/im/messages/"+ch["id"].(string)+"/reply",
		`{"text":"@Lin Yuan 收到，@王五 也看下","mentions":[{"external_id":"U04LIN","name":"Lin Yuan"}]}`)
	if sent = e.fake.sent(); code != 200 || len(sent) != 3 || sent[2].Get("text") != "<@U04LIN> 收到，@王五 也看下" {
		t.Fatalf("@ 渲染：%d %v", code, sent)
	}
	if rps := out["data"].(map[string]any)["replies"].([]any); rps[len(rps)-1].(map[string]any)["text"] != "@Lin Yuan 收到，@王五 也看下" {
		t.Fatalf("记下的是原文：%v", rps)
	}

	// Token 缺 files:read 时 Slack 回登录页：不能存成文件、标成已获取，要说清缺什么权限
	e.fake.mu.Lock()
	e.fake.noFiles = true
	e.fake.mu.Unlock()
	code, out = call(t, e.h, "POST", "/api/im/messages/"+ch["id"].(string)+"/attachments/F1/fetch", "")
	if code == 200 || !strings.Contains(fmt.Sprint(out), "files:read") {
		t.Fatalf("登录页应当判失败并提示 files:read：%d %v", code, out)
	}
	e.fake.mu.Lock()
	e.fake.noFiles = false
	e.fake.mu.Unlock()

	// 附件带 Bot Token 下载
	code, out = call(t, e.h, "POST", "/api/im/messages/"+ch["id"].(string)+"/attachments/F1/fetch", "")
	if code != 200 || out["data"].(map[string]any)["attachments"].([]any)[0].(map[string]any)["fetch"] != "done" {
		t.Fatalf("附件获取：%d %v", code, out)
	}
}

// 列出来的会话里有读不到历史的：私信跳过、不置异常；监听频道读不到记成异常并写明是哪个。别的会话照收。
func TestSlackUnreadableConversation(t *testing.T) {
	e := setupSlack(t)
	e.fake.convs = []map[string]any{{"id": "C01", "name": "product"}, {"id": "D01", "is_im": true, "user": "U09ZHOU"},
		{"id": "D02", "is_im": true, "user": "U00GONE"}}
	e.fake.broken = map[string]bool{"D02": true}
	c := e.connect(t, 0) // 间隔 0：后台不定时拉，免得抢在立即同步前面
	ctx := context.Background()
	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 2 {
		t.Fatalf("私信读不到时同步：%d %v", code, out)
	}
	if cn, _ := e.conns.Get(ctx, c.ID); cn.Status != "connected" || cn.Error != "" {
		t.Fatalf("私信读不到不该置异常：%+v", cn)
	}

	e.fake.mu.Lock()
	e.fake.broken["C01"] = true
	e.fake.history["D01"] = append(e.fake.history["D01"], map[string]any{"type": "message", "user": "U09ZHOU", "text": "再一条", "ts": "1761700500.000100"})
	e.fake.mu.Unlock()
	code, out = call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 1 {
		t.Fatalf("频道读不到时别的会话照收：%d %v", code, out)
	}
	if cn, _ := e.conns.Get(ctx, c.ID); cn.Status != "error" || !strings.Contains(cn.Error, "#product（C01）") {
		t.Fatalf("监听频道读不到应记异常并写明频道：%+v", cn)
	}
}

func TestSlackInvalidAuthMarksError(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 5)
	ctx := context.Background()
	e.fake.setRevoked(true)
	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if code != 502 || out["error"].(map[string]any)["code"] != "sync_failed" || !strings.Contains(out["error"].(map[string]any)["message"].(string), "invalid_auth") {
		t.Fatalf("Token 失效：%d %v", code, out)
	}
	cn, _ := e.conns.Get(ctx, c.ID)
	if cn.Status != "error" || !strings.Contains(cn.Error, "invalid_auth") || strings.Contains(cn.Error, "xoxb-good") {
		t.Fatalf("应置为异常并写原因：%+v", cn)
	}
	// Token 恢复后回调照收
	e.fake.setRevoked(false)
	e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"D01","channel_type":"im","user":"U09ZHOU","text":"在吗","ts":"1761700300.0"}}`, "")
	_, got := list(t, e.h, "")
	m := got["D01:1761700300.0"]
	if m == nil {
		t.Fatalf("回调应照收：%v", got)
	}
	// 回调成功后连接器恢复
	cn, _ = e.conns.Get(ctx, c.ID)
	if cn.Status != "connected" || cn.Error != "" {
		t.Fatalf("恢复后：%+v", cn)
	}
	// 暂停时同步 409、回调 200 不落库
	off := false
	if _, err := e.conns.Update(ctx, c.ID, connector.Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 409 || out["error"].(map[string]any)["reason"] != "connector_paused" {
		t.Fatalf("暂停时同步：%d %v", code, out)
	}
	if code, _ := e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"D01","channel_type":"im","user":"U09ZHOU","text":"x","ts":"1761700301.0"}}`, ""); code != 200 {
		t.Fatalf("暂停时回调应 200：%d", code)
	}
	if e.sl.Due(ctx, time.Now().Add(time.Hour)) {
		t.Fatal("暂停时后台不该拉")
	}
}

func TestSlackPlainText(t *testing.T) {
	s := NewSlack(SlackOptions{})
	s.users["U1"] = "Lin"
	s.convs["C9"] = slackConv{ID: "C9", Name: "ops"}
	got := s.plainText("<@U1> <@U2|zhou> 看 <#C9> 和 <#C8|dev>，<!channel> <!subteam^S1|@fe> &lt;b&gt; &amp; <https://a.b> <https://a.b|链接>")
	want := "@Lin @zhou 看 #ops 和 #dev，@channel @fe <b> & https://a.b 链接 (https://a.b)"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if splitChannels(" #product，feedback、#product C01") == nil || len(splitChannels("#a, b、a")) != 2 {
		t.Fatal("splitChannels")
	}
	if !tsTime("1761700000.000100").Equal(time.Unix(1761700000, 100000).UTC()) {
		t.Fatal("tsTime")
	}
}

// 反馈机器人这类消息 text 是空的，内容在旧版 attachments 或 blocks 里，发送人只有 bot_id：正文、名字都要取出来
func TestSlackCardMessages(t *testing.T) {
	s := NewSlack(SlackOptions{})
	s.users["U1"] = "Lin"
	cv := slackConv{ID: "C1", Name: "feedback"}
	var card slackMsg
	if err := json.Unmarshal([]byte(`{"type":"message","subtype":"bot_message","bot_id":"B1","text":"","ts":"1761700000.000100","channel":"C1",
		"attachments":[{"fallback":"新用户反馈","pretext":":postbox: 新用户反馈 · :bug: Bug","text":"用户：a@b.com\n反馈内容：读取失败 &amp; 报错\n• <https://x.y/log.txt|日志>",
		"fields":[{"title":"页面","value":"-"}]}]}`), &card); err != nil {
		t.Fatal(err)
	}
	in, ok := s.toIncoming("cn", connector.SlackIdentity{}, "", "", cv, true, card)
	if !ok || in.SenderID != "B1" {
		t.Fatalf("机器人卡片应当收下：%v %+v", ok, in)
	}
	want := ":postbox: 新用户反馈 · :bug: Bug\n用户：a@b.com\n反馈内容：读取失败 & 报错\n• 日志 (https://x.y/log.txt)\n页面：-"
	if in.Text != want {
		t.Fatalf("卡片正文\ngot  %q\nwant %q", in.Text, want)
	}
	// 没有正文、只有 fallback 的卡片用 fallback；名字取 bot_profile
	card.Attachments = []slackAttachment{{Fallback: "只有摘要"}}
	card.BotProfile = &struct {
		Name string `json:"name"`
	}{Name: "反馈助手"}
	if in, _ := s.toIncoming("cn", connector.SlackIdentity{}, "", "", cv, true, card); in.Text != "只有摘要" || in.SenderName != "反馈助手" {
		t.Fatalf("fallback / bot_profile：%+v", in)
	}

	var blk slackMsg
	if err := json.Unmarshal([]byte(`{"type":"message","user":"U1","text":"","ts":"1761700001.000100","channel":"C1","blocks":[
		{"type":"header","text":{"type":"plain_text","text":"周报"}},
		{"type":"section","text":{"type":"mrkdwn","text":"本周完成 3 项"},"fields":[{"type":"mrkdwn","text":"*负责人* <@U1>"}]},
		{"type":"divider"},
		{"type":"context","elements":[{"type":"mrkdwn","text":"来自工作流"},{"type":"image","image_url":"x"}]},
		{"type":"rich_text","elements":[{"type":"rich_text_section","elements":[{"type":"text","text":"请 "},{"type":"user","user_id":"U1"},{"type":"text","text":" 看 "},{"type":"link","url":"https://a.b","text":"这里"}]},
			{"type":"rich_text_list","elements":[{"type":"rich_text_section","elements":[{"type":"text","text":"一"}]},{"type":"rich_text_section","elements":[{"type":"text","text":"二"}]}]}]}]}`), &blk); err != nil {
		t.Fatal(err)
	}
	in, _ = s.toIncoming("cn", connector.SlackIdentity{}, "", "", cv, true, blk)
	want = "周报\n本周完成 3 项\n*负责人* @Lin\n来自工作流\n请 @Lin 看 这里 (https://a.b)\n• 一\n• 二"
	if in.Text != want {
		t.Fatalf("blocks 正文\ngot  %q\nwant %q", in.Text, want)
	}
	// text 有内容时不再拼 blocks（blocks 只是同一段话的富文本版）
	blk.Text = "原文"
	if in, _ := s.toIncoming("cn", connector.SlackIdentity{}, "", "", cv, true, blk); in.Text != "原文" {
		t.Fatalf("有 text 时：%q", in.Text)
	}
}

// 以前没解析出来的空正文，按消息编号回 Slack 重取补上：只改正文为空的，不新增消息、不动别的
func TestSlackRefill(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 5)
	ctx := context.Background()
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("同步：%d %v", code, out)
	}
	// 模拟老版本落库：私信那条正文、发送人是空的；对方那边其实是一张卡片
	if _, err := e.d.W.ExecContext(ctx, `UPDATE im_messages SET text = '', sender_name = '' WHERE external_id = 'D01:1761700004.000100'`); err != nil {
		t.Fatal(err)
	}
	e.fake.mu.Lock()
	e.fake.history["D01"][0] = map[string]any{"type": "message", "subtype": "bot_message", "bot_id": "B9", "text": "", "ts": "1761700004.000100",
		"bot_profile": map[string]any{"name": "反馈助手"}, "attachments": []map[string]any{{"pretext": "新反馈", "text": "页面打不开"}}}
	// 不在库里的新消息：补全不能把它收进来
	e.fake.history["D01"] = append(e.fake.history["D01"], map[string]any{"type": "message", "user": "U09ZHOU", "text": "新的", "ts": "1761700009.000100"})
	e.fake.mu.Unlock()

	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/refill", "")
	res, _ := out["data"].(map[string]any)
	if code != 200 || res["checked"] != float64(1) || res["filled"] != float64(1) {
		t.Fatalf("补全：%d %v", code, out)
	}
	n, got := list(t, e.h, "")
	m := got["D01:1761700004.000100"]
	if n != 2 || m == nil || m["text"] != "新反馈\n页面打不开" || m["sender_name"] != "反馈助手" {
		t.Fatalf("补全后：%d %v", n, m)
	}
	// 再补一次没有可补的
	if _, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/refill", ""); out["data"].(map[string]any)["checked"] != float64(0) {
		t.Fatalf("第二次：%v", out)
	}
}

// 以本人身份接入（IM-06）：收 xoxp- 的 User Token，auth.test 回的本人当「我」；本人自己发的不进待处理，
// 记成会话里最近一条消息的回复；@本人 算 @我（没填 Member ID）；回复用 User Token 发出；回调照常验签。
func TestSlackUserIdentity(t *testing.T) {
	e := setupSlack(t)
	ctx := context.Background()
	e.fake.history = map[string][]map[string]any{
		"C01": {
			{"type": "message", "user": "U04LIN", "text": "<@U0EXAMPLE> 权限点看下", "ts": "1761700000.000100"},
			{"type": "message", "user": "U0EXAMPLE", "text": "好的我看", "ts": "1761700001.000100"},
		},
		"C02": {{"type": "message", "user": "U04LIN", "text": "不监听的频道", "ts": "1761700003.000100"}},
		"D01": {
			{"type": "message", "user": "U09ZHOU", "text": "预发好了", "ts": "1761700004.000100"},
			{"type": "message", "user": "U0EXAMPLE", "text": "收到", "ts": "1761700005.000100"},
		},
	}
	every := 0 // 不让后台定时拉抢在立即同步前面
	c, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &every,
		Config:  map[string]string{"identity": connector.SlackAsUser, "channels": "#product"},
		Secrets: map[string]string{"bot_token": "xoxp-me", "signing_secret": "sig-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := e.conns.Test(ctx, c.ID)
	if err != nil || !res.OK || res.Account != "broleez（U0EXAMPLE）" {
		t.Fatalf("本人身份连通测试：%+v %v", res, err)
	}

	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 2 {
		t.Fatalf("本人身份同步：%d %v", code, out)
	}
	n, got := list(t, e.h, "")
	ch, dm := got["C01:1761700000.000100"], got["D01:1761700004.000100"]
	if n != 2 || ch == nil || dm == nil {
		t.Fatalf("本人发的不该进来，应只有别人的两条：%d %v", n, got)
	}
	if ch["relevance"] != "me" || ch["status"] != "pending" {
		t.Fatalf("@本人 应算 @我、状态不动：%v", ch)
	}
	rps := ch["replies"].([]any)
	if len(rps) != 1 || rps[0].(map[string]any)["text"] != "好的我看" || rps[0].(map[string]any)["external_id"] != "C01:1761700001.000100" || ch["read"] != true {
		t.Fatalf("本人在 Slack 里回的应记成回复并标已读：%v", ch)
	}

	// 从工作台回复：用 User Token 发出；拉回来时同一条不重复记
	code, out = call(t, e.h, "POST", "/api/im/messages/"+dm["id"].(string)+"/reply", `{"text":"好"}`)
	if code != 200 {
		t.Fatalf("回复：%d %v", code, out)
	}
	if by := e.fake.postedBy; len(by) != 1 || by[0] != "xoxp-me" {
		t.Fatalf("应以本人 Token 发：%v", by)
	}
	e.fake.add("D01", map[string]any{"type": "message", "user": "U0EXAMPLE", "text": "好", "ts": "1761709999.000100"})
	call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", "")
	_, got = list(t, e.h, "")
	if rps := got["D01:1761700004.000100"]["replies"].([]any); len(got) != 2 || len(rps) != 2 {
		t.Fatalf("Slack 里的「收到」和工作台的「好」各一条，不重复：%v", got["D01:1761700004.000100"])
	}

	// 回调：本人发的记成回复，别人的照收
	e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"C01","channel_type":"channel","user":"U0EXAMPLE","text":"看完了","ts":"1761700100.0"}}`, "")
	code, out = e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"C01","channel_type":"channel","user":"U04LIN","text":"多谢","ts":"1761700101.0"}}`, "")
	if code != 200 || len(out["data"].(map[string]any)["ids"].([]any)) != 1 {
		t.Fatalf("本人身份回调：%d %v", code, out)
	}
	_, got = list(t, e.h, "")
	if rps := got["C01:1761700000.000100"]["replies"].([]any); len(got) != 3 || len(rps) != 2 {
		t.Fatalf("回调里本人发的应记成回复：%v", got)
	}

	// 工作台回复发出后、落库前，本人这条已经经回调推回来：只记一条，记在被回复的那条上
	e.fake.postTS = "1761710500.000100"
	e.fake.onPost = func() {
		e.signed(t, `{"type":"event_callback","event":{"type":"message","channel":"D01","channel_type":"im","user":"U0EXAMPLE","text":"再确认下","ts":"1761710500.000100"}}`, "")
	}
	code, out = call(t, e.h, "POST", "/api/im/messages/"+dm["id"].(string)+"/reply", `{"text":"再确认下"}`)
	e.fake.onPost, e.fake.postTS = nil, ""
	if code != 200 {
		t.Fatalf("回复：%d %v", code, out)
	}
	_, got = list(t, e.h, "")
	same := 0
	for _, rp := range got["D01:1761700004.000100"]["replies"].([]any) {
		if rp.(map[string]any)["external_id"] == "D01:1761710500.000100" {
			same++
		}
	}
	if same != 1 {
		t.Fatalf("回复和推回来的本人消息是同一条，应只记一次：%v", got["D01:1761700004.000100"]["replies"])
	}

	// 身份是我本人却填了 Bot Token：不调对方，提示要 xoxp-
	if _, err := e.conns.Update(ctx, c.ID, connector.Patch{Secrets: map[string]string{"bot_token": "xoxb-good"}}); err != nil {
		t.Fatal(err)
	}
	calls := e.fake.calls["auth.test"]
	if res, _ = e.conns.Test(ctx, c.ID); res.OK || !strings.Contains(res.Message, "xoxp-") || e.fake.calls["auth.test"] != calls {
		t.Fatalf("我本人填 Bot Token：%+v", res)
	}
	// 身份只能是两项之一
	if _, err := e.conns.Update(ctx, c.ID, connector.Patch{Config: map[string]string{"identity": "admin"}}); err == nil {
		t.Fatal("身份写错应拒绝")
	}
}

// 本人身份一列几百个私信（TSK-0304）：不活跃的私信每轮至多查 slackIdleBudget 个、按上次查过的时间轮流，
// 几轮下来都查到；被限流时这一轮停下，不置异常、不记「部分会话没拉到」，下一轮接着拉。
func TestSlackManyConversationsAndRateLimit(t *testing.T) {
	fake := newFakeSlack()
	const n = 30
	fake.convs = nil
	fake.history = map[string][]map[string]any{}
	for i := range n {
		id := fmt.Sprintf("D%03d", i)
		fake.convs = append(fake.convs, map[string]any{"id": id, "is_im": true, "user": "U09ZHOU"})
		fake.history[id] = []map[string]any{{"type": "message", "user": "U09ZHOU", "text": "很久以前的 " + id, "ts": fmt.Sprintf("1761700%03d.000100", i)}}
	}
	e := setupSlackOn(t, fake, fake)
	ctx := context.Background()
	every := 0
	c, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &every,
		Config:  map[string]string{"identity": connector.SlackAsUser},
		Secrets: map[string]string{"bot_token": "xoxp-me", "signing_secret": "sig-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	history := func() int {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.calls["conversations.history"]
	}
	sync := func(round string) {
		t.Helper()
		if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
			t.Fatalf("%s 同步：%d %v", round, code, out)
		}
		if cn, _ := e.conns.Get(ctx, c.ID); cn.Status == connector.StatusError {
			t.Fatalf("%s 不该置为异常：%q", round, cn.Error)
		}
	}

	sync("第一轮")
	if got := history(); got != slackIdleBudget {
		t.Fatalf("第一轮不活跃私信应只查 %d 个，实际 %d", slackIdleBudget, got)
	}
	sync("第二轮")
	if got, _ := list(t, e.h, ""); got != n {
		t.Fatalf("两轮下来 %d 个私信都该查到（没查过的先查），实际收到 %d 条", n, got)
	}

	// 第三轮读到第 5 个会话时限流：停下，不再往下读，连接器照常
	before := history()
	fake.mu.Lock()
	fake.limitAt = before + 4
	fake.mu.Unlock()
	sync("限流那轮")
	if got := history() - before; got != 5 {
		t.Fatalf("限流后应停下，这一轮共读 5 次（第 5 次 429），实际 %d", got)
	}
	if cn, _ := e.conns.Get(ctx, c.ID); cn.Error != "" {
		t.Fatalf("限流不该记原因：%q", cn.Error)
	}
}

// 活跃会话多到一轮读不完时（限流总在同一处截断），上一轮没轮到的这一轮排前面，不会有会话永远拉不到。
func TestSlackPullOrderRotatesActive(t *testing.T) {
	now := time.Now()
	recent := fmt.Sprintf("%d.000100", now.Add(-time.Hour).Unix())
	cur := slackCursor{Latest: map[string]string{}, Checked: map[string]int64{}}
	var convs []slackConv
	for i := range 5 {
		id := fmt.Sprintf("D%d", i)
		convs = append(convs, slackConv{ID: id, IsIM: true})
		cur.Latest[id] = recent
	}
	cur.Checked["D0"], cur.Checked["D1"], cur.Checked["D2"] = now.Unix(), now.Unix(), now.Unix() // 上一轮读到 D2 被限流
	var got []string
	for _, cv := range cur.pullOrder(convs, now) {
		got = append(got, cv.ID)
	}
	if strings.Join(got, ",") != "D3,D4,D0,D1,D2" {
		t.Fatalf("上一轮没轮到的应排前面：%v", got)
	}
}
