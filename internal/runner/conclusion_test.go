// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import "testing"

func TestConclusion(t *testing.T) {
	cases := map[string]string{
		"先简单同步一下进度：我在读目录。\n[工具] Bash · ls\n[工具] Read · a.go\n改好了，单测通过。": "改好了，单测通过。",
		"结论在前。\n[工具] Bash · go test ./...": "结论在前。",
		"[工具] Bash · ls\n[工具失败] Read · x":  "",
		"没有工具调用，直接回答。":                     "没有工具调用，直接回答。",
		"":                                 "",
	}
	for in, want := range cases {
		if got := Conclusion(in); got != want {
			t.Errorf("Conclusion(%q) = %q，应当 %q", in, got, want)
		}
	}
}
