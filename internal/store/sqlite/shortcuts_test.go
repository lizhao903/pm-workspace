// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"errors"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func mustShortcut(t *testing.T, s *Store, ctx context.Context, sc *domain.Shortcut) *domain.Shortcut {
	t.Helper()
	out, err := s.CreateShortcut(ctx, sc)
	if err != nil {
		t.Fatalf("create shortcut %q: %v", sc.Label, err)
	}
	return out
}

func mustGroup(t *testing.T, s *Store, ctx context.Context, name string) *domain.ShortcutGroup {
	t.Helper()
	g, err := s.CreateShortcutGroup(ctx, &domain.ShortcutGroup{Name: name})
	if err != nil {
		t.Fatalf("create group %q: %v", name, err)
	}
	return g
}

// 空库不带种子数据：首次进入要走空态引导。
func TestShortcutsStartEmpty(t *testing.T) {
	s, ctx := newStore(t)
	items, err := s.ListShortcuts(ctx)
	if err != nil {
		t.Fatalf("list shortcuts: %v", err)
	}
	groups, err := s.ListShortcutGroups(ctx)
	if err != nil {
		t.Fatalf("list groups: %v", err)
	}
	if len(items) != 0 || len(groups) != 0 {
		t.Fatalf("迁移不应塞种子数据, got %d items / %d groups", len(items), len(groups))
	}
}

func TestShortcutURLSchemeWhitelist(t *testing.T) {
	s, ctx := newStore(t)

	ok := []string{
		"https://example.atlassian.net/jira/software/projects/AAA/boards/1",
		"http://127.0.0.1:3000/admin",
		"file:///Users/me/notes.md",
		// 变量占位符必须能过，这是 url 类型最主要的用法。
		`https://example.atlassian.net/issues/?jql=text~"{{title}}"`,
		"https://example.test/{{ref}}/{{today}}",
	}
	for _, u := range ok {
		if _, err := s.CreateShortcut(ctx, &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutURL, URL: u}); err != nil {
			t.Errorf("URL %q 应被接受: %v", u, err)
		}
	}

	bad := []string{
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"data:text/html;base64,PHNjcmlwdD4=",
		"vbscript:msgbox(1)",
		"//evil.test/x", // 协议相对写法，解析出来没有 scheme
		"/relative/path",
		"", // url 类型下必填
	}
	for _, u := range bad {
		_, err := s.CreateShortcut(ctx, &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutURL, URL: u})
		if !errors.Is(err, domain.ErrValidation) {
			t.Errorf("URL %q 应被拒绝, got err = %v", u, err)
		}
	}

	// 非 url 类型不校验 url 字段。
	if _, err := s.CreateShortcut(ctx, &domain.Shortcut{
		Label: "打开快速捕获", TargetKind: domain.ShortcutCommand, Command: "quick-capture:requirement",
	}); err != nil {
		t.Fatalf("command 类型不该被 url 校验拦住: %v", err)
	}
}

func TestShortcutFieldValidation(t *testing.T) {
	s, ctx := newStore(t)

	tests := []struct {
		name string
		sc   *domain.Shortcut
	}{
		{"label 必填", &domain.Shortcut{Label: "  ", TargetKind: domain.ShortcutCommand}},
		{"target_kind 非法", &domain.Shortcut{Label: "x", TargetKind: "webhook"}},
		{"open_in 非法", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutCommand, Command: "c", OpenIn: "popup"}},
		{"internal 类型 nav 为空", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal}},
		{"internal 类型 nav 是空对象", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal, Nav: "{}"}},
		{"internal 类型 nav 只有空白", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal, Nav: "  { }  "}},
		{"command 类型 command 为空", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutCommand}},
		{"command 类型 command 只有空白", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutCommand, Command: "   "}},
		{"nav 不是 JSON", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal, Nav: "{不是json"}},
		{"nav 是数组", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal, Nav: `["a"]`}},
		{"nav 是 null", &domain.Shortcut{Label: "x", TargetKind: domain.ShortcutInternal, Nav: `null`}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.CreateShortcut(ctx, tc.sc); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("应为 ErrValidation, got %v", err)
			}
		})
	}
}

// 缺省值要落成 DDL 里写的那套，前端不用每次都传全。
func TestShortcutDefaults(t *testing.T) {
	s, ctx := newStore(t)
	sc := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "Jira", URL: "https://example.test"})
	if sc.TargetKind != domain.ShortcutURL {
		t.Errorf("target_kind = %q, want url", sc.TargetKind)
	}
	if sc.OpenIn != "new_tab" {
		t.Errorf("open_in = %q, want new_tab", sc.OpenIn)
	}
	if sc.Nav != "{}" {
		t.Errorf("nav = %q, want {}", sc.Nav)
	}
	if sc.UseCount != 0 || sc.LastUsedAt != nil {
		t.Errorf("新建的条目不该有使用记录: count=%d last=%v", sc.UseCount, sc.LastUsedAt)
	}
	if sc.GroupID != nil {
		t.Errorf("group_id 应为 nil, got %v", *sc.GroupID)
	}
}

