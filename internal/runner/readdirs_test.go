// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadDirRulesCoverIncident（TSK-0851 复现）：「系统版本更新 → 视频素材」在 web-video 里跑，
// 去 pm-workspace 跑 git -C <目录> log 被拒——「允许改文件」档的白名单里只有 Bash(git log:*)，前缀对不上 git -C。
// 额外可读目录的规则要正好放开这类只读命令，又不放开同一目录里的写操作。
func TestReadDirRulesCoverIncident(t *testing.T) {
	repo := "/Volumes/project/0xBroleez/pm-workspace"
	gitLog := map[string]any{"command": `git -C ` + repo + ` log --since="1 week ago" --no-merges --date=short --pretty=format:"%h %ad %s"`}

	base := PermAllowed(PermAcceptEdits, nil)
	if r := MatchAny(base, "Bash", gitLog); r != "" {
		t.Fatalf("前提不成立：默认白名单已经放行了 %q（规则 %s）", gitLog["command"], r)
	}

	rules := ReadDirRules([]string{repo})
	for _, cmd := range []string{
		gitLog["command"].(string),
		"git -C " + repo + " show --stat abc123",
		"git -C " + repo + " diff HEAD~1",
		"git -C " + repo + " status --short",
	} {
		if MatchAny(rules, "Bash", map[string]any{"command": cmd}) == "" {
			t.Errorf("额外可读目录的规则没放行只读命令 %q", cmd)
		}
	}
	for _, cmd := range []string{
		"git -C " + repo + " push origin main",
		"git -C " + repo + " commit -m x",
		"git -C " + repo + " checkout .",
		"git -C /elsewhere log",
	} {
		if r := MatchAny(rules, "Bash", map[string]any{"command": cmd}); r != "" {
			t.Errorf("%q 不该被额外可读目录的规则放行（命中 %s）", cmd, r)
		}
	}
	if rules[0] != "Read(//Volumes/project/0xBroleez/pm-workspace/**)" {
		t.Errorf("第一条要是 Read 规则，得到 %q", rules[0])
	}
	for _, r := range rules {
		if strings.HasPrefix(r, "Edit") || strings.HasPrefix(r, "Write") {
			t.Errorf("额外可读目录不能放开写：%s", r)
		}
	}
}

func TestReadDirRulesUnsafePathOnlyRead(t *testing.T) {
	rules := ReadDirRules([]string{"/a b/c"})
	if len(rules) != 1 || rules[0] != "Read(//a b/c/**)" {
		t.Fatalf("路径带空格只给 Read 规则，得到 %v", rules)
	}
}

func TestReadDirRulesSymlink(t *testing.T) {
	real := t.TempDir()
	real, _ = filepath.EvalSymlinks(real)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ReadDirRules([]string{link}), "\n")
	if !strings.Contains(got, "Read(/"+link+"/**)") || !strings.Contains(got, "Read(/"+real+"/**)") {
		t.Fatalf("软链接要连实际路径一起放，得到\n%s", got)
	}
}

func TestCheckReadDir(t *testing.T) {
	dir := t.TempDir()
	if got, err := CheckReadDir(" " + dir + "/ "); err != nil || got != filepath.Clean(dir) {
		t.Fatalf("CheckReadDir = %q %v", got, err)
	}
	f := filepath.Join(dir, "f.txt")
	_ = os.WriteFile(f, []byte("x"), 0o644)
	for _, bad := range []string{"", "rel/dir", filepath.Join(dir, "nope"), f} {
		if _, err := CheckReadDir(bad); err == nil {
			t.Errorf("CheckReadDir(%q) 要报错", bad)
		}
	}
	paren := filepath.Join(dir, "a(b)")
	_ = os.Mkdir(paren, 0o755)
	if _, err := CheckReadDir(paren); err == nil {
		t.Error("路径带括号要报错")
	}
}

func TestReadDirsSection(t *testing.T) {
	if ReadDirsSection(nil) != "" {
		t.Fatal("没有目录不加这一节")
	}
	s := ReadDirsSection([]string{"/x/repo"})
	for _, want := range []string{"## 额外可读目录", "- /x/repo", "git -C <目录> log", "不要 cd 过去再跑 git"} {
		if !strings.Contains(s, want) {
			t.Errorf("提示词里没有 %q：%s", want, s)
		}
	}
}

// TestDenialHintPointsToSOPReadDirs：工作目录外的命令被拒、推不出白名单规则时，提示里要指到 SOP 节点的「额外可读目录」。
func TestDenialHintPointsToSOPReadDirs(t *testing.T) {
	req := Request{AllowWrites: true, Permission: PermAcceptEdits, AllowedTools: PermAllowed(PermAcceptEdits, nil)}
	d := []Denial{{ToolName: "Bash", ToolInput: map[string]any{"command": "ls /Volumes/project/0xBroleez/pm-workspace/.git/logs/refs/heads/"}}}
	got := denialReason(d, req, true)
	if !strings.Contains(got, "「额外可读目录」") {
		t.Fatalf("提示里没指到额外可读目录：%s", got)
	}
}
