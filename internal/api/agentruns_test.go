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
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newRunServer 是接了事件总线和触发调度的服务，模型是假 Ollama：按剧本一次回一段，剧本空了回一句话。
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
