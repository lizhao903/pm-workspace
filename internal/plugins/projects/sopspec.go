package projects

import "github.com/lizhao903/pm-workspace/internal/plugin"

// SOP 节点的声明（TSK-0490）：每个节点做什么、认哪些配置、往输出里加哪些字段。保存校验、编辑器的「这一步能拿到的字段」、
// SOP 编排的 AI 协助和 Agent 建流程都按它出稿。Register 开头用 plugin.WithSOPSpecs 包一层，登记节点时按 kind 补上。
// 改节点的配置或输出时这里一起改，sopspec_test.go 盯着清单里的节点都有声明。

type (
	sp = plugin.SOPParam
	so = plugin.SOPOutput
)

func opt(pairs ...string) []plugin.SOPOption {
	out := make([]plugin.SOPOption, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, plugin.SOPOption{Value: pairs[i], Label: pairs[i+1]})
	}
	return out
}

var (
	taskKey   = sp{Key: "task", Label: "任务", Template: true, Desc: "任务 id 或编号，比如 {{task.id}}；留空取输入里的 task_id、task.id（跑测试、准备发布另认 worktree.task_id）"}
	syncParam = sp{Key: "sync", Label: "同步", Template: true, Default: "{{sync.id}}", Desc: "同步记录 id；接在「取同步范围」后面不用填"}
	okOut     = func(path, label string) so {
		return so{Path: path + ".ok", Type: "bool", Label: label, Values: opt("true", "成功", "false", "没成")}
	}
	stepsOut = func(path string) so {
		return so{Path: path + ".steps", Type: "list", Label: "每个子步骤 {key, label, status, duration_ms, timed_out, error, output, exit_code}"}
	}
	syncOut = []so{
		{Path: "sync", Type: "object", Label: "这次原型同步"},
		{Path: "sync.id", Type: "string", Label: "同步记录 id"},
		{Path: "sync.status", Type: "string", Label: "同步状态"},
		{Path: "sync.changed", Type: "bool", Label: "代码有没有涉及界面或接口的改动", Values: opt("true", "有", "false", "没有")},
		{Path: "sync.has_pending", Type: "bool", Label: "有没有等产品裁决的不确定项", Values: opt("true", "有", "false", "没有")},
		{Path: "sync.code_dir", Type: "string", Label: "代码库目录"}, {Path: "sync.branch", Type: "string", Label: "生产分支"},
		{Path: "sync.base_short", Type: "string", Label: "上次同步点（短 hash）"}, {Path: "sync.head_short", Type: "string", Label: "这次 HEAD（短 hash）"},
		{Path: "sync.diff_stat", Type: "string", Label: "改动统计"}, {Path: "sync.diff_path", Type: "string", Label: "diff 文件路径"},
		{Path: "sync.files", Type: "list", Label: "改动的文件（最多 200 个）"}, {Path: "sync.files_count", Type: "number", Label: "改动的文件数"},
		{Path: "sync.proto_path", Type: "string", Label: "原型同步分支的 worktree 目录"}, {Path: "sync.proto_branch", Type: "string", Label: "原型同步分支"},
		{Path: "sync.proto_commit", Type: "string", Label: "同步分支上的提交"},
		{Path: "sync.items", Type: "list", Label: "差异 {kind, title, detail, spec, page, status, decision}"},
		{Path: "sync.counts", Type: "object", Label: "各类差异的条数 {added, changed, unimplemented, removed, uncertain, pending}"},
		{Path: "sync.items_text", Type: "string", Label: "差异清单（给通知用）"}, {Path: "sync.pending_text", Type: "string", Label: "待裁决的差异"},
		{Path: "sync.decision", Type: "string", Label: "这次的裁决", Values: opt("design", "当作新设计", "defect", "当作缺陷", "ignore", "暂不处理", "", "还没裁决")},
		{Path: "sync.fix_task_id", Type: "string", Label: "当作缺陷时建的修复任务 id"},
		{Path: "sync.text", Type: "string", Label: "给通知用的一句话"},
	}
)

