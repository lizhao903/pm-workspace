// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 每录音一个文件夹（M4a，设计 §13.1）：attachments/recording/<id>/ 下固定这几个文件名，
// 「重命名」只改标题，不动磁盘上的文件名。GET /files 现查磁盘；写文件用 tmp + rename，
// 失败只记日志不挡主流程（DB 是唯一真源，文件可以从 DB/JSON 重新导出）。

const (
	fileTranscript  = "transcript.md"
	fileMinutesMD   = "minutes.md"
	fileMinutesJSON = "minutes.json"
	fileFlowMMD     = "diagrams/flow.mmd"
	fileTreeMMD     = "diagrams/tree.mmd"
)

// recordingFileKinds 是文件白名单：下载接口只认这几个名字（相对录音目录）。
var recordingFileKinds = map[string]string{
	fileTranscript:  "transcript",
	fileMinutesMD:   "minutes",
	fileMinutesJSON: "minutes_json",
	fileFlowMMD:     "diagram_flow",
	fileTreeMMD:     "diagram_tree",
}

// listRecordingFiles 现查磁盘，返回录音目录里已生成的文件（按白名单顺序）。
func listRecordingFiles(c plugin.Core, recordingID string) []RecordingFile {
	out := []RecordingFile{}
	dir := audioDir(c, recordingID)
	for _, name := range []string{fileTranscript, fileMinutesMD, fileMinutesJSON, fileFlowMMD, fileTreeMMD} {
		fi, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		out = append(out, RecordingFile{
			Name:      name,
			Kind:      recordingFileKinds[name],
			Bytes:     fi.Size(),
			UpdatedAt: fi.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	return out
}

// recordingFilePath 是白名单文件在磁盘上的绝对路径；name 不在白名单回空串（防路径穿越）。
func recordingFilePath(c plugin.Core, recordingID, name string) string {
	if _, ok := recordingFileKinds[name]; !ok {
		return ""
	}
	return filepath.Join(audioDir(c, recordingID), filepath.FromSlash(name))
}

// writeRecordingFile 写一个生成的文件：先建目录、写 .tmp 再改名。
func writeRecordingFile(c plugin.Core, recordingID, name string, data []byte) error {
	abs := recordingFilePath(c, recordingID, name)
	if abs == "" {
		return fmt.Errorf("不认识的文件名：%s", name)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	tmp := abs + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// writeTranscriptFile 写 transcript.md：标题 + 时长/模型/时间头 + 全文。
// 转写成功、PATCH 改全文、重新生成纪要时调；失败只记日志。
func writeTranscriptFile(c plugin.Core, rec recordingRow) {
	body := transcriptMarkdown(rec)
	if err := writeRecordingFile(c, rec.ID, fileTranscript, []byte(body)); err != nil {
		c.Log().Warn("recording: 写 transcript.md 失败", "recording", rec.ID, "err", err)
	}
}

// transcriptMarkdown 是 transcript.md 的内容（纯函数，方便单测）。
func transcriptMarkdown(rec recordingRow) string {
	var b strings.Builder
	title := strings.TrimSpace(rec.Title)
	if title == "" {
		title = rec.ID
	}
	fmt.Fprintf(&b, "# %s\n\n", title)
	fmt.Fprintf(&b, "- 时长：%s\n", formatDurationMS(rec.DurationMs))
	if rec.Model != "" {
		fmt.Fprintf(&b, "- 模型：%s\n", rec.Model)
	}
	if rec.Language != "" {
		fmt.Fprintf(&b, "- 语言：%s\n", rec.Language)
	}
	if rec.UpdatedAt != "" {
		fmt.Fprintf(&b, "- 更新时间：%s\n", rec.UpdatedAt)
	}
	b.WriteString("\n---\n\n")
	b.WriteString(strings.TrimRight(rec.Transcript, "\n"))
	b.WriteString("\n")
	return b.String()
}

// writeMinutesFiles 写 minutes.md / minutes.json / diagrams/*.mmd；任何一份写失败只记日志。
func writeMinutesFiles(c plugin.Core, rec recordingRow, mins RecordingMinutes) {
	if err := writeRecordingFile(c, rec.ID, fileMinutesMD, []byte(minutesMarkdown(rec, mins))); err != nil {
		c.Log().Warn("recording: 写 minutes.md 失败", "recording", rec.ID, "err", err)
	}
	if body, err := json.MarshalIndent(mins, "", "  "); err != nil {
		c.Log().Warn("recording: 序列化 minutes.json 失败", "recording", rec.ID, "err", err)
	} else if err := writeRecordingFile(c, rec.ID, fileMinutesJSON, append(body, '\n')); err != nil {
		c.Log().Warn("recording: 写 minutes.json 失败", "recording", rec.ID, "err", err)
	}
	if mmd := mermaidFlow(mins.Diagrams.Flow); mmd != "" {
		if err := writeRecordingFile(c, rec.ID, fileFlowMMD, []byte(mmd)); err != nil {
			c.Log().Warn("recording: 写 diagrams/flow.mmd 失败", "recording", rec.ID, "err", err)
		}
	}
	if mmd := mermaidTree(mins.Diagrams.Tree); mmd != "" {
		if err := writeRecordingFile(c, rec.ID, fileTreeMMD, []byte(mmd)); err != nil {
			c.Log().Warn("recording: 写 diagrams/tree.mmd 失败", "recording", rec.ID, "err", err)
		}
	}
}

// minutesMarkdown 把结构化纪要排成给人看的 Markdown（纯函数，方便单测）。
func minutesMarkdown(rec recordingRow, mins RecordingMinutes) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 会议纪要：%s\n\n", strings.TrimSpace(rec.Title))
	b.WriteString(strings.TrimSpace(mins.SummaryMD))
	b.WriteString("\n")
	if len(mins.Conclusions) > 0 {
		b.WriteString("\n## 结论\n\n")
		for _, c := range mins.Conclusions {
			fmt.Fprintf(&b, "- %s\n", c)
		}
	}
	if len(mins.Actions) > 0 {
		b.WriteString("\n## 待办\n\n")
		for _, a := range mins.Actions {
			fmt.Fprintf(&b, "- **%s**", a.Title)
			var meta []string
			if a.Owner != "" {
				meta = append(meta, "负责人："+a.Owner)
			}
			if a.Due != "" {
				meta = append(meta, "截止："+a.Due)
			}
			if a.Project != "" {
				meta = append(meta, "项目："+a.Project)
			}
			meta = append(meta, fmt.Sprintf("置信度：%.2f", a.Confidence))
			fmt.Fprintf(&b, "（%s）\n", strings.Join(meta, "，"))
			if a.Detail != "" {
				fmt.Fprintf(&b, "  %s\n", a.Detail)
			}
		}
	}
	if len(mins.Projects) > 0 {
		b.WriteString("\n## 项目\n\n")
		for _, p := range mins.Projects {
			fmt.Fprintf(&b, "- %s（置信度 %.2f）", p.Name, p.Confidence)
			if p.Reason != "" {
				fmt.Fprintf(&b, "：%s", p.Reason)
			}
			b.WriteString("\n")
		}
	}
	if len(mins.Goals) > 0 {
		b.WriteString("\n## 目标\n\n")
		for _, g := range mins.Goals {
			fmt.Fprintf(&b, "- %s（置信度 %.2f）", g.Title, g.Confidence)
			if g.Reason != "" {
				fmt.Fprintf(&b, "：%s", g.Reason)
			}
			b.WriteString("\n")
		}
	}
	if len(mins.Questions) > 0 {
		b.WriteString("\n## 需要你确认\n\n")
		for _, q := range mins.Questions {
			fmt.Fprintf(&b, "- %s", q.Question)
			if q.Why != "" {
				fmt.Fprintf(&b, "（%s）", q.Why)
			}
			b.WriteString("\n")
		}
	}
	if mmd := mermaidFlow(mins.Diagrams.Flow); mmd != "" {
		b.WriteString("\n## 讨论脉络\n\n```mermaid\n")
		b.WriteString(mmd)
		b.WriteString("```\n")
	}
	if mmd := mermaidTree(mins.Diagrams.Tree); mmd != "" {
		b.WriteString("\n## 项目 / 任务树\n\n```mermaid\n")
		b.WriteString(mmd)
		b.WriteString("```\n")
	}
	b.WriteString("\n---\n\n")
	if mins.GeneratedAt != "" {
		fmt.Fprintf(&b, "生成时间：%s", mins.GeneratedAt)
	}
	if mins.Model != "" {
		fmt.Fprintf(&b, "；模型：%s", mins.Model)
	}
	b.WriteString("\n")
	return b.String()
}

// formatDurationMS 把毫秒排成 mm:ss（超过 1 小时是 h:mm:ss）。
func formatDurationMS(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	total := ms / 1000
	h := total / 3600
	m := (total % 3600) / 60
	s := total % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}

// mermaidText 清理标签里会破坏 mermaid 语法的字符。
var mermaidReplacer = strings.NewReplacer(
	"\r", "", "\n", " ", "\"", "'", "|", "｜", "[", "（", "]", "）", "{", "｛", "}", "｝",
)

func mermaidText(s string) string {
	return strings.TrimSpace(mermaidReplacer.Replace(s))
}

// mermaidFlow 把流程图导出成 mermaid 源码（flowchart TD）。节点没有 id 时按顺序补。
func mermaidFlow(f RecordingFlow) string {
	nodes := f.Nodes
	if len(nodes) == 0 {
		return ""
	}
	var b strings.Builder
	if title := mermaidText(f.Title); title != "" {
		b.WriteString("%% " + title + "\n")
	}
	b.WriteString("flowchart TD\n")
	ids := make(map[string]string, len(nodes))
	for i, n := range nodes {
		id := "n" + strconv.Itoa(i)
		if n.ID != "" {
			if _, dup := ids[n.ID]; !dup {
				ids[n.ID] = id
			}
		}
		label := mermaidText(n.Label)
		switch n.Kind {
		case "start", "end":
			fmt.Fprintf(&b, "  %s([%s])\n", id, quoteLabel(label))
		case "decision":
			fmt.Fprintf(&b, "  %s{%s}\n", id, quoteLabel(label))
		default:
			fmt.Fprintf(&b, "  %s[%s]\n", id, quoteLabel(label))
		}
	}
	for _, e := range f.Edges {
		from, to := ids[e.From], ids[e.To]
		if from == "" || to == "" {
			continue
		}
		if label := mermaidText(e.Label); label != "" {
			fmt.Fprintf(&b, "  %s -->|%s| %s\n", from, label, to)
		} else {
			fmt.Fprintf(&b, "  %s --> %s\n", from, to)
		}
	}
	return b.String()
}

// mermaidTree 把树形图导出成 mermaid 源码（graph TD）。深度最多 3 层，和纪要解析一致。
func mermaidTree(t RecordingTree) string {
	if strings.TrimSpace(t.Root.Label) == "" && len(t.Root.Children) == 0 {
		return ""
	}
	var b strings.Builder
	if title := mermaidText(t.Title); title != "" {
		b.WriteString("%% " + title + "\n")
	}
	b.WriteString("graph TD\n")
	next := 0
	var walk func(n RecordingTreeNode, parent string, depth int)
	walk = func(n RecordingTreeNode, parent string, depth int) {
		id := "t" + strconv.Itoa(next)
		next++
		fmt.Fprintf(&b, "  %s[%s]\n", id, quoteLabel(mermaidText(n.Label)))
		if parent != "" {
			fmt.Fprintf(&b, "  %s --> %s\n", parent, id)
		}
		if depth >= 3 {
			return
		}
		for _, child := range n.Children {
			walk(child, id, depth+1)
		}
	}
	walk(t.Root, "", 1)
	return b.String()
}

// quoteLabel 给 mermaid 节点标签加引号，空标签也合法。
func quoteLabel(label string) string {
	return "\"" + strings.ReplaceAll(label, "\"", "'") + "\""
}
