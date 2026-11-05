package sqlite

import (
	"context"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 这一组测试锁的是链条的第三步：domain 字段 → API 解析 → **store 谓词**。
// 前两步 api-layer 已经用反射断言锁住了，但字段解析出来而 buildWhere 不用它时，
// API 层测试照样全绿，用户看到的却是「筛选没效果」。due_after / stalled / not_terminal
// 三次都是这么漏过去的。
//
// 判定方式不是断言 SQL 文本（重构拼接方式会误报，而且证明不了语义），
// 而是造数据跑真查询，并且额外比对「把该字段清零后结果必须变化」——
// 谓词缺失时两次结果会一模一样，这条就红。

// filterCase 一个筛选字段一条。build 负责造数据并返回带该字段的 filter，
// 这样需要引用新建对象 ID 的场景（project_id）也能覆盖。
type filterCase struct {
	field string   // domain.ObjectFilter 的字段名，用于反射清零与覆盖度核对
	want  []string // 期望返回的对象标题
	build func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter
}

// notFilterFields 是确实不参与过滤的字段。理由必须写，空理由会 fail——
// 否则这张例外表迟早变成「加个字段就往里塞」的垃圾桶。
var notFilterFields = map[string]string{
	"Sort":   "排序字段，不改变结果集合，由 TestListObjectsSortAndQuery 覆盖",
	"Limit":  "分页大小，不改变匹配集合，由 TestListObjectsPagination 覆盖",
	"Offset": "分页偏移，同 Limit，由 TestListObjectsPagination 覆盖",
}

func titlesOf(items []*domain.Object) []string {
	out := make([]string, 0, len(items))
	for _, o := range items {
		out = append(out, o.Title)
	}
	sort.Strings(out)
	return out
}

func filterCases() []filterCase {
	// 只造两条对象：一条该命中、一条该被排除。多了反而看不清是哪个谓词起的作用。
	return []filterCase{
		{
			field: "TypeIDs",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "排除"})
				return domain.ObjectFilter{TypeIDs: []string{"task"}}
			},
		},
		{
			field: "CategoryID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "命中", CategoryID: pstr("cat_req_prod_cloud")})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "排除", CategoryID: pstr("cat_req_tech_perf")})
				return domain.ObjectFilter{CategoryID: "cat_req_prod_cloud"}
			},
		},
		{
			field: "CategorySubtree",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				// 挂在二级分类上：不带 subtree 时按一级分类查不到，带了才查得到。
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "命中", CategoryID: pstr("cat_req_prod_cloud")})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "排除", CategoryID: pstr("cat_req_tech_perf")})
				return domain.ObjectFilter{CategoryID: "cat_req_prod", CategorySubtree: true}
			},
		},
		{
			field: "Uncategorized",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "requirement", Title: "命中"})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "排除", CategoryID: pstr("cat_req_prod_cloud")})
				return domain.ObjectFilter{Uncategorized: true}
			},
		},
		{
			field: "Statuses",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Status: "blocked"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Status: "todo"})
				return domain.ObjectFilter{Statuses: []string{"blocked"}}
			},
		},
		{
			field: "Priorities",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Priority: "P0"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Priority: "P3"})
				return domain.ObjectFilter{Priorities: []string{"P0"}}
			},
		},
		{
			field: "Tags",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "命中", Tags: []string{"云端平台"}})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "排除", Tags: []string{"本地客户端"}})
				return domain.ObjectFilter{Tags: []string{"云端平台"}}
			},
		},
		{
			// 0010 起按 owner_id 筛，不再按 owner 文本匹配。这条用例就是那次替换的守门人：
			// 解析了 owner_id 而 buildWhere 仍在比 owner 文本时，两个人的对象都会被漏掉或全放过。
			field: "OwnerID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				me := mustStakeholder(t, s, ctx, "张三")
				other := mustStakeholder(t, s, ctx, "王闯")
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", OwnerID: &me.ID})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", OwnerID: &other.ID})
				return domain.ObjectFilter{OwnerID: me.ID}
			},
		},
		{
			field: "ProjectID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				prj := mustCreate(t, s, ctx, &domain.Object{TypeID: "project", Title: "某项目"})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "命中", ProjectID: &prj.ID})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除"})
				return domain.ObjectFilter{ProjectID: prj.ID, TypeIDs: []string{"task"}}
			},
		},
		{
			field: "Query",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Body: "多租户组织架构"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Body: "无关内容"})
				return domain.ObjectFilter{Query: "多租户"}
			},
		},
		{
			field: "DueAfter",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				future := time.Now().Add(48 * time.Hour)
				past := time.Now().Add(-48 * time.Hour)
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", DueAt: &future})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", DueAt: &past})
				cut := time.Now()
				return domain.ObjectFilter{DueAfter: &cut}
			},
		},
		{
			field: "DueBefore",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				future := time.Now().Add(48 * time.Hour)
				past := time.Now().Add(-48 * time.Hour)
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", DueAt: &past})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", DueAt: &future})
				cut := time.Now()
				return domain.ObjectFilter{DueBefore: &cut}
			},
		},
		{
			field: "Overdue",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				past := time.Now().Add(-48 * time.Hour)
				future := time.Now().Add(48 * time.Hour)
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "命中", Status: "todo", DueAt: &past})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "排除", Status: "todo", DueAt: &future})
				return domain.ObjectFilter{Overdue: true}
			},
		},
		{
			field: "Stalled",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				old := time.Now().AddDate(0, 0, -(stalledDays + 6))
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "命中", Status: "todo", CreatedAt: old, UpdatedAt: old})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Status: "todo"})
				return domain.ObjectFilter{Stalled: true}
			},
		},
		{
			field: "NotTerminal",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Status: "todo"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Status: "done"})
				return domain.ObjectFilter{NotTerminal: true}
			},
		},
		{
			field: "Inbox",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				// 两条都挂了分类，差别只在 source，确保命中来自 source='inbox' 那一支。
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "命中",
					Source: "inbox", CategoryID: pstr("cat_req_prod_cloud")})
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "requirement", Title: "排除",
					Source: "manual", CategoryID: pstr("cat_req_prod_cloud")})
				return domain.ObjectFilter{Inbox: true}
			},
		},
		{
			field: "Sources",
			want:  []string{"命中", "命中二"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				// 多值是或；不带来源和手动建的都要被排除。
				mustCreate(t, s, ctx, &domain.Object{
					TypeID: "task", Title: "命中", Source: domain.TaskSourceWebhook,
					Props: map[string]any{domain.PropSourceRef: map[string]any{"hook_id": "wh_1", "delivery_id": "dl_1"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中二", Source: domain.TaskSourceIM})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Source: domain.TaskSourceManual})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "也排除"})
				return domain.ObjectFilter{Sources: []string{domain.TaskSourceWebhook, domain.TaskSourceIM}}
			},
		},
		{
			field: "Stages",
			want:  []string{"命中", "命中二"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				// 多值是或；none 是没设阶段（没有键或空串）
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Props: map[string]any{domain.PropStage: "designing"}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中二"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Props: map[string]any{domain.PropStage: "released"}})
				return domain.ObjectFilter{Stages: []string{"designing", "none"}}
			},
		},
		{
			field: "RequesterID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中",
					Props: map[string]any{domain.PropRequester: map[string]any{"contact_id": "sh_a", "name": "甲"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除",
					Props: map[string]any{domain.PropRequester: map[string]any{"contact_id": "sh_b", "name": "乙"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "也排除"})
				return domain.ObjectFilter{RequesterID: "sh_a"}
			},
		},
		{
			field: "RequesterChannel",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				// 渠道和发送者成对：别的渠道同号的要排除
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中",
					Props: map[string]any{domain.PropRequester: map[string]any{"channel": "slack", "sender_id": "U1", "name": "U1"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除",
					Props: map[string]any{domain.PropRequester: map[string]any{"channel": "telegram", "sender_id": "U1", "name": "U1"}}})
				return domain.ObjectFilter{RequesterChannel: "slack", RequesterSenderID: "U1"}
			},
		},
		{
			field: "RequesterSenderID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中",
					Props: map[string]any{domain.PropRequester: map[string]any{"channel": "slack", "sender_id": "U1", "name": "U1"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除",
					Props: map[string]any{domain.PropRequester: map[string]any{"channel": "slack", "sender_id": "U2", "name": "U2"}}})
				return domain.ObjectFilter{RequesterChannel: "slack", RequesterSenderID: "U1"}
			},
		},
		{
			field: "SourceMessageID",
			want:  []string{"命中"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "命中", Source: domain.TaskSourceIM,
					Props: map[string]any{domain.PropSourceRef: map[string]any{"message_id": "imm_1"}}})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "排除", Source: domain.TaskSourceIM,
					Props: map[string]any{domain.PropSourceRef: map[string]any{"message_id": "imm_2"}}})
				return domain.ObjectFilter{SourceMessageID: "imm_1"}
			},
		},
		{
			field: "IncludeArchived",
			want:  []string{"已归档", "正常"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "已归档"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "正常"})
				yes := true
				if _, err := s.UpdateObject(ctx, o.ID,
					domain.ObjectPatch{Archived: &yes}, store.DefaultActor); err != nil {
					t.Fatalf("archive: %v", err)
				}
				return domain.ObjectFilter{IncludeArchived: true}
			},
		},
		{
			field: "IncludeDeleted",
			want:  []string{"已删除", "正常"},
			build: func(t *testing.T, s *Store, ctx context.Context) domain.ObjectFilter {
				o := mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "已删除"})
				mustCreate(t, s, ctx, &domain.Object{TypeID: "task", Title: "正常"})
				if err := s.DeleteObject(ctx, o.ID, false, store.DefaultActor); err != nil {
					t.Fatalf("delete: %v", err)
				}
				return domain.ObjectFilter{IncludeDeleted: true}
			},
		},
	}
}

