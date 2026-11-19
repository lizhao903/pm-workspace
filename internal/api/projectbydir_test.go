// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 按工作目录认定项目（TSK-0841 复盘）：等于或位于其下算命中，取最长；前缀相同但不是子目录的不算；
// 软链两边都解析；最长的有两个不同项目并列时不认；相对路径、空目录跳过。
func TestMatchProjectDir(t *testing.T) {
	root := t.TempDir()
	mk := func(p string) string {
		d := filepath.Join(root, p)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		return d
	}
	octok, proto, other := mk("Octok项目"), mk("Octok项目/proto"), mk("Octok项目2")
	link := filepath.Join(root, "link")
	if err := os.Symlink(octok, link); err != nil {
		t.Fatal(err)
	}
	cands := []projectDirCand{
		{ProjectID: "p1", Kind: projectDirWorkdir, Dir: link},
		{ProjectID: "p2", Kind: plugin.ProjectDirPrototype, Dir: proto},
		{ProjectID: "p3", Kind: plugin.ProjectDirCode, Dir: "relative/dir"},
		{ProjectID: "p4", Kind: plugin.ProjectDirPRD, Dir: ""},
	}
	for _, c := range []struct {
		wd, want, kind string
	}{
		{octok, "p1", projectDirWorkdir},                                 // 项目目录是软链，工作目录是真实路径
		{mk("Octok项目/docs/x"), "p1", projectDirWorkdir},                  // 位于其下
		{filepath.Join(link, "proto"), "p2", plugin.ProjectDirPrototype}, // 两个都命中，取更具体的
		{other, "", ""}, // 只是前缀相同，不是子目录
		{root, "", ""},  // 在项目目录上面
	} {
		got, ok := matchProjectDir(c.wd, cands)
		if got.ProjectID != c.want || ok != (c.want != "") || got.Kind != c.kind {
			t.Errorf("%s：得到 %+v %v，应为 %q", c.wd, got, ok, c.want)
		}
	}
	// 并列：两个不同项目设了同一个目录，不替用户挑
	tie := append(cands, projectDirCand{ProjectID: "p5", Kind: plugin.ProjectDirCode, Dir: proto})
	if got, ok := matchProjectDir(proto, tie); ok {
		t.Fatalf("并列应不认：%+v", got)
	}
	// 同一个项目两个目录并列不算冲突，取先出现的
	same := append(cands, projectDirCand{ProjectID: "p2", Kind: plugin.ProjectDirCode, Dir: proto})
	if got, ok := matchProjectDir(proto, same); !ok || got.ProjectID != "p2" || got.Kind != plugin.ProjectDirPrototype {
		t.Fatalf("同项目并列：%+v %v", got, ok)
	}
}

// 没挂项目的任务：工作目录在项目目录里时，预览带「所属项目」并注明按工作目录认定；不在时没有这一节；
// 不改任务的 project_id。挂了项目的任务照旧，不出现「按工作目录认定」。
func TestRunPromptProjectByWorkdir(t *testing.T) {
	s, f, attached, _ := terminalFixture(t)
	prj, err := f.GetObject(t.Context(), *attached.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(prj.Workdir, "需求")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	loose, err := f.CreateObject(t.Context(), &domain.Object{TypeID: "task", Title: "IM 转来的", Status: "todo"}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	preview := func(id, wd string) string {
		t.Helper()
		q := ""
		if wd != "" {
			q = "?workdir=" + url.QueryEscape(wd)
		}
		return decodeEnvelope(t, do(s, "GET", "/api/objects/"+id+"/run/prompt"+q, ""))["data"].(map[string]any)["prompt"].(string)
	}
	p := preview(loose.ID, sub)
	want := "## 所属项目\n名称：Acme（" + prj.Ref + "）\n按工作目录认定为项目「Acme」（任务本身没挂项目）：工作目录在项目工作目录 " + prj.Workdir + " 下。\n"
	if !strings.Contains(p, want) || !strings.Contains(p, "这个项目没有登记原型目录") {
		t.Fatalf("应按工作目录认定为 Acme：\n%s", p)
	}
	if p := preview(loose.ID, ""); strings.Contains(p, "## 所属项目") {
		t.Fatalf("没给目录、任务和项目都没目录时不应认定：\n%s", p)
	}
	if p := preview(loose.ID, t.TempDir()); strings.Contains(p, "## 所属项目") {
		t.Fatalf("工作目录不在任何项目里不应有所属项目：\n%s", p)
	}
	if got, _ := f.GetObject(t.Context(), loose.ID); got.ProjectID != nil {
		t.Fatalf("不该改任务的 project_id：%v", *got.ProjectID)
	}
	if p := preview(attached.ID, ""); !strings.Contains(p, "## 所属项目\n名称：Acme") || strings.Contains(p, "按工作目录认定") {
		t.Fatalf("挂了项目的照旧：\n%s", p)
	}
}
