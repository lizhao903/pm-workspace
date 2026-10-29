package video

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// fakeClaude 是假的 Claude Code：记下请求，等 gate 关上（nil 不等）再按 fail 回成功或失败。
type fakeClaude struct {
	mu   sync.Mutex
	gate chan struct{}
	fail string
	got  []runner.Request
}

func (f *fakeClaude) Start(_ context.Context, req runner.Request, _ func(runner.Event)) (*runner.Result, error) {
	f.mu.Lock()
	f.got = append(f.got, req)
	gate, fail := f.gate, f.fail
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	if fail != "" {
		return &runner.Result{Status: plugin.RunFailed, ExitCode: 1, Error: fail}, nil
	}
	return &runner.Result{Status: plugin.RunDone, Output: "做好了"}, nil
}

func (f *fakeClaude) last() runner.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.got[len(f.got)-1]
}

// fakeAgent 是假的 Agent：RunAgent 直接回一个会话。
type fakeAgent struct{}

func (fakeAgent) Complete(context.Context, plugin.CompleteRequest) (string, error) { return "", nil }
func (fakeAgent) RunAgent(_ context.Context, q plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	if q.Agent == "nobody" {
		return plugin.AgentRunResult{}, errors.New("Agent 不存在")
	}
	return plugin.AgentRunResult{SessionID: "ags_video1", Reply: "做好了"}, nil
}
func (fakeAgent) AgentState(context.Context, string) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, nil
}
func (fakeAgent) SearchKB(context.Context, []string, string, int) ([]plugin.KBHit, error) {
	return nil, nil
}

