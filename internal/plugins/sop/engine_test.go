// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 引擎测试（SOP-01b）：并行和汇合、分支、人工检查点、断点续跑、快照、今日卡片。

// gate 卡住指定步骤的执行：进来时记一下，等 release 或 ctx 取消才放行。
type gate struct {
	mu      sync.Mutex
	block   map[string]bool
	entered map[string]int
	release chan struct{}
}

func newGate(keys ...string) *gate {
	g := &gate{block: map[string]bool{}, entered: map[string]int{}, release: make(chan struct{})}
	for _, k := range keys {
		g.block[k] = true
	}
	return g
}

func (g *gate) hook(ctx context.Context, _, step string) error {
	g.mu.Lock()
	g.entered[step]++
	blocked := g.block[step]
	g.mu.Unlock()
	if !blocked {
		return nil
	}
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *gate) count(step string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.entered[step]
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("等了 5 秒还没有：%s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newFlow(t *testing.T, h http.Handler, body string) string {
	t.Helper()
	code, out := call(t, h, "POST", "/api/sop/flows", body)
	if code != 201 {
		t.Fatalf("建流程 %d %s", code, errMsg(out))
	}
	return out["data"].(map[string]any)["id"].(string)
}

func startRun(t *testing.T, h http.Handler, flowID, body string) map[string]any {
	t.Helper()
	code, out := call(t, h, "POST", "/api/sop/flows/"+flowID+"/runs", body)
	if code != 201 {
		t.Fatalf("发起执行 %d %s", code, errMsg(out))
	}
	return out["data"].(map[string]any)
}

func getRun(t *testing.T, h http.Handler, id string) map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/runs/"+id, "")
	if code != 200 {
		t.Fatalf("取执行 %d %s", code, errMsg(out))
	}
	return out["data"].(map[string]any)
}

func step(run map[string]any, key string) map[string]any {
	for _, s := range run["steps"].([]any) {
		if m := s.(map[string]any); m["key"] == key {
			return m
		}
	}
	return nil
}

func waitStatus(t *testing.T, h http.Handler, id, status string) map[string]any {
	t.Helper()
	var run map[string]any
	waitFor(t, "执行 "+id+" 变成 "+status, func() bool {
		run = getRun(t, h, id)
		return run["status"] == status
	})
	return run
}

func act(t *testing.T, h http.Handler, id, body string) (int, map[string]any) {
	t.Helper()
	return call(t, h, "POST", "/api/sop/runs/"+id+"/actions", body)
}

func hasLog(s map[string]any, text string) bool {
	for _, l := range s["log"].([]any) {
		if strings.Contains(l.(map[string]any)["text"].(string), text) {
			return true
		}
	}
	return false
}

func TestParallelThenJoin(t *testing.T) {
	g := newGate("b", "c")
	p := New()
	p.stepHook = g.hook
	_, h := setup(t, p)
	id := newFlow(t, h, `{"name":"并行","fields":[{"key":"who","label":"谁","type":"text","default":"周屿"}],"steps":[
		{"key":"a","name":"起草","kind":"template","after":[],"config":{"template":"你好 {{who}}","output":"text"}},
		{"key":"b","name":"左路","kind":"template","after":["a"],"config":{"template":"左：{{text}}","output":"left"}},
		{"key":"c","name":"右路","kind":"template","after":["a"],"config":{"template":"右：{{text}}","output":"right"}},
		{"key":"j","name":"汇总","kind":"aggregate","after":["b","c"],"config":{"mode":"merge"}},
		{"key":"e","name":"结束","kind":"end","config":{"outputs":"left, right"}}]}`)
	run := startRun(t, h, id, `{}`)
	rid := run["id"].(string)
	if !strings.HasPrefix(rid, "spr_") || run["title"] != "并行 · 周屿" {
		t.Fatalf("id=%v title=%v", rid, run["title"])
	}
	// 两路都进了执行、都还没出结果：同时在跑
	waitFor(t, "两路都开跑", func() bool { return g.count("b") == 1 && g.count("c") == 1 })
	var got map[string]any
	waitFor(t, "两路在库里都是 running", func() bool {
		got = getRun(t, h, rid)
		return step(got, "b")["status"] == "running" && step(got, "c")["status"] == "running"
	})
	if step(got, "j")["status"] != "pending" || g.count("j") != 0 {
		t.Fatalf("聚合不能在两路结束前开始：%v", step(got, "j")["status"])
	}
	close(g.release)
	got = waitStatus(t, h, rid, "done")
	j := step(got, "j")
	in := j["input"].(map[string]any)
	if _, ok := in["b"]; !ok || len(in) != 2 {
		t.Fatalf("汇合的输入应当按上游 key 分组：%v", in)
	}
	end := step(got, "e")["output"].(map[string]any)
	if end["left"] != "左：你好 周屿" || end["right"] != "右：你好 周屿" || len(end) != 2 {
		t.Fatalf("结束节点输出 %v", end)
	}
	if got["ended_at"] == nil {
		t.Fatal("全部结束要写 ended_at")
	}
}

