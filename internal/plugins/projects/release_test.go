// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 发布（AUTO-10）。代码库是临时 git 仓库，「生产」是 t.TempDir() 里的一个目录：发布前检查、发布、回滚各在里面留一个标记文件，
// 线上冒烟看里面有没有 smoke_ok。审批前（准备段）不许出现任何标记。

type relEnv struct {
	*wtEnv
	arts *artRecorder
	prod string
}

func setupRelease(t *testing.T, extra map[string]string) relEnv {
	t.Helper()
	prod := t.TempDir()
	cmds := map[string]string{
		"version":    `echo "v1.2.$TASK_REF" > "$RELEASE_DIR/version.txt"; printf -- '- 导出加 CSV\n- 修了编码' > "$RELEASE_DIR/changelog.md"; echo ver-done`,
		"package":    `echo "packing {{RELEASE_VERSION}} in $(pwd)"; test "$WORKTREE" = "$(pwd)"`,
		"preflight":  `echo "$RELEASE_VERSION" > ` + prod + `/backup`,
		"release":    `echo "$RELEASE_VERSION" > ` + prod + `/deployed; echo "secret=[$PMW_SECRET_TOKEN]"`,
		"prod_smoke": `test -f ` + prod + `/smoke_ok`,
		"rollback":   `touch ` + prod + `/rolled_back`,
		"test":       "true",
	}
	for k, v := range extra {
		if v == "" {
			delete(cmds, k)
		} else {
			cmds[k] = v
		}
	}
	var parts []string
	for k, v := range cmds {
		parts = append(parts, `"`+k+`":{"command":`+cmdJSON(v)+`}`)
	}
	e, arts, _ := setupTest(t, "{"+strings.Join(parts, ",")+"}")
	return relEnv{wtEnv: e, arts: arts, prod: prod}
}

func (e relEnv) has(name string) bool {
	_, err := os.Stat(filepath.Join(e.prod, name))
	return err == nil
}

// waitRelease 等发布不在跑，回最后的记录。
func waitRelease(t *testing.T, e *wtEnv, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		code, out := call(t, e.h, "GET", "/api/projects/releases/runs/"+id, "")
		if code != 200 {
			t.Fatalf("读发布：%d %v", code, out)
		}
		if d := data(out); d["status"] != rlRunning {
			return d
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("发布 30 秒没跑完")
	return nil
}

func (e relEnv) prepare(t *testing.T) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/projects/releases", `{"task_id":"TSK-T1"}`)
	if code != 202 || data(out)["status"] != rlRunning || data(out)["phase"] != phasePrepare {
		t.Fatalf("准备发布：%d %v", code, out)
	}
	return waitRelease(t, e.wtEnv, data(out)["id"].(string))
}

func (e relEnv) deploy(t *testing.T, id string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/projects/releases/runs/"+id+"/deploy", "")
	if code != 202 || data(out)["phase"] != phaseDeploy || data(out)["approved_by"] != "api" {
		t.Fatalf("上线：%d %v", code, out)
	}
	return waitRelease(t, e.wtEnv, id)
}