var sopSpecs = map[string]plugin.SOPNodeSpec{
	NodeListProfiles: {Effect: plugin.SOPEffectRead, Label: "列项目档案", Desc: "取建过档案的项目摘要（简介、关键词、平台），给模型判断归属项目用",
		Params: []sp{},
		Outputs: []so{{Path: "profiles", Type: "list", Label: "项目 {project_id, name, ref, intro, keywords, platforms, dirs_ready}"},
			{Path: "profiles_text", Type: "string", Label: "给模型看的项目清单，一行一个"}}},
	NodeGetProfile: {Effect: plugin.SOPEffectRead, Label: "读项目档案", Desc: "读一个项目的档案；profile.dirs 是代码库、原型库、PRD 目录（没设的依次回退）",
		Params: []sp{{Key: "project", Label: "项目", Required: true, Template: true, Source: "projects", Desc: "项目 id、编号或名字，比如 {{project.id}}"}},
		Outputs: []so{{Path: "profile", Type: "object", Label: "项目档案"},
			{Path: "profile.project_id", Type: "string", Label: "项目 id"}, {Path: "profile.name", Type: "string", Label: "项目名"},
			{Path: "profile.ref", Type: "string", Label: "项目编号"}, {Path: "profile.intro", Type: "string", Label: "简介"},
			{Path: "profile.keywords", Type: "list", Label: "关键词"}, {Path: "profile.platforms", Type: "list", Label: "平台"},
			{Path: "profile.code_dir", Type: "string", Label: "代码库目录（档案里设的）"}, {Path: "profile.root", Type: "string", Label: "项目工作目录"},
			{Path: "profile.dirs", Type: "object", Label: "{code, prototype, prd}，没设的依次回退"},
			{Path: "profile.dirs.code", Type: "string", Label: "代码库目录"}, {Path: "profile.dirs.prototype", Type: "string", Label: "原型库目录"},
			{Path: "profile.dirs.prd", Type: "string", Label: "PRD 目录"},
			{Path: "profile.has_profile", Type: "bool", Label: "建过档案"},
			{Path: "profile.owners", Type: "list", Label: "负责人 [{id, name}]"}, {Path: "profile.owners_text", Type: "string", Label: "负责人名字一行"},
			{Path: "profile.acceptors", Type: "list", Label: "验收人员 [{id, name}]"}, {Path: "profile.acceptors_text", Type: "string", Label: "验收人员名字一行"}}},
	NodePrepareWorktree: {Effect: plugin.SOPEffectWrite, DryRun: "不建 worktree、不分端口，列出任务；worktree 为占位", Label: "准备工作区", Desc: "给任务在项目代码库建独立的 worktree 和分支 auto/<任务编号>，分一段端口；下游 Claude Code 的工作目录填 {{worktree.path}}",
		Params: []sp{taskKey},
		Outputs: []so{{Path: "worktree", Type: "object", Label: "工作区"},
			{Path: "worktree.path", Type: "string", Label: "worktree 目录"}, {Path: "worktree.branch", Type: "string", Label: "分支"},
			{Path: "worktree.root", Type: "string", Label: "代码库根目录"}, {Path: "worktree.base_commit", Type: "string", Label: "起点提交"},
			{Path: "worktree.port_start", Type: "number", Label: "分到的端口起点"}, {Path: "worktree.port_end", Type: "number", Label: "端口终点"},
			{Path: "worktree.reused", Type: "bool", Label: "沿用了已有的工作区"},
			{Path: "worktree.task_id", Type: "string", Label: "任务 id"}, {Path: "worktree.task_ref", Type: "string", Label: "任务编号"}}},
	NodeRunTest: {Effect: plugin.SOPEffectWrite, DryRun: "不构建、不起测试环境、不写报告，列出任务和保留设置；test 为占位", Label: "跑测试", Desc: "在任务的工作区上按项目档案构建、起临时测试环境、跑测试和冒烟，写测试报告登记为任务产出；下游条件分支判断 test.ok",
		Params: []sp{taskKey, {Key: "keep_env", Label: "保留测试环境", Template: true, Desc: "留空不保留；「是」按设置里的时长保留，也可以写「24 小时」「2 天」"}},
		Outputs: []so{{Path: "test", Type: "object", Label: "测试结果"}, okOut("test", "全部通过"),
			{Path: "test.status", Type: "string", Label: "测试状态"}, {Path: "test.id", Type: "string", Label: "测试记录 id"},
			{Path: "test.error", Type: "string", Label: "没通过的原因"}, {Path: "test.failed_step", Type: "string", Label: "没通过的子步骤"},
			{Path: "test.report_url", Type: "string", Label: "测试报告链接"}, {Path: "test.url", Type: "string", Label: "测试环境地址"},
			{Path: "test.env_text", Type: "string", Label: "测试环境的一句话（地址、保留到什么时候）"},
			{Path: "test.env_kept", Type: "bool", Label: "测试环境保留了"}, stepsOut("test"),
			{Path: "test.junit", Type: "object", Label: "JUnit 汇总 {files, tests, failures, errors, skipped, failed}"}}},
	NodePrepareRelease: {Effect: plugin.SOPEffectWrite, DryRun: "不跑版本号和打包，列出任务；release 为占位", Label: "准备发布", Desc: "在任务的工作区上按项目档案跑版本号与更新日志、打包，不碰生产；跑完停在等审批。下游条件分支判断 release.ok",
		Params:  []sp{taskKey},
		Outputs: releaseOut},
	NodeRelease: {Effect: plugin.SOPEffectWrite, DryRun: "不碰生产、不记审批，列出发布 id；release 为占位", Label: "上线", Desc: "放在人工审批之后：发布前检查、发布、线上冒烟，发布或冒烟没过自动回滚。只认准备好、等审批的发布",
		Params:  []sp{{Key: "release", Label: "发布", Template: true, Default: "{{release.id}}", Desc: "发布 id；接在「准备发布」后面不用填"}},
		Outputs: releaseOut},
	NodeProtoSyncRange: {Effect: plugin.SOPEffectWrite, DryRun: "不建同步记录、不取 diff，列出项目和同步记录；sync 为占位", Label: "取同步范围", Desc: "取项目上次同步点到生产分支 HEAD 的代码 diff（首次同步对比整个代码库），判断有没有涉及界面或接口的改动",
		Params: []sp{{Key: "project", Label: "项目", Template: true, Default: "{{project_id}}", Source: "projects"},
			{Key: "sync", Label: "同步", Template: true, Default: "{{sync_id}}", Desc: "项目插件发起时带的同步记录 id；没有就新建一次"},
			{Key: "trigger", Label: "发起原因", Template: true, Default: "{{trigger}}"}},
		Outputs: syncOut},
	NodeProtoSyncBranch:   {Effect: plugin.SOPEffectWrite, DryRun: "不拉分支、不建 worktree，列出同步记录；sync 为占位", Label: "准备原型同步分支", Desc: "在原型库拉 proto-sync/<日期> 分支的独立 worktree，不切换、不改原型库主目录", Params: []sp{syncParam}, Outputs: syncOut},
	NodeProtoSyncClassify: {Effect: plugin.SOPEffectWrite, DryRun: "不登记差异，列出同步记录和结论字段；sync 为占位", Label: "登记差异", Desc: "读 Claude Code 回报的 result.items，按五类登记；有不确定项时等产品裁决", Params: []sp{syncParam, {Key: "result", Label: "结论字段", Default: "result", Desc: "字段路径"}}, Outputs: syncOut},
	NodeProtoSyncVerdict: {Effect: plugin.SOPEffectWrite, DryRun: "不记裁决、不建修复任务，列出裁决；sync 为占位", Label: "记裁决", Desc: "把还没裁决的不确定项记成这次的裁决",
		Params:  []sp{{Key: "decision", Label: "裁决", Required: true, Template: true, Options: opt("design", "当作新设计", "defect", "当作缺陷（建修复任务）", "ignore", "暂不处理")}, syncParam},
		Outputs: syncOut},
	NodeProtoSyncCommit: {Effect: plugin.SOPEffectWrite, DryRun: "不提交，列出同步记录；sync 为占位", Label: "提交同步分支", Desc: "把同步分支 worktree 里没提交的改动提交到 proto-sync/ 分支；不推送、不合并", Params: []sp{syncParam}, Outputs: syncOut},
	NodeProtoSyncRecord: {Effect: plugin.SOPEffectWrite, DryRun: "不记同步点、不删 worktree，列出同步记录和结果；sync 为占位", Label: "记同步点", Desc: "把这次的代码 HEAD 记成同步点；删掉 worktree，分支保留",
		Params:  []sp{syncParam, {Key: "outcome", Label: "结果", Template: true, Options: opt("", "按有没有改动定", "no_change", "没有涉及界面或接口的改动")}},
		Outputs: syncOut},
	NodeKBSync: {Effect: plugin.SOPEffectWrite, DryRun: "不建知识库、不改知识库、不发通知，列出要同步的项目和来源开关；kb_sync 为占位",
		Label: "项目资料同步到知识库",
		Desc:  "把项目资料（本机文件和文件夹、笔记、链接的标题和备注、关联的工作台文档、文档目录）同步进项目知识库：新增的加进去，内容变了的重新索引，资料删了的移出，只动本节点加进来的；没有知识库的按「<项目名> 项目知识库」新建并绑定",
		Params: []sp{{Key: "project", Label: "项目", Template: true, Source: "projects", Default: kbAll, Desc: "项目 id、编号或名字，比如 {{project.id}}；留空或填「全部」是所有没归档的项目"},
			yesNoParam("files", "收本机文件和文件夹", "项目资料里的文件、文件夹：只收 md、markdown、txt、text，单个文件超过 1MB 跳过"),
			yesNoParam("notes", "收笔记", "项目资料里的笔记，作为文本"),
			yesNoParam("links", "收链接", "只收标题和备注（分类、标签），不抓网页正文"),
			yesNoParam("docs", "收关联的文档", "挂在这个项目下的工作台文档"),
			yesNoParam("docs_dir", "收文档目录", "项目设置里的文档目录，规则同本机文件夹"),
			{Key: "notify", Label: "通知我", Template: true, Options: opt("", "不通知", "changed", "有新增、更新、移除或失败时通知", "always", "每次都通知"), Desc: "发一条平台通知，内容同 kb_sync.text"}},
		Outputs: []so{{Path: "kb_sync", Type: "object", Label: "这次同步"},
			{Path: "kb_sync.projects", Type: "list", Label: "每个项目 {project_id, name, ref, kb_id, kb_name, created, added, updated, removed, unchanged, skipped, failed, failures, skips, sources, error, at}；failures、skips 是 [{title, ref, reason}]"},
			{Path: "kb_sync.totals", Type: "object", Label: "汇总 {projects, added, updated, removed, unchanged, skipped, failed, errors, created}"},
			{Path: "kb_sync.totals.added", Type: "number", Label: "新增的篇数"}, {Path: "kb_sync.totals.updated", Type: "number", Label: "更新的篇数"},
			{Path: "kb_sync.totals.removed", Type: "number", Label: "移除的篇数"}, {Path: "kb_sync.totals.failed", Type: "number", Label: "失败的条数"},
			{Path: "kb_sync.totals.skipped", Type: "number", Label: "跳过的条数"}, {Path: "kb_sync.totals.errors", Type: "number", Label: "整个没同步成的项目数"},
			{Path: "kb_sync.text", Type: "string", Label: "给通知用的几行：汇总加每个项目一行，失败的列原因"},
			{Path: "kb_sync.ok", Type: "bool", Label: "都成了（没有失败、没有没同步成的项目）", Values: opt("true", "都成了", "false", "有失败")},
			{Path: "kb_sync.changed", Type: "bool", Label: "有新增、更新、移除或失败", Values: opt("true", "有", "false", "没有")},
			{Path: "kb_sync.notified", Type: "bool", Label: "发了通知"}}},
}

