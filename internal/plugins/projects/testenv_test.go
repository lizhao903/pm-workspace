// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 测试环境与测试报告（AUTO-08）。代码库是 t.TempDir() 里 git init 的临时仓库，命令都是 sh -c 的小脚本，测试环境用 python3 -m http.server。

// artRecorder 记下插件登记的产物（接在注册表的建对象 store 上）。
type artRecorder struct {
	mu  sync.Mutex
	got []domain.ArtifactInput
}

func (a *artRecorder) CreateObject(context.Context, *domain.Object, store.Actor) (*domain.Object, error) {
	return nil, errors.New("不建对象")
}

func (a *artRecorder) RecordArtifact(_ context.Context, in domain.ArtifactInput) (*domain.Artifact, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.got = append(a.got, in)
	return &domain.Artifact{ID: "art_" + strconv.Itoa(len(a.got))}, nil
}

func (a *artRecorder) list() []domain.ArtifactInput {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]domain.ArtifactInput(nil), a.got...)
}

// setupTest 建好项目代码库、任务 TSK-T1 和它的工作区，端口段挑一段随机的高位端口，档案命令用 cmds（JSON）。
func setupTest(t *testing.T, cmds string) (*wtEnv, *artRecorder, map[string]any) {
	t.Helper()
	e := setupWT(t)
	arts := &artRecorder{}
	e.r.SetObjectCreator(arts)
	repo := newRepo(t)
	lo := 20000 + rand.IntN(400)*100
	if code, out := call(t, e.h, "PATCH", "/api/projects/worktree-settings", fmt.Sprintf(`{"port_min":%d,"port_max":%d,"port_block":10}`, lo, lo+999)); code != 200 {
		t.Fatalf("端口范围：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+repo+`","commands":`+cmds+`}`); code != 200 {
		t.Fatalf("档案：%d %v", code, out)
	}
	e.task(t, "obj_t1", "TSK-T1", "obj_p1")
	code, out := call(t, e.h, "POST", "/api/projects/worktrees", `{"task_id":"obj_t1"}`)
	if code != 201 {
		t.Fatalf("准备工作区：%d %v", code, out)
	}
	return e, arts, data(out)
}

func needPython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("本机没装 python3")
	}
}

// waitTest 等测试结束（不是 running），回最后的记录。
func waitTest(t *testing.T, e *wtEnv, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		code, out := call(t, e.h, "GET", "/api/projects/tests/runs/"+id, "")
		if code != 200 {
			t.Fatalf("读测试：%d %v", code, out)
		}
		if d := data(out); d["status"] != trRunning {
			return d
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("测试 30 秒没跑完")
	return nil
}

func steps(r map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, x := range r["steps"].([]any) {
		m := x.(map[string]any)
		out[m["key"].(string)] = m
	}
	return out
}

func cmdJSON(c string) string {
	return strconv.Quote(c)
}

// 全流程：构建 → 起测试环境（等 HTTP 就绪）→ 测试 → 冒烟；报告、截图、junit 收齐，登记为任务产出；环境跑完回收；子进程不带工作台的环境变量
func TestRunTestPassesAndReports(t *testing.T) {
	needPython(t)
	t.Setenv("PMW_SECRET_TOKEN", "do-not-leak")
	testCmd := `python3 -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/').read()" && ` +
		`echo "secret=[$PMW_SECRET_TOKEN] port={{PORT}} range=$PORT_START-$PORT_END ref=$TASK_REF ci=$CI" && ` +
		`mkdir -p "$TEST_REPORT_DIR/shots" && printf 'png' > "$TEST_REPORT_DIR/shots/home.png" && ` +
		`printf '<testsuites><testsuite name="s"><testcase classname="a" name="ok"/><testcase name="skip"><skipped/></testcase></testsuite></testsuites>' > "$TEST_REPORT_DIR/junit.xml"`
	cmds := `{"build":{"command":` + cmdJSON(`echo building in "$(pwd)"; test "$WORKTREE" = "$(pwd)"`) + `},` +
		`"test_env":{"command":"exec python3 -m http.server $PORT --bind 127.0.0.1","timeout_sec":20,"ready":"/"},` +
		`"test":{"command":` + cmdJSON(testCmd) + `},` +
		`"smoke":{"command":"echo smoke ok"}}`
	e, arts, wt := setupTest(t, cmds)
	port := int(wt["port_start"].(float64))

	code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"TSK-T1"}`)
	if code != 202 || data(out)["status"] != trRunning || data(out)["url"] != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("起测试：%d %v", code, out)
	}
	id := data(out)["id"].(string)
	if !strings.HasPrefix(id, "tr_") {
		t.Fatalf("id 前缀：%s", id)
	}
	r := waitTest(t, e, id)
	if r["status"] != trPassed || r["failed_step"] != "" {
		t.Fatalf("应该通过：%v", r)
	}
	st := steps(r)
	for _, k := range []string{"build", "test_env", "test", "smoke"} {
		if st[k]["status"] != stPassed {
			t.Fatalf("%s 应该通过：%v", k, st[k])
		}
	}
	if st["build"]["exit_code"] != float64(0) || st["test_env"]["exit_code"] != nil {
		t.Fatalf("退出码：build %v test_env %v", st["build"]["exit_code"], st["test_env"]["exit_code"])
	}
	testOut := st["test"]["output"].(string)
	want := fmt.Sprintf("secret=[] port=%d range=%d-%d ref=TSK-T1 ci=1", port, port, port+9)
	if !strings.Contains(testOut, want) {
		t.Fatalf("测试输出要有注入的变量、不带工作台的环境变量：%q", testOut)
	}
	if !strings.Contains(st["test_env"]["ready"].(string), "/") {
		t.Fatalf("就绪检查说明：%v", st["test_env"]["ready"])
	}
	// 测试环境已回收
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("测试环境跑完要回收")
	}
	// 报告和收进来的东西
	runDir := filepath.Join(e.data, ReportsSubdir, "obj_p1", "TSK-T1", id)
	if r["run_dir"] != runDir || r["report_path"] != filepath.Join(runDir, "report.md") {
		t.Fatalf("报告位置：%v %v", r["run_dir"], r["report_path"])
	}
	if shots := r["shots"].([]any); len(shots) != 1 || shots[0] != "shots/home.png" {
		t.Fatalf("截图：%v", r["shots"])
	}
	j := r["junit"].(map[string]any)
	if j["tests"] != float64(2) || j["skipped"] != float64(1) || j["failures"] != float64(0) || j["files"] != float64(1) {
		t.Fatalf("junit 汇总：%v", j)
	}
	b, err := os.ReadFile(filepath.Join(runDir, "report.md"))
	if err != nil {
		t.Fatal(err)
	}
	rep := string(b)
	for _, s := range []string{"# 测试报告：TSK-T1", "**通过**", "| 构建 |", "| 起测试环境 |", "2 个用例", "![shots/home.png](out/shots/home.png)", "smoke ok"} {
		if !strings.Contains(rep, s) {
			t.Fatalf("报告里要有 %q：\n%s", s, rep)
		}
	}
	if strings.Contains(rep, "do-not-leak") {
		t.Fatal("报告里不能有工作台的环境变量")
	}
	// 产出：报告（doc）和截图（other），挂到任务上，来源 run
	got := arts.list()
	if len(got) != 2 || got[0].Kind != "doc" || got[0].Path != filepath.Join(runDir, "report.md") || *got[0].ObjectID != "obj_t1" ||
		got[0].Source != domain.ArtifactSourceRun || got[0].ActorID != "projects" || got[1].Kind != "other" {
		t.Fatalf("登记的产出：%+v", got)
	}
	if ids := r["artifact_ids"].([]any); len(ids) != 2 {
		t.Fatalf("artifact_ids：%v", ids)
	}
	// 报告原文、截图接口；不在列表里的路径不给
	req := httptest.NewRequest("GET", "/api/projects/tests/runs/"+id+"/report", nil)
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") || !strings.Contains(w.Body.String(), "测试报告") {
		t.Fatalf("报告接口：%d %s", w.Code, w.Header().Get("Content-Type"))
	}
	w = httptest.NewRecorder()
	e.h.ServeHTTP(w, httptest.NewRequest("GET", "/api/projects/tests/runs/"+id+"/shots/shots/home.png", nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Body.String() != "png" {
		t.Fatalf("截图接口：%d %s", w.Code, w.Header().Get("Content-Type"))
	}
	if code, _ := call(t, e.h, "GET", "/api/projects/tests/runs/"+id+"/shots/junit.xml", ""); code != 404 {
		t.Fatalf("不是收进来的截图要 404：%d", code)
	}
	// 列表
	code, out = call(t, e.h, "GET", "/api/projects/tests?task_id=obj_t1", "")
	if code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("列表：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "GET", "/api/projects/tests?status=bad", ""); code != 400 {
		t.Fatalf("status 不认 400：%d", code)
	}
}

// 某步没过后面的跳过；超时杀掉；就绪前退出；junit 里有失败以 junit 为准；起不了的情况说清楚
func TestRunTestFailures(t *testing.T) {
	e, _, _ := setupTest(t, `{"build":{"command":"echo boom >&2; exit 3"},"test":{"command":"echo never"}}`)
	run := func() map[string]any {
		t.Helper()
		code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`)
		if code != 202 {
			t.Fatalf("起测试：%d %v", code, out)
		}
		return waitTest(t, e, data(out)["id"].(string))
	}
	profile := func(cmds string) {
		t.Helper()
		if code, out := call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"commands":`+cmds+`}`); code != 200 {
			t.Fatalf("档案：%d %v", code, out)
		}
	}

	r := run()
	st := steps(r)
	if r["status"] != trFailed || r["failed_step"] != "build" || st["build"]["exit_code"] != float64(3) || st["test"]["status"] != stSkipped ||
		!strings.Contains(st["build"]["output"].(string), "boom") || !strings.Contains(r["error"].(string), "退出码 3") {
		t.Fatalf("构建失败：%v", r)
	}

	profile(`{"test":{"command":"sleep 30","timeout_sec":1}}`)
	r = run()
	st = steps(r)
	if r["status"] != trFailed || st["test"]["timed_out"] != true || st["test"]["status"] != stFailed || !strings.Contains(st["test"]["error"].(string), "超过 1 秒") {
		t.Fatalf("超时：%v", r)
	}

	profile(`{"test_env":{"command":"echo bye; exit 7","timeout_sec":5},"test":{"command":"echo never"}}`)
	r = run()
	st = steps(r)
	if r["failed_step"] != "test_env" || st["test_env"]["exit_code"] != float64(7) || !strings.Contains(st["test_env"]["error"].(string), "就绪前退出") ||
		st["test"]["status"] != stSkipped {
		t.Fatalf("就绪前退出：%v", r)
	}

	profile(`{"test":{"command":"printf '<testsuite><testcase name=\"x\"><failure/></testcase></testsuite>' > $TEST_REPORT_DIR/r.xml"}}`)
	r = run()
	if r["status"] != trFailed || r["failed_step"] != "test" || r["junit"].(map[string]any)["failures"] != float64(1) {
		t.Fatalf("junit 有失败：%v", r)
	}

	// 目录跑出工作区、档案没有测试命令、任务没有工作区
	profile(`{"test":{"command":"true","dir":"nope"}}`)
	if code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`); code != 400 || !strings.Contains(errMsg(out), "不存在") {
		t.Fatalf("目录不存在：%d %v", code, out)
	}
	profile(`{"release":{"command":"make release"}}`)
	if code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`); code != 400 || !strings.Contains(errMsg(out), "没有构建、测试") {
		t.Fatalf("没有命令：%d %v", code, out)
	}
	e.task(t, "obj_t2", "TSK-T2", "obj_p1")
	if code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t2"}`); code != 409 || !strings.Contains(errMsg(out), "还没有在用的工作区") {
		t.Fatalf("没有工作区：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "GET", "/api/projects/tests/runs/tr_none", ""); code != 404 {
		t.Fatalf("不存在 404：%d", code)
	}
	// 就绪检查只许本机地址；只有 test_env 能配
	if code, _ := call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"commands":{"test":{"command":"x","ready":"/h"}}}`); code != 400 {
		t.Fatalf("test 不能配就绪检查：%d", code)
	}
	if code, _ := call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"commands":{"test_env":{"command":"x","ready":"health"}}}`); code != 400 {
		t.Fatalf("就绪检查要 / 或 http 开头：%d", code)
	}
}

