package sop

import (
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 节点和触发方式的声明（TSK-0490）：每种节点认哪些配置（含义、可选值、能不能写 {{字段}}、默认值）、往输出里加哪些字段；
// 每种触发方式自动带进输入的字段。保存校验（check.go）、编辑器的「这一步能拿到的字段」（fields.go，POST /api/sop/step-fields）、
// GET /api/sop/node-types、AI 协助（assist.go）和 Agent 的节点目录（launch.go 的 SOPGuide）都读这一份。
// 插件节点的声明随 SOPNodeDef.Spec 登记（plugin/sopnode.go）。改节点的配置或输出时这里一起改，spec_test.go 盯着内置节点都有声明。

type (
	Param  = plugin.SOPParam
	Option = plugin.SOPOption
	Output = plugin.SOPOutput
)

// 配置项要现取的选项（Param.Source），前端按它取列表；AI 协助和 Agent 拿到的是这几个说明。
const (
	srcAgents     = "agents"         // Agent（设置 / Agent）
	srcProviders  = "providers"      // 模型服务商
	srcModels     = "models"         // 所选服务商的模型
	srcKBs        = "kbs"            // 知识库，多选，存逗号隔开的 id
	srcProjects   = "projects"       // 项目（也认 {{project_id}} 这类字段）
	srcDocCats    = "doc_categories" // 文档分类
	srcFlows      = "flows"          // 别的 SOP 流程
	srcPresets    = "presets"        // Claude Code 角色（设置里的角色）
	srcUpstream   = "upstream_steps" // 本步上游的步骤 key
	srcConvs      = "conversations"  // IM 会话（内核会话 id，cv_ 开头）
	srcTaskStages = "task_stages"    // 任务阶段（看板列）
)

func opts(pairs ...string) []Option {
	out := make([]Option, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, Option{Value: pairs[i], Label: pairs[i+1]})
	}
	return out
}

var (
	agentParam = Param{Key: "agent", Label: "Agent", Source: srcAgents,
		Desc: "用这个 Agent 的模型、思考和指令；不选按场景默认"}
	timeoutParam = Param{Key: "timeout", Label: "超时", Default: "2 小时",
		Desc: "写成「30 分钟」「2 小时」，最多 24 小时；到点取消这次执行、这一步失败"}
	presetParam = Param{Key: "preset", Label: "角色", Source: srcPresets,
		Desc: "Claude Code 角色：执行要求和输出要求拼进提示词"}
	claudeOutputs = []Output{
		{Path: "status", Type: "string", Label: "执行结果", Values: opts("done", "成功", "failed", "失败（只有失败时继续往下走才会出现）")},
		{Path: "summary", Type: "string", Label: "Claude Code 回报的摘要"},
		{Path: "result", Type: "object", Open: true, Label: "回报的结构化结论（没回报为 null），约定有 verdict: pass / reject，别的键按提示词约定", Example: `{"verdict":"pass"}`},
		{Path: "result.verdict", Type: "string", Label: "结论", Values: opts("pass", "通过", "reject", "退回")},
		{Path: "run_id", Type: "string", Label: "这次执行的 id"},
	}
	taskObj = func(label string) []Output {
		return []Output{
			{Path: "task", Type: "object", Label: label},
			{Path: "task.id", Type: "string", Label: "任务 id", Example: "obj_06gt…"},
			{Path: "task.ref", Type: "string", Label: "任务编号", Example: "TSK-0001"},
			{Path: "task.title", Type: "string", Label: "标题"},
			{Path: "task.status", Type: "string", Label: "状态", Values: taskStatuses},
			{Path: "task.project_id", Type: "string", Label: "所属项目 id，没有为空"},
			{Path: "task.project", Type: "string", Label: "所属项目名"},
			{Path: "task.assignee", Type: "string", Label: "负责人名字"},
		}
	}
	taskStatuses = opts("todo", "未开工", "doing", "进行中", "review", "待验收", "blocked", "受阻", "done", "已完成", "cancelled", "已取消")
)

