package projects

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 测试环境保留给人工验收（AUTO-09）。测试环境用 python3 -m http.server，跑在临时仓库的工作区上。

const keepCmds = `{"test_env":{"command":"exec python3 -m http.server $PORT --bind 127.0.0.1","timeout_sec":20,"ready":"/"},"test":{"command":"true"}}`

// 通过且要求保留：环境接着跑，记保留到什么时候；报告写明；手动回收后端口放开、记原因；再回收原样回
func TestKeepEnvManualRelease(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, keepCmds)
	port := int(wt["port_start"].(float64))
	code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true,"keep_hours":2}`)
	if code != 202 {
		t.Fatalf("起测试：%d %v", code, out)
	}
	id := data(out)["id"].(string)
	r := waitTest(t, e, id)
	if r["status"] != trPassed || r["env_state"] != envKept || r["env_keep_until"] == nil || r["env_release_reason"] != "" {
		t.Fatalf("要保留：%v", r)
	}
	until, _ := time.Parse(time.RFC3339, r["env_keep_until"].(string))
	if d := time.Until(until); d < 110*time.Minute || d > 2*time.Hour+time.Minute {
		t.Fatalf("保留 2 小时：%v", until)
	}
	if !listeningWithin(port, time.Second) {
		t.Fatal("保留期间测试环境要能访问")
	}
	var envPgid int
	_ = e.d.R.QueryRow(`SELECT env_pgid FROM projects_test_runs WHERE id = ?`, id).Scan(&envPgid)
	if envPgid == 0 {
		t.Fatal("保留期间进程组号要留着")
	}
	b, _ := readReport(r)
	if !strings.Contains(b, "保留给人工验收") {
		t.Fatalf("报告要写明保留：\n%s", b)
	}
	code, out = call(t, e.h, "POST", "/api/projects/tests/runs/"+id+"/release", "")
	r = data(out)
	if code != 200 || r["env_state"] != envReleased || r["env_release_reason"] != EnvManual || r["env_released_at"] == nil {
		t.Fatalf("手动回收：%d %v", code, out)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("回收后端口要放开")
	}
	if code, out := call(t, e.h, "POST", "/api/projects/tests/runs/"+id+"/release", ""); code != 200 || data(out)["env_release_reason"] != EnvManual {
		t.Fatalf("再回收原样回：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/projects/tests/runs/tr_none/release", ""); code != 404 {
		t.Fatalf("不存在 404：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true,"keep_hours":200}`); code != 400 {
		t.Fatalf("保留时长超出 400：%d", code)
	}
}

func readReport(r map[string]any) (string, error) {
	return readFile(r["report_path"].(string))
}

// 没通过不保留；没要求保留照常回收
func TestKeepEnvOnlyWhenPassed(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, `{"test_env":{"command":"exec python3 -m http.server $PORT --bind 127.0.0.1","timeout_sec":20,"ready":"/"},"test":{"command":"exit 1"}}`)
	port := int(wt["port_start"].(float64))
	_, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true}`)
	r := waitTest(t, e, data(out)["id"].(string))
	if r["status"] != trFailed || r["env_state"] != "" || r["env_keep_until"] != nil {
		t.Fatalf("没通过不保留：%v", r)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("没保留要回收")
	}
}

// 回收时机：再跑一次测试先回收上次的（端口让出来）；阶段离开待验收；任务完成；工作区清理；到点
func TestKeepEnvReleaseTriggers(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, keepCmds)
	port := int(wt["port_start"].(float64))
	keep := func() string {
		t.Helper()
		code, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true}`)
		if code != 202 {
			t.Fatalf("起测试：%d %v", code, out)
		}
		id := data(out)["id"].(string)
		if r := waitTest(t, e, id); r["env_state"] != envKept {
			t.Fatalf("要保留：%v", r)
		}
		return id
	}
	reason := func(id string) string {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			_, out := call(t, e.h, "GET", "/api/projects/tests/runs/"+id, "")
			if r := data(out); r["env_state"] == envReleased {
				return r["env_release_reason"].(string)
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("%s 没回收", id)
		return ""
	}

	first := keep()
	second := keep() // 同一端口段：要先回收上一次的，否则测试环境起不来
	if got := reason(first); got != EnvRerun {
		t.Fatalf("再跑一次：%s", got)
	}
	if !listeningWithin(port, time.Second) {
		t.Fatal("第二次的环境要在")
	}
	// 进待验收不回收，离开待验收（验收通过进待发布）回收
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t1", "type_id": "task", "from": "testing", "to": "accepting"})
	_, out := call(t, e.h, "GET", "/api/projects/tests/runs/"+second, "")
	if data(out)["env_state"] != envKept {
		t.Fatal("进待验收不回收")
	}
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t1", "type_id": "task", "from": "accepting", "to": "releasing"})
	if got := reason(second); got != EnvAccepted {
		t.Fatalf("验收通过：%s", got)
	}
	third := keep()
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t1", "type_id": "task", "from": "accepting", "to": "developing"})
	if got := reason(third); got != EnvStageChanged {
		t.Fatalf("验收退回：%s", got)
	}
	fourth := keep()
	e.fire(t, "object.status_changed", map[string]any{"id": "obj_t1", "type_id": "task", "from": "doing", "to": "cancelled"})
	if got := reason(fourth); got != EnvTaskDone {
		t.Fatalf("任务取消：%s", got)
	}
	// 取消时工作区也清理了；重新准备一个
	if code, out := call(t, e.h, "POST", "/api/projects/worktrees", `{"task_id":"obj_t1"}`); code != 201 && code != 200 {
		t.Fatalf("重新准备：%d %v", code, out)
	}
	fifth := keep()
	_, out = call(t, e.h, "GET", "/api/projects/worktrees?task_id=obj_t1&status=active", "")
	wid := out["data"].([]any)[0].(map[string]any)["id"].(string)
	if code, out := call(t, e.h, "POST", "/api/projects/worktrees/"+wid+"/cleanup", `{"force":true}`); code != 200 {
		t.Fatalf("清理：%d %v", code, out)
	}
	if got := reason(fifth); got != EnvWorktreeGone {
		t.Fatalf("工作区清理：%s", got)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("回收后端口要放开")
	}
}