// 手动停止：杀掉当前步骤和测试环境的进程组；跑着时再起 409
func TestRunTestStop(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, `{"test_env":{"command":"exec python3 -m http.server $PORT --bind 127.0.0.1","timeout_sec":20},"test":{"command":"sleep 30"}}`)
	port := int(wt["port_start"].(float64))
	code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`)
	if code != 202 {
		t.Fatalf("起测试：%d %v", code, out)
	}
	id := data(out)["id"].(string)
	var pgid int
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var envPgid int
		if err := e.d.R.QueryRow(`SELECT pgid, env_pgid FROM projects_test_runs WHERE id = ?`, id).Scan(&pgid, &envPgid); err != nil {
			t.Fatal(err)
		}
		if pgid > 0 && envPgid > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if pgid == 0 {
		t.Fatal("测试那一步没起来")
	}
	if code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`); code != 409 || !strings.Contains(errMsg(out), "正在跑") {
		t.Fatalf("跑着时再起要 409：%d %v", code, out)
	}
	code, out = call(t, e.h, "POST", "/api/projects/tests/runs/"+id+"/stop", "")
	r := data(out)
	if code != 200 || r["status"] != trStopped || steps(r)["test"]["status"] != stStopped || r["error"] != "手动停止" {
		t.Fatalf("停止：%d %v", code, out)
	}
	if err := syscall.Kill(-pgid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("测试那一步的进程组要杀掉：%v", err)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("测试环境要回收")
	}
	// 已经结束的再停原样回
	if code, out := call(t, e.h, "POST", "/api/projects/tests/runs/"+id+"/stop", ""); code != 200 || data(out)["status"] != trStopped {
		t.Fatalf("再停：%d %v", code, out)
	}
}

