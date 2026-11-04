package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 发布 pipeline（AUTO-10，docs/auto-delivery-flow.md 第 1 节第 9 段）。
//
// 内置流程「发布 pipeline」（sop_im_release_pipeline）同研发 pipeline 一样由后台任务 sop_templates 写进 SOP，写过一次记在 im_sop_templates，
// 用户删了不补回来；触发方式「手动」即默认停用：手动发起（输入任务 id），或由研发 pipeline 验收通过分支末尾的子流程接上。
// 步骤见 releasePipelineFlow：阶段改为待发布 → 准备发布（版本号与更新日志、打包，只在工作区里跑）→ 通知审批 → 人工审批（decide）
// → 批准后才上线（发布前检查、发布、线上冒烟，冒烟没过项目插件自动回滚）→ 成功阶段改为已上线、回复原消息；失败需人工、通知。
// 「审批前不动生产」靠两层：流程里上线节点只接在人工审批的「批准」分支后；项目插件的上线只认准备好（prepared）的发布。
//
// 研发 pipeline 第 1 版的验收通过分支以「结束」收尾，没接发布：已经写进 SOP 的、还是第 1 版、没有进行中执行、没被定时任务引用的，
// 撤下重写成新版（末尾以子流程接发布 pipeline）；改过的不动。做过一次记一个标记行（devPipelineUpgradeMark），不加迁移。

const (
	// ReleasePipelineFlowID 是内置流程「发布 pipeline」的 id。
	ReleasePipelineFlowID = "sop_im_release_pipeline"

	// devPipelineUpgradeMark 记在 im_sop_templates 里，表示「研发 pipeline」已经换成接发布 pipeline 的版本（或者用户改过、删了，不再换）。
	devPipelineUpgradeMark = DevPipelineFlowID + "#release"
)

const approveText = `需求 {{task.ref}}「{{task.title}}」已打包，等上线审批。
版本：{{release.version}}
更新日志：
{{release.changelog}}

发布报告（含审批后要跑的发布前检查、发布、线上冒烟命令）：{{release.report_url}}
负责人：{{profile.owners_text}}
看板：{{task.url}}
到 SOP 执行页的「上线审批」选「批准上线」或「暂缓」。`

const releasedText = `需求 {{task.ref}}「{{task.title}}」已上线，版本 {{release.version}}。
更新日志：
{{release.changelog}}
看板：{{task.url}}`

const releaseFailText = `需求 {{task.ref}}「{{task.title}}」上线没成功：{{release.text}}
发布报告：{{release.report_url}}
负责人：{{profile.owners_text}}
看板：{{task.url}}`

