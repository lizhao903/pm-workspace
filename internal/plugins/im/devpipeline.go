// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 研发 pipeline（AUTO-09，docs/auto-delivery-flow.md 第 1 节 6 到 9 段）。
//
// 一个 SOP 节点：
//   - 通知 im_notify：发一条平台通知（关联任务，通知中心和事件流里看得到）；配了消息且取得到 id 时，同时在原消息所在的串里回复。
//     消息 id 渲染后为空就只发平台通知、不报错，所以「有没有来源消息」不用在流程里另做判断。
//
// 内置流程「研发 pipeline」（sop_im_dev_pipeline）由「IM 需求自动受理」同一个后台任务写进 SOP，写过一次记在 im_sop_templates，
// 用户删了不补回来；触发方式「手动」即默认停用，用户手动发起（输入任务 id），或由「IM 需求自动受理」末尾的子流程步骤接上。
// 步骤见 devPipelineFlow；回退目标是「回到开发中」那一步，退回时阶段先回到开发中。
//
// 验收通过分支末尾以子流程接「发布 pipeline」（AUTO-10，releasepipeline.go）；第 1 版研发 pipeline 没接，升级做法同下。
//
// 「IM 需求自动受理」第 1 版没有接研发 pipeline：已经写进 SOP 的、还是第 1 版（用户没改过）、没有进行中执行的，
// 撤下重写成新版（末尾加子流程）；改过的不动。做过一次记一个标记行（intakeUpgradeMark），不加迁移。

const (
	NodeNotify = "im_notify"

	// DevPipelineFlowID 是内置流程「研发 pipeline」的 id。
	DevPipelineFlowID = "sop_im_dev_pipeline"

	// intakeUpgradeMark 记在 im_sop_templates 里，表示「IM 需求自动受理」已经换成接研发 pipeline 的版本（或者用户改过、删了，不再换）。
	intakeUpgradeMark = AutoIntakeFlowID + "#pipeline"
)

func (in *inbox) registerDevPipeline(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeNotify, Group: "沟通", Required: []plugin.SOPNodeField{{Key: "text", Label: "内容"}}, Run: in.notifyNode})
}

/* ---------- 通知 ---------- */

// notifyNode：config.task 关联的任务（默认 {{task.id}}，取不到不关联）、config.title 标题（留空「任务编号 标题」）、
// config.text 内容、config.level（info / success / error，默认 info）、config.message 要回复的原消息（留空不回复；
// 渲染后为空也不回复）。都支持 {{字段}}。平台通知和回复各按写入键去重（服务重启后重跑同一次尝试不重复发）。
func (in *inbox) notifyNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	text := strings.TrimSpace(render(n.Config["text"], n.Input))
	if text == "" {
		return nil, errors.New("通知内容是空的")
	}
	taskTpl := n.Config["task"]
	if strings.TrimSpace(taskTpl) == "" {
		taskTpl = "{{task.id}}"
	}
	taskID := strings.TrimSpace(render(taskTpl, n.Input))
	title := strings.TrimSpace(render(n.Config["title"], n.Input))
	if title == "" {
		title = strings.TrimSpace(txt(getPath(n.Input, "task.ref")) + " " + txt(getPath(n.Input, "task.title")))
	}
	if title == "" {
		title = "流程通知"
	}
	level := strings.TrimSpace(n.Config["level"])
	switch level {
	case "", plugin.NotifyInfo, plugin.NotifySuccess, plugin.NotifyError:
	default:
		return nil, fmt.Errorf("通知级别「%s」不认，只能是 info、success、error", level)
	}
	notified := map[string]any{"title": clip(title, 200), "text": text, "task_id": taskID}

	// 平台通知
	meta := writeMeta(n)
	target := taskID
	if target == "" {
		target = n.RunID
	}
	if a, found, ferr := c.Audit().Find(ctx, "notify", "object", meta); ferr != nil {
		c.Log().Warn("im notify dedupe lookup failed", "key", meta.Key, "err", ferr)
	} else if found {
		notified["app"], notified["reused"] = a.Detail["status"], true
	}
	if notified["app"] == nil {
		err := c.Notify(ctx, plugin.Notification{Kind: "notify", Level: level, Title: clip(title, 200), Body: text, ObjectID: taskID,
			Data: map[string]any{"run_id": n.RunID, "flow_id": n.FlowID, "step": n.Step}})
		status := "sent"
		if err != nil {
			// 通知中心没接上（只在测试和最小启动里）不算失败，照常回复原消息
			if !errors.Is(err, plugin.ErrNoNotifier) {
				return nil, fmt.Errorf("发平台通知失败：%w", err)
			}
			status = "skipped"
		}
		c.Audit().Note(ctx, plugin.AuditNote{Action: "notify", TargetType: "object", TargetID: target,
			Summary: "发平台通知「" + clip(title, 60) + "」", Detail: map[string]any{"status": status, "title": clip(title, 200), "text": clip(text, auditTextMax)}}, meta)
		notified["app"] = status
	}

	// 回复原消息：配了且取得到消息 id 才回
	notified["im"] = "skipped"
	if tpl := strings.TrimSpace(n.Config["message"]); tpl != "" && strings.TrimSpace(render(tpl, n.Input)) != "" {
		out, err := in.replyMessageNode(ctx, c, plugin.SOPNodeInput{RunID: n.RunID, FlowID: n.FlowID, Step: n.Step, Attempt: n.Attempt,
			Input: n.Input, Config: map[string]string{"message": tpl, "text": n.Config["text"]}})
		if err != nil {
			return nil, fmt.Errorf("平台通知已发，回复原消息失败：%w", err)
		}
		notified["im"] = "sent"
		notified["replied"] = out["replied"]
	}
	return with(n.Input, "notified", notified), nil
}

