package api

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// PATCH 的三态：字段缺失=不改，字段有值=改，字段为 null=置空。
// 这是本层最容易写错的地方，逐字段钉死。
func TestParseObjectPatchThreeStates(t *testing.T) {
	t.Run("字段缺失表示不改", func(t *testing.T) {
		p, err := parseObjectPatch([]byte(`{"title":"只改标题"}`))
		if err != nil {
			t.Fatal(err)
		}
		if p.CategoryID != nil {
			t.Fatal("category_id 缺失时必须为 nil")
		}
		if p.DueAt != nil {
			t.Fatal("due_at 缺失时必须为 nil")
		}
		if p.ProjectID != nil || p.Status != nil || p.Tags != nil || p.Archived != nil {
			t.Fatal("未出现的字段都应为 nil")
		}
		if p.Title == nil || *p.Title != "只改标题" {
			t.Fatalf("title = %v", p.Title)
		}
	})

	t.Run("字段有值表示赋值", func(t *testing.T) {
		p, err := parseObjectPatch([]byte(`{"category_id":"cat_1","project_id":"obj_9","due_at":"2026-09-30T12:00:00+08:00"}`))
		if err != nil {
			t.Fatal(err)
		}
		if p.CategoryID == nil || *p.CategoryID == nil || **p.CategoryID != "cat_1" {
			t.Fatalf("category_id = %v", p.CategoryID)
		}
		if p.ProjectID == nil || *p.ProjectID == nil || **p.ProjectID != "obj_9" {
			t.Fatalf("project_id = %v", p.ProjectID)
		}
		if p.DueAt == nil || *p.DueAt == nil {
			t.Fatal("due_at 应有值")
		}
		want := time.Date(2026, 9, 30, 12, 0, 0, 0, time.FixedZone("", 8*3600))
		if !(**p.DueAt).Equal(want) {
			t.Fatalf("due_at = %v, 期望 %v", **p.DueAt, want)
		}
	})

	t.Run("字段为 null 表示置空", func(t *testing.T) {
		p, err := parseObjectPatch([]byte(`{"category_id":null,"project_id":null,"due_at":null}`))
		if err != nil {
			t.Fatal(err)
		}
		for name, v := range map[string]bool{
			"category_id": p.CategoryID != nil && *p.CategoryID == nil,
			"project_id":  p.ProjectID != nil && *p.ProjectID == nil,
		} {
			if !v {
				t.Fatalf("%s 置空失败", name)
			}
		}
		if p.DueAt == nil || *p.DueAt != nil {
			t.Fatalf("due_at 置空失败: %v", p.DueAt)
		}
	})
}

