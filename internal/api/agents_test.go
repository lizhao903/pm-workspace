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
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newAgentServer 用真库、审计、定时任务；上游是一个记下请求体的假 Ollama。
func newAgentServer(t *testing.T) (*Server, *sqlite.Store, *capturedChat) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	ws := audit.WrapStore(st, al)
	ss := schedule.New(st.DB(), time.UTC)

	cc := &capturedChat{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		cc.mu.Lock()
		cc.bodies = append(cc.bodies, b)
		cc.mu.Unlock()
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"好的。"},"done":true}`+"\n")
	}))
	t.Cleanup(up.Close)
	if _, err := st.CreateProvider(ctx, &domain.AgentProvider{
		Name: "本机", Kind: domain.ProviderOllama, BaseURL: up.URL, Model: "qwen3.5:4b", Enabled: true,
	}, ""); err != nil {
		t.Fatal(err)
	}
	return New(ws, Options{Version: "test", Logger: log, Audit: al, Schedules: ss}), st, cc
}

type capturedChat struct {
	mu     sync.Mutex
	bodies [][]byte
}

// system 取最近一次请求里的系统提示词。
func (c *capturedChat) system(t *testing.T) string {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.bodies) == 0 {
		t.Fatal("上游一次请求都没收到")
	}
	var req struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(c.bodies[len(c.bodies)-1], &req); err != nil {
		t.Fatal(err)
	}
	for _, m := range req.Messages {
		if m.Role == "system" {
			return m.Content
		}
	}
	t.Fatal("请求里没有系统提示词")
	return ""
}

func (c *capturedChat) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.bodies)
}

func firstProviderID(t *testing.T, st *sqlite.Store) string {
	t.Helper()
	list, err := st.ListProviders(context.Background())
	if err != nil || len(list) == 0 {
		t.Fatalf("没有服务商：%v", err)
	}
	return list[0].ID
}

func createAgent(t *testing.T, s *Server, body string) map[string]any {
	t.Helper()
	w := do(s, "POST", "/api/agents", body)
	mustCode(t, w, http.StatusCreated, "create agent "+w.Body.String())
	return envelopeData(t, w)
}

// 验收：不带 provider_id 或服务商不存在回 400；响应里同时有 provider_id 和 model；默认值对齐原型 newAgent。
func TestAgentCreateRequiresProvider(t *testing.T) {
	s, st, _ := newAgentServer(t)
	pid := firstProviderID(t, st)

	for name, body := range map[string]string{
		"不带服务商":  `{"name":"分诊","model":"m1"}`,
		"服务商为空":  `{"name":"分诊","provider_id":" ","model":"m1"}`,
		"服务商不存在": `{"name":"分诊","provider_id":"apv_nope","model":"m1"}`,
		"名称为空":   `{"name":" ","provider_id":"` + pid + `"}`,
		"触发方式为空": `{"name":"分诊","provider_id":"` + pid + `","triggers":[]}`,
		"触发方式不认": `{"name":"分诊","provider_id":"` + pid + `","triggers":[{"kind":"cron","detail":""}]}`,
		"图标不认":   `{"name":"分诊","provider_id":"` + pid + `","avatar":{"kind":"icon","value":"cat"}}`,
		"图片不是图片": `{"name":"分诊","provider_id":"` + pid + `","avatar":{"kind":"image","value":"data:text/plain;base64,aGk="}}`,
		"颜色不对":   `{"name":"分诊","provider_id":"` + pid + `","color":"red"}`,
	} {
		w := do(s, "POST", "/api/agents", body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s：状态码 = %d，期望 400（%s）", name, w.Code, w.Body.String())
		}
	}

	// 图片超过 1MB
	big := strings.Repeat("A", (1<<20)/3*4+8)
	w := do(s, "POST", "/api/agents", `{"name":"分诊","provider_id":"`+pid+`","avatar":{"kind":"image","value":"data:image/png;base64,`+big+`"}}`)
	mustCode(t, w, http.StatusBadRequest, "图片超过 1MB")

	a := createAgent(t, s, `{"name":" 消息分诊助手 ","provider_id":"`+pid+`","avatar":{"kind":"image","value":"data:image/png;base64,aGk="},"skills":["sk_a","sk_a"," sk_b "]}`)
	if a["provider_id"] != pid || a["model"] != "qwen3.5:4b" {
		t.Errorf("没给 model 应当取服务商默认模型：%v / %v", a["provider_id"], a["model"])
	}
	if a["name"] != "消息分诊助手" || a["enabled"] != true || !strings.HasPrefix(a["id"].(string), "ag_") {
		t.Errorf("新建 = %v", a)
	}
	if c, _ := a["color"].(string); len(c) != 7 || c[0] != '#' {
		t.Errorf("颜色应当随机挑一个：%q", c)
	}
	if tr := a["triggers"].([]any); len(tr) != 1 || tr[0].(map[string]any)["kind"] != "manual" {
		t.Errorf("默认触发方式应当是一条手动：%v", tr)
	}
	if sk := a["skills"].([]any); len(sk) != 2 || sk[1] != "sk_b" {
		t.Errorf("技能应当去重去空白：%v", sk)
	}
	for _, k := range []string{"mcps", "kbs"} {
		if v, ok := a[k].([]any); !ok || len(v) != 0 {
			t.Errorf("%s 应当是空数组：%v", k, a[k])
		}
	}

	// 改：服务商不存在回 400，model 不能改成空；model 不校验是否在模型列表里
	id := a["id"].(string)
	mustCode(t, do(s, "PATCH", "/api/agents/"+id, `{"provider_id":"apv_nope"}`), http.StatusBadRequest, "patch provider")
	mustCode(t, do(s, "PATCH", "/api/agents/"+id, `{"model":""}`), http.StatusBadRequest, "patch empty model")
	w = do(s, "PATCH", "/api/agents/"+id, `{"model":"不在列表里的模型","enabled":false,"abilities":{"x":"auto"}}`)
	mustCode(t, w, http.StatusOK, "patch")
	if got := envelopeData(t, w); got["model"] != "不在列表里的模型" || got["enabled"] != false || got["provider_id"] != pid {
		t.Errorf("patch = %v", got)
	}
	mustCode(t, do(s, "GET", "/api/agents/ag_nope", ""), http.StatusNotFound, "get missing")

	w = do(s, "GET", "/api/agents", "")
	mustCode(t, w, http.StatusOK, "list")
	if env := decodeEnvelope(t, w); len(env["data"].([]any)) != 1 {
		t.Errorf("列表 = %v", env["data"])
	}
}

// 验收：用 agent_id 建的会话，对话时系统提示词带上 Agent 指令，模型用 Agent 的。
func TestAgentSessionUsesAgentInstructions(t *testing.T) {
	s, st, cc := newAgentServer(t)
	pid := firstProviderID(t, st)
	a := createAgent(t, s, `{"name":"周报助手","desc":"每周五整理周报","provider_id":"`+pid+`","model":"agent-model",
		"instructions":"只用三段话回答，结尾写「完毕」。"}`)
	agentID := a["id"].(string)

	mustCode(t, do(s, "POST", "/api/agent/sessions", `{"agent_id":"ag_nope"}`), http.StatusNotFound, "unknown agent")

	w := do(s, "POST", "/api/agent/sessions", `{"agent_id":"`+agentID+`","provider_id":"apv_other","model":"other"}`)
	mustCode(t, w, http.StatusCreated, "create session")
	sess := envelopeData(t, w)
	if sess["agent_id"] != agentID || sess["provider_id"] != pid || sess["model"] != "agent-model" || sess["agent_deleted"] != false {
		t.Fatalf("会话应当用 Agent 的服务商和模型：%v", sess)
	}
	sid := sess["id"].(string)

	w = do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","model":"别的模型","message":"写周报"}`)
	mustCode(t, w, http.StatusOK, "chat")
	if !strings.Contains(w.Body.String(), `"type":"done"`) {
		t.Fatalf("流没正常结束：%s", w.Body.String())
	}
	sys := cc.system(t)
	for _, want := range []string{"周报助手", "每周五整理周报", "只用三段话回答，结尾写「完毕」。"} {
		if !strings.Contains(sys, want) {
			t.Errorf("系统提示词里没有 %q", want)
		}
	}
	var req struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(cc.bodies[len(cc.bodies)-1], &req)
	if req.Model != "agent-model" {
		t.Errorf("上游模型 = %q，期望 Agent 的 agent-model", req.Model)
	}

	// Agent 换了模型，下一轮跟着换，会话快照写回
	mustCode(t, do(s, "PATCH", "/api/agents/"+agentID, `{"model":"agent-model-2"}`), http.StatusOK, "patch model")
	mustCode(t, do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"再来"}`), http.StatusOK, "chat 2")
	got, err := st.GetAgentSession(context.Background(), sid)
	if err != nil || got.Model != "agent-model-2" {
		t.Errorf("会话模型快照 = %v（%v）", got, err)
	}

	// 不挂 Agent 的会话，系统提示词里没有 Agent 段
	mustCode(t, do(s, "POST", "/api/agent/chat", `{"message":"随手记"}`), http.StatusOK, "plain chat")
	if strings.Contains(cc.system(t), "周报助手") {
		t.Error("不挂 Agent 的会话不该带 Agent 指令")
	}

	// chat 不带 session_id、带 agent_id：新建挂 Agent 的会话
	mustCode(t, do(s, "POST", "/api/agent/chat", `{"agent_id":"`+agentID+`","message":"新开一个"}`), http.StatusOK, "chat new")
	if !strings.Contains(cc.system(t), "只用三段话回答") {
		t.Error("chat 带 agent_id 新建的会话应当带 Agent 指令")
	}
}

// 验收：停用的 Agent 发消息回 409；删除 Agent 后会话还在，agent_deleted 为 true。
func TestAgentDisabledAndDeletedSessions(t *testing.T) {
	s, st, cc := newAgentServer(t)
	pid := firstProviderID(t, st)
	agentID := createAgent(t, s, `{"name":"分诊","provider_id":"`+pid+`"}`)["id"].(string)
	w := do(s, "POST", "/api/agent/sessions", `{"agent_id":"`+agentID+`"}`)
	mustCode(t, w, http.StatusCreated, "create session")
	sid := envelopeData(t, w)["id"].(string)

	mustCode(t, do(s, "PATCH", "/api/agents/"+agentID, `{"enabled":false}`), http.StatusOK, "disable")
	before := cc.count()
	w = do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"你好"}`)
	mustCode(t, w, http.StatusConflict, "chat disabled")
	if !strings.Contains(w.Body.String(), "Agent 已停用") {
		t.Errorf("message = %s", w.Body.String())
	}
	w = do(s, "POST", "/api/agent/chat", `{"agent_id":"`+agentID+`","message":"你好"}`)
	mustCode(t, w, http.StatusConflict, "chat new disabled")
	if cc.count() != before {
		t.Error("停用时不该调上游")
	}
	if msgs, _ := st.ListAgentMessages(context.Background(), sid, 0); len(msgs) != 0 {
		t.Errorf("被拦的消息不该落库：%d 条", len(msgs))
	}
	if list, _ := st.ListAgentSessions(context.Background(), domain.AgentSessionFilter{Unscoped: true}); len(list) != 1 {
		t.Errorf("停用时 chat 带 agent_id 不该留下空会话：%d 条", len(list))
	}

	w = do(s, "DELETE", "/api/agents/"+agentID, "")
	mustCode(t, w, http.StatusOK, "delete")
	w = do(s, "GET", "/api/agent/sessions?unscoped=true", "")
	mustCode(t, w, http.StatusOK, "list sessions")
	items := decodeEnvelope(t, w)["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("会话应当保留：%v", items)
	}
	if it := items[0].(map[string]any); it["agent_id"] != agentID || it["agent_deleted"] != true {
		t.Errorf("删除后会话 = %v", it)
	}
	sess, err := st.GetAgentSession(context.Background(), sid)
	if err != nil || !sess.AgentDeleted {
		t.Errorf("GetAgentSession agent_deleted = %v（%v）", sess, err)
	}
	w = do(s, "POST", "/api/agent/chat", `{"session_id":"`+sid+`","message":"你好"}`)
	mustCode(t, w, http.StatusConflict, "chat deleted")
	if !strings.Contains(w.Body.String(), "Agent 已删除") {
		t.Errorf("message = %s", w.Body.String())
	}

	// 不挂 Agent 的会话 agent_id 为 null
	w = do(s, "POST", "/api/agent/sessions", `{}`)
	mustCode(t, w, http.StatusCreated, "plain session")
	if v, ok := envelopeData(t, w)["agent_id"]; !ok || v != nil {
		t.Errorf("不挂 Agent 的会话 agent_id 应当是 null：%v", v)
	}
}

