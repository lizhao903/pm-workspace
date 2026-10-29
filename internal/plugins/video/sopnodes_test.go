package video

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
)

// SOP 节点和内置流程（VID-03d）。只在测试里把 SOP 插件拉进来，插件代码之间不 import。

func fastSOP(t *testing.T) {
	t.Helper()
	ow, ot := sopWaitEvery, templateEvery
	sopWaitEvery, templateEvery = 10*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { sopWaitEvery, templateEvery = ow, ot })
}

// setupWith 同 setup，另外装好、启用 extra 里的插件（在 video 之前）。
func setupWith(t *testing.T, extra ...plugin.Plugin) env {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	ps := append([]plugin.Plugin{projects.New()}, extra...)
	ps = append(ps, New())
	for _, p := range ps {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, p := range ps {
		m := p.Manifest()
		grant := m.Permissions
		if m.ID == "projects" {
			grant = []string{"process:spawn"}
		}
		if err := r.Install(ctx, m.ID, grant); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, m.ID); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return env{r, mux, d}
}

func nodeKinds(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/node-types", "")
	if code != 200 {
		t.Fatalf("节点目录 %d %v", code, out)
	}
	got := map[string]string{}
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		got[m["kind"].(string)] = m["source"].(string) + "/" + m["group"].(string)
	}
	return got
}

func sopRun(t *testing.T, e env, runID string) map[string]any {
	t.Helper()
	return mustCall(t, e.h, "GET", "/api/sop/runs/"+runID, "", 200)
}

func runStep(run map[string]any, key string) map[string]any {
	for _, s := range run["steps"].([]any) {
		if m := s.(map[string]any); m["key"] == key {
			return m
		}
	}
	return nil
}

