// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"strings"
	"testing"
)

// TSK-0460：交给工作台 Agent 的提示词由标题、验收标准、正文、所属项目、角色、补充说明拼成。
func TestBuildAgentPrompt(t *testing.T) {
	got := BuildAgentPrompt(AgentTask{Task: Task{
		Ref: "TSK-0009", Title: " 整理竞品清单 ", Body: "列出三家", Acceptance: "- [ ] 三家都有",
		Project: &Project{Name: "一人之下", Ref: "PRJ-0001"},
		Preset:  &Preset{Scene: "分类", Content: "只分类", ReadOnly: true},
		Extra:   "先看 A 家", Workdir: "/tmp/out",
	}})
	for _, want := range []string{"编号：TSK-0009", "标题：整理竞品清单", "## 任务描述\n列出三家", "## 验收标准\n- [ ] 三家都有",
		"名称：一人之下（PRJ-0001）", "## 执行要求（分类）", "这个角色只读", "## 本次执行的补充要求\n先看 A 家",
		"parent_ref=TSK-0009", "不能向用户提问", "write_file 写进 /tmp/out", "## 结束时"} {
		if !strings.Contains(got, want) {
			t.Fatalf("提示词缺 %q：\n%s", want, got)
		}
	}
	if strings.Contains(got, "接着上次") {
		t.Fatal("不是续跑")
	}
	resume := BuildAgentPrompt(AgentTask{Task: Task{Ref: "TSK-0009", Title: "x"}, Resume: true})
	if !strings.Contains(resume, "接着上次的执行") || strings.Contains(resume, "write_file 写进") || strings.Contains(resume, "## 执行要求") {
		t.Fatalf("续跑、没有目录和角色时：\n%s", resume)
	}
}