// 端口已经被别的程序占着：测试环境这一步失败，不连到别的程序上
func TestRunTestPortBusy(t *testing.T) {
	e, _, wt := setupTest(t, `{"test_env":{"command":"sleep 30","timeout_sec":5},"test":{"command":"true"}}`)
	port := int(wt["port_start"].(float64))
	l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Skip("端口被占：", err)
	}
	defer func() { _ = l.Close() }()
	_, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1"}`)
	r := waitTest(t, e, data(out)["id"].(string))
	if r["failed_step"] != "test_env" || !strings.Contains(steps(r)["test_env"]["error"].(string), "已经有程序在监听") {
		t.Fatalf("端口被占：%v", r)
	}
}

// SOP 节点：起测试后挂起；同一次执行、步骤、尝试再进来时跑完了直接回结果（test.ok 给下游分支）；没确认 process:spawn 说清楚
func TestRunTestNode(t *testing.T) {
	e, _, _ := setupTest(t, `{"test":{"command":"echo node-ok"}}`)
	ctx := context.Background()
	sop := e.probe.c.SOP()
	in := plugin.SOPNodeInput{RunID: "spr_1", Step: "test", Attempt: 1, Input: map[string]any{"worktree": map[string]any{"task_id": "obj_t1"}, "keep": "x"},
		Config: map[string]string{}}
	_, err := sop.RunNode(ctx, NodeRunTest, in)
	if !errors.Is(err, plugin.ErrWaiting) || !strings.Contains(err.Error(), "TSK-T1") {
		t.Fatalf("要挂起：%v", err)
	}
	var id, src string
	if err := e.d.R.QueryRow(`SELECT id, source FROM projects_test_runs WHERE sop_run_id = 'spr_1'`).Scan(&id, &src); err != nil || src != "sop" {
		t.Fatalf("记录：%v %s", err, src)
	}
	waitTest(t, e, id)
	out, err := sop.RunNode(ctx, NodeRunTest, in)
	if err != nil {
		t.Fatal(err)
	}
	tst, _ := out["test"].(map[string]any)
	if out["keep"] != "x" || tst["ok"] != true || tst["status"] != trPassed || tst["report_path"] == "" || tst["port"] == nil || tst["id"] != id {
		t.Fatalf("节点输出：%v", out)
	}
	if _, has := tst["failed_step"]; has {
		t.Fatalf("通过时没有 failed_step：%v", tst)
	}
	if _, has := tst["url"]; has {
		t.Fatalf("没有测试环境时没有 url：%v", tst)
	}
	stps := tst["steps"].([]any)
	if len(stps) != 1 || !strings.Contains(stps[0].(map[string]any)["output"].(string), "node-ok") {
		t.Fatalf("steps：%v", stps)
	}
	var notified int
	_ = e.d.R.QueryRow(`SELECT sop_notified FROM projects_test_runs WHERE id = ?`, id).Scan(&notified)
	if notified != 1 {
		t.Fatal("回过结果要记已唤醒")
	}
	if render("{{test.ok}}", out) != "true" {
		t.Fatalf("下游按 test.ok 分支：%q", render("{{test.ok}}", out))
	}
	// 新的一次尝试重新跑
	in.Attempt = 2
	if _, err := sop.RunNode(ctx, NodeRunTest, in); !errors.Is(err, plugin.ErrWaiting) {
		t.Fatalf("第二次尝试要重新跑：%v", err)
	}
	if _, err := sop.RunNode(ctx, NodeRunTest, plugin.SOPNodeInput{RunID: "spr_2", Step: "t", Attempt: 1, Input: map[string]any{}, Config: map[string]string{}}); err == nil ||
		!strings.Contains(err.Error(), "没有指定任务") {
		t.Fatalf("没指定任务：%v", err)
	}
	s := newTestService(denyCore{}, newWorktreeService(denyCore{}), "")
	if _, err := s.Start(ctx, "obj_t1", nil, 0); err == nil || !strings.Contains(err.Error(), "process:spawn") {
		t.Fatalf("没确认权限：%v", err)
	}
}

