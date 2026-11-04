package sqlite

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

func mustSession(t *testing.T, s *Store, ctx context.Context, title string) *domain.AgentSession {
	t.Helper()
	sess, err := s.CreateAgentSession(ctx, &domain.AgentSession{
		Title: title, ProviderID: "apv_x", Model: "qwen3.5:4b", Workdir: "/tmp/out",
	})
	if err != nil {
		t.Fatalf("建会话 %s: %v", title, err)
	}
	return sess
}

func TestCreateAgentSessionDefaults(t *testing.T) {
	s, ctx := newStore(t)

	sess, err := s.CreateAgentSession(ctx, &domain.AgentSession{})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	if sess.ID == "" {
		t.Error("应当生成 id")
	}
	// 空标题要有个能在侧栏显示的兜底，否则列表里是一排空行。
	if sess.Title != "新对话" {
		t.Errorf("默认标题 = %q", sess.Title)
	}
	if sess.MessageCount != 0 {
		t.Errorf("新会话消息数 = %d，期望 0", sess.MessageCount)
	}
	if sess.CreatedAt.IsZero() || sess.UpdatedAt.IsZero() {
		t.Error("时间戳没填")
	}
}

func TestGetAgentSessionNotFound(t *testing.T) {
	s, ctx := newStore(t)
	_, err := s.GetAgentSession(ctx, "ags_nope")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，得到 %v", err)
	}
}

// TestAppendAgentMessageTouchesSession 盯的是会话列表的排序依据：
// 追加消息必须把 updated_at 推上去，否则刚聊过的会话会沉在列表底部。
func TestAppendAgentMessageTouchesSession(t *testing.T) {
	s, ctx := newStore(t)
	older := mustSession(t, s, ctx, "先建的")
	newer := mustSession(t, s, ctx, "后建的")

	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: older.ID, Role: domain.RoleUser, Content: "在吗",
	}); err != nil {
		t.Fatalf("追加消息: %v", err)
	}

	list, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true})
	if err != nil {
		t.Fatalf("列会话: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("会话数 = %d", len(list))
	}
	if list[0].ID != older.ID {
		t.Errorf("刚收到消息的会话应排在最前，实际首位是 %q", list[0].Title)
	}
	if list[0].MessageCount != 1 {
		t.Errorf("消息数 = %d，期望 1", list[0].MessageCount)
	}
	if list[1].ID != newer.ID || list[1].MessageCount != 0 {
		t.Errorf("第二条 = %+v", list[1])
	}
}

func TestAppendAgentMessageValidates(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: "ags_nope", Role: domain.RoleUser,
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("不存在的会话应报 ErrNotFound，得到 %v", err)
	}
	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: sess.ID, Role: "robot",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("非法 role 应报 ErrValidation，得到 %v", err)
	}
	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: sess.ID,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("空 role 应报 ErrValidation，得到 %v", err)
	}
}

// TestListAgentMessagesOrderAndLimit 确认 limit 取的是「最近 N 条」但仍按正序返回。
func TestListAgentMessagesOrderAndLimit(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	want := []string{"第一句", "第二句", "第三句", "第四句"}
	for _, c := range want {
		if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: sess.ID, Role: domain.RoleUser, Content: c,
		}); err != nil {
			t.Fatalf("追加 %s: %v", c, err)
		}
	}

	all, err := s.ListAgentMessages(ctx, sess.ID, 0)
	if err != nil {
		t.Fatalf("列消息: %v", err)
	}
	for i, m := range all {
		if m.Content != want[i] {
			t.Fatalf("第 %d 条 = %q，期望 %q", i, m.Content, want[i])
		}
	}

	// limit=2 要拿到最后两条，且仍是正序。
	recent, err := s.ListAgentMessages(ctx, sess.ID, 2)
	if err != nil {
		t.Fatalf("列最近消息: %v", err)
	}
	if len(recent) != 2 || recent[0].Content != "第三句" || recent[1].Content != "第四句" {
		t.Fatalf("limit=2 得到 %v", contents(recent))
	}
}

