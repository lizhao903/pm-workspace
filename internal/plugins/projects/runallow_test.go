// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 项目执行白名单（迁移 0014，TSK-0837）：PATCH 校验同自定义白名单（规范化、去重、Bash(*) 这类 400），
// 只改别的字段不动它；内核钩子读出来同档案；没建档案回空；停用后回 ErrNoProjectRunAllow。
func TestProjectRunAllow(t *testing.T) {
	r, h, _ := setup(t)
	ctx := context.Background()
	if got, err := r.ProjectRunAllow(ctx, "obj_p1"); err != nil || len(got) != 0 {
		t.Fatalf("没建档案：%v %v", got, err)
	}
	code, out := call(t, h, "GET", "/api/projects/obj_p1/profile", "")
	if code != 200 || out["data"].(map[string]any)["run_allow"] == nil {
		t.Fatalf("空档案也要带 run_allow：%d %v", code, out)
	}
	code, out = call(t, h, "PATCH", "/api/projects/obj_p1/profile",
		`{"run_allow":[" Bash(./_shared/新建需求.sh:*) ","","Bash(./_shared/新建需求.sh:*)","Read(//Volumes/docs/PRDs/**)","mcp__claude_ai_Slack__slack_read_thread"]}`)
	want := "Bash(./_shared/新建需求.sh:*)|Read(//Volumes/docs/PRDs/**)|mcp__claude_ai_Slack__slack_read_thread"
	if code != 200 || joinAny(out["data"].(map[string]any)["run_allow"]) != want {
		t.Fatalf("存执行白名单：%d %v", code, out)
	}
	if code, _ := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"intro":"只改简介"}`); code != 200 {
		t.Fatal(code)
	}
	got, err := r.ProjectRunAllow(ctx, "obj_p1")
	if err != nil || strings.Join(got, "|") != want {
		t.Fatalf("钩子读出：%v %v", got, err)
	}
	for _, bad := range []string{`["Bash(*)"]`, `["Bash"]`, `["rm -rf x"]`, `["Bash(ls:*)\nBash(rm:*)"]`} {
		if code, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"run_allow":`+bad+`}`); code != 400 {
			t.Errorf("%s 应 400：%d %v", bad, code, out)
		}
	}
	if code, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"run_allow":[]}`); code != 200 || joinAny(out["data"].(map[string]any)["run_allow"]) != "" {
		t.Fatalf("清空：%d %v", code, out)
	}
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ProjectRunAllow(ctx, "obj_p1"); !errors.Is(err, plugin.ErrNoProjectRunAllow) {
		t.Fatalf("停用后应回 ErrNoProjectRunAllow：%v", err)
	}
}

func joinAny(v any) string {
	xs, _ := v.([]any)
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i], _ = x.(string)
	}
	return strings.Join(s, "|")
}
