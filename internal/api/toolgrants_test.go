package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// grantUpstream 是假 Ollama：按剧本一次回一段，剧本空了回一句话；记下每次请求带的工具名。
type grantUpstream struct {
	mu     sync.Mutex
	script []string
	tools  [][]string
	// delay 是每次回话前等多久（模拟慢服务商，测时长上限）
	delay time.Duration
}

func (u *grantUpstream) push(lines ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.script = append(u.script, lines...)
}

func (u *grantUpstream) lastTools() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.tools) == 0 {
		return nil
	}
	return u.tools[len(u.tools)-1]
}

func toolCallLine(name, args string) string {
	return `{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"` + name + `","arguments":` + args + `}}]},"done":true}`
}

func newGrantServer(t *testing.T) (*connRec, *sqlite.Store, *grantUpstream) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := connector.NewRegistry()
	if err := defs.Register(connector.Fake()); err != nil {
		t.Fatal(err)
	}
	up := &grantUpstream{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		names := []string{}
		for _, x := range req.Tools {
			names = append(names, x.Function.Name)
		}
		up.mu.Lock()
		delay := up.delay
		up.mu.Unlock()
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		up.mu.Lock()
		up.tools = append(up.tools, names)
		line := `{"message":{"role":"assistant","content":"好的。"},"done":true}`
		if len(up.script) > 0 {
			line, up.script = up.script[0], up.script[1:]
		}
		up.mu.Unlock()
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, line+"\n")
	}))
	t.Cleanup(srv.Close)
	if _, err := st.CreateProvider(ctx, &domain.AgentProvider{
		Name: "本机", Kind: domain.ProviderOllama, BaseURL: srv.URL, Model: "qwen3.5:4b", Enabled: true,
	}, ""); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	s := New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Vault: v, Audit: al,
		Connectors: connector.New(st.DB(), v, defs)})
	return &connRec{t: t, s: s}, st, up
}

// sse 把 SSE 响应拆成事件。
func sse(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, blk := range strings.Split(body, "\n\n") {
		blk = strings.TrimSpace(blk)
		if !strings.HasPrefix(blk, "data: ") {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(blk, "data: ")), &ev); err != nil {
			t.Fatalf("SSE 事件不是 JSON：%s", blk)
		}
		out = append(out, ev)
	}
	return out
}

func findEvent(evs []map[string]any, typ string) map[string]any {
	for _, ev := range evs {
		if ev["type"] == typ {
			return ev
		}
	}
	return nil
}

