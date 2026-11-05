package im

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 私信我确认、来消息确认派发（TSK-0411）：回复解析；私信发给「我」、我的回复不落成消息；执行 / 分配 / 不做三条分支、
// 认不出再问一次、超时提醒一次后不执行；同一条消息不重复建任务；内置流程只写一次。

func TestParseAnswer(t *testing.T) {
	cases := []struct{ in, choice, who string }{
		{"执行", askChoiceExecute, ""}, {" 好的。", askChoiceExecute, ""}, {"OK", askChoiceExecute, ""}, {"确认!", askChoiceExecute, ""},
		{"分配 林原", askChoiceAssign, "林原"}, {"分配给 @Lin Yuan", askChoiceAssign, "Lin Yuan"}, {"交给：张三。", askChoiceAssign, "张三"},
		{"不做", askChoiceCancel, ""}, {"取消", askChoiceCancel, ""}, {"算了", askChoiceCancel, ""},
		{"分配", askChoiceAssign, ""}, {"嗯？", "", ""}, {"执行一下看看再说", "", ""}, {"不好", "", ""}, {"", "", ""},
	}
	for _, c := range cases {
		if ch, who := parseAnswer(c.in); ch != c.choice || who != c.who {
			t.Errorf("parseAnswer(%q) = %q %q，应当 %q %q", c.in, ch, who, c.choice, c.who)
		}
	}
}

// confirmAgent 分类器认「要建任务」：说到「午饭」的不用。
type confirmAgent struct{ *intakeAgent }

func (a confirmAgent) Complete(ctx context.Context, req plugin.CompleteRequest) (string, error) {
	if strings.Contains(req.Prompt, "要建任务") {
		if strings.Contains(req.Prompt, "午饭") {
			return "不用", nil
		}
		return "要建任务", nil
	}
	return a.intakeAgent.Complete(ctx, req)
}

type confirmEnv struct {
	intakeEnv
	mu  *sync.Mutex
	seq *int
}

