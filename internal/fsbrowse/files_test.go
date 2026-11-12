// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package fsbrowse

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func put(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadFileText(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	p := filepath.Join(root, "a.md")
	put(t, p, []byte("# 标题\n正文"))
	f, err := ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if f.Content != "# 标题\n正文" || f.Binary || f.Truncated || f.Ext != "md" || f.Limit != MaxReadBytes {
		t.Fatalf("got %+v", f)
	}
}

func TestReadFileTruncatesOnRuneBoundary(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	p := filepath.Join(root, "big.txt")
	// 一个字母打头，后面全是三字节的中文，截断点正好落在字符中间
	data := []byte("ab" + strings.Repeat("中", MaxReadBytes/3+10))
	put(t, p, data)
	f, err := ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !f.Truncated || f.Binary || f.Size != int64(len(data)) {
		t.Fatalf("truncated=%v binary=%v size=%d", f.Truncated, f.Binary, f.Size)
	}
	if len(f.Content) > MaxReadBytes || len(f.Content) < MaxReadBytes-3 || !utf8.ValidString(f.Content) {
		t.Fatalf("content len %d valid=%v", len(f.Content), utf8.ValidString(f.Content))
	}
}

func TestReadFileBinaryMetaOnly(t *testing.T) {
	root := realTemp(t)
	withRoots(t, root)
	p := filepath.Join(root, "x.png")
	put(t, p, []byte{0x89, 'P', 'N', 'G', 0, 0, 1, 2})
	f, err := ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !f.Binary || f.Content != "" || f.Size != 8 {
		t.Fatalf("got %+v", f)
	}
}

func TestReadFileBounds(t *testing.T) {
	root := realTemp(t)
	outside := realTemp(t)
	withRoots(t, root)
	secret := filepath.Join(outside, "secret.txt")
	put(t, secret, []byte("no"))

	if _, err := ReadFile(secret); !errors.Is(err, ErrForbidden) {
		t.Errorf("越界：%v", err)
	}
	if _, err := ReadFile(filepath.Join(root, "..", filepath.Base(outside), "secret.txt")); !errors.Is(err, ErrForbidden) {
		t.Errorf("../ 穿越：%v", err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadFile(link); !errors.Is(err, ErrForbidden) {
		t.Errorf("软链逃逸：%v", err)
	}
	if _, err := ReadFile(filepath.Join(root, "none.md")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("不存在：%v", err)
	}
	if _, err := ReadFile(root); !errors.Is(err, ErrBadRequest) {
		t.Errorf("目录：%v", err)
	}
	if _, err := ReadFile("rel.md"); !errors.Is(err, ErrBadRequest) {
		t.Errorf("相对路径：%v", err)
	}
}

func TestResolveDir(t *testing.T) {
	root := realTemp(t)
	outside := realTemp(t)
	withRoots(t, root)
	put(t, filepath.Join(root, "f.md"), []byte("x"))
	if _, err := ResolveDir(outside); !errors.Is(err, ErrForbidden) {
		t.Errorf("越界：%v", err)
	}
	if _, err := ResolveDir(filepath.Join(root, "f.md")); !errors.Is(err, ErrNotDir) {
		t.Errorf("文件：%v", err)
	}
	if got, err := ResolveDir(root); err != nil || got != root {
		t.Errorf("got %q %v", got, err)
	}
}

func TestListFiles(t *testing.T) {
	root := realTemp(t)
	outside := realTemp(t)
	withRoots(t, root)
	put(t, filepath.Join(root, "b.md"), []byte("b"))
	put(t, filepath.Join(root, "sub", "a.txt"), []byte("a"))
	put(t, filepath.Join(root, "img.png"), []byte{0})
	put(t, filepath.Join(root, ".hidden.md"), []byte("h"))
	put(t, filepath.Join(root, "node_modules", "x.md"), []byte("x"))
	put(t, filepath.Join(root, ".git", "y.md"), []byte("y"))
	put(t, filepath.Join(outside, "z.md"), []byte("z"))
	if err := os.Symlink(outside, filepath.Join(root, "out")); err != nil {
		t.Fatal(err)
	}
	l, err := ListFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, f := range l.Files {
		rels = append(rels, f.Rel)
	}
	// png 现在也列（图片），按 WalkDir 顺序：同层按名字
	if got := strings.Join(rels, ","); got != "b.md,img.png,sub/a.txt" {
		t.Fatalf("files = %s", got)
	}
	if l.Skipped != 0 || l.Truncated || l.Reason != "" {
		t.Fatalf("skipped=%d truncated=%v reason=%q", l.Skipped, l.Truncated, l.Reason)
	}
	if l.Files[2].Path != filepath.Join(root, "sub", "a.txt") || l.Files[1].Kind != KindImage || l.Files[0].Kind != KindText {
		t.Fatalf("got %+v %+v", l.Files[1], l.Files[2])
	}
}