func hasStr(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func TestAgentGrantsAPI(t *testing.T) {
	r, st, _ := newGrantServer(t)
	pid := firstProviderID(t, st)
	ag := r.call("POST", "/api/agents", `{"name":"分诊","provider_id":"`+pid+`"}`, http.StatusCreated)
	id := ag["id"].(string)

	g := r.call("GET", "/api/agents/"+id+"/grants", "", http.StatusOK)
	grants := g["grants"].(map[string]any)
	if g["agent_id"] != id || grants["read_tasks"] != "auto" || grants["read_contacts"] != "auto" || grants["write_tasks"] != "off" || len(grants) != 9 {
		t.Fatalf("默认授权 = %v", g)
	}

	c := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	cid := c["id"].(string)
	r.call("POST", "/api/connectors/"+cid+"/tools/refresh", "", http.StatusOK)

	for name, body := range map[string]string{
		"不认识的 key":   `{"grants":{"fly":"auto"}}`,
		"档位不对":       `{"grants":{"write_tasks":"maybe"}}`,
		"只读设需确认":     `{"grants":{"read_tasks":"confirm"}}`,
		"连接器不存在":     `{"grants":{"conn:cn_nope:list_items":"auto"}}`,
		"工具不在清单里":    `{"grants":{"conn:` + cid + `:nope":"auto"}}`,
		"只读连接器工具需确认": `{"grants":{"conn:` + cid + `:list_items":"confirm"}}`,
		"没有 grants":  `{}`,
	} {
		w := do(r.s, "PUT", "/api/agents/"+id+"/grants", body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s：%d %s", name, w.Code, w.Body.String())
		}
	}
	mustCode(t, do(r.s, "GET", "/api/agents/ag_nope/grants", ""), http.StatusNotFound, "grants of missing agent")

	// 连接器上限是需确认（create_item 默认），Agent 设成自动，实际按需确认；没挂载时实际是关闭
	g = r.call("PUT", "/api/agents/"+id+"/grants",
		`{"grants":{"read_tasks":"auto","write_tasks":"confirm","conn:`+cid+`:create_item":"auto","conn:`+cid+`:list_items":"auto"}}`, http.StatusOK)
	if g["grants"].(map[string]any)["read_contacts"] != "off" || g["effective"].(map[string]any)["conn:"+cid+":create_item"] != "off" {
		t.Fatalf("没挂载的实际档位 = %v", g)
	}
	r.call("PATCH", "/api/agents/"+id, `{"mcps":["`+cid+`"]}`, http.StatusOK)
	g = r.call("GET", "/api/agents/"+id+"/grants", "", http.StatusOK)
	eff := g["effective"].(map[string]any)
	if eff["conn:"+cid+":create_item"] != "confirm" || eff["conn:"+cid+":list_items"] != "auto" || eff["conn:"+cid+":get_item"] != "off" {
		t.Fatalf("挂载后的实际档位 = %v", eff)
	}

	// 审计记改了的 key 和新档位
	var n int
	var detail string
	if err := st.DB().R.QueryRow(`SELECT COUNT(*), MAX(detail) FROM audits WHERE action = 'set_tool_grants' AND target_id = ?`, id).Scan(&n, &detail); err != nil {
		t.Fatal(err)
	}
	if n != 1 || !strings.Contains(detail, `"read_contacts":"off"`) || !strings.Contains(detail, `"write_tasks":"confirm"`) {
		t.Fatalf("审计 %d 条：%s", n, detail)
	}
}

// 验收：关闭的不给模型、硬调回「没有授权」；需确认的发 confirm 后结束，确认后执行并继续，拒绝后不执行，都有审计；
// 连接器上限为需确认、Agent 设自动时按需确认。
func TestAgentToolCallConfirmFlow(t *testing.T) {
	r, st, up := newGrantServer(t)
	ctx := context.Background()
	pid := firstProviderID(t, st)
	c := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	cid := c["id"].(string)
	r.call("POST", "/api/connectors/"+cid+"/tools/refresh", "", http.StatusOK)
	ag := r.call("POST", "/api/agents", `{"name":"分诊","provider_id":"`+pid+`","mcps":["`+cid+`"]}`, http.StatusCreated)
	id := ag["id"].(string)
	r.call("PUT", "/api/agents/"+id+"/grants",
		`{"grants":{"read_tasks":"auto","write_tasks":"confirm","conn:`+cid+`:create_item":"auto","conn:`+cid+`:list_items":"auto"}}`, http.StatusOK)

	// 1. 关闭的 write_file 不在工具列表里；硬调不执行
	up.push(toolCallLine("write_file", `{"path":"a.md","content":"x"}`))
	w := do(r.s, "POST", "/api/agent/chat", `{"agent_id":"`+id+`","message":"写个文件"}`)
	mustCode(t, w, http.StatusOK, "chat")
	evs := sse(t, w.Body.String())
	tools := up.lastTools()
	if hasStr(tools, "write_file") || hasStr(tools, "fake__get_item") || !hasStr(tools, "create_object") || !hasStr(tools, "fake__create_item") || !hasStr(tools, "fake__list_items") {
		t.Fatalf("给模型的工具 = %v", tools)
	}
	if tr := findEvent(evs, "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "没有授权") {
		t.Fatalf("硬调关闭的工具：%v", evs)
	}
	sid := findEvent(evs, "done")["session_id"].(string)

	// 2. 需确认的 create_object：confirm 后本轮结束，没执行
	up.push(toolCallLine("create_object", `{"type_id":"task","title":"开通试点账号"}`))
	before := len(up.tools)
	w = do(r.s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"建个任务"}`)
	evs = sse(t, w.Body.String())
	if len(up.tools) != before+1 {
		t.Fatalf("发出 confirm 后又跑了 %d 轮", len(up.tools)-before)
	}
	cf := findEvent(evs, "confirm")
	if cf == nil || cf["name"] != "create_object" || cf["summary"] != "新建「开通试点账号」" || findEvent(evs, "done") == nil {
		t.Fatalf("confirm 事件：%v", evs)
	}
	if objs, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: "开通试点账号"}); len(objs) != 0 {
		t.Fatal("确认前就执行了")
	}
	callID := cf["id"].(string)
	// 有待确认的调用时删 Agent 被拦
	mustCode(t, do(r.s, "DELETE", "/api/agents/"+id, ""), http.StatusConflict, "delete agent with pending call")

	// 确认：执行，接着跑
	up.push(`{"message":{"role":"assistant","content":"建好了。"},"done":true}`)
	w = do(r.s, "POST", "/api/agent/tool-calls/"+callID+"/confirm", "")
	mustCode(t, w, http.StatusOK, "confirm")
	evs = sse(t, w.Body.String())
	if tr := findEvent(evs, "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "已创建") || findEvent(evs, "done") == nil {
		t.Fatalf("确认后的事件：%v", evs)
	}
	if objs, _, _ := st.ListObjects(ctx, domain.ObjectFilter{Query: "开通试点账号"}); len(objs) != 1 {
		t.Fatal("确认后没有执行")
	}
	if tc, _ := st.GetAgentToolCall(ctx, callID); tc.State != "confirmed" || !strings.Contains(tc.Result, "已创建") {
		t.Fatalf("调用记录 = %+v", tc)
	}
	mustCode(t, do(r.s, "POST", "/api/agent/tool-calls/"+callID+"/confirm", ""), http.StatusConflict, "confirm twice")
	mustCode(t, do(r.s, "POST", "/api/agent/tool-calls/atc_nope/reject", ""), http.StatusNotFound, "reject missing")

	// 3. 连接器上限需确认 + Agent 自动 = 需确认；拒绝后不执行
	up.push(toolCallLine("fake__create_item", `{"title":"y"}`))
	w = do(r.s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"在对方建一条"}`)
	cf = findEvent(sse(t, w.Body.String()), "confirm")
	if cf == nil || cf["name"] != "fake__create_item" {
		t.Fatalf("连接器上限需确认时应发 confirm：%s", w.Body.String())
	}
	up.push(`{"message":{"role":"assistant","content":"那就不建了。"},"done":true}`)
	w = do(r.s, "POST", "/api/agent/tool-calls/"+cf["id"].(string)+"/reject", "")
	mustCode(t, w, http.StatusOK, "reject")
	evs = sse(t, w.Body.String())
	if tr := findEvent(evs, "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "用户拒绝了") || findEvent(evs, "tool_call") != nil {
		t.Fatalf("拒绝后的事件：%v", evs)
	}

	// 4. 自动的连接器工具经 Call 真调假连接器
	up.push(toolCallLine("fake__list_items", `{}`))
	w = do(r.s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"列一下"}`)
	if tr := findEvent(sse(t, w.Body.String()), "tool_result"); tr == nil || !strings.Contains(tr["summary"].(string), "list_items") {
		t.Fatalf("连接器工具调用：%s", w.Body.String())
	}

	// 确认、拒绝都有审计
	var nc, nr int
	_ = st.DB().R.QueryRow(`SELECT COUNT(*) FROM audits WHERE target_type = 'agent_tool_call' AND action = 'confirm'`).Scan(&nc)
	_ = st.DB().R.QueryRow(`SELECT COUNT(*) FROM audits WHERE target_type = 'agent_tool_call' AND action = 'reject'`).Scan(&nr)
	if nc != 1 || nr != 1 {
		t.Fatalf("审计：确认 %d 条，拒绝 %d 条", nc, nr)
	}

	// 没挂 Agent 的老会话不受授权约束：工具列表照旧
	w = do(r.s, "POST", "/api/agent/chat", `{"message":"你好"}`)
	mustCode(t, w, http.StatusOK, "plain chat")
	if tools := up.lastTools(); !hasStr(tools, "write_file") || hasStr(tools, "fake__list_items") {
		t.Fatalf("老会话的工具 = %v", tools)
	}
}

// 验收：删除前影响检查里有 agent_mounts；删除后挂了它的 Agent 的 mcps 和 conn:<id>:* 授权被清掉。
func TestDeleteConnectorDetachesAgents(t *testing.T) {
	r, st, _ := newGrantServer(t)
	pid := firstProviderID(t, st)
	c := r.call("POST", "/api/connectors", `{"tool":"fake","secrets":{"token":"abc"}}`, http.StatusCreated)
	cid := c["id"].(string)
	r.call("POST", "/api/connectors/"+cid+"/tools/refresh", "", http.StatusOK)
	a1 := r.call("POST", "/api/agents", `{"name":"分诊","provider_id":"`+pid+`","mcps":["`+cid+`","cn_other"]}`, http.StatusCreated)["id"].(string)
	a2 := r.call("POST", "/api/agents", `{"name":"周报","provider_id":"`+pid+`","mcps":["`+cid+`"]}`, http.StatusCreated)["id"].(string)
	r.call("POST", "/api/agents", `{"name":"无关","provider_id":"`+pid+`"}`, http.StatusCreated)
	r.call("PUT", "/api/agents/"+a1+"/grants", `{"grants":{"read_tasks":"auto","conn:`+cid+`:list_items":"auto","conn:`+cid+`:create_item":"confirm"}}`, http.StatusOK)

	imp := r.call("GET", "/api/connectors/"+cid+"/impact", "", http.StatusOK)
	var mounts map[string]any
	for _, it := range imp["items"].([]any) {
		if m := it.(map[string]any); m["key"] == "agent_mounts" {
			mounts = m
		}
	}
	if mounts == nil || mounts["source"] != "core" || mounts["effect"] != "detach" || mounts["count"] != float64(2) ||
		mounts["text"] != "2 个 Agent 会卸下这个连接器：「周报」、「分诊」（失去 create_item、list_items 工具）" {
		t.Fatalf("agent_mounts = %v", mounts)
	}

	r.call("DELETE", "/api/connectors/"+cid, "", http.StatusOK)
	got := r.call("GET", "/api/agents/"+a1, "", http.StatusOK)
	if mc := got["mcps"].([]any); len(mc) != 1 || mc[0] != "cn_other" {
		t.Fatalf("a1 mcps = %v", mc)
	}
	if mc := r.call("GET", "/api/agents/"+a2, "", http.StatusOK)["mcps"].([]any); len(mc) != 0 {
		t.Fatalf("a2 mcps = %v", mc)
	}
	g := r.call("GET", "/api/agents/"+a1+"/grants", "", http.StatusOK)["grants"].(map[string]any)
	for k := range g {
		if strings.HasPrefix(k, "conn:"+cid+":") {
			t.Fatalf("conn 授权没清掉：%v", g)
		}
	}
	if g["read_tasks"] != "auto" {
		t.Errorf("内置授权不该动：%v", g)
	}
}