func TestBranchRuleAndManualRoute(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"分支","fields":[{"key":"kind","label":"类型","type":"text"}],"steps":[
		{"key":"d","name":"规则判断","kind":"decide","after":[],"rule":"kind 等于 bug","cases":[{"key":"yes","label":"是缺陷"},{"key":"no","label":"不是"}]},
		{"key":"x","name":"建缺陷单","kind":"auto","after":["d"],"branch":{"of":"d","case":"yes"}},
		{"key":"y","name":"记需求","kind":"auto","after":["d"],"branch":{"of":"d","case":"no"}},
		{"key":"m","name":"人工判断","kind":"decide","after":["x","y"],"cases":[{"key":"new","label":"新建"},{"key":"merge","label":"合并"}]},
		{"key":"n","name":"新建","kind":"auto","after":["m"],"branch":{"of":"m","case":"new"}},
		{"key":"g","name":"合并","kind":"review","after":["m"],"branch":{"of":"m","case":"merge"}},
		{"key":"z","name":"收尾","kind":"auto","after":["n","g"]}]}`)
	rid := startRun(t, h, id, `{"input":{"kind":"bug"}}`)["id"].(string)
	run := waitStatus(t, h, rid, "waiting")
	d := step(run, "d")
	if d["route"] != "yes" || !hasLog(d, "判断结果：走「是缺陷」") {
		t.Fatalf("规则判断 route=%v log=%v", d["route"], d["log"])
	}
	if step(run, "x")["status"] != "done" || step(run, "y")["status"] != "bypassed" {
		t.Fatalf("x=%v y=%v", step(run, "x")["status"], step(run, "y")["status"])
	}
	m := step(run, "m")
	if m["status"] != "review" || !hasLog(m, "等待人工判断走哪个分支") {
		t.Fatalf("人工判断应当停在 review：%v", m["status"])
	}
	// 只有一路走到：输入就是那一路的输出
	if m["input"].(map[string]any)["kind"] != "bug" {
		t.Fatalf("人工判断的输入 %v", m["input"])
	}
	if code, out := act(t, h, rid, `{"kind":"route","step":"m","route":"maybe"}`); code != 400 {
		t.Fatalf("不存在的分支应当 400，实际 %d %s", code, errMsg(out))
	}
	if code, _ := act(t, h, rid, `{"kind":"approve","step":"m"}`); code != 409 {
		t.Fatalf("判断步骤不能放行，实际 %d", code)
	}
	code, out := act(t, h, rid, `{"kind":"route","step":3,"route":"new"}`)
	if code != 200 {
		t.Fatalf("选分支 %d %s", code, errMsg(out))
	}
	run = waitStatus(t, h, rid, "done")
	m = step(run, "m")
	if m["route"] != "new" || m["route_reason"] != "人工判断" || m["edited"] != "route" {
		t.Fatalf("人工判断 %v %v %v", m["route"], m["route_reason"], m["edited"])
	}
	if step(run, "n")["status"] != "done" || step(run, "g")["status"] != "bypassed" || step(run, "z")["status"] != "done" {
		t.Fatalf("n=%v g=%v z=%v", step(run, "n")["status"], step(run, "g")["status"], step(run, "z")["status"])
	}

	// 规则不成立走第二个分支
	rid = startRun(t, h, id, `{"input":{"kind":"feature"}}`)["id"].(string)
	run = waitStatus(t, h, rid, "waiting")
	if step(run, "d")["route"] != "no" || step(run, "x")["status"] != "bypassed" || step(run, "y")["status"] != "done" {
		t.Fatalf("规则不成立：route=%v x=%v y=%v", step(run, "d")["route"], step(run, "x")["status"], step(run, "y")["status"])
	}
}

func TestReviewApproveWithEditedOutput(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"检查","steps":[
		{"key":"draft","name":"起草","kind":"template","after":[],"config":{"template":"初稿","output":"text"}},
		{"key":"check","name":"检查回复","kind":"review"},
		{"key":"send","name":"发出","kind":"auto"}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	run := waitStatus(t, h, rid, "waiting")
	c := step(run, "check")
	if c["status"] != "review" || c["output"].(map[string]any)["text"] != "初稿" || !hasLog(c, "已就绪，等待人工检查") {
		t.Fatalf("人工检查 %v %v", c["status"], c["output"])
	}
	if step(run, "send")["status"] != "pending" {
		t.Fatal("放行前下游不能开始")
	}
	code, out := act(t, h, rid, `{"kind":"approve","step":"check","output":{"text":"改过的稿"}}`)
	if code != 200 {
		t.Fatalf("放行 %d %s", code, errMsg(out))
	}
	if s := step(out["data"].(map[string]any), "check"); s["status"] != "done" || s["edited"] != "output" {
		t.Fatalf("放行后 %v edited=%v", s["status"], s["edited"])
	}
	run = waitStatus(t, h, rid, "done")
	if c = step(run, "check"); c["edited"] != "output" || !hasLog(c, "输出已修改并放行") {
		t.Fatalf("edited=%v", c["edited"])
	}
	if in := step(run, "send")["input"].(map[string]any); in["text"] != "改过的稿" {
		t.Fatalf("下游拿到的应当是改过的输出：%v", in)
	}
	// 结束了再操作 409
	if code, _ := act(t, h, rid, `{"kind":"stop"}`); code != 409 {
		t.Fatalf("结束后终止应当 409，实际 %d", code)
	}
}

func TestReworkRetrySkipStepThroughStop(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"动作","steps":[
		{"key":"a","name":"整理","kind":"template","after":[],"config":{"template":"x","output":"t"}},
		{"key":"r","name":"检查","kind":"review"},
		{"key":"ai","name":"AI 起草","kind":"ai"},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	waitStatus(t, h, rid, "waiting")
	if code, out := act(t, h, rid, `{"kind":"rework","step":"r"}`); code != 200 {
		t.Fatalf("退回 %d %s", code, errMsg(out))
	}
	run := waitStatus(t, h, rid, "waiting")
	if a := step(run, "a"); a["attempts"] != float64(2) || !hasLog(a, "被下游退回，重新执行") {
		t.Fatalf("上游重跑 attempts=%v", a["attempts"])
	}
	if code, _ := act(t, h, rid, `{"kind":"approve","step":"r"}`); code != 200 {
		t.Fatal("放行")
	}
	// 没接模型时 AI 节点失败
	run = waitStatus(t, h, rid, "failed")
	if s := step(run, "ai"); s["error"] != "调模型失败："+plugin.ErrNoAgent.Error() {
		t.Fatalf("ai error=%v", s["error"])
	}
	if code, _ := act(t, h, rid, `{"kind":"retry","step":"ai"}`); code != 200 {
		t.Fatal("重试")
	}
	run = waitStatus(t, h, rid, "failed")
	if s := step(run, "ai"); s["attempts"] != float64(2) || !hasLog(s, "第 2 次尝试") {
		t.Fatalf("重试后 attempts=%v", s["attempts"])
	}
	if code, _ := act(t, h, rid, `{"kind":"skip","step":"ai"}`); code != 200 {
		t.Fatal("跳过")
	}
	run = waitStatus(t, h, rid, "done")
	if s := step(run, "ai"); s["status"] != "skipped" {
		t.Fatalf("跳过后 %v", s["status"])
	}

	// 逐步确认：执行前停在 paused，改了输入再跑；中途关掉逐步确认；终止
	rid = startRun(t, h, id, `{"step_through":true}`)["id"].(string)
	run = waitStatus(t, h, rid, "waiting")
	if s := step(run, "a"); s["status"] != "paused" {
		t.Fatalf("逐步确认应当停在 paused：%v", s["status"])
	}
	if code, _ := act(t, h, rid, `{"kind":"confirm-input","step":0,"input":{"who":"人改的"}}`); code != 200 {
		t.Fatal("确认输入")
	}
	run = waitStatus(t, h, rid, "waiting")
	if s := step(run, "a"); s["edited"] != "input" || s["status"] != "done" {
		t.Fatalf("改输入 edited=%v status=%v", s["edited"], s["status"])
	}
	if s := step(run, "r"); s["status"] != "paused" {
		t.Fatalf("下一步也要停在 paused：%v", s["status"])
	}
	if code, _ := act(t, h, rid, `{"kind":"step-through","on":false}`); code != 200 {
		t.Fatal("关逐步确认")
	}
	if code, _ := act(t, h, rid, `{"kind":"stop"}`); code != 200 {
		t.Fatal("终止")
	}
	run = getRun(t, h, rid)
	if run["status"] != "stopped" || run["step_through"] != false || step(run, "r")["status"] != "pending" || !hasLog(step(run, "r"), "执行被终止") {
		t.Fatalf("终止后 status=%v step_through=%v r=%v", run["status"], run["step_through"], step(run, "r")["status"])
	}
}

// 运行到一半关掉引擎，用同一个库重新起，执行接着跑，执行中的那步 attempts 加 1
func TestResumeAfterRestart(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	boot := func(p *Plugin) (*plugin.Registry, http.Handler) {
		r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
		r.Migrations = plugin.NewSQLMigrationStore(d)
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
		if err := r.Start(ctx); err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
			mux.HandleFunc(rt.Pattern, rt.Handler)
		}
		return r, mux
	}

	g := newGate("slow")
	p1 := New()
	p1.stepHook = g.hook
	r1, h1 := boot(p1)
	if err := r1.Install(ctx, "sop", sopPerms); err != nil {
		t.Fatal(err)
	}
	if err := r1.Enable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	id := newFlow(t, h1, `{"name":"续跑","steps":[
		{"key":"a","name":"整理","kind":"template","after":[],"config":{"template":"x","output":"t"}},
		{"key":"slow","name":"慢的一步","kind":"template","config":{"template":"y","output":"u"}},
		{"key":"w","name":"等一会","kind":"wait","after":[],"config":{"duration":"600ms"}},
		{"key":"chk","name":"人工检查","kind":"review","after":[]},
		{"key":"z","name":"收尾","kind":"auto","after":["slow","w"]}]}`)
	rid := startRun(t, h1, id, `{}`)["id"].(string)
	waitFor(t, "慢的一步开跑", func() bool { return g.count("slow") == 1 })
	var before map[string]any
	waitFor(t, "人工检查停下", func() bool {
		before = getRun(t, h1, rid)
		return step(before, "chk")["status"] == "review" && step(before, "slow")["status"] == "running"
	})
	wake := step(before, "w")["wake_at"]
	if step(before, "slow")["attempts"] != float64(1) || wake == nil {
		t.Fatalf("关之前 slow attempts=%v wake_at=%v", step(before, "slow")["attempts"], wake)
	}
	r1.Close()
	// 关掉后库里那一步还是 running
	var st string
	var attempts int
	if err := d.R.QueryRowContext(ctx, `SELECT status, attempts FROM sop_run_steps WHERE run_id = ? AND step_key = 'slow'`, rid).Scan(&st, &attempts); err != nil {
		t.Fatal(err)
	}
	if st != "running" || attempts != 1 {
		t.Fatalf("关掉后 slow=%s attempts=%d", st, attempts)
	}

	r2, h2 := boot(New())
	defer r2.Close()
	var got map[string]any
	waitFor(t, "重启后跑完", func() bool {
		got = getRun(t, h2, rid)
		return step(got, "z")["status"] == "done"
	})
	s := step(got, "slow")
	if s["attempts"] != float64(2) || !hasLog(s, "服务重启后重跑") {
		t.Fatalf("执行中的那步应当重跑一次：attempts=%v log=%v", s["attempts"], s["log"])
	}
	w := step(got, "w")
	if w["attempts"] != float64(1) || w["wake_at"] != wake || !hasLog(w, "服务重启后继续等待") {
		t.Fatalf("等待节点按原到点时间继续：attempts=%v wake_at=%v→%v", w["attempts"], wake, w["wake_at"])
	}
	if c := step(got, "chk"); c["status"] != "review" || c["attempts"] != float64(1) {
		t.Fatalf("review 原样等人：%v attempts=%v", c["status"], c["attempts"])
	}
	if got["status"] != "waiting" {
		t.Fatalf("还有人工检查没放行，应当 waiting：%v", got["status"])
	}
	if code, _ := act(t, h2, rid, `{"kind":"approve","step":"chk"}`); code != 200 {
		t.Fatal("重启后放行")
	}
	waitStatus(t, h2, rid, "done")
}

// 改了流程定义后，进行中的执行仍按开始时的快照走完；有进行中的执行时不能删流程
func TestRunKeepsSnapshot(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"快照","steps":[
		{"key":"a","name":"整理","kind":"auto","after":[]},
		{"key":"r","name":"检查","kind":"review"},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	rid := startRun(t, h, id, `{"input":{"x":1}}`)["id"].(string)
	waitStatus(t, h, rid, "waiting")
	code, out := call(t, h, "PATCH", "/api/sop/flows/"+id, `{"steps":[{"key":"only","name":"新的唯一一步","kind":"ai","after":[]}]}`)
	if code != 200 {
		t.Fatalf("改流程 %d %s", code, errMsg(out))
	}
	if code, out := call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 409 || !strings.Contains(errMsg(out), "1 个进行中的执行") {
		t.Fatalf("有进行中的执行时删除应当 409：%d %s", code, errMsg(out))
	}
	if code, _ := act(t, h, rid, `{"kind":"approve","step":"r"}`); code != 200 {
		t.Fatal("放行")
	}
	run := waitStatus(t, h, rid, "done")
	if n := len(run["steps"].([]any)); n != 3 || step(run, "z")["status"] != "done" {
		t.Fatalf("应当按快照的 3 步走完：%d 步", n)
	}
	snap := run["flow"].(map[string]any)
	if run["flow_version"] != float64(1) || snap["version"] != float64(1) || len(snap["steps"].([]any)) != 3 {
		t.Fatalf("快照 flow_version=%v", run["flow_version"])
	}
	// 新发起的用新定义
	rid2 := startRun(t, h, id, `{}`)["id"].(string)
	run = waitStatus(t, h, rid2, "failed")
	if run["flow_version"] != float64(2) || step(run, "only") == nil {
		t.Fatalf("新执行应当用第 2 版：%v", run["flow_version"])
	}
	if code, _ := act(t, h, rid2, `{"kind":"stop"}`); code != 200 {
		t.Fatal("终止")
	}
	if code, _ := call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 200 {
		t.Fatalf("执行都结束后能删，实际 %d", code)
	}
	// 流程删了执行记录照留
	if got := getRun(t, h, rid); got["flow_name"] != "快照" {
		t.Fatalf("删流程后执行记录 flow_name=%v", got["flow_name"])
	}
}

func TestListFiltersAndTodayCard(t *testing.T) {
	r, h := setup(t, New())
	ctx := context.Background()
	cards := func() []plugin.TodayCard {
		var out []plugin.TodayCard
		for _, c := range r.TodayCards(ctx) {
			if c.Key == "sop_pending" {
				out = append(out, c)
			}
		}
		return out
	}
	if cs := cards(); len(cs) != 0 {
		t.Fatalf("没有等人的执行时不出卡片：%v", cs)
	}
	a := newFlow(t, h, `{"name":"甲","steps":[{"key":"r","name":"检查","kind":"review","after":[]}]}`)
	b := newFlow(t, h, `{"name":"乙","steps":[{"key":"x","name":"自动","kind":"auto","after":[]}]}`)
	ra := startRun(t, h, a, `{}`)["id"].(string)
	rb := startRun(t, h, b, `{}`)["id"].(string)
	waitStatus(t, h, ra, "waiting")
	waitStatus(t, h, rb, "done")

	list := func(q string) []any {
		t.Helper()
		code, out := call(t, h, "GET", "/api/sop/runs"+q, "")
		if code != 200 {
			t.Fatalf("列表 %s：%d %s", q, code, errMsg(out))
		}
		return out["data"].([]any)
	}
	if n := len(list("")); n != 2 {
		t.Fatalf("全部 %d 条", n)
	}
	mine := list("?mine=true")
	if len(mine) != 1 || mine[0].(map[string]any)["id"] != ra {
		t.Fatalf("待我处理 %v", mine)
	}
	row := mine[0].(map[string]any)
	if _, has := row["flow"]; has || row["flow_name"] != "甲" || row["steps"].([]any)[0].(map[string]any)["name"] != "检查" {
		t.Fatalf("列表行 %v", row)
	}
	if got := list("?flow_id=" + b + "&status=done"); len(got) != 1 || got[0].(map[string]any)["id"] != rb {
		t.Fatalf("按流程和状态 %v", got)
	}
	if got := list("?status=running,failed"); len(got) != 0 {
		t.Fatalf("running,failed %v", got)
	}
	if code, _ := call(t, h, "GET", "/api/sop/runs?status=nope", ""); code != 400 {
		t.Fatalf("不认的状态应当 400，实际 %d", code)
	}

	cs := cards()
	if len(cs) != 1 || cs[0].Title != "SOP 待我处理" || cs[0].Total != 1 || cs[0].Plugin != "sop" {
		t.Fatalf("今日卡片 %+v", cs)
	}
	b2, _ := json.Marshal(cs[0].Items)
	if !strings.Contains(string(b2), `"step_key":"r"`) || !strings.Contains(string(b2), ra) {
		t.Fatalf("卡片条目 %s", b2)
	}
	if err := r.Disable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	if cs := cards(); len(cs) != 0 {
		t.Fatalf("停用后卡片应当消失：%v", cs)
	}
}

func TestSubflowWaitsForChild(t *testing.T) {
	_, h := setup(t, New())
	child := newFlow(t, h, `{"name":"子流程","fields":[{"key":"who","label":"谁","type":"text","required":true}],"steps":[
		{"key":"t","name":"拼","kind":"template","after":[],"config":{"template":"嗨 {{who}}","output":"text"}},
		{"key":"r","name":"子检查","kind":"review"}]}`)
	parent := newFlow(t, h, `{"name":"父流程","steps":[
		{"key":"sub","name":"跑子流程","kind":"subflow","after":[],"config":{"sop":"子流程"}},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	_ = child
	rid := startRun(t, h, parent, `{"input":{"who":"林予安"}}`)["id"].(string)
	var cid string
	waitFor(t, "起了子执行", func() bool {
		cid, _ = step(getRun(t, h, rid), "sub")["child_run_id"].(string)
		return cid != ""
	})
	c := waitStatus(t, h, cid, "waiting")
	if c["parent_run_id"] != rid || c["parent_step"] != "sub" {
		t.Fatalf("子执行的父 %v %v", c["parent_run_id"], c["parent_step"])
	}
	if p := getRun(t, h, rid); step(p, "sub")["status"] != "running" || p["status"] != "running" {
		t.Fatalf("子执行没结束时父那一步应当还在 running：%v", step(p, "sub")["status"])
	}
	if code, _ := act(t, h, cid, `{"kind":"approve","step":"r","output":{"text":"改过"}}`); code != 200 {
		t.Fatal("子执行放行")
	}
	p := waitStatus(t, h, rid, "done")
	sub := step(p, "sub")["output"].(map[string]any)["subflow"].(map[string]any)
	if sub["run_id"] != cid || sub["status"] != "done" || sub["output"].(map[string]any)["text"] != "改过" {
		t.Fatalf("子流程结果 %v", sub)
	}

	// 父执行终止时子执行一起终止
	rid = startRun(t, h, parent, `{"input":{"who":"周屿"}}`)["id"].(string)
	waitFor(t, "起了子执行", func() bool {
		cid, _ = step(getRun(t, h, rid), "sub")["child_run_id"].(string)
		return cid != ""
	})
	waitStatus(t, h, cid, "waiting")
	if code, _ := act(t, h, rid, `{"kind":"stop"}`); code != 200 {
		t.Fatal("终止父执行")
	}
	waitStatus(t, h, cid, "stopped")
}

// 原型三条示例流程原样导入后能跑：写死的函数没了，按各自类型执行，没接模型时 AI 节点失败
func TestPrototypeFlowsRun(t *testing.T) {
	_, h := setup(t, New())
	b, err := os.ReadFile(filepath.Join("testdata", "prototype_sops.json"))
	if err != nil {
		t.Fatal(err)
	}
	var sops []json.RawMessage
	if err := json.Unmarshal(b, &sops); err != nil {
		t.Fatal(err)
	}
	for _, s := range sops {
		newFlow(t, h, string(s))
	}
	run := startRun(t, h, "sop_meeting", `{}`)
	mid := run["id"].(string)
	waitFor(t, "三路都结束", func() bool {
		run = getRun(t, h, mid)
		return step(run, "stats")["status"] == "done" && step(run, "summarize")["status"] == "failed" && step(run, "todos")["status"] == "failed"
	})
	if s := step(run, "split"); s["status"] != "done" || run["status"] != "failed" {
		t.Fatalf("split=%v", s["status"])
	}
	for _, k := range []string{"summarize", "todos"} {
		if s := step(run, k); s["status"] != "failed" || !strings.Contains(s["error"].(string), plugin.ErrNoAgent.Error()) {
			t.Fatalf("%s=%v %v", k, s["status"], s["error"])
		}
	}
	if s := step(run, "stats"); s["status"] != "done" {
		t.Fatalf("stats=%v", s["status"])
	}
	// 联系人建档的「新建还是合并」没有规则，是人工判断
	run = startRun(t, h, "sop_contact", `{}`)
	if code, out := act(t, h, run["id"].(string), `{"kind":"skip","step":"parse"}`); code != 200 {
		// parse 是 AI 节点，可能还没失败；等它失败再跳过
		waitStatus(t, h, run["id"].(string), "failed")
		if code, out = act(t, h, run["id"].(string), `{"kind":"skip","step":"parse"}`); code != 200 {
			t.Fatalf("跳过 %d %s", code, errMsg(out))
		}
	}
	run = waitStatus(t, h, run["id"].(string), "waiting")
	if s := step(run, "match"); s["status"] != "review" {
		t.Fatalf("match=%v", s["status"])
	}
}
