package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/localdir"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newLocalDirServer(t *testing.T) (*Server, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "pm.db")
	st, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	return New(audit.WrapStore(st, al), Options{Version: "test", Logger: log, Audit: al, LocalDirs: localdir.New(st.DB())}), dbPath
}

func decodeLocalDir(t *testing.T, body []byte) localdir.Dir {
	t.Helper()
	var env struct {
		Data localdir.Dir `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func listLocalDirNames(t *testing.T, s *Server) string {
	t.Helper()
	w := do(s, "GET", "/api/local-dirs", "")
	mustCode(t, w, http.StatusOK, "list")
	var env struct {
		Data []localdir.Dir `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, d := range env.Data {
		names = append(names, d.Name)
	}
	return strings.Join(names, ",")
}

func jsonStr(v string) string { b, _ := json.Marshal(v); return string(b) }

func TestLocalDirsCRUD(t *testing.T) {
	s, _ := newLocalDirServer(t)
	a, b := tmpDirUnderTmp(t), tmpDirUnderTmp(t)

	w := do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(a)+`}`)
	mustCode(t, w, http.StatusCreated, "mount a")
	da := decodeLocalDir(t, w.Body.Bytes())
	if !strings.HasPrefix(da.ID, "dir_") || da.Path != a || da.Name != filepath.Base(a) || da.Position != 1 {
		t.Fatalf("mount a = %+v", da)
	}
	w = do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(b)+`,"name":"  资料  "}`)
	mustCode(t, w, http.StatusCreated, "mount b")
	db := decodeLocalDir(t, w.Body.Bytes())
	if db.Name != "资料" || db.Position != 2 {
		t.Fatalf("mount b = %+v", db)
	}
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(a)+`}`), http.StatusConflict, "mount twice")

	w = do(s, "PATCH", "/api/local-dirs/"+da.ID, `{"name":"笔记"}`)
	mustCode(t, w, http.StatusOK, "rename")
	if got := decodeLocalDir(t, w.Body.Bytes()); got.Name != "笔记" || got.Path != a {
		t.Fatalf("rename = %+v", got)
	}
	mustCode(t, do(s, "PATCH", "/api/local-dirs/"+da.ID, `{"name":"  "}`), http.StatusBadRequest, "empty name")
	mustCode(t, do(s, "PATCH", "/api/local-dirs/"+da.ID, `{"path":"/tmp"}`), http.StatusBadRequest, "patch path")
	mustCode(t, do(s, "PATCH", "/api/local-dirs/dir_none", `{"name":"x"}`), http.StatusNotFound, "rename missing")

	mustCode(t, do(s, "POST", "/api/local-dirs/reorder", `{"ids":["`+db.ID+`","`+da.ID+`"]}`), http.StatusOK, "reorder")
	if got := listLocalDirNames(t, s); got != "资料,笔记" {
		t.Fatalf("after reorder = %s", got)
	}
	mustCode(t, do(s, "POST", "/api/local-dirs/reorder", `{"ids":["`+db.ID+`"]}`), http.StatusBadRequest, "reorder partial")
	mustCode(t, do(s, "POST", "/api/local-dirs/reorder", `{"ids":["`+db.ID+`","`+db.ID+`"]}`), http.StatusBadRequest, "reorder dup")
	mustCode(t, do(s, "POST", "/api/local-dirs/reorder", `{"ids":["`+db.ID+`","dir_none"]}`), http.StatusBadRequest, "reorder unknown")
	if got := listLocalDirNames(t, s); got != "资料,笔记" {
		t.Fatalf("失败的重排不该改顺序：%s", got)
	}

	mustCode(t, do(s, "DELETE", "/api/local-dirs/"+db.ID, ""), http.StatusOK, "delete")
	mustCode(t, do(s, "DELETE", "/api/local-dirs/"+db.ID, ""), http.StatusNotFound, "delete twice")
	if got := listLocalDirNames(t, s); got != "笔记" {
		t.Fatalf("after delete = %s", got)
	}
	if _, err := os.Stat(b); err != nil {
		t.Fatalf("移除挂载不该删目录：%v", err)
	}
}

// 重启后挂载还在：关库重开同一个文件。
func TestLocalDirsPersist(t *testing.T) {
	s, dbPath := newLocalDirServer(t)
	a := tmpDirUnderTmp(t)
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(a)+`,"name":"留着"}`), http.StatusCreated, "mount")

	st, err := sqlite.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	got, err := localdir.New(st.DB()).List(context.Background())
	if err != nil || len(got) != 1 || got[0].Name != "留着" || got[0].Path != a {
		t.Fatalf("reopen = %+v %v", got, err)
	}
}

func TestLocalDirsBounds(t *testing.T) {
	s, _ := newLocalDirServer(t)
	w := do(s, "POST", "/api/local-dirs", `{"path":"/etc"}`)
	mustCode(t, w, http.StatusForbidden, "mount /etc")
	if !strings.Contains(w.Body.String(), `"forbidden"`) {
		t.Fatalf("body = %s", w.Body.String())
	}
	a := tmpDirUnderTmp(t)
	if err := os.Symlink("/etc", filepath.Join(a, "etc")); err != nil {
		t.Fatal(err)
	}
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(filepath.Join(a, "etc"))+`}`), http.StatusForbidden, "symlink escape")
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(filepath.Join(a, "none"))+`}`), http.StatusNotFound, "missing dir")
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":"rel"}`), http.StatusBadRequest, "relative")
}

