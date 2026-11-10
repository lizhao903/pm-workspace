// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 纪要 JSON 的宽松解析（设计 §13.3）：代码块围栏、前后解释文字、缺字段、单字段类型坏掉都不整份失败。
func TestParseMinutesJSONLoose(t *testing.T) {
	raw := "好的，这是纪要：\n```json\n" + `{
		"summary_md": "  # 摘要  ",
		"conclusions": ["结论一", "", " 结论二 "],
		"actions": [{"title":"出方案","owner":"张三","confidence":1.7,"kind":"unknown"},{"title":""}],
		"projects": [{"name":"官网改版","confidence":0.86,"reason":"多次提到"}],
		"goals": [{"title":"Q4 上线","confidence":0.8}],
		"questions": [{"question":"预算多少","why":"没说","confidence":0.3}],
		"diagrams": {
			"flow": {"title":"脉络","nodes":[{"id":"n1","label":"现状","kind":"start"},{"id":"n2","label":"上线","kind":"oops"}],"edges":[{"from":"n1","to":"n2"},{"from":"n1","to":"n9"}]},
			"tree": {"title":"树","root":{"label":"主题","children":[{"label":"子项"}]}}
		},
		"model": "  fake  "
	}
` + "```\n以上。"
	mins, err := parseMinutesJSON(raw)
	if err != nil {
		t.Fatalf("宽松解析失败：%v", err)
	}
	if mins.SummaryMD != "# 摘要" {
		t.Errorf("summary_md 没去空白：%q", mins.SummaryMD)
	}
	if len(mins.Conclusions) != 2 {
		t.Errorf("空结论应该丢掉：%v", mins.Conclusions)
	}
	if len(mins.Actions) != 1 || mins.Actions[0].Kind != "task" || mins.Actions[0].Confidence != 1 {
		t.Errorf("actions 归一化不对：%+v", mins.Actions)
	}
	if len(mins.Projects) != 1 || mins.Projects[0].Confidence != 0.86 {
		t.Errorf("projects 不对：%+v", mins.Projects)
	}
	if mins.GeneratedAt == "" {
		t.Error("generated_at 空时应补当前时间")
	}
	if mins.Model != "fake" {
		t.Errorf("model 没去空白：%q", mins.Model)
	}
	flow := mins.Diagrams.Flow
	if len(flow.Nodes) != 2 || flow.Nodes[1].Kind != "process" {
		t.Errorf("flow 节点 kind 应收敛成 process：%+v", flow.Nodes)
	}
	if len(flow.Edges) != 1 || flow.Edges[0].To != "n2" {
		t.Errorf("指向不存在节点的边应该丢掉：%+v", flow.Edges)
	}
	if mins.Diagrams.Tree.Root.Label != "主题" || len(mins.Diagrams.Tree.Root.Children) != 1 {
		t.Errorf("tree 不对：%+v", mins.Diagrams.Tree)
	}
}

func TestParseMinutesJSONSingleBadField(t *testing.T) {
	// confidence 是字符串这种坏字段只丢这一个字段，整份纪要还在。
	mins, err := parseMinutesJSON(`{"summary_md":"有用","actions":[{"title":"任务","confidence":"很高"}],"projects":"不是数组"}`)
	if err != nil {
		t.Fatalf("单字段坏掉不该整份失败：%v", err)
	}
	if mins.SummaryMD != "有用" {
		t.Errorf("摘要丢了：%+v", mins)
	}
	if len(mins.Actions) != 1 || mins.Actions[0].Title != "任务" {
		t.Errorf("坏字段让整条 action 丢了：%+v", mins.Actions)
	}
	if len(mins.Projects) != 0 {
		t.Errorf("类型不对的 projects 应忽略：%+v", mins.Projects)
	}
}

func TestParseMinutesJSONNoObject(t *testing.T) {
	for _, raw := range []string{"", "模型说了一堆话但没有 JSON", "{broken json"} {
		if _, err := parseMinutesJSON(raw); err == nil {
			t.Errorf("%q 应该解析失败", raw)
		}
	}
}

func TestParseMinutesJSONNoFields(t *testing.T) {
	if _, err := parseMinutesJSON(`{"foo": 1}`); err == nil {
		t.Fatal("没有纪要字段的对象应该算解析失败（会触发重试）")
	}
}

