// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// 同一工具接多个实例（IM-01d）：两个 Slack 工作区、两个 Telegram Bot。

// slackWorkspaces 按 Bot Token 把请求分派到各工作区的假 Slack；认不出的给第一个（由它回 invalid_auth）。
type slackWorkspaces struct{ ws []*fakeSlack }

func (m slackWorkspaces) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	for _, f := range m.ws {
		if auth == "Bearer "+f.token {
			f.ServeHTTP(w, r)
			return
		}
	}
	m.ws[0].ServeHTTP(w, r)
}

// newSecondWorkspace 是第二个工作区 T2：Bot 在 #design（C11）和一个私信（D11）里。
func newSecondWorkspace() *fakeSlack {
	return &fakeSlack{token: "xoxb-two", team: "T2", calls: map[string]int{},
		convs: []map[string]any{{"id": "C11", "name": "design"}, {"id": "D11", "is_im": true, "user": "U21WU"}},
		history: map[string][]map[string]any{
			"C11": {{"type": "message", "user": "U21WU", "text": "设计稿更新了", "ts": "1761700010.000100"}},
			"D11": {{"type": "message", "user": "U21WU", "text": "私信一句", "ts": "1761700011.000100"}},
		}}
}

func (e slackEnv) signedWith(t *testing.T, secret, body string) (int, map[string]any) {
	t.Helper()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req := httptest.NewRequest("POST", "/api/im/callbacks/slack", strings.NewReader(body))
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", connector.SlackSign(secret, ts, []byte(body)))
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestSlackTwoWorkspaces(t *testing.T) {
	f1, f2 := newFakeSlack(), newSecondWorkspace()
	e := setupSlackOn(t, f1, slackWorkspaces{[]*fakeSlack{f1, f2}})
	ctx := context.Background()
	a := e.connect(t, 5)
	five := 5
	b, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &five,
		Config:  map[string]string{"channels": "#design"},
		Secrets: map[string]string{"bot_token": "xoxb-two", "signing_secret": "sig-two"}})
	if err != nil {
		t.Fatal(err)
	}

	// 回调：按签名认实例，各归各的连接器
	evA := `{"type":"event_callback","team_id":"T1","event":{"type":"message","channel":"D01","channel_type":"im","user":"U09ZHOU","text":"A 的私信","ts":"1761700500.0"}}`
	evB := `{"type":"event_callback","team_id":"T2","event":{"type":"message","channel":"D11","channel_type":"im","user":"U21WU","text":"B 的私信","ts":"1761700501.0"}}`
	if code, out := e.signedWith(t, "sig-secret", evA); code != 200 {
		t.Fatalf("A 回调：%d %v", code, out)
	}
	if code, out := e.signedWith(t, "sig-two", evB); code != 200 {
		t.Fatalf("B 回调：%d %v", code, out)
	}
	if code, _ := e.signedWith(t, "sig-other", evB); code != 401 {
		t.Fatalf("两个实例的签名都对不上应 401：%d", code)
	}
	_, got := list(t, e.h, "")
	if got["D01:1761700500.0"]["connector_id"] != a.ID || got["D11:1761700501.0"]["connector_id"] != b.ID {
		t.Fatalf("回调应归到各自连接器：%v", got)
	}

	// 立即同步只拉指定的实例
	_, out := call(t, e.h, "POST", "/api/im/connectors/"+b.ID+"/sync", "")
	if ids := out["data"].(map[string]any)["ids"].([]any); len(ids) != 2 {
		t.Fatalf("B 立即同步应收 #design 一条、私信一条：%v", out)
	}
	if f1.calls["conversations.history"] != 0 {
		t.Fatalf("同步 B 不该拉 A：%v", f1.calls)
	}
	_, out = call(t, e.h, "POST", "/api/im/connectors/"+a.ID+"/sync", "")
	if ids := out["data"].(map[string]any)["ids"].([]any); len(ids) != 2 {
		t.Fatalf("A 立即同步：%v", out)
	}
	_, got = list(t, e.h, "")
	for ext, want := range map[string]string{"C01:1761700000.000100": a.ID, "D01:1761700004.000100": a.ID,
		"C11:1761700010.000100": b.ID, "D11:1761700011.000100": b.ID} {
		if m := got[ext]; m == nil || m["connector_id"] != want {
			t.Fatalf("%s 应归到 %s：%v", ext, want, m)
		}
	}
	if got["C11:1761700010.000100"]["conversation"] != "#design" {
		t.Fatalf("B 的频道名：%v", got["C11:1761700010.000100"])
	}
	for _, id := range []string{a.ID, b.ID} {
		if cn, _ := e.conns.Get(ctx, id); cn.LastSyncAt == nil || cn.Status != "connected" {
			t.Fatalf("各自记同步结果：%+v", cn)
		}
	}

	// 后台一轮：两个实例都到点，各拉各的，进度按实例分开存
	e.sl.mu.Lock()
	e.sl.lastPull = map[string]time.Time{}
	e.sl.mu.Unlock()
	if !e.sl.Due(ctx, time.Now()) {
		t.Fatal("两个实例都没拉过，应到点")
	}
	msgs, cur, err := e.sl.Pull(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]int{}
	for _, m := range msgs {
		by[m.ConnectorID]++
	}
	if by[a.ID] != 2 || by[b.ID] != 2 {
		t.Fatalf("后台一轮应各收 2 条：%v", by)
	}
	if cs := readCursors(cur); cs[a.ID] == nil || cs[b.ID] == nil {
		t.Fatalf("进度应按实例存：%s", cur)
	}

	// 一个实例 Token 失效不耽误另一个
	f2.setRevoked(true)
	e.sl.mu.Lock()
	e.sl.lastPull = map[string]time.Time{}
	e.sl.mu.Unlock()
	if msgs, _, err = e.sl.Pull(ctx, ""); err != nil || len(msgs) != 2 || msgs[0].ConnectorID != a.ID {
		t.Fatalf("B 失效时 A 照收：%v %v", msgs, err)
	}
	if cn, _ := e.conns.Get(ctx, b.ID); cn.Status != "error" {
		t.Fatalf("B 应置为异常：%+v", cn)
	}
	if cn, _ := e.conns.Get(ctx, a.ID); cn.Status != "connected" {
		t.Fatalf("A 不受影响：%+v", cn)
	}
	f2.setRevoked(false)
	call(t, e.h, "POST", "/api/im/connectors/"+b.ID+"/sync", "") // 同步成功后 B 恢复，才回得了

	// 回复走消息所属的实例
	call(t, e.h, "POST", "/api/im/messages/"+got["C11:1761700010.000100"]["id"].(string)+"/reply", `{"text":"收到"}`)
	if s1, s2 := f1.sent(), f2.sent(); len(s1) != 0 || len(s2) != 1 || s2[0].Get("channel") != "C11" {
		t.Fatalf("回复 B 的消息应走 B：A %v，B %v", s1, s2)
	}
	call(t, e.h, "POST", "/api/im/messages/"+got["D01:1761700004.000100"]["id"].(string)+"/reply", `{"text":"好"}`)
	if s1, s2 := f1.sent(), f2.sent(); len(s1) != 1 || len(s2) != 1 || s1[0].Get("channel") != "D01" {
		t.Fatalf("回复 A 的消息应走 A：A %v，B %v", s1, s2)
	}
}

