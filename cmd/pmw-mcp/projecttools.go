package main

// 项目档案（AUTO-04）的只读工具：分类 Agent 拿它判断一条需求属于哪个项目，pipeline 拿它找目录和命令。
// 档案在项目插件的表里（/api/projects/profiles），插件读不到对象列表，没建档案的项目这里用 /api/objects?type=project 补上。

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// projectProfileSummary 对应 GET /api/projects/profiles 的一行。
type projectProfileSummary struct {
	ProjectID string   `json:"project_id"`
	Name      string   `json:"name"`
	Ref       string   `json:"ref"`
	Intro     string   `json:"intro"`
	Keywords  []string `json:"keywords"`
	Platforms []string `json:"platforms"`
	Dirs      map[string]struct {
		Path      string `json:"path"`
		State     string `json:"state"`
		Inherited bool   `json:"inherited"`
	} `json:"dirs"`
	DirsReady bool     `json:"dirs_ready"`
	Commands  []string `json:"commands"`
}

const listProjectProfilesDesc = `【只读】列出全部项目的档案摘要：简介、关键词、平台标签、三个目录（代码库、原型库、PRD）是否齐全、设了哪些命令。

什么时候用：要判断一条需求、一条 IM 消息属于哪个项目（分类），或者要找某个项目的代码库、原型库、PRD 目录时。

要点：
- 档案在项目页的「档案」标签里编辑；没建过档案的项目也会列出来，标「未建档案」，这时只有名称和说明可参考。
- 目录状态：ok 存在、missing 设了但找不到、unset 没设；代码库没设时用项目目录，标「沿用项目目录」。
- 命令只列设了哪些（build 构建、test 测试、test_env 起测试环境、smoke 测试环境冒烟、version 版本号与更新日志、package 打包、preflight 发布前检查、release 发布、prod_smoke 线上冒烟、rollback 回滚），命令原文在项目档案接口 GET /api/projects/{id}/profile 里。
- 项目插件没启用时只列项目名称和说明。

返回：每个项目一段，第一行「名称 (id) ref」，下面是简介、关键词、平台、目录、命令。`

var dirLabels = []struct{ key, label string }{{"code", "代码库"}, {"prototype", "原型库"}, {"prd", "PRD"}}

var dirStateLabels = map[string]string{"ok": "", "missing": "（找不到）", "unset": "未设"}

func addListProjectProfiles(s *mcp.Server, c *client) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "pmw_list_project_profiles",
		Description: listProjectProfilesDesc,
		Annotations: readOnly("列出项目档案摘要"),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		q := url.Values{"type": {"project"}, "limit": {"200"}, "sort": {"title"}}
		projects, _, err := c.listObjects(ctx, q)
		if err != nil {
			return nil, nil, err
		}
		var rows []projectProfileSummary
		pluginOff := false
		if _, err := c.do(ctx, http.MethodGet, "/api/projects/profiles", nil, nil, &rows); err != nil {
			if !strings.Contains(err.Error(), "not_found") {
				return nil, nil, err
			}
			pluginOff = true
		}
		return textResult(renderProjectProfiles(projects, rows, pluginOff)), nil, nil
	})
}

// renderProjectProfiles 把项目列表和档案摘要合成一段文字；软删的项目不列。
func renderProjectProfiles(projects []*domain.Object, rows []projectProfileSummary, pluginOff bool) string {
	byID := map[string]projectProfileSummary{}
	for _, r := range rows {
		byID[r.ProjectID] = r
	}
	if len(projects) == 0 {
		return "工作台里还没有项目。"
	}
	var b strings.Builder
	if pluginOff {
		b.WriteString("项目插件没启用，只能列出项目名称和说明。\n\n")
	}
	for _, o := range projects {
		if o.DeletedAt != nil {
			continue
		}
		fmt.Fprintf(&b, "%s (%s) %s\n", o.Title, o.ID, o.Ref)
		r, ok := byID[o.ID]
		if !ok {
			if !pluginOff {
				b.WriteString("  未建档案\n")
			}
			if d := firstLineOf(o.Body); d != "" {
				fmt.Fprintf(&b, "  说明：%s\n", d)
			}
			b.WriteString("\n")
			continue
		}
		intro := r.Intro
		if intro == "" {
			intro = firstLineOf(o.Body)
		}
		if intro != "" {
			fmt.Fprintf(&b, "  简介：%s\n", truncate(strings.ReplaceAll(intro, "\n", " "), 300))
		}
		if len(r.Keywords) > 0 {
			fmt.Fprintf(&b, "  关键词：%s\n", strings.Join(r.Keywords, "、"))
		}
		if len(r.Platforms) > 0 {
			fmt.Fprintf(&b, "  平台：%s\n", strings.Join(r.Platforms, "、"))
		}
		var dirs []string
		for _, d := range dirLabels {
			st := r.Dirs[d.key]
			switch {
			case st.State == "unset":
				dirs = append(dirs, d.label+" 未设")
			case st.Inherited:
				dirs = append(dirs, d.label+" "+st.Path+dirStateLabels[st.State]+"（沿用项目目录）")
			default:
				dirs = append(dirs, d.label+" "+st.Path+dirStateLabels[st.State])
			}
		}
		ready := "目录齐全"
		if !r.DirsReady {
			ready = "目录不全"
		}
		fmt.Fprintf(&b, "  %s：%s\n", ready, strings.Join(dirs, "；"))
		if len(r.Commands) > 0 {
			fmt.Fprintf(&b, "  命令：%s\n", strings.Join(r.Commands, ", "))
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	return s
}