// 到点回收；环境自己退出记 exited
func TestKeepEnvExpiryAndExit(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, keepCmds)
	port := int(wt["port_start"].(float64))
	_, out := call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true}`)
	id := data(out)["id"].(string)
	waitTest(t, e, id)
	// 把到点时间改到过去，手动跑一次到点回收
	if _, err := e.d.W.Exec(`UPDATE projects_test_runs SET env_keep_until = ? WHERE id = ?`, time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), id); err != nil {
		t.Fatal(err)
	}
	svc := e.tests(t)
	if err := svc.releaseExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, out = call(t, e.h, "GET", "/api/projects/tests/runs/"+id, "")
	if r := data(out); r["env_state"] != envReleased || r["env_release_reason"] != EnvExpired {
		t.Fatalf("到点回收：%v", r)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("到点要杀掉")
	}

	// 环境自己退出
	_, out = call(t, e.h, "POST", "/api/projects/tests", `{"task_id":"obj_t1","keep_env":true}`)
	id = data(out)["id"].(string)
	waitTest(t, e, id)
	var pgid int
	_ = e.d.R.QueryRow(`SELECT env_pgid FROM projects_test_runs WHERE id = ?`, id).Scan(&pgid)
	killGroupAsync(pgid)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		_, out = call(t, e.h, "GET", "/api/projects/tests/runs/"+id, "")
		if r := data(out); r["env_state"] == envReleased {
			if r["env_release_reason"] != EnvExited {
				t.Fatalf("自己退出：%v", r)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("环境退出了要记回收")
}

// SOP 节点 config.keep_env：「是」用设置里的默认时长；输出带 env_kept、env_keep_until、env_text、report_url（拼 --public-url）
func TestKeepEnvNode(t *testing.T) {
	needPython(t)
	e, _, wt := setupTest(t, keepCmds)
	port := int(wt["port_start"].(float64))
	if code, out := call(t, e.h, "PATCH", "/api/projects/worktree-settings", `{"env_keep_hours":3}`); code != 200 || data(out)["env_keep_hours"] != float64(3) {
		t.Fatalf("保留时长设置：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "PATCH", "/api/projects/worktree-settings", `{"env_keep_hours":0}`); code != 400 {
		t.Fatalf("保留时长 0 要 400：%d", code)
	}
	svc := e.tests(t)
	svc.publicURL = "http://pm.local"
	ctx := context.Background()
	sop := e.probe.c.SOP()
	in := plugin.SOPNodeInput{RunID: "spr_k", Step: "test", Attempt: 1, Input: map[string]any{"task_id": "obj_t1"}, Config: map[string]string{"keep_env": "是"}}
	if _, err := sop.RunNode(ctx, NodeRunTest, in); !errors.Is(err, plugin.ErrWaiting) {
		t.Fatalf("要挂起：%v", err)
	}
	var id string
	_ = e.d.R.QueryRow(`SELECT id FROM projects_test_runs WHERE sop_run_id = 'spr_k'`).Scan(&id)
	waitTest(t, e, id)
	out, err := sop.RunNode(ctx, NodeRunTest, in)
	if err != nil {
		t.Fatal(err)
	}
	tst := out["test"].(map[string]any)
	until, _ := time.Parse(time.RFC3339, tst["env_keep_until"].(string))
	if tst["env_kept"] != true || time.Until(until) < 170*time.Minute ||
		tst["report_url"] != "http://pm.local/api/projects/tests/runs/"+id+"/report" ||
		!strings.Contains(tst["env_text"].(string), "http://127.0.0.1:"+strconv.Itoa(port)+"（保留到 ") {
		t.Fatalf("节点输出：%v", tst)
	}
	// 写法不对、超出范围
	for _, v := range []string{"一会儿", "200 小时", "10s"} {
		in := plugin.SOPNodeInput{RunID: "spr_x", Step: "t", Attempt: 1, Input: map[string]any{"task_id": "obj_t1"}, Config: map[string]string{"keep_env": v}}
		if _, err := sop.RunNode(ctx, NodeRunTest, in); err == nil || !strings.Contains(err.Error(), "保留测试环境") {
			t.Fatalf("%s：%v", v, err)
		}
	}
	for v, want := range map[string]time.Duration{"": 0, "否": 0, "2 天": 48 * time.Hour, "30 分钟": 30 * time.Minute, "1.5小时": 90 * time.Minute, "36h": 36 * time.Hour, "yes": 3 * time.Hour} {
		if got, err := svc.keepOf(ctx, v); err != nil || got != want {
			t.Fatalf("keepOf(%q) = %v %v，要 %v", v, got, err, want)
		}
	}
	// 插件停用：保留的一起回收
	if err := e.r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if listeningWithin(port, 300*time.Millisecond) {
		t.Fatal("插件停用要回收保留的环境")
	}
	var state, reason string
	_ = e.d.R.QueryRow(`SELECT env_state, env_release_reason FROM projects_test_runs WHERE id = ?`, id).Scan(&state, &reason)
	if state != envReleased || reason != EnvPluginStopped {
		t.Fatalf("停用后：%s %s", state, reason)
	}
}

// 工作台异常退出后重启：上次保留着的（不在本进程里）按记下的进程组杀掉，记 restart
func TestKeepEnvReconcile(t *testing.T) {
	e, _, _ := setupTest(t, `{"test":{"command":"true"}}`)
	cmd := startGroup(t)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.d.W.Exec(`INSERT INTO projects_test_runs (id, task_id, task_ref, project_id, worktree_id, workdir, port, port_start, port_end,
		status, steps, env_pgid, env_state, env_keep_until, started_at, finished_at, updated_at) VALUES ('tr_kept', 'obj_t1', 'TSK-T1', 'obj_p1', 'wt_x', '/tmp', 1, 1, 10,
		'passed', '[]', ?, 'kept', ?, ?, ?, ?)`, cmd.pid, time.Now().Add(time.Hour).UTC().Format(time.RFC3339), now, now, now); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := e.r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "GET", "/api/projects/tests/runs/tr_kept", ""); code != 200 || data(out)["status"] != trPassed {
		t.Fatalf("读：%d %v", code, out)
	}
	code, out := call(t, e.h, "GET", "/api/projects/tests?task_id=obj_t1", "")
	if code != 200 {
		t.Fatalf("列表：%d %v", code, out)
	}
	r := out["data"].([]any)[0].(map[string]any)
	if r["env_state"] != envReleased || r["env_release_reason"] != EnvRestart {
		t.Fatalf("重启后：%v", r)
	}
	select {
	case <-cmd.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("上次保留的进程组要杀掉")
	}
}

func readFile(p string) (string, error) {
	b, err := os.ReadFile(p)
	return string(b), err
}

type groupProc struct {
	pid    int
	exited chan struct{}
}

// startGroup 起一个自成进程组的 sleep，测试结束时杀掉。
func startGroup(t *testing.T) groupProc {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	g := groupProc{pid: cmd.Process.Pid, exited: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(g.exited) }()
	t.Cleanup(func() { _ = syscall.Kill(-g.pid, syscall.SIGKILL) })
	return g
}
