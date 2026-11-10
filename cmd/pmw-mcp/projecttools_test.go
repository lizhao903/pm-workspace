// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func TestRenderProjectProfiles(t *testing.T) {
	now := time.Now()
	projects := []*domain.Object{
		{ID: "obj_a", Ref: "PRJ-1", Title: "工作台", Body: "个人产品管理\n第二行"},
		{ID: "obj_b", Ref: "PRJ-2", Title: "官网", Body: "公司官网"},
		{ID: "obj_c", Ref: "PRJ-3", Title: "删掉的", DeletedAt: &now},
	}
	var row projectProfileSummary
	row.ProjectID, row.Keywords, row.Platforms, row.Commands = "obj_a", []string{"需求", "原型"}, []string{"web"}, []string{"build", "test"}
	row.Dirs = map[string]struct {
		Path      string `json:"path"`
		State     string `json:"state"`
		Inherited bool   `json:"inherited"`
	}{
		"code":      {Path: "/src/pmw", State: "ok", Inherited: true},
		"prototype": {Path: "/src/proto", State: "missing"},
		"prd":       {State: "unset"},
	}
	out := renderProjectProfiles(projects, []projectProfileSummary{row}, false)
	for _, want := range []string{
		"工作台 (obj_a) PRJ-1", "简介：个人产品管理", "关键词：需求、原型", "平台：web",
		"目录不全：代码库 /src/pmw（沿用项目目录）；原型库 /src/proto（找不到）；PRD 未设", "命令：build, test",
		"官网 (obj_b) PRJ-2\n  未建档案\n  说明：公司官网",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("缺 %q：\n%s", want, out)
		}
	}
	if strings.Contains(out, "删掉的") || strings.Contains(out, "第二行") {
		t.Fatalf("软删项目、说明第二行不该出现：\n%s", out)
	}
	if off := renderProjectProfiles(projects[1:2], nil, true); !strings.HasPrefix(off, "项目插件没启用") || strings.Contains(off, "未建档案") {
		t.Fatalf("插件没启用：\n%s", off)
	}
	if renderProjectProfiles(nil, nil, false) != "工作台里还没有项目。" {
		t.Fatal("没项目")
	}
}
