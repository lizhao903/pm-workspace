package sop

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	clauderun "github.com/lizhao903/pm-workspace/internal/runner"
)

// 流水线治理测试（AUTO-12）：Claude Code 并发上限排队、每需求次数 / 时长上限超了暂停并通知、放行后恢复、设置校验，
// 以及流水线视图和待我处理接口。

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

// twoClaudeFlow：两步 Claude Code，parallel 为真时并行，否则 b 接在 a 后面；都关联输入里的任务。
func twoClaudeFlow(parallel bool) string {
	after := `["a"]`
	if parallel {
		after = `[]`
	}
	return fmt.Sprintf(`{"name":"研发","fields":[{"key":"dir","label":"目录","type":"text"},{"key":"task_id","label":"任务","type":"text"}],"steps":[
		{"key":"a","name":"研发","kind":"claude_code","after":[],"config":{"workdir":"{{dir}}","prompt":"实现","task":"{{task_id}}"}},
		{"key":"b","name":"自测","kind":"claude_code","after":%s,"config":{"workdir":"{{dir}}","prompt":"自测","task":"{{task_id}}"}}
	]}`, after)
}

// TestClaudeConcurrencyLimit：同时跑的 Claude Code 步骤数到上限后，后来的排队（仍是 running，带 queue.slot），前一个跑完再发起。
func TestClaudeConcurrencyLimit(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	r.SetObjectCreator(&taskRuns{})
	if code, out := call(t, h, "PATCH", "/api/sop/settings", `{"claude_concurrency":1}`); code != 200 || out["data"].(map[string]any)["claude_concurrency"] != float64(1) {
		t.Fatalf("%d %v", code, out)
	}
	fid := newFlow(t, h, twoClaudeFlow(true))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q,"task_id":"obj_c1"}}`, wd))["id"].(string)
	recvRun(t, f)
	var queued map[string]any
	waitFor(t, "另一步排队等名额", func() bool {
		run := getRun(t, h, id)
		for _, k := range []string{"a", "b"} {
			s := step(run, k)
			if q, ok := s["queue"].(map[string]any); ok && q["slot"] == claudeKind && s["status"] == stRunning && hasLog(s, "排队等 Claude Code 名额") {
				queued = s
				return true
			}
		}
		return false
	})
	if queued["claude"] != nil {
		t.Fatalf("排队的步骤不该发起：%v", queued)
	}
	select {
	case id := <-f.started:
		t.Fatalf("名额只有 1 个，不该再发起 %s", id)
	case <-time.After(100 * time.Millisecond):
	}
	_, out := call(t, h, "GET", "/api/sop/settings", "")
	if s := out["data"].(map[string]any); s["claude_running"] != float64(1) || s["claude_queued"] != float64(1) {
		t.Fatalf("设置里的此刻 = %v", s)
	}
	f.results <- &clauderun.Result{Status: domain.RunDone}
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	waitStatus(t, h, id, "done")
	waitFor(t, "名额都还回来", func() bool {
		_, out := call(t, h, "GET", "/api/sop/settings", "")
		s := out["data"].(map[string]any)
		return s["claude_running"] == float64(0) && s["claude_queued"] == float64(0)
	})
}

// TestBudgetRunsHoldAndResume：每需求次数上限是 1，第一步跑完后第二步不发起、转 paused（执行转等人），记 hold、发通知、
// 出现在待我处理和流水线卡点里；点「继续」放行后发起、跑完；账本记了两次。
func TestBudgetRunsHoldAndResume(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	r.SetObjectCreator(&taskRuns{})
	n := &notes{}
	r.SetNotifier(n)
	if code, out := call(t, h, "PATCH", "/api/sop/settings", `{"task_max_claude_runs":1}`); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	fid := newFlow(t, h, twoClaudeFlow(false))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q,"task_id":"obj_b1"}}`, wd))["id"].(string)
	first := recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	run := waitStatus(t, h, id, "waiting")
	b := step(run, "b")
	hold, _ := b["hold"].(map[string]any)
	if b["status"] != stPaused || hold == nil || hold["kind"] != holdRuns || !strings.Contains(hold["reason"].(string), "到了上限 1 次") {
		t.Fatalf("第二步 = %v", b)
	}
	if b["attempts"] != float64(0) || b["claude"] != nil {
		t.Fatalf("暂停的这一步不该算一次尝试、不该发起：%v", b)
	}
	waitFor(t, "发通知", func() bool { return len(n.list()) == 1 })
	if x := n.list()[0]; x.Kind != "sop.budget_hold" || x.Level != plugin.NotifyError || x.ObjectID != "obj_b1" || !strings.Contains(x.Title, "超出上限") {
		t.Fatalf("通知 = %+v", x)
	}
	// 待我处理
	_, out := call(t, h, "GET", "/api/sop/waiting", "")
	items, _ := out["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("待我处理 = %v", out)
	}
	if it := items[0].(map[string]any); it["wait"] != waitHold || it["step_key"] != "b" || it["task_id"] != "obj_b1" || it["run_id"] != id {
		t.Fatalf("待我处理一条 = %v", it)
	}
	// 流水线
	_, out = call(t, h, "GET", "/api/sop/pipeline/obj_b1", "")
	p := out["data"].(map[string]any)
	if bl := p["blockers"].([]any); len(bl) != 1 || bl[0].(map[string]any)["wait"] != waitHold {
		t.Fatalf("卡点 = %v", p["blockers"])
	}
	if bu := p["budget"].(map[string]any); bu["claude_runs"] != float64(1) || bu["max_runs"] != float64(1) {
		t.Fatalf("预算 = %v", bu)
	}
	if c := p["claude"].([]any); len(c) != 1 || c[0].(map[string]any)["id"] != first || c[0].(map[string]any)["status"] != usageDone {
		t.Fatalf("账本 = %v", c)
	}
	// 放行
	if code, out := act(t, h, id, `{"kind":"confirm-input","step":"b"}`); code != 200 {
		t.Fatalf("继续 %d %s", code, errMsg(out))
	}
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	run = waitStatus(t, h, id, "done")
	b = step(run, "b")
	hold = b["hold"].(map[string]any)
	if hold["released"] != true || b["attempts"] != float64(1) || !hasLog(b, "已放行") {
		t.Fatalf("放行后 = %v", b)
	}
	_, out = call(t, h, "GET", "/api/sop/pipeline/obj_b1", "")
	p = out["data"].(map[string]any)
	if c := p["claude"].([]any); len(c) != 2 {
		t.Fatalf("账本 = %v", c)
	}
	if bl := p["blockers"].([]any); len(bl) != 0 {
		t.Fatalf("放行后不该还有卡点：%v", bl)
	}
	if rs := p["runs"].([]any); len(rs) != 1 || rs[0].(map[string]any)["id"] != id {
		t.Fatalf("执行 = %v", rs)
	}
}

