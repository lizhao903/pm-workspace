// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"path/filepath"
	"testing"
)

// 读项目档案节点的目录回退（AUTO-06）：取第一个现在存在的目录，都不存在取第一个设了的，都没设为空串。
// 节点整条走 SOP 的用例在 IM 插件的 autointake_test.go（IM 需求自动受理）。
func TestFirstDir(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	gone := filepath.Join(a, "gone")
	for _, tc := range []struct {
		in   []string
		want string
	}{
		{[]string{a, b}, a},
		{[]string{"", b}, b},
		{[]string{gone, b}, b},
		{[]string{gone, ""}, gone},
		{[]string{"", ""}, ""},
	} {
		if got := firstDir(tc.in...); got != tc.want {
			t.Fatalf("firstDir(%v) = %q，要 %q", tc.in, got, tc.want)
		}
	}
}
