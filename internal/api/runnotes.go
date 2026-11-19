// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"
)

// 交给执行的快捷附加说明（SPEC-tasks-6.36、SPEC-settings-28，用户 2026-11-19 提）：「交给执行」弹窗的附加说明上面
// 一排芯片，点一个把对应文字追加进附加说明。存在 agent_settings 的 run_quick_notes 下（[{label, text}]），
// GET / PUT /api/run-quick-notes 整组替换，同角色（run_prompts）的存法；没设过时回内置的一组。
// 只是帮着填附加说明的文字，不进提示词模板、不影响执行，发起时照旧只认请求里的 extra_prompt。

const (
	runQuickNotesKey    = "run_quick_notes"
	maxRunQuickNotes    = 20
	maxRunQuickNoteName = 12
	maxRunQuickNoteText = 500
)

// RunQuickNote 是一条快捷附加说明：芯片上的短名和点了追加的文字。
type RunQuickNote struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

// builtinRunQuickNotes 是没设过时的内置一组：前两条取自线上执行记录里出现最多的附加说明（整理需求和原型），
// 其余是通用的几种交代。
func builtinRunQuickNotes() []RunQuickNote {
	return []RunQuickNote{
		{Label: "整理需求及原型", Text: "整理需求及对应原型"},
		{Label: "需求设计回写任务", Text: "输出需求设计和原型文档后，更新到当前任务信息中"},
		{Label: "只读调研", Text: "只读调研，不改代码：读相关代码和文档，给出结论和建议的改法"},
		{Label: "修复并补测试", Text: "修复问题并补上能复现这个问题的测试，相关测试跑通后再提交"},
		{Label: "按规格同步原型", Text: "按规格同步原型：对照规格文档改原型，规格没写的不要自己加"},
		{Label: "更新 PRD 并回复", Text: "更新 PRD 与原型，完成后回复原消息，说明改了什么、在哪里看"},
	}
}

func (s *Server) handleListRunQuickNotes(w http.ResponseWriter, r *http.Request) {
	raw, err := s.st.AgentSetting(r.Context(), runQuickNotesKey)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	list := builtinRunQuickNotes()
	if len(raw) > 0 {
		var v []RunQuickNote
		if err := json.Unmarshal(raw, &v); err != nil {
			s.log.Warn("bad run_quick_notes setting, using builtins", "err", err)
		} else {
			list = v
			if list == nil {
				list = []RunQuickNote{}
			}
		}
	}
	respondData(w, http.StatusOK, list)
}

func (s *Server) handlePutRunQuickNotes(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []RunQuickNote `json:"items"`
	}
	if err := decodeBody(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	list, err := cleanRunQuickNotes(body.Items)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	raw, _ := json.Marshal(list)
	if err := s.st.SetAgentSetting(r.Context(), runQuickNotesKey, raw); err != nil {
		s.fail(w, r, err)
		return
	}
	labels := make([]string, 0, len(list))
	for _, n := range list {
		labels = append(labels, n.Label)
	}
	s.auditConfig(r, "update", "run_quick_notes", runQuickNotesKey, "修改交给执行的快捷附加说明", map[string]any{"labels": labels})
	respondData(w, http.StatusOK, list)
}

// cleanRunQuickNotes 去掉首尾空白；短名或文字空的、超长的、短名重复的、超过条数的回 400。空数组表示不要快捷说明。
func cleanRunQuickNotes(in []RunQuickNote) ([]RunQuickNote, error) {
	if len(in) > maxRunQuickNotes {
		return nil, validationf("快捷说明最多 %d 条", maxRunQuickNotes)
	}
	out := make([]RunQuickNote, 0, len(in))
	seen := map[string]bool{}
	for i, n := range in {
		n.Label, n.Text = strings.TrimSpace(n.Label), strings.TrimSpace(n.Text)
		switch {
		case n.Label == "":
			return nil, validationf("第 %d 条没写名称", i+1)
		case utf8.RuneCountInString(n.Label) > maxRunQuickNoteName:
			return nil, validationf("名称「%s」超过 %d 字", n.Label, maxRunQuickNoteName)
		case n.Text == "":
			return nil, validationf("「%s」没写说明文字", n.Label)
		case utf8.RuneCountInString(n.Text) > maxRunQuickNoteText:
			return nil, validationf("「%s」的说明文字超过 %d 字", n.Label, maxRunQuickNoteText)
		case seen[n.Label]:
			return nil, validationf("名称「%s」重复了", n.Label)
		}
		seen[n.Label] = true
		out = append(out, n)
	}
	return out, nil
}
