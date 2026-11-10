// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import "github.com/lizhao903/pm-workspace/internal/plugin"

// SOP 节点的声明（TSK-0490）：每个节点做什么、认哪些配置、往输出里加哪些字段。保存校验、编辑器的「这一步能拿到的字段」、
// SOP 编排的 AI 协助和 Agent 建流程都按它出稿。Register 开头用 plugin.WithSOPSpecs 包一层，登记节点时按 kind 补上。

func stageOptions(checkpoint bool) []plugin.SOPOption {
	var out []plugin.SOPOption
	for _, s := range Stages {
		if s.Checkpoint == checkpoint {
			out = append(out, plugin.SOPOption{Value: s.Key, Label: s.Label})
		}
	}
	return out
}

var videoParam = plugin.SOPParam{Key: "video", Label: "视频", Required: true, Template: true, Desc: "视频 id，比如 {{video_id}}"}

var sopSpecs = map[string]plugin.SOPNodeSpec{
	NodeRunStage: {Effect: plugin.SOPEffectWrite, Label: "跑视频阶段", Desc: "用视频里这一阶段配的执行器跑一遍，跑完再往下走；没跑成这一步失败",
		Params: []plugin.SOPParam{videoParam, {Key: "stage", Label: "阶段", Required: true, Template: true, Options: stageOptions(false)}},
		Outputs: []plugin.SOPOutput{{Path: "stage_run", Type: "object", Label: "{video_id, title, stage, label, status, run_id, ref, artifact_ids, ended_at}"},
			{Path: "stage_run.status", Type: "string", Label: "执行状态"}, {Path: "stage_run.artifact_ids", Type: "list", Label: "产出物 id"}}},
	NodeWaitCheckpoint: {Effect: plugin.SOPEffectWait, Label: "等视频检查点", Desc: "停下等人在视频页通过这个检查点（已通过、已跳过的直接往下走）",
		Params: []plugin.SOPParam{videoParam, {Key: "checkpoint", Label: "检查点", Required: true, Template: true, Options: stageOptions(true)}},
		Outputs: []plugin.SOPOutput{{Path: "checkpoint", Type: "object", Label: "{video_id, title, stage, label, state, note, at}"},
			{Path: "checkpoint.state", Type: "string", Label: "检查点状态", Values: []plugin.SOPOption{{Value: "passed", Label: "通过"}, {Value: "skipped", Label: "跳过"}}},
			{Path: "checkpoint.note", Type: "string", Label: "检查意见"}}},
	NodePublish: {Effect: plugin.SOPEffectWrite, Label: "发布到平台", Desc: "按发布记录经连接器把视频发到平台",
		Params: []plugin.SOPParam{{Key: "publish", Label: "发布记录", Required: true, Template: true, Desc: "发布记录 id"}},
		Outputs: []plugin.SOPOutput{{Path: "publish", Type: "object", Label: "{publish_id, video_id, platform, title, status, url}"},
			{Path: "publish.status", Type: "string", Label: "发布状态"}, {Path: "publish.url", Type: "string", Label: "平台上的链接"}}},
}
