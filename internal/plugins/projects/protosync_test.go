// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 原型回写旁路（AUTO-11）。代码库、原型库都是 t.TempDir() 里 git init 的临时仓库；SOP 发起换成记录器，节点直接调。

type psEnv struct {
	*wtEnv
	code, proto string
	ps          *protoSyncService
	mu          sync.Mutex
	started     []plugin.SOPRunStart
	startErr    error
	clock       time.Time
}

func setupProtoSync(t *testing.T) *psEnv {
	t.Helper()
	e := &psEnv{wtEnv: setupWT(t)}
	e.code, e.proto = newRepo(t), newRepo(t)
	write(t, filepath.Join(e.proto, "docs/spec/home.md"), "| SPEC-home-1.1 | 首页 | 看 | 列表 |\n")
	gitRun(t, e.proto, "add", ".")
	gitRun(t, e.proto, "commit", "-q", "-m", "spec")
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+e.code+`","proto_dir":"`+e.proto+`"}`); code != 200 {
		t.Fatalf("档案：%d %v", code, out)
	}
	e.ps = e.plug.protoSyncs
	e.clock = time.Date(2026, 11, 4, 10, 0, 0, 0, time.Local)
	e.ps.now = func() time.Time {
		e.mu.Lock()
		defer e.mu.Unlock()
		return e.clock
	}
	e.ps.start = func(_ context.Context, q plugin.SOPRunStart) (string, error) {
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.startErr != nil {
			return "", e.startErr
		}
		e.started = append(e.started, q)
		return "run_" + q.Input["sync_id"].(string), nil
	}
	return e
}

func (e *psEnv) setClock(t time.Time) {
	e.mu.Lock()
	e.clock = t
	e.mu.Unlock()
}

func (e *psEnv) starts() []plugin.SOPRunStart {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]plugin.SOPRunStart(nil), e.started...)
}

func (e *psEnv) commit(t *testing.T, file, body string) string {
	t.Helper()
	write(t, filepath.Join(e.code, file), body)
	gitRun(t, e.code, "add", ".")
	gitRun(t, e.code, "commit", "-q", "-m", "change "+file)
	return gitRun(t, e.code, "rev-parse", "HEAD")
}

func (e *psEnv) state(t *testing.T) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/projects/obj_p1/proto-sync", "")
	if code != 200 {
		t.Fatalf("概况：%d %v", code, out)
	}
	return data(out)
}

func (e *psEnv) history(t *testing.T) []map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/projects/obj_p1/proto-syncs", "")
	if code != 200 {
		t.Fatalf("历史：%d %v", code, out)
	}
	var rows []map[string]any
	for _, x := range out["data"].([]any) {
		rows = append(rows, x.(map[string]any))
	}
	return rows
}

func (e *psEnv) settings(t *testing.T, body string) {
	t.Helper()
	if code, out := call(t, e.h, "PATCH", "/api/projects/obj_p1/proto-sync", body); code != 200 {
		t.Fatalf("改设置 %s：%d %v", body, code, out)
	}
}

func (e *psEnv) node(t *testing.T, kind string, cfg map[string]string, input map[string]any) (map[string]any, error) {
	t.Helper()
	n := plugin.SOPNodeInput{RunID: "spr_t", FlowID: "sop_im_proto_sync", Step: kind, Attempt: 1, Config: cfg, Input: input}
	switch kind {
	case NodeProtoSyncRange:
		return e.ps.rangeNode(context.Background(), nil, n)
	case NodeProtoSyncBranch:
		return e.ps.branchNode(context.Background(), nil, n)
	case NodeProtoSyncClassify:
		return e.ps.classifyNode(context.Background(), nil, n)
	case NodeProtoSyncVerdict:
		return e.ps.verdictNode(context.Background(), nil, n)
	case NodeProtoSyncCommit:
		return e.ps.commitNode(context.Background(), nil, n)
	case NodeProtoSyncRecord:
		return e.ps.recordNode(context.Background(), nil, n)
	}
	t.Fatalf("没有节点 %s", kind)
	return nil, nil
}