func TestAgentMessageKeepsToolFields(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: sess.ID, Role: domain.RoleTool,
		Content: "已创建 TSK-0001", ToolName: "create_object",
		ToolArgs: `{"type_id":"task","title":"对账"}`,
	}); err != nil {
		t.Fatalf("追加工具消息: %v", err)
	}

	got, err := s.ListAgentMessages(ctx, sess.ID, 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("列消息: %v (%d 条)", err, len(got))
	}
	m := got[0]
	if m.ToolName != "create_object" || m.ToolArgs == "" {
		t.Errorf("工具字段丢了: %+v", m)
	}
}

// TestDeleteAgentSessionCascades 是这张 schema 的核心约束，0012 之后它变成了两条：
// 消息必须跟着删（没有会话的消息是孤儿），产物必须**留下**（session_id 置空）。
//
// 产物这一条是反的，而且是有意的。0007 时产物是会话的附属物，一起删说得通；
// 现在产物指向的是磁盘上真实存在的文件或云端真实存在的页面，
// 删掉一段对话不该让那个文件从产物清单里消失——那一行往往是它在本机唯一的索引。
func TestDeleteAgentSessionCascades(t *testing.T) {
	s, ctx := newStore(t)
	target := mustSession(t, s, ctx, "要删的")
	keep := mustSession(t, s, ctx, "要留的")

	for _, sess := range []*domain.AgentSession{target, keep} {
		if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: sess.ID, Role: domain.RoleUser, Content: "你好",
		}); err != nil {
			t.Fatalf("追加消息: %v", err)
		}
		sid := sess.ID
		if _, err := s.RecordArtifact(ctx, domain.ArtifactInput{
			SessionID: &sid, Path: "报告.md", BaseDir: "/tmp/wd-" + sess.ID,
			Size: 12, Source: domain.ArtifactSourceAgent,
		}); err != nil {
			t.Fatalf("记产物: %v", err)
		}
	}

	if err := s.DeleteAgentSession(ctx, target.ID); err != nil {
		t.Fatalf("删会话: %v", err)
	}

	if _, err := s.GetAgentSession(ctx, target.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("会话应已删除，得到 %v", err)
	}
	// 直接查底表：走 ListAgentMessages 的话，会话没了也可能只是返回空。
	var orphanMsgs int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE session_id = ?`, target.ID).Scan(&orphanMsgs); err != nil {
		t.Fatalf("查 agent_messages: %v", err)
	}
	if orphanMsgs != 0 {
		t.Errorf("agent_messages 残留 %d 行孤儿数据", orphanMsgs)
	}

	// 产物这边查的是「还在不在」以及「有没有被解绑」，两个都要查。
	// 只查行数的话，一个漏配成 CASCADE 的外键会让它变 0 而测试仍然能过——
	// 因为「产物还在」这句话没有被断言，只有「消息没了」被断言了。
	var keptArts, stillBound int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*),
		COALESCE(SUM(CASE WHEN session_id IS NOT NULL THEN 1 ELSE 0 END), 0)
		FROM artifacts WHERE path LIKE ?`, "/tmp/wd-"+target.ID+"%").Scan(&keptArts, &stillBound); err != nil {
		t.Fatalf("查 artifacts: %v", err)
	}
	if keptArts != 1 {
		t.Errorf("删会话后产物应保留 1 条，得到 %d 条", keptArts)
	}
	if stillBound != 0 {
		t.Errorf("产物的 session_id 应被置空，仍有 %d 条绑着已删除的会话", stillBound)
	}

	// 另一个会话必须毫发无损。
	msgs, err := s.ListAgentMessages(ctx, keep.ID, 0)
	if err != nil || len(msgs) != 1 {
		t.Errorf("另一个会话的消息被误删: %v (%d 条)", err, len(msgs))
	}
	arts, _, err := s.ListArtifacts(ctx, domain.ArtifactFilter{SessionID: keep.ID})
	if err != nil || len(arts) != 1 {
		t.Errorf("另一个会话的产物被误删: %v (%d 条)", err, len(arts))
	}
}