// untilStep 等某一步满足条件，回最后一次取到的执行。
func untilStep(t *testing.T, e env, runID, key, what string, ok func(s map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		run := sopRun(t, e, runID)
		if s := runStep(run, key); s != nil && ok(s) {
			return run
		}
		if time.Now().After(deadline) {
			t.Fatalf("等了 10 秒还没有：%s，步骤 %s：%v", what, key, runStep(run, key))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitingStep(s map[string]any) bool {
	out, _ := s["output"].(map[string]any)
	_, ok := out["waiting"].(map[string]any)
	return s["status"] == "running" && ok
}

func weeklyBody(t *testing.T) string {
	t.Helper()
	b, err := json.Marshal(weeklyFlow())
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// 验收 1：SOP 编辑器的节点目录里有三种视频节点（video_publish 是 VID-06c 加的），停用视频插件后消失
func TestSOPNodeTypesFollowPlugin(t *testing.T) {
	e := setupWith(t, sop.New())
	got := nodeKinds(t, e.h)
	if got[NodeWaitCheckpoint] != "video/视频" || got[NodeRunStage] != "video/视频" || got[NodePublish] != "video/视频" {
		t.Fatalf("节点目录：%v", got)
	}
	if err := e.r.Disable(context.Background(), "video"); err != nil {
		t.Fatal(err)
	}
	got = nodeKinds(t, e.h)
	if _, ok := got[NodeWaitCheckpoint]; ok {
		t.Fatalf("停用后还在：%v", got)
	}
	if _, ok := got[NodeRunStage]; ok {
		t.Fatalf("停用后还在：%v", got)
	}
}

// 验收 2：用「视频周更」建的 SOP 跑完文稿处理，停在规划检查（视频被推到规划检查上）；在视频页通过后接着开发第 1 章，
// 再停在检查第 1 章
func TestWeeklyFlowStopsAtPlan(t *testing.T) {
	fastSOP(t)
	e := setupWith(t, sop.New())
	fc := &fakeClaude{}
	e.r.SetClaudeRunner(fc)
	root := t.TempDir()
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 28 集：周更流程","orientations":["landscape"],"root":"`+root+`","chapters":2}`, 201)
	vid := v["id"].(string)
	atScript(t, e, vid)
	path := "/api/video/videos/" + vid
	for _, st := range []string{"script", "web"} {
		mustCall(t, e.h, "PUT", path+"/runners/"+st, `{"type":"skill","ref_id":"sk_video"}`, 200)
	}
	// 内置模板由后台任务写入 SOP（sop/flow_install.go）；还没写到就手动建，撞上已写入的就直接用
	flow := map[string]any{}
	if code, got := call(t, e.h, "POST", "/api/sop/flows", weeklyBody(t)); code == 201 {
		flow = data(got)
	} else {
		flow = mustCall(t, e.h, "GET", "/api/sop/flows/"+WeeklyFlowID, "", 200)
	}
	if flow["id"] != WeeklyFlowID || flow["name"] != "视频周更" || len(flow["steps"].([]any)) != 8 {
		t.Fatalf("流程：%v", flow)
	}
	rid := mustCall(t, e.h, "POST", "/api/sop/flows/"+WeeklyFlowID+"/runs", `{"input":{"video_id":"`+vid+`"}}`, 201)["id"].(string)

	run := untilStep(t, e, rid, "plan", "停在规划检查", waitingStep)
	script := runStep(run, "script")
	sr, _ := script["output"].(map[string]any)["stage_run"].(map[string]any)
	if script["status"] != "done" || sr["stage"] != "script" || sr["status"] != "done" || len(sr["artifact_ids"].([]any)) != 2 {
		t.Fatalf("文稿处理：%v %v", script["status"], script["output"])
	}
	if !strings.Contains(fc.last().Prompt, "Phase 1") || fc.last().Workdir != root {
		t.Fatalf("交给 Claude Code 的：%+v", fc.last())
	}
	if got := mustCall(t, e.h, "GET", path, "", 200); got["stage"] != "plan" {
		t.Fatalf("视频应当被推到规划检查：%v", got["stage"])
	}
	if runStep(run, "ch1")["status"] != "pending" {
		t.Fatalf("规划检查没过不该开始第 1 章：%v", runStep(run, "ch1"))
	}
	// 退回不算，接着等
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"rejected","note":"大纲太散"}`, 200)
	time.Sleep(60 * time.Millisecond)
	if s := runStep(sopRun(t, e, rid), "plan"); !waitingStep(s) {
		t.Fatalf("退回后应当接着等：%v", s)
	}
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	run = untilStep(t, e, rid, "ch1_review", "停在检查第 1 章", waitingStep)
	plan := runStep(run, "plan")
	cp, _ := plan["output"].(map[string]any)["checkpoint"].(map[string]any)
	if plan["status"] != "done" || cp["stage"] != "plan" || cp["state"] != "passed" || plan["output"].(map[string]any)["video_id"] != vid {
		t.Fatalf("规划检查：%v %v", plan["status"], plan["output"])
	}
	if ch1 := runStep(run, "ch1"); ch1["status"] != "done" || !strings.Contains(fc.last().Prompt, "Phase 2.1") {
		t.Fatalf("开发第 1 章：%v", ch1)
	}
	if got := mustCall(t, e.h, "GET", path, "", 200); got["stage"] != "ch1" {
		t.Fatalf("视频应当在第一章验收：%v", got["stage"])
	}
	if runStep(run, "rest")["status"] != "pending" {
		t.Fatalf("第 1 章没验收不该往下走：%v", runStep(run, "rest"))
	}
}

// 跑阶段：没配执行器、检查不过直接失败，原因是视频页同一句话；执行器没跑成让步骤失败
func TestRunStageNodeFails(t *testing.T) {
	fastSOP(t)
	e := setupWith(t, sop.New())
	fc := &fakeClaude{fail: "工程目录里没有 package.json"}
	e.r.SetClaudeRunner(fc)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"失败","orientations":["landscape"],"root":"`+t.TempDir()+`"}`, 201)
	vid := v["id"].(string)
	atScript(t, e, vid)
	flow := func(stage string) string {
		return mustCall(t, e.h, "POST", "/api/sop/flows", `{"name":"跑 `+stage+`","fields":[{"key":"video_id","label":"视频","type":"text"}],
			"steps":[{"key":"a","name":"跑","kind":"video_run_stage","config":{"video":"{{video_id}}","stage":"`+stage+`"}}]}`, 201)["id"].(string)
	}
	start := func(fid, video string) string {
		return mustCall(t, e.h, "POST", "/api/sop/flows/"+fid+"/runs", `{"input":{"video_id":"`+video+`"}}`, 201)["id"].(string)
	}
	failed := func(s map[string]any) bool { return s["status"] == "failed" }
	run := untilStep(t, e, start(flow("script"), vid), "a", "没配执行器失败", failed)
	if got := runStep(run, "a")["error"]; got != "「内容编写」还没配执行器，先配一个再跑" {
		t.Fatalf("没配执行器：%v", got)
	}
	run = untilStep(t, e, start(flow("web"), vid), "a", "检查不过失败", failed)
	if got := runStep(run, "a")["error"]; got != "「规划检查」还没通过，不能开始「网页开发」" {
		t.Fatalf("规划检查没过：%v", got)
	}
	run = untilStep(t, e, start(flow("script"), "vid_nope"), "a", "视频不存在", failed)
	if got := runStep(run, "a")["error"]; got != "视频 vid_nope 不存在" {
		t.Fatalf("视频不存在：%v", got)
	}
	mustCall(t, e.h, "PUT", "/api/video/videos/"+vid+"/runners/script", `{"type":"skill","ref_id":"sk_video"}`, 200)
	run = untilStep(t, e, start(flow("script"), vid), "a", "执行器没跑成", failed)
	if got := runStep(run, "a")["error"].(string); !strings.HasPrefix(got, "「内容编写」没跑成：") || !strings.Contains(got, "package.json") {
		t.Fatalf("没跑成：%v", got)
	}
	var n int
	if err := e.d.R.QueryRow(`SELECT count(*) FROM video_sop_waits`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("等待没清掉：%d %v", n, err)
	}
}

// 等检查点：已经通过的直接往下走；中间隔着别的检查点时不推视频
func TestWaitCheckpointNode(t *testing.T) {
	fastSOP(t)
	e := setupWith(t, sop.New())
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"等","orientations":["landscape"]}`, 201)
	vid := v["id"].(string)
	fid := mustCall(t, e.h, "POST", "/api/sop/flows", `{"name":"等","fields":[{"key":"video_id","label":"视频","type":"text"}],
		"steps":[{"key":"a","name":"等","kind":"video_wait_checkpoint","config":{"video":"{{video_id}}","checkpoint":"ch1"}}]}`, 201)["id"].(string)
	rid := mustCall(t, e.h, "POST", "/api/sop/flows/"+fid+"/runs", `{"input":{"video_id":"`+vid+`"}}`, 201)["id"].(string)
	untilStep(t, e, rid, "a", "挂起", waitingStep)
	if got := mustCall(t, e.h, "GET", "/api/video/videos/"+vid, "", 200); got["stage"] != "topic" {
		t.Fatalf("中间隔着规划检查，不该推视频：%v", got["stage"])
	}
	// 视频删了，步骤失败
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+vid, "", 200)
	run := untilStep(t, e, rid, "a", "视频删了失败", func(s map[string]any) bool { return s["status"] == "failed" })
	if got := runStep(run, "a")["error"]; got != "视频 "+vid+" 已经删了" {
		t.Fatalf("视频删了：%v", got)
	}

	v = mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"已过","orientations":["landscape"]}`, 201)
	vid = v["id"].(string)
	atScript(t, e, vid)
	mustCall(t, e.h, "POST", "/api/video/videos/"+vid+"/advance", `{"from":"script"}`, 200)
	mustCall(t, e.h, "POST", "/api/video/videos/"+vid+"/checkpoints/plan", `{"state":"passed"}`, 200)
	fid = mustCall(t, e.h, "POST", "/api/sop/flows", `{"name":"已过","fields":[{"key":"video_id","label":"视频","type":"text"}],
		"steps":[{"key":"a","name":"等","kind":"video_wait_checkpoint","config":{"video":"{{video_id}}","checkpoint":"plan"}}]}`, 201)["id"].(string)
	rid = mustCall(t, e.h, "POST", "/api/sop/flows/"+fid+"/runs", `{"input":{"video_id":"`+vid+`"}}`, 201)["id"].(string)
	run = untilStep(t, e, rid, "a", "直接通过", func(s map[string]any) bool { return s["status"] == "done" })
	if cp := runStep(run, "a")["output"].(map[string]any)["checkpoint"].(map[string]any); cp["state"] != "passed" || cp["label"] != "规划检查" {
		t.Fatalf("已通过：%v", cp)
	}
}

