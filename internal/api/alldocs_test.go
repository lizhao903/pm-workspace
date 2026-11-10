// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 「全部文档」：文件清单分页拉全量、认得的种类都列、skipped 只计不认的；原文件预览和用本机应用打开的边界同 /api/fs/read。

func mountDir(t *testing.T, s *Server, dir string) string {
	t.Helper()
	mw := do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(dir)+`}`)
	mustCode(t, mw, http.StatusCreated, "mount")
	return decodeLocalDir(t, mw.Body.Bytes()).ID
}

func TestLocalDirFilesPaged(t *testing.T) {
	s, _ := newLocalDirServer(t)
	a := tmpDirUnderTmp(t)
	files := map[string]string{"x.pdf": "%PDF", "x.docx": "d", "x.png": "p", "deck.pptx": "p", "sheet.xlsx": "x", "notes.jsonl": "{}", "run.sh": "#!", "a.zip": "z"}
	for i := range 1500 {
		files[fmt.Sprintf("n/%04d.md", i)] = "x"
	}
	writeFiles(t, a, files)
	id := mountDir(t, s, a)

	var all []fsbrowse.FileItem
	skipped, pages := 0, 0
	kinds := map[string]int{}
	for cur := ""; ; pages++ {
		q := url.Values{"limit": {"400"}}
		if cur != "" {
			q.Set("cursor", cur)
		}
		w := do(s, "GET", "/api/local-dirs/"+id+"/files?"+q.Encode(), "")
		mustCode(t, w, http.StatusOK, "page")
		l := decodeData[fsbrowse.FileList](t, w.Body.Bytes())
		if len(l.Files) > 400 || l.Truncated {
			t.Fatalf("一页 %d 个，truncated=%v", len(l.Files), l.Truncated)
		}
		for _, f := range l.Files {
			all = append(all, *f)
			kinds[f.Kind]++
		}
		skipped += l.Skipped
		if l.NextCursor == "" {
			break
		}
		cur = l.NextCursor
	}
	if len(all) != 1506 || pages != 3 {
		t.Fatalf("全量 %d 个、%d 页", len(all), pages+1)
	}
	if skipped != 2 {
		t.Fatalf("skipped = %d，只该计 run.sh、a.zip", skipped)
	}
	if kinds["text"] != 1501 || kinds["pdf"] != 1 || kinds["image"] != 1 || kinds["office"] != 3 {
		t.Fatalf("种类 = %v", kinds)
	}
	seen := map[string]bool{}
	for _, f := range all {
		if seen[f.Rel] {
			t.Fatalf("重复 %s", f.Rel)
		}
		seen[f.Rel] = true
	}
	mustCode(t, do(s, "GET", "/api/local-dirs/"+id+"/files?limit=0", ""), http.StatusBadRequest, "limit 0")
	mustCode(t, do(s, "GET", "/api/local-dirs/"+id+"/files?cursor=%21%21", ""), http.StatusBadRequest, "bad cursor")
	// 不传 limit 一页最多 DefaultPageSize，这里一页拿完
	w := do(s, "GET", "/api/local-dirs/"+id+"/files", "")
	if l := decodeData[fsbrowse.FileList](t, w.Body.Bytes()); len(l.Files) != 1506 || l.NextCursor != "" {
		t.Fatalf("默认一页 %d 个 next=%q", len(l.Files), l.NextCursor)
	}
}

func TestFsRawAndOpen(t *testing.T) {
	s, _ := newLocalDirServer(t)
	a := tmpDirUnderTmp(t)
	writeFiles(t, a, map[string]string{
		"doc.pdf": "%PDF-1.4 hello", "pic.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
		"pic.png": "png", "deck.pptx": "x", "note.md": "# hi", "run.command": "echo hi", ".hidden.pdf": "%PDF",
		"pm.db": "sqlite", "id.key": "k",
	})
	outside := tmpDirUnderTmp(t)
	writeFiles(t, outside, map[string]string{"o.pdf": "%PDF"})
	if err := os.Symlink(filepath.Join(outside, "o.pdf"), filepath.Join(a, "link.pdf")); err != nil {
		t.Fatal(err)
	}

	raw := func(p string) *http.Response {
		return do(s, "GET", "/api/fs/raw?path="+url.QueryEscape(p), "").Result()
	}
	// 没挂载前不给
	if r := raw(filepath.Join(a, "doc.pdf")); r.StatusCode != http.StatusForbidden {
		t.Fatalf("挂载前 = %d", r.StatusCode)
	}
	mountDir(t, s, a)
	r := raw(filepath.Join(a, "doc.pdf"))
	if r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "application/pdf" || r.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(r.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("pdf = %d %v", r.StatusCode, r.Header)
	}
	if r := raw(filepath.Join(a, "pic.svg")); r.StatusCode != http.StatusOK || !strings.Contains(r.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("svg 要带 CSP sandbox：%d %v", r.StatusCode, r.Header)
	}
	if r := raw(filepath.Join(a, "pic.png")); r.StatusCode != http.StatusOK || r.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("png = %d %v", r.StatusCode, r.Header)
	}
	// Range（PDF 查看器会按段取）
	rr := do(s, "GET", "/api/fs/raw?path="+url.QueryEscape(filepath.Join(a, "doc.pdf")), "", [2]string{"Range", "bytes=0-3"})
	if rr.Code != http.StatusPartialContent || rr.Body.String() != "%PDF" {
		t.Fatalf("range = %d %q", rr.Code, rr.Body.String())
	}
	for name, want := range map[string]int{
		"deck.pptx": http.StatusBadRequest, "note.md": http.StatusBadRequest, // 不是预览类型
		".hidden.pdf": http.StatusForbidden, "pm.db": http.StatusForbidden, "id.key": http.StatusForbidden, "link.pdf": http.StatusForbidden,
		"none.pdf": http.StatusNotFound,
	} {
		if r := raw(filepath.Join(a, name)); r.StatusCode != want {
			t.Errorf("raw %s = %d, want %d", name, r.StatusCode, want)
		}
	}
	if r := raw("/etc/hosts"); r.StatusCode != http.StatusForbidden {
		t.Errorf("raw /etc/hosts = %d", r.StatusCode)
	}

	var opened []string
	old := openLocal
	openLocal = func(p string, reveal bool) error {
		opened = append(opened, fmt.Sprintf("%s:%v", filepath.Base(p), reveal))
		return nil
	}
	defer func() { openLocal = old }()
	open := func(name string, reveal bool) int {
		return do(s, "POST", "/api/fs/open", fmt.Sprintf(`{"path":%s,"reveal":%v}`, jsonStr(filepath.Join(a, name)), reveal)).Code
	}
	if c := open("deck.pptx", false); c != http.StatusOK {
		t.Fatalf("open pptx = %d", c)
	}
	if c := open("run.command", false); c != http.StatusForbidden {
		t.Fatalf("脚本不能直接打开：%d", c)
	}
	if c := open("run.command", true); c != http.StatusOK {
		t.Fatalf("脚本可以在访达中显示：%d", c)
	}
	for _, name := range []string{".hidden.pdf", "pm.db", "id.key", "link.pdf"} {
		if c := open(name, true); c != http.StatusForbidden {
			t.Errorf("open %s = %d", name, c)
		}
	}
	if c := open("none.pdf", false); c != http.StatusNotFound {
		t.Errorf("open missing = %d", c)
	}
	if got := strings.Join(opened, ","); got != "deck.pptx:false,run.command:true" {
		t.Fatalf("真去打开的 = %s", got)
	}
}

