package runner

import (
	"strings"
	"testing"
)

func TestBuildPromptIncludesAcceptanceAndRepo(t *testing.T) {
	p := BuildPrompt(Task{Title: "修除零", Workdir: "/w", Acceptance: "- [ ] 抛 ValueError", Repo: "/w"})
	if !strings.Contains(p, "## 验收标准\n- [ ] 抛 ValueError") || !strings.Contains(p, "关联仓库：/w") {
		t.Fatalf("提示词里应有验收标准和关联仓库:\n%s", p)
	}
	// 没有时整节消失，不留空标题。
	p = BuildPrompt(Task{Title: "x", Workdir: "/w"})
	if strings.Contains(p, "验收标准") || strings.Contains(p, "关联仓库") {
		t.Fatalf("没有验收标准时不应出现该节:\n%s", p)
	}
}

// 任务挂在项目下：项目名称、编号、工作目录、文档目录、原型目录都写进去，约束放宽到这两个目录。
func TestBuildPromptProjectContext(t *testing.T) {
	p := BuildPrompt(Task{Title: "改原型", Workdir: "/w", Project: &Project{
		Name: "一人之下控制台", Ref: "PRJ-0007", Workdir: "/Volumes/project/pmw",
		DocsDir: "/Volumes/docs/example/acme-project", DocsLabel: "acme-project概况",
		Prototypes: []PrototypeDir{{Name: "原型站点（web-next）", Dir: "/Volumes/project/pmw/web-next"}},
	}})
	for _, want := range []string{
		"## 所属项目\n名称：一人之下控制台（PRJ-0007）\n",
		"项目工作目录：/Volumes/project/pmw\n",
		"文档在哪里操作：/Volumes/docs/example/acme-project（项目关联目录「acme-project概况」）\n",
		"原型在哪里操作：\n  - 原型站点（web-next）：/Volumes/project/pmw/web-next\n",
		"文档目录和原型目录里",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("提示词里应有 %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "不要改动工作区之外的任何文件") || strings.Contains(p, "回写到工作台") {
		t.Fatalf("有项目时约束应放宽，流式执行没有回写一节:\n%s", p)
	}
}

// 项目没有文档目录、没有登记原型：写明可在项目设置里补，不写项目工作目录那一行。
func TestBuildPromptProjectWithoutDirs(t *testing.T) {
	p := BuildPrompt(Task{Title: "x", Workdir: "/w", Project: &Project{Name: "Acme"}})
	for _, want := range []string{
		"名称：Acme\n",
		"这个项目没有设文档目录，可在项目设置里补",
		"这个项目没有登记原型目录，可在项目设置里补",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("提示词里应有 %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "项目工作目录") || strings.Contains(p, "（）") {
		t.Fatalf("没设的字段不该留空行:\n%s", p)
	}
}

// 没挂项目：没有「所属项目」一节，约束照旧。
func TestBuildPromptNoProject(t *testing.T) {
	p := BuildPrompt(Task{Title: "x", Workdir: "/w"})
	if strings.Contains(p, "所属项目") || !strings.Contains(p, "不要改动工作区之外的任何文件") {
		t.Fatalf("没挂项目时不该有项目一节:\n%s", p)
	}
}

// 终端执行：要求经 MCP 回写，执行 id 和对象 id 都写进去。
func TestBuildPromptWriteBack(t *testing.T) {
	p := BuildPrompt(Task{Title: "x", Workdir: "/w", WriteBack: &WriteBack{RunID: "run_abc", ObjectID: "obj_1"}})
	for _, want := range []string{
		"## 回写到工作台", "执行记录 run_abc", "pmw_update_object（id=obj_1）",
		"object_id=obj_1、run_id=run_abc", "调 pmw_finish_run，run_id=run_abc",
	} {
		if !strings.Contains(p, want) {
			t.Fatalf("提示词里应有 %q:\n%s", want, p)
		}
	}
}