// TestObjectFilterPredicatesTakeEffect 逐个字段验证 buildWhere 真的用上了它。
func TestObjectFilterPredicatesTakeEffect(t *testing.T) {
	for _, c := range filterCases() {
		t.Run(c.field, func(t *testing.T) {
			s, ctx := newStore(t)
			f := c.build(t, s, ctx)

			items, total, err := s.ListObjects(ctx, f)
			if err != nil {
				t.Fatalf("list with %s: %v", c.field, err)
			}
			got := titlesOf(items)
			want := append([]string{}, c.want...)
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s 过滤结果 = %v, want %v", c.field, got, want)
			}
			// total 单独断言：它走的是另一条 COUNT SQL，谓词漏拼在那边不会影响 items。
			if total != len(want) {
				t.Errorf("%s total = %d, want %d（COUNT 与列表的条件不一致）", c.field, total, len(want))
			}

			// 关键一步：把该字段清零重跑，结果必须变。没变就说明 buildWhere 压根没读它。
			base := f
			zeroField(t, &base, c.field)
			baseItems, baseTotal, err := s.ListObjects(ctx, base)
			if err != nil {
				t.Fatalf("list without %s: %v", c.field, err)
			}
			if reflect.DeepEqual(titlesOf(baseItems), got) && baseTotal == total {
				t.Errorf("清空 ObjectFilter.%s 后结果没有变化（仍是 %v），"+
					"说明 buildWhere 没有使用这个字段——参数解析了但筛选不生效", c.field, got)
			}
		})
	}
}