// releasePipelineFlow 是内置流程「发布 pipeline」。触发方式「手动」即默认停用。
func releasePipelineFlow() plugin.SOPFlowTemplate {
	task := "{{task.id}}"
	stage := func(key, name, after, value, desc string, br *intakeBranch) intakeStep {
		return intakeStep{Key: key, Name: name, Kind: NodeSetTaskStage, After: []string{after}, Branch: br, Desc: desc,
			Config: map[string]string{"task": task, "stage": value}}
	}
	notify := func(key, name, after, title, text, level string, reply bool, br *intakeBranch) intakeStep {
		cfg := map[string]string{"task": task, "title": title, "text": text, "level": level}
		if reply {
			cfg["message"] = "{{message_id}}"
		}
		return intakeStep{Key: key, Name: name, Kind: NodeNotify, After: []string{after}, Branch: br, Config: cfg}
	}
	steps := []intakeStep{
		{Key: "start", Name: "阶段改为待发布", Kind: NodeSetTaskStage, After: []string{}, Desc: "取任务信息（编号、标题、所属项目、看板链接）",
			Config: map[string]string{"task": "{{task_id}}", "stage": "releasing"}},
		{Key: "profile", Name: "读项目档案", Kind: "projects_get_profile", After: []string{"start"}, Desc: "取负责人，通知审批和失败时用",
			Config: map[string]string{"project": "{{task.project_id}}"}},
		{Key: "prepare", Name: "版本号、更新日志与打包", Kind: "projects_prepare_release", After: []string{"profile"},
			Desc:   "按项目档案在任务的工作区里跑版本号与更新日志、打包两步，只在工作区里跑，不碰生产；跑完定下审批后要跑的命令，等审批",
			Config: map[string]string{"task": task}},
		{Key: "prep_gate", Name: "打包成了吗", Kind: "decide", After: []string{"prepare"}, Rule: "release.ok 等于 true",
			Cases: []intakeCase{{"ok", "成了"}, {"fail", "没成"}}},
		// 打包没成：转人工
		stage("prep_human_stage", "阶段改为需人工", "prep_gate", "need_human", "", &intakeBranch{"prep_gate", "fail"}),
		notify("prep_human_notify", "通知：打包没成", "prep_human_stage", "{{task.ref}} 打包没成",
			"需求 {{task.ref}}「{{task.title}}」发布准备没成：{{release.text}}\n发布报告：{{release.report_url}}\n看板：{{task.url}}", "error", false, nil),
		{Key: "prep_end", Name: "结束", Kind: "end", After: []string{"prep_human_notify"}, Desc: "修好后重新发起发布 pipeline"},
		// 打包成了：通知审批
		notify("ask_approve", "通知负责人审批", "prep_gate", "{{task.ref}} 待上线审批", approveText, "info", false, &intakeBranch{"prep_gate", "ok"}),
		{Key: "approve", Name: "上线审批", Kind: "decide", After: []string{"ask_approve"},
			Desc:  "人工确认：看发布报告里的版本、更新日志和审批后要跑的命令，批准才会动生产；暂缓则这次不上线，阶段保持待发布",
			Cases: []intakeCase{{"approve", "批准上线"}, {"hold", "暂缓"}}},
		// 暂缓
		notify("hold_notify", "通知：暂缓上线", "approve", "{{task.ref}} 暂缓上线",
			"需求 {{task.ref}}「{{task.title}}」上线审批选了暂缓，这次不上线，阶段保持待发布；要上线时重新发起发布 pipeline。看板：{{task.url}}", "info", false,
			&intakeBranch{"approve", "hold"}),
		{Key: "hold_end", Name: "结束", Kind: "end", After: []string{"hold_notify"}},
		// 批准：上线
		{Key: "deploy", Name: "备份、核对密钥、发布、线上冒烟", Kind: "projects_release", After: []string{"approve"}, Branch: &intakeBranch{"approve", "approve"},
			Desc:   "按项目档案跑发布前检查（备份数据库、核对密钥）、发布、线上冒烟；发布或冒烟没过自动回滚",
			Config: map[string]string{"release": "{{release.id}}"}},
		{Key: "deploy_gate", Name: "上线成功了吗", Kind: "decide", After: []string{"deploy"}, Rule: "release.ok 等于 true",
			Cases: []intakeCase{{"ok", "成功"}, {"fail", "没成功"}}},
		// 成功：已上线，回复原消息
		stage("stage_released", "阶段改为已上线", "deploy_gate", "released", "工作区随之清理", &intakeBranch{"deploy_gate", "ok"}),
		notify("tell_released", "回复原消息：已上线", "stage_released", "{{task.ref}} 已上线", releasedText, "success", true, nil),
		{Key: "done", Name: "结束", Kind: "end", After: []string{"tell_released"}},
		// 失败（已回滚或回滚也没成）：需人工、通知
		stage("fail_stage", "阶段改为需人工", "deploy_gate", "need_human", "", &intakeBranch{"deploy_gate", "fail"}),
		notify("fail_notify", "通知：上线没成功", "fail_stage", "{{task.ref}} 上线没成功", releaseFailText, "error", false, nil),
		{Key: "fail_end", Name: "结束", Kind: "end", After: []string{"fail_notify"}, Desc: "看发布报告处理；修好后重新发起发布 pipeline"},
	}
	fields := []map[string]any{
		{"key": "task_id", "label": "任务", "type": "text", "required": true, "placeholder": "任务 id；任务要有在用的工作区，项目档案里设了发布命令"},
		{"key": "message_id", "label": "来源消息", "type": "text", "placeholder": "IM 消息 id，上线后在原消息里回复提出人"},
		{"key": "conversation_id", "label": "会话", "type": "text", "placeholder": "来源消息所在的会话，可空"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID: ReleasePipelineFlowID, Name: "发布 pipeline", Trigger: "manual", Fields: fb, Steps: sb,
		Desc: "版本号与更新日志、打包，通知负责人上线审批；批准后备份与核对密钥、发布、线上冒烟，冒烟没过自动回滚并通知；成功后阶段改为已上线、回复原 IM 消息。" +
			"审批前不跑任何动生产的命令。默认停用：手动发起，或由「研发 pipeline」验收通过后接上",
	}
}

// upgradeDevPipeline 把第 1 版的「研发 pipeline」换成验收通过后接发布 pipeline 的版本，做法同 upgradeIntake：
// 还是第 1 版、没有进行中执行、没被定时任务引用的撤下重写；改过的、被用户删掉的不动，记标记不再试；有进行中执行、被定时任务引用的下次再试。
func (in *inbox) upgradeDevPipeline(ctx context.Context, c plugin.Core) error {
	removed, why, err := c.SOP().RemoveFlow(ctx, DevPipelineFlowID)
	if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
		return nil
	}
	if err != nil {
		return err
	}
	switch {
	case removed:
		if _, err := c.SOP().InstallFlow(ctx, devPipelineFlow()); err != nil {
			return fmt.Errorf("重写「研发 pipeline」失败：%w", err)
		}
		c.Log().Info("im dev pipeline flow upgraded to hand off to release pipeline", "flow", DevPipelineFlowID)
	case why == "":
		// 用户删掉了：不补回来
	case strings.Contains(why, "改过"):
		c.Log().Info("im dev pipeline flow edited by user, not upgraded", "flow", DevPipelineFlowID, "why", why)
	default:
		c.Log().Info("im dev pipeline flow upgrade postponed", "flow", DevPipelineFlowID, "why", why)
		return nil
	}
	return in.markTemplate(ctx, c, devPipelineUpgradeMark)
}
