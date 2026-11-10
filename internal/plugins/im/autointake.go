// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 需求自动受理（AUTO-06，docs/auto-delivery-flow.md 第 1 节 1 到 5 段）。
//
// 两个 SOP 节点：
//   - 转成任务 im_to_task：同消息页的「转任务」，建任务（来源消息、提出人、阶段 received），任务 id 记在消息上；
//     消息已经转过、任务还在时不再建，取回那条任务。输出 task：id、ref、title、status、stage、url（看板链接），
//     输入里没有 conversation_id 时补上消息所在的会话（后面等提出人回复用）。
//   - 设置任务阶段 im_set_task_stage：改任务的阶段（props.stage），可同时绑定所属项目（项目 id、编号或名字）。
//     经内核 ObjectWriter.UpdateTask，口径同 PUT /api/objects/{id}/stage，阶段事件和审计照常。输出 task（同上），绑了项目时加 project。
//
// 内置流程「IM 需求自动受理」（sop_im_auto_intake）由后台任务写进 SOP，写过一次记在 im_sop_templates，用户删了不补回来。
// 默认停用：SOP 没有启停开关，流程的触发方式写成「手动」，IM 消息来了不会自动跑；用户在 SOP 编排页把触发方式改成
// 「IM 消息」才算启用（SOP 插件按 trigger = im 订阅新消息，见 SOP 插件 imtrigger.go）。

const (
	NodeToTask       = "im_to_task"
	NodeSetTaskStage = "im_set_task_stage"

	// AutoIntakeFlowID 是内置流程「IM 需求自动受理」的 id。
	AutoIntakeFlowID = "sop_im_auto_intake"
)

// intakeEvery 是多久试一次把内置流程写进 SOP（SOP 插件可能比本插件晚启用）；测试里调小。
var intakeEvery = time.Minute

func (in *inbox) registerAutoIntake(r plugin.Registrar) {
	in.registerDevPipeline(r)
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeToTask, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.toTaskNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeSetTaskStage, Group: "沟通", Required: []plugin.SOPNodeField{}, Run: in.setTaskStageNode})
	r.Job(plugin.Job{Name: "sop_templates", Every: intakeEvery, Run: in.installIntake})
}

// boardURL 是任务在阶段看板上的链接：--public-url 加 /tasks/board?t=<id>；没给地址时只有路径。
func (in *inbox) boardURL(taskID string) string {
	return in.publicURL + "/tasks/board?t=" + url.QueryEscape(taskID)
}

func (in *inbox) taskInfo(id, ref, title, status, stage, projectID string) map[string]any {
	return map[string]any{"id": id, "ref": ref, "title": title, "status": status, "stage": stage, "project_id": projectID, "url": in.boardURL(id)}
}

func writeMeta(n plugin.SOPNodeInput) plugin.WriteMeta {
	return plugin.WriteMeta{Session: n.RunID, Key: fmt.Sprintf("%s/%s#%d", n.RunID, n.Step, n.Attempt), Detail: map[string]any{
		"run_id": n.RunID, "flow_id": n.FlowID, "step": n.Step, "attempt": n.Attempt,
	}}
}

/* ---------- 转成任务 ---------- */