/* ---------- 内置流程 ---------- */

const devPrompt = `按任务 {{task.ref}}（id {{task.id}}）「{{task.title}}」的内容和验收标准开发。先用 pmw_get_object 读任务正文、验收标准和最近的进展。
项目：{{profile.name}}。工作目录是这个任务独立的工作区（分支 {{worktree.branch}}），只改这里面的代码；改完跑通构建和相关单测，提交到当前分支。
测试用例（docs/test-cases/）和自动化测试脚本由另外两路同时在写，不要改它们新增的文件。

上一轮退回的原因（第一轮为空）：{{feedback.reason}}
自动测试没通过时：没过的步骤 {{feedback.test.failed_step}}，原因 {{feedback.test.error}}，测试报告 {{feedback.test.report_path}}，先读报告再改。
人工验收退回时（原因里提到验收）：验收意见写在任务最近的进展里，逐条改掉。
summary 写成给提出人和验收人员看的变更说明：改了什么、怎么用。`

const casesPrompt = `为任务 {{task.ref}}（id {{task.id}}）「{{task.title}}」设计测试用例：先用 pmw_get_object 读任务的验收标准，逐条写出用例（前置条件、步骤、预期），写进工作区的 docs/test-cases/{{task.ref}}.md（目录没有就建）。
不改业务代码，不写自动化脚本（另一路在写）。写完只提交这一个文件：git commit -- docs/test-cases/{{task.ref}}.md，提交信息「test: {{task.ref}} 测试用例」；遇到 git 锁冲突等几秒重试。
summary 写成给验收人员用的验收清单，每条一行「- [ ] 要验证的事」。`

const autotestPrompt = `为任务 {{task.ref}}（id {{task.id}}）「{{task.title}}」写自动化测试：先用 pmw_get_object 读验收标准，再看项目现有的测试怎么组织，按同样的方式写单测、接口测试或端到端脚本，放进项目的测试目录，要能被项目档案里的测试命令跑到。
端到端测试的截图和 junit xml 写到环境变量 TEST_REPORT_DIR 指的目录（测试环境地址是 http://127.0.0.1:$PORT），工作台会收进测试报告。
不改业务代码（功能还在另一路开发，现在跑不过是正常的）。写完只提交你新增的测试文件（git commit -- <文件>），提交信息「test: {{task.ref}} 自动化测试」；遇到 git 锁冲突等几秒重试。
summary 里列出新增的测试文件和覆盖了哪几条验收标准。`

const acceptText = `需求 {{task.ref}}「{{task.title}}」开发完成，自动测试通过，请验收。
测试环境：{{test.env_text}}
测试报告：{{test.report_url}}
看板：{{task.url}}
验收人员：{{profile.acceptors_text}}

变更说明：
{{summary}}

验收清单：
{{test_cases}}`

