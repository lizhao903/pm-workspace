// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package fsbrowse

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withRoots 把可浏览范围换成一组受控目录。用真实的 $HOME 做边界测试，
// 换台机器就测不准了；而且「同前缀兄弟目录」那条必须自己造目录才测得出来。
func withRoots(t *testing.T, roots ...string) {
	t.Helper()
	old := rootsFn
	rootsFn = func() []string { return roots }
	t.Cleanup(func() { rootsFn = old })
}

func mkdirs(t *testing.T, base string, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := os.MkdirAll(filepath.Join(base, n), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", n, err)
		}
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func entryNames(t *testing.T, path string) []string {
	t.Helper()
	l, err := List(path)
	if err != nil {
		t.Fatalf("List(%s): %v", path, err)
	}
	out := make([]string, 0, len(l.Entries))
	for _, e := range l.Entries {
		out = append(out, e.Name)
	}
	return out
}

func has(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// --- 只列目录 ---

func TestListReturnsDirectoriesOnly(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "alpha", "beta")
	writeFile(t, filepath.Join(base, "notes.md"))
	writeFile(t, filepath.Join(base, "pm.db"))

	got := entryNames(t, base)
	if len(got) != 2 || !has(got, "alpha") || !has(got, "beta") {
		t.Fatalf("只该列出目录，实际 %v", got)
	}

	l, err := List(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range l.Entries {
		if !e.IsDir {
			t.Fatalf("条目 %s 的 IsDir 应为 true", e.Name)
		}
		// 条目路径拼在解析后的目录上，界面拿到的一律是真实路径。
		if e.Path != filepath.Join(l.Path, e.Name) {
			t.Fatalf("条目 %s 的 Path 应是绝对路径，实际 %q", e.Name, e.Path)
		}
	}
}

func TestListSortsCaseInsensitively(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "Zebra", "apple", "Mango")

	got := entryNames(t, base)
	want := []string{"apple", "Mango", "Zebra"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("排序应忽略大小写，want %v got %v", want, got)
	}
}

func TestListRejectsFile(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	f := filepath.Join(base, "notes.md")
	writeFile(t, f)

	_, err := List(f)
	if !errors.Is(err, ErrNotDir) {
		t.Fatalf("对文件调 List 应报 ErrNotDir，实际 %v", err)
	}
}

// --- 隐藏 . 开头，但显式传路径能进 ---

func TestListHidesDotEntriesButAllowsExplicitPath(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, ".git", ".ssh", "src", ".config/nested")

	got := entryNames(t, base)
	if has(got, ".git") || has(got, ".ssh") || has(got, ".config") {
		t.Fatalf("以 . 开头的条目不该出现在列表里，实际 %v", got)
	}
	if !has(got, "src") {
		t.Fatalf("普通目录应该在，实际 %v", got)
	}

	// 不显示不等于不让进：用户自己把路径打进来照样能浏览。
	inside := entryNames(t, filepath.Join(base, ".config"))
	if !has(inside, "nested") {
		t.Fatalf("显式传 .config 应该能列出内容，实际 %v", inside)
	}
}

// --- 边界 ---

func TestListRejectsSystemPaths(t *testing.T) {
	// 这里用真实的默认范围，测的就是线上那套根。
	for _, p := range []string{"/etc", "/System", "/private/var", "/usr/local", "/"} {
		_, err := List(p)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("List(%s) 应被边界拒绝，实际 %v", p, err)
		}
	}
}

func TestListRejectsDotDotTraversal(t *testing.T) {
	base := t.TempDir()
	inner := filepath.Join(base, "inner")
	mkdirs(t, base, "inner")
	withRoots(t, inner)

	// 字面量里带 .. 穿出去，Clean 之后就露馅。
	_, err := List(inner + "/../")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("../ 穿越应被拒绝，实际 %v", err)
	}
	_, err = List(filepath.Join(inner, "..", "..", "etc"))
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("多级 ../ 穿越应被拒绝，实际 %v", err)
	}
}

func TestListRejectsSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir() // 另一棵树，不在范围内
	withRoots(t, base)
	mkdirs(t, outside, "secrets")
	mkdirs(t, base, "ok")

	link := filepath.Join(base, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	// 走进去要被拦。
	_, err := List(link)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("软链逃逸应被拒绝，实际 %v", err)
	}
	// 列表里也不该出现——让用户点一下才吃拒绝是最差的体验。
	got := entryNames(t, base)
	if has(got, "escape") {
		t.Fatalf("指向范围外的软链不该出现在列表里，实际 %v", got)
	}
	if !has(got, "ok") {
		t.Fatalf("同目录下的正常条目应该还在，实际 %v", got)
	}
}

func TestListAllowsSymlinkInsideBounds(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "real/deep", "holder")

	link := filepath.Join(base, "holder", "alias")
	if err := os.Symlink(filepath.Join(base, "real"), link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	got := entryNames(t, filepath.Join(base, "holder"))
	if !has(got, "alias") {
		t.Fatalf("指向范围内的软链应该能选，实际 %v", got)
	}
	l, err := List(link)
	if err != nil {
		t.Fatalf("List(alias): %v", err)
	}
	// Path 回的是解析后的真实路径，界面显示的和服务端实际读的才是同一个地方。
	if l.Path != mustEval(t, filepath.Join(base, "real")) {
		t.Fatalf("Path 应是解析软链后的真实路径，实际 %q", l.Path)
	}
}

// TestBoundaryRequiresSeparator 是最容易写错的一条：只比字符串前缀的话，
// /Users/example 会把隔壁的 /Users/exampleevil 一起放进来。
func TestBoundaryRequiresSeparator(t *testing.T) {
	base := t.TempDir()
	mkdirs(t, base, "broleez/work", "broleezevil")
	withRoots(t, filepath.Join(base, "broleez"))

	if _, err := List(filepath.Join(base, "broleez", "work")); err != nil {
		t.Fatalf("根之内的目录应该放行，实际 %v", err)
	}
	_, err := List(filepath.Join(base, "broleezevil"))
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("同前缀的兄弟目录应被拒绝，实际 %v", err)
	}
	// 根本身要能列。
	if _, err := List(filepath.Join(base, "broleez")); err != nil {
		t.Fatalf("根本身应该能列，实际 %v", err)
	}
}

func TestListRejectsRelativeAndMissing(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)

	if _, err := List("relative/path"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("相对路径应被拒绝，实际 %v", err)
	}
	_, err := List(filepath.Join(base, "nope"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("不存在的目录应报 ErrNotExist，实际 %v", err)
	}
}

func TestListDefaultsToHome(t *testing.T) {
	base := t.TempDir()
	t.Setenv("HOME", base)
	withRoots(t, base)
	mkdirs(t, base, "Desktop")

	l, err := List("")
	if err != nil {
		t.Fatalf("空 path 应回落主目录，实际 %v", err)
	}
	if l.Path != mustEval(t, base) {
		t.Fatalf("空 path 应列主目录，实际 %q", l.Path)
	}
}

func TestParentStopsAtBoundary(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "a/b")

	root, err := List(base)
	if err != nil {
		t.Fatal(err)
	}
	if root.Parent != "" {
		t.Fatalf("已在范围边界上，Parent 应为空串，实际 %q", root.Parent)
	}
	deep, err := List(filepath.Join(base, "a", "b"))
	if err != nil {
		t.Fatal(err)
	}
	if deep.Parent != mustEval(t, filepath.Join(base, "a")) {
		t.Fatalf("Parent 应指向上一级，实际 %q", deep.Parent)
	}
}

// --- 可写标记 ---

