// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目目录钩子（TSK-0841 复盘）：回各档案设了的代码库、原型库、需求文档目录，没设的不回；停用后回 ErrNoProjectDirs。
func TestProjectDirsHook(t *testing.T) {
	r, h, _ := setup(t)
	ctx := context.Background()
	if got, err := r.ProjectDirs(ctx); err != nil || len(got) != 0 {
		t.Fatalf("没建档案：%v %v", got, err)
	}
	code, prd := t.TempDir(), t.TempDir()
	st, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", fmt.Sprintf(`{"code_dir":%q,"prd_dir":%q}`, code, " "+prd+" "))
	if st != 200 {
		t.Fatalf("存档案：%d %v", st, out)
	}
	got, err := r.ProjectDirs(ctx)
	if err != nil || fmt.Sprint(got) != fmt.Sprint([]plugin.ProjectDir{
		{ProjectID: "obj_p1", Kind: plugin.ProjectDirCode, Dir: code},
		{ProjectID: "obj_p1", Kind: plugin.ProjectDirPRD, Dir: prd},
	}) {
		t.Fatalf("钩子读出：%v %v", got, err)
	}
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ProjectDirs(ctx); !errors.Is(err, plugin.ErrNoProjectDirs) {
		t.Fatalf("停用后应回 ErrNoProjectDirs：%v", err)
	}
}
