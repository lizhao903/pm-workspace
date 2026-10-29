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

// fakeSlack 是本机假 Slack Web API：认一个 Bot Token，Bot 在 #product（C01）、#random（C02）和一个私信（D01）里。
type fakeSlack struct {
	mu      sync.Mutex
	token   string
	team    string           // 空为 T1
	convs   []map[string]any // Bot 所在的会话，空为 #product、#random 和一个私信
	revoked bool
	history map[string][]map[string]any // 会话 -> 消息（正序）
	posted  []url.Values
	calls   map[string]int
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{token: "xoxb-good", calls: map[string]int{}, history: map[string][]map[string]any{
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
	if strings.HasPrefix(r.URL.Path, "/files-pri/") {
		if auth != "Bearer "+f.token || f.revoked {
			w.WriteHeader(http.StatusForbidden)
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
	if auth != "Bearer "+f.token || f.revoked {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid_auth"})
		return
	}
	switch method {
	case "auth.test":
		team := f.team
		if team == "" {
			team = "T1"
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
		names := map[string]string{"U04LIN": "Lin Yuan", "U09ZHOU": "Zhou Yu", "UBOT": "pmw", "U07ME": "Broleez"}
		reply(map[string]any{"user": map[string]any{"name": strings.ToLower(r.Form.Get("user")), "profile": map[string]any{"display_name": names[r.Form.Get("user")]}}})
	case "conversations.history":
		oldest, _ := strconv.ParseFloat(r.Form.Get("oldest"), 64)
		limit, _ := strconv.Atoi(r.Form.Get("limit"))
		var out []map[string]any
		h := f.history[r.Form.Get("channel")]
		for i := len(h) - 1; i >= 0 && len(out) < limit; i-- {
			ts, _ := strconv.ParseFloat(h[i]["ts"].(string), 64)
			if ts > oldest {
				out = append(out, h[i])
			}
		}
		reply(map[string]any{"messages": out, "has_more": false})
	case "chat.postMessage":
		f.posted = append(f.posted, r.Form)
		reply(map[string]any{"channel": r.Form.Get("channel"), "ts": "1761709999.000100"})
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
	return slackEnv{h: mux, conns: conns, fake: fake, sl: sl}
}

func (e slackEnv) connect(t *testing.T, interval int) *connector.Connector {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &interval,
		Config:  map[string]string{"channels": "#product", "self_user_id": "U07ME"},
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
		"text":"<!here> 发版了 <@U07ME>","ts":"1761700100.000200"}}`
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

	// 附件带 Bot Token 下载
	code, out = call(t, e.h, "POST", "/api/im/messages/"+ch["id"].(string)+"/attachments/F1/fetch", "")
	if code != 200 || out["data"].(map[string]any)["attachments"].([]any)[0].(map[string]any)["fetch"] != "done" {
		t.Fatalf("附件获取：%d %v", code, out)
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
