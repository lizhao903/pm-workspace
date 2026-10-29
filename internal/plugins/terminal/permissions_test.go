package terminal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// denyCore 是没确认任何权限的 Core，只用到 PluginID、Granted
type denyCore struct{ plugin.Core }

func (denyCore) PluginID() string    { return "terminal" }
func (denyCore) Granted(string) bool { return false }

func TestCreateNeedsProcessSpawn(t *testing.T) {
	h := &handlers{c: denyCore{}, m: newManager()}
	w := httptest.NewRecorder()
	h.create(w, httptest.NewRequest("POST", "/api/terminal/sessions", strings.NewReader(`{"cwd":"`+t.TempDir()+`"}`)))
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "插件 terminal 的 process:spawn 权限还没确认，到插件管理里升级并确认") {
		t.Fatalf("没确认 process:spawn 不能起 shell：%d %s", w.Code, w.Body.String())
	}
	if len(h.m.list()) != 0 {
		t.Fatal("不该留下会话")
	}
}

// 项目根目录、cwd 存成 file:// 地址时去掉前缀再用（TERM-01c 记的）
func TestCreateFileURLRoot(t *testing.T) {
	_, srv, d := setupDB(t)
	root := t.TempDir()
	other := t.TempDir()
	now := time.Now().UTC().Format(time.RFC3339)
	u := (&url.URL{Scheme: "file", Path: root}).String()
	if _, err := d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, workdir, created_at, updated_at) VALUES ('obj_f1', 'project', 'PRJ-F1', '文件地址', ?, ?, ?)`, u, now, now); err != nil {
		t.Fatal(err)
	}
	if s := create(t, srv, `{"project_id":"obj_f1"}`); s["cwd"] != root {
		t.Fatalf("file:// 根目录 cwd = %v, want %s", s["cwd"], root)
	}
	if s := create(t, srv, `{"cwd":"file://`+other+`"}`); s["cwd"] != other {
		t.Fatalf("file:// cwd = %v, want %s", s["cwd"], other)
	}
}
