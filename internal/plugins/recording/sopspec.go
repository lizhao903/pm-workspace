// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import "github.com/lizhao903/pm-workspace/internal/plugin"

// SOP 节点的声明（TSK-0490）：每个节点做什么、认哪些配置、往输出里加哪些字段。
// Register 里用 plugin.WithSOPSpecs 包一层，登记节点时按 kind 补上（同视频插件的 sopspec.go）。
// 保存校验、编辑器的字段候选、AI 协助和 Agent 的节点目录都按它出稿。

var sopSpecs = map[string]plugin.SOPNodeSpec{
	NodeMinutes: {
		Effect: plugin.SOPEffectWrite,
		Label:  "生成会议纪要",
		Desc:   "用本机 Agent 把录音转写生成结构化纪要，写 minutes.md / minutes.json / diagrams/*.mmd，并提取候选",
		Params: []plugin.SOPParam{
			{Key: "recording", Label: "录音", Required: true, Template: true, Desc: "录音 id 或标题，比如 {{recording_id}}"},
			{Key: "provider", Label: "服务商", Desc: "空用设置里的纪要服务商"},
			{Key: "model", Label: "模型", Desc: "空用设置里的纪要模型"},
		},
		Outputs: []plugin.SOPOutput{
			{Path: "minutes", Type: "object", Label: "{recording_id, title, summary, conclusions_count, actions_count, files}"},
			{Path: "minutes.recording_id", Type: "string", Label: "录音 id"},
			{Path: "minutes.summary", Type: "string", Label: "纪要摘要（Markdown）"},
			{Path: "minutes.files", Type: "list", Label: "生成的文件名"},
		},
	},
	NodeExtract: {
		Effect: plugin.SOPEffectWrite,
		Label:  "提取会议候选",
		Desc:   "从已生成的纪要里提取候选项目/任务/目标，高置信度的推给用户确认",
		Params: []plugin.SOPParam{
			{Key: "recording", Label: "录音", Required: true, Template: true, Desc: "录音 id 或标题，比如 {{recording_id}}"},
		},
		Outputs: []plugin.SOPOutput{
			{Path: "recording_todos", Type: "object", Label: "{recording_id, pending_count, high_confidence_count, project_candidates, task_count}"},
			{Path: "recording_todos.pending_count", Type: "number", Label: "待确认候选数"},
			{Path: "recording_todos.high_confidence_count", Type: "number", Label: "高置信度候选数"},
		},
	},
}
