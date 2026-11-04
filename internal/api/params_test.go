package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// filterOf 走一遍真实的 query 解析，返回过滤条件与错误。
func filterOf(t *testing.T, query string) objectFilterResult {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/objects?"+query, nil)
	fl, err := objectFilter(r)
	return objectFilterResult{f: fl, err: err}
}

type objectFilterResult struct {
	f   domain.ObjectFilter
	err error
}

func TestObjectFilterMultiValue(t *testing.T) {
	res := filterOf(t, "type=requirement,task&status=doing,%20blocked%20&priority=P0,P1&tag=%E4%BA%91%E7%AB%AF&tag=%E5%B9%B3%E5%8F%B0")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if !reflect.DeepEqual(res.f.TypeIDs, []string{"requirement", "task"}) {
		t.Fatalf("type = %v", res.f.TypeIDs)
	}
	// 逗号分隔的值两侧空格要去掉，前端拼 query 时很容易带上。
	if !reflect.DeepEqual(res.f.Statuses, []string{"doing", "blocked"}) {
		t.Fatalf("status = %v", res.f.Statuses)
	}
	if !reflect.DeepEqual(res.f.Priorities, []string{"P0", "P1"}) {
		t.Fatalf("priority = %v", res.f.Priorities)
	}
	// tag 是可重复参数（AND 语义），不能按逗号切。
	if !reflect.DeepEqual(res.f.Tags, []string{"云端", "平台"}) {
		t.Fatalf("tag = %v", res.f.Tags)
	}
}

func TestObjectFilterEmptyQuery(t *testing.T) {
	res := filterOf(t, "")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if res.f.TypeIDs != nil || res.f.Tags != nil || res.f.Statuses != nil {
		t.Fatalf("空 query 不应产生空切片: %+v", res.f)
	}
	if res.f.Limit != defaultLimit || res.f.Offset != 0 {
		t.Fatalf("默认分页错误: limit=%d offset=%d", res.f.Limit, res.f.Offset)
	}
	if res.f.Sort != "" || res.f.DueBefore != nil {
		t.Fatalf("默认排序/时间不应有值: %+v", res.f)
	}
}

// 分页越界不报错，避免前端因为一个手滑参数整页挂掉。
// limit 只有显式传 1..200 才生效：0 与负数按「没指定」回落默认值，超上限钳到 200。
func TestObjectFilterLimitClamp(t *testing.T) {
	tests := []struct {
		query                 string
		wantLimit, wantOffset int
	}{
		{"limit=10&offset=20", 10, 20},
		{"limit=1", 1, 0},
		{"limit=200", 200, 0},
		{"limit=999", maxLimit, 0},
		{"limit=0", defaultLimit, 0},
		{"limit=-5", defaultLimit, 0},
		{"offset=-1", defaultLimit, 0},
	}
	for _, tc := range tests {
		res := filterOf(t, tc.query)
		if res.err != nil {
			t.Fatalf("%s: %v", tc.query, res.err)
		}
		if res.f.Limit != tc.wantLimit || res.f.Offset != tc.wantOffset {
			t.Fatalf("%s -> limit=%d offset=%d, 期望 %d/%d", tc.query, res.f.Limit, res.f.Offset, tc.wantLimit, tc.wantOffset)
		}
	}
}

func TestObjectFilterBooleans(t *testing.T) {
	res := filterOf(t, "subtree=true&overdue=1&inbox=yes&archived=on&deleted=false")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if !res.f.CategorySubtree || !res.f.Overdue || !res.f.Inbox || !res.f.IncludeArchived {
		t.Fatalf("布尔参数解析错误: %+v", res.f)
	}
	if res.f.IncludeDeleted {
		t.Fatal("deleted=false 应为 false")
	}
	if res := filterOf(t, "overdue=maybe"); res.err == nil {
		t.Fatal("非法布尔值应报错")
	}
}

