// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// hangLine 是剧本里的特殊一行：模型一直不返回，直到请求被取消——用来测停止一次在跑的执行。
const hangLine = "__hang__"

// newRunServer 是接了事件总线和触发调度的服务，模型是假 Ollama：按剧本一次回一段，剧本空了回一句话。
// 剧本里放 hangLine 时这次模型调用会挂着不返回，直到执行被取消。
func newRunServer(t *testing.T) (*connRec, *sqlite.Store, *agent.Dispatcher, func(lines ...string)) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	var mu sync.Mutex
	var script []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		line := `{"message":{"role":"assistant","content":"看过了。"},"done":true}`
		if len(script) > 0 {
			line, script = script[0], script[1:]
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-ndjson")
		if line == hangLine {
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, line+"\n")
	}))
	t.Cleanup(up.Close)
	if _, err := st.CreateProvider(ctx, &domain.AgentProvider{
		Name: "本机", Kind: domain.ProviderOllama, BaseURL: up.URL, Model: "qwen3.5:4b", Enabled: true,
	}, ""); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := events.New(nil, log)
	objects := events.WrapStore(st, bus)
	d := agent.NewDispatcher(objects, log)
	bus.Tap(func(e plugin.Event) { d.HandleEvent(e.Type, e.Payload) })
	t.Cleanup(func() { d.Wait(5 * time.Second) })
	s := New(objects, Options{Version: "test", Logger: log, AgentRuns: d})
	push := func(lines ...string) {
		mu.Lock()
		defer mu.Unlock()
		script = append(script, lines...)
	}
	return &connRec{t: t, s: s}, st, d, push
}

func (c *connRec) list(target string) ([]any, map[string]any) {
	c.t.Helper()
	w := do(c.s, "GET", target, "")
	mustCode(c.t, w, http.StatusOK, target)
	env := decodeEnvelope(c.t, w)
	items, _ := env["data"].([]any)
	meta, _ := env["meta"].(map[string]any)
	return items, meta
}

// 验收：任务分配给 Agent 后自动跑一次，需确认的调用让记录停在 waiting，确认后变 done；会话挂在任务下。
func TestAgentRunTaskFlow(t *testing.T) {
	r, st, d, push := newRunServer(t)
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"任务助手","provider_id":"`+pid+`","triggers":[{"kind":"task","detail":"","match":{"assigned":true,"tags":[]}}]}`, http.StatusCreated)
	id := ag["id"].(string)
	trig := ag["triggers"].([]any)[0].(map[string]any)
	if m, ok := trig["match"].(map[string]any); !ok || m["assigned"] != true {
		t.Fatalf("触发条件没存上：%v", trig)
	}
	r.call("PUT", "/api/agents/"+id+"/grants", `{"grants":{"read_tasks":"auto","write_tasks":"confirm"}}`, http.StatusOK)

	push(toolCallLine("create_object", `{"type_id":"task","title":"开通试点账号"}`))
	task := r.call("POST", "/api/objects", `{"type_id":"task","title":"跟进远川试点","props":{"agent_id":"`+id+`"}}`, http.StatusCreated)
	if !d.Wait(5 * time.Second) {
		t.Fatal("执行没跑完")
	}

	items, meta := r.list("/api/agent-runs?agent=" + id)
	if len(items) != 1 || meta["total"].(float64) != 1 {
		t.Fatalf("执行记录：%v", items)
	}
	run := items[0].(map[string]any)
	if run["status"] != "waiting" || run["trigger_kind"] != "task" || run["source_id"] != task["id"] || run["pending"].(float64) != 1 {
		t.Fatalf("应停在 waiting：%v", run)
	}
	sid := run["session_id"].(string)
	sessions, _ := r.list("/api/agent/sessions?object_id=" + task["id"].(string))
	if len(sessions) != 1 || sessions[0].(map[string]any)["id"] != sid {
		t.Fatalf("会话应挂在任务下：%v", sessions)
	}
	if got, _ := r.list("/api/agent-runs?status=waiting"); len(got) != 1 {
		t.Fatalf("按状态筛：%v", got)
	}
	if got, _ := r.list("/api/agent-runs?status=done"); len(got) != 0 {
		t.Fatalf("按状态筛：%v", got)
	}
	mustCode(t, do(r.s, "GET", "/api/agent-runs?status=bogus", ""), http.StatusBadRequest, "bad status")

	detail := r.call("GET", "/api/agent-runs/"+run["id"].(string), "", http.StatusOK)
	tcs := detail["tool_calls"].([]any)
	if len(tcs) != 1 || tcs[0].(map[string]any)["state"] != "pending" || len(detail["calls"].([]any)) == 0 {
		t.Fatalf("详情：%v", detail)
	}
	callID := tcs[0].(map[string]any)["id"].(string)

	// 确认：执行，接着跑完，执行记录变 done
	push(`{"message":{"role":"assistant","content":"试点账号的任务建好了。"},"done":true}`)
	w := do(r.s, "POST", "/api/agent/tool-calls/"+callID+"/confirm", "")
	mustCode(t, w, http.StatusOK, "confirm")
	if findEvent(sse(t, w.Body.String()), "done") == nil {
		t.Fatalf("确认后的事件：%s", w.Body.String())
	}
	d.Wait(5 * time.Second)
	done := r.call("GET", "/api/agent-runs/"+run["id"].(string), "", http.StatusOK)
	if done["status"] != "done" || done["summary"] != "试点账号的任务建好了。" || done["pending"].(float64) != 0 {
		t.Fatalf("确认后：%v", done)
	}
	// Agent 自己建的任务没有分配给它，不再触发
	if items, _ := r.list("/api/agent-runs"); len(items) != 1 {
		t.Fatalf("不该多出执行记录：%v", items)
	}
	mustCode(t, do(r.s, "GET", "/api/agent-runs/ar_nope", ""), http.StatusNotFound, "missing run")
}

// 停用的 Agent 不再被触发。
func TestAgentRunDisabledAgent(t *testing.T) {
	r, st, d, _ := newRunServer(t)
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"停用的","provider_id":"`+pid+`","enabled":false,"triggers":[{"kind":"task","detail":""}]}`, http.StatusCreated)
	r.call("POST", "/api/objects", `{"type_id":"task","title":"给它的","props":{"agent_id":"`+ag["id"].(string)+`"}}`, http.StatusCreated)
	d.Wait(5 * time.Second)
	if items, _ := r.list("/api/agent-runs"); len(items) != 0 {
		t.Fatalf("停用的 Agent 被触发了：%v", items)
	}
	if !strings.HasPrefix(ag["id"].(string), "ag_") {
		t.Fatal(ag)
	}
}

