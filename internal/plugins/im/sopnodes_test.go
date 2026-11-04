package im

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// SOP 节点（SOP-02b）：用假适配器跑一条「发消息、等回复」的流程。只在测试里把 SOP 插件拉进来，插件代码之间不 import。

type sopEnv struct {
	r    *plugin.Registry
	h    http.Handler
	st   *sqlite.Store
	fake *Fake
}

func setupSOP(t *testing.T) sopEnv {
	t.Helper()
	old := waitEvery
	waitEvery = 10 * time.Millisecond
	t.Cleanup(func() { waitEvery = old })
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := bootSOP(t, st, true)
	exec(t, st.DB(),
		`INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
		  ('cn_ok', 'slack', 'Slack 工作区', 'connected', 'both', 'x', 'x'),
		  ('cn_recv', 'slack', 'Slack 只收', 'connected', 'receive', 'x', 'x')`,
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES
		  ('cv_prod', 'slack', 'C01', 'group', '#product', 'x', 'x'),
		  ('cv_recv', 'slack', 'C02', 'group', '#readonly', 'x', 'x'),
		  ('cv_empty', 'slack', 'C03', 'group', '#empty', 'x', 'x')`,
	)
	return e
}

// bootSOP 在 st 上起 SOP 插件和带假适配器的 IM 插件；fresh 为真时装好、启用两个插件。
func bootSOP(t *testing.T, st *sqlite.Store, fresh bool) sopEnv {
	t.Helper()
	ctx := context.Background()
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	e := sopEnv{r: r, st: st, fake: NewFake("fake", "slack", time.Hour, "Broleez")}
	for _, p := range []plugin.Plugin{sop.New(), New(e.fake)} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for id, perms := range map[string][]string{"sop": {"network:any", "fs:write:project", "process:spawn"}, "im": {"network:im"}} {
		if !fresh {
			break
		}
		if err := r.Install(ctx, id, perms); err != nil {
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
	return e
}

func (e sopEnv) push(t *testing.T, body string) {
	t.Helper()
	if code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", `{"messages":[`+body+`]}`); code != 200 {
		t.Fatalf("回调：%d %v", code, out)
	}
}

func (e sopEnv) flow(t *testing.T, body string) string {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/sop/flows", body)
	if code != 201 {
		t.Fatalf("建流程 %d %v", code, out)
	}
	return data(out)["id"].(string)
}

func (e sopEnv) start(t *testing.T, flowID, body string) string {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/sop/flows/"+flowID+"/runs", body)
	if code != 201 {
		t.Fatalf("发起执行 %d %v", code, out)
	}
	return data(out)["id"].(string)
}

// until 等执行满足条件，回最后一次取到的执行。
func (e sopEnv) until(t *testing.T, runID, what string, ok func(run map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		code, out := call(t, e.h, "GET", "/api/sop/runs/"+runID, "")
		if code != 200 {
			t.Fatalf("取执行 %d %v", code, out)
		}
		if ok(data(out)) {
			return data(out)
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒还没有：%s，执行：%v", what, data(out))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sopStep(run map[string]any, key string) map[string]any {
	for _, s := range run["steps"].([]any) {
		if m := s.(map[string]any); m["key"] == key {
			return m
		}
	}
	return nil
}

func stepLogged(s map[string]any, text string) bool {
	for _, l := range s["log"].([]any) {
		if strings.Contains(l.(map[string]any)["text"].(string), text) {
			return true
		}
	}
	return false
}

func nodeTypes(t *testing.T, h http.Handler) map[string]map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/node-types", "")
	if code != 200 {
		t.Fatalf("节点目录 %d %v", code, out)
	}
	got := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		got[m["kind"].(string)] = m
	}
	return got
}

func TestSOPSendAndWaitReply(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"林原","text":"在吗"}`)
	id := e.flow(t, `{"name":"问一下","fields":[{"key":"cv","label":"会话","type":"text"},{"key":"who","label":"谁","type":"text"}],"steps":[
		{"key":"say","name":"发消息","kind":"im_send_message","config":{"conversation":"{{cv}}","text":"你好 {{who}}，方案看了吗"}},
		{"key":"ask","name":"等回复","kind":"im_wait_reply","after":["say"],"config":{"conversation":"cv_prod","timeout":"1 小时"}},
		{"key":"z","name":"收尾","kind":"auto","after":["ask"]}]}`)
	rid := e.start(t, id, `{"input":{"cv":"cv_prod","who":"林原"}}`)

	// 发消息：发到指定会话，输出带 sent，有审计
	run := e.until(t, rid, "等回复挂起", func(r map[string]any) bool { return stepLogged(sopStep(r, "ask"), "等插件唤醒") })
	say := sopStep(run, "say")
	sent, _ := say["output"].(map[string]any)["sent"].(map[string]any)
	if say["status"] != "done" || sent["conversation_id"] != "cv_prod" || sent["text"] != "你好 林原，方案看了吗" || sent["external_id"] != "C01:reply1" {
		t.Fatalf("发消息：%v %v", say["status"], say["output"])
	}
	if out := e.fake.Sent(); len(out) != 1 || out[0].ConversationID != "C01" || out[0].ConnectorID != "cn_ok" || out[0].Text != "你好 林原，方案看了吗" || out[0].ReplyTo != "" {
		t.Fatalf("假适配器收到：%+v", out)
	}
	var n int
	var actor, source, summary, detail string
	if err := e.st.DB().R.QueryRow(`SELECT count(*), max(actor), max(source), max(summary), max(detail) FROM audits WHERE kind = 'agent' AND action = 'send' AND target_type = 'conversation' AND target_id = 'cv_prod'`).
		Scan(&n, &actor, &source, &summary, &detail); err != nil || n != 1 {
		t.Fatalf("审计：%d %v", n, err)
	}
	if actor != "im#"+rid || source != "plugin" || summary != "发消息到「#product」" ||
		!strings.Contains(detail, `"status":"sent"`) || !strings.Contains(detail, `"step":"say"`) || !strings.Contains(detail, `"run_id":"`+rid+`"`) {
		t.Fatalf("审计内容：%s %s %s %s", actor, source, summary, detail)
	}

	// 等回复：挂起；我自己发的、别的会话的不算；对方的回复到了就继续
	ask := sopStep(run, "ask")
	if ask["status"] != "running" || !stepLogged(ask, "等「#product」里对方回复，最多等 1 小时") {
		t.Fatalf("挂起：%v %v", ask["status"], ask["log"])
	}
	time.Sleep(5 * time.Millisecond) // 让后面的消息时间晚于挂起时间
	e.push(t, `{"external_id":"C01:2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"UME","sender_name":"Broleez","text":"补一句"}`)
	e.push(t, `{"external_id":"C02:1","connector_id":"cn_ok","conversation_id":"C02","conversation_name":"#readonly","sender_id":"U04LIN","text":"别的群"}`)
	time.Sleep(50 * time.Millisecond)
	if r := e.until(t, rid, "", func(map[string]any) bool { return true }); sopStep(r, "ask")["status"] != "running" {
		t.Fatalf("我自己的消息、别的会话不该唤醒：%v", sopStep(r, "ask"))
	}
	e.push(t, `{"external_id":"C01:3","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"林原","text":"看了，没问题"}`)
	run = e.until(t, rid, "执行完成", func(r map[string]any) bool { return r["status"] == "done" })
	ask = sopStep(run, "ask")
	out := ask["output"].(map[string]any)
	reply, _ := out["reply"].(map[string]any)
	if reply["text"] != "看了，没问题" || reply["sender_id"] != "U04LIN" || reply["conversation_id"] != "cv_prod" || out["sent"] == nil || !stepLogged(ask, "插件 im 唤醒") {
		t.Fatalf("唤醒后的输出：%v", ask)
	}
	// 执行先走完、等待行随后删，负载高时两者之间有间隔，最多等 3 秒
	var left int
	var err error
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		err = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_waits`).Scan(&left)
		if err != nil || left == 0 || time.Now().After(deadline) {
			break
		}
	}
	if err != nil || left != 0 {
		t.Fatalf("唤醒后应删掉等待：%d %v", left, err)
	}
}

// TestSOPWaitReplyAcrossRestart：挂起后服务重启，等待还在库里，对方回复后照样唤醒。
func TestSOPWaitReplyAcrossRestart(t *testing.T) {
	e := setupSOP(t)
	id := e.flow(t, `{"name":"重启","steps":[{"key":"ask","name":"等回复","kind":"im_wait_reply","config":{"conversation":"cv_prod"}}]}`)
	rid := e.start(t, id, `{"input":{"k":"v"}}`)
	e.until(t, rid, "挂起", func(r map[string]any) bool { return stepLogged(sopStep(r, "ask"), "等插件唤醒") })
	e.r.Close()
	time.Sleep(5 * time.Millisecond)

	e2 := bootSOP(t, e.st, false)
	e2.push(t, `{"external_id":"C01:9","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"回来了"}`)
	run := e2.until(t, rid, "重启后唤醒", func(r map[string]any) bool { return r["status"] == "done" })
	out := sopStep(run, "ask")["output"].(map[string]any)
	if out["k"] != "v" || out["reply"].(map[string]any)["text"] != "回来了" {
		t.Fatalf("重启后唤醒的输出：%v", out)
	}
}

// TestSOPSendAcrossRestart：发出、记完审计后结果还没落库就重启，重跑同一次尝试按审计取回，不再发第二次；
// 退回重做是新的一次尝试，会再发（POL-02）。
func TestSOPSendAcrossRestart(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"在吗"}`)
	entered := make(chan struct{}, 1)
	afterSend = func(c context.Context, _ string) error {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-c.Done()
		return c.Err()
	}
	t.Cleanup(func() { afterSend = nil })
	id := e.flow(t, `{"name":"只发一次","steps":[
		{"key":"say","name":"发消息","kind":"im_send_message","config":{"conversation":"cv_prod","text":"周报发出来了"}},
		{"key":"chk","name":"检查","kind":"review","after":["say"]}]}`)
	rid := e.start(t, id, `{"input":{"k":"v"}}`)
	<-entered
	if n := len(e.fake.Sent()); n != 1 {
		t.Fatalf("重启前发出 %d 条", n)
	}
	e.r.Close()
	var st string
	if err := e.st.DB().R.QueryRow(`SELECT status FROM sop_run_steps WHERE run_id = ? AND step_key = 'say'`, rid).Scan(&st); err != nil || st != "running" {
		t.Fatalf("关掉后 say=%s %v", st, err)
	}

	afterSend = nil
	e2 := bootSOP(t, e.st, false)
	run := e2.until(t, rid, "重跑后停在检查", func(r map[string]any) bool { return sopStep(r, "say")["status"] == "done" })
	say := sopStep(run, "say")
	out := say["output"].(map[string]any)
	sent, _ := out["sent"].(map[string]any)
	if say["attempts"] != float64(1) || !stepLogged(say, "服务重启后重跑同一次尝试") || out["k"] != "v" ||
		sent["external_id"] != "C01:reply1" || sent["text"] != "周报发出来了" || sent["conversation_id"] != "cv_prod" || sent["reused"] != true {
		t.Fatalf("重跑：attempts=%v log=%v output=%v", say["attempts"], say["log"], out)
	}
	if n := len(e2.fake.Sent()); n != 0 {
		t.Fatalf("重启后不该再发：%+v", e2.fake.Sent())
	}
	count := func() int {
		var n int
		if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM audits WHERE action = 'send' AND actor = ?`, "im#"+rid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(); n != 1 {
		t.Fatalf("审计应当只有一条，got %d", n)
	}
	// 退回重做是新的一次尝试，再发一条
	e2.until(t, rid, "停在检查", func(r map[string]any) bool { return sopStep(r, "chk")["status"] == "review" })
	if code, out := call(t, e2.h, "POST", "/api/sop/runs/"+rid+"/actions", `{"kind":"rework","step":"chk"}`); code != 200 {
		t.Fatalf("退回 %d %v", code, out)
	}
	e2.until(t, rid, "第二次尝试发出", func(r map[string]any) bool {
		return sopStep(r, "say")["attempts"] == float64(2) && sopStep(r, "say")["status"] == "done"
	})
	if n := len(e2.fake.Sent()); n != 1 || count() != 2 {
		t.Fatalf("退回重做后：发出 %d 条，审计 %d 条", n, count())
	}
}