// sort_order 未指定时排到该组末尾，并且各组独立计数。
func TestShortcutSortOrderAppendsPerGroup(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")

	a := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "A", URL: "https://a.test"})
	b := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "B", URL: "https://b.test"})
	if b.SortOrder <= a.SortOrder {
		t.Fatalf("未分组区排序号应递增: a=%d b=%d", a.SortOrder, b.SortOrder)
	}

	inGroup := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "C", URL: "https://c.test", GroupID: &g.ID})
	if inGroup.SortOrder != a.SortOrder {
		t.Fatalf("新组的第一条应从头开始, got %d, 未分组首条为 %d", inGroup.SortOrder, a.SortOrder)
	}

	// 显式指定则原样保留。
	fixed := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "D", URL: "https://d.test", SortOrder: 999})
	if fixed.SortOrder != 999 {
		t.Fatalf("sort_order = %d, want 999", fixed.SortOrder)
	}
}

func TestReorderShortcuts(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")

	a := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "A", URL: "https://a.test", GroupID: &g.ID})
	b := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "B", URL: "https://b.test", GroupID: &g.ID})
	c := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "C", URL: "https://c.test", GroupID: &g.ID})

	// 全量倒序重排。
	if err := s.ReorderShortcuts(ctx, &g.ID, []string{c.ID, b.ID, a.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	items, err := s.ListShortcuts(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var got []string
	for _, it := range items {
		got = append(got, it.Label)
	}
	if len(got) != 3 || got[0] != "C" || got[1] != "B" || got[2] != "A" {
		t.Fatalf("重排后顺序 = %v, want [C B A]", got)
	}
	// 重排后的排序号不能落到 0，否则 CreateShortcut 会把它当成「未指定」。
	for _, it := range items {
		if it.SortOrder == 0 {
			t.Fatalf("条目 %s 的 sort_order 不应为 0", it.Label)
		}
	}
}

func TestReorderShortcutsRejectsForeignIDs(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")
	inGroup := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "A", URL: "https://a.test", GroupID: &g.ID})
	loose := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "B", URL: "https://b.test"})

	tests := []struct {
		name    string
		groupID *string
		ids     []string
	}{
		{"混进别组的条目", &g.ID, []string{inGroup.ID, loose.ID}},
		{"未分组区传了组内条目", nil, []string{inGroup.ID}},
		{"不存在的 ID", &g.ID, []string{inGroup.ID, "sct_nope"}},
		{"空列表", &g.ID, nil},
		{"重复 ID", &g.ID, []string{inGroup.ID, inGroup.ID}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.ReorderShortcuts(ctx, tc.groupID, tc.ids); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("应为 ErrValidation, got %v", err)
			}
		})
	}

	// 校验失败不能留下半截写入。
	after, _ := s.GetShortcut(ctx, inGroup.ID)
	if after.SortOrder != inGroup.SortOrder {
		t.Fatalf("失败的重排不该改动数据: %d -> %d", inGroup.SortOrder, after.SortOrder)
	}
}

// 重排要求传全量：少传会让没列出的条目留在旧位置，界面和库里就对不上了。
func TestReorderShortcutsRequiresFullList(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")
	a := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "A", URL: "https://a.test", GroupID: &g.ID})
	mustShortcut(t, s, ctx, &domain.Shortcut{Label: "B", URL: "https://b.test", GroupID: &g.ID})

	if err := s.ReorderShortcuts(ctx, &g.ID, []string{a.ID}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("少传应为 ErrValidation, got %v", err)
	}
}

// 删组只是把条目降级为未分组，不能连带删掉。
func TestDeleteShortcutGroupKeepsItems(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "文档与设计")
	sc := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "Figma", URL: "https://figma.test", GroupID: &g.ID})

	if err := s.DeleteShortcutGroup(ctx, g.ID); err != nil {
		t.Fatalf("delete group: %v", err)
	}
	after, err := s.GetShortcut(ctx, sc.ID)
	if err != nil {
		t.Fatalf("条目不该被级联删除: %v", err)
	}
	if after.GroupID != nil {
		t.Fatalf("条目应变为未分组, got group_id = %v", *after.GroupID)
	}
	if _, err := s.ListShortcutGroups(ctx); err != nil {
		t.Fatalf("list groups: %v", err)
	}
	if err := s.DeleteShortcutGroup(ctx, g.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("重复删除应为 ErrNotFound, got %v", err)
	}
}

func TestVisitShortcut(t *testing.T) {
	s, ctx := newStore(t)
	sc := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "监控", URL: "https://grafana.test"})
	before := sc.UpdatedAt

	first, err := s.VisitShortcut(ctx, sc.ID)
	if err != nil {
		t.Fatalf("visit: %v", err)
	}
	if first.UseCount != 1 {
		t.Fatalf("use_count = %d, want 1", first.UseCount)
	}
	if first.LastUsedAt == nil {
		t.Fatal("last_used_at 应被填上")
	}
	// 点击是使用不是修改，不该刷新 updated_at。
	if !first.UpdatedAt.Equal(before) {
		t.Fatalf("updated_at 被改动了: %v -> %v", before, first.UpdatedAt)
	}

	second, err := s.VisitShortcut(ctx, sc.ID)
	if err != nil {
		t.Fatalf("visit again: %v", err)
	}
	if second.UseCount != 2 {
		t.Fatalf("use_count = %d, want 2", second.UseCount)
	}

	if _, err := s.VisitShortcut(ctx, "sct_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("应为 ErrNotFound, got %v", err)
	}
}

