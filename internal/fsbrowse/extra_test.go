package fsbrowse

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withExtra 给一组受控的默认根和系统目录，额外根从空开始，测完清掉。
func withExtra(t *testing.T, roots, sys []string) {
	t.Helper()
	t.Cleanup(SetBoundsForTest(roots, sys))
}

func TestExtraRootAddBrowseRemove(t *testing.T) {
	base := mustEval(t, t.TempDir())
	home := filepath.Join(base, "home")
	outside := filepath.Join(base, "outside")
	mkdirs(t, base, "home", "outside/sub")
	withExtra(t, []string{home}, nil)

	if _, err := List(outside); !errors.Is(err, ErrForbidden) {
		t.Fatalf("没加之前应该越界，实际 %v", err)
	}
	file := filepath.Join(base, "roots.json")
	if err := LoadExtraRoots(file); err != nil {
		t.Fatal(err)
	}
	r, err := AddExtraRoot(outside, "")
	if err != nil {
		t.Fatal(err)
	}
	if r.Path != outside || r.AddedAt.IsZero() {
		t.Fatalf("存下的不对：%+v", r)
	}
	l, err := List(filepath.Join(outside, "sub"))
	if err != nil {
		t.Fatalf("加了之后应该能浏览：%v", err)
	}
	if l.Parent != outside || l.Root != outside {
		t.Fatalf("上一级和根应是额外根本身：parent=%q root=%q", l.Parent, l.Root)
	}
	found := false
	for _, s := range Shortcuts() {
		if s.Path == outside && strings.HasPrefix(s.Label, "可浏览目录") {
			found = true
		}
	}
	if !found {
		t.Fatal("额外根应该出现在起跳点里")
	}

	// 重新读文件还在
	resetExtraRoots()
	if err := LoadExtraRoots(file); err != nil {
		t.Fatal(err)
	}
	if got := ExtraRoots(); len(got) != 1 || got[0].Path != outside {
		t.Fatalf("重新读入后应还有这一条：%+v", got)
	}

	if _, err := AddExtraRoot(outside, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("加两次应是冲突，实际 %v", err)
	}
	if _, err := RemoveExtraRoot(outside); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveExtraRoot(outside); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("删两次应是不存在，实际 %v", err)
	}
	_, err = List(outside)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("删掉之后应回到越界，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "设置 - 本机目录") {
		t.Fatalf("越界说明应告诉用户去哪加：%v", err)
	}
	b, _ := os.ReadFile(file)
	if strings.Contains(string(b), outside) {
		t.Fatalf("删掉后文件里不该还有：%s", b)
	}
}

func TestExtraRootRejects(t *testing.T) {
	base := mustEval(t, t.TempDir())
	home := filepath.Join(base, "home")
	sys := filepath.Join(base, "sys")
	data := filepath.Join(base, "work", "data")
	mkdirs(t, base, "home/proj", "sys/conf", "work/data")
	writeFile(t, filepath.Join(base, "f.txt"))
	// 外面放一个软链，指进「系统目录」
	link := filepath.Join(base, "link")
	if err := os.Symlink(filepath.Join(sys, "conf"), link); err != nil {
		t.Fatal(err)
	}
	withExtra(t, []string{home}, []string{sys})

	cases := []struct {
		name, path string
		kind       error
		msg        string
	}{
		{"根目录", "/", ErrBadRequest, "根目录"},
		{"空", " ", ErrBadRequest, "绝对路径"},
		{"相对路径", "a/b", ErrBadRequest, "绝对路径"},
		{"系统目录", sys, ErrBadRequest, "系统目录"},
		{"系统目录里", filepath.Join(sys, "conf"), ErrBadRequest, "系统目录"},
		{"软链指进系统目录", link, ErrBadRequest, "指向"},
		{"不存在", filepath.Join(base, "nope"), fs.ErrNotExist, "不存在"},
		{"文件", filepath.Join(base, "f.txt"), ErrNotDir, "不是目录"},
		{"数据目录", data, ErrBadRequest, "数据目录"},
		{"数据目录的上级", filepath.Join(base, "work"), ErrBadRequest, "数据目录"},
		{"默认范围里", filepath.Join(home, "proj"), ErrConflict, "默认"},
		{"默认范围里但字面量在系统目录", filepath.Join(sys, "..", "home", "proj"), ErrConflict, "默认"},
	}
	for _, c := range cases {
		_, err := AddExtraRoot(c.path, data)
		if !errors.Is(err, c.kind) || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s：应是 %v 且说明含「%s」，实际 %v", c.name, c.kind, c.msg, err)
		}
	}
	if n := len(ExtraRoots()); n != 0 {
		t.Fatalf("被拒的不该存下，实际 %d 条", n)
	}
}