// devPipelineFlow 是内置流程「研发 pipeline」。触发方式「手动」即默认停用。
func devPipelineFlow() plugin.SOPFlowTemplate {
	task := "{{task.id}}"
	stage := func(key, name, after, value, desc string, br *intakeBranch) intakeStep {
		return intakeStep{Key: key, Name: name, Kind: NodeSetTaskStage, After: []string{after}, Branch: br, Desc: desc,
			Config: map[string]string{"task": task, "stage": value}}
	}
	claude := func(key, name, after, preset, prompt, desc string) intakeStep {
		return intakeStep{Key: key, Name: name, Kind: "claude_code", After: []string{after}, Desc: desc,
			Config: map[string]string{"preset": preset, "workdir": "{{worktree.path}}", "prompt": prompt, "task": task, "permission": "write", "timeout": "4 小时"}}
	}
	notify := func(key, name, after, title, text, level string, reply bool) intakeStep {
		cfg := map[string]string{"task": task, "title": title, "text": text, "level": level}
		if reply {
			cfg["message"] = "{{message_id}}"
		}
		return intakeStep{Key: key, Name: name, Kind: NodeNotify, After: []string{after}, Config: cfg}
	}
	steps := []intakeStep{
		{Key: "start", Name: "阶段改为开发中", Kind: NodeSetTaskStage, After: []string{}, Desc: "取任务信息（编号、标题、所属项目、看板链接）",
			Config: map[string]string{"task": "{{task_id}}", "stage": "developing"}},
		{Key: "profile", Name: "读项目档案", Kind: "projects_get_profile", After: []string{"start"}, Desc: "取验收人员，通知时用",
			Config: map[string]string{"project": "{{task.project_id}}"}},
		{Key: "worktree", Name: "准备工作区", Kind: "projects_prepare_worktree", After: []string{"profile"},
			Desc: "在项目代码库建任务独立的 worktree 和分支 auto/<任务编号>，分一段端口", Config: map[string]string{"task": task}},
		// 三路并行
		stage("dev_stage", "回到开发中", "worktree", "developing", "测试没通过、验收发现实现缺陷时退回到这里，阶段先回到开发中", nil),
		claude("dev", "研发：功能开发", "dev_stage", "rp_dev", devPrompt, "Claude Code 按研发角色在工作区里改代码、跑单测、提交"),
		claude("cases", "测试用例设计", "worktree", "rp_testdesign", casesPrompt, "对照验收标准写测试用例，summary 是验收清单"),
		{Key: "cases_note", Name: "记下验收清单", Kind: "template", After: []string{"cases"}, Desc: "汇合时研发的 summary 会盖掉这一路的，先存一份",
			Config: map[string]string{"template": "{{summary}}", "output": "test_cases"}},
		claude("autotest", "自动化测试脚本", "worktree", "rp_testdesign", autotestPrompt, "写单测、接口、端到端脚本，产物写进 TEST_REPORT_DIR"),
		{Key: "autotest_note", Name: "记下自动化测试", Kind: "template", After: []string{"autotest"},
			Config: map[string]string{"template": "{{summary}}", "output": "autotest"}},
		{Key: "join", Name: "三路汇合", Kind: "aggregate", After: []string{"cases_note", "autotest_note", "dev"}, Desc: "合并三路的输出，研发排最后，summary 是研发的变更说明",
			Config: map[string]string{"mode": "merge"}},
		stage("stage_test", "阶段改为测试中", "join", "testing", "", nil),
		{Key: "test", Name: "部署测试", Kind: "projects_run_test", After: []string{"stage_test"},
			Desc:   "按项目档案构建、起测试环境、跑测试和冒烟，写测试报告；通过时保留测试环境给人工验收",
			Config: map[string]string{"task": task, "keep_env": "是"}},
		{Key: "test_gate", Name: "测试没通过就退回研发", Kind: "loopback", After: []string{"test"}, Rule: "test.ok 等于 false",
			Desc:  "退回「回到开发中」重做，失败步骤和报告作为 feedback 带回去；最多 3 轮",
			Cases: []intakeCase{{"pass", "通过"}, {"over", "超限"}}, Config: map[string]string{"target": "dev_stage", "max_rounds": "3"}},
		// 测试修复超限：转人工
		stage("test_human_stage", "阶段改为需人工", "test_gate", "need_human", "", &intakeBranch{"test_gate", "over"}),
		notify("test_human_notify", "通知：测试修复超限", "test_human_stage", "{{task.ref}} 自动测试修复 3 轮仍没通过",
			"需求 {{task.ref}}「{{task.title}}」自动测试退回研发 3 轮仍没通过，转人工处理。\n最近一次：{{test.error}}\n测试报告：{{test.report_url}}\n看板：{{task.url}}", "error", false),
		{Key: "test_human", Name: "人工处理", Kind: "review", After: []string{"test_human_notify"}, Desc: "看测试报告决定怎么办：改好代码后放行，或者终止这次执行"},
		// 通过：待验收、通知
		stage("stage_accept", "阶段改为待验收", "test_gate", "accepting", "", &intakeBranch{"test_gate", "pass"}),
		notify("notify", "通知提出人与验收人员", "stage_accept", "{{task.ref}} 待验收", acceptText, "info", true),
		{Key: "accept", Name: "人工验收", Kind: "decide", After: []string{"notify"},
			Desc:  "在测试环境上验收。通过选「通过」；不通过先在任务里写一条进展说明问题，再按归属选「实现缺陷」（退回研发）或「需求偏差」（退回产品）",
			Cases: []intakeCase{{"pass", "通过"}, {"defect", "实现缺陷"}, {"deviation", "需求偏差"}}},
		// 通过：待发布，接发布 pipeline（AUTO-10）。子流程的输入就是这一步的输入：先把任务 id 写成 task_id，
		// 再用「结束」只留 task_id、message_id、conversation_id，研发的 summary、test、feedback 不带进发布
		stage("stage_release", "阶段改为待发布", "accept", "releasing", "验收结束，保留的测试环境随之回收", &intakeBranch{"accept", "pass"}),
		notify("tell_release", "告诉提出人验收通过", "stage_release", "{{task.ref}} 验收通过",
			"需求 {{task.ref}}「{{task.title}}」验收通过，进入发布。进度：{{task.url}}", "success", true),
		{Key: "release_in", Name: "交给发布 pipeline", Kind: "template", After: []string{"tell_release"}, Desc: "把任务 id 写成 task_id，发布 pipeline 按它取任务",
			Config: map[string]string{"template": "{{task.id}}", "output": "task_id"}},
		{Key: "release_args", Name: "只带任务和来源消息", Kind: "end", After: []string{"release_in"},
			Desc:   "子流程拿这一步的输出当输入：只留 task_id、message_id、conversation_id",
			Config: map[string]string{"outputs": "task_id, message_id, conversation_id"}},
		{Key: "release", Name: "发布 pipeline", Kind: "subflow", After: []string{"release_args"},
			Desc:   "版本号、打包、上线审批、发布、线上冒烟（没过自动回滚）；这一步等发布 pipeline 走完",
			Config: map[string]string{"sop": ReleasePipelineFlowID}},
		// 实现缺陷：退回研发
		stage("back_dev", "阶段改回开发中", "accept", "developing", "", &intakeBranch{"accept", "defect"}),
		{Key: "accept_gate", Name: "验收不通过退回研发", Kind: "loopback", After: []string{"back_dev"}, Rule: "task.stage 等于 developing",
			Desc:  "退回「回到开发中」重做，研发从任务进展里读验收意见；最多 3 轮",
			Cases: []intakeCase{{"pass", "通过"}, {"over", "超限"}}, Config: map[string]string{"target": "dev_stage", "max_rounds": "3"}},
		stage("accept_human_stage", "阶段改为需人工", "accept_gate", "need_human", "", &intakeBranch{"accept_gate", "over"}),
		notify("accept_human_notify", "通知：验收退回超限", "accept_human_stage", "{{task.ref}} 验收退回 3 轮仍没通过",
			"需求 {{task.ref}}「{{task.title}}」验收退回研发 3 轮仍没通过，转人工处理。看板：{{task.url}}", "error", false),
		{Key: "accept_human", Name: "人工处理", Kind: "review", After: []string{"accept_human_notify"}, Desc: "验收退回 3 轮仍不通过：看验收意见决定怎么办"},
		// 需求偏差：退回产品
		stage("back_design", "阶段改回设计中", "accept", "designing", "", &intakeBranch{"accept", "deviation"}),
		notify("tell_pm", "通知产品：需求偏差", "back_design", "{{task.ref}} 验收发现需求偏差",
			"需求 {{task.ref}}「{{task.title}}」验收发现需求偏差，已退回产品重新设计，验收意见见任务进展。看板：{{task.url}}", "error", true),
		{Key: "to_design", Name: "结束", Kind: "end", After: []string{"tell_pm"}, Desc: "产品改完 PRD 后重新走评审和研发"},
	}
	fields := []map[string]any{
		{"key": "task_id", "label": "任务", "type": "text", "required": true, "placeholder": "任务 id；任务要已归到项目、项目档案里设了代码库和测试命令"},
		{"key": "message_id", "label": "来源消息", "type": "text", "placeholder": "IM 消息 id，有的话通知时在原消息里回复提出人"},
		{"key": "conversation_id", "label": "会话", "type": "text", "placeholder": "来源消息所在的会话，可空"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: DevPipelineFlowID, Name: "研发 pipeline", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "准备工作区，研发、测试用例、自动化测试三路并行，汇合后部署测试；没通过自动退回研发最多 3 轮；通过后保留测试环境、通知提出人和验收人员，" +
			"人工验收通过进待发布、接着走发布 pipeline，实现缺陷退回研发、需求偏差退回产品。默认停用：手动发起，或由「IM 需求自动受理」接上",
	}
}

// installOnce 把一条内置流程写进 SOP，写过一次（含已有同 id 的）记下来，之后不再写，用户删了也不补回来。
// SOP 插件没在跑回 false、nil（下次再试）；定义不合法（例：项目插件没装，节点类型不认）回错误。
func (in *inbox) installOnce(ctx context.Context, c plugin.Core, t plugin.SOPFlowTemplate) (bool, error) {
	done, err := in.templateDone(ctx, c, t.ID)
	if err != nil || done {
		return done, err
	}
	created, err := c.SOP().InstallFlow(ctx, t)
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := in.markTemplate(ctx, c, t.ID); err != nil {
		return false, err
	}
	c.Log().Info("im builtin flow installed", "flow", t.ID, "created", created)
	return true, nil
}

func (in *inbox) templateDone(ctx context.Context, c plugin.Core, id string) (bool, error) {
	var n int
	if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM im_sop_templates WHERE flow_id = ?`, id).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

func (in *inbox) markTemplate(ctx context.Context, c plugin.Core, id string) error {
	_, err := c.Store().Exec(ctx, `INSERT INTO im_sop_templates (flow_id, installed_at) VALUES (?, ?) ON CONFLICT (flow_id) DO NOTHING`,
		id, in.clock().UTC().Format(timeLayout))
	return err
}

// upgradeIntake 把第 1 版的「IM 需求自动受理」换成接研发 pipeline 的版本：还是第 1 版、没有进行中执行、没被定时任务引用的撤下重写；
// 改过的、被用户删掉的不动，记标记不再试；有进行中执行、被定时任务引用的下次再试。
func (in *inbox) upgradeIntake(ctx context.Context, c plugin.Core) error {
	removed, why, err := c.SOP().RemoveFlow(ctx, AutoIntakeFlowID)
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return nil
	}
	if err != nil {
		return err
	}
	switch {
	case removed:
		if _, err := c.SOP().InstallFlow(ctx, intakeFlow()); err != nil {
			return fmt.Errorf("重写「IM 需求自动受理」失败：%w", err)
		}
		c.Log().Info("im auto intake flow upgraded to hand off to dev pipeline", "flow", AutoIntakeFlowID)
		// 新版已经带「回执需求方」（TSK-0467），不用再换一次
		if err := in.markTemplate(ctx, c, intakeAckMark); err != nil {
			return err
		}
	case why == "":
		// 用户删掉了：不补回来
	case strings.Contains(why, "改过"):
		c.Log().Info("im auto intake flow edited by user, not upgraded", "flow", AutoIntakeFlowID, "why", why)
	default:
		c.Log().Info("im auto intake flow upgrade postponed", "flow", AutoIntakeFlowID, "why", why)
		return nil
	}
	return in.markTemplate(ctx, c, intakeUpgradeMark)
}