func TestParseMinutesJSONLimits(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"summary_md":"x","actions":[`)
	for i := 0; i < 30; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"title":"任务"}`)
	}
	b.WriteString(`],"projects":[`)
	for i := 0; i < 9; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"name":"项目"}`)
	}
	b.WriteString(`]}`)
	mins, err := parseMinutesJSON(b.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(mins.Actions) != maxMinutesActions {
		t.Errorf("actions 应截到 %d 条，实际 %d", maxMinutesActions, len(mins.Actions))
	}
	if len(mins.Projects) != maxMinutesProjects {
		t.Errorf("projects 应截到 %d 个，实际 %d", maxMinutesProjects, len(mins.Projects))
	}
}

func TestParseExtractJSON(t *testing.T) {
	x, err := parseExtractJSON("```json\n" + `{
		"projects":[{"name":"官网改版","confidence":0.9}],
		"tasks":[{"title":"出方案","confidence":0.92,"kind":"task"},{"title":"目标化","kind":"goal"}],
		"goals":[{"title":"上线"}],
		"questions":[{"question":"预算"}]
	}` + "\n```")
	if err != nil {
		t.Fatal(err)
	}
	if len(x.Projects) != 1 || len(x.Tasks) != 2 || len(x.Goals) != 1 || len(x.Questions) != 1 {
		t.Errorf("候选解析不对：%+v", x)
	}
}

func TestTruncateTranscript(t *testing.T) {
	short := "短转写"
	if got := truncateTranscript(short); got != short {
		t.Errorf("短文本不该动：%q", got)
	}
	long := strings.Repeat("会", minutesTranscriptLimit+100)
	got := truncateTranscript(long)
	if !strings.Contains(got, "已截断") {
		t.Error("超长转写应注明截断")
	}
	if n := len([]rune(got)); n > minutesTranscriptLimit+50 {
		t.Errorf("截断后还是太长：%d", n)
	}
	if !strings.HasPrefix(got, strings.Repeat("会", 10)) {
		t.Error("截断应从开头保留")
	}
}

func TestBuildCandidatesProjectMatchAndDedup(t *testing.T) {
	projects := []plugin.ObjectInfo{{ID: "prj_1", Title: "官网改版", Type: "project"}}
	rec := recordingRow{ID: "rec_1", Title: "评审", ProjectID: "prj_1"}
	mins := RecordingMinutes{
		Actions:  []RecordingAction{{Title: "出改版方案", Project: "官网改版", Confidence: 0.9, Kind: "task"}},
		Projects: []RecordingProject{{Name: "官网改版", Confidence: 0.9}},
	}
	extracted := &extractResult{
		Projects: []RecordingProject{{Name: "官网改版", Confidence: 0.9}},
		Tasks: []RecordingAction{
			{Title: "出改版方案", Project: "官网改版", Confidence: 0.92, Kind: "task"},
			{Title: "确认预算", Confidence: 0.35, Kind: "task"},
		},
		Goals: []RecordingGoal{{Title: "Q4 上线", Confidence: 0.8}},
	}
	todos := buildCandidates(mins, extracted, projects, rec)
	if len(todos) != 4 {
		t.Fatalf("应去重成 4 条候选（项目/2 任务/目标），实际 %d：%+v", len(todos), todos)
	}
	for i, todo := range todos {
		if todo.Index != i {
			t.Errorf("index 应连续：%d != %d", todo.Index, i)
		}
		if todo.Status != "pending" {
			t.Errorf("新候选 status 应是 pending：%+v", todo)
		}
		if todo.RecordingID != rec.ID {
			t.Errorf("recording_id 不对：%+v", todo)
		}
	}
	byTitle := map[string]todoRow{}
	for _, todo := range todos {
		byTitle[todo.Title] = todo
	}
	if p := byTitle["官网改版"]; p.Kind != "project" || p.ProjectID != "prj_1" || p.ProjectTitle != "官网改版" {
		t.Errorf("项目候选应匹配已有项目：%+v", p)
	}
	if task := byTitle["出改版方案"]; task.Kind != "task" || task.ProjectID != "prj_1" || task.Detail != "" || task.Confidence != 0.92 {
		t.Errorf("任务候选应挂项目：%+v", task)
	}
	// 没写项目的低置信度任务挂录音自己的项目
	if low := byTitle["确认预算"]; low.ProjectID != "prj_1" || low.Confidence != 0.35 {
		t.Errorf("低置信度任务候选不对：%+v", low)
	}
}

