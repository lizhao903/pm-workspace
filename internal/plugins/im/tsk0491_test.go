package im

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// TSK-0491：SOP 调试真实取数、写操作不真写（调试前后库里没有任何变化），v3 原稿一调就看出问题，
// v4 显示真实消息内容和「将把消息标为忽略」；模拟 IM 触发按真实口径判每条 IM 流程；自动触发没发起的原因记下来。

// settled 等后台任务（IM 插件写内置流程等）写完，库里各表行数稳定下来再拍快照。
func settled(t *testing.T, e sopEnv) map[string]string {
	t.Helper()
	prev := tableCounts(t, e)
	for i := 0; i < 50; i++ {
		time.Sleep(60 * time.Millisecond)
		cur := tableCounts(t, e)
		if fmt.Sprint(cur) == fmt.Sprint(prev) && i >= 3 {
			return cur
		}
		prev = cur
	}
	return prev
}

// tableCounts 是库里每张表的行数，加上 im_messages 的状态签名：调试前后要一模一样。
func tableCounts(t *testing.T, e sopEnv) map[string]string {
	t.Helper()
	ctx := context.Background()
	rows, err := e.st.DB().W.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		names = append(names, n)
	}
	_ = rows.Close()
	out := map[string]string{}
	for _, n := range names {
		var c int
		if err := e.st.DB().W.QueryRowContext(ctx, `SELECT COUNT(*) FROM "`+n+`"`).Scan(&c); err != nil {
			t.Fatal(err)
		}
		out[n] = fmt.Sprint(c)
	}
	var sig string
	if err := e.st.DB().W.QueryRowContext(ctx, `SELECT COALESCE(group_concat(id || ':' || status || ':' || is_read, ','), '') FROM (SELECT * FROM im_messages ORDER BY id)`).Scan(&sig); err != nil {
		t.Fatal(err)
	}
	out["im_messages#status"] = sig
	return out
}

func sameCounts(t *testing.T, before, after map[string]string) {
	t.Helper()
	for k, v := range before {
		if after[k] != v {
			t.Errorf("调试后 %s 变了：%s → %s", k, v, after[k])
		}
	}
	if len(after) != len(before) {
		t.Errorf("调试后表的数量变了：%d → %d", len(before), len(after))
	}
}

