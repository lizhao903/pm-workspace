package im

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// 串里的回复（0010）：假 Slack 的 threads 存串里的回复，history 回父消息时带 reply_count、latest_reply。

// agoTS 是 d 之前的 Slack ts；n 区分同一时刻的几条。
func agoTS(d time.Duration, n int) string {
	return fmt.Sprintf("%d.%06d", time.Now().Add(-d).Unix(), n)
}

func noThreadScanWait(t *testing.T) {
	t.Helper()
	old := slackThreadScanEvery
	slackThreadScanEvery = 0
	t.Cleanup(func() { slackThreadScanEvery = old })
}

func (f *fakeSlack) addReply(ch, parent string, m map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.threads == nil {
		f.threads = map[string][]map[string]any{}
	}
	m["thread_ts"] = parent
	if _, ok := m["type"]; !ok {
		m["type"] = "message"
	}
	f.threads[ch+":"+parent] = append(f.threads[ch+":"+parent], m)
}

func (f *fakeSlack) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[method]
}

func (e slackEnv) syncOK(t *testing.T, id, round string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/im/connectors/"+id+"/sync", "")
	if code != 200 {
		t.Fatalf("%s 同步：%d %v", round, code, out)
	}
	if cn, _ := e.conns.Get(context.Background(), id); cn.Status == connector.StatusError {
		t.Fatalf("%s 不该置为异常：%q", round, cn.Error)
	}
	return out["data"].(map[string]any)
}

