// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package events

import "testing"

// run.finished 的 summary 只带结论，不带过程：IM 回执会把它原样回给需求方。
func TestRunConclusion(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"最后一次工具调用之后的文字",
			"先简单同步一下进度：我在读目录。\n[工具] Bash · ls -la\n[工具] Read · /a/b.md\n现在去查积分现状。\n[工具] Bash · git log\n[工具失败] Bash · 需要授权\n已写好 PRD，放在 cloud-v1105-01 目录。\n还差原型截图。",
			"已写好 PRD，放在 cloud-v1105-01 目录。\n还差原型截图。"},
		{"没有工具调用", "  直接给出结论。  ", "直接给出结论。"},
		{"以工具行结尾时退回最后一段文字",
			"开始。\n[工具] Bash · ls\n读完了，结论是 A。\n[工具] Read · x",
			"读完了，结论是 A。"},
		{"全是工具行", "[工具] Bash · ls\n[工具失败] Bash · x", ""},
		{"空", "", ""},
	}
	for _, c := range cases {
		if got := runConclusion(c.in); got != c.want {
			t.Errorf("%s：得到 %q，要 %q", c.name, got, c.want)
		}
	}
}