// pushed 推一条消息进来，回它的 id。
func pushed(t *testing.T, e sopEnv, ext, conv, sender, text string, at time.Time) string {
	t.Helper()
	e.push(t, fmt.Sprintf(`{"external_id":%q,"conversation_id":%q,"conversation_name":"#ai-octok-platform","sender_id":%q,"sender_name":%q,"text":%q,"at":%q}`,
		ext, conv, sender, sender, text, at.UTC().Format(time.RFC3339)))
	var id string
	if err := e.st.DB().W.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func debugOf(t *testing.T, e sopEnv, body string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/sop/debug", body)
	if code != 200 {
		t.Fatalf("调试：%d %v", code, out)
	}
	return data(out)
}

func dstep(res map[string]any, key string) map[string]any {
	for _, s := range res["steps"].([]any) {
		if m := s.(map[string]any); m["key"] == key {
			return m
		}
	}
	return nil
}

func TestDebugV4ShowsRealMessageAndDoesNotWrite(t *testing.T) {
	e := setup0490(t)
	msg := pushed(t, e, "C0BNCBRL5C0:1", "C0BNCBRL5C0", "octok-bot", "部署完成 build #42", time.Now().Add(-time.Minute))
	id := e.flow(t, flowV4)
	before := settled(t, e)

	res := debugOf(t, e, fmt.Sprintf(`{"flow_id":%q,"message_id":%q}`, id, msg))
	if res["source"] != "message" || res["message_id"] != msg {
		t.Fatalf("输入应来自选的消息：%v", res)
	}
	m := res["message"].(map[string]any)
	if m["text"] != "部署完成 build #42" || m["conversation_id"] != "cv_octok" || m["relevance_key"] != "" {
		t.Fatalf("消息要真实取到正文和归类：%v", m)
	}
	in := res["input"].(map[string]any)
	if in["message_id"] != msg || in["conversation_id"] != "cv_octok" || in["channel"] != "slack" {
		t.Fatalf("输入按 IM 触发带上归类：%v", in)
	}
	s := dstep(res, "mark")
	act, _ := s["action"].(map[string]any)
	if s["status"] != "simulated" || s["effect"] != "write" || act == nil ||
		act["text"] != "将把消息 "+msg+" 标为「忽略（ignore）」" {
		t.Fatalf("标记消息只显示将做什么：%v", s)
	}
	if !strings.Contains(res["summary"].(string), "部署完成") || !strings.Contains(res["summary"].(string), "没真做") {
		t.Fatalf("结论要带消息和将做的事：%s", res["summary"])
	}
	sameCounts(t, before, tableCounts(t, e))
	var status string
	_ = e.st.DB().W.QueryRow(`SELECT status FROM im_messages WHERE id = ?`, msg).Scan(&status)
	if status != "pending" {
		t.Fatalf("消息不能真被标记：%s", status)
	}

	// 不给消息：取这条流程最近一次执行（没有）再最近一次没发起的记录（没有）→ 400
	if code, out := call(t, e.h, "POST", "/api/sop/debug", fmt.Sprintf(`{"flow_id":%q}`, id)); code != 400 || !strings.Contains(errText(out), "要选一条消息") {
		t.Fatalf("IM 流程没有可用的消息：%d %v", code, out)
	}
}

func TestDebugV3ExposesProblems(t *testing.T) {
	e := setup0490(t)
	msg := pushed(t, e, "C0BNCBRL5C0:1", "C0BNCBRL5C0", "octok-bot", "部署完成", time.Now())
	res := debugOf(t, e, fmt.Sprintf(`{"draft":%s,"message_id":%q}`, flowV3, msg))
	if !strings.Contains(fmt.Sprint(res["input_error"]), "会被跳过") {
		t.Fatalf("必填 input 补不齐要说出来：%v", res["input_error"])
	}
	s1 := dstep(res, "s1")
	if s1["status"] != "failed" || !strings.Contains(fmt.Sprint(s1["error"]), "写法不对") {
		t.Fatalf("一句话的条件调试时要失败：%v", s1)
	}
	if dstep(res, "s2")["status"] != "not_reached" || res["status"] != "failed" {
		t.Fatalf("下游没走到：%v", res)
	}
	if len(res["issues"].([]any)) == 0 {
		t.Fatalf("保存校验问题要一起列出：%v", res)
	}
}

// 读取消息 + 结构化条件：读类节点真实执行，条件逐条给真实值；step-fields 叠真实值、列出没声明的字段。
func TestDebugReadAndCondDetail(t *testing.T) {
	e := setup0490(t)
	msg := pushed(t, e, "C0BNCBRL5C0:9", "C0BNCBRL5C0", "Lin", "@Broleez 帮我看下", time.Now())
	flow := `{"name":"分诊","trigger":"im","fields":[],"steps":[
	 {"key":"get","name":"读消息","kind":"im_get_message","after":[]},
	 {"key":"d","name":"@我吗","kind":"decide","after":["get"],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}],
	  "cond":{"logic":"and","items":[{"field":"message.relevance_key","op":"eq","value":"me"},{"field":"message.text","op":"contains","value":"帮"}]}},
	 {"key":"t","name":"建任务","kind":"task","after":["d"],"branch":{"of":"d","case":"yes"},"config":{"title":"跟进：{{message.text}}"}},
	 {"key":"n","name":"不管","kind":"review","after":["d"],"branch":{"of":"d","case":"no"}}]}`
	before := settled(t, e)
	res := debugOf(t, e, fmt.Sprintf(`{"draft":%s,"message_id":%q}`, flow, msg))
	get := dstep(res, "get")
	if get["status"] != "done" || get["effect"] != "read" {
		t.Fatalf("读取消息要真实执行：%v", get)
	}
	var sampled bool
	for _, f := range get["fields"].([]any) {
		fm := f.(map[string]any)
		if fm["path"] == "message.text" && fm["sample"] == "@Broleez 帮我看下" && fm["declared"] == true {
			sampled = true
		}
	}
	if !sampled {
		t.Fatalf("字段要带真实值：%v", get["fields"])
	}
	d := dstep(res, "d")
	cond := d["cond"].(map[string]any)
	items := cond["items"].([]any)
	if d["route"] != "yes" || cond["result"] != true || items[0].(map[string]any)["actual"] != "me" || items[0].(map[string]any)["ok"] != true {
		t.Fatalf("条件逐条给真实值和判定：%v", d)
	}
	tk := dstep(res, "t")
	if tk["status"] != "simulated" || tk["action"].(map[string]any)["text"] != "将建任务「跟进：@Broleez 帮我看下」" {
		t.Fatalf("建任务只显示将做什么：%v", tk)
	}
	if dstep(res, "n")["status"] != "bypassed" {
		t.Fatalf("另一个分支不走：%v", dstep(res, "n"))
	}
	sameCounts(t, before, tableCounts(t, e))

	// step-fields 带 sample：声明的字段补真实值，没声明的另列一组
	sample, _ := json.Marshal(dstep(res, "d")["input"])
	extra := strings.Replace(string(sample), `{`, `{"debug_extra":{"x":1},`, 1)
	code, out := call(t, e.h, "POST", "/api/sop/step-fields", fmt.Sprintf(`{"draft":%s,"step":"d","sample":%s}`, flow, extra))
	if code != 200 {
		t.Fatalf("字段：%d %v", code, out)
	}
	var found, undeclared bool
	for _, g := range out["data"].([]any) {
		gm := g.(map[string]any)
		for _, f := range gm["fields"].([]any) {
			fm := f.(map[string]any)
			if fm["path"] == "message.relevance_key" && fm["sample"] == "me" {
				found = true
			}
			if gm["source"] == "sample" && fm["path"] == "debug_extra.x" && fm["declared"] == false {
				undeclared = true
			}
		}
	}
	if !found || !undeclared {
		t.Fatalf("要叠真实值、列出没声明的字段：%v", out["data"])
	}
}

// 模拟 IM 触发：v4（第 1 个、拦截）和一条接全部消息的流程；拦截、过滤不符各自写清楚，不真发起。
func TestExplainIMTrigger(t *testing.T) {
	e := setup0490(t)
	v4 := e.flow(t, flowV4)
	all := e.flow(t, `{"name":"全部消息摘要","trigger":"im","fields":[],"steps":[{"key":"g","name":"读","kind":"im_get_message","after":[]}]}`)
	bot := pushed(t, e, "C0BNCBRL5C0:1", "C0BNCBRL5C0", "octok-bot", "部署完成", time.Now())
	me := pushed(t, e, "C0BNCBRL5C0:2", "C0BNCBRL5C0", "Lin", "@Broleez 看下", time.Now())
	before := settled(t, e)

	explain := func(id string) map[string]any {
		code, out := call(t, e.h, "POST", "/api/sop/im-explain", fmt.Sprintf(`{"message_id":%q}`, id))
		if code != 200 {
			t.Fatalf("模拟：%d %v", code, out)
		}
		return data(out)
	}
	verdicts := func(res map[string]any) map[string]string {
		out := map[string]string{}
		for _, f := range res["flows"].([]any) {
			fm := f.(map[string]any)
			out[fm["flow_id"].(string)] = fm["verdict"].(string)
		}
		return out
	}
	r1 := explain(bot)
	if v := verdicts(r1); v[v4] != "start" || v[all] != "stopped" {
		t.Fatalf("机器人消息：v4 发起并拦截后面的：%v", r1)
	}
	if ws := r1["will_start"].([]any); len(ws) != 1 || ws[0] != v4 {
		t.Fatalf("只会发起 v4：%v", ws)
	}
	r2 := explain(me)
	if v := verdicts(r2); v[v4] != "filtered" || v[all] != "start" {
		t.Fatalf("@我的消息：v4 过滤不符、后面的照常：%v", r2)
	}
	if !strings.Contains(r2["summary"].(string), "与我的关系是「@我」") {
		t.Fatalf("过滤不符要说出哪一条：%s", r2["summary"])
	}
	sameCounts(t, before, tableCounts(t, e))

	// 发信人被自动忽略：所有 IM 流程都收不到
	if code, out := call(t, e.h, "POST", "/api/im/mutes", `{"channel":"slack","sender_id":"octok-bot","ignore_pending":true}`); code != 201 {
		t.Fatalf("标记：%d %v", code, out)
	}
	muted := pushed(t, e, "C0BNCBRL5C0:3", "C0BNCBRL5C0", "octok-bot", "又部署了", time.Now())
	r3 := explain(muted)
	if r3["delivered"] != false || verdicts(r3)[v4] != "muted" || !strings.Contains(r3["summary"].(string), "自动忽略") {
		t.Fatalf("被自动忽略的消息：%v", r3)
	}
}

// 自动触发没发起的记录：过滤不符、被拦截、发信人被自动忽略都记下来，流程详情能看到。
func TestSkipsRecorded(t *testing.T) {
	e := setup0490(t)
	ctx := context.Background()
	v4 := e.flow(t, flowV4)
	all := e.flow(t, `{"name":"全部消息摘要","trigger":"im","fields":[],"steps":[{"key":"g","name":"读","kind":"review","after":[]}]}`)
	deliver := func(typ, id, rel string, extra map[string]any) {
		t.Helper()
		p := map[string]any{"message_id": id, "channel": "slack", "connector_id": "", "conversation_id": "cv_octok", "relevance": rel,
			"at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
		for k, v := range extra {
			p[k] = v
		}
		b, _ := json.Marshal(p)
		subs := e.r.Subscribers(typ)
		if len(subs) == 0 {
			t.Fatalf("没有插件订阅 %s", typ)
		}
		for _, s := range subs {
			if err := s.Handle(ctx, plugin.Event{Type: typ, At: time.Now(), Payload: b}); err != nil {
				t.Fatal(err)
			}
		}
	}
	deliver("im.message_received", "msg_bot", "", nil)
	deliver("im.message_received", "msg_me", "me", nil)
	deliver("im.message_muted", "msg_muted", "", map[string]any{"mute_id": "imu_1", "mute_name": "octok-bot"})

	skips := func(id, q string) []map[string]any {
		code, out := call(t, e.h, "GET", "/api/sop/flows/"+id+"/skips"+q, "")
		if code != 200 {
			t.Fatalf("没发起的记录：%d %v", code, out)
		}
		var res []map[string]any
		for _, x := range out["data"].([]any) {
			res = append(res, x.(map[string]any))
		}
		return res
	}
	reasons := func(list []map[string]any) map[string]string {
		out := map[string]string{}
		for _, s := range list {
			out[s["source_ref"].(string)] = s["reason"].(string)
		}
		return out
	}
	if r := reasons(skips(v4, "")); r["msg_me"] != "filtered" || r["msg_muted"] != "muted" || len(r) != 2 {
		t.Fatalf("v4 的记录：%v", r)
	}
	if r := reasons(skips(all, "")); r["msg_bot"] != "stopped" || r["msg_muted"] != "muted" || len(r) != 2 {
		t.Fatalf("后面那条的记录：%v", r)
	}
	if list := skips(v4, "?reason=-filtered"); len(list) != 1 || list[0]["reason"] != "muted" {
		t.Fatalf("按原因排除：%v", list)
	}
	// 调试不写记录、不建执行：msg_me 那条在 v4 后面的流程发起了一次，调试 v4 不多出来
	var runs int
	_ = e.st.DB().W.QueryRow(`SELECT COUNT(*) FROM sop_runs`).Scan(&runs)
	if runs != 2 {
		t.Fatalf("v4 发起了 msg_bot、后面那条发起了 msg_me：%d", runs)
	}
	if code, out := call(t, e.h, "GET", "/api/sop/flows/"+v4+"/skips?reason=bogus", ""); code != 400 {
		t.Fatalf("不认的原因 400：%d %v", code, out)
	}
}

func errText(out map[string]any) string {
	if e, ok := out["error"].(map[string]any); ok {
		return fmt.Sprint(e["message"])
	}
	return ""
}