func TestParseObjectPatchFields(t *testing.T) {
	p, err := parseObjectPatch([]byte(`{
		"title":"标题","body":"正文","status":"doing","priority":"P0","owner":"me","source":"ui",
		"props":{"k":1},"tags":["云端","平台"],"archived":true
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if *p.Title != "标题" || *p.Body != "正文" || *p.Status != "doing" ||
		*p.Priority != "P0" || *p.Owner != "me" || *p.Source != "ui" {
		t.Fatalf("字符串字段解析错误: %+v", p)
	}
	if p.Props == nil || (*p.Props)["k"] != float64(1) {
		t.Fatalf("props = %v", p.Props)
	}
	if p.Tags == nil || len(*p.Tags) != 2 || (*p.Tags)[0] != "云端" {
		t.Fatalf("tags = %v", p.Tags)
	}
	if p.Archived == nil || !*p.Archived {
		t.Fatalf("archived = %v", p.Archived)
	}
}

// due_at 允许日期选择器直接传 YYYY-MM-DD，按当天末尾处理。
func TestParseObjectPatchDateOnlyDue(t *testing.T) {
	p, err := parseObjectPatch([]byte(`{"due_at":"2026-09-30"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := **p.DueAt
	want := time.Date(2026, 9, 30, 23, 59, 59, 0, time.Local)
	if !got.Equal(want) {
		t.Fatalf("due_at = %v, 期望 %v", got, want)
	}
}

func TestParseObjectPatchErrors(t *testing.T) {
	tests := []struct{ name, body string }{
		{"空 body", ``},
		{"非法 JSON", `{`},
		{"顶层不是对象", `[1,2]`},
		{"title 为 null", `{"title":null}`},
		{"title 类型错误", `{"title":123}`},
		{"tags 类型错误", `{"tags":"a,b"}`},
		{"archived 类型错误", `{"archived":"yes"}`},
		{"category_id 类型错误", `{"category_id":42}`},
		{"due_at 格式错误", `{"due_at":"下周三"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseObjectPatch([]byte(tc.body)); err == nil {
				t.Fatal("期望报错")
			} else if !isValidation(err) {
				t.Fatalf("应为 validation 错误, 得到 %v", err)
			}
		})
	}
}

func isValidation(err error) bool {
	return errors.Is(err, domain.ErrValidation)
}

// jsonForPatchField 给 ObjectPatch 的每个字段配一段「能把它从零值推开」的请求体。
// 新增字段时必须在这里登记，或者写进 exemptPatchFields 说明为什么不解析。
var jsonForPatchField = map[string]string{
	"Title":      `{"title":"标题"}`,
	"Body":       `{"body":"正文"}`,
	"Status":     `{"status":"doing"}`,
	"Priority":   `{"priority":"P0"}`,
	"Owner":      `{"owner":"me"}`,
	"CategoryID": `{"category_id":"cat_1"}`,
	"ProjectID":  `{"project_id":"obj_1"}`,
	"Source":     `{"source":"ui"}`,
	"Props":      `{"props":{"k":1}}`,
	"Workdir":    `{"workdir":"/tmp/ws"}`,
	"DueAt":      `{"due_at":"2026-09-30T12:00:00+08:00"}`,
	"Tags":       `{"tags":["云端"]}`,
	"Archived":   `{"archived":true}`,
}

// exemptPatchFields 登记「有意不从请求体解析」的字段，值是理由。
// 留空也要保留：新增字段必须显式表态，不能靠默认放过。
var exemptPatchFields = map[string]string{}

// exemptCreateFields 登记「PATCH 有、但 POST 建对象时有意不收」的字段，值是理由。
var exemptCreateFields = map[string]string{
	"archived": "新建的对象不可能一出生就是归档态，要归档得走 PATCH",
}

// 这条和 TestEveryObjectFilterFieldIsReachableFromQuery 是一对：
// 那条守 query 参数入口，这条守请求体入口。
// domain 加了字段但 parseObjectPatch 忘了读，同样是静默失效——
// 不报错、不红测试，PATCH 传了也白传。workdir 就是这么漏的。
func TestEveryObjectPatchFieldIsParsed(t *testing.T) {
	base, err := parseObjectPatch([]byte(`{}`))
	if err != nil {
		t.Fatalf("空对象解析失败: %v", err)
	}
	pt := reflect.TypeOf(domain.ObjectPatch{})
	baseV := reflect.ValueOf(base)

	for i := 0; i < pt.NumField(); i++ {
		f := pt.Field(i)
		if !f.IsExported() {
			continue
		}
		if reason, ok := exemptPatchFields[f.Name]; ok {
			if reason == "" {
				t.Errorf("ObjectPatch.%s 登记在 exemptPatchFields 里但没写理由", f.Name)
			}
			continue
		}
		body, ok := jsonForPatchField[f.Name]
		if !ok {
			t.Errorf("ObjectPatch.%s 没有对应的请求体片段；"+
				"若有意不解析请登记进 exemptPatchFields", f.Name)
			continue
		}

		got, err := parseObjectPatch([]byte(body))
		if err != nil {
			t.Errorf("ObjectPatch.%s: 请求体 %s 解析报错: %v", f.Name, body, err)
			continue
		}
		// 和 {} 的基线比而不是判非 nil，理由同 query 那条：
		// 万一将来某个字段有默认值，判非 nil 会变成一条永远绿的假断言。
		want := reflect.ValueOf(got).Field(i).Interface()
		if reflect.DeepEqual(baseV.Field(i).Interface(), want) {
			t.Errorf("ObjectPatch.%s: 请求体带了 %s 之后该字段仍是默认值，"+
				"说明 parseObjectPatch 没读这个键，PATCH 传了会被静默丢掉", f.Name, body)
		}
	}
}

// PATCH 能改的字段，POST 建对象时基本都该能直接带上，
// 否则前端只能「先建后改」两次请求，中间还会多出一条无意义的修订记录。
func TestCreateObjectReqCoversObjectPatchFields(t *testing.T) {
	patchTags := jsonTagsOf(reflect.TypeOf(domain.ObjectPatch{}))
	createTags := jsonTagsOf(reflect.TypeOf(createObjectReq{}))

	for tag := range patchTags {
		if reason, ok := exemptCreateFields[tag]; ok {
			if reason == "" {
				t.Errorf("%q 登记在 exemptCreateFields 里但没写理由", tag)
			}
			continue
		}
		if !createTags[tag] {
			t.Errorf("createObjectReq 缺 %q：PATCH 改得了、POST 建不了，"+
				"前端只能先建后改；若确实不该在创建时给，请登记进 exemptCreateFields", tag)
		}
	}
}

// 反向校验：三张表里都不能留下已经改名或删掉的字段。
func TestPatchFieldTablesHaveNoStaleEntries(t *testing.T) {
	pt := reflect.TypeOf(domain.ObjectPatch{})
	fields := map[string]bool{}
	for i := 0; i < pt.NumField(); i++ {
		fields[pt.Field(i).Name] = true
	}
	for name := range jsonForPatchField {
		if !fields[name] {
			t.Errorf("jsonForPatchField 里的 %q 已经不是 ObjectPatch 的字段了，请删掉或改名", name)
		}
	}
	for name := range exemptPatchFields {
		if !fields[name] {
			t.Errorf("exemptPatchFields 里的 %q 已经不是 ObjectPatch 的字段了，请删掉或改名", name)
		}
	}
	tags := jsonTagsOf(pt)
	for tag := range exemptCreateFields {
		if !tags[tag] {
			t.Errorf("exemptCreateFields 里的 %q 已经不是 ObjectPatch 的 json 键了，请删掉或改名", tag)
		}
	}
}

// jsonTagsOf 取一个结构体所有字段的 json 键名，忽略 omitempty 之类的选项。
func jsonTagsOf(t reflect.Type) map[string]bool {
	out := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		name := strings.Split(t.Field(i).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			out[name] = true
		}
	}
	return out
}
