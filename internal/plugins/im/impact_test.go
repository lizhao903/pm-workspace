// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// TestConnectorImpactCountsMessages（CONN-03）：按 connector_id 数消息；没收过消息的连接器没有这一项；停用后不问。
func TestConnectorImpactCountsMessages(t *testing.T) {
	ctx := context.Background()
	e := setup(t)
	code, out := call(t, e.h, "POST", "/api/im/callbacks/fake", `{"messages":[
  {"external_id":"C01:1","connector_id":"cn_a","conversation_id":"C01","sender_id":"U04LIN","text":"一","at":"2026-10-29T01:00:00Z"},
  {"external_id":"C01:2","connector_id":"cn_a","conversation_id":"C01","sender_id":"U04LIN","text":"二","at":"2026-10-29T01:01:00Z"},
  {"external_id":"C01:3","connector_id":"cn_b","conversation_id":"C01","sender_id":"U04LIN","text":"三","at":"2026-10-29T01:02:00Z"}
]}`)
	if code != 200 {
		t.Fatalf("回调：%d %v", code, out)
	}
	got := e.r.ConnectorImpacts(ctx, plugin.ConnectorRef{ID: "cn_a", Tool: "slack"})
	if len(got) != 1 || got[0].Plugin != "im" || got[0].Key != "messages" || got[0].Count != 2 ||
		got[0].Effect != plugin.ImpactKeep || got[0].Text != "2 条 IM 消息会变成「渠道已删除」，只能查看" {
		t.Fatalf("cn_a 的影响 = %+v", got)
	}
	if got := e.r.ConnectorImpacts(ctx, plugin.ConnectorRef{ID: "cn_none", Tool: "slack"}); len(got) != 0 {
		t.Fatalf("没消息的连接器 = %+v", got)
	}
	if err := e.r.Disable(ctx, "imwatch"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Disable(ctx, "im"); err != nil {
		t.Fatal(err)
	}
	if got := e.r.ConnectorImpacts(ctx, plugin.ConnectorRef{ID: "cn_a"}); len(got) != 0 {
		t.Fatalf("停用后还在问：%+v", got)
	}
}
