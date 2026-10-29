package kb_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 同步目录时 Allow 拦下的文件不收；已经收进来的被拦下后，重新索引标成失败、正文不再更新。
func TestSyncHonorsAllow(t *testing.T) {
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	dir, err := os.MkdirTemp("/tmp", "pmw-kb-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if dir, err = filepath.EvalSymlinks(dir); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"ok.md": "可以收", "blocked.md": "被拦下的", ".hidden.md": "隐藏的", "x.pem": "证书"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	name := "库"
	k, err := st.CreateKnowledgeBase(ctx, store.KbInput{Name: &name, Settings: &store.KbSettingsInput{Dirs: &[]store.KbDir{{Path: dir}}}})
	if err != nil {
		t.Fatal(err)
	}
	block := map[string]bool{"blocked.md": true}
	sv := &kb.Service{St: st, Allow: func(p string) bool { return !block[filepath.Base(p)] }}
	res, err := sv.Sync(ctx, k, "")
	if err != nil || res.Added != 1 {
		t.Fatalf("同步 = %+v, %v", res, err)
	}
	docs, _ := st.ListKbDocs(ctx, k.ID)
	if len(docs) != 1 || docs[0].Title != "ok.md" || docs[0].Status != store.KbIndexed {
		t.Fatalf("收进来的 = %+v", docs)
	}

	block["ok.md"] = true
	d, err := sv.Index(ctx, k, docs[0])
	if err != nil || d.Status != store.KbFailed || !strings.Contains(d.Error, "不能收进知识库") {
		t.Fatalf("被拦下后重新索引 = %+v, %v", d, err)
	}
}