// toTaskNode：config.message 消息 id（留空取输入的 message_id），config.title 标题（留空同转任务：正文前 40 字），
// config.body 正文（留空是消息原文），都支持 {{字段}}。幂等：消息上记着任务就取回；同一次尝试重跑按写入键取回。
func (in *inbox) toTaskNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	m, err := in.messageOf(ctx, n.Config, n.Input)
	if err != nil {
		return nil, err
	}
	out := n.Input
	if strings.TrimSpace(txt(getPath(out, "conversation_id"))) == "" && m.ConversationID != nil {
		out = with(out, "conversation_id", *m.ConversationID)
	}
	in.taskMu.Lock()
	defer in.taskMu.Unlock()
	if m.TaskID != nil {
		o, err := c.Objects().Get(ctx, *m.TaskID)
		if err == nil && !o.Deleted {
			t := in.taskInfo(o.ID, o.Ref, o.Title, o.Status, domain.StageOf(o.Props), "")
			t["reused"] = true
			return with(out, "task", t), nil
		}
		if err != nil && !errors.Is(err, plugin.ErrNoRows) {
			return nil, err
		}
	}
	// 别的流程（消息分流的 task 节点等，TSK-0411）已经为这条消息建过任务：props.source_ref.message_id 指着它，取回那条、记到消息上
	if rows, err := c.Objects().TaskStages(ctx, plugin.TaskStageQuery{MessageID: m.ID, Limit: 5}); err == nil {
		for _, r := range rows {
			o, err := c.Objects().Get(ctx, r.ID)
			if err != nil || o.Deleted {
				continue
			}
			if _, err := c.Store().Exec(ctx, `UPDATE im_messages SET task_id = ?, task_ref = ? WHERE id = ?`, o.ID, o.Ref, m.ID); err != nil {
				return nil, err
			}
			t := in.taskInfo(o.ID, o.Ref, o.Title, o.Status, domain.StageOf(o.Props), o.ProjectID)
			t["reused"] = true
			return with(out, "task", t), nil
		}
	}
	title := strings.TrimSpace(render(n.Config["title"], n.Input))
	if title == "" {
		title = defaultTaskTitle(m)
	}
	body := strings.TrimSpace(render(n.Config["body"], n.Input))
	if body == "" {
		body = m.Text
	}
	task, err := c.ObjectWriter().CreateAs(ctx, plugin.NewObject{
		TypeID: "task", Title: clip(title, 200), Body: body,
		Props: map[string]any{domain.PropSourceRef: sourceRefOf(m), domain.PropRequester: requesterOf(m).Map(), domain.PropStage: "received"},
	}, writeMeta(n))
	if err != nil {
		return nil, fmt.Errorf("建任务失败：%w", err)
	}
	if _, err := c.Store().Exec(ctx, `UPDATE im_messages SET task_id = ?, task_ref = ? WHERE id = ?`, task.ID, task.Ref, m.ID); err != nil {
		return nil, err
	}
	t := in.taskInfo(task.ID, task.Ref, task.Title, task.Status, "received", "")
	if task.Reused {
		t["reused"] = true
	}
	return with(out, "task", t), nil
}

/* ---------- 设置任务阶段 ---------- */

// stageKeys 是给出错信息用的阶段 key 列表。
func stageKeys() string {
	ks := make([]string, 0, len(domain.TaskStages))
	for _, s := range domain.TaskStages {
		ks = append(ks, s.Key)
	}
	return strings.Join(ks, "、")
}

// cleanKey 去掉模型回答常带的引号、句号和空白。
func cleanKey(s string) string {
	return strings.Trim(strings.TrimSpace(s), "「」\"'`。.，, \n")
}

// setTaskStageNode：config.task 任务 id（留空取输入的 task.id），config.stage 阶段 key，config.project 项目 id、编号或名字，
// 都支持 {{字段}}；阶段和项目至少给一个。同样的值再写一次不动，重跑不另做幂等。
func (in *inbox) setTaskStageNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	tpl := n.Config["task"]
	if strings.TrimSpace(tpl) == "" {
		tpl = "{{task.id}}"
	}
	id := strings.TrimSpace(render(tpl, n.Input))
	if id == "" {
		return nil, errors.New("没有指定任务：配置里填任务 id，或者输入里要有 task.id")
	}
	stage := strings.TrimSpace(render(n.Config["stage"], n.Input))
	if stage != "" && !domain.ValidTaskStage(stage) {
		return nil, fmt.Errorf("阶段「%s」不认，只能是 %s", stage, stageKeys())
	}
	var proj plugin.ObjectInfo
	if tplP := strings.TrimSpace(n.Config["project"]); tplP != "" {
		key := cleanKey(render(tplP, n.Input))
		if key == "" || strings.EqualFold(key, "none") {
			return nil, fmt.Errorf("没有认出项目：配置「%s」取到的是空的", tplP)
		}
		o, err := c.Objects().Find(ctx, "project", key)
		if errors.Is(err, plugin.ErrNoRows) {
			return nil, fmt.Errorf("项目「%s」不存在：填项目 id、编号或名字，已删除的项目不算", clip(key, 60))
		}
		if err != nil {
			return nil, err
		}
		proj = o
	}
	if stage == "" && proj.ID == "" {
		return nil, errors.New("没有要改的：阶段和项目至少填一个")
	}
	t, err := c.ObjectWriter().UpdateTask(ctx, id, plugin.TaskChange{Stage: stage, ProjectID: proj.ID}, writeMeta(n))
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return nil, fmt.Errorf("任务 %s 不存在", id)
	case errors.Is(err, domain.ErrValidation):
		return nil, fmt.Errorf("改任务 %s 失败：%v", id, err)
	case err != nil:
		return nil, err
	}
	out := with(n.Input, "task", in.taskInfo(t.ID, t.Ref, t.Title, t.Status, t.Stage, t.ProjectID))
	if proj.ID != "" {
		out = with(out, "project", map[string]any{"id": proj.ID, "ref": proj.Ref, "name": proj.Title})
	}
	return out, nil
}