// builtinSpecs 是内置节点的声明，按 kind。
var builtinSpecs = map[string]plugin.SOPNodeSpec{
	"auto": {Label: "自动执行", Desc: "只把输入原样传下去、记一行日志，不做任何写操作；要改数据（标记消息、建任务、写文档……）用对应的写节点",
		Params: []Param{}, Outputs: []Output{}},
	"ai": {Label: "AI 处理", Desc: "按步骤说明（desc，可写 {{字段}}）让模型处理输入，结果写进输出字段",
		Params: []Param{agentParam,
			{Key: "provider", Label: "服务商", Source: srcProviders, Desc: "不选用默认服务商；选了 Agent 时不看"},
			{Key: "model", Label: "模型", Source: srcModels, Desc: "不选用服务商设置的模型"},
			{Key: "output", Label: "输出字段名", Default: "result", Desc: "模型的回答写进输出的这个字段"}},
		Outputs: []Output{{Path: "{output}", Type: "string", Label: "模型的回答（文字）"}}},
	"knowledge": {Label: "知识检索", Desc: "在知识库里按问题找相关段落",
		Params: []Param{
			{Key: "query", Label: "检索问题", Required: true, Template: true},
			{Key: "kbs", Label: "检索哪些知识库", Source: srcKBs, Desc: "逗号隔开的知识库 id；不选执行时失败"},
			{Key: "top_k", Label: "最多返回", Default: "3", Desc: "整数"}},
		Outputs: []Output{
			{Path: "query", Type: "string", Label: "渲染后的检索问题"},
			{Path: "matches", Type: "list", Label: "命中的段落，每项 kb_id、doc_id、title、index、score、snippet"}}},
	"extract": {Label: "参数提取", Desc: "让模型从一段文字里抽出指定字段，写进 extracted",
		Params: []Param{
			{Key: "fields", Label: "要提取的字段", Required: true, Desc: "逗号或顿号隔开，每个字段在输出里是 extracted.<字段>"},
			{Key: "from", Label: "从哪个字段里提", Desc: "字段路径；留空自动找最长的那段文字"},
			agentParam},
		Outputs: []Output{{Path: "extracted", Type: "object", Label: "提取结果，每个配置的字段一项（没提到为空串）"}}},
	"template": {Label: "模板转换", Desc: "用 {{字段}} 把输入拼成一段固定格式的文字",
		Params: []Param{
			{Key: "template", Label: "模板", Required: true, Template: true},
			{Key: "output", Label: "输出字段名", Default: "text"}},
		Outputs: []Output{{Path: "{output}", Type: "string", Label: "拼好的文字"}}},
	"aggregate": {Label: "变量聚合", Desc: "把几路上游（并行或分支）的输出合成一份",
		Params: []Param{{Key: "mode", Label: "合并方式", Default: "merge",
			Options: opts("merge", "字段合并（后面的覆盖前面的）", "group", "按上游分组保留（输出是 {上游 key: 输出}）", "first", "取第一个有值的")}},
		Outputs: []Output{}},
	"code": {Label: "代码执行", Desc: "写一段代码处理输入（后端暂不执行，执行到这一步会失败）",
		Params: []Param{
			{Key: "language", Label: "语言", Default: "javascript", Options: opts("javascript", "JavaScript", "python", "Python")},
			{Key: "code", Label: "代码", Required: true}},
		Outputs: []Output{}},
	"decide": {Label: "条件分支", Desc: "按条件（步骤上的 cond：字段 + 运算符 + 值，可多条且/或）选分支，成立走第一个出口、不成立走第二个；没有条件就是人工判断，停下等人选",
		Params: []Param{}, Outputs: []Output{}},
	"classifier": {Label: "问题分类器", Desc: "让模型判断输入属于哪一类（cases 的名称就是类别），每一类一个出口",
		Params: []Param{
			{Key: "from", Label: "要分类的字段", Desc: "字段路径；留空自动找最长的那段文字"},
			{Key: "hint", Label: "分类说明", Desc: "每一类的判断依据"},
			agentParam},
		Outputs: []Output{}},
	"iterate": {Label: "迭代", Desc: "对一个列表里的每一项让模型做同样的事",
		Params: []Param{
			{Key: "list", Label: "列表字段", Required: true, Desc: "输入里哪个字段是列表（字段路径）"},
			{Key: "action", Label: "每一项做什么", Required: true},
			agentParam},
		Outputs: []Output{{Path: "results", Type: "list", Label: "每项 {item, result}"}}},
	"wait": {Label: "等待", Desc: "停一段时间再往下走",
		Params:  []Param{{Key: "duration", Label: "等多久", Default: "1 小时", Desc: "「30 分钟」「1 小时」「1 天」，也认 90s、1h30m"}},
		Outputs: []Output{{Path: "waited", Type: "string", Label: "等了多久（配置原文）"}}},
	loopbackKind: {Label: "条件回退", Desc: "条件（cond，写法同条件分支）成立就自动退回上游重做，超过轮次上限走「超限」；不成立走「通过」",
		Params: []Param{
			{Key: "target", Label: "退回到哪一步", Required: true, Source: srcUpstream, Desc: "上游步骤的 key"},
			{Key: "max_rounds", Label: "最多退回几轮", Default: "3", Desc: "1 到 10 的整数"}},
		Outputs: []Output{}},
	"review": {Label: "人工检查", Desc: "停下来让人看输出，可改了再放行",
		Params:  []Param{{Key: "assignee", Label: "谁来检查", Default: "我"}},
		Outputs: []Output{}},
	"http": {Label: "HTTP 请求", Desc: "调用外部系统的接口，响应写进 http",
		Params: []Param{
			{Key: "method", Label: "方法", Default: "POST", Options: opts("GET", "GET", "POST", "POST", "PUT", "PUT", "PATCH", "PATCH", "DELETE", "DELETE")},
			{Key: "url", Label: "地址", Required: true, Template: true},
			{Key: "headers", Label: "请求头", Template: true, Desc: "一行一个「名字: 值」"},
			{Key: "body", Label: "请求体", Template: true}},
		Outputs: []Output{
			{Path: "http", Type: "object", Label: "响应"},
			{Path: "http.status", Type: "number", Label: "HTTP 状态码（4xx、5xx 时这一步失败）"},
			{Path: "http.body", Type: "any", Label: "响应体：JSON 时是解析后的对象，否则是文字"},
			{Path: "http.method", Type: "string", Label: "请求方法"},
			{Path: "http.url", Type: "string", Label: "请求地址（去掉了凭证）"},
			{Path: "http.truncated", Type: "bool", Label: "响应超过 64KB 被截断时为 true"}}},
	"notify": {Label: "发送消息", Desc: "原型的发消息节点，正式产品由 IM 插件的 im_send_message 代替，执行到这一步会失败",
		Params: []Param{
			{Key: "to", Label: "发给", Required: true, Template: true},
			{Key: "content", Label: "内容", Required: true, Template: true}},
		Outputs: []Output{}},
	"task": {Label: "创建任务", Desc: "在「任务」里建一条；输入有 message_id 且这条消息已经建过任务时取回那条",
		Params: []Param{
			{Key: "title", Label: "标题", Required: true, Template: true},
			{Key: "priority", Label: "优先级", Default: "P2", Options: opts("P0", "P0", "P1", "P1", "P2", "P2", "P3", "P3")},
			{Key: "assignee", Label: "负责人", Default: "我", Template: true, Desc: "联系人 id 或名字，「我」不指派"},
			{Key: "project", Label: "所属项目", Template: true, Source: srcProjects, Desc: "项目 id、编号或名字；认不出时这一步失败"},
			{Key: "body", Label: "正文", Template: true}},
		Outputs: append(taskObj("建好（或取回）的任务"),
			Output{Path: "task.priority", Type: "string", Label: "优先级"},
			Output{Path: "task.reused", Type: "bool", Label: "这条消息已经建过任务、取回了那条时为 true"})},
	"doc": {Label: "写文档", Desc: "新建一篇文档，或把内容追加到已有文档末尾",
		Params: []Param{
			{Key: "mode", Label: "方式", Default: "new", Options: opts("new", "新建文档", "append", "追加到已有文档")},
			{Key: "title", Label: "标题", Template: true, Desc: "新建时用；留空用「流程名 · 步骤名」"},
			{Key: "doc", Label: "追加到哪篇文档", Template: true, Desc: "文档 id，追加时用"},
			{Key: "category", Label: "文档分类", Source: srcDocCats},
			{Key: "content", Label: "正文", Template: true, Desc: "留空时写入输入的 JSON"}},
		Outputs: []Output{
			{Path: "content_id", Type: "string", Label: "文档 id"},
			{Path: "doc", Type: "object", Label: "文档"},
			{Path: "doc.id", Type: "string", Label: "文档 id"},
			{Path: "doc.ref", Type: "string", Label: "文档编号"},
			{Path: "doc.title", Type: "string", Label: "标题"},
			{Path: "doc.mode", Type: "string", Label: "方式", Values: opts("new", "新建", "append", "追加")}}},
	"contact": {Label: "写联系人", Desc: "新建联系人，或把字段合并到已有联系人；配置留空时取输入里同名的字段",
		Params: []Param{
			{Key: "mode", Label: "方式", Default: "new", Options: opts("new", "新建联系人", "merge", "合并到已有联系人")},
			{Key: "id", Label: "合并到哪个联系人", Template: true, Desc: "联系人 id，留空取输入的 contact_id"},
			{Key: "name", Label: "姓名", Template: true}, {Key: "company", Label: "公司", Template: true},
			{Key: "title", Label: "职位", Template: true}, {Key: "phone", Label: "电话", Template: true},
			{Key: "email", Label: "邮箱", Template: true}, {Key: "group", Label: "分组", Template: true},
			{Key: "note", Label: "备注", Template: true}},
		Outputs: []Output{
			{Path: "contact_id", Type: "string", Label: "联系人 id"},
			{Path: "contact", Type: "object", Label: "联系人 {id, name, mode, fields}"},
			{Path: "contact.id", Type: "string", Label: "联系人 id"},
			{Path: "contact.name", Type: "string", Label: "姓名"}}},
	"local_append": {Label: "写进项目目录", Desc: "把一段文字写进项目关联的本地目录，文件已有就追加",
		Params: []Param{
			{Key: "project", Label: "项目", Required: true, Template: true, Source: srcProjects},
			{Key: "dir", Label: "写进哪个目录", Desc: "第几个（从 1 起）或目录名称；留空是第一个关联目录"},
			{Key: "path", Label: "文件路径", Required: true, Template: true, Desc: "项目目录下的相对路径，不能有 ..；另认 {{date}}"},
			{Key: "content", Label: "内容", Required: true, Template: true}},
		Outputs: []Output{
			{Path: "file", Type: "object", Label: "写入的文件 {path, rel, dir, dir_label, project, bytes, created}"},
			{Path: "file.path", Type: "string", Label: "绝对路径"},
			{Path: "file.created", Type: "bool", Label: "这次新建了文件"}}},
	"agent": {Label: "调用 Agent", Desc: "把这一步交给一个 Agent，按它的权限做事；它要调需确认的工具时停下等你确认",
		Params: []Param{
			{Key: "agent", Label: "Agent", Required: true, Source: srcAgents},
			{Key: "prompt", Label: "交代给它的事", Template: true, Desc: "留空用步骤说明"}},
		Outputs: []Output{
			{Path: "agent", Type: "object", Label: "会话 {session_id, message_id, agent_id, name, status}"},
			{Path: "agent_reply", Type: "string", Label: "Agent 的回复"}}},
	"subflow": {Label: "子流程", Desc: "在这里执行另一个 SOP，跑完再回来；子流程的输入是这一步的输入",
		Params: []Param{{Key: "sop", Label: "执行哪个 SOP", Required: true, Source: srcFlows}},
		Outputs: []Output{
			{Path: "subflow", Type: "object", Label: "子执行 {run_id, flow_id, sop, status, output}"},
			{Path: "subflow.output", Type: "object", Label: "子流程的结果（最后几步的输出）"}}},
	claudeKind: {Label: "Claude Code 执行", Desc: "交给本机 Claude Code 在指定目录里做一件事，等它做完把结论交给下游",
		Params: []Param{presetParam,
			{Key: "workdir", Label: "工作目录", Required: true, Template: true, Desc: "本机绝对路径"},
			{Key: "prompt", Label: "提示词", Required: true, Template: true},
			{Key: "task", Label: "关联任务", Template: true, Desc: "任务 id，填了在任务上留执行记录"},
			{Key: "permission", Label: "权限", Options: opts("", "按角色（没选角色就只读）", "read", "只读", "write", "可写")},
			timeoutParam},
		Outputs: claudeOutputs},
	taskRunKind: {Label: "执行任务", Desc: "把一条任务交给本机 Claude Code 去做：工作目录按任务、所属项目继承，等它做完",
		Params: []Param{
			{Key: "task", Label: "任务", Template: true, Default: "{{task.id}}", Desc: "任务 id 或编号；留空取输入的 task.id，再取 task_id"},
			{Key: "prompt", Label: "附加要求", Template: true},
			presetParam, timeoutParam,
			{Key: "on_fail", Label: "失败时", Options: opts("", "这一步失败（停下）", "stop", "这一步失败（停下）", "continue", "继续往下走，输出 status=failed 和 error")}},
		Outputs: append(append([]Output{}, claudeOutputs...),
			Output{Path: "error", Type: "string", Label: "失败原因（失败时继续往下走才有）"})},
	taskUpdateKind: {Label: "更新任务", Desc: "改已有任务的负责人、状态；都不填只读取任务（含继承后的工作目录）",
		Params: []Param{
			{Key: "task", Label: "任务", Template: true, Desc: "任务 id 或编号；留空取输入的 task.id，再取 task_id"},
			{Key: "assignee", Label: "负责人", Template: true, Desc: "联系人 id 或名字"},
			{Key: "status", Label: "状态", Template: true, Options: append(opts("", "不改"), taskStatuses...)}},
		Outputs: append(taskObj("任务（改完之后）"),
			Output{Path: "task.owner_id", Type: "string", Label: "负责人联系人 id"},
			Output{Path: "task.workdir", Type: "string", Label: "继承后的工作目录"},
			Output{Path: "task.assign_ok", Type: "string", Label: "负责人改成了没有", Values: opts("yes", "改了", "no", "名册里没有这个人，没改", "", "没要求改")},
			Output{Path: "task.assign_note", Type: "string", Label: "没改成时的提示"},
			Output{Path: "task.changed", Type: "bool", Label: "这次改了东西"})},
	"end": {Label: "结束", Desc: "流程到这里结束，挑出要留下的结果",
		Params:  []Param{{Key: "outputs", Label: "保留哪些字段", Desc: "逗号隔开的字段路径；留空保留全部"}},
		Outputs: []Output{}},
}