func setupConfirm(t *testing.T) confirmEnv {
	t.Helper()
	old := askEvery
	askEvery = 10 * time.Millisecond
	t.Cleanup(func() { askEvery = old })
	e := setupIntake(t)
	e.r.SetAgent(confirmAgent{e.agent})
	// 没有 Slack 连接器：私信走假适配器，「我」是它给的称呼 Broleez
	exec(t, e.st.DB(), `DELETE FROM connectors`,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_lin', '林原', 'x', 'x')`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+TaskConfirmFlowID, ""); code == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("等了 5 秒「来消息确认派发」还没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return confirmEnv{intakeEnv: e, mu: &sync.Mutex{}, seq: new(int)}
}

// msg 灌一条群里的消息，回消息 id。
func (e confirmEnv) msg(t *testing.T, text string) string {
	t.Helper()
	e.mu.Lock()
	*e.seq++
	ext := fmt.Sprintf("C01:%d", *e.seq)
	e.mu.Unlock()
	e.push(t, fmt.Sprintf(`{"external_id":%q,"conversation_id":"C01","conversation_kind":"group","conversation_name":"#product",
		"sender_id":"U04LIN","sender_name":"Lin Yuan","text":%q,"at":%q}`, ext, text, time.Now().UTC().Format(time.RFC3339Nano)))
	var id string
	if err := e.st.DB().R.QueryRow(`SELECT id FROM im_messages WHERE external_id = ?`, ext).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// reply 我在私信里回一句（发送人是我，私聊）。
func (e confirmEnv) reply(t *testing.T, text string) {
	t.Helper()
	e.mu.Lock()
	*e.seq++
	ext := fmt.Sprintf("D_ME:%d", *e.seq)
	e.mu.Unlock()
	e.push(t, fmt.Sprintf(`{"external_id":%q,"conversation_id":"D_ME","conversation_kind":"direct","sender_id":"Broleez","sender_name":"Broleez",
		"text":%q,"at":%q}`, ext, text, time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)))
}

// sentTo 是发给我的私信（假适配器记下的），按顺序。
func (e confirmEnv) dms() []Outgoing {
	var out []Outgoing
	for _, o := range e.fake.Sent() {
		if o.RecipientID == "Broleez" && o.ConversationKind == "direct" {
			out = append(out, o)
		}
	}
	return out
}

func (e confirmEnv) waitDM(t *testing.T, n int, want string) Outgoing {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if ds := e.dms(); len(ds) >= n {
			if !strings.Contains(ds[n-1].Text, want) {
				t.Fatalf("第 %d 条私信 %q 里应当有 %q", n, ds[n-1].Text, want)
			}
			return ds[n-1]
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒没有第 %d 条私信（%s），已发 %v", n, want, e.dms())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e confirmEnv) startConfirm(t *testing.T, input string) string {
	t.Helper()
	return e.start(t, TaskConfirmFlowID, `{"input":`+input+`}`)
}

func (e confirmEnv) asking(t *testing.T, runID string) {
	t.Helper()
	e.until(t, runID, "私信我确认挂起", func(run map[string]any) bool {
		s := sopStep(run, "ask")
		return s != nil && s["status"] == "running" && stepLogged(s, "等你回复")
	})
}

func (e confirmEnv) ended(t *testing.T, runID, status string) map[string]any {
	t.Helper()
	return e.until(t, runID, "执行结束："+status, func(run map[string]any) bool { return run["status"] == status })
}

func (e confirmEnv) mkTask(t *testing.T, title, project string) *domain.Object {
	t.Helper()
	o := &domain.Object{TypeID: "task", Title: title}
	if project != "" {
		o.ProjectID = &project
	}
	out, err := e.st.CreateObject(context.Background(), o, store.Actor{Name: "me", Source: "ui"})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// TestConfirmExecute：单独用（只给消息）：分类要建任务、建任务、私信我摘要；回「执行」派 Claude Code 在继承的项目目录里执行，
// 结束后私信回报；我的回复不落成消息。同一条消息再跑一次取回那条任务，不再建。
func TestConfirmExecute(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "客户端导出要支持 CSV")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q}`, mid))
	e.asking(t, rid)
	task := e.task(t, mid)
	exec(t, e.st.DB(), `UPDATE objects SET project_id = 'obj_acme' WHERE id = '`+task.ID+`'`)
	ask := e.waitDM(t, 1, task.Ref)
	if !strings.Contains(ask.Text, askHint) || !strings.Contains(ask.Text, "客户端导出要支持 CSV") || !strings.Contains(ask.Text, "http://pmw.test/tasks/board?t=") {
		t.Fatalf("问题 = %q", ask.Text)
	}
	e.reply(t, "执行")
	rq := e.recv(t)
	req := e.claude.last()
	if req.Workdir != e.code || !req.AllowWrites || !strings.Contains(req.Prompt, task.Ref) {
		t.Fatalf("执行请求 = %+v", req)
	}
	e.finish(t, rq, "加了 CSV 导出", nil)
	e.ended(t, rid, "done")
	e.waitDM(t, 2, "执行完了")
	if d := e.dms()[1].Text; !strings.Contains(d, "加了 CSV 导出") {
		t.Fatalf("回报 = %q", d)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_messages WHERE sender_external_id = 'Broleez'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("我的回复不该落成消息：%d %v", n, err)
	}
	// 同一条消息再跑：取回那条任务
	rid2 := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q}`, mid))
	e.asking(t, rid2)
	run := e.until(t, rid2, "建任务步骤完成", func(run map[string]any) bool { return sopStep(run, "to_task")["status"] == "done" })
	if tk := sopStep(run, "to_task")["output"].(map[string]any)["task"].(map[string]any); tk["id"] != task.ID || tk["reused"] != true {
		t.Fatalf("第二次 = %v", tk)
	}
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM objects WHERE type_id = 'task'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("任务 %d 条", n)
	}
}

// TestConfirmExecuteNoWorkdir：任务没有工作目录时不派发，私信回报原因和任务链接，执行照常结束。
func TestConfirmExecuteNoWorkdir(t *testing.T) {
	e := setupConfirm(t)
	task := e.mkTask(t, "没目录的任务", "obj_globex")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q,"task_id":%q}`, e.msg(t, "看一下"), task.ID))
	e.asking(t, rid)
	e.waitDM(t, 1, task.Ref)
	e.reply(t, "好")
	e.ended(t, rid, "done")
	d := e.waitDM(t, 2, "没执行成功")
	if !strings.Contains(d.Text, "没有工作目录") || !strings.Contains(d.Text, "所属项目「Globex」也没设") || !strings.Contains(d.Text, "tasks/board?t="+task.ID) {
		t.Fatalf("回报 = %q", d.Text)
	}
	select {
	case <-e.claude.started:
		t.Fatal("没目录不该派发")
	default:
	}
}

// TestConfirmAssign：回「分配 林原」改负责人并回一句；名字对不上时不改、回「没找到」。
func TestConfirmAssign(t *testing.T) {
	e := setupConfirm(t)
	task := e.mkTask(t, "整理权限点", "")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q,"task_id":%q}`, e.msg(t, "权限点"), task.ID))
	e.asking(t, rid)
	e.waitDM(t, 1, task.Ref)
	e.reply(t, "分配 林原")
	e.ended(t, rid, "done")
	e.waitDM(t, 2, "已把 "+task.Ref)
	if o, _ := e.st.GetObject(context.Background(), task.ID); o.OwnerID == nil || *o.OwnerID != "stk_lin" || o.Status != "todo" {
		t.Fatalf("任务 = owner %v status %s", o.OwnerID, o.Status)
	}

	t2 := e.mkTask(t, "另一条", "")
	rid = e.startConfirm(t, fmt.Sprintf(`{"message_id":%q,"task_id":%q}`, e.msg(t, "另一条"), t2.ID))
	e.asking(t, rid)
	e.waitDM(t, 3, t2.Ref)
	e.reply(t, "分配给 张三")
	e.ended(t, rid, "done")
	e.waitDM(t, 4, "没找到「张三」，任务留着没分配")
	if o, _ := e.st.GetObject(context.Background(), t2.ID); o.OwnerID != nil {
		t.Fatalf("不该分配：%v", *o.OwnerID)
	}
}