// 布尔族只要漏解析一个，对应的聚焦就会退化成全量，和徽标对不上。
// 这里把 ObjectFilter 上每个布尔位都钉一遍，避免以后再漏。
func TestObjectFilterAllBooleansReachFilter(t *testing.T) {
	res := filterOf(t, "subtree=true&uncategorized=true&overdue=true&inbox=true"+
		"&stalled=true&not_terminal=true&archived=true&deleted=true")
	if res.err != nil {
		t.Fatal(res.err)
	}
	for name, got := range map[string]bool{
		"subtree":       res.f.CategorySubtree,
		"uncategorized": res.f.Uncategorized,
		"overdue":       res.f.Overdue,
		"inbox":         res.f.Inbox,
		"stalled":       res.f.Stalled,
		"not_terminal":  res.f.NotTerminal,
		"archived":      res.f.IncludeArchived,
		"deleted":       res.f.IncludeDeleted,
	} {
		if !got {
			t.Errorf("%s=true 没有落进 ObjectFilter，被 HTTP 层静默丢掉了", name)
		}
	}
}

func TestObjectFilterStalledAndNotTerminal(t *testing.T) {
	res := filterOf(t, "stalled=true&sort=updated_at")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if !res.f.Stalled {
		t.Fatal("stalled 未被解析")
	}
	if res.f.NotTerminal {
		t.Fatal("没传 not_terminal 就不该置位")
	}

	// 「今日」「本周」会带 not_terminal 排除已完成的，否则列表比徽标多。
	res = filterOf(t, "due_after=2026-09-15&due_before=2026-09-15&not_terminal=true")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if !res.f.NotTerminal {
		t.Fatal("not_terminal 未被解析")
	}

	for _, q := range []string{"stalled=maybe", "not_terminal=maybe"} {
		res := filterOf(t, q)
		if res.err == nil {
			t.Fatalf("%s 应报错", q)
		}
		if !strings.Contains(res.err.Error(), strings.Split(q, "=")[0]) {
			t.Fatalf("错误信息应指明参数名: %v", res.err)
		}
	}
}

func TestObjectFilterDueBefore(t *testing.T) {
	// 纯日期按当地时区当天 23:59:59，这样「9-30 之前」包含 9-30 当天。
	res := filterOf(t, "due_before=2026-09-30")
	if res.err != nil {
		t.Fatal(res.err)
	}
	want := time.Date(2026, 9, 30, 23, 59, 59, 0, time.Local)
	if !res.f.DueBefore.Equal(want) {
		t.Fatalf("due_before = %v, 期望 %v", res.f.DueBefore, want)
	}

	res = filterOf(t, "due_before=2026-09-30T08:00:00%2B08:00")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if got := res.f.DueBefore.UTC(); got.Hour() != 0 {
		t.Fatalf("RFC3339 解析错误: %v", res.f.DueBefore)
	}

	if res := filterOf(t, "due_before=2026/09/30"); res.err == nil {
		t.Fatal("非法日期应报错")
	}
}

// due_after 之前整条漏解析，导致「今日」退化成「今天之前到期的全算」，
// 列表条数和徽标对不上。这里把成对语义钉死。
func TestObjectFilterDueAfter(t *testing.T) {
	res := filterOf(t, "due_after=2026-09-15T00%3A00%3A00%2B08%3A00")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if res.f.DueAfter == nil {
		t.Fatal("due_after 必须被解析，不能静默丢掉")
	}
	want := time.Date(2026, 9, 15, 0, 0, 0, 0, time.FixedZone("", 8*3600))
	if !res.f.DueAfter.Equal(want) {
		t.Fatalf("due_after = %v, 期望 %v", res.f.DueAfter, want)
	}

	if res := filterOf(t, "due_after=2026/09/15"); res.err == nil {
		t.Fatal("非法日期应报错")
	} else if !strings.Contains(res.err.Error(), "due_after") {
		t.Fatalf("错误信息应指明是 due_after: %v", res.err)
	}
}

// 纯日期写法要按边界补时分秒：下界补 00:00:00、上界补 23:59:59，
// 两端传同一天才等于「这一天到期」。补反了「今日」就会一条都查不出来。
func TestObjectFilterDayBounds(t *testing.T) {
	res := filterOf(t, "due_after=2026-09-15&due_before=2026-09-15")
	if res.err != nil {
		t.Fatal(res.err)
	}
	wantLo := time.Date(2026, 9, 15, 0, 0, 0, 0, time.Local)
	wantHi := time.Date(2026, 9, 15, 23, 59, 59, 0, time.Local)
	if !res.f.DueAfter.Equal(wantLo) {
		t.Fatalf("due_after = %v, 期望当天起点 %v", res.f.DueAfter, wantLo)
	}
	if !res.f.DueBefore.Equal(wantHi) {
		t.Fatalf("due_before = %v, 期望当天终点 %v", res.f.DueBefore, wantHi)
	}
	if !res.f.DueAfter.Before(*res.f.DueBefore) {
		t.Fatal("同一天的下界必须早于上界，否则窗口是空的")
	}
}

