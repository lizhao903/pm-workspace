package im

import (
	"context"
	"fmt"
	"net"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 研发 pipeline（AUTO-09）：真的 git 临时仓库、真的测试命令和测试环境（python3 -m http.server），Claude Code 用假执行器。
// 三路并行 → 汇合 → 测试没过退回研发（带失败步骤和报告）→ 通过后保留测试环境、通知提出人和验收人员 →
// 人工验收「实现缺陷」退回研发 → 再验收「通过」进待发布；需求偏差退回产品；测试修复超限转人工。

// pipeClaude 是假的 Claude Code：每次运行单独等结果，按提示词认是哪一路。
type pipeClaude struct {
	mu      sync.Mutex
	waits   map[string]chan *runner.Result
	started chan runner.Request
}

func newPipeClaude() *pipeClaude {
	return &pipeClaude{waits: map[string]chan *runner.Result{}, started: make(chan runner.Request, 16)}
}

func (f *pipeClaude) Start(ctx context.Context, req runner.Request, _ func(runner.Event)) (*runner.Result, error) {
	ch := make(chan *runner.Result, 1)
	f.mu.Lock()
	f.waits[req.RunID] = ch
	f.mu.Unlock()
	f.started <- req
	select {
	case res := <-ch:
		return res, nil
	case <-ctx.Done():
		return &runner.Result{Status: domain.RunCanceled, ExitCode: -1, Error: "已取消"}, nil
	}
}

// notes 是假的通知中心，记下插件发的平台通知。
type notes struct {
	mu  sync.Mutex
	got []plugin.Notification
}

func (n *notes) NotifyFromPlugin(_ context.Context, x plugin.Notification) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.got = append(n.got, x)
	return nil
}

func (n *notes) list() []plugin.Notification {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]plugin.Notification(nil), n.got...)
}

type pipeEnv struct {
	intakeEnv
	pc    *pipeClaude
	notes *notes
	repo  string
	port  int
	// prod 是假的「生产」：发布前检查、发布、回滚各在里面留标记文件，线上冒烟看有没有 smoke_ok（AUTO-10）
	prod string
}

// role 认是哪一路：dev、cases、autotest。
func role(req runner.Request) string {
	switch {
	case strings.Contains(req.Prompt, "设计测试用例"):
		return "cases"
	case strings.Contains(req.Prompt, "写自动化测试"):
		return "autotest"
	case strings.Contains(req.Prompt, "的内容和验收标准开发"):
		return "dev"
	}
	return "?"
}

// next 等下一次 Claude Code 发起。
func (e pipeEnv) next(t *testing.T) runner.Request {
	t.Helper()
	select {
	case req := <-e.pc.started:
		return req
	case <-time.After(10 * time.Second):
		t.Fatal("等了 10 秒 Claude Code 还没被发起")
		return runner.Request{}
	}
}

// nextN 等 n 次发起，按角色分好。
func (e pipeEnv) nextN(t *testing.T, n int) map[string]runner.Request {
	t.Helper()
	out := map[string]runner.Request{}
	for range n {
		req := e.next(t)
		out[role(req)] = req
	}
	return out
}