// TestObjectFilterFieldsAllCovered 保证新增筛选字段时不会忘了补 store 侧覆盖。
func TestObjectFilterFieldsAllCovered(t *testing.T) {
	covered := map[string]bool{}
	for _, c := range filterCases() {
		if covered[c.field] {
			t.Errorf("字段 %s 有重复用例", c.field)
		}
		covered[c.field] = true
	}

	ft := reflect.TypeOf(domain.ObjectFilter{})
	for i := 0; i < ft.NumField(); i++ {
		name := ft.Field(i).Name
		if covered[name] {
			continue
		}
		reason, declared := notFilterFields[name]
		if !declared {
			t.Errorf("ObjectFilter.%s 没有 store 层的过滤用例；"+
				"要么在 filterCases() 里补一条，要么在 notFilterFields 里写明不参与过滤的理由", name)
			continue
		}
		if strings.TrimSpace(reason) == "" {
			t.Errorf("ObjectFilter.%s 列在 notFilterFields 里但没写理由", name)
		}
	}

	// 反向核对：例外表里不该有已经不存在的字段，否则它会悄悄掩盖同名新字段。
	for name := range notFilterFields {
		if _, ok := ft.FieldByName(name); !ok {
			t.Errorf("notFilterFields 里的 %s 在 ObjectFilter 上已不存在，请删除", name)
		}
	}
	if _, ok := ft.FieldByName("Limit"); !ok {
		t.Fatal("ObjectFilter.Limit 不存在了，本测试的假设需要更新")
	}
}

// TestListObjectsPagination 覆盖 notFilterFields 里给 Limit/Offset 写的那个理由。
func TestListObjectsPagination(t *testing.T) {
	s, ctx := newStore(t)
	for i := 0; i < 5; i++ {
		mustCreate(t, s, ctx, &domain.Object{
			TypeID: "task", Title: string(rune('A'+i)) + " 号事项", Priority: "P1"})
	}

	// total 是满足条件的总数，不受 limit 影响——分页时前端靠它算页数。
	page1, total, err := s.ListObjects(ctx, domain.ObjectFilter{Sort: "title", Limit: 2})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if total != 5 {
		t.Errorf("total = %d, want 5（total 不该被 limit 截断）", total)
	}
	if len(page1) != 2 {
		t.Fatalf("page1 返回 %d 条, want 2", len(page1))
	}

	page2, _, err := s.ListObjects(ctx, domain.ObjectFilter{Sort: "title", Limit: 2, Offset: 2})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 2 {
		t.Fatalf("page2 返回 %d 条, want 2", len(page2))
	}
	if page1[0].ID == page2[0].ID {
		t.Error("offset 没生效，两页返回了相同的首条")
	}

	last, _, err := s.ListObjects(ctx, domain.ObjectFilter{Sort: "title", Limit: 2, Offset: 4})
	if err != nil {
		t.Fatalf("page3: %v", err)
	}
	if len(last) != 1 {
		t.Errorf("最后一页返回 %d 条, want 1", len(last))
	}

	// 超过上限要被夹到 maxLimit，不能让前端一把拉走整库。
	if _, _, err := s.ListObjects(ctx, domain.ObjectFilter{Limit: maxLimit + 500}); err != nil {
		t.Fatalf("oversized limit: %v", err)
	}
}

// zeroField 用反射把 filter 上指定字段置零值，用于做「有无该字段」的对照。
func zeroField(t *testing.T, f *domain.ObjectFilter, name string) {
	t.Helper()
	v := reflect.ValueOf(f).Elem().FieldByName(name)
	if !v.IsValid() {
		t.Fatalf("ObjectFilter 上没有字段 %s", name)
	}
	if !v.CanSet() {
		t.Fatalf("ObjectFilter.%s 不可写", name)
	}
	v.Set(reflect.Zero(v.Type()))
}
