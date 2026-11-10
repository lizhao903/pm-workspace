// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"encoding/json"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 原型同步（AUTO-11，docs/auto-delivery-flow.md 第 2 节「旁路：按上线代码回写原型库」）。
//
// 内置流程「原型同步」（sop_im_proto_sync）同另外三条一样由后台任务 sop_templates 写进 SOP，写过一次记在 im_sop_templates，
// 用户删了不补回来；触发方式「手动」即默认停用。由项目插件发起（发布成功、生产分支合并、每日巡检三种触发，各自在项目里开关，默认都关），
// 也能在 SOP 页手动发起（输入项目 id）。流程放在 IM 插件写：末尾要用本插件的 im_notify 通知产品负责人，
// 同步点、取范围、同步分支这些节点在项目插件（IM 的内置流程本来就用项目插件的节点，依赖方向不变）。
//
// 步骤：读项目档案 → 取同步范围（同步点 → 生产分支 HEAD 的代码 diff）→ 没有涉及界面或接口的改动就只前移同步点、结束；
// 有 → 准备原型同步分支（原型库拉 proto-sync/<日期> 的 worktree）→ Claude Code（角色 rp_protosync，可写）对比并按五类处理 →
// 登记差异 → 有拿不准的通知负责人、人工裁决（当作新设计 → 再交 Claude Code 按代码回写；当作缺陷 → 建修复任务；暂不处理）→
// 提交同步分支（只提交到 proto-sync/ 分支，不碰主分支）→ 记同步点 → 通知负责人。

// ProtoSyncFlowID 是内置流程「原型同步」的 id，项目插件按它发起（projects.ProtoSyncFlowID）。
const ProtoSyncFlowID = "sop_im_proto_sync"

const protoSyncPrompt = `把原型库拉齐到已上线的代码（项目 {{profile.name}}）。
代码库：{{sync.code_dir}}，生产分支 {{sync.branch}}，这次范围 {{sync.base_short}} → {{sync.head_short}}，改动 {{sync.files_count}} 个文件。
完整 diff：{{sync.diff_path}}（首次同步没有 diff，直接对照代码库在 {{sync.head_short}} 的代码）。改动摘要：
{{sync.diff_stat}}

工作目录是原型库同步分支 {{sync.proto_branch}} 的独立 worktree：只改这里面的原型和规格，不要切换分支、不要动别的分支、不要推送、不要合并，改完提交到当前分支。
代码库只读：用 git -C {{sync.code_dir}} show {{sync.head}}:<文件> 看上线版本，不要改代码库。

按路由、组件、规格编号把代码改动映射到原型页面和规格条目，逐项对比，分五类处理：
1. 新增（added）：代码有、原型没有。补原型页面或状态，规格加条目（编号接该节现有最大号往后加），条目末尾标「实现状态：已实现（原型同步 {{sync.head_short}}）」。
2. 不一致（changed）：都有但不一致。以代码为准改原型和规格，被替换的旧设计写进 detail 留档；条目标「实现状态：已实现」。
3. 未实现（unimplemented）：原型有、代码没有。不删原型，规格条目标「实现状态：未实现」。
4. 已下线（removed）：代码已删、原型还在。不直接删，原型标「已下线」，规格条目标「实现状态：已下线（代码 {{sync.head_short}} 删除）」。
5. 不确定（uncertain）：分不清是 bug 还是有意改动。不改原型，列出来交给产品裁决，不要自己定。
没有涉及界面或接口的改动就什么都不改。
result 里回报 {"items": [{"kind": "added、changed、unimplemented、removed、uncertain 之一", "title": "一句话", "detail": "差异说明；不一致时写旧设计", "spec": "规格编号，没有留空", "page": "原型页面或路由"}]}。
summary 写给产品看：同步了什么、哪些拿不准。`

const protoRewritePrompt = `产品已裁决：原型同步里拿不准的差异「当作新设计」，以上线代码 {{sync.head_short}} 为准回写原型和规格。
差异清单（只处理标了「裁决：当作新设计，按代码回写」的那几条）：
{{sync.items_text}}

做法同上一轮：被替换的旧设计留档，规格条目标「实现状态：已实现（产品裁决）」。
工作目录仍是原型库同步分支 {{sync.proto_branch}} 的 worktree，代码库 {{sync.code_dir}} 只读；改完提交到当前分支，不切分支、不推送、不合并。
summary 写改了哪些页面和规格条目。`

const protoAskText = `项目 {{profile.name}} 的原型同步（代码 {{sync.base_short}} → {{sync.head_short}}）有 {{sync.counts.pending}} 条差异拿不准是 bug 还是有意改动，等产品裁决：
{{sync.pending_text}}

负责人：{{profile.owners_text}}
到 SOP 执行页的「产品裁决」选：当作新设计（按代码回写原型）、当作缺陷（建修复任务，原型不动）、暂不处理。`

const protoDoneText = `{{sync.text}}
差异清单：
{{sync.items_text}}
负责人：{{profile.owners_text}}`