// 准备段只跑版本号和打包，不碰生产；审批（deploy）后才跑发布前检查、发布、线上冒烟；成功不回滚，报告登记为产出
func TestReleaseApproveBeforeProduction(t *testing.T) {
	t.Setenv("PMW_SECRET_TOKEN", "do-not-leak")
	e := setupRelease(t, nil)
	write(t, filepath.Join(e.prod, "smoke_ok"), "ok")

	r := e.prepare(t)
	st := steps(r)
	if r["status"] != rlPrepared || r["version"] != "v1.2.TSK-T1" || !strings.Contains(r["changelog"].(string), "修了编码") {
		t.Fatalf("准备好等审批：%v", r)
	}
	if st["version"]["status"] != stPassed || st["package"]["status"] != stPassed || !strings.Contains(st["package"]["output"].(string), "packing v1.2.TSK-T1") {
		t.Fatalf("准备段两步：%v %v", st["version"], st["package"])
	}
	for _, k := range []string{"preflight", "release", "prod_smoke", "rollback"} {
		if st[k]["status"] != stPending || st[k]["phase"] != phaseDeploy || st[k]["started_at"] != nil {
			t.Fatalf("审批前 %s 不该跑：%v", k, st[k])
		}
	}
	if e.has("backup") || e.has("deployed") || e.has("rolled_back") {
		t.Fatal("审批前动了生产")
	}
	if r["approved_at"] != nil || len(e.arts.list()) != 0 {
		t.Fatalf("准备段没有审批、不登记产出：%v %v", r["approved_at"], e.arts.list())
	}
	rep, err := readReport(r)
	if err != nil || !strings.Contains(rep, "等审批") || !strings.Contains(rep, "| 发布 | 审批后 |") {
		t.Fatalf("准备段报告：%v\n%s", err, rep)
	}

	id := r["id"].(string)
	r = e.deploy(t, id)
	st = steps(r)
	if r["status"] != rlReleased || r["rollback_state"] != "" || r["approved_at"] == nil {
		t.Fatalf("应已上线：%v", r)
	}
	if st["rollback"]["status"] != stSkipped || st["prod_smoke"]["status"] != stPassed {
		t.Fatalf("成功不回滚：%v", st["rollback"])
	}
	if b, _ := os.ReadFile(filepath.Join(e.prod, "deployed")); strings.TrimSpace(string(b)) != "v1.2.TSK-T1" || !e.has("backup") || e.has("rolled_back") {
		t.Fatalf("生产：%q", b)
	}
	if strings.Contains(st["release"]["output"].(string), "do-not-leak") {
		t.Fatal("子进程不能带工作台的环境变量")
	}
	arts := e.arts.list()
	if len(arts) != 1 || arts[0].ObjectID == nil || *arts[0].ObjectID != "obj_t1" || !strings.Contains(arts[0].Title, "发布报告 TSK-T1 v1.2.TSK-T1（已上线）") {
		t.Fatalf("产出：%+v", arts)
	}
	// 已上线的不能再上
	if code, out := call(t, e.h, "POST", "/api/projects/releases/runs/"+id+"/deploy", ""); code != 409 || !strings.Contains(errMsg(out), "只有准备好") {
		t.Fatalf("再上线：%d %v", code, out)
	}
	if code, out := call(t, e.h, "GET", "/api/projects/releases/runs/"+id+"/report", ""); code != 200 {
		t.Fatalf("报告：%d %v", code, out)
	}
	code, out := call(t, e.h, "GET", "/api/projects/releases?task_id=obj_t1&status=released", "")
	if code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("列表：%d %v", code, out)
	}
}