// 同一个 Slack App 装进两个工作区：Signing Secret 一样，按事件的 team_id 认实例。
func TestSlackSharedSigningSecret(t *testing.T) {
	f1, f2 := newFakeSlack(), newSecondWorkspace()
	e := setupSlackOn(t, f1, slackWorkspaces{[]*fakeSlack{f1, f2}})
	ctx := context.Background()
	a := e.connect(t, 0)
	b, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both",
		Secrets: map[string]string{"bot_token": "xoxb-two", "signing_secret": "sig-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	ev := func(team, ts string) string {
		return `{"type":"event_callback","team_id":"` + team + `","event":{"type":"message","channel":"D11","channel_type":"im","user":"U21WU","text":"x","ts":"` + ts + `"}}`
	}
	if code, out := e.signedWith(t, "sig-secret", ev("T2", "1761700600.0")); code != 200 {
		t.Fatalf("T2 回调：%d %v", code, out)
	}
	if code, out := e.signedWith(t, "sig-secret", ev("T1", "1761700601.0")); code != 200 {
		t.Fatalf("T1 回调：%d %v", code, out)
	}
	code, out := e.signedWith(t, "sig-secret", ev("T9", "1761700602.0"))
	if code != 200 || out["data"].(map[string]any)["ignored"] == nil {
		t.Fatalf("没接入的工作区应 200 不落库：%d %v", code, out)
	}
	_, got := list(t, e.h, "")
	if len(got) != 2 || got["D11:1761700600.0"]["connector_id"] != b.ID || got["D11:1761700601.0"]["connector_id"] != a.ID {
		t.Fatalf("应按 team_id 归实例：%v", got)
	}
}