/* ---------- 内置流程 ---------- */

// fakeSOP 是只为接内置流程的假 SOP 插件：记下写入和撤下，modified 里的流程撤下时说改过了。
type fakeSOP struct {
	mu       sync.Mutex
	flows    map[string]plugin.SOPFlowTemplate
	log      []string
	modified map[string]bool
}

type fakeSOPEngine struct{ f *fakeSOP }

func (fakeSOPEngine) Resume(context.Context, string, string, string, map[string]any) error {
	return nil
}
func (fakeSOPEngine) Fail(context.Context, string, string, string, string) error { return nil }

func (e fakeSOPEngine) InstallFlow(_ context.Context, caller string, t plugin.SOPFlowTemplate) (bool, error) {
	e.f.mu.Lock()
	defer e.f.mu.Unlock()
	e.f.log = append(e.f.log, "install "+caller+" "+t.ID)
	if _, ok := e.f.flows[t.ID]; ok {
		return false, nil
	}
	e.f.flows[t.ID] = t
	return true, nil
}

func (e fakeSOPEngine) RemoveFlow(_ context.Context, caller, id string) (bool, string, error) {
	e.f.mu.Lock()
	defer e.f.mu.Unlock()
	e.f.log = append(e.f.log, "remove "+caller+" "+id)
	if e.f.modified[id] {
		return false, "改过了", nil
	}
	_, ok := e.f.flows[id]
	delete(e.f.flows, id)
	return ok, "", nil
}

