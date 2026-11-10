// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 会话归属与检索（S-1）+ 会话追加要求（S-2，0057） ---

// newSessionSearchStore 开一个临时库；会话、消息、项目对象都建在它上面。
func newSessionSearchStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st, ctx
}

func mkSession(t *testing.T, st *Store, ctx context.Context, title string, objectID *string) *domain.AgentSession {
	t.Helper()
	s, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: title, ObjectID: objectID})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mkMessage(t *testing.T, st *Store, ctx context.Context, sessionID, role, content string) *domain.AgentMessage {
	t.Helper()
	m, err := st.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: sessionID, Role: role, Content: content})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// q 搜标题和消息正文，ASCII 大小写不敏感，% 和 _ 按字面量；可和 object_id / unscoped 组合。
func TestListAgentSessionsSearch(t *testing.T) {
	st, ctx := newSessionSearchStore(t)
	o1, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "检索对象一"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	o2, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "检索对象二"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	obj := o1.ID
	byTitle := mkSession(t, st, ctx, "Deploy Checklist", &obj)
	byMessage := mkSession(t, st, ctx, "闲聊", &obj)
	mkMessage(t, st, ctx, byMessage.ID, domain.RoleUser, "帮我看看 DEPLOY 流程")
	byPercent := mkSession(t, st, ctx, "进度 100% 完成", &obj)
	mkSession(t, st, ctx, "进度 100x 完成", &obj)
	byUnderline := mkSession(t, st, ctx, "a_b 标题", &obj)
	mkSession(t, st, ctx, "axb 标题", &obj)
	otherObj := o2.ID
	mkSession(t, st, ctx, "Deploy 另一个对象", &otherObj)

	ids := func(items []*domain.AgentSession) map[string]bool {
		out := map[string]bool{}
		for _, s := range items {
			out[s.ID] = true
		}
		return out
	}

	// 大小写不敏感：标题命中和消息正文命中都算
	got, err := st.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj, Q: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	set := ids(got)
	if !set[byTitle.ID] || !set[byMessage.ID] || len(set) != 2 {
		t.Fatalf("q=deploy 命中 = %v，想要标题和消息各一条", set)
	}
	// 换一个 scope 也能用 q
	got, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true, Q: "deploy"})
	if len(got) != 0 {
		t.Fatalf("unscoped + q 只该看全局会话：%v", got)
	}
	// % 和 _ 是字面量，不是通配符
	got, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj, Q: "%"})
	if set := ids(got); len(set) != 1 || !set[byPercent.ID] {
		t.Fatalf("q=%% 命中 = %v，只该命中标题里带百分号的", set)
	}
	got, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj, Q: "_"})
	if set := ids(got); len(set) != 1 || !set[byUnderline.ID] {
		t.Fatalf("q=_ 命中 = %v，只该命中标题里带下划线的", set)
	}
	// 没命中
	got, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj, Q: "不存在的词"})
	if len(got) != 0 {
		t.Fatalf("不该有命中：%v", got)
	}
}