// --- 停止 / 重试（P0-O2，0056） ---

// 停止一次还在跑的执行：记录收尾 canceled（不是 failed），总结写明已做的操作不撤回；接口回 run_id + canceled。
func TestAgentRunStop(t *testing.T) {
	r, st, d, push := newRunServer(t)
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"长活助手","provider_id":"`+pid+`","triggers":[{"kind":"task","detail":""}]}`, http.StatusCreated)
	agID := ag["id"].(string)
	push(hangLine)
	r.call("POST", "/api/objects", `{"type_id":"task","title":"慢慢做","props":{"agent_id":"`+agID+`"}}`, http.StatusCreated)

	deadline := time.Now().Add(5 * time.Second)
	var runID string
	for runID == "" {
		items, _ := r.list("/api/agent-runs?agent=" + agID)
		if len(items) > 0 {
			runID = items[0].(map[string]any)["id"].(string)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("执行记录没出现")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// 记录建出来到取消函数登记有先后，碰上刚建好就 409，等一拍再试
	var stopped map[string]any
	for {
		w := do(r.s, "POST", "/api/agent-runs/"+runID+"/stop", "")
		if w.Code == http.StatusOK {
			env := decodeEnvelope(t, w)
			stopped, _ = env["data"].(map[string]any)
			break
		}
		if w.Code != http.StatusConflict || time.Now().After(deadline) {
			t.Fatalf("停止 = %d %s", w.Code, w.Body.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if stopped["run_id"] != runID || stopped["status"] != "canceled" {
		t.Fatalf("停止响应 = %v", stopped)
	}
	if !d.Wait(5 * time.Second) {
		t.Fatal("停止后执行没结束")
	}
	got := r.call("GET", "/api/agent-runs/"+runID, "", http.StatusOK)
	if got["status"] != "canceled" || got["summary"] != "已手动停止，已经执行的操作不会撤回。" || got["finished_at"] == nil {
		t.Fatalf("停止后 = %v", got)
	}
	if p, _ := got["prompt"].(string); !strings.Contains(p, "慢慢做") {
		t.Fatalf("提示词没落库：%v", got["prompt"])
	}
	// 已经结束的再停 409，按 canceled 筛得到它，不存在的 404
	mustCode(t, do(r.s, "POST", "/api/agent-runs/"+runID+"/stop", ""), http.StatusConflict, "stop twice")
	if items, _ := r.list("/api/agent-runs?status=canceled"); len(items) != 1 || items[0].(map[string]any)["id"] != runID {
		t.Fatalf("按 canceled 筛：%v", items)
	}
	mustCode(t, do(r.s, "POST", "/api/agent-runs/ar_nope/stop", ""), http.StatusNotFound, "stop missing")
}

// 重试失败 / 停止的执行：新建一条记录和新会话，提示词沿用、触发加（重试）、event_key 留空，异步跑完。
func TestAgentRunRetry(t *testing.T) {
	r, st, d, push := newRunServer(t)
	ctx := context.Background()
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"重试助手","provider_id":"`+pid+`","triggers":[{"kind":"manual","detail":""}]}`, http.StatusCreated)
	agID := ag["id"].(string)

	orig, err := st.CreateAgentRun(ctx, &store.AgentRun{
		AgentID: agID, TriggerKind: "task", Trigger: "任务分配给它 · TSK-1", SourceID: "obj_1",
		EventKey: "task:obj_1", Prompt: "把这条任务处理完",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishAgentRun(ctx, orig.ID, store.AgentRunFailed, "执行失败：boom"); err != nil {
		t.Fatal(err)
	}

	push(`{"message":{"role":"assistant","content":"重试好了。"},"done":true}`)
	out := r.call("POST", "/api/agent-runs/"+orig.ID+"/retry", "", http.StatusAccepted)
	run, _ := out["run"].(map[string]any)
	if run["id"] == orig.ID || run["event_key"] != "" || run["source_id"] != "obj_1" || run["trigger_kind"] != "task" {
		t.Fatalf("重试记录 = %v", run)
	}
	if trig, _ := run["trigger"].(string); !strings.Contains(trig, "（重试）") {
		t.Fatalf("触发说明 = %v", run["trigger"])
	}
	if run["prompt"] != "把这条任务处理完" {
		t.Fatalf("提示词没沿用：%v", run["prompt"])
	}
	sessionID, _ := out["session_id"].(string)
	if sessionID == "" || run["session_id"] != sessionID {
		t.Fatalf("新会话 = %v", out["session_id"])
	}
	sess, err := st.GetAgentSession(ctx, sessionID)
	if err != nil || !strings.HasPrefix(sess.Title, "重试 · ") {
		t.Fatalf("新会话 = %+v，%v", sess, err)
	}
	if !d.Wait(5 * time.Second) {
		t.Fatal("重试的执行没跑完")
	}
	done := r.call("GET", "/api/agent-runs/"+run["id"].(string), "", http.StatusOK)
	if done["status"] != "done" || done["summary"] != "重试好了。" {
		t.Fatalf("重试执行完 = %v", done)
	}
	// 成功的不能重试；没有提示词的不能重试；不存在的 404
	mustCode(t, do(r.s, "POST", "/api/agent-runs/"+run["id"].(string)+"/retry", ""), http.StatusConflict, "retry done")
	empty, err := st.CreateAgentRun(ctx, &store.AgentRun{AgentID: agID, TriggerKind: "im", Trigger: "旧执行"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishAgentRun(ctx, empty.ID, store.AgentRunCanceled, ""); err != nil {
		t.Fatal(err)
	}
	mustCode(t, do(r.s, "POST", "/api/agent-runs/"+empty.ID+"/retry", ""), http.StatusConflict, "retry no prompt")
	mustCode(t, do(r.s, "POST", "/api/agent-runs/ar_nope/retry", ""), http.StatusNotFound, "retry missing")

	// Agent 停用：409，不新建记录
	off := false
	if _, err := st.UpdateAgent(ctx, agID, domain.AgentInput{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	disabled, err := st.CreateAgentRun(ctx, &store.AgentRun{AgentID: agID, TriggerKind: "im", Trigger: "停用后", Prompt: "做点什么"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.FinishAgentRun(ctx, disabled.ID, store.AgentRunFailed, "执行失败：x"); err != nil {
		t.Fatal(err)
	}
	w := do(r.s, "POST", "/api/agent-runs/"+disabled.ID+"/retry", "")
	mustCode(t, w, http.StatusConflict, "retry disabled agent")
	// 一共：原记录、重试出来的、没提示词的、停用 Agent 的
	if items, _ := r.list("/api/agent-runs?agent=" + agID); len(items) != 4 {
		t.Fatalf("停用后不该新建执行记录：%d", len(items))
	}
}

// 触发执行无人值守：Runner 不给 ask_user、步数按 DefaultRunSteps 给预算（确认后接着跑那条路径同口径）。
func TestAgentRunnerUnattendedBudget(t *testing.T) {
	r, st, _, _ := newRunServer(t)
	ctx := context.Background()
	pid := firstProviderID(t, st)
	name := "触发助手"
	ag, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &pid})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{
		Title: "测试会话", ProviderID: pid, Model: "qwen3.5:4b", AgentID: &ag.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := r.s.agentRunner(ctx, ag, sess)
	if err != nil {
		t.Fatal(err)
	}
	if !runner.Unattended {
		t.Fatal("触发执行应无人值守")
	}
	if runner.Budget == nil || runner.Budget.MaxSteps != agent.DefaultRunSteps {
		t.Fatalf("预算 = %+v，想要 %d 步", runner.Budget, agent.DefaultRunSteps)
	}
}