// 工作台重启（这里用停用再启用插件代替）：表里 running、不在本进程里的记成 interrupted，杀掉记下的进程组
func TestRunTestReconcile(t *testing.T) {
	e, _, _ := setupTest(t, `{"test":{"command":"true"}}`)
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.d.W.Exec(`INSERT INTO projects_test_runs (id, task_id, task_ref, project_id, worktree_id, workdir, port, port_start, port_end,
		status, steps, pgid, started_at, updated_at) VALUES ('tr_old', 'obj_t1', 'TSK-T1', 'obj_p1', 'wt_x', '/tmp', 1, 1, 10, 'running',
		'[{"key":"test","label":"测试","status":"running"},{"key":"smoke","label":"冒烟","status":"pending"}]', ?, ?, ?)`, cmd.Process.Pid, now, now); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := e.r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	code, out := call(t, e.h, "GET", "/api/projects/tests?task_id=obj_t1", "")
	if code != 200 {
		t.Fatalf("列表：%d %v", code, out)
	}
	r := out["data"].([]any)[0].(map[string]any)
	st := steps(r)
	if r["status"] != trInterrupted || st["test"]["status"] != stStopped || st["smoke"]["status"] != stSkipped || r["finished_at"] == nil {
		t.Fatalf("重启后：%v", r)
	}
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("上次留下的进程组要杀掉")
	}
}

