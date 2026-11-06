package sop

import (
	"context"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 给模型看的编排说明（TSK-0490）：节点目录（含插件节点的配置项、输出字段）、触发方式自动带入的字段、结构化条件的写法、
// IM 触发的过滤 / 顺序 / 拦截、文件夹。编辑器的 AI 协助（assist.go）和 Agent 的 create_sop / update_sop（经 SOPGuide）用同一份，
// 都从 spec.go 和插件登记的声明生成，改节点不用改这里。

// allNodeTypes 是内置的加在跑的插件登记的。
func allNodeTypes(c plugin.Core) []NodeType {
	out := make([]NodeType, 0, len(NodeTypes))
	for _, t := range NodeTypes {
		t.Source = "builtin"
		out = append(out, t)
	}
	for _, n := range c.SOP().Nodes() {
		out = append(out, pluginNodeType(n))
	}
	return out
}

// hiddenKinds 是不该再用的内置节点：notify 由 IM 插件的节点代替、code 后端不执行。目录里不列。
var hiddenKinds = map[string]bool{"notify": true, "code": true}

// catalogText 是节点目录，一个节点一段。
func catalogText(types []NodeType) string {
	var b strings.Builder
	for _, t := range types {
		if hiddenKinds[t.Kind] {
			continue
		}
		fmt.Fprintf(&b, "- %s「%s」（%s", t.Kind, orDefault(t.Label, t.Kind), t.Group)
		if t.Source != "" && t.Source != "builtin" {
			fmt.Fprintf(&b, "，插件 %s", t.Source)
		}
		b.WriteString("）")
		if t.Desc != "" {
			b.WriteString("：" + t.Desc)
		}
		if t.Branching && len(t.DefaultCases) > 0 {
			cs := make([]string, len(t.DefaultCases))
			for i, c := range t.DefaultCases {
				cs[i] = c.Key + "=" + c.Label
			}
			b.WriteString("。分支出口 " + strings.Join(cs, "、"))
		}
		b.WriteString("\n")
		switch {
		case t.Params == nil && len(t.Required) > 0:
			req := make([]string, len(t.Required))
			for i, r := range t.Required {
				req[i] = r.Key + "（" + r.Label + "，必填）"
			}
			b.WriteString("  配置：" + strings.Join(req, "；") + "\n")
		case len(t.Params) > 0:
			ps := make([]string, len(t.Params))
			for i, p := range t.Params {
				ps[i] = paramText(p)
			}
			b.WriteString("  配置：" + strings.Join(ps, "；") + "\n")
		case t.Params != nil:
			b.WriteString("  配置：无（config 留空）\n")
		}
		switch {
		case !t.declared():
			b.WriteString("  输出：没声明（下游引用它的字段只能碰运气，尽量别依赖）\n")
		case len(t.Outputs) == 0:
			b.WriteString("  输出：输入原样往下传，不加字段\n")
		default:
			os := make([]string, len(t.Outputs))
			for i, o := range t.Outputs {
				os[i] = outputText(o)
			}
			b.WriteString("  输出（输入原样往下传，再加上）：" + strings.Join(os, "；") + "\n")
		}
	}
	return b.String()
}

func paramText(p Param) string {
	s := p.Key + "（" + p.Label
	if p.Required {
		s += "，必填"
	}
	if p.Default != "" {
		s += "，留空按 " + p.Default
	}
	if p.Template {
		s += "，可写 {{字段}}"
	}
	s += "）"
	if len(p.Options) > 0 {
		os := make([]string, len(p.Options))
		for i, o := range p.Options {
			v := o.Value
			if v == "" {
				v = `""`
			}
			os[i] = v + "=" + o.Label
		}
		s += " 可选 " + strings.Join(os, "、")
	}
	if p.Source != "" {
		s += " 取值来自" + sourceLabel(p.Source)
	}
	if p.Desc != "" {
		s += "：" + p.Desc
	}
	return s
}

func sourceLabel(src string) string {
	if l, ok := map[string]string{srcAgents: "已有的 Agent", srcProviders: "模型服务商", srcModels: "服务商的模型", srcKBs: "知识库 id",
		srcProjects: "项目（id、编号或名字）", srcDocCats: "文档分类", srcFlows: "已有的流程 id", srcPresets: "Claude Code 角色",
		srcUpstream: "上游步骤的 key", srcConvs: "IM 会话（cv_ 开头的会话 id）", srcTaskStages: "任务阶段"}[src]; ok {
		return l
	}
	return src
}

func outputText(o Output) string {
	s := o.Path + "（" + o.Type + "）" + o.Label
	if len(o.Values) > 0 {
		vs := make([]string, len(o.Values))
		for i, v := range o.Values {
			x := v.Value
			if x == "" {
				x = `""`
			}
			vs[i] = x + "=" + v.Label
		}
		s += "，取值 " + strings.Join(vs, "、")
	}
	return s
}

// triggersText 是触发方式和自动带入的字段。
func triggersText() string {
	var b strings.Builder
	for _, t := range Triggers {
		fmt.Fprintf(&b, "- %s「%s」：%s", t.Key, t.Label, t.Desc)
		if len(t.Outputs) > 0 {
			os := make([]string, len(t.Outputs))
			for i, o := range t.Outputs {
				os[i] = outputText(o)
			}
			b.WriteString("。自动带进输入：" + strings.Join(os, "；"))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// condGuide 是结构化条件的写法，模型照着写。
const condGuide = `条件分支（decide）和条件回退（loopback）的条件写在步骤的 "cond" 上（和 kind 同级，不在 config 里）：
  "cond": {"logic": "and" 或 "or", "items": [{"field": "字段路径", "op": "运算符", "value": "值"}]}
  - op 只能是 eq（等于）、ne（不等于）、contains（包含：文字含子串，列表有一项等于）、not_contains（不包含）、empty（为空）、not_empty（不为空）；empty / not_empty 不写 value。value 一律写成字符串。
  - field 必须是这一步真实拿得到的字段：触发方式自动带入的、输入字段（fields 的 key）、上游步骤输出里声明的（见节点目录的「输出」）。不要编字段，不要用中文描述当字段。
  - 成立走第一个出口（decide 的 yes、loopback 退回重做），不成立走第二个。cond 和 rule 都不写的 decide 是人工判断（停下等人选）。
  - 不要写 "rule"，也不要把一句话（比如「来源是某群且没有 @我」）当条件：程序没法照着一句话判断。说明性的话写进步骤的 desc。
  - 能用触发方式自带的过滤表达的（比如 IM 消息的会话、和我的关系），用触发过滤，不要再加判断节点。`

// imGuide 是 IM 触发的过滤、执行顺序、拦截（TSK-0481）怎么写进草稿。
const imGuide = `触发方式是 im 时，草稿里可以带 "im"：{"conversations": [...], "relevance": [...], "relevance_mode": "include" 或 "exclude", "order": 数字, "stop": true/false}
  - conversations：只处理这些会话的消息，写渠道里的会话编号（如 Slack 的 "C0BNCBRL5C0"）、会话名或 cv_ 开头的会话 id；空数组是全部会话。
  - relevance：和我的关系 me（@我）、all（@所有人）、dm（私聊）、none（无关）；relevance_mode 是 include（只要这几种）或 exclude（除了这几种），比如「除了 @我 的」写 "relevance": ["me"], "relevance_mode": "exclude"。
  - order：在所有 IM 流程里排第几执行（1 最先）；stop=true 表示这条流程命中并发起后，排在后面的 IM 流程不再处理这条消息。「优先于其他流程」「先于别的工作流执行」就写 "order": 1, "stop": true。
  - 不符合过滤的消息根本不会发起执行，比在流程里加判断节点更省事、更准。
  - IM 触发只带 message_id 等几个字段（见触发方式），输入字段里必填又没有默认值的会让每条消息都被跳过；要正文、发信人用 im_get_message 取（输出 message.text 等）。`

// guideText 是整份说明；folders 是流程库的文件夹，nil 时不写这一节。
func guideText(types []NodeType, folders []Folder) string {
	var b strings.Builder
	b.WriteString("节点类型目录（kind 只能用这里的；配置项的值一律写成字符串）：\n")
	b.WriteString(catalogText(types))
	b.WriteString("\n触发方式（trigger）：\n")
	b.WriteString(triggersText())
	b.WriteString("\n" + condGuide + "\n\n" + imGuide + "\n")
	if folders != nil {
		b.WriteString("\n流程库的文件夹（草稿里写 \"folder_id\" 放进去，不写是不改）：")
		if len(folders) == 0 {
			b.WriteString("还没有文件夹\n")
		} else {
			names := make([]string, len(folders))
			for i, f := range folders {
				names[i] = f.ID + "=" + f.Name
			}
			b.WriteString(strings.Join(names, "、") + "\n")
		}
	}
	return b.String()
}

// SOPGuide 是给 Agent 的同一份说明（内核流程目录 SOPCatalog，TSK-0490）。
func (s *starter) SOPGuide(ctx context.Context) (string, error) {
	folders, _, err := listFolders(ctx, s.c)
	if err != nil {
		return "", err
	}
	return guideText(allNodeTypes(s.c), folders), nil
}