// 知识库目录同步不再有 1000 个文件的上限，分批收全；进度在同步时能查到，同一个知识库不能同时同步两次。
func TestKbSyncAllFilesAndProgress(t *testing.T) {
	s, st, _ := newKbServer(t)
	dir := tmpDirUnderTmp(t)
	files := map[string]string{"pic.png": "p", "deck.pptx": "x", "data.json": "{}"}
	for i := range 1234 {
		files[fmt.Sprintf("d%d/%04d.md", i%7, i)] = fmt.Sprintf("第 %d 篇的正文", i)
	}
	writeFiles(t, dir, files)
	w := do(s, "POST", "/api/knowledge-bases", `{"name":"大目录","settings":{"dirs":[{"path":`+jsonStr(dir)+`,"auto_sync":true}]}}`)
	mustCode(t, w, http.StatusCreated, "create "+w.Body.String())
	k := decodeData[kbResp](t, w.Body.Bytes())
	if k.Settings.Dirs[0].Files != 1234 || k.Counts.Indexed != 1234 {
		t.Fatalf("收进来 %d 篇，已索引 %d", k.Settings.Dirs[0].Files, k.Counts.Indexed)
	}
	// 没在同步时进度是 null
	if w := do(s, "GET", "/api/knowledge-bases/"+k.ID+"/sync", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"data":null`) {
		t.Fatalf("progress = %d %s", w.Code, w.Body.String())
	}
	// 再同步一次：内容没变的跳过，不重读
	w = do(s, "POST", "/api/knowledge-bases/"+k.ID+"/sync", `{"path":`+jsonStr(dir)+`}`)
	mustCode(t, w, http.StatusOK, "sync")
	res := decodeData[struct {
		Result kb.SyncResult `json:"result"`
	}](t, w.Body.Bytes()).Result
	if res.Unchanged != 1234 || res.Added+res.Updated+res.Removed != 0 {
		t.Fatalf("再同步 = %+v", res)
	}

	// 同步进行中：进度可查，第二次同步 409
	full, err := st.GetKnowledgeBase(context.Background(), k.ID)
	if err != nil {
		t.Fatal(err)
	}
	var mid *kb.SyncProgress
	var second int
	sv := s.kbService()
	sv.Allow = func(p string) bool {
		if mid == nil && strings.HasSuffix(p, "0500.md") {
			w := do(s, "GET", "/api/knowledge-bases/"+k.ID+"/sync", "")
			mid = decodeData[*kb.SyncProgress](t, w.Body.Bytes())
			second = do(s, "POST", "/api/knowledge-bases/"+k.ID+"/sync", "").Code
		}
		return true
	}
	if _, err := sv.Sync(context.Background(), full, dir); err != nil {
		t.Fatal(err)
	}
	if mid == nil || mid.Dir != dir || mid.Listed == 0 || mid.KbID != k.ID {
		t.Fatalf("同步中的进度 = %+v", mid)
	}
	if second != http.StatusConflict {
		t.Fatalf("同时第二次同步 = %d", second)
	}
	if p := s.kbSync.Get(k.ID); p != nil {
		t.Fatalf("同步完了进度该清掉：%+v", p)
	}
	docs := kbDocs(t, s, k.ID)
	n := 0
	for _, d := range docs {
		if d.Source.Type == store.KbSrcDir {
			n++
		}
	}
	if n != 1234 {
		t.Fatalf("目录文件 %d 篇", n)
	}
}