// TestConfirmCancel：回「不做」任务标为已取消，不执行。
func TestConfirmCancel(t *testing.T) {
	e := setupConfirm(t)
	task := e.mkTask(t, "不做的", "obj_acme")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q,"task_id":%q}`, e.msg(t, "x"), task.ID))
	e.asking(t, rid)
	e.waitDM(t, 1, task.Ref)
	e.reply(t, "不做")
	e.ended(t, rid, "done")
	e.waitDM(t, 2, "已取消 "+task.Ref)
	if o, _ := e.st.GetObject(context.Background(), task.ID); o.Status != "cancelled" {
		t.Fatalf("状态 = %s", o.Status)
	}
	select {
	case <-e.claude.started:
		t.Fatal("不做不该派发")
	default:
	}
}

// TestConfirmUnknownTwice：认不出再问一次（串在提问下面），还认不出就不执行，私信说明，任务留在未开工。
func TestConfirmUnknownTwice(t *testing.T) {
	e := setupConfirm(t)
	task := e.mkTask(t, "认不出", "obj_acme")
	rid := e.startConfirm(t, fmt.Sprintf(`{"message_id":%q,"task_id":%q}`, e.msg(t, "x"), task.ID))
	e.asking(t, rid)
	e.waitDM(t, 1, task.Ref)
	e.reply(t, "嗯？")
	re := e.waitDM(t, 2, "没认出「嗯？」")
	if re.ThreadOf == "" {
		t.Fatalf("再问应当串在提问下面：%+v", re)
	}
	e.reply(t, "你看着办")
	e.ended(t, rid, "done")
	e.waitDM(t, 3, "两次都没认出你的回复")
	if o, _ := e.st.GetObject(context.Background(), task.ID); o.Status != "todo" {
		t.Fatalf("状态 = %s", o.Status)
	}
	select {
	case <-e.claude.started:
		t.Fatal("认不出不该派发")
	default:
	}
}

// TestAskMeTimeout：到点先提醒一次，再到点以 choice=none 往下走（不执行）。
func TestAskMeTimeout(t *testing.T) {
	e := setupConfirm(t)
	fid := e.flow(t, `{"name":"问我","fields":[{"key":"x","label":"x","type":"text"}],"steps":[
		{"key":"ask","name":"私信我确认","kind":"im_ask_me","after":[],"config":{"text":"做不做 {{x}}","timeout":"1 秒"}}]}`)
	rid := e.start(t, fid, `{"input":{"x":"A"}}`)
	e.waitDM(t, 1, "做不做 A")
	e.waitDM(t, 2, "还在等你回复：做不做 A")
	run := e.ended(t, rid, "done")
	ans := sopStep(run, "ask")["output"].(map[string]any)["answer"].(map[string]any)
	if ans["choice"] != askChoiceNone || ans["reason"] != "timeout" || ans["asked"] != float64(2) {
		t.Fatalf("answer = %v", ans)
	}
}

// TestAskMeSendFails：私信发不出去时这一步失败（记运行异常），不静默。
func TestAskMeSendFails(t *testing.T) {
	e := setupConfirm(t)
	e.r.SetIncidents(incident.New(e.st.DB(), nil))
	e.fake.FailReplies("channel_not_found")
	fid := e.flow(t, `{"name":"问我","fields":[],"steps":[{"key":"ask","name":"私信我确认","kind":"im_ask_me","after":[],"config":{"text":"做不做"}}]}`)
	rid := e.start(t, fid, `{"input":{}}`)
	run := e.ended(t, rid, "failed")
	if msg, _ := sopStep(run, "ask")["error"].(string); !strings.Contains(msg, "私信发不出去") || !strings.Contains(msg, "channel_not_found") {
		t.Fatalf("失败原因 = %v", msg)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM incidents WHERE fingerprint LIKE 'sop:%:ask'`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("应当记运行异常：%d %v", n, err)
	}
}