func TestWritableFlag(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 无视权限位，这条测不出来")
	}
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "rw", "ro")
	ro := filepath.Join(base, "ro")
	if err := os.Chmod(ro, 0o500); err != nil { // r-x：能进去，不能写
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })

	l, err := List(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range l.Entries {
		switch e.Name {
		case "rw":
			if !e.Writable {
				t.Fatal("可写目录的 Writable 应为 true")
			}
		case "ro":
			if e.Writable {
				t.Fatal("不可写目录的 Writable 应为 false")
			}
		}
	}
	if !l.Writable {
		t.Fatal("当前目录可写，FsListing.Writable 应为 true")
	}

	roL, err := List(ro)
	if err != nil {
		t.Fatalf("不可写目录仍应能列出内容：%v", err)
	}
	if roL.Writable {
		t.Fatal("站在不可写目录里时 FsListing.Writable 应为 false")
	}
}

// --- 单条出错不拖垮整个列表 ---

func TestListSkipsUnreachableEntries(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 无视权限位，这条测不出来")
	}
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "good", "locked/hidden")

	locked := filepath.Join(base, "locked")
	// 指向一个进不去的目录内部：Stat 会拿到 EACCES。这条必须被跳过——
	// 一个 ~/Library 就能让整个主目录列不出来的话，用户看到的是一片空白。
	if err := os.Symlink(filepath.Join(locked, "hidden"), filepath.Join(base, "blocked")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// 断掉的软链：Stat 也会失败，同样只能跳过。
	if err := os.Symlink(filepath.Join(base, "gone"), filepath.Join(base, "dangling")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	got := entryNames(t, base)
	if !has(got, "good") {
		t.Fatalf("正常目录应该还在，实际 %v", got)
	}
	if has(got, "blocked") || has(got, "dangling") {
		t.Fatalf("够不着的条目应被跳过，实际 %v", got)
	}
	// locked 本身仍在列表里：stat 它只需要父目录的搜索权限，进不去是点进去之后的事。
	if !has(got, "locked") {
		t.Fatalf("locked 本身应该还在列表里，实际 %v", got)
	}
}

func TestListUnreadableDirReportsPermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root 无视权限位，这条测不出来")
	}
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "locked")
	locked := filepath.Join(base, "locked")
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	_, err := List(locked)
	if !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("进不去的目录应报权限错误，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "权限") {
		t.Fatalf("报错要说清是权限问题，实际 %q", err.Error())
	}
}

// --- Mkdir ---

func TestMkdirCreatesOneLevel(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)

	l, err := Mkdir(base, "新项目")
	if err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	if fi, err := os.Stat(filepath.Join(base, "新项目")); err != nil || !fi.IsDir() {
		t.Fatalf("目录没建出来：%v", err)
	}
	// 返回的是建好之后所在目录的列表，界面可以直接刷新。
	found := false
	for _, e := range l.Entries {
		if e.Name == "新项目" {
			found = true
		}
	}
	if !found {
		t.Fatal("返回的列表里应包含刚建的目录")
	}
	if l.Path != mustEval(t, base) {
		t.Fatalf("返回的应是 parent 的列表，实际 %q", l.Path)
	}
}

func TestMkdirRejectsBadNames(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)

	bad := []string{"", "   ", ".", "..", "../evil", "a/b", "/abs", "..hidden", ".hidden",
		strings.Repeat("x", maxNameLen+1)}
	for _, n := range bad {
		if _, err := Mkdir(base, n); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("Mkdir(%q) 应被拒绝，实际 %v", n, err)
		}
	}
	// 一个都不许落地。
	items, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("非法名字不该建出任何东西，实际 %d 条", len(items))
	}
}

func TestMkdirRejectsOutOfBounds(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)

	if _, err := Mkdir("/etc", "pwn"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("越界的 parent 应被拒绝，实际 %v", err)
	}
	if _, err := Mkdir(base+"/..", "pwn"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("parent 里的 .. 穿越应被拒绝，实际 %v", err)
	}
}

func TestMkdirRejectsExisting(t *testing.T) {
	base := t.TempDir()
	withRoots(t, base)
	mkdirs(t, base, "dup")

	_, err := Mkdir(base, "dup")
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("重名应报错而不是静默成功，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "已经存在") {
		t.Fatalf("报错要说清是重名，实际 %q", err.Error())
	}
}

// --- Shortcuts ---

