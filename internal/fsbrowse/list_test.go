package fsbrowse

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestKindOf(t *testing.T) {
	cases := map[string]string{
		"md": KindText, "MD": KindText, "jsonl": KindText, "csv": KindText, "mmd": KindText,
		"pdf": KindPDF, "png": KindImage, "JPG": KindImage, "jpeg": KindImage, "gif": KindImage, "webp": KindImage, "svg": KindImage,
		"docx": KindOffice, "doc": KindOffice, "xlsx": KindOffice, "xls": KindOffice, "pptx": KindOffice, "ppt": KindOffice,
		"key": KindOffice, "pages": KindOffice, "numbers": KindOffice,
		"zip": "", "py": "", "exe": "", "command": "", "app": "", "": "",
	}
	for ext, want := range cases {
		if got := KindOf(ext); got != want {
			t.Errorf("KindOf(%q) = %q, want %q", ext, got, want)
		}
	}
}

func TestWalkCmp(t *testing.T) {
	cases := []struct {
		a, b string
		cmp  int
		anc  bool
	}{
		{"a", "a/b", -1, true},
		{"a/b", "a", 1, false},
		{"a-b", "a/b", 1, false}, // 逐段比：段 "a-b" 比段 "a" 长，排在 a 整棵子树后面（整串比的话 '-' 在 '/' 前，会排错）
		{"a/z", "b", -1, false},
		{"b", "a/z", 1, false},
		{"a/b", "a/b", 0, false},
	}
	for _, c := range cases {
		cmp, anc := walkCmp(c.a, c.b)
		if cmp != c.cmp || anc != c.anc {
			t.Errorf("walkCmp(%q,%q) = %d %v, want %d %v", c.a, c.b, cmp, anc, c.cmp, c.anc)
		}
	}
}

// 造一棵有深有浅、名字容易排错（a、a-b、a.b、a/b）的目录树，返回应列出的文件（WalkDir 顺序）和跳过数。
func makeTree(t *testing.T, root string) (want []string, skipped int) {
	t.Helper()
	files := []string{
		"a/b.md", "a/c/d.pdf", "a/c/e.png", "a-b.md", "a.b/x.docx", "a.md",
		"z/1.md", "z/2.xlsx", "z/deep/er/than/you/think.md", "中文/说明.md", "中文/图.jpg",
	}
	for i := range 30 {
		files = append(files, fmt.Sprintf("many/f%02d.md", i))
	}
	other := []string{"a/c/run.py", "z/archive.zip", "many/x.bin"}
	for _, f := range append(append([]string{}, files...), other...) {
		put(t, filepath.Join(root, filepath.FromSlash(f)), []byte("x"))
	}
	// 目录形式的 Keynote：整个包当一个文件，不往里走
	put(t, filepath.Join(root, "talk.key", "Index.zip"), []byte("x"))
	files = append(files, "talk.key")
	// 不往里走、不计数的
	put(t, filepath.Join(root, "node_modules", "p.md"), []byte("x"))
	put(t, filepath.Join(root, ".git", "h.md"), []byte("x"))
	put(t, filepath.Join(root, ".hidden.md"), []byte("x"))
	all, err := ListFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, f := range all.Files {
		rels = append(rels, f.Rel)
	}
	sorted := append([]string{}, rels...)
	sort.Slice(sorted, func(i, j int) bool { c, _ := walkCmp(sorted[i], sorted[j]); return c < 0 })
	if strings.Join(sorted, ",") != strings.Join(rels, ",") {
		t.Fatalf("不是 WalkDir 顺序：%v", rels)
	}
	return rels, len(other)
}

func TestListFilesPagesJoinToFull(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	full, skipped := makeTree(t, root)
	if len(full) != 42 {
		t.Fatalf("全量 %d 个：%v", len(full), full)
	}
	for _, size := range []int{1, 2, 3, 7, 41, 42, 100} {
		var got []string
		sk, pages := 0, 0
		for cur := ""; ; pages++ {
			l, err := ListFilesPage(root, cur, size)
			if err != nil {
				t.Fatal(err)
			}
			if len(l.Files) > size {
				t.Fatalf("size %d：一页 %d 个", size, len(l.Files))
			}
			if l.Truncated {
				t.Fatalf("size %d 不该截断：%+v", size, l)
			}
			for _, f := range l.Files {
				got = append(got, f.Rel)
			}
			sk += l.Skipped
			if l.NextCursor == "" {
				break
			}
			cur = l.NextCursor
			if pages > 100 {
				t.Fatal("翻页停不下来")
			}
		}
		if strings.Join(got, ",") != strings.Join(full, ",") {
			t.Fatalf("size %d 拼出来不对：\n%v\n%v", size, got, full)
		}
		if sk != skipped {
			t.Fatalf("size %d skipped = %d, want %d", size, sk, skipped)
		}
	}
}