// TestBudgetRetryCounts：重试也算一次；次数上限 2 时，失败重试一次后再失败、再重试就暂停。
func TestBudgetRetryCounts(t *testing.T) {
	r, h, f, wd := setupClaude(t)
	r.SetObjectCreator(&taskRuns{})
	call(t, h, "PATCH", "/api/sop/settings", `{"task_max_claude_runs":2}`)
	fid := newFlow(t, h, twoClaudeFlow(false))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q,"task_id":"obj_r1"}}`, wd))["id"].(string)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunFailed, ExitCode: 1, Error: "退出码 1"}
	waitStatus(t, h, id, "failed")
	act(t, h, id, `{"kind":"retry","step":"a"}`)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunFailed, ExitCode: 1, Error: "退出码 1"}
	waitStatus(t, h, id, "failed")
	if code, out := act(t, h, id, `{"kind":"retry","step":"a"}`); code != 200 {
		t.Fatalf("重试 %d %s", code, errMsg(out))
	}
	run := waitStatus(t, h, id, "waiting")
	if a := step(run, "a"); a["status"] != stPaused || a["hold"] == nil || a["attempts"] != float64(2) {
		t.Fatalf("第 3 次应当暂停：%v", a)
	}
	// 跳过也能解开
	if code, out := act(t, h, id, `{"kind":"skip","step":"a"}`); code != 200 {
		t.Fatalf("跳过 %d %s", code, errMsg(out))
	}
	// 下一步也是这个需求的，照样被拦
	run = waitStatus(t, h, id, "waiting")
	if b := step(run, "b"); b["status"] != stPaused || b["hold"] == nil {
		t.Fatalf("下一步 = %v", b)
	}
}

// TestBudgetDurationHold：每需求时长上限 1 分钟，账本里这个需求已经跑了 2 分钟，下一次发起前暂停；上限改成不限后放行照常跑。
func TestBudgetDurationHold(t *testing.T) {
	r, h, d := setupDB(t, New())
	f := newFakeClaude()
	r.SetClaudeRunner(f)
	r.SetObjectCreator(&taskRuns{})
	t.Cleanup(func() { r.WaitRuns(5 * time.Second) })
	wd := t.TempDir()
	start := time.Now().Add(-3 * time.Minute)
	if _, err := d.W.Exec(`INSERT INTO sop_claude_usage (id, run_id, step, attempt, task_id, budget_key, started_at, ended_at, status)
		VALUES ('run_old', 'spr_old', 'a', 1, 'obj_d1', 'obj_d1', ?, ?, 'done')`, ts(start), ts(start.Add(2*time.Minute))); err != nil {
		t.Fatal(err)
	}
	call(t, h, "PATCH", "/api/sop/settings", `{"task_max_claude_minutes":1}`)
	fid := newFlow(t, h, twoClaudeFlow(false))
	id := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q,"task_id":"obj_d1"}}`, wd))["id"].(string)
	run := waitStatus(t, h, id, "waiting")
	a := step(run, "a")
	hold, _ := a["hold"].(map[string]any)
	if hold == nil || hold["kind"] != holdDuration || !strings.Contains(hold["reason"].(string), "累计跑了 2 分钟") {
		t.Fatalf("时长超限 = %v", a)
	}
	// 另一个需求不受影响
	other := startRun(t, h, fid, fmt.Sprintf(`{"input":{"dir":%q,"task_id":"obj_d2"}}`, wd))["id"].(string)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	waitStatus(t, h, other, "done")
	// 调成不限后放行
	call(t, h, "PATCH", "/api/sop/settings", `{"task_max_claude_minutes":0}`)
	act(t, h, id, `{"kind":"confirm-input","step":"a"}`)
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	recvRun(t, f)
	f.results <- &clauderun.Result{Status: domain.RunDone}
	waitStatus(t, h, id, "done")
}