func TestTailAndExpand(t *testing.T) {
	long := strings.Repeat("一", 3000) // 9000 字节
	if got := tailOf(long); len(got) > tailBytes || !strings.HasPrefix(got, "一") {
		t.Fatalf("按字节截尾要切在完整字符上：%d %q", len(got), got[:6])
	}
	var lines []string
	for i := range 100 {
		lines = append(lines, strconv.Itoa(i))
	}
	if got := tailOf(strings.Join(lines, "\n")); !strings.HasPrefix(got, "40\n") || !strings.HasSuffix(got, "99") {
		t.Fatalf("最多 %d 行：%q", tailLines, got)
	}
	vars := map[string]string{"PORT": "8000", "WORKTREE": "/w"}
	if got := expand("serve --port {{PORT}} --dir {{ WORKTREE }} {{OTHER}}", vars); got != "serve --port 8000 --dir /w {{OTHER}}" {
		t.Fatalf("占位：%q", got)
	}
	if codeFence("a ```` b") != "`````" || codeFence("x") != "```" {
		t.Fatal("代码块围栏要比输出里的反引号长")
	}
	env := strings.Join(childEnv(vars), "\n")
	if !strings.Contains(env, "PORT=8000") || !strings.Contains(env, "CI=1") || strings.Contains(env, "PMW_") {
		t.Fatalf("子进程环境：%s", env)
	}
}
