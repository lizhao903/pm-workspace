// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package webhook

import (
	"encoding/json"
	"testing"
)

// 原型 web-next/src/taskdata.ts 的种子 Webhook：seedHooks 的 wh_sentry、wh_form
var (
	seedSentry = Webhook{
		ID: "wh_sentry", Name: "Sentry 线上告警", Enabled: true,
		Mapping:  Mapping{Title: "event.title", Desc: "event.culprit", Priority: "event.level"},
		Filter:   "action == created",
		Dedupe:   "event.id",
		Defaults: Defaults{Priority: "P1", Assignee: "周屿"},
	}
	seedForm = Webhook{
		ID: "wh_form", Name: "官网需求表单", Enabled: true,
		Mapping:  Mapping{Title: "answers.need", Desc: "answers.detail", Priority: "answers.urgency", Due: "answers.expect_date"},
		Defaults: Defaults{Priority: "P2", Assignee: "林予安"},
	}
)

// sentryPayload 同原型的 sentryPayload(id, title, level, action)
func sentryPayload(id, title, level, action string) string {
	b, _ := json.Marshal(map[string]any{"action": action, "project": "web-console", "event": map[string]any{
		"id": id, "title": title, "culprit": "src/pages/Export.tsx in runExport", "level": level,
		"url": "https://sentry.io/issues/" + id + "/"}})
	return string(b)
}

const (
	seedSentrySample = `{"action":"created","project":"web-console","event":{"id":"a81f3c","title":"TypeError: Cannot read properties of undefined (reading 'roles')","culprit":"src/pages/RoleEditor.tsx in buildTree","level":"error","url":"https://sentry.io/issues/4431/"}}`
	seedFormSample   = `{"form":"需求收集","answers":{"company":"北岸物流","contact":"宋砚","need":"司机端支持离线签收","detail":"山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。","urgency":"高","expect_date":"2026-11-19"}}`
	seedFormNoNeed   = `{"form":"需求收集","answers":{"company":"远川科技","contact":"许知行","detail":"希望审批能接企业微信","urgency":"中"}}`
)

// 原型 seedDeliveries 的映射结果和过滤结果（去重、建任务在 delivery_test.go）
func TestSeedDeliveriesMapping(t *testing.T) {
	cases := []struct {
		name    string
		hook    Webhook
		payload string
		mapped  Mapping
		pass    bool
		reason  string
	}{
		{"dl_s1", seedSentry, sentryPayload("b902ee", "Export job timeout after 300s", "fatal", "created"),
			Mapping{Title: "Export job timeout after 300s", Desc: "src/pages/Export.tsx in runExport", Priority: "fatal"}, true, ""},
		{"dl_s3", seedSentry, sentryPayload("c11d04", "Slow query on /api/audit", "warning", "resolved"),
			Mapping{Title: "Slow query on /api/audit", Desc: "src/pages/Export.tsx in runExport", Priority: "warning"},
			false, "不满足过滤条件 action == created（实际是「resolved」）"},
		{"sentry sample", seedSentry, seedSentrySample,
			Mapping{Title: "TypeError: Cannot read properties of undefined (reading 'roles')", Desc: "src/pages/RoleEditor.tsx in buildTree", Priority: "error"}, true, ""},
		{"dl_f1", seedForm, seedFormSample,
			Mapping{Title: "司机端支持离线签收", Desc: "山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。", Priority: "高", Due: "2026-11-19"}, true, ""},
		{"dl_f2", seedForm, seedFormNoNeed,
			Mapping{Desc: "希望审批能接企业微信", Priority: "中"}, true, ""},
	}
	for _, c := range cases {
		p := json.RawMessage(c.payload)
		if got := MapFields(c.hook.Mapping, p); got != c.mapped {
			t.Errorf("%s mapped = %+v, want %+v", c.name, got, c.mapped)
		}
		pass, reason := PassFilter(c.hook.Filter, p)
		if pass != c.pass || reason != c.reason {
			t.Errorf("%s filter = %v %q, want %v %q", c.name, pass, reason, c.pass, c.reason)
		}
	}
	// 种子里的级别对到的优先级：fatal P0、error P1、高 P1，取不到用默认
	for _, c := range []struct{ v, fallback, want string }{
		{"fatal", "P1", "P0"}, {"error", "P1", "P1"}, {"warning", "P1", "P2"}, {"高", "P2", "P1"}, {"中", "P2", "P2"},
		{"", "P1", "P1"}, {"P3", "P1", "P3"}, {" p0 ", "P2", "P0"}, {"Critical", "P2", "P0"}, {"minor", "P2", "P3"},
		{"info", "P1", "P3"}, {"normal", "P1", "P2"}, {"whatever", "P2", "P2"}, {"p4", "P1", "P1"},
	} {
		if got := ToPriority(c.v, c.fallback); got != c.want {
			t.Errorf("ToPriority(%q, %q) = %q, want %q", c.v, c.fallback, got, c.want)
		}
	}
}

func TestGetPath(t *testing.T) {
	p := json.RawMessage(`{"a":{"b":[{"c":"x"},{"c":2.50}],"o":{"z":1,"y":[true,null]},"n":null,"s":"str","0":"zero"},"items":[{"name":"第一"}]}`)
	for _, c := range []struct{ path, want string }{
		{"a.b[0].c", "x"},
		{"a.b[1].c", "2.50"},
		{" items[0].name ", "第一"},
		{"items.0.name", "第一"},
		{"a.o", `{"z":1,"y":[true,null]}`}, // 对象原样压成一行，字段顺序不变
		{"a.o.y[0]", "true"},
		{"a.o.y[1]", ""},
		{"a.n", ""},
		{"a.n.x", ""},
		{"a.s.length", ""}, // 字符串不是对象，取不下去
		{"a.b[9].c", ""},
		{"a.0", "zero"},
		{"a..s", "str"}, // 空段跳过，同原型 filter(Boolean)
		{"missing.x", ""},
		{"", ""},
		{"   ", ""},
	} {
		if got := AsText(GetPath(p, c.path)); got != c.want {
			t.Errorf("GetPath(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestPassFilter(t *testing.T) {
	p := json.RawMessage(`{"action":"opened","level":"info","n":3,"empty":""}`)
	for _, c := range []struct {
		filter string
		pass   bool
		reason string
	}{
		{"", true, ""},
		{"   ", true, ""},
		{"action == opened", true, ""},
		{"action == 'opened'", true, ""},
		{`action=="opened"`, true, ""},
		{"level != info", false, "不满足过滤条件 level != info（实际是「info」）"},
		{"level != debug", true, ""},
		{"n == 3", true, ""},
		{"empty == x", false, "不满足过滤条件 empty == x（实际是「空」）"},
		{"missing != x", true, ""},
		{"action opened", false, "过滤条件写法不对：action opened"},
	} {
		pass, reason := PassFilter(c.filter, p)
		if pass != c.pass || reason != c.reason {
			t.Errorf("PassFilter(%q) = %v %q, want %v %q", c.filter, pass, reason, c.pass, c.reason)
		}
	}
	if got := unquote(`"`); got != "" {
		t.Errorf("unquote(\") = %q", got)
	}
	if got := unquote(`'a"`); got != "a" {
		t.Errorf("unquote('a\") = %q", got)
	}
}