func TestExtraRootRejectsRealSystemDirs(t *testing.T) {
	// 真实的系统目录清单，只做校验不写盘
	for _, p := range []string{"/", "/etc", "/private/etc", "/usr/local", "/System", "/Library", "/var", "/dev"} {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		_, err := AddExtraRoot(p, "")
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s 应被拒，实际 %v", p, err)
		}
	}
}

func TestLoadExtraRootsDropsInvalid(t *testing.T) {
	base := mustEval(t, t.TempDir())
	ok := filepath.Join(base, "ok")
	mkdirs(t, base, "ok")
	withExtra(t, []string{filepath.Join(base, "home")}, []string{"/etc"})
	file := filepath.Join(base, "roots.json")
	body := `{"roots":[{"path":"/"},{"path":"/etc/x"},{"path":"rel"},{"path":` + `"` + ok + `"}]}`
	if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := LoadExtraRoots(file); err == nil {
		t.Fatal("有不合规的条目应该告知")
	}
	if got := ExtraRoots(); len(got) != 1 || got[0].Path != ok {
		t.Fatalf("只该留下合规的那条：%+v", got)
	}
	// 文件不存在当空清单
	if err := LoadExtraRoots(filepath.Join(base, "none.json")); err != nil || len(ExtraRoots()) != 0 {
		t.Fatalf("文件不存在应是空清单：%v %v", err, ExtraRoots())
	}
}

func TestShortcutsListVolumes(t *testing.T) {
	base := mustEval(t, t.TempDir())
	vols := filepath.Join(base, "Volumes")
	mkdirs(t, vols, "project", "Docs", ".timemachine")
	if err := os.Symlink("/", filepath.Join(vols, "Macintosh HD")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(base, "home"))
	withExtra(t, []string{vols}, nil)
	old := volumesDir
	volumesDir = vols
	t.Cleanup(func() { volumesDir = old })

	got := map[string]string{}
	var labels []string
	for _, s := range Shortcuts() {
		got[s.Label] = s.Path
		labels = append(labels, s.Label)
	}
	if got["外挂分区：project"] != filepath.Join(vols, "project") || got["外挂分区：Docs"] != filepath.Join(vols, "Docs") {
		t.Fatalf("每个分区都该有一条：%v", labels)
	}
	if got["/Volumes（全部分区）"] != vols {
		t.Fatalf("应有一条 /Volumes：%v", labels)
	}
	for _, l := range labels {
		if strings.Contains(l, "Macintosh") || strings.Contains(l, "timemachine") {
			t.Fatalf("指回根盘的软链和隐藏项不该列：%v", labels)
		}
	}
	// 插上一块新盘，刷新即有
	mkdirs(t, vols, "sandbox")
	found := false
	for _, s := range Shortcuts() {
		found = found || s.Label == "外挂分区：sandbox"
	}
	if !found {
		t.Fatal("新挂的分区应立即出现")
	}
	l, err := List(filepath.Join(vols, "project"))
	if err != nil {
		t.Fatal(err)
	}
	if l.Root != vols {
		t.Fatalf("分区里的根应是 /Volumes，实际 %q", l.Root)
	}
}