func TestDeleteAgentSessionNotFound(t *testing.T) {
	s, ctx := newStore(t)
	if err := s.DeleteAgentSession(ctx, "ags_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，得到 %v", err)
	}
}

func TestUpdateAgentSession(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "原标题")

	title, workdir := "新标题", "/tmp/新目录"
	out, err := s.UpdateAgentSession(ctx, sess.ID, &title, &workdir, nil, nil)
	if err != nil {
		t.Fatalf("改会话: %v", err)
	}
	if out.Title != "新标题" || out.Workdir != "/tmp/新目录" {
		t.Errorf("改后 = %+v", out)
	}
	// 没传的字段不能被清掉。
	if out.Model != "qwen3.5:4b" || out.ProviderID != "apv_x" {
		t.Errorf("未传的字段被改动了: %+v", out)
	}

	// 空标题要被忽略，不能把会话改成无标题。
	empty := "   "
	out, err = s.UpdateAgentSession(ctx, sess.ID, &empty, nil, nil, nil)
	if err != nil {
		t.Fatalf("改会话: %v", err)
	}
	if out.Title != "新标题" {
		t.Errorf("空标题不该覆盖原标题，得到 %q", out.Title)
	}

	// workdir 允许被显式清空：用户可以取消产物目录。
	blank := ""
	out, err = s.UpdateAgentSession(ctx, sess.ID, nil, &blank, nil, nil)
	if err != nil {
		t.Fatalf("清 workdir: %v", err)
	}
	if out.Workdir != "" {
		t.Errorf("workdir 应可清空，得到 %q", out.Workdir)
	}

	if _, err := s.UpdateAgentSession(ctx, "ags_nope", &title, nil, nil, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("期望 ErrNotFound，得到 %v", err)
	}
}

func contents(msgs []*domain.AgentMessage) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = m.Content
	}
	return out
}

// TestAppendAgentMessagePreservesOrderWithinSameInstant 是对话框最直接可见的一条约束：
// 连续追加不加任何间隔，读回来的顺序必须和写入顺序完全一致。
//
// 顺序错乱在界面上表现为「回复出现在提问前面」或「工具结果先后颠倒」，
// 而且不报任何错，只会让人以为模型疯了——所以要在最坏情况（同一毫秒内连写）下钉死它。
func TestAppendAgentMessagePreservesOrderWithinSameInstant(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	// 不加 sleep，尽可能撞进同一毫秒。
	want := []string{"第一条", "第二条", "第三条", "第四条", "第五条"}
	for _, c := range want {
		if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: sess.ID, Role: domain.RoleUser, Content: c,
		}); err != nil {
			t.Fatalf("追加 %s: %v", c, err)
		}
	}

	got, err := s.ListAgentMessages(ctx, sess.ID, 0)
	if err != nil {
		t.Fatalf("列消息: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("消息数 = %d，期望 %d", len(got), len(want))
	}
	for i, m := range got {
		if m.Content != want[i] {
			t.Fatalf("第 %d 条 = %q，期望 %q（完整顺序 %v）", i, m.Content, want[i], contents(got))
		}
	}

	// 倒序取最近 N 条那层走的是另一个查询分支，同样要稳。
	recent, err := s.ListAgentMessages(ctx, sess.ID, 3)
	if err != nil {
		t.Fatalf("列最近消息: %v", err)
	}
	if len(recent) != 3 {
		t.Fatalf("limit=3 得到 %d 条", len(recent))
	}
	for i, wantC := range want[2:] {
		if recent[i].Content != wantC {
			t.Fatalf("limit 分支第 %d 条 = %q，期望 %q（完整 %v）",
				i, recent[i].Content, wantC, contents(recent))
		}
	}
}

