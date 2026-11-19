// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// IM 来源（IM 0.32.0）：source_ref.thread_parent 认成提示词里的原消息；空正文、没有时为 nil。
func TestIMSourceThreadParent(t *testing.T) {
	obj := func(ref map[string]any) *domain.Object {
		return &domain.Object{Props: map[string]any{domain.PropSourceRef: ref}}
	}
	src := imSourceOf(obj(map[string]any{"message_id": "msg_1", "text": "回复", "thread_parent": map[string]any{"sender": "我", "text": " 原消息全文 ", "partial": true}}))
	if src == nil || src.ThreadParent == nil || src.ThreadParent.Text != "原消息全文" || src.ThreadParent.Sender != "我" || !src.ThreadParent.Partial {
		t.Fatalf("认出原消息：%+v", src)
	}
	if src := imSourceOf(obj(map[string]any{"message_id": "msg_1", "thread_parent": map[string]any{"text": " "}})); src == nil || src.ThreadParent != nil {
		t.Fatalf("空正文不算：%+v", src)
	}
	if src := imSourceOf(obj(map[string]any{"message_id": "msg_1"})); src == nil || src.ThreadParent != nil {
		t.Fatalf("没有原消息：%+v", src)
	}
}
