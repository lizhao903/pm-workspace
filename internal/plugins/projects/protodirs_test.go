// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"strconv"
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