// TestGovernanceSettings：默认值、校验（不合法整个请求不改）、0 是不限、token 不支持。
func TestGovernanceSettings(t *testing.T) {
	_, h := setup(t, New())
	_, out := call(t, h, "GET", "/api/sop/settings", "")
	s := out["data"].(map[string]any)
	if s["claude_concurrency"] != float64(defaultClaudeConcurrency) || s["task_max_claude_runs"] != float64(defaultTaskMaxRuns) ||
		s["task_max_claude_minutes"] != float64(defaultTaskMaxMinutes) || s["token_limit_supported"] != false || s["model_concurrency"] != float64(2) {
		t.Fatalf("默认 = %v", s)
	}
	for _, body := range []string{`{"claude_concurrency":0}`, `{"claude_concurrency":11}`, `{"task_max_claude_runs":-1}`,
		`{"task_max_claude_minutes":"x"}`, `{"model_concurrency":3,"claude_concurrency":99}`} {
		if code, out := call(t, h, "PATCH", "/api/sop/settings", body); code != 400 || !strings.Contains(errMsg(out), "的整数") {
			t.Fatalf("%s → %d %v", body, code, out)
		}
	}
	_, out = call(t, h, "GET", "/api/sop/settings", "")
	if s := out["data"].(map[string]any); s["model_concurrency"] != float64(2) {
		t.Fatalf("不合法的请求不该改任何一项：%v", s)
	}
	code, out := call(t, h, "PATCH", "/api/sop/settings", `{"claude_concurrency":5,"task_max_claude_runs":0,"task_max_claude_minutes":60}`)
	s = out["data"].(map[string]any)
	if code != 200 || s["claude_concurrency"] != float64(5) || s["task_max_claude_runs"] != float64(0) || s["task_max_claude_minutes"] != float64(60) {
		t.Fatalf("%d %v", code, s)
	}
}

