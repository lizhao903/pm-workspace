// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 批量停止（TSK-0717）。

// ctxAgent 是会被取消的模型：Complete 卡到 ctx 取消或 release，记下被取消了几次。
type ctxAgent struct {
	*fakeAgent
	release   chan struct{}
	inFlight  atomic.Int32
	cancelled atomic.Int32
}

func (a *ctxAgent) Complete(ctx context.Context, _ plugin.CompleteRequest) (string, error) {
	a.inFlight.Add(1)
	defer a.inFlight.Add(-1)
	select {
	case <-a.release:
		return "好", nil
	case <-ctx.Done():
		a.cancelled.Add(1)
		return "", ctx.Err()
	}
}

func stopCall(t *testing.T, h http.Handler, body string) map[string]any {
	t.Helper()
	code, out := call(t, h, "POST", "/api/sop/runs/stop", body)
	return stopData(t, code, out)
}

func stopData(t *testing.T, code int, out map[string]any) map[string]any {
	t.Helper()
	if code != 200 {
		t.Fatalf("停止 %d %s", code, errMsg(out))
	}
	return out["data"].(map[string]any)
}

// 300 条执行（1 条在调模型、299 条排队）一次按条件停完：排队的立即出队、调模型的请求被取消，
// 再停一次幂等（matched 0）；停止的不算待我处理；同流程以外的不动。
func TestStopWhere300(t *testing.T) {
	ag := &ctxAgent{fakeAgent: &fakeAgent{}, release: make(chan struct{})}
	r, h := setup(t, New())
	r.SetAgent(ag)
	if code, _ := call(t, h, "PATCH", "/api/sop/settings", `{"model_concurrency":1}`); code != 200 {
		t.Fatal("改并发上限")
	}
	id := newFlow(t, h, `{"name":"分诊","fields":[{"key":"message_id","label":"消息","type":"text"}],"steps":[
		{"key":"a","name":"判断","kind":"ai","desc":"判断","after":[],"config":{"output":"summary"}}]}`)
	other := newFlow(t, h, `{"name":"别的","steps":[{"key":"r","name":"检查","kind":"review","after":[]}]}`)
	keep := startRun(t, h, other, `{}`)["id"].(string)
	waitStatus(t, h, keep, "waiting")

	// 分两批发起 300 条，带同一个批次
	const batch = "spb_testbatch0001"
	for b := range 2 {
		var in []string
		for i := range 150 {
			in = append(in, fmt.Sprintf(`{"message_id":"m%d"}`, b*150+i))
		}
		code, out := call(t, h, "POST", "/api/sop/flows/"+id+"/runs/batch", `{"batch_id":"`+batch+`","inputs":[`+strings.Join(in, ",")+`]}`)
		if code != 200 {
			t.Fatalf("批量发起 %d %s", code, errMsg(out))
		}
		d := out["data"].(map[string]any)
		if d["batch_id"] != batch || len(d["started"].([]any)) != 150 || len(d["cancelled"].([]any)) != 0 {
			t.Fatalf("批量发起结果：%v %d", d["batch_id"], len(d["started"].([]any)))
		}
	}
	waitFor(t, "一个在调模型、299 个排队", func() bool {
		_, out := call(t, h, "GET", "/api/sop/settings", "")
		d := out["data"].(map[string]any)
		return ag.inFlight.Load() == 1 && d["running"] == float64(1) && d["queued"] == float64(299)
	})

	// 不给条件 400；dry_run 只数不停
	for _, bad := range []string{`{}`, `{"all_running":false}`, `{"source":"x"}`, `{"batch_id":"abc"}`, `{"flow_id":1}`, `{"dry_run":"1","all_running":true}`} {
		if code, _ := call(t, h, "POST", "/api/sop/runs/stop", bad); code != 400 {
			t.Fatalf("%s 应当 400，实际 %d", bad, code)
		}
	}
	d := stopCall(t, h, `{"batch_id":"`+batch+`","dry_run":true}`)
	if d["matched"] != float64(300) || len(d["stopped"].([]any)) != 0 || d["summary"].(map[string]any)["running"] != float64(300) || d["dry_run"] != true {
		t.Fatalf("dry_run：%v %v", d["matched"], d["summary"])
	}

	code, out := call(t, h, "POST", "/api/sop/runs/stop", `{"batch_id":"`+batch+`"}`)
	d = stopData(t, code, out)
	if d["matched"] != float64(300) || len(d["stopped"].([]any)) != 300 || len(d["failed"].([]any)) != 0 {
		t.Fatalf("停 300 条：matched %v stopped %d failed %v", d["matched"], len(d["stopped"].([]any)), d["failed"])
	}
	if s := d["summary"].(map[string]any); s["stopped"] != float64(300) || s["running"] != float64(0) {
		t.Fatalf("停完的统计：%v", s)
	}
	waitFor(t, "队列清空、调模型的请求被取消", func() bool {
		_, out := call(t, h, "GET", "/api/sop/settings", "")
		d := out["data"].(map[string]any)
		return d["running"] == float64(0) && d["queued"] == float64(0) && ag.inFlight.Load() == 0
	})
	if ag.cancelled.Load() != 1 {
		t.Fatalf("在调模型的那一个应当被取消：%d", ag.cancelled.Load())
	}
	// 幂等：再停一次什么都不做
	d = stopCall(t, h, `{"batch_id":"`+batch+`"}`)
	if d["matched"] != float64(0) || len(d["stopped"].([]any)) != 0 {
		t.Fatalf("再停一次：%v", d)
	}
	// 停止后的批次再发起：不新起，记进 cancelled
	code, out = call(t, h, "POST", "/api/sop/flows/"+id+"/runs/batch", `{"batch_id":"`+batch+`","inputs":[{"message_id":"late"}]}`)
	if code != 200 {
		t.Fatalf("停止后再发起 %d", code)
	}
	if bd := out["data"].(map[string]any); len(bd["started"].([]any)) != 0 || len(bd["cancelled"].([]any)) != 1 ||
		bd["cancelled"].([]any)[0].(map[string]any)["key"] != "" {
		t.Fatalf("停止后的批次：%v", bd)
	}
	// 待我处理只剩别的流程那条（停止的不算），它没被动
	_, out = call(t, h, "GET", "/api/sop/runs?mine=true", "")
	if out["meta"].(map[string]any)["total"] != float64(1) || getRun(t, h, keep)["status"] != "waiting" {
		t.Fatalf("待我处理：%v", out["meta"])
	}
	close(ag.release)
}