// TestAskMeBotNeedsMemberID：Slack 连接器是 Bot 身份又没填「我的 Member ID」时，失败并说明去哪里填。
func TestAskMeBotNeedsMemberID(t *testing.T) {
	e := setupConfirm(t)
	exec(t, e.st.DB(), `INSERT INTO connectors (id, tool, name, status, direction, created_at, updated_at) VALUES
		('cn_bot', 'slack', 'Slack Bot', 'connected', 'both', 'x', 'x')`)
	fid := e.flow(t, `{"name":"问我","fields":[],"steps":[{"key":"ask","name":"私信我确认","kind":"im_ask_me","after":[],"config":{"text":"做不做"}}]}`)
	run := e.ended(t, e.start(t, fid, `{"input":{}}`), "failed")
	if msg, _ := sopStep(run, "ask")["error"].(string); !strings.Contains(msg, "认不出你在 Slack 上的本人身份") || !strings.Contains(msg, "我的 Member ID") {
		t.Fatalf("失败原因 = %v", msg)
	}
}

// TestToTaskReusesOtherFlowsTask：消息已经被别的流程（task 节点）建过任务时，转成任务取回那条、记到消息上。
func TestToTaskReusesOtherFlowsTask(t *testing.T) {
	e := setupConfirm(t)
	mid := e.msg(t, "别的流程建过")
	other := e.flow(t, `{"name":"分流","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"分流建的"}}]}`)
	e.ended(t, e.start(t, other, fmt.Sprintf(`{"input":{"message_id":%q}}`, mid)), "done")
	conv := e.flow(t, `{"name":"转","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"t","name":"转成任务","kind":"im_to_task","after":[]}]}`)
	run := e.ended(t, e.start(t, conv, fmt.Sprintf(`{"input":{"message_id":%q}}`, mid)), "done")
	tk := sopStep(run, "t")["output"].(map[string]any)["task"].(map[string]any)
	if tk["title"] != "分流建的" || tk["reused"] != true {
		t.Fatalf("转成任务 = %v", tk)
	}
	if got := e.task(t, mid); got.ID != tk["id"] {
		t.Fatalf("消息上记的 = %s", got.ID)
	}
}

// TestTaskConfirmFlowInstalledOnce：内置流程默认停用（手动），写过一次记下；用户删了不补回来。
func TestTaskConfirmFlowInstalledOnce(t *testing.T) {
	e := setupConfirm(t)
	_, out := call(t, e.h, "GET", "/api/sop/flows/"+TaskConfirmFlowID, "")
	if f := data(out); f["trigger"] != "manual" || f["version"] != float64(1) {
		t.Fatalf("内置流程 = %v", f)
	}
	if code, out := call(t, e.h, "DELETE", "/api/sop/flows/"+TaskConfirmFlowID, ""); code != 200 && code != 204 {
		t.Fatalf("删 %d %v", code, out)
	}
	time.Sleep(100 * time.Millisecond) // 后台任务跑过几轮
	if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+TaskConfirmFlowID, ""); code != 404 {
		t.Fatalf("删掉的不该补回来：%d", code)
	}
}

// TestAskMeFromSelfReply：Slack 以我本人身份接入时，我在私信里的回复拉回来是 FromSelf，同样认作回复，不记成别的消息的回复。
func TestAskMeFromSelfReply(t *testing.T) {
	e := setupConfirm(t)
	fid := e.flow(t, `{"name":"问我","fields":[],"steps":[{"key":"ask","name":"私信我确认","kind":"im_ask_me","after":[],"config":{"text":"做不做"}}]}`)
	rid := e.start(t, fid, `{"input":{}}`)
	e.waitDM(t, 1, "做不做")
	e.push(t, fmt.Sprintf(`{"external_id":"D_SELF:1","conversation_id":"D_SELF","conversation_kind":"direct","sender_id":"U_ME","sender_name":"我",
		"text":"分配 林原","from_self":true,"at":%q}`, time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)))
	run := e.ended(t, rid, "done")
	ans := sopStep(run, "ask")["output"].(map[string]any)["answer"].(map[string]any)
	if ans["choice"] != askChoiceAssign || ans["assignee"] != "林原" || ans["asked"] != float64(1) {
		t.Fatalf("answer = %v", ans)
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_replies WHERE text = '分配 林原'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("不该记成回复：%d %v", n, err)
	}
}

// Slack 我本人身份：从连接器账号「名字（Member ID）」里取 Member ID。
func TestMemberIDFromAccount(t *testing.T) {
	for in, want := range map[string]string{"zhangsan（U0EXAMPLE01）": "U0EXAMPLE01", "bot (U012AB34)": "U012AB34", "zhangsan": ""} {
		got := ""
		if m := memberIDRe.FindStringSubmatch(in); m != nil {
			got = m[1]
		}
		if got != want {
			t.Errorf("%q → %q，应当 %q", in, got, want)
		}
	}
}