// TestListAgentMessagesRejectsMissingSession 守读写一致：
// 写接口对不存在的会话报 ErrNotFound，读接口不能反而安静地回一个空列表——
// 那会把「会话没了」显示成「会话是空的」，用户会以为消息丢了。
//
// 产物那一半 0012 之后不在这里了：ListArtifacts 是个通用过滤器，
// 「按某个会话过滤」只是它的一种用法，让它去校验会话存在性等于把
// 一个无关的前置条件塞进所有调用方。同一个保证移到了 API 层——
// handleListAgentArtifacts 先 GetAgentSession 再查，见 internal/api/agent.go。
// 这不是把保证丢了，是换了个地方；换地方这件事本身要写下来，
// 否则下一个人会以为它消失了，或者以为它还在这里。
func TestListAgentMessagesRejectsMissingSession(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.ListAgentMessages(ctx, "ags_nope", 0); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("列不存在会话的消息应报 ErrNotFound，得到 %v", err)
	}

	// 存在但是空的会话，仍然要正常返回空列表（这不是错误）。
	sess := mustSession(t, s, ctx, "空会话")
	msgs, err := s.ListAgentMessages(ctx, sess.ID, 0)
	if err != nil || len(msgs) != 0 {
		t.Errorf("空会话应返回空列表: %v (%d 条)", err, len(msgs))
	}
}

// TestListAgentSessionsOrderWithinSameInstant 钉住会话列表的排序：
// 连续建会话不加间隔，列表必须是创建顺序的倒序（最近活跃在最前）。
//
// 这条和消息那条是同一类问题：秒级时间戳 + idgen 同毫秒内的随机低位，
// 会让「同刻创建的两个会话」顺序随机。用户快速连建两个会话时，下拉里的先后会乱。
func TestListAgentSessionsOrderWithinSameInstant(t *testing.T) {
	s, ctx := newStore(t)

	// 不加 sleep，尽可能撞进同一毫秒。
	var created []*domain.AgentSession
	for _, title := range []string{"第一个", "第二个", "第三个"} {
		created = append(created, mustSession(t, s, ctx, title))
	}

	got, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true})
	if err != nil {
		t.Fatalf("列会话: %v", err)
	}
	if len(got) != len(created) {
		t.Fatalf("会话数 = %d，期望 %d", len(got), len(created))
	}
	// 最近活跃在最前，所以是创建顺序的倒序。
	for i, want := range []string{"第三个", "第二个", "第一个"} {
		if got[i].Title != want {
			titles := make([]string, len(got))
			for j, g := range got {
				titles[j] = g.Title
			}
			t.Fatalf("第 %d 条 = %q，期望 %q（完整顺序 %v）", i, got[i].Title, want, titles)
		}
	}
}

// --- 会话归属 ---

// mustObjectSession 建一条挂在某个工作对象上的会话。
func mustObjectSession(t *testing.T, s *Store, ctx context.Context, title, objectID string) *domain.AgentSession {
	t.Helper()
	sess, err := s.CreateAgentSession(ctx, &domain.AgentSession{
		Title: title, ObjectID: &objectID, ProviderID: "apv_x", Model: "qwen3.5:4b",
	})
	if err != nil {
		t.Fatalf("建对象会话 %s: %v", title, err)
	}
	return sess
}

// TestListAgentSessionsByFilter 是这条改动的核心约束：三批会话各回各家。
//
// 把「全局的」漏进某个对象的抽屉，或者把 A 对象的对话漏进 B 的，界面上都表现为
// 「有内容，但不是这里该有的内容」——用户看不出这是 bug，只会以为自己记错了。
func TestListAgentSessionsByFilter(t *testing.T) {
	s, ctx := newStore(t)
	a := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "对象 A"})
	b := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "对象 B"})

	onA := mustObjectSession(t, s, ctx, "A 的对话", a.ID)
	mustObjectSession(t, s, ctx, "B 的对话", b.ID)
	global := mustSession(t, s, ctx, "底部对话框聊的")

	// 按对象取：只有那个对象的。
	got, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: a.ID})
	if err != nil {
		t.Fatalf("按对象列会话: %v", err)
	}
	if len(got) != 1 || got[0].ID != onA.ID {
		t.Fatalf("object_id=%s 应当只拿到 A 的那条，得到 %v", a.ID, sessionTitles(got))
	}
	if got[0].ObjectID == nil || *got[0].ObjectID != a.ID {
		t.Errorf("读路径没把 object_id 带出来: %v", got[0].ObjectID)
	}

	// 取全局：只有 object_id IS NULL 的，两条对象会话都不该出现。
	got, err = s.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true})
	if err != nil {
		t.Fatalf("列全局会话: %v", err)
	}
	if len(got) != 1 || got[0].ID != global.ID {
		t.Fatalf("unscoped 应当只拿到全局那条，得到 %v", sessionTitles(got))
	}
	if got[0].ObjectID != nil {
		t.Errorf("全局会话的 object_id 应为 nil，得到 %q", *got[0].ObjectID)
	}

	// 两个都不给：零条，不是全部。这是故意反直觉的默认值，见 store.ListAgentSessions。
	got, err = s.ListAgentSessions(ctx, domain.AgentSessionFilter{})
	if err != nil {
		t.Fatalf("空 filter: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("空 filter 应返回零条，得到 %v", sessionTitles(got))
	}
	if got == nil {
		t.Error("空结果要是空切片而不是 nil，调用方直接 range 不该分两种写法")
	}
}

