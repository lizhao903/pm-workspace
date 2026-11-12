// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// recvOnly 是只收不回的适配器（没实现 Replier）。
type recvOnly struct{}

func (recvOnly) Key() string     { return "tg" }
func (recvOnly) Channel() string { return "telegram" }
func (recvOnly) Receive(r *http.Request) ([]Incoming, error) {
	return (&Fake{}).Receive(r)
}

type actEnv struct {
	r    *plugin.Registry
	h    http.Handler
	st   *sqlite.Store
	fake *Fake
}

// 内核 store 接上插件建对象，装好 im（fake 能回复，tg 只收）
func setupActions(t *testing.T) actEnv {
	t.Helper()
	ctx := context.Background()
	old := snoozeEvery
	snoozeEvery = 20 * time.Millisecond
	t.Cleanup(func() { snoozeEvery = old })
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), log)
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	e := actEnv{r: r, st: st, fake: NewFake("fake", "slack", time.Hour, "Broleez")}
	if err := r.Add(New(e.fake, recvOnly{})); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	r.SetObjectCreator(st)
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
	e.h = mux
	exec(t, st.DB(),
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_lin', '林原', 'x', 'x')`,
		`INSERT INTO contact_identities (id, stakeholder_id, channel, external_id, created_at, updated_at) VALUES ('idn_lin', 'stk_lin', 'slack', 'U04LIN', 'x', 'x')`,
		`INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
		  ('cn_ok', 'slack', 'Slack 工作区', 'connected', 'both', 'x', 'x'),
		  ('cn_paused', 'slack', 'Slack 备用', 'paused', 'both', 'x', 'x'),
		  ('cn_recv', 'slack', 'Slack 只收', 'connected', 'receive', 'x', 'x'),
		  ('cn_rxerr', 'fake', '收消息冲突', 'error', 'both', 'x', 'x')`,
	)
	return e
}

// push 经回调灌一条，回消息 id
func (e actEnv) push(t *testing.T, adapter, body string) string {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/im/callbacks/"+adapter, `{"messages":[`+body+`]}`)
	if code != 200 {
		t.Fatalf("回调：%d %v", code, out)
	}
	ids := out["data"].(map[string]any)["ids"].([]any)
	if len(ids) != 1 {
		t.Fatalf("应新落 1 条：%v", out)
	}
	return ids[0].(string)
}

func data(out map[string]any) map[string]any { d, _ := out["data"].(map[string]any); return d }

func errOf(out map[string]any) map[string]any { d, _ := out["error"].(map[string]any); return d }

func TestStateActions(t *testing.T) {
	e := setupActions(t)
	id := e.push(t, "fake", `{"external_id":"C01:1","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"看下"}`)

	code, out := call(t, e.h, "GET", "/api/im/messages/"+id, "")
	if m := data(out); code != 200 || m["status"] != "pending" || m["read"] != false || m["adapter"] != "fake" ||
		m["task_id"] != nil || m["reply_error"] != "" || len(m["replies"].([]any)) != 0 {
		t.Fatalf("单条：%d %v", code, out)
	}
	for _, c := range []struct {
		act, status string
		read        bool
	}{
		{"read", "pending", true}, {"done", "done", true}, {"reopen", "pending", true}, {"ignore", "ignored", true}, {"reopen", "pending", true},
	} {
		code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/"+c.act, "")
		if m := data(out); code != 200 || m["status"] != c.status || m["read"] != c.read || m["snooze_until"] != nil {
			t.Fatalf("%s：%d %v", c.act, code, out)
		}
	}
	for _, p := range []string{"/done", "/ignore", "/reopen", "/read", "/snooze", "/reply", "/task", ""} {
		method := "POST"
		if p == "" {
			method = "GET"
		}
		body := `{"until":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `","text":"x"}`
		if code, _ := call(t, e.h, method, "/api/im/messages/msg_none"+p, body); code != 404 {
			t.Errorf("%s 不存在的消息应 404：%d", p, code)
		}
	}

	// 停用后动作接口 404
	if err := e.r.Disable(context.Background(), "im"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/done", "/snooze", "/reply", "/task"} {
		if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+p, `{}`); code != 404 {
			t.Errorf("停用后 %s 应 404：%d", p, code)
		}
	}
	if code, _ := call(t, e.h, "GET", "/api/im/messages/"+id, ""); code != 404 {
		t.Errorf("停用后单条应 404：%d", code)
	}
}

