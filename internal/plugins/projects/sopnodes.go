// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// SOP 节点（AUTO-06），经内核的 SOP 节点扩展点登记（plugin-api.md 2.7），给「IM 需求自动受理」这类流程取项目档案：
//   - 列项目档案 projects_list_profiles：建过档案的项目摘要，输出 profiles（列表）和 profiles_text（给模型看的几行文字），
//     分类步骤把 profiles_text 拼进提示词；
//   - 读项目档案 projects_get_profile：按项目 id、编号或名字读一个项目的档案，输出 profile，其中 dirs 是各角色该在哪个目录跑：
//     code 是代码库目录（没设用项目目录），prototype 是原型库目录（没设或找不到依次退到 PRD 目录、代码库目录），
//     prd 是 PRD 目录（没设或找不到依次退到原型库目录、代码库目录）。Claude Code 节点的工作目录写 {{profile.dirs.prototype}}。
// 插件之间不 import：IM、SOP 插件读不到本插件的表，经节点把档案交到流程里。只读，不改档案。

const (
	NodeListProfiles = "projects_list_profiles"
	NodeGetProfile   = "projects_get_profile"
)

func registerSOPNodes(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeListProfiles, Group: "项目", Required: []plugin.SOPNodeField{}, Run: listProfilesNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeGetProfile, Group: "项目",
		Required: []plugin.SOPNodeField{{Key: "project", Label: "项目"}}, Run: getProfileNode})
}

func listProfilesNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	list, err := listProfileSummaries(ctx, c)
	if err != nil {
		return nil, err
	}
	rows := make([]any, 0, len(list))
	var b strings.Builder
	for _, s := range list {
		rows = append(rows, map[string]any{"project_id": s.ProjectID, "name": s.Name, "ref": s.Ref, "intro": s.Intro,
			"keywords": anyStrs(s.Keywords), "platforms": anyStrs(s.Platforms), "dirs_ready": s.DirsReady})
		fmt.Fprintf(&b, "- %s（编号 %s，id %s）", s.Name, s.Ref, s.ProjectID)
		if s.Intro != "" {
			fmt.Fprintf(&b, "：%s", oneLine(s.Intro, 300))
		}
		if len(s.Keywords) > 0 {
			fmt.Fprintf(&b, "；关键词：%s", strings.Join(s.Keywords, "、"))
		}
		if len(s.Platforms) > 0 {
			fmt.Fprintf(&b, "；平台：%s", strings.Join(s.Platforms, "、"))
		}
		b.WriteString("\n")
	}
	text := strings.TrimSpace(b.String())
	if text == "" {
		text = "（还没有项目建过档案）"
	}
	return with(n.Input, map[string]any{"profiles": rows, "profiles_text": text}), nil
}

func getProfileNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	key := strings.TrimSpace(render(n.Config["project"], n.Input))
	if key == "" {
		return nil, fmt.Errorf("没有指定项目：配置「%s」在输入里取不到", strings.TrimSpace(n.Config["project"]))
	}
	o, err := c.Objects().Find(ctx, "project", key)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, fmt.Errorf("项目「%s」不存在：填项目 id、编号或名字，已删除的项目不算", key)
	}
	if err != nil {
		return nil, err
	}
	h := &profiles{&stakeholders{c: c}}
	p, err := h.load(ctx, o)
	if err != nil {
		return nil, err
	}
	code := firstDir(p.CodeDir, o.Workdir)
	dirs := map[string]any{
		"code":      code,
		"prototype": firstDir(p.ProtoDir, p.PRDDir, code),
		"prd":       firstDir(p.PRDDir, p.ProtoDir, code),
	}
	owners, ownersText, err := people(ctx, c, p.OwnerIDs)
	if err != nil {
		return nil, err
	}
	acceptors, acceptorsText, err := people(ctx, c, p.AcceptorIDs)
	if err != nil {
		return nil, err
	}
	return with(n.Input, map[string]any{"profile": map[string]any{
		"project_id": o.ID, "name": o.Title, "ref": o.Ref, "intro": p.Intro, "keywords": anyStrs(p.Keywords), "platforms": anyStrs(p.Platforms),
		"code_dir": p.CodeDir, "proto_dir": p.ProtoDir, "prd_dir": p.PRDDir, "root": o.Workdir, "dirs": dirs,
		"has_profile": p.CreatedAt != nil,
		// 负责人、验收人员（AUTO-09）：[{id, name}] 和给通知用的一行名字（「张三、李四」，没设为「（没设）」）
		"owners": owners, "owners_text": ownersText, "acceptors": acceptors, "acceptors_text": acceptorsText,
	}}), nil
}

// people 把联系人 id 换成 [{id, name}] 和一行名字；已删的联系人档案读出来时已经滤掉了。
func people(ctx context.Context, c plugin.Core, ids []string) ([]any, string, error) {
	out := make([]any, 0, len(ids))
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		ct, err := c.Contacts().Get(ctx, id)
		if errors.Is(err, plugin.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		out = append(out, map[string]any{"id": ct.ID, "name": ct.Name})
		names = append(names, ct.Name)
	}
	if len(names) == 0 {
		return out, "（没设）", nil
	}
	return out, strings.Join(names, "、"), nil
}

// firstDir 取第一个现在存在的目录；都不存在时取第一个设了的，都没设回空串。
func firstDir(cands ...string) string {
	first := ""
	for _, d := range cands {
		if d == "" {
			continue
		}
		if dirState(d).State == "ok" {
			return d
		}
		if first == "" {
			first = d
		}
	}
	return first
}

func anyStrs(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}

func with(input map[string]any, add map[string]any) map[string]any {
	out := make(map[string]any, len(input)+len(add))
	for k, v := range input {
		out[k] = v
	}
	for k, v := range add {
		out[k] = v
	}
	return out
}

/* ---------- {{字段}} 模板，口径同 SOP 插件 ---------- */

var (
	tplRe   = regexp.MustCompile(`\{\{\s*([\w.\[\]\p{Han}]+)\s*\}\}`)
	indexRe = regexp.MustCompile(`\[(\d+)\]`)
)

func render(tpl string, input map[string]any) string {
	return tplRe.ReplaceAllStringFunc(tpl, func(m string) string {
		return txt(getPath(input, tplRe.FindStringSubmatch(m)[1]))
	})
}

func getPath(obj any, path string) any {
	cur := obj
	for _, k := range strings.Split(indexRe.ReplaceAllString(strings.TrimSpace(path), ".$1"), ".") {
		if k == "" {
			continue
		}
		switch v := cur.(type) {
		case map[string]any:
			cur = v[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(v) {
				return nil
			}
			cur = v[i]
		default:
			return nil
		}
	}
	return cur
}

func txt(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case map[string]any, []any:
		b, _ := json.Marshal(x)
		return string(b)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}
