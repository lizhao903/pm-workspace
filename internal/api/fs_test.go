// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tmpDirUnderTmp 在 /tmp 下建测试目录。不能用 t.TempDir()：macOS 上它落在
// /var/folders/...，解析软链后是 /private/var/...，正好在可浏览范围之外——
// 那是边界在正常工作，不是测试环境有问题。
func tmpDirUnderTmp(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pmw-fs-test-")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	return real
}

func TestFsBrowseDefaultsToHome(t *testing.T) {
	s := newTestServer(newFakeStore())

	w := do(s, http.MethodGet, "/api/fs/browse", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body=%s", w.Code, w.Body.String())
	}
	env := decodeEnvelope(t, w)
	data, ok := env["data"].(map[string]any)
	if !ok {
		t.Fatalf("data 不是对象：%s", w.Body.String())
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("取不到主目录")
	}
	wantHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatalf("eval home: %v", err)
	}
	if got, _ := data["path"].(string); got != wantHome {
		t.Fatalf("省略 path 时应列主目录 %q，实际 %q", wantHome, got)
	}
	if _, ok := data["entries"].([]any); !ok {
		t.Fatalf("entries 应该是数组：%s", w.Body.String())
	}
	if _, ok := env["meta"]; ok {
		t.Fatal("目录列表不是分页列表，不该带 meta")
	}
}

func TestFsBrowseListsOnlyDirectories(t *testing.T) {
	s := newTestServer(newFakeStore())
	base := tmpDirUnderTmp(t)
	if err := os.Mkdir(filepath.Join(base, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := do(s, http.MethodGet, "/api/fs/browse?path="+base, "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body=%s", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	entries := data["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("只该有一个目录条目，实际 %d：%s", len(entries), w.Body.String())
	}
	e := entries[0].(map[string]any)
	if e["name"] != "sub" || e["is_dir"] != true {
		t.Fatalf("条目不对：%v", e)
	}
	if _, ok := e["writable"].(bool); !ok {
		t.Fatalf("条目应带 writable 标记：%v", e)
	}
}

// TestFsBrowseRejectsOutOfBounds 越界要被拦住，并且报错里得说清可选范围是哪儿。
func TestFsBrowseRejectsOutOfBounds(t *testing.T) {
	s := newTestServer(newFakeStore())

	for _, p := range []string{"/etc", "/System", "/private/var", "/"} {
		w := do(s, http.MethodGet, "/api/fs/browse?path="+p, "")
		// assertError 回的就是 error 那一层。
		msg, _ := assertError(t, w, http.StatusBadRequest, "validation")["message"].(string)
		if !strings.Contains(msg, "可浏览范围") {
			t.Fatalf("path=%s 的报错要说清范围，实际 %q", p, msg)
		}
	}
}

func TestFsBrowseMissingPath(t *testing.T) {
	s := newTestServer(newFakeStore())
	base := tmpDirUnderTmp(t)

	w := do(s, http.MethodGet, "/api/fs/browse?path="+filepath.Join(base, "nope"), "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestFsBrowseRelativePath(t *testing.T) {
	s := newTestServer(newFakeStore())

	w := do(s, http.MethodGet, "/api/fs/browse?path=relative/dir", "")
	assertError(t, w, http.StatusBadRequest, "validation")
}

func TestFsShortcuts(t *testing.T) {
	s := newTestServer(newFakeStore())

	w := do(s, http.MethodGet, "/api/fs/shortcuts", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body=%s", w.Code, w.Body.String())
	}
	items, ok := decodeEnvelope(t, w)["data"].([]any)
	if !ok {
		t.Fatalf("data 应该是数组：%s", w.Body.String())
	}
	if len(items) == 0 {
		t.Fatal("起跳点不该是空的")
	}
	for _, it := range items {
		m := it.(map[string]any)
		label, _ := m["label"].(string)
		path, _ := m["path"].(string)
		if label == "" || path == "" {
			t.Fatalf("起跳点字段不完整：%v", m)
		}
		// 每个起跳点都得真能点开，否则界面上摆的是个死链。
		bw := do(s, http.MethodGet, "/api/fs/browse?path="+path, "")
		if bw.Code != http.StatusOK {
			t.Fatalf("起跳点 %s (%s) 点不开：%d %s", label, path, bw.Code, bw.Body.String())
		}
	}
}

func TestFsMkdir(t *testing.T) {
	s := newTestServer(newFakeStore())
	base := tmpDirUnderTmp(t)

	w := do(s, http.MethodPost, "/api/fs/mkdir", `{"parent":"`+base+`","name":"新目录"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body=%s", w.Code, w.Body.String())
	}
	if fi, err := os.Stat(filepath.Join(base, "新目录")); err != nil || !fi.IsDir() {
		t.Fatalf("目录没建出来：%v", err)
	}
	// 回的是新建之后所在目录的列表，界面直接拿去刷新。
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["path"] != base {
		t.Fatalf("应返回 parent 的列表，实际 %v", data["path"])
	}
	entries := data["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["name"] != "新目录" {
		t.Fatalf("列表里应有刚建的目录：%s", w.Body.String())
	}
}

func TestFsMkdirRejectsBadInput(t *testing.T) {
	s := newTestServer(newFakeStore())
	base := tmpDirUnderTmp(t)

	cases := []struct{ name, body string }{
		{"越界的 parent", `{"parent":"/etc","name":"pwn"}`},
		// 注意 parent 里带 .. 本身不是罪：清理后仍在范围内（比如 /tmp/x/.. 就是 /tmp）
		// 就该放行。要拦的是清理后穿到范围外的。
		{"parent 穿越到范围外", `{"parent":"` + base + `/../../etc","name":"pwn"}`},
		{"名字带分隔符", `{"parent":"` + base + `","name":"a/b"}`},
		{"名字是 ..", `{"parent":"` + base + `","name":".."}`},
		{"名字里带 ..", `{"parent":"` + base + `","name":"../evil"}`},
		{"名字为空", `{"parent":"` + base + `","name":"  "}`},
		{"parent 为空", `{"parent":"","name":"x"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			assertError(t, do(s, http.MethodPost, "/api/fs/mkdir", c.body), http.StatusBadRequest, "validation")
		})
	}

	items, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("非法入参不该建出任何东西，实际 %d 条", len(items))
	}
}

func TestFsMkdirNeedsBody(t *testing.T) {
	s := newTestServer(newFakeStore())

	assertError(t, do(s, http.MethodPost, "/api/fs/mkdir", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, http.MethodPost, "/api/fs/mkdir", "{"), http.StatusBadRequest, "validation")
}
