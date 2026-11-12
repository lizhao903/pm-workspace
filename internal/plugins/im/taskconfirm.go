// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"encoding/json"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内置流程「来消息确认派发」（TSK-0411，sop_im_task_confirm）：IM 消息要建任务时先私信我确认，
// 我回「执行」才派 Claude Code 在任务继承的工作目录里开工，回「分配 某人」改负责人，回「不做」把任务标为已取消；
// 认不出、超时都不执行（im_ask_me 再问、提醒各一次后以 choice=none 往下走）。
//
// 两种用法，都不会对同一条消息建两条任务：
//   - 单独用：触发方式改成「IM 消息」。输入只有 message_id，先分类「要不要建任务」，要建的经 im_to_task 建
//     （这条消息已经被别的流程建过任务时取回那条，不再建）。
//   - 接在已有流程建任务之后（如「消息分流」的建任务步骤后面加一步子流程）：子流程的输入里有 task.id 或 task_id，
//     跳过分类和建任务，直接拿这条任务去问。
//
// 由「IM 需求自动受理」同一个后台任务写进 SOP（installOnce：写过一次记在 im_sop_templates，用户删了不补回来、改过的不动）；
// trigger 写成 manual 即默认停用。用到 SOP 插件的 task_update、task_run 节点（TSK-0411）：SOP 插件版本旧、不认这两个节点时
// 写不进去，下次再试。

// TaskConfirmFlowID 是内置流程「来消息确认派发」的 id。
const TaskConfirmFlowID = "sop_im_task_confirm"

const confirmAsk = `要处理吗：{{task.ref}}「{{task.title}}」
项目：{{task.project}}
工作目录：{{task.workdir}}
来自 {{message.sender}}（{{message.conversation}}）：{{message.text}}
任务：{{task.url}}`