// 线上冒烟没过自动回滚；回滚也没过记 rollback_failed；没有回滚命令记 unavailable；发布前检查没过不发布、不回滚
func TestReleaseSmokeFailRollsBack(t *testing.T) {
	e := setupRelease(t, nil)
	r := e.deploy(t, e.prepare(t)["id"].(string))
	st := steps(r)
	if r["status"] != rlRolledBack || r["rollback_state"] != rbDone || r["failed_step"] != "prod_smoke" || !e.has("rolled_back") ||
		st["rollback"]["status"] != stPassed || !strings.HasPrefix(r["error"].(string), "线上冒烟：") {
		t.Fatalf("冒烟没过要自动回滚：%v", r)
	}
	if rep, _ := readReport(r); !strings.Contains(rep, "- 回滚：已回滚") {
		t.Fatalf("报告写明回滚：\n%s", rep)
	}

	e2 := setupRelease(t, map[string]string{"rollback": "exit 4"})
	r = e2.deploy(t, e2.prepare(t)["id"].(string))
	if r["status"] != rlRollbackFailed || r["rollback_state"] != rbFailed || r["failed_step"] != "prod_smoke" {
		t.Fatalf("回滚也没过：%v", r)
	}
	if txt := releaseText(mustRelease(t, e2.wtEnv, r["id"].(string))); !strings.Contains(txt, "自动回滚也没成功（退出码 4）") {
		t.Fatalf("一句话：%s", txt)
	}

	e3 := setupRelease(t, map[string]string{"rollback": "", "release": "exit 2"})
	r = e3.deploy(t, e3.prepare(t)["id"].(string))
	if r["status"] != rlFailed || r["rollback_state"] != rbUnavailable || r["failed_step"] != "release" || steps(r)["prod_smoke"]["status"] != stSkipped {
		t.Fatalf("没有回滚命令：%v", r)
	}

	e4 := setupRelease(t, map[string]string{"preflight": "echo 密钥对不上; exit 1"})
	r = e4.deploy(t, e4.prepare(t)["id"].(string))
	st = steps(r)
	if r["status"] != rlFailed || r["failed_step"] != "preflight" || r["rollback_state"] != "" || e4.has("deployed") || e4.has("rolled_back") ||
		st["release"]["status"] != stSkipped || st["rollback"]["status"] != stSkipped {
		t.Fatalf("发布前检查没过：%v", r)
	}
	if txt := releaseText(mustRelease(t, e4.wtEnv, r["id"].(string))); !strings.Contains(txt, "还没动生产") {
		t.Fatalf("一句话：%s", txt)
	}
}

