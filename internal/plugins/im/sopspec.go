// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

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
	msgParam = func(desc string) sp {
		return sp{Key: "message", Label: "消息", Template: true, Default: "{{message_id}}", Desc: desc}
	}
	textParam     = sp{Key: "text", Label: "内容", Required: true, Template: true}
	taskParam     = sp{Key: "task", Label: "任务", Template: true, Default: "{{task.id}}", Desc: "任务 id，留空用输入里的 task.id"}
	channelParam  = sp{Key: "channel", Label: "渠道", Options: opt("", "Slack（默认）", "slack", "Slack", "telegram", "Telegram")}
	connParam     = sp{Key: "connector", Label: "连接器", Desc: "连接器 id；留空用这个渠道最新建的、能发消息的那个"}
	relLabels     = opt("@我", "@我", "@所有人", "@所有人", "私聊", "私聊", "无关", "无关")
	taskOutFields = []so{
		{Path: "task", Type: "object", Label: "任务 {id, ref, title, status, stage, project_id, url}"},
		{Path: "task.id", Type: "string", Label: "任务 id"},
		{Path: "task.ref", Type: "string", Label: "任务编号", Example: "TSK-0001"},
		{Path: "task.title", Type: "string", Label: "标题"},
		{Path: "task.status", Type: "string", Label: "状态（todo、doing、review、blocked、done、cancelled）"},
		{Path: "task.stage", Type: "string", Label: "看板阶段 key"},
		{Path: "task.project_id", Type: "string", Label: "所属项目 id，没有为空"},
		{Path: "task.url", Type: "string", Label: "看板链接"},
	}
)

