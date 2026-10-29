package projects

import (
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// denyCore 是没确认任何权限的 Core，只用到 PluginID、Granted
type denyCore struct{ plugin.Core }

func (denyCore) PluginID() string    { return "projects" }
func (denyCore) Granted(string) bool { return false }

func TestStartNeedsProcessSpawn(t *testing.T) {
	m := newManager(denyCore{})
	err := m.start(Prototype{ID: "pt_x", Name: "s", Dir: t.TempDir(), Argv: []string{"sleep", "30"}, Command: "sleep 30", Port: freePort(t)}, "项目", 0)
	if err == nil || !strings.Contains(err.Error(), "插件 projects 的 process:spawn 权限还没确认，到插件管理里升级并确认") {
		t.Fatalf("没确认 process:spawn 不能起原型：%v", err)
	}
	if m.runtime("pt_x").Status != statusStopped {
		t.Fatal("不该留下进程")
	}
}

// 原型目录写成 file:// 地址时去掉前缀；早先存下的 file:// 目录启动时也认
func TestPrototypeFileURLDir(t *testing.T) {
	_, h, d := setup(t)
	base := "/api/projects/obj_p1/prototypes"
	dir := t.TempDir()
	code, out := call(t, h, "POST", base, argvBody(t, "s", "file://"+dir, freePort(t), "sleep", "30"))
	if code != 201 || out["data"].(map[string]any)["dir"] != dir {
		t.Fatalf("file:// 目录：%d %v", code, out)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.W.Exec(`INSERT INTO projects_prototypes (`+protoCols+`) VALUES ('pt_f', 'obj_p1', 's2', ?, 'sleep 30', '["sleep","30"]', ?, ?, ?)`,
		"file://"+dir, freePort(t), now, now); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "POST", base+"/pt_f/start", ""); code != 200 {
		t.Fatalf("存成 file:// 的目录要能启动：%d %v", code, out)
	}
	waitProto(t, h, base+"/pt_f", func(p map[string]any) bool { return p["pid"].(float64) > 0 })
}