// 前端「今日」chip 实际发的就是这种带毫秒的 UTC 区间，端到端保证它能落进 filter。
func TestObjectFilterTodayWindow(t *testing.T) {
	res := filterOf(t, "due_after=2026-09-14T16%3A00%3A00.000Z&due_before=2026-09-15T15%3A59%3A59.000Z&sort=-updated_at&limit=200")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if res.f.DueAfter == nil || res.f.DueBefore == nil {
		t.Fatalf("今日窗口的上下界都要在: after=%v before=%v", res.f.DueAfter, res.f.DueBefore)
	}
	if !res.f.DueAfter.Before(*res.f.DueBefore) {
		t.Fatal("窗口下界应早于上界")
	}
}

func TestObjectFilterSortWhitelist(t *testing.T) {
	for _, s := range []string{"updated_at", "-updated_at", "created_at", "due_at", "priority", "title"} {
		if res := filterOf(t, "sort="+s); res.err != nil {
			t.Fatalf("sort=%s 应被接受: %v", s, res.err)
		}
	}
	for _, s := range []string{"id", "-body", "title%3Bdrop"} {
		if res := filterOf(t, "sort="+s); res.err == nil {
			t.Fatalf("sort=%s 应被拒绝", s)
		}
	}
}

func TestObjectFilterUncategorized(t *testing.T) {
	res := filterOf(t, "type=requirement&uncategorized=true")
	if res.err != nil {
		t.Fatal(res.err)
	}
	if !res.f.Uncategorized {
		t.Fatalf("uncategorized=true 未解析: %+v", res.f)
	}

	if res := filterOf(t, "uncategorized=1"); res.err != nil || !res.f.Uncategorized {
		t.Fatalf("uncategorized=1 应为 true: %+v / %v", res.f, res.err)
	}
	// 缺省和显式 false 都不该开启这个筛选。
	if res := filterOf(t, ""); res.err != nil || res.f.Uncategorized {
		t.Fatalf("缺省应为 false: %+v / %v", res.f, res.err)
	}
	if res := filterOf(t, "uncategorized=false"); res.err != nil || res.f.Uncategorized {
		t.Fatalf("uncategorized=false 应为 false: %+v / %v", res.f, res.err)
	}
	// 非法值要落到 400 validation，不能穿成 500。
	res = filterOf(t, "uncategorized=abc")
	if res.err == nil {
		t.Fatal("非法布尔值应报错")
	}
	if !errors.Is(res.err, domain.ErrValidation) {
		t.Fatalf("uncategorized=abc 应为 validation 错误，实际 %v", res.err)
	}
}

// queryForField 给 ObjectFilter 的每个字段配一段「能把它从默认值推开」的 query。
// 新增字段时必须在这里登记，或者写进 exemptFields 说明为什么不暴露。
var queryForField = map[string]string{
	"TypeIDs":         "type=requirement",
	"CategoryID":      "category=cat_req_prod",
	"CategorySubtree": "subtree=true",
	"Uncategorized":   "uncategorized=true",
	"Statuses":        "status=doing",
	"Priorities":      "priority=P0",
	"Tags":            "tag=%E4%BA%91%E7%AB%AF",
	"OwnerID":         "owner_id=stk_1",
	"ProjectID":       "project=obj_1",
	"Query":           "q=%E5%A4%9A%E7%A7%9F%E6%88%B7",
	"DueAfter":        "due_after=2026-09-15",
	"DueBefore":       "due_before=2026-09-15",
	"Overdue":         "overdue=true",
	"Stalled":         "stalled=true",
	"NotTerminal":     "not_terminal=true",
	"Inbox":           "inbox=true",
	"Sources":         "source=webhook",
	// AUTO-05：渠道和发送者成对给，单给一个是 400，所以两条都带上另一半
	"Stages":            "stage=designing,none",
	"RequesterID":       "requester_id=stk_1",
	"RequesterChannel":  "requester_channel=slack&requester_sender_id=U1",
	"RequesterSenderID": "requester_channel=slack&requester_sender_id=U1",
	"SourceMessageID":   "source_message_id=imm_1",
	"IncludeArchived":   "archived=true",
	"IncludeDeleted":    "deleted=true",
	"Sort":              "sort=-updated_at",
	"Limit":             "limit=10",
	"Offset":            "offset=5",
}