func syncOf(out map[string]any) map[string]any {
	m, _ := out["sync"].(map[string]any)
	return m
}

// 三种触发默认都关；设基线记同步点；开了「生产分支合并」后 HEAD 变了才发起，同一个 HEAD 不重复发起；
// 开了「发布成功」后发布 released 时发起；每日巡检到点一次，HEAD 没变只记 no_change。
func TestProtoSyncTriggers(t *testing.T) {
	e := setupProtoSync(t)
	e.setClock(time.Date(2026, 11, 4, 8, 0, 0, 0, time.Local))
	st := e.state(t)
	set := st["settings"].(map[string]any)
	if set["on_release"] != false || set["on_merge"] != false || set["daily"] != false || set["daily_at"] != "09:00" || st["point"] != nil || st["branch"] != "main" {
		t.Fatalf("默认都关、没有同步点：%v", st)
	}
	// 发布回调接上了
	if e.plug.releases.onReleased == nil {
		t.Fatal("发布成功的回调没接上")
	}

	// 设基线
	head0 := gitRun(t, e.code, "rev-parse", "HEAD")
	code, out := call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{"mode":"baseline"}`)
	if code != 201 || data(out)["status"] != psBaseline || data(out)["head_commit"] != head0 {
		t.Fatalf("设基线：%d %v", code, out)
	}
	if p := e.state(t)["point"].(map[string]any); p["commit"] != head0 || p["status"] != psBaseline {
		t.Fatalf("同步点：%v", p)
	}

	// 开关都关：有新提交也不发起
	head1 := e.commit(t, "web/app.tsx", "export const A = 1\n")
	e.ps.watch(context.Background())
	e.ps.onReleased(Release{ID: "rel_x", ProjectID: "obj_p1", Status: rlReleased})
	if len(e.starts()) != 0 || len(e.history(t)) != 1 {
		t.Fatalf("默认停用：%v", e.starts())
	}

	// 生产分支合并
	e.settings(t, `{"on_merge":true}`)
	e.ps.watch(context.Background())
	s := e.starts()
	if len(s) != 1 || s[0].Flow != ProtoSyncFlowID || s[0].Input["trigger"] != trigMerge || s[0].Input["project_id"] != "obj_p1" || s[0].ObjectID != "obj_p1" {
		t.Fatalf("合并后发起：%v", s)
	}
	h := e.history(t)
	if h[0]["trigger"] != trigMerge || h[0]["trigger_ref"] != head1 || h[0]["status"] != psRunning || h[0]["base_commit"] != head0 ||
		h[0]["head_commit"] != head1 || h[0]["run_id"] != "run_"+h[0]["id"].(string) {
		t.Fatalf("合并触发的同步：%v", h[0])
	}
	// 进行中：不重复发起；发布成功也挡住
	e.ps.watch(context.Background())
	e.settings(t, `{"on_release":true}`)
	e.ps.onReleased(Release{ID: "rel_1", ProjectID: "obj_p1", Status: rlReleased})
	if len(e.starts()) != 1 {
		t.Fatalf("有进行中的不再发起：%v", e.starts())
	}
	if code, out := call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", ""); code != 409 || !strings.Contains(errMsg(out), "还没结束") {
		t.Fatalf("手动发起被挡：%d %v", code, out)
	}
	// 作废：同步点不动；同一个 HEAD 不再自动发起
	code, out = call(t, e.h, "POST", "/api/projects/proto-syncs/runs/"+h[0]["id"].(string)+"/cancel", "")
	if code != 200 || data(out)["status"] != psCancelled {
		t.Fatalf("作废：%d %v", code, out)
	}
	e.ps.watch(context.Background())
	if len(e.starts()) != 1 || e.state(t)["point"].(map[string]any)["commit"] != head0 {
		t.Fatalf("作废后同一个 HEAD 不自动重来，同步点不动：%v", e.starts())
	}

	// 发布成功
	e.settings(t, `{"on_merge":false}`)
	e.ps.onReleased(Release{ID: "rel_2", ProjectID: "obj_p1", Status: rlReleased})
	s = e.starts()
	if len(s) != 2 || s[1].Input["trigger"] != trigRelease {
		t.Fatalf("发布成功后发起：%v", s)
	}
	h = e.history(t)
	if h[0]["trigger"] != trigRelease || h[0]["trigger_ref"] != "rel_2" {
		t.Fatalf("发布触发：%v", h[0])
	}
	call(t, e.h, "POST", "/api/projects/proto-syncs/runs/"+h[0]["id"].(string)+"/cancel", "")

	// 每日巡检：先把 HEAD 记成同步点，到点后巡检一次只记 no_change，不发起；当天不再巡检
	e.settings(t, `{"on_release":false,"daily":true,"daily_at":"09:30"}`)
	e.setClock(time.Date(2026, 11, 4, 9, 0, 0, 0, time.Local))
	call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{"mode":"baseline"}`)
	e.ps.watch(context.Background())
	if n := len(e.history(t)); n != 4 {
		t.Fatalf("没到点不巡检：%d", n)
	}
	e.setClock(time.Date(2026, 11, 4, 9, 31, 0, 0, time.Local))
	e.ps.watch(context.Background())
	h = e.history(t)
	if len(h) != 5 || h[0]["trigger"] != trigDaily || h[0]["status"] != psNoChange || h[0]["trigger_ref"] != "2026-11-04" || len(e.starts()) != 2 {
		t.Fatalf("巡检没变化只记一行：%v", h[0])
	}
	e.ps.watch(context.Background())
	if len(e.history(t)) != 5 {
		t.Fatal("当天只巡检一次")
	}
	// 第二天有新提交：巡检发起流程
	head2 := e.commit(t, "web/list.tsx", "export const L = 2\n")
	e.setClock(time.Date(2026, 11, 5, 10, 0, 0, 0, time.Local))
	e.ps.watch(context.Background())
	s = e.starts()
	if len(s) != 3 || s[2].Input["trigger"] != trigDaily {
		t.Fatalf("第二天巡检发起：%v", s)
	}
	if h = e.history(t); h[0]["head_commit"] != head2 || h[0]["base_commit"] != head1 || h[0]["status"] != psRunning {
		t.Fatalf("巡检的范围：%v", h[0])
	}
	if a := e.state(t)["active"].(map[string]any); a["id"] != h[0]["id"] {
		t.Fatalf("进行中的那次：%v", a)
	}

	// 流程没发起成（SOP 没在跑）：这次记 failed
	call(t, e.h, "POST", "/api/projects/proto-syncs/runs/"+h[0]["id"].(string)+"/cancel", "")
	e.mu.Lock()
	e.startErr = plugin.ErrNoSOPStarter
	e.mu.Unlock()
	code, out = call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{}`)
	if code != 409 || !strings.Contains(errMsg(out), "原型同步流程没发起") {
		t.Fatalf("发起失败：%d %v", code, out)
	}
	if h = e.history(t); h[0]["status"] != psFailed || h[0]["trigger"] != trigManual {
		t.Fatalf("发起失败记 failed：%v", h[0])
	}
}

// 设置校验；项目不存在 404
func TestProtoSyncSettingsValidation(t *testing.T) {
	e := setupProtoSync(t)
	for _, body := range []string{`{"daily_at":"9:30"}`, `{"daily_at":"24:00"}`, `{"branch":"a..b"}`, `{"branch":"bad name"}`, `{"branch":"-x"}`} {
		if code, out := call(t, e.h, "PATCH", "/api/projects/obj_p1/proto-sync", body); code != 400 {
			t.Fatalf("%s 应 400：%d %v", body, code, out)
		}
	}
	e.settings(t, `{"branch":"release/prod"}`)
	if st := e.state(t); st["head_error"] == "" || !strings.Contains(st["head_error"].(string), "没有分支 release/prod") {
		t.Fatalf("分支不存在写进 head_error：%v", st)
	}
	if code, _ := call(t, e.h, "GET", "/api/projects/obj_nope/proto-sync", ""); code != 404 {
		t.Fatalf("项目不存在：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{"mode":"x"}`); code != 400 {
		t.Fatalf("mode 不认：%d", code)
	}
}