// waitRun 轮询视频直到 last_run 不再是 running。
func waitRun(t *testing.T, e env, vid string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		v := mustCall(t, e.h, "GET", "/api/video/videos/"+vid, "", 200)
		if lr, _ := v["last_run"].(map[string]any); lr != nil && lr["status"] != "running" {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("等不到执行结束：%v", v["last_run"])
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 新建一集横竖两版的视频，工程目录是临时目录，停在规划检查上
func runnerVideo(t *testing.T, e env) (string, string) {
	t.Helper()
	root := t.TempDir()
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 27 集：Ollama 本地跑模型","orientations":["landscape","portrait"],"root":"`+root+`","chapters":3}`, 201)
	vid := v["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/videos/"+vid+"/advance", `{"from":"script"}`, 200)
	return vid, root
}

func artifactsOf(t *testing.T, e env, vid string) []map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/video/artifacts?video_id="+vid, "")
	if code != 200 {
		t.Fatalf("产出物列表：%d %v", code, out)
	}
	var xs []map[string]any
	for _, x := range out["data"].([]any) {
		xs = append(xs, x.(map[string]any))
	}
	return xs
}

// 验收 1、2：规划检查没过 409 说明原因；通过后直接开始网页开发，跑完演示工程（每个比例一份）进待验收，检查点不动
func TestRunWebAfterPlan(t *testing.T) {
	e := setup(t)
	fc := &fakeClaude{gate: make(chan struct{})}
	e.r.SetClaudeRunner(fc)
	vid, root := runnerVideo(t, e)
	path := "/api/video/videos/" + vid

	v := mustCall(t, e.h, "PUT", path+"/runners/web", `{"type":"skill","ref_id":"sk_video","prompt":"套 templates/ai100 搭竖屏演示工程"}`, 200)
	if rs := v["runners"].([]any); len(rs) != 1 || rs[0].(map[string]any)["ref_id"] != "sk_video" || rs[0].(map[string]any)["stage"] != "web" {
		t.Fatalf("执行器：%v", v["runners"])
	}
	if v["last_run"] != nil {
		t.Fatalf("还没跑过不该有 last_run：%v", v["last_run"])
	}
	// 规划检查没过
	code, out := call(t, e.h, "POST", path+"/runners/web/run", "")
	if code != 409 || errMsg(out) != "「规划检查」还没通过，不能开始「网页开发」" {
		t.Fatalf("规划检查没过要 409：%d %v", code, out)
	}
	// 退回了也一样，说的是退回
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"rejected","note":"大纲太散"}`, 200)
	if code, out := call(t, e.h, "POST", path+"/runners/web/run", `{}`); code != 409 || !strings.Contains(errMsg(out), "被退回了") {
		t.Fatalf("规划检查退回要 409：%d %v", code, out)
	}
	if got := mustCall(t, e.h, "GET", path, "", 200); got["last_run"] != nil {
		t.Fatalf("没跑起来不记执行：%v", got["last_run"])
	}

	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/web/run", `{}`, 202)
	lr := v["last_run"].(map[string]any)
	if lr["status"] != "running" || lr["stage"] != "web" || lr["type"] != "agent" || !strings.HasPrefix(lr["id"].(string), "run_") || lr["started_at"] == "" {
		t.Fatalf("发起后 last_run：%v", lr)
	}
	// 在跑的时候再点 409
	if code, out := call(t, e.h, "POST", path+"/runners/web/run", ""); code != 409 || !strings.Contains(errMsg(out), "正在跑") {
		t.Fatalf("在跑时再跑要 409：%d %v", code, out)
	}
	req := fc.last()
	if req.Workdir != root || !req.AllowWrites || !strings.Contains(req.Prompt, "web-video-presentation") || !strings.Contains(req.Prompt, "Phase 2.1") ||
		!strings.Contains(req.Prompt, "套 templates/ai100") || !strings.Contains(req.Prompt, "pc/") {
		t.Fatalf("交给 Claude Code 的请求：%+v", req)
	}
	close(fc.gate)
	v = waitRun(t, e, vid)
	lr = v["last_run"].(map[string]any)
	if lr["status"] != "done" || lr["ended_at"] == nil || lr["error"] != nil || len(lr["artifact_ids"].([]any)) != 2 {
		t.Fatalf("跑完 last_run：%v", lr)
	}
	// 检查点不动，阶段也不动
	if v["stage"] != "web" || cpState(v, "ch1")["state"] != "pending" {
		t.Fatalf("执行器不能动检查点：%v %v", v["stage"], cpState(v, "ch1"))
	}
	arts := artifactsOf(t, e, vid)
	if len(arts) != 2 {
		t.Fatalf("要登记横竖两份演示工程：%v", arts)
	}
	for i, o := range []string{"landscape", "portrait"} {
		a := arts[i]
		src := a["source"].(map[string]any)
		if a["kind"] != "presentation" || a["variant"] != o || a["status"] != "review" || a["version"] != 1.0 || a["name"] != "演示工程（第 1 章）" ||
			a["path"] != "presentation-"+o || src["type"] != "skill" || src["label"] != "网页演示做视频" || src["id"] != "sk_video" {
			t.Fatalf("产出物 %d：%v", i, a)
		}
	}

	// 再跑一次：已有的升版本，还是待验收
	fc.mu.Lock()
	fc.gate = nil
	fc.mu.Unlock()
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+arts[0]["id"].(string), `{"status":"final"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/web/run", "", 202)
	waitRun(t, e, vid)
	arts = artifactsOf(t, e, vid)
	if len(arts) != 2 || arts[0]["version"] != 2.0 || arts[0]["status"] != "review" || arts[1]["version"] != 2.0 {
		t.Fatalf("再跑要升版本：%v", arts)
	}
}

// 验收 3：运行失败 last_run 记失败和原因，检查点不动，不登记产出物
func TestRunFailedKeepsCheckpoints(t *testing.T) {
	e := setup(t)
	fc := &fakeClaude{fail: "预览端口 7801 被占用，演示工程起不来"}
	e.r.SetClaudeRunner(fc)
	vid, _ := runnerVideo(t, e)
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	before := mustCall(t, e.h, "GET", path, "", 200)
	mustCall(t, e.h, "PUT", path+"/runners/web", `{"type":"skill","ref_id":"sk_video"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/web/run", "", 202)
	v := waitRun(t, e, vid)
	lr := v["last_run"].(map[string]any)
	if lr["status"] != "failed" || lr["error"] != "预览端口 7801 被占用，演示工程起不来" || lr["ended_at"] == nil || lr["artifact_ids"] != nil {
		t.Fatalf("失败的 last_run：%v", lr)
	}
	for _, k := range CheckpointStages {
		if a, b := cpState(before, k), cpState(v, k); a["state"] != b["state"] || a["at"] != b["at"] {
			t.Fatalf("检查点 %s 被动了：%v -> %v", k, a, b)
		}
	}
	if v["stage"] != "web" || len(artifactsOf(t, e, vid)) != 0 {
		t.Fatalf("失败不登记产出物：%v", artifactsOf(t, e, vid))
	}
	// 失败后能重试
	fc.mu.Lock()
	fc.fail = ""
	fc.mu.Unlock()
	mustCall(t, e.h, "POST", path+"/runners/web/run", "", 202)
	if lr := waitRun(t, e, vid)["last_run"].(map[string]any); lr["status"] != "done" {
		t.Fatalf("重试：%v", lr)
	}
}

// 发起时就失败的（工程目录是相对路径又没挂项目、没定比例）记一条失败的执行，回 200
func TestRunStartFailure(t *testing.T) {
	e := setup(t)
	e.r.SetClaudeRunner(&fakeClaude{})
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"单集","root":"videos/ep01"}`, 201)
	vid := v["id"].(string)
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "PUT", path+"/runners/script", `{"type":"skill","ref_id":"sk_video"}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/script/run", "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || lr["error"] != "还没定画面比例，先在规划检查里选好" || lr["id"] != "" {
		t.Fatalf("没定比例：%v", lr)
	}
	mustCall(t, e.h, "PATCH", path, `{"orientations":["portrait"]}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/script/run", "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || !strings.Contains(lr["error"].(string), "是相对路径") {
		t.Fatalf("相对路径没挂项目：%v", lr)
	}
	// 挂上有工作区目录的项目，接在后面
	ws := t.TempDir()
	addProject(t, e.d, "obj_pj")
	if _, err := e.d.W.Exec(`UPDATE objects SET workdir = ? WHERE id = 'obj_pj'`, ws); err != nil {
		t.Fatal(err)
	}
	mustCall(t, e.h, "PATCH", path, `{"project_id":"obj_pj","root":"."}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/script/run", "", 202)
	v = waitRun(t, e, vid)
	if lr := v["last_run"].(map[string]any); lr["status"] != "done" || len(lr["artifact_ids"].([]any)) != 2 {
		t.Fatalf("接在项目目录后面：%v", lr)
	}
	arts := artifactsOf(t, e, vid)
	if len(arts) != 2 || arts[0]["kind"] != "script" || arts[0]["variant"] != "portrait" || arts[1]["kind"] != "outline" || arts[0]["path"] != "script-portrait.md" {
		t.Fatalf("内容编写的产出物：%v", arts)
	}
	mustCall(t, e.h, "PATCH", path, `{"root":"../outside"}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/script/run", "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || !strings.Contains(lr["error"].(string), "越出了") {
		t.Fatalf("越出项目目录：%v", lr)
	}
}

// Agent 执行器：产出物来源记 Agent 和会话；Agent 跑失败记失败
func TestRunAgentRunner(t *testing.T) {
	e := setup(t)
	e.r.SetAgent(fakeAgent{})
	vid, _ := runnerVideo(t, e)
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	mustCall(t, e.h, "POST", path+"/advance", `{"from":"web"}`, 200)
	mustCall(t, e.h, "POST", path+"/checkpoints/ch1", `{"state":"passed"}`, 200)
	mustCall(t, e.h, "PUT", path+"/runners/chapters", `{"type":"agent","ref_id":"nobody"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/chapters/run", "", 202)
	if lr := waitRun(t, e, vid)["last_run"].(map[string]any); lr["status"] != "failed" || lr["error"] != "Agent 不存在" {
		t.Fatalf("Agent 失败：%v", lr)
	}
	mustCall(t, e.h, "PUT", path+"/runners/chapters", `{"type":"agent","ref_id":"视频助手"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/chapters/run", "", 202)
	v := waitRun(t, e, vid)
	if lr := v["last_run"].(map[string]any); lr["status"] != "done" || lr["ref"] != "ags_video1" || lr["type"] != "agent" {
		t.Fatalf("Agent 跑完：%v", lr)
	}
	arts := artifactsOf(t, e, vid)
	if len(arts) != 2 {
		t.Fatalf("其余章节登记演示工程：%v", arts)
	}
	if src := arts[0]["source"].(map[string]any); src["type"] != "agent" || src["session_id"] != "ags_video1" || src["label"] != "视频助手" || arts[0]["name"] != "演示工程" {
		t.Fatalf("Agent 产出物：%v", arts[0])
	}
	// SOP 插件没装：发起时就失败
	mustCall(t, e.h, "PUT", path+"/runners/chapters", `{"type":"sop","ref_id":"视频周更"}`, 200)
	v = mustCall(t, e.h, "POST", path+"/runners/chapters/run", "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || lr["error"] != "SOP 插件没启用，SOP 执行器跑不了" {
		t.Fatalf("没有 SOP 插件：%v", lr)
	}
}

// 配执行器的校验、只能跑当前阶段、没配执行器 409、删执行器
func TestRunnerConfig(t *testing.T) {
	e := setup(t)
	vid, _ := runnerVideo(t, e)
	path := "/api/video/videos/" + vid
	for _, c := range []struct{ stage, body, want string }{
		{"plan", `{"type":"skill","ref_id":"sk_video"}`, "「规划检查」只有人能做，不能配执行器"},
		{"ch1", `{"type":"skill","ref_id":"sk_video"}`, "「第一章验收」只有人能做，不能配执行器"},
		{"nope", `{"type":"skill","ref_id":"sk_video"}`, "没有 nope 这个阶段"},
		{"web", `{"type":"robot","ref_id":"x"}`, ""},
		{"web", `{"ref_id":"x"}`, "type 必填，只能是 skill、sop、agent"},
		{"web", `{"type":"agent"}`, "要选一个Agent"},
		{"web", `{"type":"skill","ref_id":"sk_other"}`, ""},
		{"web", `{"type":"skill","ref_id":"sk_video","extra":1}`, "不认识的字段 extra"},
	} {
		code, out := call(t, e.h, "PUT", path+"/runners/"+c.stage, c.body)
		if code != 400 || (c.want != "" && errMsg(out) != c.want) {
			t.Fatalf("PUT %s %s：要 400 %q，实际 %d %v", c.stage, c.body, c.want, code, out)
		}
	}
	if code, _ := call(t, e.h, "PUT", "/api/video/videos/vd_nope/runners/web", `{"type":"skill","ref_id":"sk_video"}`); code != 404 {
		t.Fatalf("视频不存在要 404：%d", code)
	}
	// 当前在规划检查，script 已经过了
	mustCall(t, e.h, "PUT", path+"/runners/script", `{"type":"skill","ref_id":"sk_video"}`, 200)
	v := mustCall(t, e.h, "PUT", path+"/runners/record", `{"type":"sop","ref_id":"spf_render"}`, 200)
	if rs := v["runners"].([]any); len(rs) != 2 || rs[0].(map[string]any)["stage"] != "script" || rs[1].(map[string]any)["stage"] != "record" {
		t.Fatalf("执行器按阶段排：%v", rs)
	}
	if code, out := call(t, e.h, "POST", path+"/runners/script/run", ""); code != 409 || errMsg(out) != "视频已经过了「内容编写」，现在在「规划检查」，只能跑当前阶段" {
		t.Fatalf("过了的阶段：%d %v", code, out)
	}
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	if code, out := call(t, e.h, "POST", path+"/runners/record/run", ""); code != 409 || errMsg(out) != "「第一章验收」还没通过，不能开始「录屏渲染」" {
		t.Fatalf("前面的检查点没过：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", path+"/runners/web/run", ""); code != 409 || errMsg(out) != "「网页开发」还没配执行器，先配一个再跑" {
		t.Fatalf("没配执行器：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", path+"/runners/plan/run", ""); code != 400 {
		t.Fatalf("检查点阶段不能跑：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", path+"/runners/web/run", `{"stage":"web"}`); code != 400 {
		t.Fatalf("运行不收字段：%d %v", code, out)
	}
	v = mustCall(t, e.h, "DELETE", path+"/runners/record", "", 200)
	if rs := v["runners"].([]any); len(rs) != 1 {
		t.Fatalf("删执行器：%v", rs)
	}
	mustCall(t, e.h, "DELETE", path+"/runners/record", "", 200)
	// 删视频，执行器和执行记录跟着删
	mustCall(t, e.h, "DELETE", path, "", 200)
	var n int
	if err := e.d.R.QueryRow(`SELECT (SELECT count(*) FROM video_runners) + (SELECT count(*) FROM video_runs)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("删视频后还剩 %d 行 %v", n, err)
	}
}

// 服务重启过：内核查不到运行，读视频时记失败；发起到一半没拿到运行 id 的，过一分钟算失败
func TestRunReconcileAfterRestart(t *testing.T) {
	e := setup(t)
	vid, _ := runnerVideo(t, e)
	old := time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339)
	if _, err := e.d.W.Exec(`INSERT INTO video_runs (video_id, stage, type, runner_type, ref_id, run_id, started_at) VALUES (?, 'plan', 'agent', 'skill', 'sk_video', 'run_gone', ?)`, vid, old); err != nil {
		t.Fatal(err)
	}
	v := mustCall(t, e.h, "GET", "/api/video/videos/"+vid, "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || !strings.Contains(lr["error"].(string), "工作台重启过") || lr["id"] != "run_gone" {
		t.Fatalf("重启后：%v", lr)
	}
	if _, err := e.d.W.Exec(`INSERT INTO video_runs (video_id, stage, type, runner_type, ref_id, started_at) VALUES (?, 'plan', 'agent', 'skill', 'sk_video', ?)`, vid, old); err != nil {
		t.Fatal(err)
	}
	code, out := call(t, e.h, "GET", "/api/video/videos", "")
	if lr := out["data"].([]any)[0].(map[string]any)["last_run"].(map[string]any); code != 200 || lr["status"] != "failed" || !strings.Contains(lr["error"].(string), "中断") {
		t.Fatalf("发起到一半：%d %v", code, lr)
	}
}

// 不读视频也能收尾：run.finished 投过来就把执行记成结束、登记产出物
func TestRunFinishedEvent(t *testing.T) {
	e := setup(t)
	e.r.SetClaudeRunner(&fakeClaude{})
	vid, _ := runnerVideo(t, e)
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	mustCall(t, e.h, "PUT", path+"/runners/web", `{"type":"skill","ref_id":"sk_video"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/web/run", "", 202)
	if !e.r.WaitRuns(10 * time.Second) {
		t.Fatal("等不到运行结束")
	}
	var status, arts string
	if err := e.d.R.QueryRow(`SELECT status, artifact_ids FROM video_runs WHERE video_id = ?`, vid).Scan(&status, &arts); err != nil || status != "done" || strings.Count(arts, "vaf_") != 2 {
		t.Fatalf("run.finished 收尾：%s %s %v", status, arts, err)
	}
}