// 验收：有定时任务交给它时影响检查返回拦截原因，DELETE 回 409；会话算作保留的影响。
func TestAgentImpactBlocksOnSchedule(t *testing.T) {
	s, st, _ := newAgentServer(t)
	pid := firstProviderID(t, st)
	agentID := createAgent(t, s, `{"name":"周报","provider_id":"`+pid+`"}`)["id"].(string)
	mustCode(t, do(s, "POST", "/api/agent/sessions", `{"agent_id":"`+agentID+`"}`), http.StatusCreated, "session")

	w := do(s, "POST", "/api/schedules", `{"name":"每周五周报","rule":{"freq":"weekly","time":"16:00","weekdays":[5]},
		"action":{"kind":"agent","agent_id":"`+agentID+`","prompt":"写周报"}}`)
	mustCode(t, w, http.StatusCreated, "schedule "+w.Body.String())
	scID := envelopeData(t, w)["id"].(string)

	w = do(s, "GET", "/api/agents/"+agentID+"/impact", "")
	mustCode(t, w, http.StatusOK, "impact")
	imp := envelopeData(t, w)
	blocks := imp["blocks"].([]any)
	if len(blocks) != 1 || !strings.Contains(blocks[0].(map[string]any)["text"].(string), "定时任务「每周五周报」交给它执行") {
		t.Fatalf("blocks = %v", blocks)
	}
	items := imp["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["key"] != "sessions" || items[0].(map[string]any)["count"] != float64(1) {
		t.Errorf("items = %v", items)
	}

	w = do(s, "DELETE", "/api/agents/"+agentID, "")
	mustCode(t, w, http.StatusConflict, "delete blocked")
	if !strings.Contains(w.Body.String(), "不能删除：定时任务「每周五周报」") {
		t.Errorf("message = %s", w.Body.String())
	}
	mustCode(t, do(s, "GET", "/api/agents/"+agentID, ""), http.StatusOK, "still there")

	mustCode(t, do(s, "DELETE", "/api/schedules/"+scID, ""), http.StatusOK, "delete schedule")
	w = do(s, "GET", "/api/agents/"+agentID+"/impact", "")
	if b := envelopeData(t, w)["blocks"].([]any); len(b) != 0 {
		t.Errorf("定时任务删了之后不该再拦：%v", b)
	}
	mustCode(t, do(s, "DELETE", "/api/agents/"+agentID, ""), http.StatusOK, "delete")
	mustCode(t, do(s, "GET", "/api/agents/"+agentID+"/impact", ""), http.StatusNotFound, "impact missing")
}