// yesNoParam 是「收不收这类来源」的开关，留空按收。
func yesNoParam(key, label, desc string) sp {
	return sp{Key: key, Label: label, Template: true, Default: "yes", Options: opt("yes", "收", "no", "不收"), Desc: desc}
}

var releaseOut = []so{{Path: "release", Type: "object", Label: "发布"}, okOut("release", "这一段成功（准备发布：已打包等审批；上线：已上线）"),
	{Path: "release.id", Type: "string", Label: "发布 id"}, {Path: "release.status", Type: "string", Label: "发布状态"},
	{Path: "release.phase", Type: "string", Label: "阶段", Values: opt("prepare", "准备", "deploy", "上线")},
	{Path: "release.version", Type: "string", Label: "版本号"}, {Path: "release.changelog", Type: "string", Label: "更新日志"},
	{Path: "release.rollback", Type: "string", Label: "回滚情况", Values: opt("", "没回滚", "done", "已回滚", "failed", "回滚失败", "unavailable", "没有回滚命令")},
	{Path: "release.rolled_back", Type: "bool", Label: "回滚成功了"},
	{Path: "release.failed_step", Type: "string", Label: "没过的子步骤"}, {Path: "release.error", Type: "string", Label: "没成的原因"},
	{Path: "release.text", Type: "string", Label: "给通知用的一句话"}, {Path: "release.report_url", Type: "string", Label: "发布报告链接"},
	{Path: "release.task_id", Type: "string", Label: "任务 id"}, {Path: "release.task_ref", Type: "string", Label: "任务编号"}, stepsOut("release")}
