package sop

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 调模型的并发上限（SOP-07）：上限生效、排队顺序、取消时退出、动态调大调小、设置接口。

// enqueue 起一个协程排队拿名额，回拿到时关闭的 channel 和 release；等它真进了队才回。
func enqueue(t *testing.T, g *modelGate, ctx context.Context, root time.Time, name string, got chan<- string) (released func(), errc <-chan error) {
	t.Helper()
	in := make(chan struct{})
	ec := make(chan error, 1)
	var rel atomic.Value
	go func() {
		r, err := g.acquire(ctx, root, "run", name, func(int) { close(in) })
		if err != nil {
			ec <- err
			return
		}
		rel.Store(r)
		got <- name
		ec <- nil
	}()
	select {
	case <-in:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s 没进队", name)
	}
	return func() {
		waitFor(t, name+" 拿到名额", func() bool { return rel.Load() != nil })
		rel.Load().(func())()
	}, ec
}

func recv(t *testing.T, got <-chan string) string {
	t.Helper()
	select {
	case s := <-got:
		return s
	case <-time.After(2 * time.Second):
		t.Fatal("等了 2 秒没人拿到名额")
		return ""
	}
}

func none(t *testing.T, got <-chan string) {
	t.Helper()
	select {
	case s := <-got:
		t.Fatalf("不该再放人进来，%s 拿到了", s)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestModelGateLimitAndOrder(t *testing.T) {
	g := newModelGate(1)
	ctx := context.Background()
	t0 := time.Now()
	hold, err := g.acquire(ctx, t0, "run", "first", nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan string, 8)
	// 后发起的执行先进队，先发起的后进队：按顶层执行发起时间排，同一时间按进队先后
	relB, _ := enqueue(t, g, ctx, t0.Add(2*time.Second), "b", got)
	relC, _ := enqueue(t, g, ctx, t0.Add(time.Second), "c", got)
	relD, _ := enqueue(t, g, ctx, t0.Add(2*time.Second), "d", got)
	if q := g.queued("run"); q["c"] != 0 || q["b"] != 1 || q["d"] != 2 {
		t.Fatalf("队列位置 %v", q)
	}
	none(t, got)
	hold()
	hold() // 重复还不多还
	if s := recv(t, got); s != "c" {
		t.Fatalf("先放 c，实际 %s", s)
	}
	none(t, got)
	relC()
	if s := recv(t, got); s != "b" {
		t.Fatalf("再放 b，实际 %s", s)
	}
	relB()
	if s := recv(t, got); s != "d" {
		t.Fatalf("最后放 d，实际 %s", s)
	}
	relD()
	if l, a, w := g.stats(); l != 1 || a != 0 || w != 0 {
		t.Fatalf("stats %d %d %d", l, a, w)
	}
}

func TestModelGateCancelLeavesQueue(t *testing.T) {
	g := newModelGate(1)
	t0 := time.Now()
	hold, _ := g.acquire(context.Background(), t0, "run", "first", nil)
	got := make(chan string, 4)
	cctx, cancel := context.WithCancel(context.Background())
	_, errc := enqueue(t, g, cctx, t0, "gone", got)
	relN, _ := enqueue(t, g, context.Background(), t0, "next", got)
	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("取消后应回 ctx 错误：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消后排队的没退出")
	}
	if _, _, w := g.stats(); w != 1 {
		t.Fatalf("取消的应当出队，还剩 %d", w)
	}
	hold()
	if s := recv(t, got); s != "next" {
		t.Fatalf("取消的不占名额，应放 next，实际 %s", s)
	}
	relN()
	if _, a, _ := g.stats(); a != 0 {
		t.Fatalf("名额没还清：%d", a)
	}
}

func TestModelGateSetLimit(t *testing.T) {
	g := newModelGate(1)
	ctx := context.Background()
	t0 := time.Now()
	hold, _ := g.acquire(ctx, t0, "run", "first", nil)
	got := make(chan string, 8)
	var rels []func()
	for _, n := range []string{"w1", "w2", "w3", "w4"} {
		rel, _ := enqueue(t, g, ctx, t0, n, got)
		rels = append(rels, rel)
	}
	// 调大马上放排队的进来
	g.setLimit(3)
	// 两个同时放进来，谁先报到不一定
	if a, b := recv(t, got), recv(t, got); a+b != "w1w2" && a+b != "w2w1" {
		t.Fatalf("调大后放 w1、w2，实际 %s %s", a, b)
	}
	none(t, got)
	// 调小不打断在跑的，跑完一个少放一个
	g.setLimit(1)
	if _, a, w := g.stats(); a != 3 || w != 2 {
		t.Fatalf("调小后在跑 %d 排队 %d", a, w)
	}
	hold()
	rels[0]()
	none(t, got)
	rels[1]()
	if s := recv(t, got); s != "w3" {
		t.Fatalf("降到 1 个以下才放 w3，实际 %s", s)
	}
	rels[2]()
	if s := recv(t, got); s != "w4" {
		t.Fatalf("实际 %s", s)
	}
	rels[3]()
}

// 端到端：上限 1 时三条执行的 ai 步骤一次只调一个模型，排队的标 queue、记日志；终止排队的立即退出；调到 2 马上多放一个
func TestModelConcurrencyAcrossRuns(t *testing.T) {
	var mu sync.Mutex
	inFlight, maxSeen := 0, 0
	release := make(chan struct{})
	fa := &fakeAgent{complete: func(plugin.CompleteRequest) (string, error) {
		mu.Lock()
		inFlight++
		maxSeen = max(maxSeen, inFlight)
		mu.Unlock()
		<-release
		mu.Lock()
		inFlight--
		mu.Unlock()
		return "好", nil
	}}
	h := setupAgent(t, fa)
	flight := func() int { mu.Lock(); defer mu.Unlock(); return inFlight }

	code, out := call(t, h, "GET", "/api/sop/settings", "")
	if code != 200 || out["data"].(map[string]any)["model_concurrency"] != float64(2) {
		t.Fatalf("默认上限 2：%d %v", code, out)
	}
	for _, bad := range []string{`{"model_concurrency":0}`, `{"model_concurrency":17}`, `{"model_concurrency":"3"}`, `{"model_concurrency":1.5}`} {
		if code, _ := call(t, h, "PATCH", "/api/sop/settings", bad); code != 400 {
			t.Fatalf("%s 应当 400，实际 %d", bad, code)
		}
	}
	if code, out := call(t, h, "PATCH", "/api/sop/settings", `{"model_concurrency":1}`); code != 200 || out["data"].(map[string]any)["model_concurrency"] != float64(1) {
		t.Fatalf("改成 1：%d %v", code, out)
	}

	id := newFlow(t, h, `{"name":"并发","steps":[
		{"key":"a","name":"写摘要","kind":"ai","desc":"写一句话","after":[],"config":{"output":"summary"}},
		{"key":"e","name":"结束","kind":"end","after":["a"],"config":{}}]}`)
	var ids []string
	for range 3 {
		ids = append(ids, startRun(t, h, id, `{"input":{}}`)["id"].(string))
		time.Sleep(2 * time.Millisecond) // 发起时间分先后
	}
	waitFor(t, "一个在调模型、两个排队", func() bool {
		_, out := call(t, h, "GET", "/api/sop/settings", "")
		d := out["data"].(map[string]any)
		return flight() == 1 && d["running"] == float64(1) && d["queued"] == float64(2)
	})
	// 先发起的先跑：第一条在调，后两条排队，前面分别还有 0、1 个
	for n, rid := range ids {
		a := step(getRun(t, h, rid), "a")
		if a["status"] != "running" {
			t.Fatalf("执行 %d 的步骤应当 running：%v", n, a["status"])
		}
		q, _ := a["queue"].(map[string]any)
		switch n {
		case 0:
			if q != nil {
				t.Fatalf("第一条不该排队：%v", q)
			}
		default:
			if q == nil || q["ahead"] != float64(n-1) {
				t.Fatalf("执行 %d 排队位置 %v", n, q)
			}
		}
	}
	waitFor(t, "排队日志", func() bool { return hasLog(step(getRun(t, h, ids[2]), "a"), "排队等模型（前面还有 1 个）") })

	// 终止排队中的第三条：立即出队，不占名额
	if code, out := act(t, h, ids[2], `{"kind":"stop"}`); code != 200 {
		t.Fatalf("终止 %d %s", code, errMsg(out))
	}
	waitFor(t, "终止的出队", func() bool {
		_, out := call(t, h, "GET", "/api/sop/settings", "")
		return out["data"].(map[string]any)["queued"] == float64(1)
	})

	// 调到 2：第二条马上开始调模型
	if code, _ := call(t, h, "PATCH", "/api/sop/settings", `{"model_concurrency":2}`); code != 200 {
		t.Fatal("改成 2 失败")
	}
	waitFor(t, "调大后两个同时调模型", func() bool { return flight() == 2 })
	waitFor(t, "排到了的日志", func() bool { return hasLog(step(getRun(t, h, ids[1]), "a"), "排到了，开始调模型") })
	close(release)
	waitStatus(t, h, ids[0], "done")
	waitStatus(t, h, ids[1], "done")
	if maxSeen > 2 {
		t.Fatalf("同时调模型最多 %d 个，超过上限", maxSeen)
	}
	if s := step(getRun(t, h, ids[1]), "a"); s["queue"] != nil {
		t.Fatalf("跑完不该再带排队标记：%v", s["queue"])
	}
	if r := getRun(t, h, ids[2]); r["stopped"] != true || strings.Contains(r["status"].(string), "done") {
		t.Fatalf("第三条应当是终止状态：%v %v", r["stopped"], r["status"])
	}
}
