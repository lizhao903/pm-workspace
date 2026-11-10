// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"strings"
	"testing"
)

// mermaid 导出（设计 §13.3）：节点/边的形状对、脏字符清理掉、指向不存在节点的边丢掉。
func TestMermaidFlow(t *testing.T) {
	flow := RecordingFlow{
		Title: "讨论脉络",
		Nodes: []RecordingFlowNode{
			{ID: "a", Label: "现状", Kind: "start"},
			{ID: "b", Label: "Q4 上线", Kind: "process"},
			{ID: "c", Label: "预算够吗|[嗯]", Kind: "decision"},
			{ID: "d", Label: "结束", Kind: "end"},
		},
		Edges: []RecordingFlowEdge{
			{From: "a", To: "b", Label: "决定"},
			{From: "b", To: "c"},
			{From: "c", To: "d", Label: "是"},
			{From: "a", To: "nope", Label: "坏边"},
		},
	}
	got := mermaidFlow(flow)
	for _, want := range []string{
		"flowchart TD",
		`n0(["现状"])`,
		`n1["Q4 上线"]`,
		`n2{"预算够吗｜（嗯）"}`,
		`n3(["结束"])`,
		`n0 -->|决定| n1`,
		`n1 --> n2`,
		`n2 -->|是| n3`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("mermaid 里没有 %q：\n%s", want, got)
		}
	}
	if strings.Contains(got, "坏边") {
		t.Errorf("指向不存在节点的边应该丢掉：\n%s", got)
	}
	if !strings.HasPrefix(got, "%% 讨论脉络\n") {
		t.Errorf("标题应写成 mermaid 注释：\n%s", got)
	}
}

func TestMermaidFlowEmpty(t *testing.T) {
	if got := mermaidFlow(RecordingFlow{}); got != "" {
		t.Errorf("空流程图应回空串：%q", got)
	}
}

func TestMermaidFlowMissingNodeID(t *testing.T) {
	got := mermaidFlow(RecordingFlow{Nodes: []RecordingFlowNode{{Label: "匿名"}}})
	if !strings.Contains(got, `n0["匿名"]`) {
		t.Errorf("没有 id 的节点应自动补 id：\n%s", got)
	}
}

func TestMermaidTree(t *testing.T) {
	tree := RecordingTree{
		Title: "项目树",
		Root: RecordingTreeNode{Label: "官网改版", Children: []RecordingTreeNode{
			{Label: "方案"},
			{Label: "上线", Children: []RecordingTreeNode{{Label: "验收"}}},
		}},
	}
	got := mermaidTree(tree)
	for _, want := range []string{
		"graph TD",
		`t0["官网改版"]`,
		`t1["方案"]`,
		`t2["上线"]`,
		`t3["验收"]`,
		"t0 --> t1",
		"t0 --> t2",
		"t2 --> t3",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("mermaid 里没有 %q：\n%s", want, got)
		}
	}
	if got := mermaidTree(RecordingTree{}); got != "" {
		t.Errorf("空树应回空串：%q", got)
	}
}

func TestMermaidTreeDepthLimit(t *testing.T) {
	root := RecordingTreeNode{Label: "L1", Children: []RecordingTreeNode{{Label: "L2",
		Children: []RecordingTreeNode{{Label: "L3", Children: []RecordingTreeNode{{Label: "L4"}}}}}}}
	got := mermaidTree(RecordingTree{Root: root})
	if !strings.Contains(got, `t2["L3"]`) {
		t.Errorf("第 3 层应该导出：\n%s", got)
	}
	if strings.Contains(got, "L4") {
		t.Errorf("第 4 层应丢掉：\n%s", got)
	}
}

func TestFormatDurationMS(t *testing.T) {
	cases := map[int64]string{
		0:       "00:00",
		999:     "00:00",
		1000:    "00:01",
		65000:   "01:05",
		3599000: "59:59",
		3600000: "1:00:00",
		3661000: "1:01:01",
	}
	for ms, want := range cases {
		if got := formatDurationMS(ms); got != want {
			t.Errorf("formatDurationMS(%d) = %q，想要 %q", ms, got, want)
		}
	}
}

func TestTranscriptMarkdown(t *testing.T) {
	rec := recordingRow{Title: "周会", DurationMs: 65000, Model: "small", Language: "zh", Transcript: "第一句\n第二句", UpdatedAt: "2026-11-10T08:00:00Z"}
	got := transcriptMarkdown(rec)
	for _, want := range []string{"# 周会", "时长：01:05", "模型：small", "语言：zh", "第一句\n第二句"} {
		if !strings.Contains(got, want) {
			t.Errorf("transcript.md 里没有 %q：\n%s", want, got)
		}
	}
}

func TestMinutesMarkdown(t *testing.T) {
	rec := recordingRow{Title: "周会"}
	mins := RecordingMinutes{
		SummaryMD:   "# 摘要\n\n聊了官网改版。",
		Conclusions: []string{"Q4 上线"},
		Actions:     []RecordingAction{{Title: "出方案", Detail: "下周给", Owner: "张三", Due: "2026-11-20", Project: "官网改版", Confidence: 0.9}},
		Projects:    []RecordingProject{{Name: "官网改版", Confidence: 0.8, Reason: "多次提到"}},
		Goals:       []RecordingGoal{{Title: "Q4 上线", Confidence: 0.8}},
		Questions:   []RecordingQuestion{{Question: "预算多少", Why: "没说"}},
		Diagrams: RecordingDiagrams{
			Flow: RecordingFlow{Nodes: []RecordingFlowNode{{ID: "n1", Label: "现状"}}},
		},
		GeneratedAt: "2026-11-10T15:00:00+08:00",
		Model:       "fake",
	}
	got := minutesMarkdown(rec, mins)
	for _, want := range []string{
		"# 会议纪要：周会",
		"聊了官网改版",
		"## 结论",
		"Q4 上线",
		"## 待办",
		"负责人：张三",
		"项目：官网改版",
		"## 项目",
		"## 目标",
		"## 需要你确认",
		"```mermaid",
		"flowchart TD",
		"生成时间：2026-11-10T15:00:00+08:00",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("minutes.md 里没有 %q：\n%s", want, got)
		}
	}
}

func TestRecordingFilePathWhitelist(t *testing.T) {
	c := &fakeCore{attachmentDir: "/data/attachments"}
	if p := recordingFilePath(c, "rec_1", "minutes.md"); !strings.HasSuffix(p, "/recording/rec_1/minutes.md") {
		t.Errorf("白名单文件路径不对：%q", p)
	}
	for _, bad := range []string{"../../etc/passwd", "audio.webm", "diagrams/../../x", ""} {
		if p := recordingFilePath(c, "rec_1", bad); p != "" {
			t.Errorf("%q 不在白名单，应回空串：%q", bad, p)
		}
	}
}