func (f *fakeSOP) Manifest() plugin.Manifest {
	return plugin.MustParse([]byte(`{"id":"sop","name":"SOP","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":[]}`))
}
func (f *fakeSOP) Migrations() fs.FS { return nil }
func (f *fakeSOP) Register(r plugin.Registrar) error {
	r.SOPEngine(fakeSOPEngine{f})
	return nil
}

func (f *fakeSOP) set(id string, t *plugin.SOPFlowTemplate) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if t == nil {
		delete(f.flows, id)
	} else {
		f.flows[id] = *t
	}
}

func (f *fakeSOP) has(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.flows[id]
	return ok
}

func (f *fakeSOP) logged() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.log, "；")
}

func templateRows(t *testing.T, d *db.DB) int {
	t.Helper()
	var n int
	if err := d.R.QueryRow(`SELECT count(*) FROM video_sop_templates`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func until(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒还没有：%s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// 启用后写入「视频周更」，只写一次（停用再启用、用户删了都不补）；卸载撤下没改过的，改过的留着
func TestWeeklyTemplateLifecycle(t *testing.T) {
	fastSOP(t)
	ctx := context.Background()
	f := &fakeSOP{flows: map[string]plugin.SOPFlowTemplate{}, modified: map[string]bool{}}
	e := setupWith(t, f)
	until(t, "写入内置流程", func() bool { return templateRows(t, e.d) == 1 })
	if got := f.logged(); got != "install video "+WeeklyFlowID {
		t.Fatalf("写入：%s", got)
	}
	f.mu.Lock()
	tpl := f.flows[WeeklyFlowID]
	f.mu.Unlock()
	if tpl.Name != "视频周更" || !strings.Contains(string(tpl.Steps), `"kind":"video_wait_checkpoint"`) || !strings.Contains(string(tpl.Fields), `"video_id"`) {
		t.Fatalf("模板：%+v", tpl)
	}
	// 用户删了、停用再启用都不再写
	f.set(WeeklyFlowID, nil)
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if got := f.logged(); got != "install video "+WeeklyFlowID {
		t.Fatalf("不该再写：%s", got)
	}
	// 卸载（留数据）撤下，删掉记录；再装再写
	f.set(WeeklyFlowID, &tpl)
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.r.Uninstall(ctx, "video", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if f.has(WeeklyFlowID) || templateRows(t, e.d) != 0 {
		t.Fatalf("卸载应当撤下：%d", templateRows(t, e.d))
	}
	if err := e.r.Install(ctx, "video", perms); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	until(t, "重装后写入", func() bool { return templateRows(t, e.d) == 1 })
	// 改过的留着，记录也留着（重装不覆盖）
	f.mu.Lock()
	f.modified[WeeklyFlowID] = true
	f.mu.Unlock()
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.r.Uninstall(ctx, "video", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if !f.has(WeeklyFlowID) || templateRows(t, e.d) != 1 {
		t.Fatalf("改过的应当留着：%d", templateRows(t, e.d))
	}
	if got := f.logged(); strings.Count(got, "remove video "+WeeklyFlowID) != 2 {
		t.Fatalf("撤下：%s", got)
	}
}

// 没有 SOP 插件时不写、不报错，也不记成写过（之后装上 SOP 插件会补写）
func TestWeeklyTemplateWaitsForSOP(t *testing.T) {
	fastSOP(t)
	e := setup(t)
	time.Sleep(60 * time.Millisecond)
	if templateRows(t, e.d) != 0 {
		t.Fatal("没有 SOP 插件不该记写过")
	}
}

// SOP 执行器运行中 last_run.ref 就是 SOP 执行 id，能直接查这次执行（POL-02）
func TestSOPRunnerRefWhileRunning(t *testing.T) {
	fastSOP(t)
	e := setupWith(t, sop.New())
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 29 集：执行中","orientations":["landscape"],"root":"`+t.TempDir()+`","chapters":2}`, 201)
	vid := v["id"].(string)
	atScript(t, e, vid)
	fid := mustCall(t, e.h, "POST", "/api/sop/flows", `{"name":"人工把关","steps":[{"key":"chk","name":"检查","kind":"review"}]}`, 201)["id"].(string)
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "PUT", path+"/runners/script", `{"type":"sop","ref_id":"`+fid+`"}`, 200)
	got := mustCall(t, e.h, "POST", path+"/runners/script/run", "", 202)
	lr, _ := got["last_run"].(map[string]any)
	ref, _ := lr["ref"].(string)
	if lr["status"] != "running" || lr["type"] != "sop" || !strings.HasPrefix(ref, "spr") {
		t.Fatalf("运行中的 last_run：%v", lr)
	}
	run := untilStep(t, e, ref, "chk", "停在检查", func(s map[string]any) bool { return s["status"] == "review" })
	if run["flow_id"] != fid || run["status"] == "done" {
		t.Fatalf("last_run.ref 指向的执行：%v", run)
	}
	if lr := mustCall(t, e.h, "GET", path, "", 200)["last_run"].(map[string]any); lr["status"] != "running" || lr["ref"] != ref {
		t.Fatalf("读视频时的 last_run：%v", lr)
	}
}
