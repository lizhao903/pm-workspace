// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// TSK-0724：群组管理「补全消息」。

type slackWatched struct {
	slackEnv
	bus   *events.Bus
	watch *watcher
}

// setupSlackWatched 同 setupSlackOn，另接上事件总线和订阅 im.message_received 的测试插件，好断言补进来的不发事件。
func setupSlackWatched(t *testing.T) slackWatched {
	t.Helper()
	ctx := context.Background()
	fake := newFakeSlack()
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
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), log)
	r.Migrations = plugin.NewSQLMigrationStore(d)
	bus := events.New(r, log)
	r.Events = bus
	r.SetConnectors(conns)
	r.DataDir = t.TempDir()
	defs.SetPluginDefs(r.ConnectorDefs)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	r.SetHTTPTransport(slackRewrite{u})
	sl := NewSlack(SlackOptions{})
	w := &watcher{}
	if err := r.Add(New(sl)); err != nil {
		t.Fatal(err)
	}
	if err := r.Add(w); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, id := range []string{"im", "imwatch"} {
		if err := r.Install(ctx, id, imPerms(id)); err != nil {
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
	return slackWatched{slackEnv: slackEnv{d: d, h: mux, conns: conns, fake: fake, sl: sl}, bus: bus, watch: w}
}

// convID 是会话（渠道编号）在工作台里的 id。
func (e slackWatched) convID(t *testing.T, ext string) string {
	t.Helper()
	var id string
	if err := e.d.R.QueryRowContext(context.Background(), `SELECT id FROM conversations WHERE channel = 'slack' AND external_id = ?`, ext).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestBackfillConversationHistory(t *testing.T) {
	noThreadScanWait(t)
	e := setupSlackWatched(t)
	// #product 30 条，每 2 小时一条：最早 60 小时前，最近 11 条在 24 小时里；第 5 条是被自动忽略的人发的，第 2 条下面有串
	var ts []string
	var h []map[string]any
	for i := 0; i < 30; i++ {
		x := agoTS(time.Duration(30-i)*2*time.Hour, i)
		ts = append(ts, x)
		user := "U04LIN"
		if i == 5 {
			user = "U07MUTE"
		}
		h = append(h, map[string]any{"type": "message", "user": user, "text": "第 " + itoaT(i) + " 条", "ts": x})
	}
	h = append(h, map[string]any{"type": "message", "bot_id": "B0GCAL", "username": "Google Calendar", "text": "会议提醒", "ts": agoTS(time.Hour, 99)})
	e.fake.history = map[string][]map[string]any{"C01": h}
	reply := agoTS(50*time.Hour, 77)
	c := e.connect(t, 0)
	e.syncOK(t, c.ID, "首次接入")
	// 首次接入只拉最近 20 条（含机器人那条）；之后才有串，免得同步时就把串拉了
	e.fake.addReply("C01", ts[2], map[string]any{"user": "U09ZHOU", "text": "串里的老回复", "ts": reply, "parent_user_id": "U04LIN"})
	n, got := list(t, e.h, "")
	if n != 20 {
		t.Fatalf("首次接入应只有最近 20 条：%d", n)
	}
	// 一条已收的正文是空的（早先没解析出来）
	exec(t, e.d, `UPDATE im_messages SET text = '' WHERE external_id = 'C01:`+ts[25]+`'`)
	if code, out := call(t, e.h, "POST", "/api/im/mutes", `{"channel":"slack","sender_id":"U07MUTE"}`); code != 201 {
		t.Fatalf("自动忽略：%d %v", code, out)
	}
	e.bus.Wait(time.Second)
	before := len(e.watch.events())
	cid := e.convID(t, "C01")

	// 不对的范围、cursor
	if code, _ := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=90d", ""); code != 400 {
		t.Fatalf("range 不对应 400：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?cursor=not-a-cursor", ""); code != 400 {
		t.Fatalf("cursor 不对应 400：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/im/conversations/cv_nope/backfill", ""); code != 404 {
		t.Fatalf("会话不存在应 404：%d", code)
	}

	code, out := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=7d", "")
	if code != 200 {
		t.Fatalf("补全：%d %v", code, out)
	}
	d := out["data"].(map[string]any)
	// 新补 i=0..10 共 11 条（首次接入的 20 条含机器人那条）+ 串里 1 条；已有 20 条去重；补上 1 条正文；
	// 都早于 24 小时：除被忽略的 1 条外都落成已过期
	if d["added"] != 12.0 || d["duplicates"] != 20.0 || d["bodies_filled"] != 1.0 || d["muted"] != 1.0 || d["expired"] != 11.0 ||
		d["threads_checked"] != 1.0 || d["complete"] != true || d["limited"] != false || d["cursor"] != "" || d["scanned"] != 31.0 {
		t.Fatalf("补全结果：%v", d)
	}
	e.bus.Wait(time.Second)
	if n := len(e.watch.events()) - before; n != 0 {
		t.Fatalf("补进来的历史不发 im.message_received：%d", n)
	}
	n, got = list(t, e.h, "")
	if n != 32 {
		t.Fatalf("应共 32 条：%d", n)
	}
	for i := 0; i < 11; i++ {
		m := got["C01:"+ts[i]]
		want := "expired"
		if i == 5 {
			want = "ignored"
		}
		if m["status"] != want || m["read"] != true {
			t.Fatalf("第 %d 条应为 %s、已读：%v %v", i, want, m["status"], m["read"])
		}
	}
	if m := got["C01:"+reply]; m == nil || m["status"] != "expired" || m["thread"] == nil {
		t.Fatalf("串里的老回复：%v", m)
	}
	if m := got["C01:"+ts[25]]; m["text"] != "第 25 条" || m["status"] != "pending" {
		t.Fatalf("空正文应补上、状态不动：%v", m)
	}
	// 会话统计：未读不变（补进来的都已读），待处理不加
	code, out = call(t, e.h, "GET", "/api/im/conversations/summary", "")
	if code != 200 {
		t.Fatal(code)
	}
	for _, x := range out["data"].([]any) {
		s := x.(map[string]any)
		if s["conversation_id"] == cid && (s["unread"] != 20.0 || s["pending"] != 20.0 || s["can_backfill"] != true || s["backfill_note"] != "") {
			t.Fatalf("会话统计：%v", s)
		}
	}
	// 再补一次：都去重
	if _, out := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=all", ""); out["data"].(map[string]any)["added"] != 0.0 {
		t.Fatalf("再补应不新增：%v", out)
	}

	// 成员：机器人标出来
	_, out = call(t, e.h, "GET", "/api/im/conversations/"+cid+"/members", "")
	bots := 0
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		if m["is_bot"] == true {
			bots++
			if m["external_id"] != "B0GCAL" {
				t.Fatalf("只有 B0GCAL 是机器人：%v", m)
			}
		}
	}
	if bots != 1 {
		t.Fatalf("应认出 1 个机器人：%v", out)
	}
}

func TestBackfillConversationRateLimited(t *testing.T) {
	e := setupSlackWatched(t)
	old := historyPageSize
	historyPageSize = 5
	t.Cleanup(func() { historyPageSize = old })
	var h []map[string]any
	for i := 0; i < 30; i++ {
		h = append(h, map[string]any{"type": "message", "user": "U04LIN", "text": "第 " + itoaT(i) + " 条", "ts": agoTS(time.Duration(30-i)*time.Hour, i)})
	}
	e.fake.history = map[string][]map[string]any{"C01": h}
	c := e.connect(t, 0)
	e.syncOK(t, c.ID, "首次接入")
	cid := e.convID(t, "C01")
	// 第 3 页撞上限流：停下，拿到的先落库，回 cursor
	e.fake.mu.Lock()
	e.fake.limitAt = e.fake.calls["conversations.history"] + 2
	e.fake.mu.Unlock()
	code, out := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=30d", "")
	d := out["data"].(map[string]any)
	if code != 200 || d["limited"] != true || d["complete"] != false || d["cursor"] == "" || d["scanned"] != 10.0 {
		t.Fatalf("限流：%d %v", code, d)
	}
	added := d["added"].(float64)
	e.fake.mu.Lock()
	e.fake.limitAt = 0
	e.fake.mu.Unlock()
	code, out = call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=30d&cursor="+d["cursor"].(string), "")
	d = out["data"].(map[string]any)
	if code != 200 || d["complete"] != true || d["cursor"] != "" || d["scanned"] != 20.0 || added+d["added"].(float64) != 10 {
		t.Fatalf("接着补：%d %v（前次新增 %v）", code, d, added)
	}
	n, got := list(t, e.h, "")
	if n != 30 {
		t.Fatalf("应补齐 30 条：%d", n)
	}
	// 补进来的：24 小时内的待处理但已读，更早的已过期
	for i := 0; i < 10; i++ {
		var m map[string]any
		for _, x := range got {
			if x["text"] == "第 "+itoaT(i)+" 条" {
				m = x
			}
		}
		switch {
		case m == nil || m["read"] != true:
			t.Fatalf("第 %d 条应已读：%v", i, m)
		case i >= 7 && m["status"] != "pending", i < 6 && m["status"] != "expired":
			t.Fatalf("第 %d 条状态：%v", i, m["status"])
		}
	}

	// range=all 有累计上限
	oldMax := historyAllCap
	historyAllCap = 7
	t.Cleanup(func() { historyAllCap = oldMax })
	_, out = call(t, e.h, "POST", "/api/im/conversations/"+cid+"/backfill?range=all", "")
	if d := out["data"].(map[string]any); d["capped"] != true || d["complete"] != true || d["scanned"] != 7.0 {
		t.Fatalf("全部到上限应停：%v", d)
	}
}

func TestBackfillConversationUnsupported(t *testing.T) {
	e := setupSlackWatched(t)
	exec(t, e.d,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_tg', 'telegram', '-100', 'group', '产品群', 'x', 'x')`,
		`INSERT INTO im_messages (id, channel, connector_id, external_id, conversation_id, conversation_external_id, conversation_kind, conversation_name,
		  sender_external_id, sender_name, text, attachments, relevance, sent_at, received_at, adapter, status)
		  VALUES ('msg_tg', 'telegram', 'con_tg', '-100:1', 'cv_tg', '-100', 'group', '产品群', 'alice', 'Alice', 'hi', '[]', '', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'telegram', 'pending')`,
	)
	code, out := call(t, e.h, "POST", "/api/im/conversations/cv_tg/backfill", "")
	if code != 409 {
		t.Fatalf("Telegram 应 409：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/im/conversations/summary", "")
	for _, x := range out["data"].([]any) {
		s := x.(map[string]any)
		if s["conversation_id"] == "cv_tg" && (s["can_backfill"] != false || s["backfill_note"] == "") {
			t.Fatalf("Telegram 会话应置灰并说明：%v", s)
		}
	}
}

func TestBotAndSelfSender(t *testing.T) {
	if !botSender("slack", "B0GCAL") || botSender("slack", "U04LIN") || !botSender("telegram", "deploy_Bot") || botSender("telegram", "alice") {
		t.Fatal("认机器人")
	}
	if !selfSender([]string{"pmw", "UBOT"}, "ubot", "") || !selfSender([]string{"Broleez"}, "U1", "broleez") || selfSender([]string{"Broleez"}, "U1", "") {
		t.Fatal("认自己")
	}
}

func itoaT(i int) string { return string(rune('0'+i/10)) + string(rune('0'+i%10)) }
