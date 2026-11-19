// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import "testing"

// 「相关串里的回复按 @我 算」（0.23.0）：只改与我的关系这一项（无关、@所有人按 @我，私聊不变）；没勾时和以前一模一样；
// 「除了 @我」的忽略流程勾上后放过相关串里的回复；会话照样要符合；不设关系时不起作用。
func TestIMRelevanceThreadRelated(t *testing.T) {
	cv := "cv_a"
	other := "cv_b"
	rel := imReceived{ConversationID: &cv, Relevance: "", ThreadRelated: true, ThreadReason: "mention"}
	plain := imReceived{ConversationID: &cv, Relevance: ""}
	me := imReceived{ConversationID: &cv, Relevance: "me"}
	for _, c := range []struct {
		name string
		t    IMTrigger
		m    imReceived
		want bool
	}{
		{"没勾：相关串里的无关回复不算", IMTrigger{Relevance: []string{"me", "dm"}}, rel, false},
		{"勾了：相关串里的无关回复算", IMTrigger{Relevance: []string{"me", "dm"}, ThreadRelated: true}, rel, true},
		{"勾了：不相关的照旧不算", IMTrigger{Relevance: []string{"me", "dm"}, ThreadRelated: true}, plain, false},
		{"勾了：@我 照旧算", IMTrigger{Relevance: []string{"me"}, ThreadRelated: true}, me, true},
		{"勾了：会话不符照旧不算", IMTrigger{Conversations: []string{other}, Relevance: []string{"me"}, ThreadRelated: true}, rel, false},
		{"除了 @我、私聊 + 勾了：相关串里的无关回复按 @我 算，放过", IMTrigger{Relevance: []string{"me", "dm"}, RelevanceMode: imModeExclude, ThreadRelated: true}, rel, false},
		{"除了 @我、私聊 + 没勾：无关回复照旧接住", IMTrigger{Relevance: []string{"me", "dm"}, RelevanceMode: imModeExclude}, rel, true},
		{"除了 @我 + 勾了：不相关的照旧接住", IMTrigger{Relevance: []string{"me"}, RelevanceMode: imModeExclude, ThreadRelated: true}, plain, true},
		{"只要 @所有人 + 勾了：相关串里的 @所有人 按 @我 算，不接", IMTrigger{Relevance: []string{"all"}, ThreadRelated: true}, imReceived{ConversationID: &cv, Relevance: "all", ThreadRelated: true}, false},
		{"只要私聊 + 勾了：私聊不变", IMTrigger{Relevance: []string{"dm"}, ThreadRelated: true}, imReceived{ConversationID: &cv, Relevance: "dm", ThreadRelated: true}, true},
		{"不设关系：都算", IMTrigger{ThreadRelated: true}, plain, true},
	} {
		if got := c.t.matches(c.m); got != c.want {
			t.Errorf("%s：matches=%v，要 %v", c.name, got, c.want)
		}
		if why, _ := c.t.filterMiss(c.m); (why == "") != c.want {
			t.Errorf("%s：filterMiss=%q，和 matches 不一致", c.name, why)
		}
	}
	// 存的样子：没勾时不写 thread_related，旧流程 im_filter 不变
	if s := (IMTrigger{Relevance: []string{"me"}, RelevanceMode: imModeInclude}).filterJSON(); s != `{"conversations":null,"relevance":["me"],"relevance_mode":"include"}` {
		t.Fatalf("没勾时存的：%s", s)
	}
	var back IMTrigger
	readIMFilter(IMTrigger{Relevance: []string{"me"}, ThreadRelated: true}.filterJSON(), &back)
	if !back.ThreadRelated {
		t.Fatal("勾了要存上、读回来")
	}
}
