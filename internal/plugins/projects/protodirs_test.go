// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内核「项目原型目录」钩子：按登记先后回名字和目录；没有原型回空；停用后回 ErrNoProjectPrototypes。
func TestProjectPrototypesHook(t *testing.T) {
	r, h, _ := setup(t)
	ctx := context.Background()
	if got, err := r.ProjectPrototypes(ctx, "obj_p1"); err != nil || len(got) != 0 {
		t.Fatalf("没有原型：%v %v", got, err)
	}
	a, b := t.TempDir(), t.TempDir()
	for _, body := range []string{
		`{"name":"甲站","dir":"` + a + `","command":"sleep 1","port":` + strconv.Itoa(freePort(t)) + `}`,
		`{"name":"乙站","dir":"` + b + `","command":"sleep 1","port":` + strconv.Itoa(freePort(t)) + `}`,
	} {
		if code, out := call(t, h, "POST", "/api/projects/obj_p1/prototypes", body); code != 201 {
			t.Fatalf("新增原型：%d %v", code, out)
		}
	}
	got, err := r.ProjectPrototypes(ctx, "obj_p1")
	if err != nil || len(got) != 2 || got[0] != (plugin.ProjectPrototype{Name: "甲站", Dir: a}) || got[1].Dir != b {
		t.Fatalf("原型目录：%v %v", got, err)
	}
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ProjectPrototypes(ctx, "obj_p1"); !errors.Is(err, plugin.ErrNoProjectPrototypes) {
		t.Fatalf("停用后应回 ErrNoProjectPrototypes：%v", err)
	}
}

// 原型规则（迁移 0013）：档案原型库排第一、带 proto_rules；和某个登记原型同目录时合成一条，
// 名字用登记原型的、规则先档案后原型（相同只留一段），不重复列目录。
func TestProjectPrototypesHookRules(t *testing.T) {
	r, h, _ := setup(t)
	ctx := context.Background()
	lib, other := t.TempDir(), t.TempDir()
	if code, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"proto_dir":"`+lib+`","proto_rules":"拉 cloud-v<MMDD>-<nn> 分支改\r\n不做独立 HTML\n"}`); code != 200 ||
		out["data"].(map[string]any)["proto_rules"] != "拉 cloud-v<MMDD>-<nn> 分支改\n不做独立 HTML" {
		t.Fatalf("存档案规则：%d %v", code, out)
	}
	got, err := r.ProjectPrototypes(ctx, "obj_p1")
	if err != nil || len(got) != 1 || got[0] != (plugin.ProjectPrototype{Name: protoLibName, Dir: lib, Rules: "拉 cloud-v<MMDD>-<nn> 分支改\n不做独立 HTML"}) {
		t.Fatalf("只有档案原型库：%v %v", got, err)
	}
	for _, body := range []string{
		`{"name":"别的站","dir":"` + other + `","command":"sleep 1","port":` + strconv.Itoa(freePort(t)) + `,"rules":"只改 docs/"}`,
		`{"name":"基础原型","dir":"` + lib + `/","command":"sleep 1","port":` + strconv.Itoa(freePort(t)) + `,"rules":"以 UI-chat 设计为准"}`,
	} {
		if code, out := call(t, h, "POST", "/api/projects/obj_p1/prototypes", body); code != 201 {
			t.Fatalf("新增原型：%d %v", code, out)
		}
	}
	got, err = r.ProjectPrototypes(ctx, "obj_p1")
	want := []plugin.ProjectPrototype{
		{Name: "基础原型（项目档案的原型库）", Dir: lib, Rules: "拉 cloud-v<MMDD>-<nn> 分支改\n不做独立 HTML\n以 UI-chat 设计为准"},
		{Name: "别的站", Dir: other, Rules: "只改 docs/"},
	}
	if err != nil || len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("合并后：%#v %v", got, err)
	}
	// 规则超长 400
	long := strings.Repeat("规", maxRules+1)
	if code, _ := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"proto_rules":"`+long+`"}`); code != 400 {
		t.Fatalf("超长规则应 400：%d", code)
	}
}