// 验收：新建、修改、删除各产生一条审计，target_type 为 agent。
func TestAgentAudits(t *testing.T) {
	s, st, _ := newAgentServer(t)
	pid := firstProviderID(t, st)
	id := createAgent(t, s, `{"name":"分诊","provider_id":"`+pid+`"}`)["id"].(string)
	mustCode(t, do(s, "PATCH", "/api/agents/"+id, `{"instructions":"先分类","enabled":false,"id":"x"}`), http.StatusOK, "patch")
	mustCode(t, do(s, "PATCH", "/api/agents/"+id, `{"provider_id":"apv_nope"}`), http.StatusBadRequest, "bad patch")
	mustCode(t, do(s, "DELETE", "/api/agents/"+id, ""), http.StatusOK, "delete")

	list := listAudits(t, s, "target_type=agent&target_id="+id)
	if len(list) != 3 {
		t.Fatalf("审计 %d 条，期望 3：%v", len(list), list)
	}
	actions := map[string]map[string]any{}
	for _, it := range list {
		if it["kind"] != "config" {
			t.Errorf("kind = %v", it["kind"])
		}
		actions[it["action"].(string)] = it
	}
	for _, a := range []string{"create", "update", "delete"} {
		if actions[a] == nil {
			t.Errorf("缺 %s 审计", a)
		}
	}
	if d := actions["update"]["detail"].(map[string]any); d["enabled"] != false {
		t.Errorf("update detail = %v", d)
	} else if f := d["fields"].([]any); len(f) != 2 || f[0] != "enabled" || f[1] != "instructions" {
		t.Errorf("update fields = %v", f)
	}
	if d := actions["create"]["detail"].(map[string]any); d["provider_id"] != pid || d["model"] != "qwen3.5:4b" {
		t.Errorf("create detail = %v", d)
	}
}