// batch-actions 的 stop：执行中、待我处理的停掉，别的跳过并写明原因；all_running 停掉其余；
// 父子都在范围里只算父执行。
func TestBatchActionsStopAndAllRunning(t *testing.T) {
	g := newGate("x")
	p := New()
	p.stepHook = g.hook
	_, h := setup(t, p)
	run := newFlow(t, h, `{"name":"跑","steps":[{"key":"x","name":"卡住","kind":"template","after":[],"config":{"template":"好","output":"text"}}]}`)
	rv := newFlow(t, h, `{"name":"检查","steps":[{"key":"r","name":"检查","kind":"review","after":[]}]}`)
	done := newFlow(t, h, `{"name":"完","steps":[{"key":"t","name":"拼","kind":"template","after":[],"config":{"template":"好","output":"text"}}]}`)
	a := startRun(t, h, run, `{}`)["id"].(string)
	b := startRun(t, h, rv, `{}`)["id"].(string)
	c := startRun(t, h, done, `{}`)["id"].(string)
	waitStatus(t, h, a, "running")
	waitStatus(t, h, b, "waiting")
	waitStatus(t, h, c, "done")

	code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"stop","run_ids":["`+a+`","`+b+`","`+c+`","spr_none","`+a+`"]}`)
	if code != 200 {
		t.Fatalf("批量停止 %d %s", code, errMsg(out))
	}
	d := out["data"].(map[string]any)
	if len(d["done"].([]any)) != 2 || len(d["skipped"].([]any)) != 3 {
		t.Fatalf("停 2、跳过 3：%v", d)
	}
	reasons := ""
	for _, s := range d["skipped"].([]any) {
		reasons += s.(map[string]any)["reason"].(string) + "；"
	}
	for _, want := range []string{"不在执行中或待我处理（已完成）", "执行不存在", "重复"} {
		if !strings.Contains(reasons, want) {
			t.Fatalf("跳过原因缺「%s」：%s", want, reasons)
		}
	}
	for _, id := range []string{a, b} {
		if r := getRun(t, h, id); r["status"] != "stopped" || r["stopped"] != true {
			t.Fatalf("%s 应当停了：%v", id, r["status"])
		}
	}
	// 再停一次：跳过「已终止」
	code, out = call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"stop","run_ids":["`+a+`"]}`)
	if code != 200 || out["data"].(map[string]any)["skipped"].([]any)[0].(map[string]any)["reason"] != "已终止" {
		t.Fatalf("重复停止：%v", out)
	}

	// 子流程：父执行和子执行都在范围里，只停父执行，子执行随它终止
	newFlow(t, h, `{"name":"子","steps":[{"key":"x","name":"卡住","kind":"template","after":[],"config":{"template":"好","output":"text"}}]}`)
	parent := newFlow(t, h, `{"name":"父","steps":[{"key":"s","name":"子流程","kind":"subflow","after":[],"config":{"sop":"子"}}]}`)
	pid := startRun(t, h, parent, `{}`)["id"].(string)
	var cid string
	waitFor(t, "起了子执行", func() bool { cid, _ = step(getRun(t, h, pid), "s")["child_run_id"].(string); return cid != "" })
	waitStatus(t, h, cid, "running")
	d = stopCall(t, h, `{"all_running":true}`)
	if d["matched"] != float64(1) || d["stopped"].([]any)[0] != pid {
		t.Fatalf("只停父执行：%v", d)
	}
	waitStatus(t, h, cid, "stopped")
	// 上限 200
	if code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"stop","run_ids":[`+strings.Repeat(`"x",`, 200)+`"x"]}`); code != 400 ||
		!strings.Contains(errMsg(out), "一次最多停止 200 条") {
		t.Fatalf("超过 200 条：%d %s", code, errMsg(out))
	}
}