// 节点走一遍：取范围（有界面改动）→ 准备同步分支 → Claude Code 改原型（一处自己提交、一处没提交）→ 登记差异（有拿不准的转等裁决）
// → 没裁决不能记同步点 → 裁决「新设计」→ 提交同步分支（主分支不动）→ 记同步点（代码 HEAD 和同步分支提交对上，worktree 删掉、分支保留）。
func TestProtoSyncNodesClassifyVerdictCommit(t *testing.T) {
	e := setupProtoSync(t)
	head0 := gitRun(t, e.code, "rev-parse", "HEAD")
	call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{"mode":"baseline"}`)
	head1 := e.commit(t, "web/export.tsx", "export const CSV = true\n")
	ps, err := e.ps.Trigger(context.Background(), "obj_p1", trigManual, "")
	if err != nil {
		t.Fatal(err)
	}
	in := map[string]any{"project_id": "obj_p1", "sync_id": ps.ID}

	out, err := e.node(t, NodeProtoSyncRange, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	sy := syncOf(out)
	if sy["changed"] != true || sy["base"] != head0 || sy["head"] != head1 || sy["files_count"] != 1 || sy["diff_path"] == "" {
		t.Fatalf("同步范围：%v", sy)
	}
	if patch, err := os.ReadFile(sy["diff_path"].(string)); err != nil || !strings.Contains(string(patch), "CSV = true") {
		t.Fatalf("diff.patch：%v %s", err, patch)
	}

	protoMain := gitRun(t, e.proto, "rev-parse", "main")
	out, err = e.node(t, NodeProtoSyncBranch, nil, out)
	if err != nil {
		t.Fatal(err)
	}
	sy = syncOf(out)
	path := sy["proto_path"].(string)
	if sy["proto_branch"] != "proto-sync/20261104" || sy["proto_base"] != protoMain || !strings.HasPrefix(path, e.data) {
		t.Fatalf("同步分支：%v", sy)
	}
	if cur := gitRun(t, e.proto, "symbolic-ref", "--short", "HEAD"); cur != "main" {
		t.Fatalf("原型库主目录不切分支：%s", cur)
	}
	// 重跑复用同一个 worktree
	if again, err := e.node(t, NodeProtoSyncBranch, nil, out); err != nil || syncOf(again)["proto_path"] != path {
		t.Fatalf("重跑复用：%v %v", err, again)
	}

	// 假的 Claude Code：改规格（自己提交一次），再加一个原型页面不提交
	write(t, filepath.Join(path, "docs/spec/home.md"), "| SPEC-home-1.1 | 首页 | 看 | 列表（实现状态：已实现） |\n| SPEC-home-1.2 | 导出 | 点击 | 下载 CSV（实现状态：已实现（原型同步 "+head1[:7]+"）） |\n")
	gitRun(t, path, "add", ".")
	gitRun(t, path, "commit", "-q", "-m", "agent: spec")
	write(t, filepath.Join(path, "src/export.tsx"), "export const Export = () => null\n")
	out["summary"] = "补了导出按钮，导出格式拿不准"
	out["result"] = map[string]any{"items": []any{
		map[string]any{"kind": "added", "title": "导出按钮", "spec": "SPEC-home-1.2", "page": "/home"},
		map[string]any{"kind": "未实现", "title": "批量删除", "spec": "SPEC-home-1.3"},
		map[string]any{"kind": "removed", "title": "旧版筛选"},
		map[string]any{"kind": "uncertain", "title": "导出只有 CSV", "detail": "原型是 CSV 和 Excel"},
	}}
	out, err = e.node(t, NodeProtoSyncClassify, nil, out)
	if err != nil {
		t.Fatal(err)
	}
	sy = syncOf(out)
	c := sy["counts"].(map[string]any)
	if sy["has_pending"] != true || c["added"] != 1 || c["unimplemented"] != 1 || c["removed"] != 1 || c["uncertain"] != 1 || c["pending"] != 1 ||
		sy["status"] != psReviewing || !strings.Contains(sy["pending_text"].(string), "导出只有 CSV") {
		t.Fatalf("登记差异：%v", sy)
	}
	items := sy["items"].([]any)
	if items[0].(map[string]any)["status"] != implImplemented || items[1].(map[string]any)["status"] != implUnimplemented ||
		items[2].(map[string]any)["status"] != implOffline || items[3].(map[string]any)["status"] != implPending {
		t.Fatalf("规格实现状态：%v", items)
	}
	if _, err := e.node(t, NodeProtoSyncRecord, nil, out); err == nil || !strings.Contains(err.Error(), "没裁决") {
		t.Fatalf("没裁决不能记同步点：%v", err)
	}
	if _, err := e.node(t, NodeProtoSyncVerdict, map[string]string{"decision": "maybe"}, out); err == nil {
		t.Fatal("裁决不认要报错")
	}
	out, err = e.node(t, NodeProtoSyncVerdict, map[string]string{"decision": "design"}, out)
	if err != nil {
		t.Fatal(err)
	}
	sy = syncOf(out)
	if sy["has_pending"] != false || sy["decision"] != verdictDesign || sy["status"] != psRunning ||
		sy["items"].([]any)[3].(map[string]any)["status"] != implImplemented {
		t.Fatalf("裁决为新设计：%v", sy)
	}

	out, err = e.node(t, NodeProtoSyncCommit, nil, out)
	if err != nil {
		t.Fatal(err)
	}
	sy = syncOf(out)
	pc := sy["proto_commit"].(string)
	if pc == "" || gitRun(t, e.proto, "rev-parse", "proto-sync/20261104") != pc {
		t.Fatalf("提交到同步分支：%v", sy)
	}
	if gitRun(t, e.proto, "rev-parse", "main") != protoMain {
		t.Fatal("原型库主分支被改了")
	}
	if files := gitRun(t, e.proto, "diff", "--name-only", protoMain, pc); !strings.Contains(files, "src/export.tsx") || !strings.Contains(files, "docs/spec/home.md") {
		t.Fatalf("同步分支上的改动：%s", files)
	}

	out, err = e.node(t, NodeProtoSyncRecord, nil, out)
	if err != nil {
		t.Fatal(err)
	}
	sy = syncOf(out)
	if sy["status"] != psDone || !strings.Contains(sy["text"].(string), "proto-sync/20261104") {
		t.Fatalf("记同步点：%v", sy)
	}
	p := e.state(t)["point"].(map[string]any)
	if p["commit"] != head1 || p["proto_commit"] != pc || p["proto_branch"] != "proto-sync/20261104" || p["sync_id"] != ps.ID {
		t.Fatalf("同步点和同步分支对应：%v", p)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("worktree 要删掉：%v", err)
	}
	if gitRun(t, e.proto, "rev-parse", "proto-sync/20261104") != pc {
		t.Fatal("同步分支要保留")
	}
	// 重跑记同步点：原样回
	if again, err := e.node(t, NodeProtoSyncRecord, nil, out); err != nil || syncOf(again)["status"] != psDone {
		t.Fatalf("重跑：%v %v", err, again)
	}
	// 同一天再同步一次：分支名加 -2
	e.commit(t, "web/more.tsx", "x\n")
	ps2, err := e.ps.Trigger(context.Background(), "obj_p1", trigManual, "")
	if err != nil {
		t.Fatal(err)
	}
	out, _ = e.node(t, NodeProtoSyncRange, nil, map[string]any{"sync_id": ps2.ID})
	if sy = syncOf(out); sy["base"] != head1 {
		t.Fatalf("下次从同步点开始：%v", sy)
	}
	out, err = e.node(t, NodeProtoSyncBranch, nil, out)
	if err != nil || syncOf(out)["proto_branch"] != "proto-sync/20261104-2" {
		t.Fatalf("同一天第二个分支：%v %v", err, out)
	}
	// 同步分支的目录被切到别的分支：拒绝提交
	gitRun(t, syncOf(out)["proto_path"].(string), "checkout", "-q", "-b", "sneaky")
	if _, err := e.node(t, NodeProtoSyncCommit, nil, out); err == nil || !strings.Contains(err.Error(), "只提交到原型同步分支") {
		t.Fatalf("不是同步分支要拒绝：%v", err)
	}
}

// 只有测试、文档改动：没有涉及界面或接口的改动，记 no_change，同步点前移；SOP 页直接发起（没有 sync_id）时节点自己建行，重跑同一次尝试不重复建
func TestProtoSyncNoUIChangeAndDirectRun(t *testing.T) {
	e := setupProtoSync(t)
	call(t, e.h, "POST", "/api/projects/obj_p1/proto-syncs", `{"mode":"baseline"}`)
	e.commit(t, "docs/notes.md", "笔记\n")
	head := e.commit(t, "web/a_test.go", "package web\n")
	in := map[string]any{"project_id": "PRJ-T1"}
	out, err := e.node(t, NodeProtoSyncRange, nil, in)
	if err != nil {
		t.Fatal(err)
	}
	sy := syncOf(out)
	if sy["changed"] != false || sy["trigger"] != trigManual || sy["files_count"] != 2 {
		t.Fatalf("只有文档和测试：%v", sy)
	}
	again, err := e.node(t, NodeProtoSyncRange, nil, in)
	if err != nil || syncOf(again)["id"] != sy["id"] {
		t.Fatalf("重跑不重复建：%v %v", err, again)
	}
	out, err = e.node(t, NodeProtoSyncRecord, map[string]string{"outcome": "no_change"}, out)
	if err != nil || syncOf(out)["status"] != psNoChange {
		t.Fatalf("记 no_change：%v %v", err, out)
	}
	if p := e.state(t)["point"].(map[string]any); p["commit"] != head || p["status"] != psNoChange {
		t.Fatalf("同步点前移：%v", p)
	}
	// 首次同步（没有同步点）对比整个代码库
	e2 := setupProtoSync(t)
	out, err = e2.node(t, NodeProtoSyncRange, nil, map[string]any{"project_id": "obj_p1"})
	if err != nil || syncOf(out)["full"] != true || syncOf(out)["changed"] != true || syncOf(out)["base_short"] != "（首次同步）" {
		t.Fatalf("首次同步：%v %v", err, out)
	}
}

// 本插件发起的原型同步执行结束了、流程没走到记同步点：这次记 failed，同步点不动
func TestProtoSyncRunFinishedMarksFailed(t *testing.T) {
	e := setupProtoSync(t)
	e.commit(t, "web/a.tsx", "a\n")
	ps, err := e.ps.Trigger(context.Background(), "obj_p1", trigManual, "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"run_id": "run_" + ps.ID, "kind": plugin.RunKindSOP, "ref": "spr_x", "status": "failed", "ok": false})
	if err := e.ps.onRunFinished(context.Background(), nil, plugin.Event{Type: plugin.RunFinishedEvent, Payload: b}); err != nil {
		t.Fatal(err)
	}
	got, _ := e.ps.get(context.Background(), ps.ID)
	if got.Status != psFailed || !strings.Contains(got.Error, "没走完") || e.state(t)["point"] != nil {
		t.Fatalf("没走完记 failed：%+v", got)
	}
}