// exemptFields 登记「有意不通过 query 暴露」的字段，值是理由。
// 这张表留空也要保留：新增字段时必须显式表态，不能靠默认放过。
// 强制写理由是为了防腐化——一个没人说得清为什么在里面的条目，一眼就能看出该清理。
var exemptFields = map[string]string{}

// 「domain 加字段 → API 层解析 → store 层谓词」三步缺一步都是静默失效：
// 编译不报错、测试不红、日志不响，只有前端看到数字对不上才会发现。
// due_after 和 stalled/not_terminal 已经这么漏过两次，所以用反射把这一步钉死。
func TestEveryObjectFilterFieldIsReachableFromQuery(t *testing.T) {
	base := filterOf(t, "")
	if base.err != nil {
		t.Fatalf("空 query 解析失败: %v", base.err)
	}
	ft := reflect.TypeOf(domain.ObjectFilter{})
	baseV := reflect.ValueOf(base.f)

	for i := 0; i < ft.NumField(); i++ {
		f := ft.Field(i)
		if !f.IsExported() {
			continue
		}
		if reason, ok := exemptFields[f.Name]; ok {
			if reason == "" {
				t.Errorf("ObjectFilter.%s 登记在 exemptFields 里但没写理由", f.Name)
			}
			continue
		}
		q, ok := queryForField[f.Name]
		if !ok {
			t.Errorf("ObjectFilter.%s 没有对应的 query 参数；"+
				"若有意不暴露请登记进 exemptFields", f.Name)
			continue
		}

		got := filterOf(t, q)
		if got.err != nil {
			t.Errorf("ObjectFilter.%s: query %q 解析报错: %v", f.Name, q, got.err)
			continue
		}
		// 和空 query 的基线比，而不是判非零：Limit 默认就是 50，
		// 判非零的话即使解析被删掉也照样「通过」。
		want := reflect.ValueOf(got.f).Field(i).Interface()
		if reflect.DeepEqual(baseV.Field(i).Interface(), want) {
			t.Errorf("ObjectFilter.%s: 带上 %q 之后该字段仍是默认值 %v，"+
				"说明 API 层没解析这个参数，请求里传了也会被静默丢弃",
				f.Name, q, want)
		}
	}
}

// 反向校验：queryForField 里不能留下已经改名或删掉的字段，否则这张表会慢慢腐化。
func TestQueryForFieldHasNoStaleEntries(t *testing.T) {
	ft := reflect.TypeOf(domain.ObjectFilter{})
	known := map[string]bool{}
	for i := 0; i < ft.NumField(); i++ {
		known[ft.Field(i).Name] = true
	}
	for name := range queryForField {
		if !known[name] {
			t.Errorf("queryForField 里的 %q 已经不是 ObjectFilter 的字段了，请删掉或改名", name)
		}
	}
	for name := range exemptFields {
		if !known[name] {
			t.Errorf("exemptFields 里的 %q 已经不是 ObjectFilter 的字段了，请删掉或改名", name)
		}
	}
}

// 绊线：ObjectFilter 加字段时这条会红。
//
// 和上面那条反射断言分工不同，别当成重复：
//   - 反射断言只看得见「API 层有没有解析」，那是它唯一能自动验证的一步；
//   - 这条只断言字段数，红了逼人去人工确认另外两步——store 层谓词和契约文档，
//     那两处在本包里没法自动验证，但漏掉同样是静默失效。
//
// 红了请检查三处：
//  1. internal/api/params.go 是否解析了对应 query 参数（这步反射断言也会红）
//  2. internal/store/sqlite/objects.go 的 buildWhere 是否有对应谓词
//  3. docs/api-contract.md 的 query 参数表是否补了这一行
//
// due_after 漏的是第 1 和第 3 步，stalled/not_terminal 漏的是第 1 和第 2 步。
// 三处都确认到位后，把下面的数字改成新值。
func TestObjectFilterFieldCountTripwire(t *testing.T) {
	const known = 27
	if n := reflect.TypeOf(domain.ObjectFilter{}).NumField(); n != known {
		t.Fatalf("ObjectFilter 字段数变成 %d（原为 %d）。"+
			"请确认新字段在 params.go 有解析、objects.go 有谓词、api-contract.md 有记载，"+
			"然后把 known 改成 %d", n, known, n)
	}
}
