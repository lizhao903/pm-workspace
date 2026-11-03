package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func countRows(t *testing.T, st *sqlite.Store, table string) int {
	t.Helper()
	var n int
	if err := st.DB().R.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// 验收：调试前后会话和消息表行数不变；需确认的发 confirm、确认后执行；重启后确认回 404；写操作审计带 debug: true。
func TestAgentDebugChat(t *testing.T) {
	r, st, up := newGrantServer(t)
	ctx := context.Background()
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"分诊","provider_id":"`+pid+`","enabled":false}`, http.StatusCreated)
	id := ag["id"].(string)
	sessions, msgs := countRows(t, st, "agent_sessions"), countRows(t, st, "agent_messages")

	// 1. 停用的 Agent 照常能调；body 里的授权把写工具设为需确认，存着的授权没开写工具
	up.push(toolCallLine("create_object", `{"type_id":"task","title":"调试建的任务"}`))
	body := `{"agent_id":"` + id + `","instructions":"只说中文","grants":{"read_tasks":"auto","write_tasks":"confirm"},
		"messages":[{"role":"user","content":"你好"},{"role":"assistant","content":"你好，有什么事"},{"role":"user","content":"建个任务"}]}`
	w := do(r.s, "POST", "/api/agents/debug/chat", body)
	mustCode(t, w, http.StatusOK, "debug chat")
	evs := sse(t, w.Body.String())
	if !hasStr(up.lastTools(), "create_object") || hasStr(up.lastTools(), "write_file") {
		t.Fatalf("给模型的工具 = %v", up.lastTools())
	}
	cf := findEvent(evs, "confirm")
	if cf == nil || cf["name"] != "create_object" || !agent.IsDebugCall(cf["id"].(string)) {
		t.Fatalf("confirm 事件：%v", evs)
	}
	if d := findEvent(evs, "done"); d == nil || d["session_id"] != nil {
		t.Fatalf("done 事件：%v", evs)
	}
	if objs, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: "调试建的任务"}); len(objs) != 0 {
		t.Fatal("确认前就执行了")
	}
	if countRows(t, st, "agent_tool_calls") != 0 {
		t.Fatal("调试里的待确认调用落库了")
	}

	// 2. 确认：执行，接着跑；带上了之前的调试历史
	up.push(`{"message":{"role":"assistant","content":"建好了。"},"done":true}`)
	callID := cf["id"].(string)
	w = do(r.s, "POST", "/api/agent/tool-calls/"+callID+"/confirm", "")
	mustCode(t, w, http.StatusOK, "debug confirm")
	evs = sse(t, w.Body.String())
	if tr := findEvent(evs, "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "已创建") || findEvent(evs, "done") == nil {
		t.Fatalf("确认后的事件：%v", evs)
	}
	objs, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: "调试建的任务"})
	if len(objs) != 1 {
		t.Fatal("确认后没有执行")
	}
	mustCode(t, do(r.s, "POST", "/api/agent/tool-calls/"+callID+"/confirm", ""), http.StatusNotFound, "confirm twice")

	// 写操作和确认的审计都带 debug: true
	for _, q := range []string{
		`SELECT detail FROM audits WHERE target_type = 'object' AND target_id = '` + objs[0].ID + `'`,
		`SELECT detail FROM audits WHERE target_type = 'agent_tool_call' AND target_id = '` + callID + `' AND action = 'confirm'`,
	} {
		var raw string
		if err := st.DB().R.QueryRow(q).Scan(&raw); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		var d map[string]any
		_ = json.Unmarshal([]byte(raw), &d)
		if d["debug"] != true {
			t.Fatalf("审计 detail 没有 debug: %s", raw)
		}
	}

	// 3. 拒绝；进程重启（内存清空）后确认回 404
	up.push(toolCallLine("create_object", `{"type_id":"task","title":"不要建"}`))
	w = do(r.s, "POST", "/api/agents/debug/chat", `{"agent_id":"`+id+`","grants":{"write_tasks":"confirm"},"messages":[{"role":"user","content":"再建一个"}]}`)
	cf = findEvent(sse(t, w.Body.String()), "confirm")
	if cf == nil {
		t.Fatalf("没有 confirm：%s", w.Body.String())
	}
	up.push(`{"message":{"role":"assistant","content":"那就不建了。"},"done":true}`)
	w = do(r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/reject", "")
	mustCode(t, w, http.StatusOK, "debug reject")
	if tr := findEvent(sse(t, w.Body.String()), "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "用户拒绝了") {
		t.Fatalf("拒绝后的事件：%s", w.Body.String())
	}
	up.push(toolCallLine("create_object", `{"type_id":"task","title":"重启前"}`))
	w = do(r.s, "POST", "/api/agents/debug/chat", `{"agent_id":"`+id+`","grants":{"write_tasks":"confirm"},"messages":[{"role":"user","content":"建"}]}`)
	cf = findEvent(sse(t, w.Body.String()), "confirm")
	prev := debugCalls
	debugCalls = agent.NewDebugCalls()
	t.Cleanup(func() { debugCalls = prev })
	mustCode(t, do(r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/confirm", ""), http.StatusNotFound, "confirm after restart")

	// 4. 没存过的配置：不带 agent_id，默认只开两项只读
	w = do(r.s, "POST", "/api/agents/debug/chat", `{"provider_id":"`+pid+`","messages":[{"role":"user","content":"你好"}]}`)
	mustCode(t, w, http.StatusOK, "debug chat new agent")
	if tools := up.lastTools(); hasStr(tools, "create_object") || !hasStr(tools, "search_objects") {
		t.Fatalf("新建时的工具 = %v", tools)
	}

	// 会话和消息表行数不变
	if countRows(t, st, "agent_sessions") != sessions || countRows(t, st, "agent_messages") != msgs {
		t.Fatal("调试对话写了会话或消息")
	}

	// 参数校验
	mustCode(t, do(r.s, "POST", "/api/agents/debug/chat", `{"provider_id":"`+pid+`","messages":[]}`), http.StatusBadRequest, "no messages")
	mustCode(t, do(r.s, "POST", "/api/agents/debug/chat", `{"provider_id":"`+pid+`","messages":[{"role":"assistant","content":"x"}]}`), http.StatusBadRequest, "last not user")
	mustCode(t, do(r.s, "POST", "/api/agents/debug/chat", `{"messages":[{"role":"user","content":"x"}]}`), http.StatusBadRequest, "no provider")
	mustCode(t, do(r.s, "POST", "/api/agents/debug/chat", `{"provider_id":"`+pid+`","grants":{"read_tasks":"confirm"},"messages":[{"role":"user","content":"x"}]}`), http.StatusBadRequest, "bad grant")
	mustCode(t, do(r.s, "POST", "/api/agents/debug/chat", `{"agent_id":"ag_nope","messages":[{"role":"user","content":"x"}]}`), http.StatusNotFound, "missing agent")
}
