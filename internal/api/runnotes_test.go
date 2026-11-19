// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"strings"
	"testing"
)

// 交给执行的快捷附加说明（SPEC-tasks-6.40、SPEC-settings-32）：没设过回内置的一组，整组替换，空数组表示不要，校验不过整组不生效。
func TestRunQuickNotesSettings(t *testing.T) {
	s, _, _, _ := runFixture(t, "exit 0")
	list := decodeEnvelope(t, do(s, "GET", "/api/run-quick-notes", ""))["data"].([]any)
	if len(list) != len(builtinRunQuickNotes()) || list[0].(map[string]any)["label"] != "整理需求及原型" {
		t.Fatalf("没设过时应回内置的一组：%v", list)
	}

	w := do(s, "PUT", "/api/run-quick-notes", `{"items":[{"label":" 修复 ","text":" 修复并补测试 "},{"label":"调研","text":"只读调研"}]}`)
	list = decodeEnvelope(t, w)["data"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["label"] != "修复" || list[0].(map[string]any)["text"] != "修复并补测试" {
		t.Fatalf("保存后应去掉首尾空白、保持顺序：%v", list)
	}
	list = decodeEnvelope(t, do(s, "GET", "/api/run-quick-notes", ""))["data"].([]any)
	if len(list) != 2 || list[1].(map[string]any)["label"] != "调研" {
		t.Fatalf("读回不对：%v", list)
	}

	many := make([]string, maxRunQuickNotes+1)
	for i := range many {
		many[i] = `{"label":"n` + strings.Repeat("x", i%5) + string(rune('a'+i)) + `","text":"t"}`
	}
	for _, body := range []string{
		`{"items":[{"label":"","text":"t"}]}`,
		`{"items":[{"label":"a","text":"  "}]}`,
		`{"items":[{"label":"a","text":"t"},{"label":" a","text":"u"}]}`,
		`{"items":[{"label":"` + strings.Repeat("长", maxRunQuickNoteName+1) + `","text":"t"}]}`,
		`{"items":[{"label":"a","text":"` + strings.Repeat("长", maxRunQuickNoteText+1) + `"}]}`,
		`{"items":[` + strings.Join(many, ",") + `]}`,
	} {
		assertError(t, do(s, "PUT", "/api/run-quick-notes", body), http.StatusBadRequest, "validation")
	}
	// 被拒的不生效
	if list = decodeEnvelope(t, do(s, "GET", "/api/run-quick-notes", ""))["data"].([]any); len(list) != 2 {
		t.Fatalf("400 后应保持原样：%v", list)
	}

	// 全删了：以后读回空数组，不再回内置的
	if list = decodeEnvelope(t, do(s, "PUT", "/api/run-quick-notes", `{"items":[]}`))["data"].([]any); len(list) != 0 {
		t.Fatalf("清空后应回空数组：%v", list)
	}
	if list = decodeEnvelope(t, do(s, "GET", "/api/run-quick-notes", ""))["data"].([]any); len(list) != 0 {
		t.Fatalf("清空后读回应为空数组，不补内置：%v", list)
	}
}

// 内置的一组本身要过得了校验（不然用户原样保存会 400）。
func TestBuiltinRunQuickNotesValid(t *testing.T) {
	if _, err := cleanRunQuickNotes(builtinRunQuickNotes()); err != nil {
		t.Fatal(err)
	}
}