func TestSnoozeWakes(t *testing.T) {
	e := setupActions(t)
	id := e.push(t, "fake", `{"external_id":"C01:1","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"明天再说"}`)

	for _, body := range []string{`{"until":"2020-01-01T00:00:00Z"}`, `{"until":"明天"}`, `{"until":"2999-01-01T00:00:00Z"}`, `{}`} {
		if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/snooze", body); code != 400 {
			t.Errorf("%s 应 400：%d", body, code)
		}
	}
	until := time.Now().Add(400 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/snooze", `{"until":"`+until+`"}`)
	if m := data(out); code != 200 || m["snooze_until"] == nil || m["status"] != "pending" || m["read"] != true {
		t.Fatalf("稍后：%d %v", code, out)
	}
	if n, _ := list(t, e.h, "?snoozed=true"); n != 1 {
		t.Fatalf("稍后视图应有 1 条：%d", n)
	}
	if n, _ := list(t, e.h, "?status=pending&snoozed=false"); n != 0 {
		t.Fatalf("待处理视图不含还没到点的：%d", n)
	}
	if code, _ := call(t, e.h, "GET", "/api/im/messages?snoozed=maybe", ""); code != 400 {
		t.Fatalf("snoozed 只认 true、false：%d", code)
	}

	// 到点后台任务清掉，回到待处理
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, out := call(t, e.h, "GET", "/api/im/messages/"+id, "")
		if m := data(out); m["snooze_until"] == nil {
			if m["status"] != "pending" {
				t.Fatalf("到点后应是待处理：%v", m)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("到点后 snooze_until 没被清掉")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n, _ := list(t, e.h, "?status=pending&snoozed=false"); n != 1 {
		t.Fatalf("到点后回到待处理视图：%d", n)
	}

	// 处理完的不能稍后；处理完会清掉稍后
	call(t, e.h, "POST", "/api/im/messages/"+id+"/done", "")
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/snooze", `{"until":"`+later+`"}`); code != 409 || errOf(out)["code"] != "conflict" {
		t.Fatalf("处理完的稍后应 409：%d %v", code, out)
	}
	call(t, e.h, "POST", "/api/im/messages/"+id+"/reopen", "")
	call(t, e.h, "POST", "/api/im/messages/"+id+"/snooze", `{"until":"`+later+`"}`)
	if _, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/ignore", ""); data(out)["snooze_until"] != nil {
		t.Fatalf("忽略要清掉稍后：%v", out)
	}
}

