package projects

import (
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// 测试报告（AUTO-08）：一次测试写一份 Markdown，放在这次测试的目录（数据目录 test-reports/…/<测试 id>/report.md），
// 截图按相对路径 out/<名字> 引用，报告和 out/ 放一起挪也能看。junit xml 只汇总用例数和没通过的用例名。

// collectJunit 汇总约定报告目录里的 junit xml（递归，最多 maxJunitFiles 个、每个不超过 maxJunitSize）。
// 按 testcase 元素数：下面有 failure 算失败、error 算错误、skipped 算跳过。一个 testcase 都没有的 xml 不算 junit。没有时回 nil。
func collectJunit(dir string) *JunitSummary {
	var files []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || len(files) >= maxJunitFiles || !d.Type().IsRegular() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(p), ".xml") {
			files = append(files, p)
		}
		return nil
	})
	slices.Sort(files)
	var sum JunitSummary
	sum.Failed = []string{}
	for _, f := range files {
		if st, err := os.Stat(f); err != nil || st.Size() > maxJunitSize {
			continue
		}
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		n := parseJunit(fh, &sum)
		_ = fh.Close()
		if n > 0 {
			sum.Files++
		}
	}
	if sum.Files == 0 {
		return nil
	}
	return &sum
}

// parseJunit 数一个 xml 里的 testcase，回数到几个。坏掉的 xml 数到哪算哪。
func parseJunit(r io.Reader, sum *JunitSummary) int {
	dec := xml.NewDecoder(r)
	dec.Strict = false
	n := 0
	var cur string // 当前 testcase 的名字
	var outcome string
	inCase := false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "testcase":
				inCase, outcome = true, ""
				cur = attr(t, "name")
				if c := attr(t, "classname"); c != "" && cur != "" {
					cur = c + " › " + cur
				}
			case "failure", "error", "skipped":
				if inCase && outcome == "" {
					outcome = t.Name.Local
				}
			}
		case xml.EndElement:
			if t.Name.Local != "testcase" || !inCase {
				continue
			}
			inCase = false
			n++
			sum.Tests++
			switch outcome {
			case "failure":
				sum.Failures++
			case "error":
				sum.Errors++
			case "skipped":
				sum.Skipped++
			}
			if (outcome == "failure" || outcome == "error") && len(sum.Failed) < maxFailedCases {
				sum.Failed = append(sum.Failed, oneLine(cur, 200))
			}
		}
	}
	return n
}

func attr(e xml.StartElement, name string) string {
	for _, a := range e.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

var stepStatusLabel = map[string]string{
	stPending: "没跑", stRunning: "在跑", stPassed: "通过", stFailed: "没通过", stSkipped: "跳过", stStopped: "已停止",
}

// renderReport 写报告正文。
func renderReport(r TestRun, taskTitle, branch string) string {
	var b strings.Builder
	title := r.TaskRef
	if taskTitle != "" {
		title += " " + taskTitle
	}
	fmt.Fprintf(&b, "# 测试报告：%s\n\n", oneLine(title, 200))
	res := statusLabel(r.Status)
	if r.FailedStep != "" {
		res += "（在「" + testStepLabels[r.FailedStep] + "」这一步）"
	}
	fmt.Fprintf(&b, "- 结果：**%s**\n", res)
	if r.Error != "" {
		fmt.Fprintf(&b, "- 原因：%s\n", oneLine(r.Error, 500))
	}
	fmt.Fprintf(&b, "- 工作区：`%s`", r.Workdir)
	if branch != "" {
		fmt.Fprintf(&b, "（分支 `%s`）", branch)
	}
	b.WriteString("\n")
	fmt.Fprintf(&b, "- 端口：%d（端口段 %d–%d）\n", r.Port, r.PortStart, r.PortEnd)
	if r.URL != "" {
		if r.EnvState == envKept && r.EnvKeepUntil != nil {
			fmt.Fprintf(&b, "- 测试环境：%s（保留给人工验收，到 %s 自动回收）\n", r.URL, localTime(*r.EnvKeepUntil))
		} else {
			fmt.Fprintf(&b, "- 测试环境：%s（跑完已回收）\n", r.URL)
		}
	}
	loc := time.Local
	fmt.Fprintf(&b, "- 开始：%s", r.StartedAt.In(loc).Format("2006-01-02 15:04:05"))
	if r.FinishedAt != nil {
		fmt.Fprintf(&b, "，用时 %s", humanMs(r.FinishedAt.Sub(r.StartedAt).Milliseconds()))
	}
	b.WriteString("\n")
	fmt.Fprintf(&b, "- 测试编号：`%s`\n\n", r.ID)

	b.WriteString("## 步骤\n\n| 步骤 | 命令 | 结果 | 退出码 | 用时 |\n|---|---|---|---|---|\n")
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
		fmt.Fprintf(&b, "| %s | `%s` | %s | %s | %s |\n", st.Label, mdCell(st.Command), result, code, dur)
	}
	for _, st := range r.Steps {
		if st.StartedAt == nil {
			continue
		}
		fmt.Fprintf(&b, "\n### %s\n\n", st.Label)
		fmt.Fprintf(&b, "- 目录：`%s`\n", st.Dir)
		if st.Ready != "" {
			fmt.Fprintf(&b, "- 就绪检查：%s\n", st.Ready)
		}
		if st.Error != "" {
			fmt.Fprintf(&b, "- 说明：%s\n", oneLine(st.Error, 500))
		}
		if st.Output != "" {
			fence := codeFence(st.Output)
			fmt.Fprintf(&b, "\n输出尾部（最多 %d 行）：\n\n%stext\n%s\n%s\n", tailLines, fence, st.Output, fence)
		}
	}
	if r.Junit != nil {
		j := r.Junit
		fmt.Fprintf(&b, "\n## 用例汇总（junit）\n\n%d 个文件，%d 个用例：失败 %d，错误 %d，跳过 %d。\n", j.Files, j.Tests, j.Failures, j.Errors, j.Skipped)
		if len(j.Failed) > 0 {
			b.WriteString("\n没通过的用例：\n\n")
			for _, n := range j.Failed {
				fmt.Fprintf(&b, "- %s\n", n)
			}
		}
	}
	if len(r.Shots) > 0 {
		fmt.Fprintf(&b, "\n## 截图（%d 张）\n\n", len(r.Shots))
		for _, s := range r.Shots {
			fmt.Fprintf(&b, "![%s](%s/%s)\n\n", s, ReportOutDir, s)
		}
	}
	return b.String()
}

func mdCell(s string) string {
	s = oneLine(s, 300)
	s = strings.ReplaceAll(s, "|", "\\|")
	return strings.ReplaceAll(s, "`", "'")
}

// codeFence 是比输出里最长的一串反引号还长的围栏，输出里有 ``` 也不会把代码块提前关掉。
func codeFence(s string) string {
	longest, run := 0, 0
	for _, c := range s {
		if c == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	return strings.Repeat("`", max(3, longest+1))
}

func humanMs(ms int64) string {
	switch {
	case ms < 1000:
		return strconv.FormatInt(ms, 10) + " 毫秒"
	case ms < 60_000:
		return strconv.FormatFloat(float64(ms)/1000, 'f', 1, 64) + " 秒"
	}
	m := ms / 60_000
	s := (ms % 60_000) / 1000
	return fmt.Sprintf("%d 分 %d 秒", m, s)
}