// protoSyncFlow 是内置流程「原型同步」。触发方式「手动」即默认停用。
func protoSyncFlow() plugin.SOPFlowTemplate {
	claude := func(key, name string, after []string, prompt, desc string, br *intakeBranch) intakeStep {
		return intakeStep{Key: key, Name: name, Kind: "claude_code", After: after, Branch: br, Desc: desc,
			Config: map[string]string{"preset": "rp_protosync", "workdir": "{{sync.proto_path}}", "prompt": prompt, "permission": "write", "timeout": "2 小时"}}
	}
	verdict := func(key, name, decision, label string) intakeStep {
		return intakeStep{Key: key, Name: name, Kind: "projects_proto_sync_verdict", After: []string{"verdict"}, Branch: &intakeBranch{"verdict", decision},
			Desc: label, Config: map[string]string{"decision": decision}}
	}
	steps := []intakeStep{
		{Key: "profile", Name: "读项目档案", Kind: "projects_get_profile", After: []string{}, Desc: "取项目名和负责人，通知时用",
			Config: map[string]string{"project": "{{project_id}}"}},
		{Key: "range", Name: "取同步范围", Kind: "projects_proto_sync_range", After: []string{"profile"},
			Desc: "上次同步点到生产分支 HEAD 的代码 diff；没有同步点时对比整个代码库"},
		{Key: "range_gate", Name: "有涉及界面或接口的改动吗", Kind: "decide", After: []string{"range"}, Rule: "sync.changed 等于 true",
			Cases: []intakeCase{{"changed", "有"}, {"none", "没有"}}},
		// 没有：只前移同步点
		{Key: "record_none", Name: "前移同步点", Kind: "projects_proto_sync_record", After: []string{"range_gate"}, Branch: &intakeBranch{"range_gate", "none"},
			Desc: "只有测试、文档这类改动：同步点记到这次的 HEAD", Config: map[string]string{"outcome": "no_change"}},
		{Key: "none_end", Name: "结束", Kind: "end", After: []string{"record_none"}},
		// 有：在同步分支上对比和回写
		{Key: "branch", Name: "准备原型同步分支", Kind: "projects_proto_sync_branch", After: []string{"range_gate"}, Branch: &intakeBranch{"range_gate", "changed"},
			Desc: "原型库拉 proto-sync/<日期> 分支的独立 worktree，不碰主分支"},
		claude("agent", "原型同步：对比与回写", []string{"branch"}, protoSyncPrompt,
			"Claude Code 按「原型同步」角色对比上线代码和原型、规格，按新增、不一致、未实现、已下线、不确定五类处理，确定的直接改", nil),
		{Key: "classify", Name: "登记差异", Kind: "projects_proto_sync_classify", After: []string{"agent"}, Desc: "按五类记下差异清单和规格的实现状态"},
		{Key: "pending_gate", Name: "有拿不准的吗", Kind: "decide", After: []string{"classify"}, Rule: "sync.has_pending 等于 true",
			Cases: []intakeCase{{"pending", "有"}, {"clear", "没有"}}},
		// 有拿不准的：通知负责人，人工裁决
		{Key: "ask", Name: "通知负责人裁决", Kind: NodeNotify, After: []string{"pending_gate"}, Branch: &intakeBranch{"pending_gate", "pending"},
			Config: map[string]string{"title": "{{profile.name}} 原型同步有 {{sync.counts.pending}} 条差异待裁决", "text": protoAskText, "level": "info"}},
		{Key: "verdict", Name: "产品裁决", Kind: "decide", After: []string{"ask"},
			Desc:  "看差异清单判断：当作新设计（按代码回写原型）、当作缺陷（建修复任务回主线，原型不动）、暂不处理（留在差异清单里）",
			Cases: []intakeCase{{"design", "当作新设计"}, {"defect", "当作缺陷"}, {"ignore", "暂不处理"}}},
		verdict("v_design", "记裁决：新设计", "design", "拿不准的都按代码回写"),
		claude("rewrite", "按代码回写裁决为新设计的差异", []string{"v_design"}, protoRewritePrompt, "Claude Code 在同一个同步分支上按上线代码改原型和规格", nil),
		verdict("v_defect", "记裁决：缺陷", "defect", "给项目建一条修复任务，原型和规格不动"),
		verdict("v_ignore", "记裁决：暂不处理", "ignore", "留在差异清单里，下次同步再看"),
		{Key: "clear", Name: "都确定", Kind: "template", After: []string{"pending_gate"}, Branch: &intakeBranch{"pending_gate", "clear"},
			Config: map[string]string{"template": "{{sync.id}}", "output": "sync_id"}},
		// 汇合：提交同步分支、记同步点、通知
		{Key: "commit", Name: "提交同步分支", Kind: "projects_proto_sync_commit", After: []string{"rewrite", "v_defect", "v_ignore", "clear"},
			Desc: "把没提交的改动提交到 proto-sync/ 分支；不推送、不合并，产品看过差异清单后自己合并"},
		{Key: "record", Name: "记同步点", Kind: "projects_proto_sync_record", After: []string{"commit"}, Desc: "这次的代码 HEAD 记成同步点，和同步分支的提交对应"},
		{Key: "notify", Name: "通知负责人", Kind: NodeNotify, After: []string{"record"},
			Config: map[string]string{"title": "{{profile.name}} 原型已同步到 {{sync.head_short}}", "text": protoDoneText, "level": "success"}},
		{Key: "done", Name: "结束", Kind: "end", After: []string{"notify"}},
	}
	fields := []map[string]any{
		{"key": "project_id", "label": "项目", "type": "text", "required": true, "placeholder": "项目 id、编号或名字；项目档案里要有代码库目录和原型库目录（都在 git 仓库里）"},
		{"key": "sync_id", "label": "同步记录", "type": "text", "placeholder": "项目插件发起时带上；手动发起留空"},
		{"key": "trigger", "label": "触发方式", "type": "text", "placeholder": "release、merge、daily；手动发起留空"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: ProtoSyncFlowID, Name: "原型同步", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "以上线代码为准回写原型库和规格：取上次同步点到生产分支 HEAD 的代码 diff，Claude Code 在原型库的同步分支上对比，" +
			"新增、不一致的按代码改，未实现、已下线的在规格上标状态，拿不准的交产品裁决；只提交到同步分支，记同步点并通知负责人。" +
			"默认停用：在项目档案的「原型同步」里开发布成功、生产分支合并、每日巡检三种触发，或手动发起",
	}
}
