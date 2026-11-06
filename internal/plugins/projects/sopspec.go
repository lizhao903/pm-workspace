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
	NodeListProfiles: {Label: "列项目档案", Desc: "取建过档案的项目摘要（简介、关键词、平台），给模型判断归属项目用",
		Params: []sp{},
		Outputs: []so{{Path: "profiles", Type: "list", Label: "项目 {project_id, name, ref, intro, keywords, platforms, dirs_ready}"},
			{Path: "profiles_text", Type: "string", Label: "给模型看的项目清单，一行一个"}}},
	NodeGetProfile: {Label: "读项目档案", Desc: "读一个项目的档案；profile.dirs 是代码库、原型库、PRD 目录（没设的依次回退）",
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
	NodePrepareWorktree: {Label: "准备工作区", Desc: "给任务在项目代码库建独立的 worktree 和分支 auto/<任务编号>，分一段端口；下游 Claude Code 的工作目录填 {{worktree.path}}",
		Params: []sp{taskKey},
		Outputs: []so{{Path: "worktree", Type: "object", Label: "工作区"},
			{Path: "worktree.path", Type: "string", Label: "worktree 目录"}, {Path: "worktree.branch", Type: "string", Label: "分支"},
			{Path: "worktree.root", Type: "string", Label: "代码库根目录"}, {Path: "worktree.base_commit", Type: "string", Label: "起点提交"},
			{Path: "worktree.port_start", Type: "number", Label: "分到的端口起点"}, {Path: "worktree.port_end", Type: "number", Label: "端口终点"},
			{Path: "worktree.reused", Type: "bool", Label: "沿用了已有的工作区"},
			{Path: "worktree.task_id", Type: "string", Label: "任务 id"}, {Path: "worktree.task_ref", Type: "string", Label: "任务编号"}}},
	NodeRunTest: {Label: "跑测试", Desc: "在任务的工作区上按项目档案构建、起临时测试环境、跑测试和冒烟，写测试报告登记为任务产出；下游条件分支判断 test.ok",
		Params: []sp{taskKey, {Key: "keep_env", Label: "保留测试环境", Template: true, Desc: "留空不保留；「是」按设置里的时长保留，也可以写「24 小时」「2 天」"}},
		Outputs: []so{{Path: "test", Type: "object", Label: "测试结果"}, okOut("test", "全部通过"),
			{Path: "test.status", Type: "string", Label: "测试状态"}, {Path: "test.id", Type: "string", Label: "测试记录 id"},
			{Path: "test.error", Type: "string", Label: "没通过的原因"}, {Path: "test.failed_step", Type: "string", Label: "没通过的子步骤"},
			{Path: "test.report_url", Type: "string", Label: "测试报告链接"}, {Path: "test.url", Type: "string", Label: "测试环境地址"},
			{Path: "test.env_text", Type: "string", Label: "测试环境的一句话（地址、保留到什么时候）"},
			{Path: "test.env_kept", Type: "bool", Label: "测试环境保留了"}, stepsOut("test"),
			{Path: "test.junit", Type: "object", Label: "JUnit 汇总 {files, tests, failures, errors, skipped, failed}"}}},
	NodePrepareRelease: {Label: "准备发布", Desc: "在任务的工作区上按项目档案跑版本号与更新日志、打包，不碰生产；跑完停在等审批。下游条件分支判断 release.ok",
		Params:  []sp{taskKey},
		Outputs: releaseOut},
	NodeRelease: {Label: "上线", Desc: "放在人工审批之后：发布前检查、发布、线上冒烟，发布或冒烟没过自动回滚。只认准备好、等审批的发布",
		Params:  []sp{{Key: "release", Label: "发布", Template: true, Default: "{{release.id}}", Desc: "发布 id；接在「准备发布」后面不用填"}},
		Outputs: releaseOut},
	NodeProtoSyncRange: {Label: "取同步范围", Desc: "取项目上次同步点到生产分支 HEAD 的代码 diff（首次同步对比整个代码库），判断有没有涉及界面或接口的改动",
		Params: []sp{{Key: "project", Label: "项目", Template: true, Default: "{{project_id}}", Source: "projects"},
			{Key: "sync", Label: "同步", Template: true, Default: "{{sync_id}}", Desc: "项目插件发起时带的同步记录 id；没有就新建一次"},
			{Key: "trigger", Label: "发起原因", Template: true, Default: "{{trigger}}"}},
		Outputs: syncOut},
	NodeProtoSyncBranch:   {Label: "准备原型同步分支", Desc: "在原型库拉 proto-sync/<日期> 分支的独立 worktree，不切换、不改原型库主目录", Params: []sp{syncParam}, Outputs: syncOut},
	NodeProtoSyncClassify: {Label: "登记差异", Desc: "读 Claude Code 回报的 result.items，按五类登记；有不确定项时等产品裁决", Params: []sp{syncParam, {Key: "result", Label: "结论字段", Default: "result", Desc: "字段路径"}}, Outputs: syncOut},
	NodeProtoSyncVerdict: {Label: "记裁决", Desc: "把还没裁决的不确定项记成这次的裁决",
		Params:  []sp{{Key: "decision", Label: "裁决", Required: true, Template: true, Options: opt("design", "当作新设计", "defect", "当作缺陷（建修复任务）", "ignore", "暂不处理")}, syncParam},
		Outputs: syncOut},
	NodeProtoSyncCommit: {Label: "提交同步分支", Desc: "把同步分支 worktree 里没提交的改动提交到 proto-sync/ 分支；不推送、不合并", Params: []sp{syncParam}, Outputs: syncOut},
	NodeProtoSyncRecord: {Label: "记同步点", Desc: "把这次的代码 HEAD 记成同步点；删掉 worktree，分支保留",
		Params:  []sp{syncParam, {Key: "outcome", Label: "结果", Template: true, Options: opt("", "按有没有改动定", "no_change", "没有涉及界面或接口的改动")}},
		Outputs: syncOut},
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
