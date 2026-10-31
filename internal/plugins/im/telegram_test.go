package im

import (
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
	"github.com/lizhao903/pm-workspace/internal/vault"
)

const (
	tgToken    = "123456789:AAFakeTokenForTestsOnly_abcdefgh"
	tgBadToken = "123456789:AAThisTokenWasRevokedByBotFather_x"
)

// fakeTelegram 是本机假 Bot API：updates 按 offset 返回，sendMessage 记下请求，token 不对回 401。
type fakeTelegram struct {
	mu      sync.Mutex
	token   string // 空为 tgToken
	updates []map[string]any
	offsets []float64 // 每次 getUpdates 带的 offset，没带记 -1
	sent    []map[string]any
	webhook string
}

func (f *fakeTelegram) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	want := f.token
	if want == "" {
		want = tgToken
	}
	if strings.HasPrefix(r.URL.Path, "/file/bot"+want+"/") {
		_, _ = io.WriteString(w, "file body")
		return
	}
	tok, method, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/bot"), "/")
	w.Header().Set("Content-Type", "application/json")
	if tok != want {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":401,"description":"Unauthorized"}`)
		return
	}
	var p map[string]any
	_ = json.NewDecoder(r.Body).Decode(&p)
	ok := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": v}) }
	switch method {
	case "getMe":
		ok(map[string]any{"id": 123456789, "is_bot": true, "first_name": "PM Bot", "username": "pm_bot"})
	case "getWebhookInfo":
		ok(map[string]any{"url": f.webhook})
	case "deleteWebhook":
		f.webhook = ""
		ok(true)
	case "setWebhook":
		f.webhook, _ = p["url"].(string)
		ok(true)
	case "getUpdates":
		off, has := p["offset"].(float64)
		if !has {
			off = -1
		}
		f.offsets = append(f.offsets, off)
		out := []map[string]any{}
		for _, u := range f.updates {
			if u["update_id"].(float64) >= off {
				out = append(out, u)
			}
		}
		ok(out)
	case "sendMessage":
		f.sent = append(f.sent, p)
		chat, _ := strconv.ParseInt(fmt.Sprint(p["chat_id"]), 10, 64)
		ok(map[string]any{"message_id": 900 + len(f.sent), "chat": map[string]any{"id": chat}, "date": 1})
	case "getFile":
		ok(map[string]any{"file_id": p["file_id"], "file_path": "photos/a.jpg", "file_size": 9})
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"ok":false,"error_code":404,"description":"Not Found"}`)
	}
}

func (f *fakeTelegram) push(id float64, msg map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, map[string]any{"update_id": id, "message": msg})
}

func tgMsg(id, chat float64, chatType, title, user, text string) map[string]any {
	return map[string]any{"message_id": id, "date": 1761700000, "text": text,
		"chat": map[string]any{"id": chat, "type": chatType, "title": title},
		"from": map[string]any{"id": 555, "is_bot": false, "first_name": "Lin", "last_name": "Yuan", "username": user}}
}

// rewrite 把发往 api.telegram.org 的请求改投到本机假服务；域名检查在它外面照常做。
type rewrite struct{ to *url.URL }

func (rw rewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.URL.Scheme, r2.URL.Host, r2.Host = rw.to.Scheme, rw.to.Host, rw.to.Host
	return http.DefaultTransport.RoundTrip(r2)
}

type tgEnv struct {
	r     *plugin.Registry
	h     http.Handler
	d     *db.DB
	conns *connector.Store
	fake  *fakeTelegram
	tg    *Telegram
	path  string
}

// setupTelegram 在真库上装好 im（带 Telegram 适配器、确认 network:im），接上真的连接器 store 和本机假 Bot API。
// path 给了时用同一个库（模拟重启）。
func setupTelegram(t *testing.T, path string, fake *fakeTelegram) tgEnv {
	t.Helper()
	return setupTelegramOn(t, path, fake, fake)
}

// setupTelegramOn 同 setupTelegram，假 Bot API 换成 h（多个 Bot 时按 Token 分派）。
func setupTelegramOn(t *testing.T, path string, fake *fakeTelegram, h http.Handler) tgEnv {
	t.Helper()
	ctx := context.Background()
	fresh := path == ""
	if fresh {
		path = filepath.Join(t.TempDir(), "pm.db")
	}
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
	defs.SetPluginDefs(r.ConnectorDefs)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	r.SetHTTPTransport(rewrite{u})
	tg := NewTelegram()
	tg.every, tg.poll = time.Hour, 0 // 测试里只经立即同步拉，不长轮询
	if err := r.Add(New(tg)); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if fresh {
		if err := r.Install(ctx, "im", []string{"network:im"}); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, "im"); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return tgEnv{r: r, h: mux, d: d, conns: conns, fake: fake, tg: tg, path: path}
}

func (e tgEnv) addBot(t *testing.T, token string, config map[string]string) *connector.Connector {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: TelegramTool, Direction: "both",
		Config: config, Secrets: map[string]string{"bot_token": token}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (e tgEnv) do(t *testing.T, method, path, body string, hdr ...string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func countMsgs(t *testing.T, d *db.DB) int {
	t.Helper()
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM im_messages WHERE channel = 'telegram'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTelegramConnectorTest(t *testing.T) {
	e := setupTelegram(t, "", &fakeTelegram{webhook: "https://old.example.com/hook"})
	c := e.addBot(t, tgToken, nil)
	res, err := e.conns.Test(context.Background(), c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Account != "PM Bot（@pm_bot）" || res.Connector.Status != connector.StatusConnected {
		t.Fatalf("连通测试：%+v", res)
	}
	if e.fake.webhook != "" {
		t.Fatalf("没填公网地址时应删掉旧 webhook：%q", e.fake.webhook)
	}
	if hint := res.Connector.SecretHints["bot_token"]; hint == "" || strings.Contains(hint, "AAFakeToken") {
		t.Fatalf("Token 只给脱敏提示：%q", hint)
	}
	// 填了公网地址：setWebhook 到回调路径
	if _, err := e.conns.Update(context.Background(), c.ID, connector.Patch{Config: map[string]string{"webhook_url": "https://bro.vip"}}); err != nil {
		t.Fatal(err)
	}
	if res, _ := e.conns.Test(context.Background(), c.ID); !res.OK || e.fake.webhook != "https://bro.vip/api/im/callbacks/telegram" {
		t.Fatalf("webhook：%+v %q", res, e.fake.webhook)
	}
}

func TestTelegramPullOffsetAndRestart(t *testing.T) {
	fake := &fakeTelegram{}
	e := setupTelegram(t, "", fake)
	c := e.addBot(t, tgToken, nil)
	if res, _ := e.conns.Test(context.Background(), c.ID); !res.OK {
		t.Fatalf("连通测试：%+v", res)
	}
	fake.push(10, tgMsg(1, -100200, "supergroup", "产品群", "linyuan", "@pm_bot 看下这个需求"))
	fake.push(11, tgMsg(2, 555, "private", "", "linyuan", "私聊一句"))
	fake.push(12, map[string]any{"message_id": 3, "date": 1, "chat": map[string]any{"id": -100200, "type": "supergroup"},
		"from": map[string]any{"id": 555}, "new_chat_members": []any{}}) // 服务消息，跳过

	code, out := e.do(t, http.MethodPost, "/api/im/connectors/"+c.ID+"/sync", "")
	if code != http.StatusOK {
		t.Fatalf("立即同步 %d %v", code, out)
	}
	if n := countMsgs(t, e.d); n != 2 {
		t.Fatalf("应落 2 条，实际 %d", n)
	}
	var rel, kind, conv, sender string
	if err := e.d.R.QueryRow(`SELECT relevance, conversation_kind, conversation_external_id, sender_external_id FROM im_messages WHERE external_id = '-100200:1'`).
		Scan(&rel, &kind, &conv, &sender); err != nil {
		t.Fatal(err)
	}
	if rel != "me" || kind != "group" || conv != "-100200" || sender != "linyuan" {
		t.Fatalf("群消息：relevance=%s kind=%s conv=%s sender=%s", rel, kind, conv, sender)
	}
	var dm string
	_ = e.d.R.QueryRow(`SELECT relevance FROM im_messages WHERE external_id = '555:2@123456789'`).Scan(&dm)
	if dm != "dm" {
		t.Fatalf("私聊 relevance=%s", dm)
	}
	cn, _ := e.conns.Get(context.Background(), c.ID)
	if cn.LastSyncAt == nil || cn.Status != connector.StatusConnected {
		t.Fatalf("同步后应记同步时间、置为已连接：%+v", cn)
	}

	// 再拉一次：带上 offset=13，什么都不重复
	e.do(t, http.MethodPost, "/api/im/connectors/"+c.ID+"/sync", "")
	if got := fake.offsets[len(fake.offsets)-1]; got != 13 {
		t.Fatalf("第二次应带 offset 13，实际 %v", got)
	}
	// 重启：同一个库换一套注册表，进度从 im_cursors 接着拉
	e.r.Close()
	before := len(fake.offsets)
	fake.push(13, tgMsg(4, 555, "private", "", "linyuan", "重启后的新消息"))
	e2 := setupTelegram(t, e.path, fake)
	// 启用时后台任务先跑一次，可能已经拉过；不管谁先拉，重启后第一次带的都是 13
	e2.do(t, http.MethodPost, "/api/im/connectors/"+c.ID+"/sync", "")
	if got := fake.offsets[before]; got != 13 {
		t.Fatalf("重启后应带 offset 13，实际 %v", got)
	}
	if n := countMsgs(t, e2.d); n != 3 {
		t.Fatalf("重启后应共 3 条、不重复，实际 %d", n)
	}
}

func TestTelegramInvalidTokenMarksError(t *testing.T) {
	e := setupTelegram(t, "", &fakeTelegram{})
	c := e.addBot(t, tgBadToken, nil)
	code, out := e.do(t, http.MethodPost, "/api/im/connectors/"+c.ID+"/sync", "")
	if code != http.StatusOK && code != http.StatusBadGateway && code != http.StatusConflict {
		t.Fatalf("立即同步 %d %v", code, out)
	}
	cn, _ := e.conns.Get(context.Background(), c.ID)
	if cn.Status != connector.StatusError || !strings.Contains(cn.Error, "401") {
		t.Fatalf("Token 失效应置为异常并写原因：%s %q", cn.Status, cn.Error)
	}
	if strings.Contains(cn.Error, "AAThisToken") {
		t.Fatalf("原因里不能有 Token：%q", cn.Error)
	}
}

// 后台拉连不上（网络抖动、休眠醒来）：连续 telegramMissLimit 次才置为异常，之前只记日志；立即同步一次就记。
func TestTelegramTransientFailureTolerated(t *testing.T) {
	drop := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, _, _ := w.(http.Hijacker).Hijack()
		_ = conn.Close()
	})
	e := setupTelegramOn(t, "", &fakeTelegram{}, drop)
	c := e.addBot(t, tgToken, nil)
	ctx := context.Background()
	status := func() *connector.Connector {
		cn, _ := e.conns.Get(ctx, c.ID)
		return cn
	}
	info := func() plugin.ConnectorInfo {
		cn, err := e.tg.c.Connectors().Get(ctx, c.ID)
		if err != nil {
			t.Fatal(err)
		}
		return cn
	}
	for i := 1; i < telegramMissLimit; i++ {
		if _, _, err := e.tg.pullInstance(ctx, info(), nil, true); err == nil {
			t.Fatalf("第 %d 次应连不上", i)
		}
		if cn := status(); cn.Status == connector.StatusError {
			t.Fatalf("第 %d 次偶发连不上不该置为异常：%s %q", i, cn.Status, cn.Error)
		}
	}
	_, _, _ = e.tg.pullInstance(ctx, info(), nil, true)
	if cn := status(); cn.Status != connector.StatusError || !strings.Contains(cn.Error, "连不上 Telegram") {
		t.Fatalf("连续 %d 次连不上应置为异常：%s %q", telegramMissLimit, cn.Status, cn.Error)
	}

	// 立即同步不容忍：换一个新实例，一次就记
	c2 := e.addBot(t, "987654321:AAAnotherFakeTokenForTests_abcd", nil)
	cn2, _ := e.tg.c.Connectors().Get(ctx, c2.ID)
	_, _, _ = e.tg.pullInstance(ctx, cn2, nil, false)
	if cn, _ := e.conns.Get(ctx, c2.ID); cn.Status != connector.StatusError {
		t.Fatalf("立即同步连不上应马上置为异常：%s", cn.Status)
	}
}

func TestTelegramReplyAndFetch(t *testing.T) {
	fake := &fakeTelegram{}
	e := setupTelegram(t, "", fake)
	c := e.addBot(t, tgToken, nil)
	if res, _ := e.conns.Test(context.Background(), c.ID); !res.OK {
		t.Fatalf("连通测试：%+v", res)
	}
	m := tgMsg(7, -100200, "group", "产品群", "linyuan", "")
	m["caption"] = "截图"
	m["photo"] = []any{map[string]any{"file_id": "small", "file_unique_id": "u1", "file_size": 1},
		map[string]any{"file_id": "big", "file_unique_id": "u2", "file_size": 9}}
	fake.push(20, m)
	e.do(t, http.MethodPost, "/api/im/connectors/"+c.ID+"/sync", "")
	var id, atts string
	if err := e.d.R.QueryRow(`SELECT id, attachments FROM im_messages WHERE external_id = '-100200:7'`).Scan(&id, &atts); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(atts, `"file_id":"big"`) {
		t.Fatalf("图片取最大的一张：%s", atts)
	}
	code, out := e.do(t, http.MethodPost, "/api/im/messages/"+id+"/reply", `{"text":"收到"}`)
	if code != http.StatusOK {
		t.Fatalf("回复 %d %v", code, out)
	}
	if len(fake.sent) != 1 || fake.sent[0]["chat_id"] != "-100200" || fake.sent[0]["text"] != "收到" {
		t.Fatalf("sendMessage：%v", fake.sent)
	}
	if rp, _ := fake.sent[0]["reply_parameters"].(map[string]any); rp["message_id"] != float64(7) {
		t.Fatalf("应串回原消息：%v", fake.sent[0])
	}
	rd, err := e.tg.Fetch(context.Background(), AttachmentRef{ConnectorID: c.ID, Raw: json.RawMessage(`{"file_id":"big"}`)})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rd)
	_ = rd.Close()
	if string(b) != "file body" {
		t.Fatalf("下载内容 %q", b)
	}
}

func TestTelegramWebhookSecret(t *testing.T) {
	e := setupTelegram(t, "", &fakeTelegram{})
	e.addBot(t, tgToken, map[string]string{"webhook_url": "https://bro.vip"})
	body := `{"update_id": 30, "message": {"message_id": 9, "date": 1761700000, "text": "推过来的",
		"chat": {"id": 555, "type": "private"}, "from": {"id": 555, "first_name": "Lin", "username": "linyuan"}}}`
	if code, _ := e.do(t, http.MethodPost, "/api/im/callbacks/telegram", body, telegramSecretHdr, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("secret 不对应 401，实际 %d", code)
	}
	if n := countMsgs(t, e.d); n != 0 {
		t.Fatalf("验签不过不落库：%d", n)
	}
	if code, out := e.do(t, http.MethodPost, "/api/im/callbacks/telegram", body, telegramSecretHdr, webhookSecret(tgToken)); code != http.StatusOK {
		t.Fatalf("回调 %d %v", code, out)
	}
	if n := countMsgs(t, e.d); n != 1 {
		t.Fatalf("应落 1 条：%d", n)
	}
}

func TestTelegramToIncoming(t *testing.T) {
	// Bot 自己发的跳过；回复 Bot 的消息算 @我；频道帖子按频道认发送人
	if _, ok := toIncoming("cn", "123456789", tgUpdate{Message: &tgMessage{MessageID: 1, Text: "x",
		Chat: tgChat{ID: 1, Type: "private"}, From: &tgUser{ID: 123456789}}}); ok {
		t.Fatal("Bot 自己发的应跳过")
	}
	in, ok := toIncoming("cn", "123456789", tgUpdate{Message: &tgMessage{MessageID: 2, Text: "好的",
		Chat: tgChat{ID: -1, Type: "group", Title: "群"}, From: &tgUser{ID: 7, FirstName: "A"},
		ReplyTo: &tgMessage{From: &tgUser{ID: 123456789}}}})
	if !ok || in.Mention != "me" || in.SenderID != "7" || in.ConversationName != "群" {
		t.Fatalf("%+v", in)
	}
	in, ok = toIncoming("cn", "1", tgUpdate{ChannelPost: &tgMessage{MessageID: 3, Text: "公告",
		Chat: tgChat{ID: -9, Type: "channel", Title: "频道"}, SenderChat: &tgChat{ID: -9, Title: "频道", Username: "news"}}})
	if !ok || in.SenderID != "news" || in.SenderName != "频道" || in.ExternalID != "-9:3" {
		t.Fatalf("%+v", in)
	}
}