const tgToken2 = "987654321:AAAnotherFakeTokenForTests_xyz12"

// tgBots 按路径里的 Token 把请求分派到各 Bot 的假 Bot API。
type tgBots struct{ bots []*fakeTelegram }

func (m tgBots) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for _, f := range m.bots {
		tok := f.token
		if tok == "" {
			tok = tgToken
		}
		if strings.HasPrefix(r.URL.Path, "/bot"+tok+"/") || strings.HasPrefix(r.URL.Path, "/file/bot"+tok+"/") {
			f.ServeHTTP(w, r)
			return
		}
	}
	m.bots[0].ServeHTTP(w, r)
}

func TestTelegramTwoBots(t *testing.T) {
	f1, f2 := &fakeTelegram{}, &fakeTelegram{token: tgToken2}
	e := setupTelegramOn(t, "", f1, tgBots{[]*fakeTelegram{f1, f2}})
	ctx := context.Background()
	a := e.addBot(t, tgToken, nil)
	b := e.addBot(t, tgToken2, nil)
	// 同一个人分别私聊两个 Bot：会话 id 都是 555，消息 id 各数各的，撞号
	f1.push(10, tgMsg(2, 555, "private", "", "linyuan", "问 A"))
	f2.push(40, tgMsg(2, 555, "private", "", "linyuan", "问 B"))
	f2.push(41, tgMsg(5, -100300, "supergroup", "设计群", "linyuan", "群里一句"))

	// 立即同步只拉指定的 Bot
	if code, out := e.do(t, http.MethodPost, "/api/im/connectors/"+b.ID+"/sync", ""); code != 200 {
		t.Fatalf("B 立即同步 %d %v", code, out)
	}
	if len(f1.offsets) != 0 {
		t.Fatalf("同步 B 不该拉 A：%v", f1.offsets)
	}
	e.do(t, http.MethodPost, "/api/im/connectors/"+a.ID+"/sync", "")
	rows := map[string]string{}
	rs, err := e.d.R.Query(`SELECT external_id, connector_id FROM im_messages WHERE channel = 'telegram'`)
	if err != nil {
		t.Fatal(err)
	}
	for rs.Next() {
		var ext, cn string
		_ = rs.Scan(&ext, &cn)
		rows[ext] = cn
	}
	_ = rs.Close()
	if len(rows) != 3 || rows["555:2@123456789"] != a.ID || rows["555:2@987654321"] != b.ID || rows["-100300:5"] != b.ID {
		t.Fatalf("两个 Bot 的消息都应落库、归到各自连接器：%v", rows)
	}

	// 后台一轮：两个 Bot 各拉各的，进度按实例分开存；再拉一轮各自接着 offset
	f1.push(11, tgMsg(3, 555, "private", "", "linyuan", "A 新消息"))
	if !e.tg.Due(ctx, time.Now()) {
		t.Fatal("应到点")
	}
	msgs, cur, err := e.tg.Pull(ctx, "")
	if err != nil || len(msgs) != 4 {
		t.Fatalf("从头拉应共 4 条：%d %v", len(msgs), err)
	}
	cs := readCursors(cur)
	var ca, cb tgCursor
	_ = json.Unmarshal(cs[a.ID], &ca)
	_ = json.Unmarshal(cs[b.ID], &cb)
	if ca.Offset != 12 || cb.Offset != 42 {
		t.Fatalf("各自的 offset：A %d，B %d", ca.Offset, cb.Offset)
	}
	e.tg.Due(ctx, time.Now())
	if msgs, _, err := e.tg.Pull(ctx, cur); err != nil || len(msgs) != 0 {
		t.Fatalf("接着拉不该重复：%d %v", len(msgs), err)
	}

	// 回复走消息所属的 Bot
	var idB string
	if err := e.d.R.QueryRow(`SELECT id FROM im_messages WHERE external_id = '555:2@987654321'`).Scan(&idB); err != nil {
		t.Fatal(err)
	}
	if code, out := e.do(t, http.MethodPost, "/api/im/messages/"+idB+"/reply", `{"text":"B 回你"}`); code != 200 {
		t.Fatalf("回复 %d %v", code, out)
	}
	if len(f1.sent) != 0 || len(f2.sent) != 1 || f2.sent[0]["chat_id"] != "555" {
		t.Fatalf("回复应走 B：A %v，B %v", f1.sent, f2.sent)
	}
	if rp, _ := f2.sent[0]["reply_parameters"].(map[string]any); rp["message_id"] != float64(2) {
		t.Fatalf("应串回原消息：%v", f2.sent[0])
	}
}

