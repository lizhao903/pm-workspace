// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"strings"
	"testing"
)

// 「来源消息」一节（IM 0.32.0）：来源是消息列里的回复时，原消息全文写在回复前面；只有摘要时注明；没有原消息时照旧。
func TestPromptSourceThreadParent(t *testing.T) {
	base := func(p *SourceParent) string {
		return BuildPrompt(Task{Title: "文件投递", Source: &Source{Channel: "slack", Conversation: "#grant", Sender: "赵振华", Text: "这个华哥看一下吧", ThreadParent: p}})
	}
	got := base(&SourceParent{Sender: "Broleez Li", Text: "Grant Agent 外发文件有个问题\n会把私桶的链接发出去"})
	want := "这条任务来自消息列里的一条回复。消息列的原消息（Broleez Li）：\nGrant Agent 外发文件有个问题\n会把私桶的链接发出去\n\n回复：\n这条任务来自 slack 「#grant」里 赵振华 的消息：\n这个华哥看一下吧"
	if !strings.Contains(got, want) {
		t.Fatalf("原消息要写在回复前面：\n%s", got)
	}
	if got := base(&SourceParent{Sender: "Broleez Li", Text: "Grant Agent 外发文件", Partial: true}); !strings.Contains(got, "（只有摘要，全文没取到）") {
		t.Fatalf("摘要要注明：\n%s", got)
	}
	for _, p := range []*SourceParent{nil, {Sender: "x", Text: "  "}} {
		if got := base(p); strings.Contains(got, "消息列的原消息") || !strings.Contains(got, "## 来源消息\n这条任务来自 slack") {
			t.Fatalf("没有原消息时照旧：\n%s", got)
		}
	}
}