func TestSOPWaitReplyTimeout(t *testing.T) {
	e := setupSOP(t)
	id := e.flow(t, `{"name":"等超时","steps":[
		{"key":"ask","name":"等回复","kind":"im_wait_reply","config":{"conversation":"cv_prod","timeout":"0.2 秒"}},
		{"key":"z","name":"收尾","kind":"auto","after":["ask"]}]}`)
	rid := e.start(t, id, `{}`)
	run := e.until(t, rid, "超时失败", func(r map[string]any) bool { return r["status"] == "failed" })
	ask := sopStep(run, "ask")
	if ask["status"] != "failed" || ask["error"] != "等了 0.2 秒，「#product」里对方还没回复（超时）" {
		t.Fatalf("超时：%v %v", ask["status"], ask["error"])
	}
	var left int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_waits`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("超时后应删掉等待：%d %v", left, err)
	}
}

func TestSOPSendBlocked(t *testing.T) {
	e := setupSOP(t)
	e.push(t, `{"external_id":"C02:1","connector_id":"cn_recv","conversation_id":"C02","conversation_name":"#readonly","sender_id":"U04LIN","text":"只收"}`)
	for _, c := range []struct{ cfg, want string }{
		{`{"conversation":"cv_recv","text":"hi"}`, "连接器「Slack 只收」设置为只收消息"},
		{`{"conversation":"cv_empty","text":"hi"}`, "「#empty」里还没收到过消息，不知道用哪个连接器发"},
		{`{"conversation":"cv_none","text":"hi"}`, "会话 cv_none 不存在"},
		{`{"conversation":"cv_recv","text":"{{nothing}}"}`, "要发的内容是空的"},
	} {
		id := e.flow(t, `{"name":"发不出","steps":[{"key":"say","name":"发消息","kind":"im_send_message","config":`+c.cfg+`}]}`)
		run := e.until(t, e.start(t, id, `{}`), "发送失败", func(r map[string]any) bool { return r["status"] == "failed" })
		if s := sopStep(run, "say"); s["error"] != c.want {
			t.Errorf("%s：%v", c.cfg, s["error"])
		}
	}
	if len(e.fake.Sent()) != 0 {
		t.Fatalf("不该发出去：%v", e.fake.Sent())
	}
	// 适配器发送失败：步骤失败，审计记一条 failed
	e.push(t, `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"在吗"}`)
	e.fake.FailReplies("channel_not_found")
	id := e.flow(t, `{"name":"发失败","steps":[{"key":"say","name":"发消息","kind":"im_send_message","config":{"conversation":"cv_prod","text":"hi"}}]}`)
	run := e.until(t, e.start(t, id, `{}`), "发送失败", func(r map[string]any) bool { return r["status"] == "failed" })
	if s := sopStep(run, "say"); s["error"] != "发送失败：channel_not_found" {
		t.Fatalf("发送失败：%v", s["error"])
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM audits WHERE action = 'send' AND json_extract(detail, '$.status') = 'failed'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("失败的审计：%d %v", n, err)
	}
}

func TestSOPNodesFollowIMEnabled(t *testing.T) {
	e := setupSOP(t)
	got := nodeTypes(t, e.h)
	for _, k := range []string{NodeSendMessage, NodeWaitReply} {
		if got[k] == nil || got[k]["source"] != "im" || got[k]["group"] != "沟通" {
			t.Fatalf("启用后应当有 %s：%v", k, got[k])
		}
	}
	if code, out := call(t, e.h, "POST", "/api/sop/flows", `{"name":"缺配置","steps":[{"key":"a","name":"发","kind":"im_send_message","config":{"conversation":"cv_prod"}}]}`); code != 400 || errOf(out)["message"] != "「发」还没填「内容」" {
		t.Fatalf("必填项：%d %v", code, out)
	}
	if err := e.r.Disable(context.Background(), "im"); err != nil {
		t.Fatal(err)
	}
	got = nodeTypes(t, e.h)
	if got[NodeSendMessage] != nil || got[NodeWaitReply] != nil {
		t.Fatal("停用 IM 插件后两个节点应当消失")
	}
}

func TestParseTimeout(t *testing.T) {
	for in, want := range map[string]time.Duration{"": time.Hour, "30 分钟": 30 * time.Minute, "2 天": 48 * time.Hour, "90s": 90 * time.Second} {
		if d, err := parseTimeout(in); err != nil || d != want {
			t.Errorf("%q：%v %v", in, d, err)
		}
	}
	for _, in := range []string{"很久", "0 秒", "31 天"} {
		if _, err := parseTimeout(in); err == nil {
			t.Errorf("%q 应当报错", in)
		}
	}
}

// 来消息自动分诊（SOP-05）：触发方式是 im 的流程收到新消息自动发起，「读取消息」取正文和发信人，
// 判断走哪一路，「标记消息」把消息标成忽略或已读。接上真的事件总线，和线上一样异步投递。
func TestSOPAutoTriageMarksMessage(t *testing.T) {
	e := setupSOP(t)
	e.r.Events = events.New(e.r, slog.New(slog.NewTextHandler(io.Discard, nil)))
	id := e.flow(t, `{"name":"消息分诊","trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text","required":true}],"steps":[
		{"key":"read","name":"读取消息","kind":"im_get_message","after":[]},
		{"key":"route","name":"要处理吗","kind":"decide","after":["read"],"rule":"message.text 包含 帮忙","cases":[{"key":"handle","label":"要处理"},{"key":"skip","label":"忽略"}]},
		{"key":"seen","name":"标已读","kind":"im_mark_message","after":["route"],"branch":{"of":"route","case":"handle"},"config":{"state":"read"}},
		{"key":"drop","name":"标忽略","kind":"im_mark_message","after":["route"],"branch":{"of":"route","case":"skip"},"config":{"state":"ignore"}}]}`)

	e.push(t, `{"external_id":"C01:t1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"林原","text":"大家早"}`)
	e.push(t, `{"external_id":"C01:t2","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","sender_name":"林原","text":"@Broleez 帮忙看下权限点"}`)

	byText := map[string]map[string]any{}
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, out := call(t, e.h, "GET", "/api/im/messages", "")
		for _, m := range out["data"].([]any) {
			mm := m.(map[string]any)
			byText[mm["text"].(string)] = mm
		}
		if byText["大家早"]["status"] == "ignored" && byText["@Broleez 帮忙看下权限点"]["read"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒，分诊没把消息标好：%v", byText)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if byText["@Broleez 帮忙看下权限点"]["status"] != "pending" {
		t.Fatalf("要处理的只标已读、仍待处理：%v", byText["@Broleez 帮忙看下权限点"])
	}
	_, out := call(t, e.h, "GET", "/api/sop/runs", "")
	runs := out["data"].([]any)
	if len(runs) != 2 {
		t.Fatalf("两条消息各发起一次：%d", len(runs))
	}
	run := e.until(t, runs[0].(map[string]any)["id"].(string), "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	msg := sopStep(run, "read")["output"].(map[string]any)["message"].(map[string]any)
	if msg["sender"] != "林原" || msg["conversation"] != "#product" || msg["conversation_kind"] != "群聊" || msg["text"] == "" {
		t.Fatalf("读取消息的输出：%v", msg)
	}
	_ = id
}

// 标记消息：标记为写错了、消息不存在时这一步失败，给人看得懂的原因。
func TestSOPMarkMessageErrors(t *testing.T) {
	e := setupSOP(t)
	id := e.flow(t, `{"name":"标错","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"m","name":"标记","kind":"im_mark_message","after":[],"config":{"state":"archive"}}]}`)
	rid := e.start(t, id, `{"input":{"message_id":"msg_x"}}`)
	run := e.until(t, rid, "失败", func(r map[string]any) bool { return sopStep(r, "m")["status"] == "failed" })
	if err, _ := sopStep(run, "m")["error"].(string); !strings.Contains(err, "标记为「archive」不认") {
		t.Fatalf("写错标记：%q", err)
	}
	id = e.flow(t, `{"name":"没这条","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"m","name":"读","kind":"im_get_message","after":[]}]}`)
	rid = e.start(t, id, `{"input":{"message_id":"msg_none"}}`)
	run = e.until(t, rid, "失败", func(r map[string]any) bool { return sopStep(r, "m")["status"] == "failed" })
	if err, _ := sopStep(run, "m")["error"].(string); !strings.Contains(err, "消息 msg_none 不存在") {
		t.Fatalf("消息不存在：%q", err)
	}
}
