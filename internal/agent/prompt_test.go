package agent

import (
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

var testTypes = []*domain.ObjectType{{
	ID: "requirement", Name: "需求", RefPrefix: "REQ",
	Statuses: []domain.Status{{Key: "doing", Label: "进行中"}},
}}

// TestSystemPromptNamesCurrentObjectWithoutBody 是 object_id 这条线的核心断言：
// 提示词要说清「这个」指哪一条，但**不能**把正文带进去。
//
// 带正文的坏处不是省不省 token：用户在抽屉里改完正文，这段话里还是打开页面那一刻的旧版本，
// 模型照着旧正文出方案，而它自己完全不知道手里的是旧的。指代和取数必须分开。
func TestSystemPromptNamesCurrentObjectWithoutBody(t *testing.T) {
	cur := &domain.Object{
		Ref: "REQ-0012", Title: "对账单导出支持自定义口径",
		TypeID: "requirement", Status: "doing",
		Body: "这段正文绝对不该出现在系统提示词里",
	}
	got := BuildSystemPrompt(testTypes, time.Now(), cur)

	for _, want := range []string{"REQ-0012", "对账单导出支持自定义口径", "get_object"} {
		if !strings.Contains(got, want) {
			t.Errorf("提示词里缺 %q", want)
		}
	}
	if strings.Contains(got, cur.Body) {
		t.Errorf("正文被塞进了系统提示词——用户改完对象之后模型手里就是过期的了")
	}
}

// TestSystemPromptWithoutCurrentObject 保证没选中对象时不多出一段空话。
// 全局对话框里没选中任何东西是常态，凭空来一句「用户当前打开的对象」会让模型去找一个不存在的东西。
func TestSystemPromptWithoutCurrentObject(t *testing.T) {
	got := BuildSystemPrompt(testTypes, time.Now(), nil)
	if strings.Contains(got, "用户当前打开的对象") {
		t.Errorf("没有选中对象时不该出现这一段：\n%s", got)
	}
}
