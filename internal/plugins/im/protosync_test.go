package im

import (
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// 原型同步（AUTO-11）：真的 SOP、项目插件、git 临时仓库（Octok 的代码库和原型库），Claude Code 用假执行器。
// 由项目插件的接口手动发起（三种自动触发走同一个入口，触发本身在项目插件的单测里）：
// 有界面改动 → 同步分支上对比回写 → 拿不准的交人工裁决（缺陷建修复任务 / 新设计再回写）→ 只提交到同步分支 → 记同步点 → 通知负责人；
// 只有文档改动时不交给 Claude Code，只前移同步点。

func setupProtoSyncFlow(t *testing.T) pipeEnv {
	t.Helper()
	ie := setupIntake(t)
	e := pipeEnv{intakeEnv: ie, pc: newPipeClaude(), notes: &notes{}}
	e.r.SetClaudeRunner(e.pc)
	e.r.SetNotifier(e.notes)
	for _, dir := range []string{e.code, e.proto} {
		git(t, dir, "init", "-q", "-b", "main")
		if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("octok\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		git(t, dir, "add", ".")
		git(t, dir, "commit", "-q", "-m", "init")
	}
	exec(t, e.st.DB(), `INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_own', '负责人丙', 'x', 'x')`)
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_octok/profile", `{"owner_ids":["stk_own"]}`); code != 200 {
		t.Fatalf("档案 %d %v", code, out)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+ProtoSyncFlowID, ""); code == 200 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("原型同步没写进 SOP")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code, out := call(t, e.h, "POST", "/api/projects/obj_octok/proto-syncs", `{"mode":"baseline"}`); code != 201 {
		t.Fatalf("设基线 %d %v", code, out)
	}
	return e
}

func (e pipeEnv) codeCommit(t *testing.T, file string) {
	t.Helper()
	p := filepath.Join(e.code, file)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(file+" "+time.Now().String()+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, e.code, "add", ".")
	git(t, e.code, "commit", "-q", "-m", "change "+file)
}

// startSync 经项目插件发起一次，等到 SOP 执行 id。
func (e pipeEnv) startSync(t *testing.T) (string, string) {
	t.Helper()
	code, out := call(t, e.h, "POST", "/api/projects/obj_octok/proto-syncs", "")
	if code != 202 {
		t.Fatalf("发起原型同步 %d %v", code, out)
	}
	id := data(out)["id"].(string)
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, out := call(t, e.h, "GET", "/api/projects/proto-syncs/runs/"+id, "")
		if r, _ := data(out)["sop_run_id"].(string); r != "" {
			return id, r
		}
		if time.Now().After(deadline) {
			t.Fatalf("等不到 SOP 执行：%v", out)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e pipeEnv) syncRow(t *testing.T, id string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/projects/proto-syncs/runs/"+id, "")
	if code != 200 {
		t.Fatalf("读同步 %d %v", code, out)
	}
	return data(out)
}

func (e pipeEnv) report(t *testing.T, req runner.Request, summary string, result map[string]any) {
	t.Helper()
	if _, err := e.r.ReportRun(req.RunID, "done", summary, result); err != nil {
		t.Fatal(err)
	}
	e.pc.mu.Lock()
	ch := e.pc.waits[req.RunID]
	e.pc.mu.Unlock()
	ch <- &runner.Result{Status: "done", Output: summary}
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestProtoSyncFlowInstalled：内置流程写进 SOP，手动（默认停用）；Claude Code 在同步分支的工作区里可写；裁决是人工判断，三个分支。
func TestProtoSyncFlowInstalled(t *testing.T) {
	e := setupProtoSyncFlow(t)
	code, out := call(t, e.h, "GET", "/api/sop/flows/"+ProtoSyncFlowID, "")
	f := data(out)
	if code != 200 || f["trigger"] != "manual" || f["name"] != "原型同步" {
		t.Fatalf("内置流程：%d %v", code, f)
	}
	steps := map[string]map[string]any{}
	for _, s := range f["steps"].([]any) {
		m := s.(map[string]any)
		steps[m["key"].(string)] = m
	}
	for k, want := range map[string]string{"range": "projects_proto_sync_range", "branch": "projects_proto_sync_branch", "agent": "claude_code",
		"classify": "projects_proto_sync_classify", "verdict": "decide", "commit": "projects_proto_sync_commit", "record": "projects_proto_sync_record", "notify": NodeNotify} {
		if steps[k]["kind"] != want {
			t.Fatalf("步骤 %s 应是 %s：%v", k, want, steps[k])
		}
	}
	cfg := steps["agent"]["config"].(map[string]any)
	if cfg["preset"] != "rp_protosync" || cfg["permission"] != "write" || cfg["workdir"] != "{{sync.proto_path}}" {
		t.Fatalf("Claude Code 配置：%v", cfg)
	}
	if r, _ := steps["verdict"]["rule"].(string); r != "" || len(steps["verdict"]["cases"].([]any)) != 3 {
		t.Fatalf("裁决是人工判断、三个分支：%v", steps["verdict"])
	}
}

// 有界面改动：Claude Code 改原型（没提交），有一条拿不准 → 通知负责人裁决 → 当作缺陷建修复任务 → 只提交到同步分支 → 记同步点 → 通知；
// 再来一次：拿不准的当作新设计，再交 Claude Code 回写。
func TestProtoSyncFlowDefectThenDesign(t *testing.T) {
	e := setupProtoSyncFlow(t)
	protoMain := strings.TrimSpace(gitOut(t, e.proto, "rev-parse", "main"))
	e.codeCommit(t, "web/export.tsx")
	head := strings.TrimSpace(gitOut(t, e.code, "rev-parse", "HEAD"))
	id, runID := e.startSync(t)

	req := e.next(t)
	if !strings.Contains(req.Workdir, filepath.Join("worktrees", "obj_octok", "proto-sync-"+id)) || !req.AllowWrites ||
		!strings.Contains(req.Prompt, "proto-sync/") || !strings.Contains(req.Prompt, "diff.patch") || !strings.Contains(req.Prompt, "不确定（uncertain）") {
		t.Fatalf("Claude Code 在同步分支工作区里跑：%s %v\n%s", req.Workdir, req.AllowWrites, req.Prompt)
	}
	writeFile(t, filepath.Join(req.Workdir, "src/export.tsx"), "export const Export = () => null\n")
	e.report(t, req, "补了导出按钮；导出格式拿不准", map[string]any{"items": []any{
		map[string]any{"kind": "added", "title": "导出按钮", "spec": "SPEC-home-1.2", "page": "/home"},
		map[string]any{"kind": "uncertain", "title": "导出只有 CSV", "detail": "原型是 CSV 和 Excel"},
	}})
	e.waitRun(t, runID, "停在产品裁决", func(r map[string]any) bool { return sopStep(r, "verdict")["status"] == "review" })
	if row := e.syncRow(t, id); row["status"] != "reviewing" {
		t.Fatalf("等裁决：%v", row["status"])
	}
	ns := e.notes.list()
	if a := ns[len(ns)-1]; !strings.Contains(a.Title, "1 条差异待裁决") || !strings.Contains(a.Body, "导出只有 CSV") || !strings.Contains(a.Body, "负责人丙") {
		t.Fatalf("通知负责人裁决：%+v", a)
	}
	e.act(t, runID, `{"kind":"route","step":"verdict","route":"defect"}`)
	run := e.waitRun(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	if sopStep(run, "rewrite")["status"] != "bypassed" || sopStep(run, "v_defect")["status"] != "done" {
		t.Fatalf("缺陷不再回写：%v", briefSteps(run))
	}
	row := e.syncRow(t, id)
	if row["status"] != "done" || row["decision"] != "defect" || row["fix_task_id"] == "" || row["head_commit"] != head {
		t.Fatalf("同步结果：%v", row)
	}
	var title, project string
	if err := e.st.DB().R.QueryRow(`SELECT title, project_id FROM objects WHERE id = ?`, row["fix_task_id"]).Scan(&title, &project); err != nil ||
		!strings.Contains(title, "修复：原型同步") || project != "obj_octok" {
		t.Fatalf("修复任务：%v %s %s", err, title, project)
	}
	branch := row["proto_branch"].(string)
	pc := row["proto_commit"].(string)
	if !strings.HasPrefix(branch, "proto-sync/") || pc == "" || strings.TrimSpace(gitOut(t, e.proto, "rev-parse", branch)) != pc {
		t.Fatalf("只提交到同步分支：%v", row)
	}
	if strings.TrimSpace(gitOut(t, e.proto, "rev-parse", "main")) != protoMain || fileThere(filepath.Join(e.proto, "src/export.tsx")) {
		t.Fatal("原型库主分支被改了")
	}
	_, out := call(t, e.h, "GET", "/api/projects/obj_octok/proto-sync", "")
	if p := data(out)["point"].(map[string]any); p["commit"] != head || p["proto_commit"] != pc || p["sync_id"] != id {
		t.Fatalf("同步点：%v", p)
	}
	ns = e.notes.list()
	if a := ns[len(ns)-1]; a.Level != plugin.NotifySuccess || !strings.Contains(a.Body, "原型已按上线代码") || !strings.Contains(a.Body, branch) ||
		!strings.Contains(a.Body, "当作缺陷") {
		t.Fatalf("同步完成通知：%+v", a)
	}

	// 第二次：拿不准的当作新设计，再交 Claude Code 回写
	e.codeCommit(t, "web/filter.tsx")
	id2, run2 := e.startSync(t)
	req = e.next(t)
	e.report(t, req, "筛选拿不准", map[string]any{"items": []any{map[string]any{"kind": "uncertain", "title": "筛选少了日期"}}})
	e.waitRun(t, run2, "停在产品裁决", func(r map[string]any) bool { return sopStep(r, "verdict")["status"] == "review" })
	e.act(t, run2, `{"kind":"route","step":"verdict","route":"design"}`)
	rw := e.next(t)
	if !strings.Contains(rw.Prompt, "当作新设计") || !strings.Contains(rw.Prompt, "筛选少了日期") || rw.Workdir != req.Workdir {
		t.Fatalf("回写：%s\n%s", rw.Workdir, rw.Prompt)
	}
	writeFile(t, filepath.Join(rw.Workdir, "src/filter.tsx"), "export const Filter = 1\n")
	e.report(t, rw, "按代码改了筛选", map[string]any{})
	e.waitRun(t, run2, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	row = e.syncRow(t, id2)
	items := row["items"].([]any)
	if row["status"] != "done" || row["decision"] != "design" || row["base_commit"] != head || items[0].(map[string]any)["status"] != "implemented" ||
		!strings.HasSuffix(row["proto_branch"].(string), "-2") {
		t.Fatalf("新设计回写：%v", row)
	}
}

// 只有文档改动：不交给 Claude Code，只前移同步点
func TestProtoSyncFlowNoUIChange(t *testing.T) {
	e := setupProtoSyncFlow(t)
	e.codeCommit(t, "docs/notes.md")
	head := strings.TrimSpace(gitOut(t, e.code, "rev-parse", "HEAD"))
	id, runID := e.startSync(t)
	run := e.waitRun(t, runID, "跑完", func(r map[string]any) bool { return r["status"] == "done" })
	if sopStep(run, "branch")["status"] != "bypassed" || sopStep(run, "record_none")["status"] != "done" {
		t.Fatalf("没有界面改动：%v", briefSteps(run))
	}
	if row := e.syncRow(t, id); row["status"] != "no_change" || row["head_commit"] != head {
		t.Fatalf("只前移同步点：%v", row)
	}
	select {
	case req := <-e.pc.started:
		t.Fatalf("不该交给 Claude Code：%v", req)
	default:
	}
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := runGit(dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return out
}

func fileThere(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func runGit(dir string, args ...string) (string, error) {
	cmd := osexec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}