// TestPipelineFindsRuns：关联对象、输入 task_id、步骤输出 task.id 都能把执行算到需求上，子执行跟着父执行；人工判断在待我处理里带分支。
func TestPipelineFindsRuns(t *testing.T) {
	_, h := setup(t, New())
	child := newFlow(t, h, `{"name":"子","fields":[{"key":"x","label":"X","type":"text"}],"steps":[
		{"key":"ok","name":"看一眼","kind":"review","after":[]}]}`)
	parent := newFlow(t, h, fmt.Sprintf(`{"name":"受理","fields":[{"key":"m","label":"消息","type":"text"}],"steps":[
		{"key":"to_task","name":"转任务","kind":"template","after":[],"config":{"template":"obj_p1","output":"tid"}},
		{"key":"wrap","name":"包一层","kind":"aggregate","after":["to_task"]},
		{"key":"pick","name":"选","kind":"decide","after":["wrap"],"cases":[{"key":"y","label":"要"},{"key":"n","label":"不要"}]},
		{"key":"sub","name":"子流程","kind":"subflow","after":["pick"],"branch":{"of":"pick","case":"y"},"config":{"sop":%q}}
	]}`, child))
	// 输入里带 task_id 的
	id1 := startRun(t, h, parent, `{"input":{"m":"hi","task_id":"obj_p1"}}`)["id"].(string)
	waitStatus(t, h, id1, "waiting")
	// 无关的
	id2 := startRun(t, h, parent, `{"input":{"m":"别的","task_id":"obj_other"}}`)["id"].(string)
	waitStatus(t, h, id2, "waiting")
	_, out := call(t, h, "GET", "/api/sop/waiting", "")
	items := out["data"].([]any)
	if len(items) != 2 {
		t.Fatalf("待我处理 = %v", items)
	}
	it := items[1].(map[string]any)
	if it["wait"] != waitDecide || len(it["cases"].([]any)) != 2 {
		t.Fatalf("人工判断 = %v", it)
	}
	act(t, h, id1, `{"kind":"route","step":"pick","route":"y"}`)
	waitFor(t, "子执行起来", func() bool {
		_, out := call(t, h, "GET", "/api/sop/pipeline/obj_p1", "")
		return len(out["data"].(map[string]any)["runs"].([]any)) == 2
	})
	_, out = call(t, h, "GET", "/api/sop/pipeline/obj_p1", "")
	p := out["data"].(map[string]any)
	rs := p["runs"].([]any)
	if rs[0].(map[string]any)["id"] != id1 || rs[1].(map[string]any)["parent_run_id"] != id1 {
		t.Fatalf("执行 = %v", rs)
	}
	bl := p["blockers"].([]any)
	if len(bl) != 1 || bl[0].(map[string]any)["wait"] != waitReview || bl[0].(map[string]any)["task_id"] != "obj_p1" {
		t.Fatalf("卡点 = %v", bl)
	}
	_, out = call(t, h, "GET", "/api/sop/waiting", "")
	found := false
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		if m["step_key"] == "ok" {
			found = m["task_id"] == "obj_p1"
		}
	}
	if !found {
		t.Fatalf("子执行的等人步骤要沿父执行算到需求上：%v", out["data"])
	}
	_, out = call(t, h, "GET", "/api/sop/pipeline/obj_none", "")
	if p := out["data"].(map[string]any); len(p["runs"].([]any)) != 0 || len(p["blockers"].([]any)) != 0 {
		t.Fatalf("没有执行的需求 = %v", p)
	}
}
