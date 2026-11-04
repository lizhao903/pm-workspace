package projects

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 发布报告（AUTO-10）：一次发布写一份 Markdown，放在这次发布的目录（数据目录 releases/…/<发布 id>/report.md）。
// 准备段跑完写一次（给审批的人看），上线段跑完重写。

var rollbackLabel = map[string]string{"": "不需要", rbDone: "已回滚", rbFailed: "回滚没成功", rbUnavailable: "档案里没有回滚命令，没有回滚"}

func renderReleaseReport(r Release, taskTitle, branch string) string {
	var b strings.Builder
	title := r.TaskRef
	if taskTitle != "" {
		title += " " + taskTitle
	}
	fmt.Fprintf(&b, "# 发布报告：%s\n\n", oneLine(title, 200))
	res := releaseStatusLabel(r.Status)
	if r.FailedStep != "" {
		res += "（在「" + releaseStepLabels[r.FailedStep] + "」这一步）"
	}
	fmt.Fprintf(&b, "- 结果：**%s**\n", res)
	if r.Error != "" {
		fmt.Fprintf(&b, "- 原因：%s\n", oneLine(r.Error, 500))
	}
	if r.Phase == phaseDeploy {
		fmt.Fprintf(&b, "- 回滚：%s\n", rollbackLabel[r.RollbackState])
	}
	if r.Version != "" {
		fmt.Fprintf(&b, "- 版本：`%s`\n", mdCell(r.Version))
	}
	fmt.Fprintf(&b, "- 工作区：`%s`", r.Workdir)
	if branch != "" {
		fmt.Fprintf(&b, "（分支 `%s`）", branch)
	}
	b.WriteString("\n")
	loc := time.Local
	fmt.Fprintf(&b, "- 开始：%s\n", r.StartedAt.In(loc).Format("2006-01-02 15:04:05"))
	if r.ApprovedAt != nil {
		fmt.Fprintf(&b, "- 上线审批：%s（%s）\n", r.ApprovedAt.In(loc).Format("2006-01-02 15:04:05"), r.ApprovedBy)
	} else if r.Status == rlPrepared {
		b.WriteString("- 上线审批：等审批，审批前不跑发布前检查、发布、线上冒烟\n")
	}
	if r.FinishedAt != nil {
		fmt.Fprintf(&b, "- 结束：%s\n", r.FinishedAt.In(loc).Format("2006-01-02 15:04:05"))
	}
	fmt.Fprintf(&b, "- 发布编号：`%s`\n", r.ID)
	if r.Changelog != "" {
		fmt.Fprintf(&b, "\n## 更新日志\n\n%s\n", r.Changelog)
	}

	b.WriteString("\n## 步骤\n\n| 步骤 | 阶段 | 命令 | 结果 | 退出码 | 用时 |\n|---|---|---|---|---|---|\n")
	for _, st := range r.Steps {
		code := "—"
		if st.ExitCode != nil {
			code = strconv.Itoa(*st.ExitCode)
		}
		dur := "—"
		if st.StartedAt != nil {
			dur = humanMs(st.DurationMs)
		}
		result := stepStatusLabel[st.Status]
		if st.TimedOut {
			result += "（超时）"
		}
		phase := "审批前"
		if st.Phase == phaseDeploy {
			phase = "审批后"
		}
		fmt.Fprintf(&b, "| %s | %s | `%s` | %s | %s | %s |\n", st.Label, phase, mdCell(st.Command), result, code, dur)
	}
	for _, st := range r.Steps {
		if st.StartedAt == nil {
			continue
		}
		fmt.Fprintf(&b, "\n### %s\n\n", st.Label)
		fmt.Fprintf(&b, "- 目录：`%s`\n", st.Dir)
		if st.Error != "" {
			fmt.Fprintf(&b, "- 说明：%s\n", oneLine(st.Error, 500))
		}
		if st.Output != "" {
			fence := codeFence(st.Output)
			fmt.Fprintf(&b, "\n输出尾部（最多 %d 行）：\n\n%stext\n%s\n%s\n", tailLines, fence, st.Output, fence)
		}
	}
	return b.String()
}