func TestListFilesPageTimeBudget(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	full, _ := makeTree(t, root)
	old := pageBudget
	pageBudget = -time.Second // 每处理一项就交回去
	defer func() { pageBudget = old }()
	var got []string
	for cur, n := "", 0; ; n++ {
		l, err := ListFilesPage(root, cur, 1000)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range l.Files {
			got = append(got, f.Rel)
		}
		if l.NextCursor == "" {
			break
		}
		if l.Truncated {
			t.Fatal("时间预算用完不算截断")
		}
		cur = l.NextCursor
		if n > 1000 {
			t.Fatal("原地打转")
		}
	}
	if strings.Join(got, ",") != strings.Join(full, ",") {
		t.Fatalf("拼出来不对：%v", got)
	}
}

func TestListFilesVisitedCap(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	for i := range 5 {
		put(t, filepath.Join(root, fmt.Sprintf("f%d.md", i)), []byte("x"))
	}
	// 游标里带的累计走查数已经到上限：下一页什么都不列，截断，原因是走查项数
	l, err := ListFilesPage(root, encodeCursor(cursor{A: "f1.md", V: MaxListVisited}), 10)
	if err != nil {
		t.Fatal(err)
	}
	if !l.Truncated || l.Reason != TruncVisited || l.NextCursor != "" || len(l.Files) != 0 {
		t.Fatalf("got %+v", l)
	}
	// 没到上限：正常列完
	l, err = ListFilesPage(root, encodeCursor(cursor{A: "f1.md", V: MaxListVisited - 10}), 10)
	if err != nil || l.Truncated || len(l.Files) != 3 {
		t.Fatalf("got %+v %v", l, err)
	}
}

func TestListFilesDepthCap(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	segs := make([]string, MaxListDepth+2)
	for i := range segs {
		segs[i] = "d"
	}
	put(t, filepath.Join(root, filepath.Join(segs[:MaxListDepth]...), "ok.md"), []byte("x"))
	put(t, filepath.Join(root, filepath.Join(segs...), "too-deep.md"), []byte("x"))
	put(t, filepath.Join(root, "top.md"), []byte("x"))
	l, err := ListFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if !l.Truncated || l.Reason != TruncDepth || len(l.Files) != 2 {
		t.Fatalf("got truncated=%v reason=%q files=%d", l.Truncated, l.Reason, len(l.Files))
	}
}

func TestListFilesBadCursor(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	for _, c := range []string{"!!", encodeCursor(cursor{A: "../x"}), encodeCursor(cursor{A: "/etc"}), encodeCursor(cursor{V: -1})} {
		if _, err := ListFilesPage(root, c, 10); err == nil {
			t.Errorf("cursor %q 该报错", c)
		}
	}
}

func TestOpenPreviewAndStatFile(t *testing.T) {
	root := realTemp(t)
	outside := realTemp(t)
	withRoots(t, root)
	put(t, filepath.Join(root, "a.pdf"), []byte("%PDF-1.4"))
	put(t, filepath.Join(root, "a.docx"), []byte("x"))
	put(t, filepath.Join(outside, "b.pdf"), []byte("%PDF"))
	f, fi, ct, err := OpenPreview(filepath.Join(root, "a.pdf"))
	if err != nil || ct != "application/pdf" || fi.Size() != 8 {
		t.Fatalf("pdf: %v %q", err, ct)
	}
	_ = f.Close()
	if _, _, _, err := OpenPreview(filepath.Join(root, "a.docx")); err == nil {
		t.Error("docx 不该能预览")
	}
	if _, _, _, err := OpenPreview(filepath.Join(outside, "b.pdf")); err == nil {
		t.Error("越界不该能预览")
	}
	if err := os.Symlink(filepath.Join(outside, "b.pdf"), filepath.Join(root, "link.pdf")); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := OpenPreview(filepath.Join(root, "link.pdf")); err == nil {
		t.Error("软链逃逸不该能预览")
	}
	if _, err := StatFile(filepath.Join(root, "a.docx")); err != nil {
		t.Error(err)
	}
	if _, err := StatFile(root); err == nil {
		t.Error("目录不是文件")
	}
}
