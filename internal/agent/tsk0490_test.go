// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// TSK-0490：create_sop / update_sop 回保存校验的警告（同编辑器保存后的提示），get_sop 末尾是 SOP 插件给的编排说明；
// 工具说明里条件只认结构化的 cond。
func TestSOPToolsWarningsAndGuide(t *testing.T) {
	chat := &grantChat{script: []func(func(Event)){
		grantCall(toolCreateSOP, `{"name":"群消息忽略","trigger":{"type":"im"},"steps":[{"key":"a","name":"设置忽略","kind":"auto","config":{"action":"ignore"}}]}`),
		grantCall(toolGetSOP, `{"flow_id":"sop_weekly"}`),
		grantSay("好了。"),
	}}
	r, cat, ctx := sopRunner(t, chat, map[string]string{ReadSOPAbility: store.GrantAuto, WriteSOPAbility: store.GrantAuto})
	cat.warns = []string{"（警告）第 1 步：「设置忽略」是自动执行节点，只把输入原样传下去"}
	cat.guide = "节点类型目录：\n- im_mark_message「标记消息」"
	if _, err := r.Run(ctx, "建一个流程", func(StreamEvent) {}); err != nil {
		t.Fatal(err)
	}
	if got := lastToolContent(chat.reqs[1]); !strings.Contains(got, "保存校验有这几处警告") || !strings.Contains(got, "自动执行节点") {
		t.Errorf("create_sop = %q", got)
	}
	if got := lastToolContent(chat.reqs[2]); !strings.Contains(got, "编排说明：") || !strings.Contains(got, "im_mark_message「标记消息」") {
		t.Errorf("get_sop = %q", got)
	}
	var desc string
	for _, tl := range chat.reqs[0].Tools {
		if tl.Name == toolCreateSOP {
			desc = tl.Description
		}
	}
	if !strings.Contains(desc, `"cond":{"logic":"and"`) || strings.Contains(desc, `"rule":"字段 等于 值"`) {
		t.Errorf("create_sop 说明 = %q", desc)
	}
}
