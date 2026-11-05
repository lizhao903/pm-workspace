package sop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// TSK-0392 / TSK-0391：服务商（NewAPI）挂掉的一个多小时里，每来一条 IM 消息，SOP 的 AI 步骤就调一次模型、失败一次，
// 同一条运行异常累计 48 次。这里用真的模型句柄（internal/agent）加假的模型服务端（httptest，回 503）复现：
// 改之后服务商熔断、不再每条都打出去；IM 发起的执行挂起「等服务商恢复」而不是失败；运行异常按服务商记成一条；
// 服务商恢复后原地重跑这些执行，不新建执行。

type downModel struct {
	srv  *httptest.Server
	hits atomic.Int32
	mu   sync.Mutex
	up   bool
}

func newDownModel(t *testing.T) *downModel {
	t.Helper()
	m := &downModel{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		m.hits.Add(1)
		m.mu.Lock()
		up := m.up
		m.mu.Unlock()
		if !up {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"message":{"content":"Acme"},"done":true}` + "\n"))
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *downModel) setUp() {
	m.mu.Lock()
	m.up = true
	m.mu.Unlock()
}

// realAgent 是真的模型句柄：单独一个库放服务商「NewAPI」（Ollama 协议，地址是假服务端），重试等待很短。
func realAgent(t *testing.T, url string) (*agent.Service, string) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	p, err := st.CreateProvider(ctx, &domain.AgentProvider{Name: "NewAPI", Kind: domain.ProviderOllama,
		BaseURL: url, Model: "m0", Enabled: true, IsDefault: true}, "")
	if err != nil {
		t.Fatal(err)
	}
	return &agent.Service{Store: st, RetryDelays: []time.Duration{time.Millisecond, time.Millisecond}}, p.ID
}

const routeFlow = `{"name":"消息分流：按项目归档","trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text","required":true}],"steps":[
	{"key":"route","name":"属于哪个项目","kind":"ai","desc":"判断 {{message_id}} 属于哪个项目","after":[],"config":{"output":"project"}},
	{"key":"e","name":"结束","kind":"end","after":["route"],"config":{"outputs":"project"}}]}`

func deliverIM(t *testing.T, reg *plugin.Registry, id string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"message_id": id, "channel": "slack", "connector_id": "cn_1",
		"relevance": "", "at": time.Now().UTC().Format(time.RFC3339Nano)})
	for _, s := range reg.Subscribers(imReceivedEvent) {
		if err := s.Handle(context.Background(), plugin.Event{Type: imReceivedEvent, At: time.Now(), Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
}

func pwRuns(t *testing.T, h http.Handler) []map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/runs", "")
	if code != 200 {
		t.Fatalf("列执行：%d %v", code, out)
	}
	var list []map[string]any
	for _, x := range out["data"].([]any) {
		list = append(list, x.(map[string]any))
	}
	return list
}

func (f *fakeIncidents) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.got)
}

// 复现：服务商挂着来了 8 条 IM 消息。
func TestProviderDownDoesNotFloodIncidents(t *testing.T) {
	model := newDownModel(t)
	svc, pid := realAgent(t, model.srv.URL)
	reg, h := setup(t, New())
	reg.SetAgent(svc)
	inc := &fakeIncidents{}
	reg.SetIncidents(inc)
	newFlow(t, h, routeFlow)

	const n = 8
	for i := range n {
		deliverIM(t, reg, "msg_"+string(rune('a'+i)))
	}
	waitFor(t, "每条执行都有了结果（失败或挂起）", func() bool { return settled(t, h) == n })
	time.Sleep(100 * time.Millisecond)

	// 不再每条消息打 3 次：连续失败 5 次后熔断，最多再加上同时在调的那几个
	if hits := model.hits.Load(); hits > 5+defaultModelConcurrency {
		t.Fatalf("服务商挂着时每条消息都打出去了：%d 次", hits)
	}
	for _, r := range pwRuns(t, h) {
		run := getRun(t, h, r["id"].(string))
		st := step(run, "route")
		if run["status"] != "running" || st["status"] != "running" || st["provider_wait"] == nil {
			t.Fatalf("IM 发起的执行应当挂起等服务商恢复，而不是失败：%v / %v %v %v", run["status"], st["status"], st["error"], st["provider_wait"])
		}
	}
	// 运行异常按服务商记一条，不再每条消息记一次：第一次马上写，同一分钟里后来的攒着到点写最新的一份
	inc.mu.Lock()
	defer inc.mu.Unlock()
	if len(inc.got) == 0 || len(inc.got) > 2 {
		t.Fatalf("运行异常不该每条消息都记：记了 %d 次", len(inc.got))
	}
	for _, g := range inc.got {
		if g.Fingerprint != "sop:provider:"+pid || !strings.HasPrefix(g.Title, "服务商「NewAPI」不可用，影响 ") ||
			!strings.Contains(g.Message, "设置 → 模型服务商") || !strings.Contains(g.Message, "失败时改用") {
			t.Fatalf("运行异常应当按服务商聚合、写明修复指引：%+v", g)
		}
	}
}

// settled 是 route 步骤已经有了结果的执行数：失败了，或者挂起等服务商。
func settled(t *testing.T, h http.Handler) int {
	t.Helper()
	n := 0
	for _, r := range pwRuns(t, h) {
		st := step(getRun(t, h, r["id"].(string)), "route")
		if st["status"] == "failed" || (st["status"] == "running" && st["provider_wait"] != nil) {
			n++
		}
	}
	return n
}

// affectedOf 从「服务商「X」不可用，影响 N 次执行」里取 N。
func affectedOf(title string) int {
	i, j := strings.Index(title, "影响 "), strings.Index(title, " 次执行")
	if i < 0 || j < i {
		return 0
	}
	k, _ := strconv.Atoi(title[i+len("影响 ") : j])
	return k
}

func shortWaits(t *testing.T, svc *agent.Service) {
	t.Helper()
	svc.Breaker.Config = agent.BreakerConfig{Threshold: 5, Window: time.Minute, Cooldown: 200 * time.Millisecond,
		MaxCooldown: 400 * time.Millisecond, ProbeWait: 50 * time.Millisecond}
	oldMin, oldDef, oldMax, oldEvery := providerRetryMin, providerRetryDefault, providerWaitMax, incidentEvery
	providerRetryMin, providerRetryDefault, incidentEvery = 10*time.Millisecond, 100*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() {
		providerRetryMin, providerRetryDefault, providerWaitMax, incidentEvery = oldMin, oldDef, oldMax, oldEvery
	})
}

// 服务商恢复后，挂起的执行原地重跑完成；同一条消息再来不新建执行。
func TestProviderRecoveryRerunsHeldRuns(t *testing.T) {
	model := newDownModel(t)
	svc, pid := realAgent(t, model.srv.URL)
	shortWaits(t, svc)
	reg, h := setup(t, New())
	reg.SetAgent(svc)
	inc := &fakeIncidents{}
	reg.SetIncidents(inc)
	newFlow(t, h, routeFlow)

	ids := []string{"msg_1", "msg_2", "msg_3", "msg_4"}
	for _, id := range ids {
		deliverIM(t, reg, id)
	}
	waitFor(t, "4 条执行都挂起", func() bool { return settled(t, h) == len(ids) })
	time.Sleep(500 * time.Millisecond)
	if hits := model.hits.Load(); hits > 12 {
		t.Fatalf("挂起期间应当只按熔断的节奏探测：打了 %d 次", hits)
	}
	// 运行异常只一条（同一指纹），攒着的那份写上来后标题写明影响 4 次执行
	inc.mu.Lock()
	last := inc.got[len(inc.got)-1]
	recorded := len(inc.got)
	inc.mu.Unlock()
	if last.Fingerprint != "sop:provider:"+pid || last.Title != "服务商「NewAPI」不可用，影响 4 次执行" {
		t.Fatalf("运行异常按服务商聚合，标题写明影响几次执行：%q %q", last.Fingerprint, last.Title)
	}

	model.setUp()
	waitFor(t, "服务商恢复后执行都跑完", func() bool {
		for _, r := range pwRuns(t, h) {
			if r["status"] != "done" {
				return false
			}
		}
		return true
	})
	list := pwRuns(t, h)
	if len(list) != len(ids) {
		t.Fatalf("重跑不该新建执行：%d 条", len(list))
	}
	for _, r := range list {
		run := getRun(t, h, r["id"].(string))
		st := step(run, "route")
		if st["provider_wait"] != nil || st["output"].(map[string]any)["project"] != "Acme" {
			t.Fatalf("重跑结果 %v %v", st["provider_wait"], st["output"])
		}
		logs, _ := json.Marshal(st["log"])
		if !strings.Contains(string(logs), "先挂起") || !strings.Contains(string(logs), "恢复了") {
			t.Fatalf("日志应写明挂起和恢复：%s", logs)
		}
	}
	// 同一条消息再来：不新建执行，也就不会重复建任务
	deliverIM(t, reg, "msg_1")
	if n := len(pwRuns(t, h)); n != len(ids) {
		t.Fatalf("同一条消息不该再发起：%d", n)
	}
	if n := inc.count(); n != recorded {
		t.Fatalf("恢复后不该再记运行异常：%d → %d", recorded, n)
	}
}

// 等的上限：执行发起后超过 providerWaitMax 仍没恢复的照常失败；手动发起的不挂起，直接失败；运行异常都记在服务商那一条上。
func TestProviderWaitLimitAndManualRuns(t *testing.T) {
	model := newDownModel(t)
	svc, pid := realAgent(t, model.srv.URL)
	shortWaits(t, svc)
	providerWaitMax = 300 * time.Millisecond
	reg, h := setup(t, New())
	reg.SetAgent(svc)
	inc := &fakeIncidents{}
	reg.SetIncidents(inc)
	fid := newFlow(t, h, routeFlow)

	deliverIM(t, reg, "msg_x")
	rid := pwRuns(t, h)[0]["id"].(string)
	run := waitStatus(t, h, rid, "failed")
	if e := step(run, "route")["error"].(string); !strings.Contains(e, "不再自动重跑") {
		t.Fatalf("超过上限应当失败并说明：%s", e)
	}

	mid := startRun(t, h, fid, `{"input":{"message_id":"手动"}}`)["id"].(string)
	run = waitStatus(t, h, mid, "failed")
	if e := step(run, "route")["error"].(string); strings.Contains(e, "不再自动重跑") || !strings.Contains(e, "NewAPI") {
		t.Fatalf("手动发起的直接失败：%s", e)
	}
	inc.mu.Lock()
	defer inc.mu.Unlock()
	for _, g := range inc.got {
		if g.Fingerprint != "sop:provider:"+pid {
			t.Fatalf("服务商不可用的失败也记在服务商那一条上：%+v", g)
		}
	}
}
