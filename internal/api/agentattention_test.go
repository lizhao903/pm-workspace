// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// fakeStore 只为满足 store.Store；等确认聚合接口的测试用真库（本文件），替身没有待确认的调用。
func (f *fakeStore) ListPendingToolCalls(context.Context, string) ([]*store.AgentToolCall, error) {
	return []*store.AgentToolCall{}, nil
}

// newAttentionServer 用真库起一个只有等确认聚合接口要用的服务，不挂路由，直接调 handler。
func newAttentionServer(t *testing.T) (*Server, *sqlite.Store) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(st, Options{Version: "test", Logger: log}), st
}

// attentionFixture 建好两个 Agent、两个会话，测试里按需往里加等确认的调用和等确认的执行记录。
type attentionFixture struct {
	st       *sqlite.Store
	srv      *Server
	agentA   *domain.Agent
	agentB   *domain.Agent
	sessionA *domain.AgentSession
	sessionB *domain.AgentSession
}

func newAttentionFixture(t *testing.T) *attentionFixture {
	t.Helper()
	srv, st := newAttentionServer(t)
	ctx := context.Background()
	p, err := st.CreateProvider(ctx, &domain.AgentProvider{
		Name: "本机", Kind: domain.ProviderOllama, BaseURL: "http://127.0.0.1:9", Model: "test-model", Enabled: true,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	mkAgent := func(name string) *domain.Agent {
		t.Helper()
		a, err := st.CreateAgent(ctx, domain.AgentInput{Name: &name, ProviderID: &p.ID})
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	mkSession := func(title string, ag *domain.Agent) *domain.AgentSession {
		t.Helper()
		sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{
			Title: title, ProviderID: p.ID, Model: p.Model, AgentID: &ag.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		return sess
	}
	f := &attentionFixture{st: st, srv: srv, agentA: mkAgent("分诊助手"), agentB: mkAgent("周报助手")}
	f.sessionA = mkSession("会话甲", f.agentA)
	f.sessionB = mkSession("会话乙", f.agentB)
	return f
}

func (f *attentionFixture) pending(t *testing.T, ag *domain.Agent, sess *domain.AgentSession, callID, tool, args string) *store.AgentToolCall {
	t.Helper()
	c, err := f.st.CreateAgentToolCall(context.Background(), &store.AgentToolCall{
		AgentID: ag.ID, SessionID: &sess.ID, CallID: callID, Tool: tool, GrantKey: "write_tasks", Args: args,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// waitingRun 建一条停在等确认的执行记录；startedAt 由库填当前时间。
func (f *attentionFixture) waitingRun(t *testing.T, ag *domain.Agent, sess *domain.AgentSession, trigger string) *store.AgentRun {
	t.Helper()
	ctx := context.Background()
	run, err := f.st.CreateAgentRun(ctx, &store.AgentRun{
		AgentID: ag.ID, TriggerKind: "task", Trigger: trigger, SessionID: &sess.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err = f.st.FinishAgentRun(ctx, run.ID, store.AgentRunWaiting, "等确认")
	if err != nil {
		t.Fatal(err)
	}
	return run
}

// callAttention 直接调 handler，把 data 解成响应结构；返回录制器给需要看原文的用例。
func callAttention(t *testing.T, s *Server, target string) (agentAttention, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleAgentAttention(w, httptest.NewRequest(http.MethodGet, target, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	var env struct {
		Data agentAttention `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应体不是合法 JSON：%v", err)
	}
	return env.Data, w
}

// 验收：没有待确认时 pending_calls / waiting_runs 都是 []，不是 null，total 为 0。
func TestAgentAttentionEmpty(t *testing.T) {
	_, st := newAttentionServer(t)
	s := New(st, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	out, w := callAttention(t, s, "/api/agent/attention")
	if out.Total != 0 {
		t.Errorf("total = %d，期望 0", out.Total)
	}
	if out.PendingCalls == nil || len(out.PendingCalls) != 0 {
		t.Errorf("pending_calls 应是空数组，得到 %#v", out.PendingCalls)
	}
	if out.WaitingRuns == nil || len(out.WaitingRuns) != 0 {
		t.Errorf("waiting_runs 应是空数组，得到 %#v", out.WaitingRuns)
	}
	// JSON null 会被解成 nil；这里再确认一遍原文里确实是 []
	if body := w.Body.String(); !strings.Contains(body, `"pending_calls":[]`) || !strings.Contains(body, `"waiting_runs":[]`) {
		t.Fatalf("空结果应编码成 []，得到 %s", body)
	}
}

// 验收：全量返回、名字和会话标题补齐、按契约排序、已决定的不出现。
func TestAgentAttentionAll(t *testing.T) {
	f := newAttentionFixture(t)
	c1 := f.pending(t, f.agentA, f.sessionA, "call_1", "update_object", `{"ref":"TSK-1"}`)
	c2 := f.pending(t, f.agentA, f.sessionA, "call_2", "create_object", `{"type_id":"task","title":"开通试点账号"}`)
	c3 := f.pending(t, f.agentB, f.sessionB, "call_3", "write_file", `{"path":"/tmp/out.md"}`)
	decided, err := f.st.CreateAgentToolCall(context.Background(), &store.AgentToolCall{
		AgentID: f.agentA.ID, SessionID: &f.sessionA.ID, CallID: "call_x", Tool: "update_object",
		GrantKey: "write_tasks", Args: `{"ref":"TSK-2"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.DecideAgentToolCall(context.Background(), decided.ID, store.ToolCallConfirmed); err != nil {
		t.Fatal(err)
	}

	waitA := f.waitingRun(t, f.agentA, f.sessionA, "任务分配给它 · TSK-1")
	time.Sleep(3 * time.Millisecond) // started_at 只到毫秒，拉开两条执行记录的顺序
	waitB := f.waitingRun(t, f.agentB, f.sessionB, "任务分配给它 · TSK-2")
	done, err := f.st.CreateAgentRun(context.Background(), &store.AgentRun{
		AgentID: f.agentA.ID, TriggerKind: "task", Trigger: "任务分配给它 · TSK-3", SessionID: &f.sessionA.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.FinishAgentRun(context.Background(), done.ID, store.AgentRunDone, "做完了"); err != nil {
		t.Fatal(err)
	}

	out, _ := callAttention(t, f.srv, "/api/agent/attention")
	if out.Total != 3 || len(out.PendingCalls) != 3 {
		t.Fatalf("total = %d，pending_calls = %d，期望都是 3", out.Total, len(out.PendingCalls))
	}
	if got := out.PendingCalls[0]; got.CallID != c1.ID || got.AgentName != "分诊助手" ||
		got.SessionTitle != "会话甲" || got.SessionID != f.sessionA.ID || got.Tool != "update_object" ||
		got.Args != `{"ref":"TSK-1"}` || got.Summary != "修改 TSK-1" || got.At.IsZero() {
		t.Fatalf("第一条待确认 = %+v", got)
	}
	if got := out.PendingCalls[1]; got.CallID != c2.ID || got.Summary != "新建「开通试点账号」" {
		t.Fatalf("第二条待确认 = %+v", got)
	}
	if got := out.PendingCalls[2]; got.CallID != c3.ID || got.AgentName != "周报助手" ||
		got.SessionTitle != "会话乙" || got.Summary != "写文件 /tmp/out.md" {
		t.Fatalf("第三条待确认 = %+v", got)
	}

	if len(out.WaitingRuns) != 2 {
		t.Fatalf("waiting_runs = %+v，期望 2 条", out.WaitingRuns)
	}
	if got := out.WaitingRuns[0]; got.RunID != waitA.ID || got.AgentName != "分诊助手" ||
		got.Trigger != "任务分配给它 · TSK-1" || got.SessionTitle != "会话甲" ||
		got.SessionID != f.sessionA.ID || got.Since.IsZero() {
		t.Fatalf("第一条等确认执行 = %+v", got)
	}
	if got := out.WaitingRuns[1]; got.RunID != waitB.ID || got.AgentName != "周报助手" || got.SessionTitle != "会话乙" {
		t.Fatalf("第二条等确认执行 = %+v", got)
	}
}

// 验收：session_id 查询参数只回这个会话的待确认调用和等确认执行。
func TestAgentAttentionSessionFilter(t *testing.T) {
	f := newAttentionFixture(t)
	f.pending(t, f.agentA, f.sessionA, "call_a", "update_object", `{"ref":"TSK-1"}`)
	want := f.pending(t, f.agentB, f.sessionB, "call_b", "write_file", `{"path":"/tmp/b.md"}`)
	f.waitingRun(t, f.agentA, f.sessionA, "任务分配给它 · TSK-1")
	wantRun := f.waitingRun(t, f.agentB, f.sessionB, "任务分配给它 · TSK-2")

	out, _ := callAttention(t, f.srv, "/api/agent/attention?session_id="+f.sessionB.ID)
	if out.Total != 1 || len(out.PendingCalls) != 1 || out.PendingCalls[0].CallID != want.ID {
		t.Fatalf("按会话筛后 pending_calls = %+v", out.PendingCalls)
	}
	if len(out.WaitingRuns) != 1 || out.WaitingRuns[0].RunID != wantRun.ID {
		t.Fatalf("按会话筛后 waiting_runs = %+v", out.WaitingRuns)
	}
	if out.PendingCalls[0].SessionTitle != "会话乙" || out.WaitingRuns[0].SessionTitle != "会话乙" {
		t.Fatalf("会话标题 = %q / %q", out.PendingCalls[0].SessionTitle, out.WaitingRuns[0].SessionTitle)
	}
}

// 验收：Agent 删了名字回空串，调用本身照常列出来（会话和回放都还在）。
func TestAgentAttentionDeletedAgent(t *testing.T) {
	f := newAttentionFixture(t)
	name := "临时助手"
	p, err := f.st.ListProviders(context.Background())
	if err != nil || len(p) == 0 {
		t.Fatalf("列服务商：%v，%v", p, err)
	}
	ag, err := f.st.CreateAgent(context.Background(), domain.AgentInput{Name: &name, ProviderID: &p[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := f.st.CreateAgentSession(context.Background(), &domain.AgentSession{
		Title: "会话丙", ProviderID: p[0].ID, Model: p[0].Model, AgentID: &ag.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	call := f.pending(t, ag, sess, "call_c", "update_object", `{"ref":"TSK-9"}`)
	if _, err := f.st.DeleteAgent(context.Background(), ag.ID); err != nil {
		t.Fatal(err)
	}

	out, _ := callAttention(t, f.srv, "/api/agent/attention?session_id="+sess.ID)
	if out.Total != 1 || len(out.PendingCalls) != 1 || out.PendingCalls[0].CallID != call.ID {
		t.Fatalf("删 Agent 后 pending_calls = %+v", out.PendingCalls)
	}
	if got := out.PendingCalls[0]; got.AgentID != ag.ID || got.AgentName != "" || got.SessionTitle != "会话丙" {
		t.Fatalf("删 Agent 后应该是空名字：%+v", got)
	}
}