/* ---------- 内置流程 ---------- */

// intakeStep 是内置流程的一步，字段同 SOP 的步骤定义。
type intakeStep struct {
	Key    string            `json:"key"`
	Name   string            `json:"name"`
	Kind   string            `json:"kind"`
	Desc   string            `json:"desc,omitempty"`
	After  []string          `json:"after"`
	Branch *intakeBranch     `json:"branch,omitempty"`
	Cases  []intakeCase      `json:"cases,omitempty"`
	Rule   string            `json:"rule,omitempty"`
	Config map[string]string `json:"config,omitempty"`
}

type intakeBranch struct {
	Of   string `json:"of"`
	Case string `json:"case"`
}

type intakeCase struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

const classifyAsk = `判断这条需求该归到哪个项目。
需求原文：{{message.text}}
各项目档案：
{{profiles_text}}

只回一个 JSON 对象，不要别的内容：{"project_id": "最可能的项目 id（obj_ 开头），拿不准时留空", "project": "项目名", "confidence": 0 到 1 的置信度, "sure": "置信度不低于 0.7 且 project_id 不为空时填 yes，否则填 no", "candidates_text": "候选项目，每行一个，写成「序号. 项目名（编号）」，最多 3 个", "reason": "一句话理由"}`

const pickAsk = `提出人的回复：{{reply.text}}
给过的候选：
{{extracted.candidates_text}}
全部项目：
{{profiles_text}}

从回复里认出提出人选的是哪个项目，只回这个项目的 id（obj_ 开头），不要别的字；认不出就只回 none。`

const pmPrompt = `按需求任务 {{task.ref}}（id {{task.id}}）写 PRD、更新原型与规格。
项目：{{profile.name}}；PRD 目录 {{profile.dirs.prd}}，原型库 {{profile.dirs.prototype}}。
需求原文（提出人 {{message.sender}}）：
{{message.text}}

上一轮研发评审退回的意见（第一轮为空；有的话逐条改掉）：{{feedback.result.issues}}`

const reviewPrompt = `评审需求任务 {{task.ref}}（id {{task.id}}）的 PRD、原型和规格。
项目：{{profile.name}}；PRD 目录 {{profile.dirs.prd}}，原型库 {{profile.dirs.prototype}}，代码库 {{profile.dirs.code}}。
产品这一轮的说明：{{summary}}`