func TestShortcutsSkipsMissingDirs(t *testing.T) {
	base := t.TempDir()
	t.Setenv("HOME", base)
	withRoots(t, base)
	mkdirs(t, base, "Desktop", "Documents") // 故意不建 Downloads

	got := map[string]string{}
	for _, s := range Shortcuts() {
		got[s.Label] = s.Path
	}
	for _, want := range []string{"主目录", "桌面", "文稿"} {
		if got[want] == "" {
			t.Fatalf("应该有 %s 这个起跳点，实际 %v", want, got)
		}
	}
	if _, ok := got["下载"]; ok {
		t.Fatal("不存在的目录不该出现在起跳点里")
	}
	if got["桌面"] != filepath.Join(base, "Desktop") {
		t.Fatalf("桌面路径不对：%q", got["桌面"])
	}
}

func TestShortcutsAllPathsAreBrowsable(t *testing.T) {
	// 用真实环境跑一遍：起跳点必须个个点得开，列一个点不进去的入口比不列更糟。
	for _, s := range Shortcuts() {
		if s.Label == "" || s.Path == "" {
			t.Fatalf("起跳点字段不完整：%+v", s)
		}
		if _, err := List(s.Path); err != nil {
			t.Fatalf("起跳点 %s (%s) 点不开：%v", s.Label, s.Path, err)
		}
	}
}

// TestEveryRootIsReachableFromShortcuts 守的是一类自相矛盾：某个根「允许访问」，
// 界面上却没有任何路能走到它。根目录 / 不让浏览，所以够不到的根就是真的够不到——
// 只能手打路径，而手打路径正是这套选择器要取消的东西。
//
// 「够得到」= 有某个起跳点落在这个根之内：落在根上就是直接到，落在根的子目录里
// 就能靠 Parent 一路走上来（parentOf 到边界才停）。
func TestEveryRootIsReachableFromShortcuts(t *testing.T) {
	// 两边都解析软链再比：/tmp 和 /private/tmp 是同一个目录，按字面量比会以为
	// 「/tmp 有入口而 /private/tmp 没有」，可它们本来就是一个地方。
	shortcuts := []string{}
	for _, s := range Shortcuts() {
		shortcuts = append(shortcuts, mustEval(t, s.Path))
	}
	for _, root := range rootForms() {
		reachable := false
		for _, p := range shortcuts {
			if within(p, []string{mustEval(t, root)}) {
				reachable = true
				break
			}
		}
		if !reachable {
			t.Errorf("根 %s 在允许范围内，却没有任何起跳点能走到它——"+
				"要么给它加一条起跳点，要么把它从允许范围里去掉", root)
		}
	}
}

func TestShortcutsIncludeTmp(t *testing.T) {
	for _, s := range Shortcuts() {
		if s.Path != "/tmp" {
			continue
		}
		if !strings.Contains(s.Label, "临时") {
			t.Fatalf("/tmp 的标签要让用户看出它是临时的，实际 %q", s.Label)
		}
		if _, err := List(s.Path); err != nil {
			t.Fatalf("/tmp 起跳点点不开：%v", err)
		}
		return
	}
	t.Fatal("起跳点里应该有 /tmp：它在允许范围内，没有入口用户就够不着")
}

func TestShortcutsIncludeProjectRoot(t *testing.T) {
	// 测试跑在 internal/fsbrowse 里，向上找 go.mod 应该找到仓库根。
	root := projectRoot()
	if fi, err := os.Stat(filepath.Join(root, "go.mod")); err != nil || fi.IsDir() {
		t.Fatalf("projectRoot 应指向带 go.mod 的仓库根，实际 %q", root)
	}
	for _, s := range Shortcuts() {
		if s.Label == "当前项目" {
			if s.Path != root {
				t.Fatalf("当前项目起跳点应是 %q，实际 %q", root, s.Path)
			}
			return
		}
	}
	t.Fatal("起跳点里应该有「当前项目」")
}

func mustEval(t *testing.T, p string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s): %v", p, err)
	}
	return real
}