func TestTelegramWebhookTwoBots(t *testing.T) {
	e := setupTelegram(t, "", &fakeTelegram{})
	hook := map[string]string{"webhook_url": "https://bro.vip"}
	a := e.addBot(t, tgToken, hook)
	b := e.addBot(t, tgToken2, hook)
	body := func(id int) string {
		return `{"update_id": ` + strconv.Itoa(id) + `, "message": {"message_id": 9, "date": 1761700000, "text": "推过来的",
		"chat": {"id": 555, "type": "private"}, "from": {"id": 555, "first_name": "Lin", "username": "linyuan"}}}`
	}
	if code, _ := e.do(t, http.MethodPost, "/api/im/callbacks/telegram", body(30), telegramSecretHdr, "wrong"); code != http.StatusUnauthorized {
		t.Fatalf("都对不上应 401：%d", code)
	}
	if code, out := e.do(t, http.MethodPost, "/api/im/callbacks/telegram", body(30), telegramSecretHdr, webhookSecret(tgToken2)); code != 200 {
		t.Fatalf("B 的回调 %d %v", code, out)
	}
	if code, out := e.do(t, http.MethodPost, "/api/im/callbacks/telegram", body(31), telegramSecretHdr, webhookSecret(tgToken)); code != 200 {
		t.Fatalf("A 的回调 %d %v", code, out)
	}
	var cA, cB string
	_ = e.d.R.QueryRow(`SELECT connector_id FROM im_messages WHERE external_id = '555:9@123456789'`).Scan(&cA)
	_ = e.d.R.QueryRow(`SELECT connector_id FROM im_messages WHERE external_id = '555:9@987654321'`).Scan(&cB)
	if cA != a.ID || cB != b.ID {
		t.Fatalf("按 secret_token 认实例：A=%q B=%q", cA, cB)
	}
}

// 只接一个实例时存的旧进度归到它的实例下，升级后接着拉。
func TestReadCursorsLegacy(t *testing.T) {
	old := `{"connector":"cn_a","bot":"123456789","offset":13}`
	cs := readCursors(old)
	if string(cs["cn_a"]) != old || len(cs) != 1 {
		t.Fatalf("旧进度：%v", cs)
	}
	if cs := readCursors(writeCursors(cs)); string(cs["cn_a"]) != old {
		t.Fatalf("新格式往返：%v", cs)
	}
	if len(readCursors("")) != 0 || len(readCursors("garbage")) != 0 {
		t.Fatal("空、坏的进度从头来")
	}
}
