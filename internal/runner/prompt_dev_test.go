package runner

import (
	"strings"
	"testing"
)

func TestBuildPromptIncludesAcceptanceAndRepo(t *testing.T) {
	p := BuildPrompt(Task{Title: "修除零", Workdir: "/w", Acceptance: "- [ ] 抛 ValueError", Repo: "/w"})
	if !strings.Contains(p, "## 验收标准\n- [ ] 抛 ValueError") || !strings.Contains(p, "关联仓库：/w") {
		t.Fatalf("提示词里应有验收标准和关联仓库:\n%s", p)
	}
	// 没有时整节消失，不留空标题。
	p = BuildPrompt(Task{Title: "x", Workdir: "/w"})
	if strings.Contains(p, "验收标准") || strings.Contains(p, "关联仓库") {
		t.Fatalf("没有验收标准时不应出现该节:\n%s", p)
	}
}