var sopSpecs = map[string]plugin.SOPNodeSpec{
	NodeSendMessage: {Effect: plugin.SOPEffectWrite, DryRun: "不发消息，列出会话和内容（渲染后）；sent 为占位", Label: "发消息", Desc: "往指定会话发一条消息（只能发到收发双向的连接器），发出后记审计",
		Params: []sp{{Key: "conversation", Label: "会话", Required: true, Template: true, Source: "conversations", Desc: "内核会话 id（cv_ 开头）"}, textParam},
		Outputs: []so{{Path: "sent", Type: "object", Label: "发出的消息 {conversation_id, conversation, channel, connector_id, text, external_id, at}"},
			{Path: "sent.external_id", Type: "string", Label: "渠道里的消息编号"}}},
	NodeWaitReply: {Effect: plugin.SOPEffectWait, Label: "等待回复", Desc: "等这个会话里对方的下一条消息，超时这一步失败",
		Params: []sp{{Key: "conversation", Label: "会话", Required: true, Template: true, Source: "conversations"},
			{Key: "timeout", Label: "超时", Default: "1 小时", Desc: "最多 30 天；也认 90s、1h30m"}},
		Outputs: []so{{Path: "reply", Type: "object", Label: "对方的回复"},
			{Path: "reply.text", Type: "string", Label: "回复正文"},
			{Path: "reply.message_id", Type: "string", Label: "回复的消息 id"},
			{Path: "reply.sender_name", Type: "string", Label: "发信人在渠道里的名字"},
			{Path: "reply.contact_name", Type: "string", Label: "认上的联系人名，没认上为空"},
			{Path: "reply.at", Type: "string", Label: "发送时间"}}},
	NodeGetMessage: {Effect: plugin.SOPEffectRead, Label: "读取消息", Desc: "取出这条消息的正文、发信人、会话、和我的关系、归到的项目，交给后面的步骤",
		Params: []sp{msgParam("消息 id；IM 触发的流程输入里就有 message_id")},
		Outputs: []so{{Path: "message", Type: "object", Label: "消息"},
			{Path: "message.id", Type: "string", Label: "消息 id"},
			{Path: "message.text", Type: "string", Label: "正文"},
			{Path: "message.sender", Type: "string", Label: "发信人（认上联系人时是联系人名）"},
			{Path: "message.sender_name", Type: "string", Label: "发信人在渠道里的名字"},
			{Path: "message.contact_id", Type: "string", Label: "发信人对应的联系人 id，认不出为空"},
			{Path: "message.channel", Type: "string", Label: "渠道", Values: opt("slack", "Slack", "telegram", "Telegram")},
			{Path: "message.conversation", Type: "string", Label: "会话名"},
			{Path: "message.conversation_kind", Type: "string", Label: "会话类型", Values: opt("私聊", "私聊", "群聊", "群聊")},
			{Path: "message.relevance", Type: "string", Label: "和我的关系（中文）", Values: relLabels},
			{Path: "message.status", Type: "string", Label: "消息状态", Values: opt("pending", "待处理", "done", "已处理", "ignored", "已忽略", "expired", "已过期")},
			{Path: "message.at", Type: "string", Label: "发送时间"},
			{Path: "message.project_id", Type: "string", Label: "归到的项目 id（含群组默认项目），没归为空"},
			{Path: "message.project", Type: "string", Label: "归到的项目名"},
			{Path: "message.conversation_id", Type: "string", Label: "会话 id（内核会话 id，cv_ 开头），没认上为空", Example: "cv_06gsnrd375m90zt0"},
			{Path: "message.connector_id", Type: "string", Label: "收到这条消息的连接器 id"},
			{Path: "message.relevance_key", Type: "string", Label: "和我的关系（同 IM 触发的 relevance）", Values: opt("me", "@我", "all", "@所有人", "dm", "私聊", "", "无关")},
			{Path: "message.muted", Type: "object", Label: "入库时被自动忽略的那条 {mute_id, name, active}，没有为 null"},
			{Path: "message.sender_muted", Type: "object", Label: "发信人现在命中的自动忽略 {mute_id, name}，没有为 null"}}},
	NodeMarkMessage: {Effect: plugin.SOPEffectWrite, DryRun: "不改消息状态，列出要标成什么和哪条消息；marked 为占位", Label: "标记消息", Desc: "把消息标成忽略、已处理、已读或改回待处理（同消息页的处理动作）",
		Params: []sp{{Key: "state", Label: "标记为", Required: true, Default: "ignore",
			Options: opt("ignore", "忽略", "done", "已处理", "read", "已读（仍待处理）", "reopen", "改回待处理")},
			msgParam("消息 id；IM 触发的流程输入里就有 message_id")},
		Outputs: []so{{Path: "marked", Type: "object", Label: "{message_id, state, status}"},
			{Path: "marked.state", Type: "string", Label: "标成了什么", Values: opt("ignore", "忽略", "done", "已处理", "read", "已读", "reopen", "改回待处理")},
			{Path: "marked.status", Type: "string", Label: "消息现在的状态"}}},
	NodeSetProject: {Effect: plugin.SOPEffectWrite, DryRun: "不改归属，列出项目和消息；project 为占位", Label: "消息归到项目", Desc: "把消息归到一个项目，项目的沟通里能看到它",
		Params: []sp{{Key: "project", Label: "项目", Required: true, Template: true, Source: "projects", Desc: "项目 id、编号或名字"},
			msgParam("消息 id；留空用输入里的 message_id")},
		Outputs: []so{{Path: "project", Type: "object", Label: "项目 {id, ref, name, message_id}"},
			{Path: "project.id", Type: "string", Label: "项目 id"}, {Path: "project.name", Type: "string", Label: "项目名"}}},
	NodeWaitTask: {Effect: plugin.SOPEffectWait, Label: "等任务完成", Desc: "等任务交给 Claude Code 执行成功结束或被标为已完成",
		Params: []sp{{Key: "task", Label: "任务", Template: true, Default: "{{task_id}}", Desc: "任务 id"},
			{Key: "timeout", Label: "超时", Default: "14 天", Desc: "写法同等待回复"}},
		Outputs: []so{{Path: "task", Type: "object", Label: "任务 {id, ref, title, status, summary, via}"},
			{Path: "task.summary", Type: "string", Label: "执行回报的结论"},
			{Path: "task.via", Type: "string", Label: "怎么算完成的", Values: opt("run", "执行成功结束", "status", "标为已完成")}}},
	NodeReplyMessage: {Effect: plugin.SOPEffectWrite, DryRun: "不回复，列出消息和内容；replied 为占位", Label: "回复原消息", Desc: "在原消息所在的串里回复对方",
		Params:  []sp{msgParam("消息 id；留空用输入里的 message_id"), textParam},
		Outputs: []so{{Path: "replied", Type: "object", Label: "{message_id, reply_id, external_id, text}"}}},
	NodeAskMe: {Effect: plugin.SOPEffectWrite, DryRun: "不私信、不等回复，列出内容；answer.choice 按 execute 往下走", Label: "私信我确认", Desc: "私信我本人一个问题，等我回「执行 / 分配 某人 / 不做」；认不出再问一次，超时提醒一次，仍没有就 choice=none",
		Params: []sp{{Key: "text", Label: "内容", Required: true, Template: true, Desc: "后面自动附上三种回复方式"},
			{Key: "timeout", Label: "每轮等多久", Default: "1 天"}, channelParam, connParam,
			{Key: "to", Label: "发给", Desc: "你在渠道里的编号（Slack Member ID）；留空按连接器认出你本人"}},
		Outputs: []so{{Path: "answer", Type: "object", Label: "我的回答"},
			{Path: "answer.choice", Type: "string", Label: "选了什么", Values: opt("execute", "执行", "assign", "分配给某人", "cancel", "不做", "none", "没认出或超时")},
			{Path: "answer.assignee", Type: "string", Label: "分配给谁（choice=assign 时）"},
			{Path: "answer.text", Type: "string", Label: "回复原文"},
			{Path: "answer.reason", Type: "string", Label: "choice=none 的原因", Values: opt("unknown", "两次都没认出", "timeout", "超时", "", "不是 none")},
			{Path: "answer.reason_text", Type: "string", Label: "给人看的原因"},
			{Path: "answer.asked", Type: "number", Label: "问了几次"},
			{Path: "task.url", Type: "string", Label: "输入里有 task.id 时补上的看板链接"}}},
	NodeTellMe: {Effect: plugin.SOPEffectWrite, DryRun: "不私信，列出内容；told 为占位", Label: "私信我", Desc: "私信我本人一条，不等回复；发不出去这一步失败",
		Params: []sp{textParam, channelParam, connParam,
			{Key: "to", Label: "发给", Desc: "你在渠道里的编号；留空按连接器认出你本人"}},
		Outputs: []so{{Path: "told", Type: "object", Label: "{text, external_id, at}"}, {Path: "task.url", Type: "string", Label: "输入里有 task.id 时补上的看板链接"}}},
	NodeAckTask: {Effect: plugin.SOPEffectWrite, DryRun: "不回执，列出文案；acked.status 为 sent", Label: "回执需求方", Desc: "放在建任务之后：在原消息所在的会话里回复需求方；同一条消息只回一次，回复失败不让流程失败",
		Params: []sp{{Key: "text", Label: "文案", Template: true, Default: "已创建任务 {{task_ref}}，开始进行需求规划",
			Desc: "另认 {{task_ref}}、{{task_title}}、{{task_project}}、{{task_url}}"}, taskParam, msgParam("消息 id；留空用输入里的 message_id，取不到就不回")},
		Outputs: []so{{Path: "acked", Type: "object", Label: "回执结果"},
			{Path: "acked.status", Type: "string", Label: "结果", Values: opt("sent", "回了", "skipped", "没回（见 reason）", "failed", "回复失败")},
			{Path: "acked.reason", Type: "string", Label: "没回的原因 key"}, {Path: "acked.reason_text", Type: "string", Label: "没回的原因"},
			{Path: "acked.task_ref", Type: "string", Label: "任务编号"}}},
	NodeMessageDigest: {Effect: plugin.SOPEffectRead, Label: "整理消息摘要", Desc: "把消息（发信人、会话、时间、原文、附件名）和任务编号、链接整理成文字",
		Params: []sp{{Key: "messages", Label: "消息", Template: true, Desc: "消息 id，可以几条（逗号分隔）；留空用输入里的 message_ids，再没有用 message_id"},
			{Key: "tasks", Label: "任务", Template: true, Desc: "任务 id，可以几条；留空用输入里的 task_ids，再没有用这些消息转成的任务"}},
		Outputs: []so{{Path: "digest", Type: "object", Label: "摘要"},
			{Path: "digest.messages_text", Type: "string", Label: "消息整理成的文字"}, {Path: "digest.tasks_text", Type: "string", Label: "任务一段"},
			{Path: "digest.task_refs", Type: "string", Label: "任务编号，顿号隔开"},
			{Path: "digest.messages", Type: "number", Label: "消息条数"}, {Path: "digest.tasks", Type: "number", Label: "任务条数"}}},
	NodeSendContact: {Effect: plugin.SOPEffectWrite, DryRun: "不私信，列出联系人和内容；sent_to 为占位", Label: "私信联系人", Desc: "按联系人找到他在渠道上的身份，私信一条；没有这个身份或发送失败这一步失败",
		Params: []sp{{Key: "contact", Label: "联系人", Required: true, Template: true, Desc: "联系人名字或 id"},
			{Key: "to", Label: "身份编号", Desc: "联系人在渠道里的编号；留空用他第一个不是你的身份"}, textParam, channelParam, connParam},
		Outputs: []so{{Path: "sent_to", Type: "object", Label: "{contact, to, text, external_id, at}"}}},
	NodeNotify: {Effect: plugin.SOPEffectWrite, DryRun: "不发通知、不回复，列出标题和内容；notified 为占位", Label: "通知", Desc: "发一条平台通知（关联任务）；填了消息且取得到时，同时在原消息所在的串里回复同样的内容",
		Params: []sp{textParam, {Key: "title", Label: "标题", Template: true, Desc: "留空是「任务编号 任务标题」"}, taskParam,
			{Key: "message", Label: "回复原消息", Template: true, Desc: "消息 id；留空或取不到只发平台通知"},
			{Key: "level", Label: "级别", Options: opt("", "一般", "info", "一般", "success", "成功", "error", "要处理")}},
		Outputs: []so{{Path: "notified", Type: "object", Label: "{title, text, task_id, app, im, replied}"}}},
	NodeToTask: {Effect: plugin.SOPEffectWrite, DryRun: "不建任务，列出消息、标题；task 为占位", Label: "转成任务", Desc: "同消息页「转任务」：建任务，记来源消息和提出人，阶段「已接收」；转过的取回原任务",
		Params: []sp{msgParam("消息 id；留空用输入里的 message_id"),
			{Key: "title", Label: "标题", Template: true, Desc: "留空取正文前 40 字"}, {Key: "body", Label: "正文", Template: true, Desc: "留空是消息原文"}},
		Outputs: append(append([]so{}, taskOutFields...),
			so{Path: "task.reused", Type: "bool", Label: "这条消息转过任务、取回了原任务时为 true"},
			so{Path: "conversation_id", Type: "string", Label: "消息所在的会话 id（输入里没有时补上）"})},
	NodeSetTaskStage: {Effect: plugin.SOPEffectWrite, DryRun: "不改任务，列出阶段和项目；task 为占位", Label: "设置任务阶段", Desc: "改任务在看板上的阶段，可同时把任务归到项目",
		Params: []sp{taskParam, {Key: "stage", Label: "阶段", Template: true, Source: "task_stages", Desc: "阶段 key；留空不改"},
			{Key: "project", Label: "项目", Template: true, Source: "projects", Desc: "项目 id、编号或名字；留空不改"}},
		Outputs: append(append([]so{}, taskOutFields...), so{Path: "project", Type: "object", Label: "绑了项目时：{id, ref, name}"})},
}