func init() {
	for i := range NodeTypes {
		sp := builtinSpecs[NodeTypes[i].Kind]
		NodeTypes[i].Label, NodeTypes[i].Desc = sp.Label, sp.Desc
		NodeTypes[i].Params, NodeTypes[i].Outputs = sp.Params, sp.Outputs
		if kindLabels[NodeTypes[i].Kind] == "" {
			kindLabels[NodeTypes[i].Kind] = sp.Label
		}
	}
}

// Trigger 是一种触发方式和它自动带进输入的字段（TSK-0490，GET /api/sop/triggers）。
type Trigger struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Desc  string `json:"desc"`
	// Outputs 是发起时自动带进输入的字段；输入字段（fields）里同名的由它补上，不用人填
	Outputs []Output `json:"outputs"`
	// Auto 是不经人手发起（IM、定时），必填又没有默认值、也不是自动带入的输入字段会让每次自动发起都失败或被跳过
	Auto bool `json:"auto"`
}

// imRelevanceValues 是 IM 触发 relevance 的取值。
var imRelevanceValues = opts("me", "@我", "all", "@所有人", "dm", "私聊", "", "无关（空串）")

// Triggers 是能选的触发方式，顺序同编辑器。
var Triggers = []Trigger{
	{Key: "manual", Label: "手动", Desc: "在流程页、任务详情手动发起，或由 Agent 的 run_sop、别的流程的子流程节点发起；输入由发起方填", Outputs: []Output{}},
	{Key: imTrigger, Label: "IM 消息", Auto: true,
		Desc: "来一条 IM 消息自动发起一次（先过开始节点上的会话、与我的关系过滤，按执行顺序，拦截流程命中后后面的不再发起）。正文不在输入里，用 im_get_message 按 message_id 取",
		Outputs: []Output{
			{Path: "message_id", Type: "string", Label: "消息 id", Example: "imm_06gt…"},
			{Path: "channel", Type: "string", Label: "渠道", Values: opts("slack", "Slack", "telegram", "Telegram")},
			{Path: "connector_id", Type: "string", Label: "收到这条消息的连接器 id"},
			{Path: "conversation_id", Type: "string", Label: "会话 id（内核会话 id，cv_ 开头）", Example: "cv_06gsnrd375m90zt0"},
			{Path: "stakeholder_id", Type: "string", Label: "发信人对应的联系人 id，认不出为空"},
			{Path: "relevance", Type: "string", Label: "和我的关系", Values: imRelevanceValues},
			{Path: "at", Type: "string", Label: "发送时间（RFC 3339）"},
		}},
	{Key: triggerSchedule, Label: "定时", Auto: true,
		Desc:    "按开始节点上的时间规则到点发起；不带任何字段，输入全用输入字段的默认值",
		Outputs: []Output{}},
}

func triggerOf(key string) (Trigger, bool) {
	for _, t := range Triggers {
		if t.Key == key {
			return t, true
		}
	}
	return Trigger{}, false
}