func TestReply(t *testing.T) {
	e := setupActions(t)
	id := e.push(t, "fake", `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U04LIN","text":"能看下吗"}`)

	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"  "}`); code != 400 {
		t.Fatalf("空回复应 400：%d", code)
	}
	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"收到，我今天看。"}`)
	m := data(out)
	if code != 200 || m["read"] != true || m["status"] != "pending" || len(m["replies"].([]any)) != 1 {
		t.Fatalf("回复：%d %v", code, out)
	}
	if rp := m["replies"].([]any)[0].(map[string]any); rp["status"] != "sent" || rp["text"] != "收到，我今天看。" || rp["external_id"] == "" {
		t.Fatalf("回复记录：%v", rp)
	}
	sent := e.fake.Sent()
	if len(sent) != 1 || sent[0].ConversationID != "C01" || sent[0].RecipientID != "U04LIN" || sent[0].ReplyTo != "C01:1" || sent[0].ConnectorID != "cn_ok" {
		t.Fatalf("经适配器发出：%+v", sent)
	}

	// 发送失败：记一行 failed，原因写在消息上，回 502
	e.fake.FailReplies("rate limited")
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"再看看","done":true}`)
	if er := errOf(out); code != 502 || er["code"] != "send_failed" || er["reply_id"] == "" {
		t.Fatalf("发送失败：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/im/messages/"+id, "")
	m = data(out)
	if m["reply_error"] != "rate limited" || m["status"] != "pending" || len(m["replies"].([]any)) != 2 {
		t.Fatalf("失败记在消息上、不标处理完：%v", m)
	}
	if rp := m["replies"].([]any)[1].(map[string]any); rp["status"] != "failed" || rp["error"] != "rate limited" {
		t.Fatalf("失败的回复：%v", rp)
	}
	// 再发成功：清掉失败原因，并处理
	e.fake.FailReplies("")
	_, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/reply", `{"text":"好了","done":true}`)
	if m := data(out); m["reply_error"] != "" || m["status"] != "done" || len(m["replies"].([]any)) != 3 {
		t.Fatalf("发成功并处理：%v", out)
	}

	// 回不了的原因
	for _, c := range []struct{ body, reason string }{
		{`{"external_id":"C01:2","connector_id":"cn_paused","conversation_id":"C01","sender_id":"U04LIN","text":"x"}`, "connector_paused"},
		{`{"external_id":"C01:3","connector_id":"cn_recv","conversation_id":"C01","sender_id":"U04LIN","text":"x"}`, "receive_only"},
		{`{"external_id":"C01:4","connector_id":"cn_gone","conversation_id":"C01","sender_id":"U04LIN","text":"x"}`, "connector_missing"},
	} {
		mid := e.push(t, "fake", c.body)
		code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/reply", `{"text":"好"}`)
		if er := errOf(out); code != 409 || er["code"] != "conflict" || er["reason"] != c.reason || er["message"] == "" {
			t.Errorf("%s：%d %v", c.reason, code, out)
		}
	}
	// 连接器异常（多是收消息那侧的问题）不拦回复，照常发
	mid := e.push(t, "fake", `{"external_id":"C01:5","connector_id":"cn_rxerr","conversation_id":"C01","sender_id":"U04LIN","text":"x"}`)
	if code, out := call(t, e.h, "POST", "/api/im/messages/"+mid+"/reply", `{"text":"好"}`); code != 200 {
		t.Fatalf("连接器异常时应照发：%d %v", code, out)
	}
	mid = e.push(t, "tg", `{"external_id":"9:1","conversation_id":"9","conversation_kind":"direct","sender_id":"@zhou","text":"在吗"}`)
	code, out = call(t, e.h, "POST", "/api/im/messages/"+mid+"/reply", `{"text":"在"}`)
	if er := errOf(out); code != 409 || er["reason"] != "unsupported" || er["message"] != "渠道 telegram 不支持回复" {
		t.Fatalf("渠道不支持回复：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/im/messages/"+mid, "")
	if m := data(out); len(m["replies"].([]any)) != 0 || m["reply_error"] != "" {
		t.Fatalf("被拦下的回复不记：%v", m)
	}
	if len(e.fake.Sent()) != 3 {
		t.Fatalf("被拦的不该发出去：%d", len(e.fake.Sent()))
	}
}

func TestToTask(t *testing.T) {
	e := setupActions(t)
	ctx := context.Background()
	id := e.push(t, "fake", `{"external_id":"C01:1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product",
	  "sender_id":"U04LIN","sender_name":"Lin Yuan","text":"权限点清单\n整理了一版，麻烦看下有没有漏的，特别是审批流那几个节点的权限，谢谢"}`)

	code, out := call(t, e.h, "POST", "/api/im/messages/"+id+"/task", "")
	if code != 201 {
		t.Fatalf("转任务：%d %v", code, out)
	}
	task := data(out)["task"].(map[string]any)
	msg := data(out)["message"].(map[string]any)
	if task["source"] != "im" || task["ref"] == "" || msg["task_id"] != task["id"] || msg["task_ref"] != task["ref"] || msg["status"] != "pending" {
		t.Fatalf("转任务结果：%v", out)
	}
	o, err := e.st.GetObject(ctx, task["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if o.TypeID != "task" || o.Source != domain.TaskSourceIM || o.Title != clip("权限点清单 整理了一版，麻烦看下有没有漏的，特别是审批流那几个节点的权限，谢谢", 40) || []rune(o.Title)[5] != ' ' {
		t.Fatalf("任务：type=%s source=%s title=%q", o.TypeID, o.Source, o.Title)
	}
	ref, _ := o.Props[domain.PropSourceRef].(map[string]any)
	if ref["message_id"] != id || ref["channel"] != "slack" || ref["sender"] != "林原" || ref["conversation"] != "#product" {
		t.Fatalf("source_ref 指向消息：%v", o.Props)
	}
	// 提出人（AUTO-05）：发送者认到了联系人，记联系人，渠道和发送者编号也带上
	if rq, _ := o.Props[domain.PropRequester].(map[string]any); rq["contact_id"] != "stk_lin" || rq["name"] != "林原" ||
		rq["channel"] != "slack" || rq["sender_id"] != "U04LIN" {
		t.Fatalf("提出人：%v", o.Props[domain.PropRequester])
	}
	if o.Props[domain.PropStage] != "received" {
		t.Fatalf("IM 转来的任务从已接收开始：%v", o.Props[domain.PropStage])
	}
	var actor, src string
	if err := e.st.DB().R.QueryRow(`SELECT actor, source FROM revisions WHERE object_id = ? ORDER BY rowid LIMIT 1`, o.ID).Scan(&actor, &src); err != nil {
		t.Fatal(err)
	}
	if actor != "im" || src != plugin.ActorSourcePlugin {
		t.Fatalf("修订的操作者：%s %s", actor, src)
	}

	// 已经转过：409 带 task_id
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/task", `{}`)
	if er := errOf(out); code != 409 || er["task_id"] != task["id"] {
		t.Fatalf("重复转任务：%d %v", code, out)
	}
	// 任务删了（软删）可以再转，标题自己填，并处理
	if err := e.st.DeleteObject(ctx, o.ID, false, store.DefaultActor); err != nil {
		t.Fatal(err)
	}
	if _, got := list(t, e.h, ""); got["C01:1"]["task_id"] != nil || got["C01:1"]["task_ref"] != "" {
		t.Fatalf("任务删了消息上不再显示：%v", got["C01:1"])
	}
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id+"/task", `{"title":"核对权限点","priority":"high","done":true}`)
	if code != 201 || data(out)["message"].(map[string]any)["status"] != "done" || data(out)["task"].(map[string]any)["title"] != "核对权限点" {
		t.Fatalf("再转并处理：%d %v", code, out)
	}

	// 校验错误回 400，不留半截
	id2 := e.push(t, "fake", `{"external_id":"C01:2","conversation_id":"C01","sender_id":"U04LIN","text":""}`)
	for _, body := range []string{`{"project_id":"obj_none"}`, `{"owner_id":"stk_none"}`, `{"due_at":"明天"}`, `not json`} {
		if code, out := call(t, e.h, "POST", "/api/im/messages/"+id2+"/task", body); code != 400 {
			t.Errorf("%s 应 400：%d %v", body, code, out)
		}
	}
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id2+"/task", `{}`)
	if code != 201 || data(out)["task"].(map[string]any)["title"] != "来自 林原 的消息" {
		t.Fatalf("没正文时的默认标题：%d %v", code, out)
	}

	// 认不上联系人的发送者：存快照，名字取发送者显示名
	id3 := e.push(t, "fake", `{"external_id":"C01:3","conversation_id":"C01","sender_id":"U77","sender_name":"访客","text":"能加个导出吗"}`)
	code, out = call(t, e.h, "POST", "/api/im/messages/"+id3+"/task", `{}`)
	if code != 201 {
		t.Fatalf("转任务：%d %v", code, out)
	}
	o3, err := e.st.GetObject(ctx, data(out)["task"].(map[string]any)["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if rq, _ := o3.Props[domain.PropRequester].(map[string]any); rq["contact_id"] != nil || rq["name"] != "访客" ||
		rq["sender_name"] != "访客" || rq["channel"] != "slack" || rq["sender_id"] != "U77" {
		t.Fatalf("认不上的提出人：%v", o3.Props[domain.PropRequester])
	}
}

func TestToTaskWithoutWriter(t *testing.T) {
	e := setupActions(t)
	e.r.SetObjectCreator(nil)
	id := e.push(t, "fake", `{"external_id":"C01:1","conversation_id":"C01","sender_id":"U04LIN","text":"x"}`)
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+id+"/task", ""); code != 500 {
		t.Fatalf("没接建对象时应 500：%d", code)
	}
}

func TestBatch(t *testing.T) {
	e := setupActions(t)
	exec(t, e.st.DB(),
		`INSERT INTO conversations (id, channel, external_id, kind, name, created_at, updated_at) VALUES ('cv_prod', 'slack', 'C01', 'group', '#product', 'x', 'x')`)
	msg := func(ext, conv, at string) string {
		return e.push(t, "fake", `{"external_id":"`+ext+`","conversation_id":"`+conv+`","conversation_name":"#g","sender_id":"U04LIN","text":"x","at":"`+at+`"}`)
	}
	a := msg("C01:1", "C01", "2026-10-01T08:00:00Z")
	b := msg("C01:2", "C01", "2026-10-01T09:00:00Z")
	c := msg("C01:3", "C01", "2026-10-01T10:00:00Z")
	s := msg("C01:4", "C01", "2026-10-01T07:00:00Z")
	o := msg("C02:1", "C02", "2026-10-01T08:00:00Z")
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	call(t, e.h, "POST", "/api/im/messages/"+s+"/snooze", `{"until":"`+later+`"}`)
	status := func(id string) string {
		_, out := call(t, e.h, "GET", "/api/im/messages/"+id, "")
		return data(out)["status"].(string)
	}

	for _, body := range []string{`{}`, `{"action":"reopen","ids":["x"]}`, `{"action":"done"}`, `{"action":"done","ids":["x"],"conversation_id":"cv_prod","before":"` + later + `"}`,
		`{"action":"done","conversation_id":"cv_prod"}`, `{"action":"done","conversation_id":"cv_none","before":"` + later + `"}`} {
		if code, _ := call(t, e.h, "POST", "/api/im/messages/batch", body); code != 400 {
			t.Errorf("%s 应 400：%d", body, code)
		}
	}

	// 按 id：已处理的、不存在的跳过；挑中的稍后也处理
	call(t, e.h, "POST", "/api/im/messages/"+a+"/done", "")
	code, out := call(t, e.h, "POST", "/api/im/messages/batch", `{"action":"ignore","ids":["`+a+`","`+o+`","`+s+`","msg_none"]}`)
	if d := data(out); code != 200 || d["count"] != float64(2) || d["action"] != "ignore" {
		t.Fatalf("按 id：%d %v", code, out)
	}
	if status(a) != "done" || status(o) != "ignored" || status(s) != "ignored" {
		t.Fatalf("按 id 后状态不对：%s %s %s", status(a), status(o), status(s))
	}

	// 按会话 + 时间点之前：c 晚于时间点不动
	call(t, e.h, "POST", "/api/im/messages/"+s+"/reopen", "")
	call(t, e.h, "POST", "/api/im/messages/"+s+"/snooze", `{"until":"`+later+`"}`)
	code, out = call(t, e.h, "POST", "/api/im/messages/batch", `{"action":"done","conversation_id":"cv_prod","before":"2026-10-01T09:00:00Z"}`)
	if d := data(out); code != 200 || d["count"] != float64(1) || d["ids"].([]any)[0] != b {
		t.Fatalf("按会话：%d %v", code, out)
	}
	if status(b) != "done" || status(c) != "pending" || status(s) != "pending" {
		t.Fatalf("按会话后状态不对：b=%s c=%s s=%s", status(b), status(c), status(s))
	}
	_, out = call(t, e.h, "GET", "/api/im/messages/"+b, "")
	if m := data(out); m["read"] != true {
		t.Fatalf("批量处理完要标已读：%v", m)
	}
}