// intakeFlow 是内置流程「IM 需求自动受理」。触发方式「手动」即默认停用，见文件头。
func intakeFlow() plugin.SOPFlowTemplate {
	task := "{{task.id}}"
	steps := []intakeStep{
		{Key: "read", Name: "读取消息", Kind: NodeGetMessage, After: []string{}, Desc: "按消息 id 取出正文、发信人和会话"},
		{Key: "is_req", Name: "是不是需求", Kind: "classifier", After: []string{"read"},
			Desc:   "要做新功能、改进、修问题、改产品的算需求；闲聊、通知、问进度、单纯提问不算",
			Cases:  []intakeCase{{"req", "是需求"}, {"other", "不是需求"}},
			Config: map[string]string{"from": "message.text", "hint": "要做新功能、改进现有功能、修问题、改产品的算需求；闲聊、通知、问进度、单纯提问不算"}},
		{Key: "skip", Name: "普通消息不建任务", Kind: "end", After: []string{"is_req"}, Branch: &intakeBranch{"is_req", "other"},
			Desc: "不是需求，流程到此结束，消息照常留在消息页"},
		{Key: "to_task", Name: "建需求任务", Kind: NodeToTask, After: []string{"is_req"}, Branch: &intakeBranch{"is_req", "req"},
			Desc: "建任务，记来源消息和提出人，阶段「已接收」；这条消息转过任务就用那条", Config: map[string]string{"message": "{{message_id}}"}},
		{Key: "ack", Name: "回执需求方", Kind: NodeAckTask, After: []string{"to_task"},
			Desc:   "在原消息所在的会话里回复需求方（在消息列里的回在消息列里）；同一条消息只回一次，我自己发的、只收不发的不回，回复失败不影响任务（TSK-0467）",
			Config: map[string]string{"message": "{{message_id}}", "task": task, "text": defaultAckText}},
		{Key: "profiles", Name: "读项目档案", Kind: "projects_list_profiles", After: []string{"ack"}, Desc: "取建过档案的项目摘要，给分类用"},
		{Key: "classify", Name: "判断归属项目", Kind: "ai", After: []string{"profiles"}, Desc: classifyAsk, Config: map[string]string{"output": "classify"}},
		{Key: "parse", Name: "整理分类结果", Kind: "extract", After: []string{"classify"}, Desc: "把分类回答整理成字段",
			Config: map[string]string{"from": "classify", "fields": "project_id、project、confidence、sure、candidates_text、reason"}},
		{Key: "sure", Name: "拿得准吗", Kind: "decide", After: []string{"parse"}, Rule: "extracted.sure 等于 yes",
			Desc: "置信度够（不低于 0.7）直接绑项目，不够问提出人", Cases: []intakeCase{{"yes", "拿得准"}, {"no", "拿不准"}}},
		{Key: "bind_auto", Name: "绑定项目", Kind: NodeSetTaskStage, After: []string{"sure"}, Branch: &intakeBranch{"sure", "yes"},
			Desc: "任务归到分类给出的项目", Config: map[string]string{"task": task, "project": "{{extracted.project_id}}"}},
		{Key: "ask_stage", Name: "阶段改为待确认项目", Kind: NodeSetTaskStage, After: []string{"sure"}, Branch: &intakeBranch{"sure", "no"},
			Config: map[string]string{"task": task, "stage": "confirm_project"}},
		{Key: "ask", Name: "问提出人归哪个项目", Kind: NodeReplyMessage, After: []string{"ask_stage"}, Desc: "在原消息的串里列出候选项目",
			Config: map[string]string{"message": "{{message_id}}", "text": "这条需求（{{task.ref}}）我拿不准该归到哪个项目，可能是：\n{{extracted.candidates_text}}\n回复项目名或编号就行。"}},
		{Key: "wait", Name: "等提出人回复", Kind: NodeWaitReply, After: []string{"ask"}, Desc: "等会话里对方的下一条消息",
			Config: map[string]string{"conversation": "{{conversation_id}}", "timeout": "2 天"}},
		{Key: "pick", Name: "认出选的项目", Kind: "ai", After: []string{"wait"}, Desc: pickAsk, Config: map[string]string{"output": "picked"}},
		{Key: "bind_pick", Name: "绑定项目", Kind: NodeSetTaskStage, After: []string{"pick"}, Desc: "任务归到提出人选的项目",
			Config: map[string]string{"task": task, "project": "{{picked}}"}},
		{Key: "profile", Name: "读项目档案", Kind: "projects_get_profile", After: []string{"bind_auto", "bind_pick"},
			Desc: "取绑定项目的原型库、PRD、代码库目录", Config: map[string]string{"project": "{{project.id}}"}},
		{Key: "design", Name: "阶段改为设计中", Kind: NodeSetTaskStage, After: []string{"profile"}, Desc: "评审退回时也从这里重来",
			Config: map[string]string{"task": task, "stage": "designing"}},
		{Key: "prd", Name: "产品：写 PRD 和原型", Kind: "claude_code", After: []string{"design"}, Desc: "Claude Code 按产品角色在原型库目录写 PRD、更新原型与规格",
			Config: map[string]string{"preset": "rp_pm", "workdir": "{{profile.dirs.prototype}}", "prompt": pmPrompt, "task": task, "permission": "", "timeout": "2 小时"}},
		{Key: "to_review", Name: "阶段改为评审中", Kind: NodeSetTaskStage, After: []string{"prd"}, Config: map[string]string{"task": task, "stage": "reviewing"}},
		{Key: "review", Name: "研发评审", Kind: "claude_code", After: []string{"to_review"}, Desc: "Claude Code 按研发评审角色只读评审，回报 verdict 和 issues",
			Config: map[string]string{"preset": "rp_review", "workdir": "{{profile.dirs.code}}", "prompt": reviewPrompt, "task": task, "permission": "read", "timeout": "1 小时"}},
		{Key: "gate", Name: "评审不通过就退回", Kind: "loopback", After: []string{"review"}, Rule: "result.verdict 等于 reject",
			Desc: "不通过退回「阶段改为设计中」重写，意见作为 feedback 带回去；最多 3 轮", Cases: []intakeCase{{"pass", "通过"}, {"over", "超限"}},
			Config: map[string]string{"target": "design", "max_rounds": "3"}},
		{Key: "dev", Name: "阶段改为开发中", Kind: NodeSetTaskStage, After: []string{"gate"}, Branch: &intakeBranch{"gate", "pass"},
			Config: map[string]string{"task": task, "stage": "developing"}},
		{Key: "tell_dev", Name: "告诉提出人进入开发", Kind: NodeReplyMessage, After: []string{"dev"},
			Config: map[string]string{"message": "{{message_id}}", "text": "需求 {{task.ref}} 设计评审通过，进入开发。进度：{{task.url}}"}},
		// 接研发 pipeline（AUTO-09）：子流程的输入就是这一步的输入，研发 pipeline 要 task_id，先用模板写出来
		{Key: "pipeline_in", Name: "交给研发 pipeline", Kind: "template", After: []string{"tell_dev"}, Desc: "把任务 id 写成 task_id，研发 pipeline 按它取任务",
			Config: map[string]string{"template": "{{task.id}}", "output": "task_id"}},
		{Key: "pipeline_args", Name: "只带任务和来源消息", Kind: "end", After: []string{"pipeline_in"},
			Desc:   "子流程拿这一步的输出当输入：只留 task_id、message_id、conversation_id，评审的 summary、feedback 不带进研发",
			Config: map[string]string{"outputs": "task_id, message_id, conversation_id"}},
		{Key: "pipeline", Name: "研发 pipeline", Kind: "subflow", After: []string{"pipeline_args"},
			Desc:   "开发、测试、通知验收、人工验收；这一步等研发 pipeline 走完",
			Config: map[string]string{"sop": DevPipelineFlowID}},
		{Key: "human_stage", Name: "阶段改为需人工", Kind: NodeSetTaskStage, After: []string{"gate"}, Branch: &intakeBranch{"gate", "over"},
			Config: map[string]string{"task": task, "stage": "need_human"}},
		{Key: "human", Name: "人工裁决", Kind: "review", After: []string{"human_stage"}, Desc: "退回 3 轮仍不通过：看评审意见决定放行还是打回"},
	}
	fields := []map[string]any{
		{"key": "message_id", "label": "IM 消息", "type": "text", "required": true, "placeholder": "消息 id；IM 触发时自动带上"},
		{"key": "conversation_id", "label": "会话", "type": "text", "placeholder": "留空取消息所在的会话"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: AutoIntakeFlowID, Name: "IM 需求自动受理", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "IM 消息是需求就建任务、回执需求方，按项目档案分类（拿不准问提出人），Claude Code 写 PRD、研发评审，不通过自动退回最多 3 轮，通过后进入开发，接着走研发 pipeline。" +
			"默认停用：触发方式是「手动」，把触发方式改成「IM 消息」才会自动处理新消息",
	}
}

// installIntake 先写「原型同步」（AUTO-11），再把内置流程「发布 pipeline」「研发 pipeline」「IM 需求自动受理」依次写进 SOP（后一条末尾以子流程接前一条，所以倒着写），
// 写过一次（含已有同 id 的）记下来，之后不再写，用户删了也不补回来。SOP 插件没在跑、项目插件没装或版本旧（节点类型不认）时下次再试。
// 以前写过第 1 版研发 pipeline 的，换成接发布 pipeline 的版本（releasepipeline.go 的 upgradeDevPipeline）；
// 以前写过第 1 版受理流程的，换成接研发 pipeline 的版本（devpipeline.go 的 upgradeIntake）。
func (in *inbox) installIntake(ctx context.Context, c plugin.Core) error {
	// 原型同步（AUTO-11，protosync.go）不在这条链上，单独写；项目插件旧版（没有原型同步节点）时下次再试
	if _, err := in.installOnce(ctx, c, protoSyncFlow()); err != nil {
		c.Log().Warn("im proto sync flow install failed", "err", err)
	}
	// 来消息确认派发（TSK-0411，taskconfirm.go）也不在这条链上，单独写；SOP 插件旧版（不认 task_update、task_run）时下次再试。
	// 第 1 版没有「回执需求方」（TSK-0467）：没改过的换成新版，改过的不动、发一条通知提示（taskack.go 的 installAcked）
	if err := in.installAcked(ctx, c, taskConfirmFlow(), confirmAckMark); err != nil {
		c.Log().Warn("im task confirm flow install failed", "err", err)
	}
	// 「IM 任务回执」只回状态和结果（TSK-0470，taskreply.go）：写过的旧版没改过就换新版，改过的发通知提示
	if err := in.upgradeTaskReply(ctx, c); err != nil {
		c.Log().Warn("im task reply flow upgrade failed", "err", err)
	}
	// FDE 反馈转发（TSK-0468，fdeforward.go）：单独写，只写一次
	if _, err := in.installOnce(ctx, c, fdeForwardFlow()); err != nil {
		c.Log().Warn("im fde forward flow install failed", "err", err)
	}
	ok, err := in.installOnce(ctx, c, releasePipelineFlow())
	if err != nil {
		c.Log().Warn("im release pipeline flow install failed", "err", err)
		return nil
	}
	if !ok {
		return nil
	}
	hadDev, err := in.templateDone(ctx, c, DevPipelineFlowID)
	if err != nil {
		return err
	}
	if !hadDev {
		if _, err := in.installOnce(ctx, c, devPipelineFlow()); err != nil {
			c.Log().Warn("im dev pipeline flow install failed", "err", err)
			return nil
		}
		if ok, err := in.templateDone(ctx, c, DevPipelineFlowID); err != nil || !ok {
			return err
		}
		if err := in.markTemplate(ctx, c, devPipelineUpgradeMark); err != nil {
			return err
		}
	} else if done, err := in.templateDone(ctx, c, devPipelineUpgradeMark); err != nil {
		return err
	} else if !done {
		if err := in.upgradeDevPipeline(ctx, c); err != nil {
			c.Log().Warn("im dev pipeline flow upgrade failed", "err", err)
		}
	}
	had, err := in.templateDone(ctx, c, AutoIntakeFlowID)
	if err != nil {
		return err
	}
	if !had {
		if _, err := in.installOnce(ctx, c, intakeFlow()); err != nil {
			c.Log().Warn("im auto intake flow install failed", "err", err)
			return nil
		}
		if ok, err := in.templateDone(ctx, c, AutoIntakeFlowID); err != nil || !ok {
			return err
		}
		if err := in.markTemplate(ctx, c, intakeUpgradeMark); err != nil {
			return err
		}
		return in.markTemplate(ctx, c, intakeAckMark)
	}
	if done, err := in.templateDone(ctx, c, intakeUpgradeMark); err != nil {
		return err
	} else if !done {
		if err := in.upgradeIntake(ctx, c); err != nil {
			c.Log().Warn("im auto intake flow upgrade failed", "err", err)
		}
		return nil
	}
	// 接研发 pipeline 的版本还没有「回执需求方」（TSK-0467）：同样没改过的换成新版，改过的不动、发通知提示
	if done, err := in.templateDone(ctx, c, intakeAckMark); err != nil || done {
		return err
	}
	if err := in.upgradeAck(ctx, c, intakeFlow(), intakeAckMark); err != nil {
		c.Log().Warn("im auto intake flow ack upgrade failed", "err", err)
	}
	return nil
}
