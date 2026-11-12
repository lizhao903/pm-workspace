// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDiffFindsNewAndChangedFiles 是扫描的主路径。
func TestDiffFindsNewAndChangedFiles(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "已有.md"), "v1")
	write(t, filepath.Join(root, "没动过.md"), "原样")

	before := TakeSnapshot(root)

	// mtime 的分辨率在某些文件系统上只到秒，不等一下的话「改过」可能测不出来。
	// 这正是 fileMark 用（大小, mtime）而不是内容哈希的代价，写在这里免得
	// 下次有人以为这个 Sleep 是多余的。
	time.Sleep(1100 * time.Millisecond)
	write(t, filepath.Join(root, "已有.md"), "v2 内容变长了")
	write(t, filepath.Join(root, "docs", "新的.md"), "新文件")

	changed, truncated := Diff(before, TakeSnapshot(root))
	if truncated {
		t.Error("三个文件不该触发截断")
	}
	got := map[string]bool{}
	for _, c := range changed {
		rel, _ := filepath.Rel(root, c.Path)
		got[rel] = c.New
	}
	if len(got) != 2 {
		t.Fatalf("期望 2 个改动，得到 %d 个: %v", len(got), got)
	}
	if isNew, ok := got["已有.md"]; !ok || isNew {
		t.Errorf("已有.md 应被认成「改动」而不是新建，got ok=%v new=%v", ok, isNew)
	}
	if isNew, ok := got[filepath.Join("docs", "新的.md")]; !ok || !isNew {
		t.Errorf("docs/新的.md 应被认成新建，got ok=%v new=%v", ok, isNew)
	}
	if _, ok := got["没动过.md"]; ok {
		t.Error("没动过的文件不该出现在差集里")
	}
}

// TestSnapshotSkipsNoiseDirs 守 skipDirs。
//
// 这条如果失效，一次 npm install 会把几万个依赖文件登记成用户的产出，
// 产物页就此报废——而它不会报错，只会「有很多内容」。
func TestSnapshotSkipsNoiseDirs(t *testing.T) {
	root := t.TempDir()
	before := TakeSnapshot(root)

	for _, d := range []string{"node_modules", ".git", "dist", ".pmw-runs"} {
		write(t, filepath.Join(root, d, "x.txt"), "噪音")
	}
	// 嵌套一层也要挡住：node_modules/pkg/node_modules/... 是常见形状。
	write(t, filepath.Join(root, "src", "node_modules", "y.txt"), "噪音")
	write(t, filepath.Join(root, "方案.md"), "这才是产出")

	changed, _ := Diff(before, TakeSnapshot(root))
	if len(changed) != 1 {
		paths := make([]string, len(changed))
		for i, c := range changed {
			paths[i], _ = filepath.Rel(root, c.Path)
		}
		t.Fatalf("只该扫到 方案.md，得到 %d 条: %v", len(changed), paths)
	}
	if filepath.Base(changed[0].Path) != "方案.md" {
		t.Errorf("扫到的是 %q", changed[0].Path)
	}
}

// TestDiffTruncatesAndSaysSo 守「截断必须可见」。
// 静默截断会让用户以为这次执行就产出了这些。
func TestDiffTruncatesAndSaysSo(t *testing.T) {
	root := t.TempDir()
	before := TakeSnapshot(root)
	for i := 0; i < MaxRecordedArtifacts+5; i++ {
		write(t, filepath.Join(root, "f"+string(rune('a'+i%26))+string(rune('a'+i/26))+".txt"), "x")
	}

	changed, truncated := Diff(before, TakeSnapshot(root))
	if !truncated {
		t.Errorf("超过 %d 个改动应当报告截断", MaxRecordedArtifacts)
	}
	if len(changed) != MaxRecordedArtifacts {
		t.Errorf("截断后应剩 %d 条，得到 %d 条", MaxRecordedArtifacts, len(changed))
	}
	// 排序必须稳定，否则同一次执行重跑得到不同的产物先后，看上去像数据在跳。
	for i := 1; i < len(changed); i++ {
		if changed[i-1].Path >= changed[i].Path {
			t.Fatalf("结果没有按路径排序: %q >= %q", changed[i-1].Path, changed[i].Path)
		}
	}
}

// TestSnapshotDoesNotFollowSymlinks 守「软链不跟」。
// 跟了的话，工作目录里一个指向主目录的软链会让整个主目录被登记成这次的产出。
func TestSnapshotDoesNotFollowSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "别人的文件.md"), "不该被扫到")

	before := TakeSnapshot(root)
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("这个文件系统建不了软链: %v", err)
	}

	changed, _ := Diff(before, TakeSnapshot(root))
	for _, c := range changed {
		if filepath.Base(c.Path) == "别人的文件.md" {
			t.Fatalf("软链外的文件被扫进来了: %q", c.Path)
		}
	}
}

// TestSnapshotOnMissingDirIsEmpty 保证目录不存在时是空快照而不是 panic。
// 收尾阶段目录可能已经被 claude 自己删掉或改名了。
func TestSnapshotOnMissingDirIsEmpty(t *testing.T) {
	if got := TakeSnapshot(filepath.Join(t.TempDir(), "不存在")); len(got) != 0 {
		t.Errorf("不存在的目录应得到空快照，得到 %d 条", len(got))
	}
	if got := TakeSnapshot(""); len(got) != 0 {
		t.Errorf("空路径应得到空快照，得到 %d 条", len(got))
	}
}