// TestListAgentSessionsFilterKeepsMessageCount 确认加了 WHERE 之后消息数还是对的
// ——过滤条件和 LEFT JOIN 聚合放在一起，写错位置（比如挪进 ON）就会把计数带偏。
func TestListAgentSessionsFilterKeepsMessageCount(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "对象"})
	sess := mustObjectSession(t, s, ctx, "带消息的", obj.ID)
	for _, content := range []string{"在吗", "在"} {
		if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
			SessionID: sess.ID, Role: domain.RoleUser, Content: content,
		}); err != nil {
			t.Fatalf("追加消息: %v", err)
		}
	}
	empty := mustObjectSession(t, s, ctx, "没消息的", obj.ID)

	got, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj.ID})
	if err != nil {
		t.Fatalf("列会话: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("会话数 = %d，期望 2", len(got))
	}
	counts := map[string]int{}
	for _, g := range got {
		counts[g.ID] = g.MessageCount
	}
	if counts[sess.ID] != 2 {
		t.Errorf("有消息的那条计数 = %d，期望 2", counts[sess.ID])
	}
	if counts[empty.ID] != 0 {
		t.Errorf("没消息的那条计数 = %d，期望 0", counts[empty.ID])
	}
}

// TestCreateAgentSessionUnknownObject：挂给一个不存在的对象要报 404 而不是 500。
// 靠外键去挡的话，回的是一条驱动层字符串，映射出来是 500。
func TestCreateAgentSessionUnknownObject(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.CreateAgentSession(ctx, &domain.AgentSession{
		Title: "挂给幽灵", ObjectID: pstr("obj_nope"),
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("不存在的对象应报 ErrNotFound，得到 %v", err)
	}
}

// TestCreateAgentSessionBlankObjectIsGlobal：空串和不传一样，都是全局会话。
// 落成空字符串的话它既不在任何对象的抽屉里，也不在全局列表里——彻底查不到。
func TestCreateAgentSessionBlankObjectIsGlobal(t *testing.T) {
	s, ctx := newStore(t)
	sess, err := s.CreateAgentSession(ctx, &domain.AgentSession{Title: "空串", ObjectID: pstr("  ")})
	if err != nil {
		t.Fatalf("建会话: %v", err)
	}
	if sess.ObjectID != nil {
		t.Errorf("空串应当落成 nil，得到 %q", *sess.ObjectID)
	}
	got, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{Unscoped: true})
	if err != nil || len(got) != 1 || got[0].ID != sess.ID {
		t.Errorf("空串建的会话应当出现在全局列表里: %v (%d 条)", err, len(got))
	}
}