func taskConfirmFlow() plugin.SOPFlowTemplate {
	br := func(of, c string) *intakeBranch { return &intakeBranch{Of: of, Case: c} }
	steps := []intakeStep{
		{Key: "read", Name: "读取消息", Kind: NodeGetMessage, After: []string{}, Desc: "按消息 id 取出正文、发信人和会话",
			Config: map[string]string{"message": "{{message_id}}"}},
		{Key: "given_id", Name: "带了任务 id 吗", Kind: "decide", After: []string{"read"}, Rule: `task_id 不等于 ""`,
			Desc: "接在别的流程建任务之后时，输入里带着任务，不再分类、不再建", Cases: []intakeCase{{"yes", "带了"}, {"no", "没带"}}},
		{Key: "given_obj", Name: "带了任务吗", Kind: "decide", After: []string{"given_id"}, Branch: br("given_id", "no"), Rule: `task.id 不等于 ""`,
			Cases: []intakeCase{{"yes", "带了"}, {"no", "没带"}}},
		{Key: "need", Name: "要不要建任务", Kind: "classifier", After: []string{"given_obj"}, Branch: br("given_obj", "no"),
			Desc:  "要我或团队去做的事算要建任务；闲聊、通知、问进度、客套不算",
			Cases: []intakeCase{{"task", "要建任务"}, {"none", "不用"}},
			Config: map[string]string{"from": "message.text",
				"hint": "要我或团队去做的事（新需求、改进现有功能、修问题、要交付的东西）算要建任务；闲聊、通知、广播、问进度、单纯提问、客套、表情不算。拿不准时算不用"}},
		{Key: "skip", Name: "不用建任务", Kind: "end", After: []string{"need"}, Branch: br("need", "none"), Desc: "流程到此结束，消息照常留在消息页"},
		{Key: "to_task", Name: "建任务", Kind: NodeToTask, After: []string{"need"}, Branch: br("need", "task"),
			Desc: "建任务（来源消息、提出人）；这条消息已经被别的流程建过任务时取回那条，不再建", Config: map[string]string{"message": "{{message_id}}"}},
		{Key: "use_id", Name: "用带来的任务", Kind: "auto", After: []string{"given_id"}, Branch: br("given_id", "yes")},
		{Key: "use_obj", Name: "用带来的任务", Kind: "auto", After: []string{"given_obj"}, Branch: br("given_obj", "yes")},
		{Key: "join", Name: "任务", Kind: "aggregate", After: []string{"use_id", "use_obj", "to_task"}, Config: map[string]string{"mode": "first"}},
		{Key: "info", Name: "读任务", Kind: "task_update", After: []string{"join"}, Desc: "取任务的编号、标题、项目和继承后的工作目录，给私信摘要用"},
		{Key: "ack", Name: "回执需求方", Kind: NodeAckTask, After: []string{"info"},
			Desc:   "先在原消息所在的会话里回复需求方，再私信我确认；同一条消息只回一次（别的流程回过就不回），我自己发的、只收不发的不回，回复失败不影响后面（TSK-0467）",
			Config: map[string]string{"message": "{{message_id}}", "task": "{{task.id}}", "text": defaultAckText}},
		{Key: "ask", Name: "私信我确认", Kind: NodeAskMe, After: []string{"ack"},
			Desc:   "私信我任务摘要和三种回复方式；认不出再问一次，超时提醒一次，仍没有就不执行",
			Config: map[string]string{"text": confirmAsk, "timeout": "1 天"}},
		{Key: "is_exec", Name: "回复执行？", Kind: "decide", After: []string{"ask"}, Rule: "answer.choice 等于 execute",
			Cases: []intakeCase{{"yes", "执行"}, {"no", "不是"}}},
		{Key: "run", Name: "执行任务", Kind: "task_run", After: []string{"is_exec"}, Branch: br("is_exec", "yes"),
			Desc:   "派 Claude Code 在任务继承的工作目录里执行；没有工作目录、目录不可写、执行失败都交给下一步回报",
			Config: map[string]string{"task": "{{task.id}}", "timeout": "2 小时", "on_fail": "continue"}},
		{Key: "run_ok", Name: "执行成功？", Kind: "decide", After: []string{"run"}, Rule: "status 等于 done",
			Cases: []intakeCase{{"yes", "成功"}, {"no", "失败"}}},
		{Key: "tell_done", Name: "回报结果", Kind: NodeTellMe, After: []string{"run_ok"}, Branch: br("run_ok", "yes"),
			Config: map[string]string{"text": "{{task.ref}}「{{task.title}}」执行完了。\n{{summary}}\n任务：{{task.url}}"}},
		{Key: "tell_fail", Name: "回报失败", Kind: NodeTellMe, After: []string{"run_ok"}, Branch: br("run_ok", "no"),
			Config: map[string]string{"text": "{{task.ref}}「{{task.title}}」没执行成功：{{error}}\n任务：{{task.url}}"}},
		{Key: "is_assign", Name: "回复分配？", Kind: "decide", After: []string{"is_exec"}, Branch: br("is_exec", "no"), Rule: "answer.choice 等于 assign",
			Cases: []intakeCase{{"yes", "分配"}, {"no", "不是"}}},
		{Key: "assign", Name: "改负责人", Kind: "task_update", After: []string{"is_assign"}, Branch: br("is_assign", "yes"),
			Desc: "负责人要是名册里的人；对不上不改，交给下一步回话", Config: map[string]string{"task": "{{task.id}}", "assignee": "{{answer.assignee}}"}},
		{Key: "assigned", Name: "分配上了？", Kind: "decide", After: []string{"assign"}, Rule: "task.assign_ok 等于 yes",
			Cases: []intakeCase{{"yes", "分配上了"}, {"no", "没找到人"}}},
		{Key: "tell_assigned", Name: "回话：已分配", Kind: NodeTellMe, After: []string{"assigned"}, Branch: br("assigned", "yes"),
			Config: map[string]string{"text": "已把 {{task.ref}}「{{task.title}}」分配给 {{task.assignee}}。"}},
		{Key: "tell_noone", Name: "回话：没找到人", Kind: NodeTellMe, After: []string{"assigned"}, Branch: br("assigned", "no"),
			Config: map[string]string{"text": "{{task.assign_note}}（{{task.ref}}「{{task.title}}」）：{{task.url}}"}},
		{Key: "is_cancel", Name: "回复不做？", Kind: "decide", After: []string{"is_assign"}, Branch: br("is_assign", "no"), Rule: "answer.choice 等于 cancel",
			Cases: []intakeCase{{"yes", "不做"}, {"no", "没答复"}}},
		{Key: "cancel", Name: "标为已取消", Kind: "task_update", After: []string{"is_cancel"}, Branch: br("is_cancel", "yes"),
			Config: map[string]string{"task": "{{task.id}}", "status": "cancelled"}},
		{Key: "tell_cancel", Name: "回话：已取消", Kind: NodeTellMe, After: []string{"cancel"},
			Config: map[string]string{"text": "已取消 {{task.ref}}「{{task.title}}」。"}},
		{Key: "tell_idle", Name: "回话：先不执行", Kind: NodeTellMe, After: []string{"is_cancel"}, Branch: br("is_cancel", "no"),
			Desc:   "认不出、超时：不执行，任务留在未开工",
			Config: map[string]string{"text": "{{answer.reason_text}}，{{task.ref}}「{{task.title}}」先不执行，留在未开工：{{task.url}}"}},
	}
	fields := []map[string]any{
		{"key": "message_id", "label": "IM 消息", "type": "text", "required": true, "placeholder": "消息 id；IM 触发时自动带上"},
		{"key": "task_id", "label": "任务", "type": "text", "placeholder": "已经建好的任务 id；留空时按消息判断要不要建"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: TaskConfirmFlowID, Name: "来消息确认派发", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "IM 消息要建任务时先在原会话回执需求方「已创建任务 TSK-x，开始进行需求规划」，再私信我确认：回「执行」派 Claude Code 在任务继承的工作目录里开工、做完私信回报；回「分配 某人」改负责人；回「不做」取消任务；" +
			"认不出再问一次、超时提醒一次，仍没有就不执行。可单独用（触发方式改成「IM 消息」），也可接在「消息分流」建任务之后当子流程（带上任务），" +
			"同一条消息只建一次任务。默认停用：触发方式是「手动」",
	}
}