func TestBuildCandidatesFallbackToMinutes(t *testing.T) {
	// 第二轮提取失败（extracted 为 nil）时用纪要里的数据兜底。
	mins := RecordingMinutes{
		Actions:  []RecordingAction{{Title: "出方案", Confidence: 0.7}},
		Projects: []RecordingProject{{Name: "匿名项目"}},
	}
	todos := buildCandidates(mins, nil, nil, recordingRow{ID: "rec_1"})
	if len(todos) != 2 {
		t.Fatalf("应兜底出 2 条候选：%+v", todos)
	}
	if todos[0].Kind != "task" || todos[1].Kind != "project" {
		t.Errorf("兜底候选顺序/类型不对：%+v", todos)
	}
}

func TestHighConfidenceCount(t *testing.T) {
	todos := []todoRow{
		{Status: "pending", Confidence: 0.9},
		{Status: "pending", Confidence: 0.7},
		{Status: "pending", Confidence: 0.69},
		{Status: "confirmed", Confidence: 0.95},
		{Status: "ignored", Confidence: 0.99},
	}
	if got := highConfidenceCount(todos, 0.7); got != 2 {
		t.Errorf("阈值 0.7 应有 2 条（含等于），实际 %d", got)
	}
	if got := highConfidenceCount(todos, 0.1); got != 3 {
		t.Errorf("阈值 0.1 应只算 pending 的 3 条，实际 %d", got)
	}
	if got := highConfidenceCount(nil, 0.7); got != 0 {
		t.Errorf("空候选 = %d", got)
	}
}

func TestEffectiveMinutesThreshold(t *testing.T) {
	// 0 是合法阈值：推送全部候选（前端和 Lead 确认过的语义）。
	if got := effectiveMinutesThreshold(Settings{MinutesThreshold: 0}); got != 0 {
		t.Errorf("阈值 0 应原样生效（全部候选），实际 %v", got)
	}
	if got := effectiveMinutesThreshold(Settings{MinutesThreshold: 0.4}); got != 0.4 {
		t.Errorf("设置里的阈值应生效：%v", got)
	}
	// 越界值只可能来自坏数据，兜底默认。
	if got := effectiveMinutesThreshold(Settings{MinutesThreshold: 1.5}); got != defaultMinutesThreshold {
		t.Errorf("越界阈值应兜底默认：%v", got)
	}
}

func TestParseDueAt(t *testing.T) {
	for _, raw := range []string{"2026-11-20", "2026-11-20 15:04", "2026-11-20T15:04:05", "2026-11-20T15:04:05+08:00"} {
		if due, err := parseDueAt(raw); err != nil || due == nil {
			t.Errorf("%q 应解析成功：%v %v", raw, due, err)
		}
	}
	if due, err := parseDueAt("   "); err != nil || due != nil {
		t.Errorf("空串应回 nil：%v %v", due, err)
	}
	if _, err := parseDueAt("下周五"); err == nil {
		t.Error("不认识的格式应报错")
	}
}

func TestNormalizeTreeLimits(t *testing.T) {
	root := RecordingTreeNode{Label: "根"}
	children := make([]RecordingTreeNode, 0, 20)
	for i := 0; i < 20; i++ {
		children = append(children, RecordingTreeNode{Label: "子"})
	}
	root.Children = children
	tree := normalizeTree(RecordingTree{Root: root})
	if len(tree.Root.Children) != maxTreeBreadth {
		t.Errorf("每层应截到 %d 个，实际 %d", maxTreeBreadth, len(tree.Root.Children))
	}
	// 深度：根 → 1 → 2 → 3，第 4 层丢掉
	deep := RecordingTreeNode{Label: "L0", Children: []RecordingTreeNode{{Label: "L1", Children: []RecordingTreeNode{
		{Label: "L2", Children: []RecordingTreeNode{{Label: "L3", Children: []RecordingTreeNode{{Label: "L4"}}}}},
	}}}}
	tree = normalizeTree(RecordingTree{Root: deep})
	cur := tree.Root
	depth := 1
	for len(cur.Children) > 0 {
		cur = cur.Children[0]
		depth++
	}
	if depth != maxTreeDepth {
		t.Errorf("树深度应为 %d 层，实际 %d", maxTreeDepth, depth)
	}
}

func TestGeneratedAtKept(t *testing.T) {
	stamp := time.Date(2026, 11, 10, 15, 0, 0, 0, time.FixedZone("CST", 8*3600)).Format(time.RFC3339)
	mins, err := parseMinutesJSON(`{"summary_md":"x","generated_at":"` + stamp + `"}`)
	if err != nil {
		t.Fatal(err)
	}
	if mins.GeneratedAt != stamp {
		t.Errorf("generated_at 应原样保留：%q", mins.GeneratedAt)
	}
}
