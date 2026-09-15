package sqlite

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
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

	list, err := s.ListAgentSessions(ctx)
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

// TestDeleteAgentSessionCascades 是这张 schema 的核心约束：
// 删会话必须把消息和产物一起带走，留下孤儿行会让后续的会话统计全错。
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
		if _, err := s.RecordAgentArtifact(ctx, &domain.AgentArtifact{
			SessionID: sess.ID, Path: "报告.md", Size: 12,
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
	for _, tbl := range []string{"agent_messages", "agent_artifacts"} {
		var n int
		if err := s.db.R.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM `+tbl+` WHERE session_id = ?`, target.ID).Scan(&n); err != nil {
			t.Fatalf("查 %s: %v", tbl, err)
		}
		if n != 0 {
			t.Errorf("%s 残留 %d 行孤儿数据", tbl, n)
		}
	}

	// 另一个会话必须毫发无损。
	msgs, err := s.ListAgentMessages(ctx, keep.ID, 0)
	if err != nil || len(msgs) != 1 {
		t.Errorf("另一个会话的消息被误删: %v (%d 条)", err, len(msgs))
	}
	arts, err := s.ListAgentArtifacts(ctx, keep.ID)
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

// TestRecordAgentArtifactUpserts 确认同一个文件写多次只留一条。
// 反复改一份文档会在产物面板里堆出十几行同名记录，那是没法用的。
func TestRecordAgentArtifactUpserts(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	first, err := s.RecordAgentArtifact(ctx, &domain.AgentArtifact{
		SessionID: sess.ID, Path: "docs/方案.md", Size: 100,
	})
	if err != nil {
		t.Fatalf("记产物: %v", err)
	}
	second, err := s.RecordAgentArtifact(ctx, &domain.AgentArtifact{
		SessionID: sess.ID, Path: "docs/方案.md", Size: 250,
	})
	if err != nil {
		t.Fatalf("覆盖写产物: %v", err)
	}
	// id 要复用：前端可能已经拿它当列表 key 了。
	if second.ID != first.ID {
		t.Errorf("同路径应复用 id，%q -> %q", first.ID, second.ID)
	}

	arts, err := s.ListAgentArtifacts(ctx, sess.ID)
	if err != nil {
		t.Fatalf("列产物: %v", err)
	}
	if len(arts) != 1 {
		t.Fatalf("同一路径写两次应只有 1 条，得到 %d 条", len(arts))
	}
	if arts[0].Size != 250 {
		t.Errorf("size 应更新为最后一次的值，得到 %d", arts[0].Size)
	}
}

// TestRecordAgentArtifactRejectsAbsolutePath 守的是「库里只存相对路径」这条约定：
// 存了绝对路径的话，用户换一次产物目录整张表就全指向不存在的位置。
func TestRecordAgentArtifactRejectsAbsolutePath(t *testing.T) {
	s, ctx := newStore(t)
	sess := mustSession(t, s, ctx, "会话")

	cases := []struct{ name, path string }{
		{"绝对路径", "/etc/passwd"},
		{"空路径", ""},
		{"只有空白", "   "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := s.RecordAgentArtifact(ctx, &domain.AgentArtifact{
				SessionID: sess.ID, Path: c.path,
			}); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("路径 %q 应报 ErrValidation，得到 %v", c.path, err)
			}
		})
	}

	if _, err := s.RecordAgentArtifact(ctx, &domain.AgentArtifact{
		SessionID: "ags_nope", Path: "a.md",
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("不存在的会话应报 ErrNotFound，得到 %v", err)
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

// TestListAgentMessagesAndArtifactsRejectMissingSession 守读写一致：
// 写接口对不存在的会话报 ErrNotFound，读接口不能反而安静地回一个空列表——
// 那会把「会话没了」显示成「会话是空的」，用户会以为消息丢了。
func TestListAgentMessagesAndArtifactsRejectMissingSession(t *testing.T) {
	s, ctx := newStore(t)

	if _, err := s.ListAgentMessages(ctx, "ags_nope", 0); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("列不存在会话的消息应报 ErrNotFound，得到 %v", err)
	}
	if _, err := s.ListAgentArtifacts(ctx, "ags_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("列不存在会话的产物应报 ErrNotFound，得到 %v", err)
	}

	// 存在但是空的会话，仍然要正常返回空列表（这不是错误）。
	sess := mustSession(t, s, ctx, "空会话")
	msgs, err := s.ListAgentMessages(ctx, sess.ID, 0)
	if err != nil || len(msgs) != 0 {
		t.Errorf("空会话应返回空列表: %v (%d 条)", err, len(msgs))
	}
	arts, err := s.ListAgentArtifacts(ctx, sess.ID)
	if err != nil || len(arts) != 0 {
		t.Errorf("空会话应返回空产物列表: %v (%d 条)", err, len(arts))
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

	got, err := s.ListAgentSessions(ctx)
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
