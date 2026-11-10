// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"encoding/json"
	"strings"
	"testing"
)

// 内置流程「会议纪要整理」的 id 前缀、两根步骤和依赖要能过 SOP 的定义校验。
func TestMinutesFlowTemplate(t *testing.T) {
	flow := minutesFlow()
	if flow.ID != MinutesFlowID || !strings.HasPrefix(flow.ID, "sop_recording_") {
		t.Fatalf("流程 id 不对：%q", flow.ID)
	}
	if flow.Name != "会议纪要整理" || flow.Trigger != "manual" {
		t.Fatalf("流程名字/触发方式不对：%+v", flow)
	}
	if len(flow.Fields) == 0 || len(flow.Steps) == 0 {
		t.Fatal("流程要有入参字段和步骤")
	}
	var fields []map[string]any
	if err := json.Unmarshal(flow.Fields, &fields); err != nil {
		t.Fatalf("fields 不是数组：%v", err)
	}
	if len(fields) != 1 || fields[0]["key"] != "recording_id" {
		t.Fatalf("入参字段不对：%v", fields)
	}
	var steps []struct {
		Key    string            `json:"key"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Config map[string]string `json:"config"`
		After  []string          `json:"after"`
	}
	if err := json.Unmarshal(flow.Steps, &steps); err != nil {
		t.Fatalf("steps 不是数组：%v", err)
	}
	if len(steps) != 2 {
		t.Fatalf("流程应有 2 步，实际 %d", len(steps))
	}
	kinds := map[string]bool{NodeMinutes: true, NodeExtract: true}
	keys := map[string]bool{}
	for _, s := range steps {
		if s.Key == "" || s.Name == "" {
			t.Errorf("步骤缺 key/name：%+v", s)
		}
		if !kinds[s.Kind] {
			t.Errorf("步骤 %s 的节点类型 %s 不是本插件登记的", s.Key, s.Kind)
		}
		if s.Config["recording"] != "{{recording_id}}" {
			t.Errorf("步骤 %s 的录音配置不对：%v", s.Key, s.Config)
		}
		keys[s.Key] = true
	}
	for _, s := range steps {
		for _, after := range s.After {
			if !keys[after] {
				t.Errorf("步骤 %s 依赖了不存在的步骤 %s", s.Key, after)
			}
		}
	}
	if steps[1].After[0] != steps[0].Key {
		t.Errorf("提取候选应排在生成纪要之后：%+v", steps[1])
	}
}

func TestSOPWithAndRender(t *testing.T) {
	out := sopWith(map[string]any{"recording_id": "rec_1"}, "minutes", map[string]any{"ok": true})
	if out["recording_id"] != "rec_1" || out["minutes"] == nil {
		t.Errorf("with 不应丢输入：%+v", out)
	}
	input := map[string]any{"recording_id": "rec_9", "items": []any{map[string]any{"title": "第一条"}}}
	if got := sopRender("{{recording_id}}", input); got != "rec_9" {
		t.Errorf("模板渲染 = %q", got)
	}
	if got := sopRender("{{items[0].title}}", input); got != "第一条" {
		t.Errorf("数组下标模板渲染 = %q", got)
	}
	if got := sopRender("{{nope}}", input); got != "" {
		t.Errorf("取不到应为空：%q", got)
	}
}
