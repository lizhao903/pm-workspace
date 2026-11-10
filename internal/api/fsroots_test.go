// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// 额外可浏览目录（FS-01）。默认根和系统目录换成受控的一组：t.TempDir() 在 macOS 上落在
// /private/var 下，用真实清单加不进去。
func TestFsRootsAddBrowseRemove(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(base, "home")
	outside := filepath.Join(base, "outside")
	data := filepath.Join(base, "data")
	for _, d := range []string{home, filepath.Join(outside, "sub"), data} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(fsbrowse.SetBoundsForTest([]string{home}, []string{"/etc"}))
	s, _ := newLocalDirServer(t)
	s.opt.DataDir = data
	s.loadFsRoots()

	browse := func(p string) int { return do(s, "GET", "/api/fs/browse?path="+url.QueryEscape(p), "").Code }
	if c := browse(outside); c != http.StatusBadRequest {
		t.Fatalf("没加之前应越界 400，实际 %d", c)
	}
	mustCode(t, do(s, "POST", "/api/fs/roots", `{"path":`+jsonStr(outside)+`}`), http.StatusCreated, "add")
	if c := browse(filepath.Join(outside, "sub")); c != http.StatusOK {
		t.Fatalf("加了之后应能浏览，实际 %d", c)
	}
	mustCode(t, do(s, "POST", "/api/fs/roots", `{"path":`+jsonStr(outside)+`}`), http.StatusConflict, "add twice")
	for _, p := range []string{"/", "/etc"} {
		w := do(s, "POST", "/api/fs/roots", `{"path":`+jsonStr(p)+`}`)
		mustCode(t, w, http.StatusBadRequest, "add "+p)
		if !strings.Contains(w.Body.String(), "不能") {
			t.Fatalf("%s 被拒要写明原因：%s", p, w.Body.String())
		}
	}
	mustCode(t, do(s, "POST", "/api/fs/roots", `{"path":`+jsonStr(data)+`}`), http.StatusBadRequest, "add data dir")

	w := do(s, "GET", "/api/fs/roots", "")
	mustCode(t, w, http.StatusOK, "list")
	var env struct {
		Data struct {
			Defaults []string             `json:"defaults"`
			Extra    []fsbrowse.ExtraRoot `json:"extra"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data.Defaults) != 1 || env.Data.Defaults[0] != home || len(env.Data.Extra) != 1 || env.Data.Extra[0].Path != outside {
		t.Fatalf("清单不对：%s", w.Body.String())
	}
	if b, err := os.ReadFile(filepath.Join(data, fsbrowse.ExtraRootsFile)); err != nil || !strings.Contains(string(b), outside) {
		t.Fatalf("应写进数据目录的 %s：%v %s", fsbrowse.ExtraRootsFile, err, b)
	}

	mustCode(t, do(s, "DELETE", "/api/fs/roots?path="+url.QueryEscape(outside), ""), http.StatusOK, "remove")
	mustCode(t, do(s, "DELETE", "/api/fs/roots?path="+url.QueryEscape(outside), ""), http.StatusNotFound, "remove twice")
	mustCode(t, do(s, "DELETE", "/api/fs/roots", ""), http.StatusBadRequest, "remove without path")
	if c := browse(outside); c != http.StatusBadRequest {
		t.Fatalf("删掉之后应回到越界，实际 %d", c)
	}

	// 加、删各记一条审计，被拒的不记
	entries, _, err := s.opt.Audit.List(context.Background(), audit.Filter{TargetType: "fs_root"})
	if err != nil {
		t.Fatal(err)
	}
	var acts []string
	for _, e := range entries {
		acts = append(acts, e.Action)
	}
	if strings.Join(acts, ",") != "delete,create" && strings.Join(acts, ",") != "create,delete" {
		t.Fatalf("审计应正好是一加一删：%v", acts)
	}
}

// /api/fs/read 的规则对额外根照旧：只读已挂载目录里的非隐藏文件，库文件和密钥证书类文件不给读。
func TestFsReadGuardsSecretsInExtraRoot(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(base, "home")
	ext := filepath.Join(base, "ext")
	mnt := filepath.Join(ext, "docs")
	for _, d := range []string{home, filepath.Join(mnt, ".git"), filepath.Join(ext, "other")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"note.md", "pm.db", "pm.db-wal", "vault.key", "id.pem", "cert.p12", ".env", ".git/config"} {
		if err := os.WriteFile(filepath.Join(mnt, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(ext, "other", "a.md"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fsbrowse.SetBoundsForTest([]string{home}, nil))
	s, _ := newLocalDirServer(t)

	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(mnt)+`}`), http.StatusForbidden, "mount before root added")
	mustCode(t, do(s, "POST", "/api/fs/roots", `{"path":`+jsonStr(ext)+`}`), http.StatusCreated, "add root")
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(mnt)+`}`), http.StatusCreated, "mount")
	read := func(p string) int { return do(s, "GET", "/api/fs/read?path="+url.QueryEscape(p), "").Code }
	if c := read(filepath.Join(mnt, "note.md")); c != http.StatusOK {
		t.Fatalf("挂载目录里的普通文件应能读，实际 %d", c)
	}
	for _, f := range []string{"pm.db", "pm.db-wal", "vault.key", "id.pem", "cert.p12", ".env", ".git/config"} {
		if c := read(filepath.Join(mnt, f)); c != http.StatusForbidden {
			t.Errorf("%s 应被拦下 403，实际 %d", f, c)
		}
	}
	// 额外根里、但不在挂载目录里的文件也不给读
	if c := read(filepath.Join(ext, "other", "a.md")); c != http.StatusForbidden {
		t.Fatalf("没挂载的目录不该能读，实际 %d", c)
	}
}
