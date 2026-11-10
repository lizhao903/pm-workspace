// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package kb_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 插件同步知识库（TSK-0721）：新增、内容变了重新索引、资料没了移出；只动自己 origin 下的，人工加的不动；
// 重复的、不支持的类型、大文件、被拦的跳过并记原因；目录不在时原来收进来的不移出。
func TestReconcile(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	root, err := os.MkdirTemp("/tmp", "pmw-kb-rec-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if root, err = filepath.EvalSymlinks(root); err != nil {
		t.Fatal(err)
	}
	write := func(rel, body string) string {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	single := write("single.md", "单个文件的正文")
	write("docs/a.md", "目录里的 A")
	write("docs/sub/b.txt", "目录里的 B")
	write("docs/c.png", "不认的")
	write("docs/.hidden/d.md", "隐藏的")
	pdf := write("spec.pdf", "%PDF")
	big := write("big.md", strings.Repeat("大", 1<<19)) // 1.5MB
	blocked := write("blocked.md", "被拦的")

	name := "项目库"
	k, err := st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := st.CreateObject(ctx, &domain.Object{TypeID: "doc", Title: "需求说明", Body: "工作台文档正文"}, store.Actor{})
	if err != nil {
		t.Fatal(err)
	}
	manual, err := st.CreateKbDoc(ctx, &store.KbDoc{KbID: k.ID, Title: "人工笔记", Text: "人工加的", Source: store.KbSource{Type: store.KbSrcNote}})
	if err != nil {
		t.Fatal(err)
	}
	sv := &kb.Service{St: st, Allow: func(p string) bool { return filepath.Base(p) != "blocked.md" }}
	const origin = "projects:obj_x"
	items := []kb.Item{
		{Key: "m1", Kind: kb.ItemFile, Ref: single},
		{Key: "m2", Kind: kb.ItemDir, Ref: filepath.Join(root, "docs"), Label: "文档目录"},
		{Key: "m3", Kind: kb.ItemNote, Title: "会议记录", Text: "周会结论"},
		{Key: "m4", Kind: kb.ItemLink, Ref: "https://example.com/a", Title: "设计稿", Text: "设计稿\nhttps://example.com/a"},
		{Key: "doc:" + doc.ID, Kind: kb.ItemLibrary, Ref: doc.ID},
		{Key: "m5", Kind: kb.ItemFile, Ref: pdf},
		{Key: "m6", Kind: kb.ItemFile, Ref: big},
		{Key: "m7", Kind: kb.ItemFile, Ref: blocked},
		{Key: "m8", Kind: kb.ItemFile, Ref: filepath.Join(root, "docs/a.md")}, // 和目录里的重复，只收一次
	}
	res, err := sv.Reconcile(ctx, k, origin, items)
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 6 || res.Skipped != 3 || res.Failed != 0 || res.Removed != 0 {
		t.Fatalf("第一次 = %+v", res)
	}
	reasons := map[string]string{}
	for _, p := range res.Skips {
		reasons[filepath.Base(p.Ref)] = p.Reason
	}
	if reasons["spec.pdf"] != kb.ReasonFileType || reasons["big.md"] != kb.ReasonTooLarge || reasons["blocked.md"] != kb.ReasonBlocked {
		t.Fatalf("跳过原因 = %v", reasons)
	}
	docs, _ := st.ListKbDocs(ctx, k.ID)
	byTitle := map[string]*store.KbDoc{}
	for _, d := range docs {
		byTitle[d.Title] = d
	}
	if d := byTitle["single.md"]; d == nil || d.Source.Type != store.KbSrcFile || d.Origin != origin || d.Status != store.KbIndexed {
		t.Fatalf("单个文件 = %+v", d)
	}
	if byTitle["d.md"] != nil || byTitle["c.png"] != nil {
		t.Fatal("隐藏目录、不认的类型不该收")
	}

	// 第二次：没变的不动
	res, err = sv.Reconcile(ctx, k, origin, items)
	if err != nil || res.Added != 0 || res.Updated != 0 || res.Removed != 0 || res.Unchanged != 6 {
		t.Fatalf("第二次 = %+v, %v", res, err)
	}

	// 改单个文件、改目录里的文件、改笔记，删目录里一个文件，去掉链接资料
	time.Sleep(20 * time.Millisecond)
	write("single.md", "单个文件改过了")
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(filepath.Join(root, "docs/a.md"), future, future)
	write("docs/a.md", "目录里的 A 改过")
	_ = os.Chtimes(filepath.Join(root, "docs/a.md"), future, future)
	_ = os.Remove(filepath.Join(root, "docs/sub/b.txt"))
	items[2].Text = "周会结论（更新）"
	items = append(items[:3], items[4:]...)
	res, err = sv.Reconcile(ctx, k, origin, items)
	if err != nil || res.Updated != 3 || res.Removed != 2 || res.Added != 0 {
		t.Fatalf("第三次 = %+v, %v", res, err)
	}
	if _, err := st.GetKbDoc(ctx, k.ID, manual.ID); err != nil {
		t.Fatalf("人工加的被动了：%v", err)
	}

	// 目录不在了：记失败，原来收进来的不移出
	if err := os.Rename(filepath.Join(root, "docs"), filepath.Join(root, "docs-gone")); err != nil {
		t.Fatal(err)
	}
	res, err = sv.Reconcile(ctx, k, origin, items)
	if err != nil || res.Failed != 2 || res.Removed != 0 { // 目录一条，单独登记的 docs/a.md 一条
		t.Fatalf("目录不在 = %+v, %v", res, err)
	}

	// 别的 origin 同步空清单：不碰这个 origin 的
	res, err = sv.Reconcile(ctx, k, "projects:obj_y", nil)
	if err != nil || res.Removed != 0 {
		t.Fatalf("别的 origin = %+v, %v", res, err)
	}
	// 自己同步空清单：自己的全移出，人工的留着
	res, err = sv.Reconcile(ctx, k, origin, nil)
	if err != nil || res.Removed != 4 {
		t.Fatalf("清空 = %+v, %v", res, err)
	}
	docs, _ = st.ListKbDocs(ctx, k.ID)
	if len(docs) != 1 || docs[0].ID != manual.ID {
		t.Fatalf("剩下的 = %+v", docs)
	}

	// 人工加过的工作台文档不重复收
	if _, err := sv.Add(ctx, k, kb.AddInput{Type: store.KbSrcLibrary, Ref: doc.ID}); err != nil {
		t.Fatal(err)
	}
	res, err = sv.Reconcile(ctx, k, origin, []kb.Item{{Key: "doc:" + doc.ID, Kind: kb.ItemLibrary, Ref: doc.ID}})
	if err != nil || res.Skipped != 1 || res.Skips[0].Reason != kb.ReasonDuplicate || res.Added != 0 {
		t.Fatalf("重复的工作台文档 = %+v, %v", res, err)
	}
}

// 本机文件只能由插件加：没有 origin 的 file 存不进去；重新索引时重读文件。
func TestFileDocNeedsOrigin(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	name := "库"
	k, err := st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateKbDoc(ctx, &store.KbDoc{KbID: k.ID, Title: "x.md", Source: store.KbSource{Type: store.KbSrcFile, Ref: "/tmp/x.md"}}); err == nil {
		t.Fatal("没有 origin 的本机文件不该存进去")
	}
	dir, err := os.MkdirTemp("/tmp", "pmw-kb-file-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	dir, _ = filepath.EvalSymlinks(dir)
	p := filepath.Join(dir, "x.md")
	_ = os.WriteFile(p, []byte("第一版"), 0o644)
	sv := &kb.Service{St: st}
	if _, err := sv.Reconcile(ctx, k, "projects:p", []kb.Item{{Kind: kb.ItemFile, Ref: p}}); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(p, []byte("第二版"), 0o644)
	docs, _ := st.ListKbDocs(ctx, k.ID)
	d, err := sv.Index(ctx, k, docs[0])
	if err != nil || d.Text != "第二版" || d.Status != store.KbIndexed {
		t.Fatalf("重新索引 = %+v, %v", d, err)
	}
}