func TestFsReadAndFiles(t *testing.T) {
	s, _ := newLocalDirServer(t)
	a := tmpDirUnderTmp(t)
	if err := os.WriteFile(filepath.Join(a, "a.md"), []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("x", fsbrowse.MaxReadBytes+100)
	if err := os.WriteFile(filepath.Join(a, "big.log"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}

	// 没挂载之前，允许根里的文件也读不了
	if w := do(s, "GET", "/api/fs/read?path="+filepath.Join(a, "a.md"), ""); w.Code != http.StatusForbidden {
		t.Fatalf("read before mount = %d", w.Code)
	}
	mw := do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(a)+`}`)
	mustCode(t, mw, http.StatusCreated, "mount")
	d := decodeLocalDir(t, mw.Body.Bytes())
	if err := os.MkdirAll(filepath.Join(a, ".secret"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a, ".secret", "key.txt"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a, ".env"), []byte("TOKEN=1"), 0o600); err != nil {
		t.Fatal(err)
	}

	read := func(p string) (int, fsbrowse.FileContent) {
		w := do(s, "GET", "/api/fs/read?path="+p, "")
		var env struct {
			Data fsbrowse.FileContent `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Data
	}
	if code, f := read(filepath.Join(a, "a.md")); code != http.StatusOK || f.Content != "# hi" || f.Truncated {
		t.Fatalf("read a.md = %d %+v", code, f)
	}
	if code, f := read(filepath.Join(a, "big.log")); code != http.StatusOK || !f.Truncated || len(f.Content) != fsbrowse.MaxReadBytes ||
		f.Size != int64(len(big)) {
		t.Fatalf("read big = %d truncated=%v len=%d", code, f.Truncated, len(f.Content))
	}
	if code, _ := read("/etc/hosts"); code != http.StatusForbidden {
		t.Fatalf("read /etc/hosts = %d", code)
	}
	if code, _ := read(filepath.Join(a, "..", "..", "etc", "hosts")); code != http.StatusForbidden {
		t.Fatalf("read ../ = %d", code)
	}
	if code, _ := read(filepath.Join(a, "none.md")); code != http.StatusNotFound {
		t.Fatalf("read missing = %d", code)
	}
	if code, _ := read(filepath.Join(a, ".env")); code != http.StatusForbidden {
		t.Fatalf("read hidden file = %d", code)
	}
	if code, _ := read(filepath.Join(a, ".secret", "key.txt")); code != http.StatusForbidden {
		t.Fatalf("read file under hidden dir = %d", code)
	}

	w := do(s, "GET", "/api/local-dirs/"+d.ID+"/files", "")
	mustCode(t, w, http.StatusOK, "files")
	var env struct {
		Data fsbrowse.FileList `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data.Files) != 2 || env.Data.Files[0].Rel != "a.md" || env.Data.Files[1].Rel != "big.log" {
		t.Fatalf("files = %s", w.Body.String())
	}
	if err := os.RemoveAll(a); err != nil {
		t.Fatal(err)
	}
	mustCode(t, do(s, "GET", "/api/local-dirs/"+d.ID+"/files", ""), http.StatusNotFound, "files of removed dir")
	mustCode(t, do(s, "GET", "/api/local-dirs/dir_none/files", ""), http.StatusNotFound, "files of unknown")
}

func TestLocalDirsGuardSecrets(t *testing.T) {
	s, _ := newLocalDirServer(t)
	data := tmpDirUnderTmp(t) // 假装是数据目录：放着 vault.key
	if err := os.WriteFile(filepath.Join(data, "vault.key"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.opt.DataDir = data
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(data)+`}`), http.StatusForbidden, "mount data dir")
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(filepath.Dir(data))+`}`), http.StatusForbidden, "mount parent of data dir")

	a := tmpDirUnderTmp(t)
	hid := filepath.Join(a, ".ssh")
	if err := os.MkdirAll(hid, 0o700); err != nil {
		t.Fatal(err)
	}
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(hid)+`}`), http.StatusForbidden, "mount hidden dir")
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(data, "vault.key"), ""), http.StatusForbidden, "read vault.key")

	// 别的实例的数据目录（不是本实例的 DataDir）挂上了，库文件和密钥文件也不给读
	other := tmpDirUnderTmp(t)
	for _, f := range []string{"pm.db", "pm.db-wal", "vault.key", "id.pem", "note.md"} {
		if err := os.WriteFile(filepath.Join(other, f), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mustCode(t, do(s, "POST", "/api/local-dirs", `{"path":`+jsonStr(other)+`}`), http.StatusCreated, "mount other data dir")
	for _, f := range []string{"pm.db", "pm.db-wal", "vault.key", "id.pem"} {
		mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(other, f), ""), http.StatusForbidden, "read "+f)
	}
	mustCode(t, do(s, "GET", "/api/fs/read?path="+filepath.Join(other, "note.md"), ""), http.StatusOK, "read note.md")
}