func mustRelease(t *testing.T, e *wtEnv, id string) Release {
	t.Helper()
	r, err := e.plug.releases.get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// 准备不了：档案没有发布命令 400；准备段没过整段上线不跑；再准备一次，之前等审批的作废；准备好的手动停止是作废
func TestReleasePrepareErrors(t *testing.T) {
	e := setupRelease(t, map[string]string{"release": ""})
	if code, out := call(t, e.h, "POST", "/api/projects/releases", `{"task_id":"TSK-T1"}`); code != 400 || !strings.Contains(errMsg(out), "没有发布命令") {
		t.Fatalf("没有发布命令：%d %v", code, out)
	}

	e = setupRelease(t, map[string]string{"package": "exit 3"})
	r := e.prepare(t)
	if r["status"] != rlFailed || r["failed_step"] != "package" || steps(r)["release"]["status"] != stSkipped || e.has("backup") {
		t.Fatalf("打包没过：%v", r)
	}
	if code, out := call(t, e.h, "POST", "/api/projects/releases/runs/"+r["id"].(string)+"/deploy", ""); code != 409 {
		t.Fatalf("没准备好不能上线：%d %v", code, out)
	}

	e = setupRelease(t, nil)
	first := e.prepare(t)["id"].(string)
	second := e.prepare(t)["id"].(string)
	if code, out := call(t, e.h, "GET", "/api/projects/releases/runs/"+first, ""); code != 200 || data(out)["status"] != rlCancelled {
		t.Fatalf("前一次要作废：%v", out)
	}
	code, out := call(t, e.h, "POST", "/api/projects/releases/runs/"+second+"/stop", "")
	if code != 200 || data(out)["status"] != rlCancelled || steps(data(out))["release"]["status"] != stSkipped {
		t.Fatalf("准备好的停止是作废：%d %v", code, out)
	}
}

// SOP 节点：准备、上线各自挂起等跑完；同一次尝试再进来不重复起；上线只认准备好的
func TestReleaseNodes(t *testing.T) {
	e := setupRelease(t, nil)
	write(t, filepath.Join(e.prod, "smoke_ok"), "ok")
	ctx := context.Background()
	sop := e.probe.c.SOP()
	in := plugin.SOPNodeInput{RunID: "spr_r", Step: "prepare", Attempt: 1, Input: map[string]any{"task": map[string]any{"id": "obj_t1"}, "message_id": "m1"},
		Config: map[string]string{"task": "{{task.id}}"}}
	if _, err := sop.RunNode(ctx, NodePrepareRelease, in); !errors.Is(err, plugin.ErrWaiting) {
		t.Fatalf("准备要挂起：%v", err)
	}
	var id string
	if err := e.d.R.QueryRow(`SELECT id FROM projects_releases WHERE prep_key = 'spr_r/prepare#1'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	waitRelease(t, e.wtEnv, id)
	out, err := sop.RunNode(ctx, NodePrepareRelease, in)
	if err != nil {
		t.Fatal(err)
	}
	rel := out["release"].(map[string]any)
	if out["message_id"] != "m1" || rel["ok"] != true || rel["status"] != rlPrepared || rel["id"] != id || rel["version"] != "v1.2.TSK-T1" ||
		!strings.Contains(rel["text"].(string), "等上线审批") {
		t.Fatalf("准备输出：%v", rel)
	}
	if render("{{release.ok}}", out) != "true" {
		t.Fatal("下游按 release.ok 分支")
	}
	if e.has("backup") || e.has("deployed") {
		t.Fatal("准备节点动了生产")
	}

	din := plugin.SOPNodeInput{RunID: "spr_r", Step: "deploy", Attempt: 1, Input: out, Config: map[string]string{}}
	if _, err := sop.RunNode(ctx, NodeRelease, din); !errors.Is(err, plugin.ErrWaiting) {
		t.Fatalf("上线要挂起：%v", err)
	}
	r := waitRelease(t, e.wtEnv, id)
	if r["approved_by"] != "sop:spr_r" || r["sop_run_id"] != "spr_r" {
		t.Fatalf("审批来源：%v", r)
	}
	out, err = sop.RunNode(ctx, NodeRelease, din)
	if err != nil {
		t.Fatal(err)
	}
	rel = out["release"].(map[string]any)
	if rel["ok"] != true || rel["status"] != rlReleased || rel["rolled_back"] != false || !strings.Contains(rel["text"].(string), "已上线") {
		t.Fatalf("上线输出：%v", rel)
	}
	// 新的一次尝试：已经上线的不能再上
	din.Attempt = 2
	if _, err := sop.RunNode(ctx, NodeRelease, din); err == nil || !strings.Contains(err.Error(), "上线没起来") {
		t.Fatalf("已上线不能再上：%v", err)
	}
	if _, err := sop.RunNode(ctx, NodeRelease, plugin.SOPNodeInput{RunID: "spr_x", Step: "d", Attempt: 1, Input: map[string]any{}, Config: map[string]string{}}); err == nil ||
		!strings.Contains(err.Error(), "没有指定发布") {
		t.Fatalf("没指定发布：%v", err)
	}
	s := newReleaseService(denyCore{}, newWorktreeService(denyCore{}), "")
	if _, err := s.Prepare(ctx, "obj_t1", nil); err == nil || !strings.Contains(err.Error(), "process:spawn") {
		t.Fatalf("没确认权限：%v", err)
	}
}

// 工作台重启：上线段没跑完的记 interrupted，写明生产可能停在半路
func TestReleaseReconcile(t *testing.T) {
	e := setupRelease(t, nil)
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.d.W.Exec(`INSERT INTO projects_releases (id, task_id, task_ref, project_id, worktree_id, workdir, status, phase, steps, started_at, updated_at)
		VALUES ('rel_old', 'obj_t1', 'TSK-T1', 'obj_p1', 'wt_x', '/tmp', 'running', 'deploy',
		'[{"key":"release","label":"发布","phase":"deploy","status":"running"},{"key":"prod_smoke","label":"线上冒烟","phase":"deploy","status":"pending"}]', ?, ?)`, now, now); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := e.r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	code, out := call(t, e.h, "GET", "/api/projects/releases?task_id=obj_t1", "")
	if code != 200 {
		t.Fatalf("列表：%d %v", code, out)
	}
	r := out["data"].([]any)[0].(map[string]any)
	st := steps(r)
	if r["status"] != rlInterrupted || st["release"]["status"] != stStopped || st["prod_smoke"]["status"] != stSkipped || !strings.Contains(r["error"].(string), "半路") {
		t.Fatalf("重启后：%v", r)
	}
}