// project_id：挂在项目对象下的会话 ∪ props.session_ids 里列的会话；给了 project_id 时 unscoped 不算数。
func TestListAgentSessionsProject(t *testing.T) {
	st, ctx := newSessionSearchStore(t)
	project, err := st.CreateObject(ctx, &domain.Object{TypeID: projectTypeForTest, Title: "试点项目"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	proj := project.ID
	task, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "项目里的任务", ProjectID: &proj}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	inProject := mkSession(t, st, ctx, "任务会话", &task.ID)
	listed := mkSession(t, st, ctx, "项目页里的全局会话", nil)
	otherGlobal := mkSession(t, st, ctx, "别的全局会话", nil)
	otherTask, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "别的任务"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	otherObj := otherTask.ID
	otherProjectSession := mkSession(t, st, ctx, "别处的会话", &otherObj)

	items, err := st.ListAgentSessions(ctx, domain.AgentSessionFilter{
		ProjectID: project.ID, ProjectSessionIDs: []string{listed.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, s := range items {
		got[s.ID] = true
	}
	if !got[inProject.ID] || !got[listed.ID] || len(got) != 2 {
		t.Fatalf("项目会话 = %v，想要对象归属的 + 列出来的", got)
	}
	if got[otherGlobal.ID] || got[otherProjectSession.ID] {
		t.Fatalf("不该带别的会话：%v", got)
	}
	// unscoped 给了也不算数
	items, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{
		Unscoped: true, ProjectID: project.ID, ProjectSessionIDs: []string{listed.ID},
	})
	if len(items) != 2 {
		t.Fatalf("给了 project_id 时 unscoped 应被忽略：%d", len(items))
	}
	// 没有 session_ids 的旧项目：只按对象归属
	items, _ = st.ListAgentSessions(ctx, domain.AgentSessionFilter{ProjectID: project.ID})
	if len(items) != 1 || items[0].ID != inProject.ID {
		t.Fatalf("没有 session_ids 时 = %v", items)
	}
}

// 一个 scope 都不给仍是零条，哪怕给了 q。
func TestListAgentSessionsRequiresScope(t *testing.T) {
	st, ctx := newSessionSearchStore(t)
	mkSession(t, st, ctx, "全局会话", nil)
	items, err := st.ListAgentSessions(ctx, domain.AgentSessionFilter{Q: "全局"})
	if err != nil || len(items) != 0 {
		t.Fatalf("没有 scope 应回空列表：%v，%v", items, err)
	}
}

// 列表项带最后一条消息：正文截前 200 字，时间是最后一条消息的时间；没有消息为空。
func TestListAgentSessionsLastMessage(t *testing.T) {
	st, ctx := newSessionSearchStore(t)
	o, err := st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: "最后消息对象"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	obj := o.ID
	withMsg := mkSession(t, st, ctx, "有消息", &obj)
	mkMessage(t, st, ctx, withMsg.ID, domain.RoleUser, "第一条")
	long := strings.Repeat("字", 250)
	last := mkMessage(t, st, ctx, withMsg.ID, domain.RoleAssistant, long)
	empty := mkSession(t, st, ctx, "没有消息", &obj)

	items, err := st.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]*domain.AgentSession{}
	for _, s := range items {
		byID[s.ID] = s
	}
	got := byID[withMsg.ID]
	if got == nil {
		t.Fatal("没读到有消息的会话")
	}
	if n := len([]rune(got.LastMessage)); n != 200 {
		t.Fatalf("last_message 应截到 200 字，实际 %d：%q", n, got.LastMessage[:20])
	}
	if !strings.HasPrefix(got.LastMessage, "字") {
		t.Fatalf("last_message 应是最后一条：%q", got.LastMessage)
	}
	if got.LastMessageAt.IsZero() || got.LastMessageAt.Sub(last.CreatedAt).Abs() > time.Second {
		t.Fatalf("last_message_at = %v，想要 %v", got.LastMessageAt, last.CreatedAt)
	}
	if e := byID[empty.ID]; e == nil || e.LastMessage != "" || !e.LastMessageAt.IsZero() {
		t.Fatalf("没有消息的会话 = %+v，想要空串和零值", e)
	}
}

// 会话追加要求（S-2）：建时带上、单独改、空串清空；改标题不影响它。
func TestAgentSessionInstruction(t *testing.T) {
	st, ctx := newSessionSearchStore(t)
	sess, err := st.CreateAgentSession(ctx, &domain.AgentSession{Title: "带要求的会话", Instruction: "这次只讨论前端"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.GetAgentSession(ctx, sess.ID)
	if err != nil || got.Instruction != "这次只讨论前端" {
		t.Fatalf("建时带上 = %+v，%v", got, err)
	}
	// 列表也带（会话列表项可能展示）
	items, err := st.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true})
	if err != nil || len(items) != 1 || items[0].Instruction != "这次只讨论前端" {
		t.Fatalf("列表 instruction = %+v，%v", items, err)
	}

	updated, err := st.SetAgentSessionInstruction(ctx, sess.ID, "  改成只讨论后端  ")
	if err != nil || updated.Instruction != "改成只讨论后端" {
		t.Fatalf("改 = %+v，%v", updated, err)
	}
	// 改标题不丢追加要求（UpdateAgentSession 的回读也跟着 sessionSelect）
	title := "新标题"
	if _, err := st.UpdateAgentSession(ctx, sess.ID, &title, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = st.GetAgentSession(ctx, sess.ID)
	if got.Title != "新标题" || got.Instruction != "改成只讨论后端" {
		t.Fatalf("改标题后 = %+v", got)
	}
	// 空串清空
	if _, err := st.SetAgentSessionInstruction(ctx, sess.ID, ""); err != nil {
		t.Fatal(err)
	}
	got, _ = st.GetAgentSession(ctx, sess.ID)
	if got.Instruction != "" {
		t.Fatalf("清空失败：%q", got.Instruction)
	}
	// 会话不存在
	if _, err := st.SetAgentSessionInstruction(ctx, "ags_nope", "x"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("不存在的会话 = %v", err)
	}
}

// projectTypeForTest 是内置项目类型 id，测试里建项目对象用。
const projectTypeForTest = "project"