func TestUpdateShortcutValidatesMergedState(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")
	sc := mustShortcut(t, s, ctx, &domain.Shortcut{
		Label: "Jira", URL: "https://jira.test", GroupID: &g.ID,
	})

	// 只改 url，其余保持。
	kind := domain.ShortcutURL
	bad := "javascript:alert(1)"
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{URL: &bad}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("改成非法协议应被拒绝, got %v", err)
	}

	// 切换类型时的必填项，只看 patch 本身是看不出来的，必须合并后才校验。
	cmd := domain.ShortcutCommand
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{TargetKind: &cmd}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("切成 command 但没带 command 应被拒绝, got %v", err)
	}
	cmdVal := "quick-capture:requirement"
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{TargetKind: &cmd, Command: &cmdVal}); err != nil {
		t.Fatalf("带上 command 切过去应成功: %v", err)
	}
	empty := ""
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{TargetKind: &kind, URL: &empty}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("切回 url 但没 url 应被拒绝, got %v", err)
	}

	// group_id 双指针：传指向 nil 的指针表示移出分组。
	var none *string
	out, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{GroupID: &none})
	if err != nil {
		t.Fatalf("移出分组: %v", err)
	}
	if out.GroupID != nil {
		t.Fatalf("group_id 应被置空, got %v", *out.GroupID)
	}

	// 指向不存在的分组要报 not found，而不是落一个悬空外键。
	ghost := "sgr_nope"
	p := &ghost
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{GroupID: &p}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("应为 ErrNotFound, got %v", err)
	}
}

// internal 类型切换时同样受对称必填约束。
func TestUpdateShortcutInternalRequiresNav(t *testing.T) {
	s, ctx := newStore(t)
	sc := mustShortcut(t, s, ctx, &domain.Shortcut{Label: "Jira", URL: "https://jira.test"})

	internal := domain.ShortcutInternal
	if _, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{TargetKind: &internal}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("切成 internal 但 nav 为空应被拒绝, got %v", err)
	}
	nav := `{"kind":"category","id":"cat_1"}`
	out, err := s.UpdateShortcut(ctx, sc.ID, domain.ShortcutPatch{TargetKind: &internal, Nav: &nav})
	if err != nil {
		t.Fatalf("带上 nav 切过去应成功: %v", err)
	}
	if out.Nav != nav {
		t.Fatalf("nav = %q, want %q", out.Nav, nav)
	}
}

func TestShortcutNotFound(t *testing.T) {
	s, ctx := newStore(t)
	if _, err := s.GetShortcut(ctx, "sct_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("get: %v", err)
	}
	if err := s.DeleteShortcut(ctx, "sct_nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.UpdateShortcut(ctx, "sct_nope", domain.ShortcutPatch{}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("update: %v", err)
	}
	// 建条目时指向不存在的分组同样要挡住。
	ghost := "sgr_nope"
	if _, err := s.CreateShortcut(ctx, &domain.Shortcut{
		Label: "x", URL: "https://x.test", GroupID: &ghost,
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("create with bad group: %v", err)
	}
}

func TestShortcutGroupCRUD(t *testing.T) {
	s, ctx := newStore(t)
	g := mustGroup(t, s, ctx, "常用系统")
	if g.SortOrder == 0 {
		t.Fatal("分组排序号应自动排到末尾，否则新建的组全挤在 0 上")
	}

	collapsed := true
	name := "常用系统（改）"
	out, err := s.UpdateShortcutGroup(ctx, g.ID, domain.ShortcutGroupPatch{Name: &name, Collapsed: &collapsed})
	if err != nil {
		t.Fatalf("update group: %v", err)
	}
	if out.Name != name || !out.Collapsed {
		t.Fatalf("更新未生效: %+v", out)
	}

	// 折叠状态要落库，刷新后还在。
	list, err := s.ListShortcutGroups(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || !list[0].Collapsed {
		t.Fatalf("collapsed 未落库: %+v", list)
	}

	blank := "  "
	if _, err := s.UpdateShortcutGroup(ctx, g.ID, domain.ShortcutGroupPatch{Name: &blank}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("空名应被拒绝, got %v", err)
	}
	if _, err := s.CreateShortcutGroup(ctx, &domain.ShortcutGroup{Name: ""}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("建组空名应被拒绝, got %v", err)
	}
	if _, err := s.UpdateShortcutGroup(ctx, "sgr_nope", domain.ShortcutGroupPatch{}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("应为 ErrNotFound, got %v", err)
	}
}