// TestHardDeleteObjectCascadesSessions 钉住 0011 的 ON DELETE CASCADE：
// 硬删对象带走它的会话，别的对象与全局会话一条都不能少。
func TestHardDeleteObjectCascadesSessions(t *testing.T) {
	s, ctx := newStore(t)
	target := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "要删的"})
	keep := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "留着的"})

	doomed := mustObjectSession(t, s, ctx, "要删对象的对话", target.ID)
	survivor := mustObjectSession(t, s, ctx, "另一个对象的对话", keep.ID)
	global := mustSession(t, s, ctx, "全局的")
	// 会话下面的消息也得一起走，否则留下一批指向不存在会话的孤儿。
	if _, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{
		SessionID: doomed.ID, Role: domain.RoleUser, Content: "这条也该消失",
	}); err != nil {
		t.Fatalf("追加消息: %v", err)
	}

	if err := s.DeleteObject(ctx, target.ID, true, store.DefaultActor); err != nil {
		t.Fatalf("硬删对象: %v", err)
	}

	if _, err := s.GetAgentSession(ctx, doomed.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("对象硬删后它的会话应当一起消失，得到 %v", err)
	}
	var orphans int
	if err := s.db.R.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM agent_messages WHERE session_id = ?`, doomed.ID).Scan(&orphans); err != nil {
		t.Fatalf("查孤儿消息: %v", err)
	}
	if orphans != 0 {
		t.Errorf("会话级联删掉后还剩 %d 条消息", orphans)
	}
	if _, err := s.GetAgentSession(ctx, survivor.ID); err != nil {
		t.Errorf("别的对象的会话被误删: %v", err)
	}
	if _, err := s.GetAgentSession(ctx, global.ID); err != nil {
		t.Errorf("全局会话被误删: %v", err)
	}
}

// TestSoftDeleteObjectKeepsSessions：软删（进回收站）不动会话。
// 从回收站恢复回来对话还在——这正是 0011 注释里区分软硬删的那条取舍。
func TestSoftDeleteObjectKeepsSessions(t *testing.T) {
	s, ctx := newStore(t)
	obj := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "进回收站的"})
	sess := mustObjectSession(t, s, ctx, "它的对话", obj.ID)

	if err := s.DeleteObject(ctx, obj.ID, false, store.DefaultActor); err != nil {
		t.Fatalf("软删对象: %v", err)
	}
	if _, err := s.GetAgentSession(ctx, sess.ID); err != nil {
		t.Errorf("软删不该动会话: %v", err)
	}
	got, err := s.ListAgentSessions(ctx, domain.AgentSessionFilter{ObjectID: obj.ID})
	if err != nil || len(got) != 1 {
		t.Errorf("软删后按对象仍应列出它的会话: %v (%d 条)", err, len(got))
	}

	if _, err := s.RestoreObject(ctx, obj.ID, store.DefaultActor); err != nil {
		t.Fatalf("恢复对象: %v", err)
	}
	if _, err := s.GetAgentSession(ctx, sess.ID); err != nil {
		t.Errorf("恢复后会话应当还在: %v", err)
	}
}

func sessionTitles(list []*domain.AgentSession) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s.Title
	}
	return out
}

func TestDeleteAgentMessages(t *testing.T) {
	s, ctx := newStore(t)
	a := mustSession(t, s, ctx, "a")
	b := mustSession(t, s, ctx, "b")
	var ids []string
	for _, c := range []string{"一", "二", "三"} {
		m, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: a.ID, Role: domain.RoleUser, Content: c})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.ID)
	}
	ob, err := s.AppendAgentMessage(ctx, &domain.AgentMessage{SessionID: b.ID, Role: domain.RoleUser, Content: "别处"})
	if err != nil {
		t.Fatal(err)
	}
	n, err := s.DeleteAgentMessages(ctx, a.ID, []string{ids[0], ids[2], ob.ID})
	if err != nil || n != 2 {
		t.Fatalf("删 = %d, %v；期望 2", n, err)
	}
	left, _ := s.ListAgentMessages(ctx, a.ID, 0)
	if len(left) != 1 || left[0].Content != "二" {
		t.Errorf("剩下 = %+v", left)
	}
	if lb, _ := s.ListAgentMessages(ctx, b.ID, 0); len(lb) != 1 {
		t.Errorf("别的会话不该动：%d", len(lb))
	}
	if _, err := s.DeleteAgentMessages(ctx, "ags_nope", []string{"x"}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("会话不存在应 not found：%v", err)
	}
}