func (e pipeEnv) done(t *testing.T, req runner.Request, summary string) {
	t.Helper()
	if _, err := e.r.ReportRun(req.RunID, "done", summary, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	e.pc.mu.Lock()
	ch := e.pc.waits[req.RunID]
	e.pc.mu.Unlock()
	ch <- &runner.Result{Status: domain.RunDone, Output: summary}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := osexec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// setupPipeline：Acme 的代码库是临时 git 仓库，档案命令：起测试环境（python http.server）、测试（工作区里有 ok.flag 才过）；
// 验收人员「验收甲」；任务由一条 IM 消息转来、归到 Acme。testCmd 为空用默认的。
func setupPipeline(t *testing.T, testCmd string) (pipeEnv, string, *domain.Object) {
	t.Helper()
	if _, err := osexec.LookPath("python3"); err != nil {
		t.Skip("本机没装 python3")
	}
	ie := setupIntake(t)
	e := pipeEnv{intakeEnv: ie, pc: newPipeClaude(), notes: &notes{}}
	e.r.SetClaudeRunner(e.pc)
	e.r.SetNotifier(e.notes)
	e.repo = t.TempDir()
	git(t, e.repo, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(e.repo, "README.md"), []byte("acme\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, e.repo, "add", ".")
	git(t, e.repo, "commit", "-q", "-m", "init")
	// 端口段挑一段随机的高位端口，避开别的测试
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e.port = 20000 + (l.Addr().(*net.TCPAddr).Port % 400 * 100)
	_ = l.Close()
	if code, out := call(t, e.h, "PATCH", "/api/projects/worktree-settings", fmt.Sprintf(`{"port_min":%d,"port_max":%d,"port_block":10}`, e.port, e.port+9)); code != 200 {
		t.Fatalf("端口范围 %d %v", code, out)
	}
	if testCmd == "" {
		testCmd = "test -f ok.flag"
	}
	exec(t, e.st.DB(), `INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_acc', '验收甲', 'x', 'x'), ('stk_acc2', '验收乙', 'x', 'x')`)
	e.prod = t.TempDir()
	exec(t, e.st.DB(), `INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_own', '负责人丙', 'x', 'x')`)
	body := `{"code_dir":"` + e.repo + `","acceptor_ids":["stk_acc","stk_acc2"],"owner_ids":["stk_own"],"commands":{` +
		`"test_env":{"command":"exec python3 -m http.server $PORT --bind 127.0.0.1","timeout_sec":20,"ready":"/"},` +
		`"test":{"command":` + strconv.Quote(testCmd) + `},` +
		`"version":{"command":` + strconv.Quote(`echo v2.0.1 > "$RELEASE_DIR/version.txt"; echo "- 导出支持 CSV" > "$RELEASE_DIR/changelog.md"`) + `},` +
		`"package":{"command":"echo packed"},` +
		`"preflight":{"command":` + strconv.Quote("touch "+e.prod+"/backup") + `},` +
		`"release":{"command":` + strconv.Quote("touch "+e.prod+"/deployed") + `},` +
		`"prod_smoke":{"command":` + strconv.Quote("test -f "+e.prod+"/smoke_ok") + `},` +
		`"rollback":{"command":` + strconv.Quote("touch "+e.prod+"/rolled_back") + `}}}`
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_acme/profile", body); code != 200 {
		t.Fatalf("档案 %d %v", code, out)
	}
	e.push(t, `{"external_id":"C01:p1","connector_id":"cn_ok","conversation_id":"C01","conversation_name":"#product","sender_id":"U1","sender_name":"林原","text":"导出加 CSV"}`)
	msg := e.msgID(t, "导出加 CSV")
	task, _ := e.toTask(t, msg, `{"reply_on_done":false}`)
	exec(t, e.st.DB(), `UPDATE objects SET project_id = 'obj_acme' WHERE id = '`+task["id"].(string)+`'`)
	o, err := e.st.GetObject(context.Background(), task["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	waitPipelineFlow(t, e)
	return e, msg, o
}

func waitPipelineFlow(t *testing.T, e pipeEnv) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+DevPipelineFlowID, ""); code == 200 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("研发 pipeline 没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e pipeEnv) stage(t *testing.T, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		o, err := e.st.GetObject(context.Background(), taskID)
		if err != nil {
			t.Fatal(err)
		}
		if domain.StageOf(o.Props) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("阶段应为 %s，实际 %s", want, domain.StageOf(o.Props))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitRun 同 until，等得久一些（测试命令、测试环境是真跑的）。
func (e pipeEnv) waitRun(t *testing.T, runID, what string, ok func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		code, out := call(t, e.h, "GET", "/api/sop/runs/"+runID, "")
		if code != 200 {
			t.Fatalf("取执行 %d %v", code, out)
		}
		if ok(data(out)) {
			return data(out)
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 30 秒还没有：%s，步骤：%v", what, briefSteps(data(out)))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func briefSteps(run map[string]any) string {
	var b strings.Builder
	for _, s := range run["steps"].([]any) {
		m := s.(map[string]any)
		fmt.Fprintf(&b, "%v=%v", m["key"], m["status"])
		if e, _ := m["error"].(string); e != "" {
			fmt.Fprintf(&b, "(%s)", e)
		}
		b.WriteString(" ")
	}
	return b.String()
}

func (e pipeEnv) act(t *testing.T, runID, body string) {
	t.Helper()
	if code, out := call(t, e.h, "POST", "/api/sop/runs/"+runID+"/actions", body); code != 200 {
		t.Fatalf("动作 %s：%d %v", body, code, out)
	}
}

func waitClosed(t *testing.T, port int, what string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for listening(port) {
		if time.Now().After(deadline) {
			t.Fatal(what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func listening(port int) bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// TestDevPipelineFlowInstalled：内置流程写进 SOP，触发方式手动（默认停用），校验过（三路并行、两个条件回退、人工验收三个分支）。
func TestDevPipelineFlowInstalled(t *testing.T) {
	e := setupIntake(t)
	deadline := time.Now().Add(5 * time.Second)
	var f map[string]any
	for {
		code, out := call(t, e.h, "GET", "/api/sop/flows/"+DevPipelineFlowID, "")
		if code == 200 {
			f = data(out)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("研发 pipeline 没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if f["trigger"] != "manual" || f["name"] != "研发 pipeline" {
		t.Fatalf("内置流程：%v", f)
	}
	kinds := map[string]string{}
	for _, s := range f["steps"].([]any) {
		m := s.(map[string]any)
		kinds[m["key"].(string)] = m["kind"].(string)
	}
	for k, want := range map[string]string{"worktree": "projects_prepare_worktree", "dev": "claude_code", "cases": "claude_code", "autotest": "claude_code",
		"join": "aggregate", "test": "projects_run_test", "test_gate": "loopback", "notify": NodeNotify, "accept": "decide", "accept_gate": "loopback"} {
		if kinds[k] != want {
			t.Fatalf("步骤 %s 应是 %s：%v", k, want, kinds)
		}
	}
	// 受理流程末尾接上了它
	_, out := call(t, e.h, "GET", "/api/sop/flows/"+AutoIntakeFlowID, "")
	var sub map[string]any
	for _, s := range data(out)["steps"].([]any) {
		if m := s.(map[string]any); m["key"] == "pipeline" {
			sub = m
		}
	}
	if sub == nil || sub["kind"] != "subflow" || sub["config"].(map[string]any)["sop"] != DevPipelineFlowID {
		t.Fatalf("受理流程末尾要接研发 pipeline：%v", sub)
	}
	if kinds["release"] != "subflow" || kinds["release_args"] != "end" {
		t.Fatalf("验收通过后接发布 pipeline：%v", kinds)
	}
	// 发布 pipeline：手动触发；上线只接在人工审批的「批准」分支后
	code, out := call(t, e.h, "GET", "/api/sop/flows/"+ReleasePipelineFlowID, "")
	if code != 200 || data(out)["trigger"] != "manual" || data(out)["name"] != "发布 pipeline" {
		t.Fatalf("发布 pipeline：%d %v", code, out)
	}
	var deploy, approve map[string]any
	for _, s := range data(out)["steps"].([]any) {
		switch m := s.(map[string]any); m["key"] {
		case "deploy":
			deploy = m
		case "approve":
			approve = m
		}
	}
	if approve["kind"] != "decide" || approve["rule"] != nil && approve["rule"] != "" || deploy["kind"] != "projects_release" ||
		fmt.Sprint(deploy["after"]) != "[approve]" || deploy["branch"].(map[string]any)["case"] != "approve" {
		t.Fatalf("上线要接在人工审批的批准分支后：%v %v", approve, deploy)
	}
}

// TestDevPipelineUpgradeToRelease：生产上已经写过第 1 版「研发 pipeline」（验收通过后以结束收尾）：还是第 1 版的换成接发布 pipeline 的新版；用户改过的不动。
func TestDevPipelineUpgradeToRelease(t *testing.T) {
	e := setupIntake(t)
	waitPipelineFlow(t, pipeEnv{intakeEnv: e})
	old := func() {
		t.Helper()
		// 第 1 版：验收通过分支末尾是 done（结束），没有 release_in、release_args、release
		f := devPipelineFlow()
		steps := strings.Replace(string(f.Steps), `{"key":"release_in"`, "\x00", 1)
		head := steps[:strings.Index(steps, "\x00")]
		tail := steps[strings.Index(steps, `{"key":"back_dev"`):]
		steps = head + `{"key":"done","name":"结束","kind":"end","after":["tell_release"]},` + tail
		if code, out := call(t, e.h, "DELETE", "/api/sop/flows/"+DevPipelineFlowID, ""); code != 200 {
			t.Fatalf("删 %d %v", code, out)
		}
		body := `{"id":"` + f.ID + `","name":"` + f.Name + `","trigger":"manual","fields":` + string(f.Fields) + `,"steps":` + steps + `}`
		if code, out := call(t, e.h, "POST", "/api/sop/flows", body); code != 201 {
			t.Fatalf("建旧版 %d %v", code, out)
		}
		exec(t, e.st.DB(), `DELETE FROM im_sop_templates WHERE flow_id = '`+devPipelineUpgradeMark+`'`)
	}
	hasRelease := func() bool {
		_, out := call(t, e.h, "GET", "/api/sop/flows/"+DevPipelineFlowID, "")
		return strings.Contains(fmt.Sprint(data(out)["steps"]), ReleasePipelineFlowID)
	}
	marked := func() bool {
		var n int
		_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, devPipelineUpgradeMark).Scan(&n)
		return n == 1
	}
	wait := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatal("等了 5 秒还没有：" + what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	old()
	if hasRelease() {
		t.Fatal("准备的旧版不该接发布")
	}
	wait("换成新版", func() bool { return hasRelease() && marked() })

	// 用户改过（第 2 版）：不动，记标记不再试
	old()
	if code, out := call(t, e.h, "PATCH", "/api/sop/flows/"+DevPipelineFlowID, `{"name":"研发 pipeline（改）"}`); code != 200 {
		t.Fatalf("改 %d %v", code, out)
	}
	wait("记标记", marked)
	if hasRelease() {
		t.Fatal("改过的不该换")
	}
}

// TestDevPipelineHappyPathWithRework：三路并行 → 测试没过退回研发一轮 → 通过、保留环境、通知 → 验收发现实现缺陷退回研发 → 再验收通过、待发布。
func TestDevPipelineHappyPathWithRework(t *testing.T) {
	e, msg, task := setupPipeline(t, "")
	runID := e.start(t, DevPipelineFlowID, `{"input":{"task_id":"`+task.ID+`","message_id":"`+msg+`"},"object_id":"`+task.ID+`"}`)

	// 三路并行，都在工作区里跑
	first := e.nextN(t, 3)
	e.stage(t, task.ID, "developing")
	dev, cases, auto := first["dev"], first["cases"], first["autotest"]
	if dev.RunID == "" || cases.RunID == "" || auto.RunID == "" {
		t.Fatalf("三路要并行发起：%v", first)
	}
	wt := dev.Workdir
	if !strings.Contains(wt, filepath.Join("worktrees", "obj_acme", task.Ref)) || cases.Workdir != wt || auto.Workdir != wt || !dev.AllowWrites || !cases.AllowWrites {
		t.Fatalf("工作目录、权限：dev %s %v cases %s %v auto %s", dev.Workdir, dev.AllowWrites, cases.Workdir, cases.AllowWrites, auto.Workdir)
	}
	if !strings.Contains(dev.Prompt, task.Ref) || !strings.Contains(dev.Prompt, "auto/"+task.Ref) || strings.Contains(dev.Prompt, "评审不通过") ||
		!strings.Contains(cases.Prompt, "docs/test-cases/"+task.Ref+".md") || !strings.Contains(auto.Prompt, "TEST_REPORT_DIR") {
		t.Fatalf("提示词：\n%s\n---\n%s\n---\n%s", dev.Prompt, cases.Prompt, auto.Prompt)
	}
	e.done(t, cases, "- [ ] 导出菜单里有 CSV\n- [ ] CSV 能用表格打开")
	e.done(t, auto, "加了 export_test.go")
	// 汇合要等研发这一路
	run := e.waitRun(t, runID, "两路完成", func(r map[string]any) bool { return sopStep(r, "autotest_note")["status"] == "done" })
	if sopStep(run, "join")["status"] != "pending" {
		t.Fatalf("研发没完不该汇合：%v", sopStep(run, "join"))
	}
	e.done(t, dev, "导出菜单加了 CSV")

	// 第一次测试没过（工作区里还没有 ok.flag），退回研发，带上失败步骤和报告
	dev2 := e.next(t)
	if role(dev2) != "dev" || !strings.Contains(dev2.Prompt, "没过的步骤 test") || !strings.Contains(dev2.Prompt, "report.md") ||
		!strings.Contains(dev2.Prompt, "测试没通过就退回研发") {
		t.Fatalf("测试没过退回研发：%s", dev2.Prompt)
	}
	e.stage(t, task.ID, "developing")
	run = e.waitRun(t, runID, "", func(map[string]any) bool { return true })
	if sopStep(run, "test_gate")["loops"].(float64) != 1 || sopStep(run, "cases")["status"] != "done" || sopStep(run, "dev")["round"].(float64) != 2 {
		t.Fatalf("退回：gate %v cases %v dev %v", sopStep(run, "test_gate")["loops"], sopStep(run, "cases")["status"], sopStep(run, "dev")["round"])
	}
	if err := os.WriteFile(filepath.Join(wt, "ok.flag"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.done(t, dev2, "补了 CSV 的编码")

	// 通过：待验收，测试环境保留，通知提出人（原消息串里）和平台通知
	run = e.waitRun(t, runID, "停在人工验收", func(r map[string]any) bool { return sopStep(r, "accept")["status"] == "review" })
	e.stage(t, task.ID, "accepting")
	tst := sopStep(run, "test")["output"].(map[string]any)["test"].(map[string]any)
	if tst["ok"] != true || tst["env_kept"] != true || !listening(e.port) {
		t.Fatalf("测试通过、环境保留：%v", tst)
	}
	sent := e.fake.Sent()
	last := sent[len(sent)-1]
	url := "http://127.0.0.1:" + strconv.Itoa(e.port)
	for _, want := range []string{task.Ref + "「", "请验收", url + "（保留到 ", "http://pmw.test/api/projects/tests/runs/tr_", "/report",
		"http://pmw.test/tasks/board?t=" + task.ID, "验收甲、验收乙", "补了 CSV 的编码", "- [ ] CSV 能用表格打开"} {
		if !strings.Contains(last.Text, want) {
			t.Fatalf("通知要有 %q：\n%s", want, last.Text)
		}
	}
	if last.ReplyTo != "C01:p1" {
		t.Fatalf("在原消息串里回复：%+v", last)
	}
	ns := e.notes.list()
	if len(ns) != 1 || ns[0].ObjectID != task.ID || ns[0].Title != task.Ref+" 待验收" || ns[0].Kind != "im.notify" || !strings.Contains(ns[0].Body, url) {
		t.Fatalf("平台通知：%+v", ns)
	}

	// 人工验收：实现缺陷，退回研发；保留的环境回收
	e.act(t, runID, `{"kind":"route","step":"accept","route":"defect"}`)
	dev3 := e.next(t)
	if role(dev3) != "dev" || !strings.Contains(dev3.Prompt, "验收不通过退回研发") {
		t.Fatalf("验收退回研发：%s", dev3.Prompt)
	}
	e.stage(t, task.ID, "developing")
	waitClosed(t, e.port, "验收退回后保留的测试环境要回收")
	e.done(t, dev3, "按验收意见改了列顺序")
	run = e.waitRun(t, runID, "再次停在人工验收", func(r map[string]any) bool { return sopStep(r, "accept")["status"] == "review" })
	if sopStep(run, "accept_gate")["status"] != "pending" || sopStep(run, "back_dev")["status"] != "pending" {
		t.Fatalf("退回后缺陷分支要回到未开始：%v", briefSteps(run))
	}
	if len(e.notes.list()) != 2 {
		t.Fatalf("第二次待验收要再通知：%+v", e.notes.list())
	}

	// 验收通过：待发布，告诉提出人，环境回收，接着走发布 pipeline（AUTO-10）
	e.act(t, runID, `{"kind":"route","step":"accept","route":"pass"}`)
	run = e.waitRun(t, runID, "进了发布 pipeline", func(r map[string]any) bool { return sopStep(r, "release")["child_run_id"] != nil })
	for _, k := range []string{"back_design", "tell_pm", "test_human_stage", "accept_human_stage"} {
		if sopStep(run, k)["status"] != "bypassed" {
			t.Fatalf("%s 应没走到：%v", k, briefSteps(run))
		}
	}
	if sopStep(run, "tell_release")["status"] != "done" {
		t.Fatalf("告诉提出人验收通过：%v", briefSteps(run))
	}
	waitClosed(t, e.port, "验收通过后保留的测试环境要回收")
	child := sopStep(run, "release")["child_run_id"].(string)
	crun := e.waitRun(t, child, "停在上线审批", func(r map[string]any) bool { return sopStep(r, "approve")["status"] == "review" })
	in := sopStep(crun, "start")["input"].(map[string]any)
	if len(in) != 3 || in["task_id"] != task.ID || in["message_id"] != msg {
		t.Fatalf("发布 pipeline 只带任务和来源消息：%v", in)
	}
	e.stage(t, task.ID, "releasing")
	if e.prodHas("backup") || e.prodHas("deployed") {
		t.Fatal("审批前动了生产")
	}
	ns = e.notes.list()
	if a := ns[len(ns)-1]; a.Title != task.Ref+" 待上线审批" || !strings.Contains(a.Body, "v2.0.1") || !strings.Contains(a.Body, "导出支持 CSV") ||
		!strings.Contains(a.Body, "负责人丙") || !strings.Contains(a.Body, "/api/projects/releases/runs/rel_") {
		t.Fatalf("审批通知：%+v", a)
	}
	sent = e.fake.Sent()
	if !strings.Contains(sent[len(sent)-1].Text, "验收通过") || sent[len(sent)-1].ReplyTo != "C01:p1" {
		t.Fatalf("审批通知不回复提出人，最后一条还是验收通过：%+v", sent[len(sent)-1])
	}

	// 批准：备份、发布、线上冒烟通过，阶段已上线，回复原消息，两层执行都结束
	if err := os.WriteFile(filepath.Join(e.prod, "smoke_ok"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	e.act(t, child, `{"kind":"route","step":"approve","route":"approve"}`)
	e.waitRun(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	crun = e.waitRun(t, child, "", func(map[string]any) bool { return true })
	e.stage(t, task.ID, "released")
	if !e.prodHas("backup") || !e.prodHas("deployed") || e.prodHas("rolled_back") || sopStep(crun, "fail_stage")["status"] != "bypassed" {
		t.Fatalf("上线：%v", briefSteps(crun))
	}
	sent = e.fake.Sent()
	if last := sent[len(sent)-1]; !strings.Contains(last.Text, "已上线，版本 v2.0.1") || last.ReplyTo != "C01:p1" {
		t.Fatalf("回复原消息已上线：%+v", last)
	}
	if ns := e.notes.list(); ns[len(ns)-1].Level != plugin.NotifySuccess || ns[len(ns)-1].Title != task.Ref+" 已上线" {
		t.Fatalf("上线通知：%+v", ns[len(ns)-1])
	}
}

func (e pipeEnv) prodHas(name string) bool {
	_, err := os.Stat(filepath.Join(e.prod, name))
	return err == nil
}

// TestReleasePipelineRollbackAndHold：单独发起发布 pipeline。线上冒烟没过自动回滚、阶段需人工、只发平台通知不回复提出人；
// 再来一次，审批选暂缓：不动生产，阶段保持待发布。
func TestReleasePipelineRollbackAndHold(t *testing.T) {
	e, msg, task := setupPipeline(t, "")
	if code, out := call(t, e.h, "POST", "/api/projects/worktrees", `{"task_id":"`+task.ID+`"}`); code != 201 {
		t.Fatalf("准备工作区 %d %v", code, out)
	}
	waitFlow := func(id string) {
		deadline := time.Now().Add(5 * time.Second)
		for {
			if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+id, ""); code == 200 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal(id + " 没写进 SOP")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFlow(ReleasePipelineFlowID)
	before := len(e.fake.Sent())
	runID := e.start(t, ReleasePipelineFlowID, `{"input":{"task_id":"`+task.ID+`","message_id":"`+msg+`"}}`)
	e.waitRun(t, runID, "停在上线审批", func(r map[string]any) bool { return sopStep(r, "approve")["status"] == "review" })
	e.stage(t, task.ID, "releasing")
	if e.prodHas("backup") || e.prodHas("deployed") {
		t.Fatal("审批前动了生产")
	}
	e.act(t, runID, `{"kind":"route","step":"approve","route":"approve"}`)
	run := e.waitRun(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	e.stage(t, task.ID, "need_human")
	rel := sopStep(run, "deploy")["output"].(map[string]any)["release"].(map[string]any)
	if rel["ok"] != false || rel["status"] != "rolled_back" || rel["rolled_back"] != true || !e.prodHas("rolled_back") ||
		sopStep(run, "stage_released")["status"] != "bypassed" {
		t.Fatalf("冒烟没过要自动回滚：%v %v", rel, briefSteps(run))
	}
	ns := e.notes.list()
	if a := ns[len(ns)-1]; a.Level != plugin.NotifyError || !strings.Contains(a.Body, "已自动回滚") || !strings.Contains(a.Body, "负责人丙") {
		t.Fatalf("失败通知：%+v", a)
	}
	if len(e.fake.Sent()) != before {
		t.Fatalf("失败不回复提出人：%+v", e.fake.Sent())
	}

	// 暂缓：不动生产
	for _, f := range []string{"backup", "deployed", "rolled_back"} {
		_ = os.Remove(filepath.Join(e.prod, f))
	}
	run2 := e.start(t, ReleasePipelineFlowID, `{"input":{"task_id":"`+task.ID+`"}}`)
	e.waitRun(t, run2, "停在上线审批", func(r map[string]any) bool { return sopStep(r, "approve")["status"] == "review" })
	e.act(t, run2, `{"kind":"route","step":"approve","route":"hold"}`)
	run = e.waitRun(t, run2, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	e.stage(t, task.ID, "releasing")
	if e.prodHas("backup") || e.prodHas("deployed") || sopStep(run, "deploy")["status"] != "bypassed" || sopStep(run, "hold_notify")["status"] != "done" {
		t.Fatalf("暂缓：%v", briefSteps(run))
	}
}

// TestDevPipelineDeviationAndOver：没有来源消息时只发平台通知；需求偏差退回产品（阶段设计中）；测试修复超限转人工。
func TestDevPipelineDeviationAndOver(t *testing.T) {
	e, _, task := setupPipeline(t, "test -f ok.flag")
	runID := e.start(t, DevPipelineFlowID, `{"input":{"task_id":"`+task.ID+`"}}`)
	for _, req := range e.nextN(t, 3) {
		if req.Workdir != "" && role(req) == "dev" {
			if err := os.WriteFile(filepath.Join(req.Workdir, "ok.flag"), []byte("ok"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		e.done(t, req, "做完了")
	}
	e.waitRun(t, runID, "停在人工验收", func(r map[string]any) bool { return sopStep(r, "accept")["status"] == "review" })
	before := len(e.fake.Sent())
	run := e.waitRun(t, runID, "", func(map[string]any) bool { return true })
	if n := sopStep(run, "notify")["output"].(map[string]any)["notified"].(map[string]any); n["im"] != "skipped" || n["app"] != "sent" {
		t.Fatalf("没有来源消息只发平台通知：%v", n)
	}
	e.act(t, runID, `{"kind":"route","step":"accept","route":"deviation"}`)
	run = e.waitRun(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	e.stage(t, task.ID, "designing")
	if sopStep(run, "tell_pm")["status"] != "done" || sopStep(run, "back_dev")["status"] != "bypassed" || len(e.fake.Sent()) != before {
		t.Fatalf("需求偏差：%v", briefSteps(run))
	}
	ns := e.notes.list()
	if !strings.Contains(ns[len(ns)-1].Title, "需求偏差") {
		t.Fatalf("通知产品：%+v", ns[len(ns)-1])
	}

	// 测试一直不过：退回 3 轮后转人工
	if err := os.Remove(filepath.Join(sopStep(run, "worktree")["output"].(map[string]any)["worktree"].(map[string]any)["path"].(string), "ok.flag")); err != nil {
		t.Fatal(err)
	}
	run2 := e.start(t, DevPipelineFlowID, `{"input":{"task_id":"`+task.ID+`"}}`)
	for _, req := range e.nextN(t, 3) {
		e.done(t, req, "做完了")
	}
	for range 3 {
		e.done(t, e.next(t), "又改了")
	}
	run = e.waitRun(t, run2, "转人工", func(r map[string]any) bool { return sopStep(r, "test_human")["status"] == "review" })
	e.stage(t, task.ID, "need_human")
	if sopStep(run, "test_gate")["loops"].(float64) != 3 || sopStep(run, "stage_accept")["status"] != "bypassed" {
		t.Fatalf("超限：%v", briefSteps(run))
	}
	ns = e.notes.list()
	if !strings.Contains(ns[len(ns)-1].Title, "自动测试修复 3 轮仍没通过") || ns[len(ns)-1].Level != plugin.NotifyError {
		t.Fatalf("超限通知：%+v", ns[len(ns)-1])
	}
}

// TestIntakeUpgradeToPipeline：生产上已经写过第 1 版「IM 需求自动受理」（没接研发 pipeline）：还是第 1 版的换成新版；用户改过的不动。
func TestIntakeUpgradeToPipeline(t *testing.T) {
	e := setupIntake(t)
	waitPipelineFlow(t, pipeEnv{intakeEnv: e})
	old := func() {
		t.Helper()
		// 第 1 版：没有 pipeline_in、pipeline_args、pipeline 三步；装过的记录还在，升级标记没有
		f := intakeFlow()
		steps := strings.Replace(string(f.Steps), `,{"key":"pipeline_in"`, `]`+"\x00", 1)
		steps = steps[:strings.Index(steps, "\x00")]
		if code, out := call(t, e.h, "DELETE", "/api/sop/flows/"+AutoIntakeFlowID, ""); code != 200 {
			t.Fatalf("删 %d %v", code, out)
		}
		body := `{"id":"` + f.ID + `","name":"` + f.Name + `","trigger":"manual","fields":` + string(f.Fields) + `,"steps":` + steps + `}`
		if code, out := call(t, e.h, "POST", "/api/sop/flows", body); code != 201 {
			t.Fatalf("建旧版 %d %v", code, out)
		}
		exec(t, e.st.DB(), `DELETE FROM im_sop_templates WHERE flow_id = '`+intakeUpgradeMark+`'`)
	}
	hasPipeline := func() bool {
		_, out := call(t, e.h, "GET", "/api/sop/flows/"+AutoIntakeFlowID, "")
		return strings.Contains(fmt.Sprint(data(out)["steps"]), DevPipelineFlowID)
	}
	marked := func() bool {
		var n int
		_ = e.st.DB().R.QueryRow(`SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, intakeUpgradeMark).Scan(&n)
		return n == 1
	}
	wait := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatal("等了 5 秒还没有：" + what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	old()
	if hasPipeline() {
		t.Fatal("准备的旧版不该有 pipeline")
	}
	wait("换成新版", func() bool { return hasPipeline() && marked() })

	// 用户改过（第 2 版）：不动，记标记不再试
	old()
	if code, out := call(t, e.h, "PATCH", "/api/sop/flows/"+AutoIntakeFlowID, `{"trigger":"im"}`); code != 200 {
		t.Fatalf("改 %d %v", code, out)
	}
	wait("记标记", marked)
	if hasPipeline() {
		t.Fatal("改过的不该换")
	}
}