func (e slackEnv) slackCursor(t *testing.T, id string) slackCursor {
	t.Helper()
	var raw string
	if err := e.d.R.QueryRowContext(context.Background(), `SELECT cursor FROM im_cursors WHERE adapter = 'slack'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var cur slackCursor
	_ = json.Unmarshal(readCursors(raw)[id], &cur)
	return cur
}

func TestSlackThreadReplies(t *testing.T) {
	noThreadScanWait(t)
	e := setupSlack(t)
	p := agoTS(2*time.Hour, 100)
	r1, r2 := agoTS(110*time.Minute, 1), agoTS(100*time.Minute, 2)
	e.fake.history = map[string][]map[string]any{
		"C01": {{"type": "message", "user": "U04LIN", "text": "灰度方案大家看下\n第二行", "ts": p}},
	}
	e.fake.addReply("C01", p, map[string]any{"user": "U09ZHOU", "text": "第一条串里回复", "ts": r1, "parent_user_id": "U04LIN"})
	e.fake.addReply("C01", p, map[string]any{"user": "U09ZHOU", "text": "<@UBOT> 这个要你确认", "ts": r2, "parent_user_id": "U04LIN"})
	c := e.connect(t, 0)

	// 第一轮：新到的父消息带着回复，从头拉这个串
	d := e.syncOK(t, c.ID, "第一轮")
	if n := len(d["ids"].([]any)); n != 3 {
		t.Fatalf("应收父消息和两条串里回复：%v", d)
	}
	if got := e.fake.count("conversations.replies"); got != 1 {
		t.Fatalf("应只查一次串，实际 %d", got)
	}
	_, got := list(t, e.h, "")
	pm, m1, m2 := got["C01:"+p], got["C01:"+r1], got["C01:"+r2]
	if pm == nil || m1 == nil || m2 == nil {
		t.Fatalf("缺消息：%v", got)
	}
	if pm["thread"] != nil || pm["reply_count"].(float64) != 2 {
		t.Fatalf("父消息：thread 应为 null，reply_count 2：%v %v", pm["thread"], pm["reply_count"])
	}
	th := m1["thread"].(map[string]any)
	if th["parent_external_id"] != "C01:"+p || th["parent_message_id"] != pm["id"] || th["parent_sender_name"] != "Lin Yuan" || th["parent_text"] != "灰度方案大家看下 第二行" {
		t.Fatalf("串里回复的 thread：%v", th)
	}
	if m1["conversation"] != "#product" || m1["relevance"] != "" || m2["relevance"] != "me" || m1["reply_count"].(float64) != 0 {
		t.Fatalf("串里回复按普通消息收，@我 照算：%v / %v", m1, m2)
	}
	// GET 一条也带 thread
	if code, out := call(t, e.h, "GET", "/api/im/messages/"+m2["id"].(string), ""); code != 200 ||
		out["data"].(map[string]any)["thread"].(map[string]any)["parent_message_id"] != pm["id"] {
		t.Fatalf("单条：%d %v", code, out)
	}
	cur := e.slackCursor(t, c.ID)
	if tr := cur.Threads["C01"][p]; tr == nil || tr.S != r2 || tr.L != r2 {
		t.Fatalf("进度应记到 r2：%+v", cur.Threads)
	}
	// 回串里的回复：发到同一个串，thread_ts 是父消息的
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+m1["id"].(string)+"/reply", `{"text":"收到"}`); code != 200 {
		t.Fatalf("回复：%d %v", code, out)
	}
	if sent := e.fake.sent(); len(sent) != 1 || sent[0].Get("thread_ts") != p {
		t.Fatalf("应发到父消息的串：%v", sent)
	}

	// 第二轮：老父消息下面来了新回复（history 按 oldest 看不到父消息），外加一条同时发到频道的。
	// 翻近期历史看到最新回复变了，只拉上次之后的；同时发到频道的从 history、replies 两边来，只落一条
	r3, r4 := agoTS(10*time.Minute, 3), agoTS(5*time.Minute, 4)
	e.fake.addReply("C01", p, map[string]any{"user": "U04LIN", "text": "补充一下", "ts": r3, "parent_user_id": "U04LIN"})
	bc := map[string]any{"type": "message", "subtype": "thread_broadcast", "user": "U09ZHOU", "text": "结论：周五灰度", "ts": r4, "parent_user_id": "U04LIN"}
	e.fake.addReply("C01", p, bc)
	e.fake.add("C01", bc)
	before := e.fake.count("conversations.replies")
	d = e.syncOK(t, c.ID, "第二轮")
	if n, dup := len(d["ids"].([]any)), d["duplicates"].(float64); n != 2 || dup != 1 {
		t.Fatalf("应新收 2 条（r3、r4），r4 重复 1 次：%v", d)
	}
	e.fake.mu.Lock()
	lastOldest := e.fake.repliesOldest[len(e.fake.repliesOldest)-1]
	e.fake.mu.Unlock()
	if e.fake.count("conversations.replies") != before+1 || lastOldest != r2 {
		t.Fatalf("应只查一次、从 r2 之后拉：%d 次，oldest %s", e.fake.count("conversations.replies")-before, lastOldest)
	}
	_, got = list(t, e.h, "")
	if b := got["C01:"+r4]; b == nil || b["thread"].(map[string]any)["parent_message_id"] != pm["id"] {
		t.Fatalf("同时发到频道的也记串：%v", b)
	}
	if got["C01:"+p]["reply_count"].(float64) != 4 {
		t.Fatalf("父消息 reply_count 应为 4：%v", got["C01:"+p]["reply_count"])
	}

	// 第三轮没有新回复：不查串；进度持久化在 cursor 里
	before = e.fake.count("conversations.replies")
	e.syncOK(t, c.ID, "第三轮")
	if e.fake.count("conversations.replies") != before {
		t.Fatal("没有新回复不该查串")
	}
	if tr := e.slackCursor(t, c.ID).Threads["C01"][p]; tr == nil || tr.S != r4 {
		t.Fatalf("进度应记到 r4：%+v", tr)
	}
}

// 0010 之前收进来的同时发到频道的消息不带串：再收到时补上属于哪个串。
func TestSlackThreadFillsOldBroadcast(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 0)
	ev := func(thread bool) string {
		th := ""
		if thread {
			th = `,"thread_ts":"1761700000.000100","parent_user_id":"U04LIN"`
		}
		return `{"type":"event_callback","event":{"type":"message","subtype":"thread_broadcast","channel":"C01","channel_type":"channel","user":"U09ZHOU",
		"text":"结论","ts":"1761700050.000100"` + th + `}}`
	}
	if c == nil {
		t.Fatal("没建出连接器")
	}
	if code, out := e.signed(t, ev(false), ""); code != 200 {
		t.Fatalf("回调：%d %v", code, out)
	}
	if code, out := e.signed(t, ev(true), ""); code != 200 || out["data"].(map[string]any)["duplicates"].(float64) != 1 {
		t.Fatalf("再收：%d %v", code, out)
	}
	_, got := list(t, e.h, "")
	m := got["C01:1761700050.000100"]
	if th, _ := m["thread"].(map[string]any); th == nil || th["parent_external_id"] != "C01:1761700000.000100" || th["parent_message_id"] != nil {
		t.Fatalf("应补上串、父消息不在库里为 null：%v", m["thread"])
	}
}

// 每轮每个会话至多查 slackThreadBudget 个串，剩下的下轮接着；replies 撞上 429 停下，不算同步失败，下轮接着拉。
func TestSlackThreadBudgetAndRateLimit(t *testing.T) {
	noThreadScanWait(t)
	e := setupSlack(t)
	const n = slackThreadBudget + 2
	var parents []string
	e.fake.history = map[string][]map[string]any{"C01": {}}
	for i := range n {
		p := agoTS(time.Duration(n-i)*time.Hour, i)
		parents = append(parents, p)
		e.fake.history["C01"] = append(e.fake.history["C01"], map[string]any{"type": "message", "user": "U04LIN", "text": fmt.Sprintf("话题 %d", i), "ts": p})
		e.fake.addReply("C01", p, map[string]any{"user": "U09ZHOU", "text": fmt.Sprintf("回复 %d", i), "ts": agoTS(time.Duration(n-i)*time.Hour-time.Minute, i)})
	}
	c := e.connect(t, 0)
	threadMsgs := func() int {
		_, got := list(t, e.h, "")
		k := 0
		for _, m := range got {
			if m["thread"] != nil {
				k++
			}
		}
		return k
	}
	e.syncOK(t, c.ID, "第一轮")
	if got := e.fake.count("conversations.replies"); got != slackThreadBudget || threadMsgs() != slackThreadBudget {
		t.Fatalf("第一轮应只查 %d 个串：查了 %d，收了 %d", slackThreadBudget, got, threadMsgs())
	}
	e.syncOK(t, c.ID, "第二轮")
	if threadMsgs() != n {
		t.Fatalf("第二轮应补上剩下的：%d", threadMsgs())
	}

	// 三个串来了新回复，第二次查时 429：这轮收到 1 条、不置异常，下轮接着收另外 2 条
	for i := range 3 {
		e.fake.addReply("C01", parents[i], map[string]any{"user": "U04LIN", "text": fmt.Sprintf("追问 %d", i), "ts": agoTS(time.Minute, 10+i)})
	}
	e.fake.mu.Lock()
	e.fake.repliesLimitAt = e.fake.calls["conversations.replies"] + 1
	e.fake.mu.Unlock()
	e.syncOK(t, c.ID, "限流那轮")
	if cn, _ := e.conns.Get(context.Background(), c.ID); cn.Error != "" {
		t.Fatalf("限流不该记原因：%q", cn.Error)
	}
	if got := threadMsgs(); got != n+1 {
		t.Fatalf("限流那轮应只收到 1 条：%d", got-n)
	}
	e.fake.mu.Lock()
	e.fake.repliesLimitAt = 0
	e.fake.mu.Unlock()
	e.syncOK(t, c.ID, "限流后一轮")
	if got := threadMsgs(); got != n+3 {
		t.Fatalf("下一轮应接着收完：%d", got-n)
	}
}

// 第一次翻一个会话时只记下现有的串、不往回拉；补拉接口把最近几天里有回复的串补回来，再调一次不重复。
// 我本人身份：我发起的串里别人的回复算与我相关；我在串里回的记成那个串里的回复。
func TestSlackThreadBackfill(t *testing.T) {
	noThreadScanWait(t)
	e := setupSlack(t)
	ctx := context.Background()
	old, mine := agoTS(3*24*time.Hour, 1), agoTS(2*24*time.Hour, 2)
	tooOld := agoTS(20*24*time.Hour, 3)
	e.fake.history = map[string][]map[string]any{
		"C01": {
			{"type": "message", "user": "U04LIN", "text": "很早的话题", "ts": tooOld},
			{"type": "message", "user": "U04LIN", "text": "上周的话题", "ts": old},
			{"type": "message", "user": "U07ME", "text": "我发起的讨论", "ts": mine},
		},
	}
	e.fake.addReply("C01", tooOld, map[string]any{"user": "U09ZHOU", "text": "很早的回复", "ts": agoTS(19*24*time.Hour, 1)})
	e.fake.addReply("C01", old, map[string]any{"user": "U09ZHOU", "text": "老串回复一", "ts": agoTS(3*24*time.Hour-time.Hour, 1)})
	e.fake.addReply("C01", old, map[string]any{"user": "U09ZHOU", "text": "老串回复二", "ts": agoTS(2*24*time.Hour, 5)})
	e.fake.addReply("C01", mine, map[string]any{"user": "U04LIN", "text": "我觉得可以", "ts": agoTS(24*time.Hour, 1), "parent_user_id": "U07ME"})
	e.fake.addReply("C01", mine, map[string]any{"user": "U07ME", "text": "好那就这么定", "ts": agoTS(23*time.Hour, 1), "parent_user_id": "U07ME"})
	every := 0
	c, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &every,
		Config:  map[string]string{"identity": connector.SlackAsUser, "channels": "#product"},
		Secrets: map[string]string{"bot_token": "xoxp-me", "signing_secret": "sig-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	// 模拟上线前已经拉过：进度停在最后一条，还没有串的进度
	seed, _ := json.Marshal(map[string]any{"instances": map[string]any{c.ID: slackCursor{Connector: c.ID, Team: "T1",
		Latest: map[string]string{"C01": mine}}}})
	if _, err := e.d.W.ExecContext(ctx, `INSERT INTO im_cursors (adapter, cursor, updated_at) VALUES ('slack', ?, '2026-01-01T00:00:00.000Z')`, string(seed)); err != nil {
		t.Fatal(err)
	}
	e.syncOK(t, c.ID, "上线后第一轮")
	if got := e.fake.count("conversations.replies"); got != 0 {
		t.Fatalf("第一次翻只记下现有的串，不该往回拉：查了 %d 次", got)
	}
	if tr := e.slackCursor(t, c.ID).Threads["C01"][old]; tr == nil || tr.pending() {
		t.Fatalf("现有的串应记成已拉完：%+v", tr)
	}

	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/backfill-threads?days=0", ""); code != 400 {
		t.Fatalf("days=0 应 400：%d %v", code, out)
	}
	code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/backfill-threads?days=7", "")
	if code != 200 {
		t.Fatalf("补拉：%d %v", code, out)
	}
	d := out["data"].(map[string]any)
	if d["threads_checked"].(float64) != 2 || d["replies_added"].(float64) != 3 || d["pending"].(float64) != 0 || d["complete"] != true {
		t.Fatalf("补拉应查 2 个串（20 天前的不算）、收 3 条（我回的不算新消息）：%v", d)
	}
	_, got := list(t, e.h, "")
	if got["C01:"+old] != nil {
		t.Fatal("父消息本身不该被补拉进来")
	}
	var reply1, mineReply map[string]any
	for _, m := range got {
		switch m["text"] {
		case "老串回复一":
			reply1 = m
		case "我觉得可以":
			mineReply = m
		}
	}
	if reply1 == nil || mineReply == nil {
		t.Fatalf("缺回复：%v", got)
	}
	th := reply1["thread"].(map[string]any)
	if th["parent_message_id"] != nil || th["parent_sender_name"] != "Lin Yuan" || th["parent_text"] != "上周的话题" || reply1["relevance"] != "" {
		t.Fatalf("父消息不在库里时按快照显示：%v %v", th, reply1["relevance"])
	}
	if mineReply["relevance"] != "me" || mineReply["thread"].(map[string]any)["parent_sender_name"] != "Broleez" {
		t.Fatalf("我发起的串里别人的回复算与我相关：%v", mineReply)
	}
	rps := mineReply["replies"].([]any)
	if len(rps) != 1 || rps[0].(map[string]any)["text"] != "好那就这么定" || mineReply["read"] != true {
		t.Fatalf("我在串里回的应记成这个串里的回复：%v", mineReply["replies"])
	}

	// 再调一次：最新回复都收过了，不再查
	before := e.fake.count("conversations.replies")
	_, out = call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/backfill-threads", "")
	if d := out["data"].(map[string]any); d["threads_checked"].(float64) != 0 || d["replies_added"].(float64) != 0 || e.fake.count("conversations.replies") != before {
		t.Fatalf("再补拉不该重复：%v", out)
	}

	// 暂停的连接器 409
	off := false
	if _, err := e.conns.Update(ctx, c.ID, connector.Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/backfill-threads", ""); code != 409 {
		t.Fatalf("暂停的应 409：%d %v", code, out)
	}
}
