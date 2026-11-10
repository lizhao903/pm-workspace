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
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newSkillServer 同 newAgentServer，另接上带示例插件的注册表（示例插件没装）。
func newSkillServer(t *testing.T) (*Server, *sqlite.Store, *capturedChat) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), log)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	if err := reg.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	al := audit.New(st.DB(), log)

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
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al, Plugins: reg}), st, cc
}

func skillIDs(t *testing.T, s *Server, query string) []string {
	t.Helper()
	w := do(s, "GET", "/api/skills"+query, "")
	mustCode(t, w, http.StatusOK, "list skills")
	out := []string{}
	for _, x := range decodeEnvelope(t, w)["data"].([]any) {
		out = append(out, x.(map[string]any)["id"].(string))
	}
	return out
}

func has(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// 验收：内置技能改或删回 409；复制内置技能得到一条自定义技能，内容一致、名字带「副本」。
func TestBuiltinSkillReadonlyAndCopy(t *testing.T) {
	s, _, _ := newSkillServer(t)

	all := skillIDs(t, s, "")
	if len(all) != 10 || all[0] != "sk_video" {
		t.Fatalf("只有内置技能时列表 = %v", all)
	}
	mustCode(t, do(s, "PATCH", "/api/skills/sk_weekly", `{"name":"改名"}`), http.StatusConflict, "patch builtin")
	mustCode(t, do(s, "DELETE", "/api/skills/sk_weekly", ""), http.StatusConflict, "delete builtin")
	mustCode(t, do(s, "GET", "/api/skills/sk_nope", ""), http.StatusNotFound, "get missing")
	mustCode(t, do(s, "POST", "/api/skills", `{"copy_from":"sk_nope"}`), http.StatusBadRequest, "copy missing")
	mustCode(t, do(s, "POST", "/api/skills", `{"name":"只有名字"}`), http.StatusBadRequest, "没写怎么做")

	w := do(s, "GET", "/api/skills/sk_weekly", "")
	mustCode(t, w, http.StatusOK, "get builtin")
	src := envelopeData(t, w)
	if src["source"] != "builtin" {
		t.Fatalf("source = %v", src["source"])
	}
	if _, ok := src["created_at"]; ok {
		t.Errorf("内置技能不该有时间戳：%v", src)
	}

	w = do(s, "POST", "/api/skills", `{"copy_from":"sk_weekly"}`)
	mustCode(t, w, http.StatusCreated, "copy "+w.Body.String())
	cp := envelopeData(t, w)
	id := cp["id"].(string)
	if id == "sk_weekly" || !strings.HasPrefix(id, "sk_") || cp["source"] != "custom" || cp["name"] != "写周报（副本）" {
		t.Fatalf("复制 = %v", cp)
	}
	for _, k := range []string{"desc", "instructions", "when"} {
		if cp[k] != src[k] {
			t.Errorf("%s 不一致：%v / %v", k, cp[k], src[k])
		}
	}
	if u := cp["uses"].([]any); len(u) != 2 || u[0] != "查任务" || u[1] != "写文档" {
		t.Errorf("uses = %v", u)
	}

	// 复制时给了的字段以 body 为准；自定义的能改能删
	w = do(s, "POST", "/api/skills", `{"copy_from":"sk_weekly","name":"写周报（我的）","uses":[]}`)
	mustCode(t, w, http.StatusCreated, "copy with name")
	if got := envelopeData(t, w); got["name"] != "写周报（我的）" || len(got["uses"].([]any)) != 0 || got["instructions"] != src["instructions"] {
		t.Errorf("带名字复制 = %v", got)
	}
	w = do(s, "PATCH", "/api/skills/"+id, `{"instructions":"改过的做法","source":"builtin"}`)
	mustCode(t, w, http.StatusOK, "patch custom")
	if got := envelopeData(t, w); got["instructions"] != "改过的做法" || got["source"] != "custom" {
		t.Errorf("改 = %v", got)
	}
	if got := skillIDs(t, s, "?source=custom"); len(got) != 2 {
		t.Errorf("自定义 = %v", got)
	}
	if got := skillIDs(t, s, "?source=builtin"); len(got) != 10 {
		t.Errorf("内置 = %v", got)
	}
}

// 验收：示例插件登记的技能出现在 GET /api/skills，停用插件后消失，挂了它的 Agent 对话时不注入；
// Agent 挂两个技能后系统提示词里按顺序有两段技能说明。
func TestPluginSkillAndChatInjection(t *testing.T) {
	s, st, cc := newSkillServer(t)
	pid := firstProviderID(t, st)

	mustCode(t, do(s, "POST", "/api/plugins/demo/install", `{"permissions":["network:localhost"]}`), http.StatusOK, "install")
	mustCode(t, do(s, "POST", "/api/plugins/demo/enable", ""), http.StatusOK, "enable")
	if got := skillIDs(t, s, "?source=demo"); len(got) != 1 || got[0] != plugintest.SkillID {
		t.Fatalf("启用后插件技能 = %v", got)
	}
	mustCode(t, do(s, "PATCH", "/api/skills/"+plugintest.SkillID, `{"name":"x"}`), http.StatusConflict, "patch plugin skill")
	mustCode(t, do(s, "DELETE", "/api/skills/"+plugintest.SkillID, ""), http.StatusConflict, "delete plugin skill")

	w := do(s, "POST", "/api/skills", `{"name":"业务数据查询","instructions":"只写 SELECT；先看表结构再写。","when":"要查业务数据时"}`)
	mustCode(t, w, http.StatusCreated, "create custom")
	custom := envelopeData(t, w)["id"].(string)

	a := createAgent(t, s, `{"name":"数据助手","provider_id":"`+pid+`","skills":["`+custom+`","sk_weekly","`+plugintest.SkillID+`","sk_gone"]}`)
	agentID := a["id"].(string)

	// 列表里带上在用的 Agent
	w = do(s, "GET", "/api/skills/sk_weekly", "")
	if ag := envelopeData(t, w)["agents"].([]any); len(ag) != 1 || ag[0].(map[string]any)["name"] != "数据助手" {
		t.Errorf("在用的 Agent = %v", ag)
	}

	chat := func() string {
		w := do(s, "POST", "/api/agent/chat", `{"agent_id":"`+agentID+`","message":"查一下"}`)
		mustCode(t, w, http.StatusOK, "chat")
		if !strings.Contains(w.Body.String(), `"type":"done"`) {
			t.Fatalf("流没正常结束：%s", w.Body.String())
		}
		return cc.system(t)
	}
	sys := chat()
	i := strings.Index(sys, "技能：业务数据查询")
	j := strings.Index(sys, "技能：写周报")
	k := strings.Index(sys, "技能：示例摘要")
	if i < 0 || j < 0 || k < 0 || !(i < j && j < k) {
		t.Fatalf("技能段应当按挂载顺序：%d %d %d\n%s", i, j, k, sys)
	}
	if !strings.Contains(sys, "只写 SELECT；先看表结构再写。") || !strings.Contains(sys, "什么时候用：要查业务数据时") {
		t.Errorf("技能说明没拼进去：\n%s", sys)
	}
	if strings.Index(sys, "你是 Agent「数据助手」") > i {
		t.Error("技能段应当在 Agent 身份后面")
	}

	// 停用插件：列表里没了，对话不报错、不注入它
	mustCode(t, do(s, "POST", "/api/plugins/demo/disable", ""), http.StatusOK, "disable")
	if got := skillIDs(t, s, ""); has(got, plugintest.SkillID) || len(got) != 11 {
		t.Fatalf("停用后列表 = %v", got)
	}
	mustCode(t, do(s, "GET", "/api/skills/"+plugintest.SkillID, ""), http.StatusNotFound, "get disabled plugin skill")
	sys = chat()
	if strings.Contains(sys, "示例摘要") || strings.Count(sys, "### 技能：") != 2 {
		t.Errorf("停用插件后不该注入它的技能：\n%s", sys)
	}
}

// 验收：删除自定义技能后挂了它的 Agent 的 skills 里不再有它；回的 agents 是被摘掉它的 Agent。
func TestDeleteSkillDetachesAgents(t *testing.T) {
	s, st, _ := newSkillServer(t)
	pid := firstProviderID(t, st)
	w := do(s, "POST", "/api/skills", `{"name":"竞品分析（我的）","instructions":"每家一行"}`)
	mustCode(t, w, http.StatusCreated, "create")
	id := envelopeData(t, w)["id"].(string)
	a := createAgent(t, s, `{"name":"甲","provider_id":"`+pid+`","skills":["sk_weekly","`+id+`"]}`)
	b := createAgent(t, s, `{"name":"乙","provider_id":"`+pid+`","skills":["sk_weekly"]}`)

	w = do(s, "DELETE", "/api/skills/"+id, "")
	mustCode(t, w, http.StatusOK, "delete")
	got := envelopeData(t, w)
	if ag := got["agents"].([]any); len(ag) != 1 || ag[0].(map[string]any)["id"] != a["id"] || ag[0].(map[string]any)["name"] != "甲" {
		t.Errorf("被摘掉的 Agent = %v", ag)
	}
	for _, c := range []struct {
		id   any
		want string
	}{{a["id"], "sk_weekly"}, {b["id"], "sk_weekly"}} {
		w := do(s, "GET", "/api/agents/"+c.id.(string), "")
		sk := envelopeData(t, w)["skills"].([]any)
		if len(sk) != 1 || sk[0] != c.want {
			t.Errorf("Agent %v 的技能 = %v", c.id, sk)
		}
	}
	mustCode(t, do(s, "GET", "/api/skills/"+id, ""), http.StatusNotFound, "get deleted")
	mustCode(t, do(s, "DELETE", "/api/skills/"+id, ""), http.StatusNotFound, "delete again")

	w = do(s, "GET", "/api/audits?target_type=skill", "")
	mustCode(t, w, http.StatusOK, "audits")
	if n := len(decodeEnvelope(t, w)["data"].([]any)); n != 2 {
		t.Errorf("审计 %d 条，期望新建、删除两条", n)
	}
}
