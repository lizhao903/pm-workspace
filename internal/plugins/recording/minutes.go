// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// M4a 纪要流水线（设计 §13.2）：插件内直连 Agent 生成结构化纪要，再提取候选项目/任务/目标；
// 后台 summarize 任务、POST /minutes、SOP 节点 recording_minutes / recording_extract 走同一份实现。
// 提示词要求只输出 JSON，解析时宽松（去围栏、截首尾大括号、单字段坏掉不影响整份），解析失败重试一次。

const (
	// minutesTranscriptLimit 是喂给模型的转写全文上限（字符），超了截断并在提示词里注明。
	minutesTranscriptLimit = 12000
	// minutesAgentTimeout 是一次 Agent 补全的上限（设计 §13.2：5 分钟）。
	minutesAgentTimeout = 5 * time.Minute

	maxMinutesActions   = 20
	maxMinutesProjects  = 5
	maxMinutesGoals     = 5
	maxMinutesQuestions = 5
	maxFlowNodes        = 10
	maxFlowEdges        = 15
	maxTreeDepth        = 3
	maxTreeBreadth      = 8
)

// minutesSystemPrompt 是两轮补全共用的 system 提示。
const minutesSystemPrompt = "你是会议纪要助手，只输出 JSON，不要输出解释或 Markdown 代码块。"

// buildMinutesPrompt 是生成纪要的提示词（必须含「会议纪要」四个字，供假 Agent 区分两轮调用）。
func buildMinutesPrompt(rec recordingRow, transcript string, projects []plugin.ObjectInfo) string {
	var b strings.Builder
	b.WriteString("请根据下面这段录音转写生成一份会议纪要。\n\n")
	fmt.Fprintf(&b, "录音标题：%s\n", rec.Title)
	if rec.DurationMs > 0 {
		fmt.Fprintf(&b, "录音时长：%s\n", formatDurationMS(rec.DurationMs))
	}
	if list := projectListText(projects); list != "" {
		b.WriteString("已有项目（匹配项目时优先用这些，别编新 id）：\n")
		b.WriteString(list)
		b.WriteString("\n")
	}
	b.WriteString("只输出一个 JSON 对象，不要代码块、不要解释。结构如下（字段缺失按空处理）：\n")
	b.WriteString(`{
  "summary_md": "Markdown 摘要（含结论、风险、下一步）",
  "conclusions": ["结论"],
  "actions": [{"title": "任务标题", "detail": "上下文", "owner": "负责人名字", "due": "YYYY-MM-DD", "project": "项目名", "confidence": 0.9, "kind": "task"}],
  "projects": [{"name": "项目名", "confidence": 0.8, "reason": "为什么"}],
  "goals": [{"title": "目标", "confidence": 0.8, "reason": "为什么"}],
  "questions": [{"question": "需要用户确认的问题", "why": "为什么不确定", "confidence": 0.4}],
  "diagrams": {
    "flow": {"title": "讨论脉络", "nodes": [{"id": "n1", "label": "现状", "kind": "start"}], "edges": [{"from": "n1", "to": "n2", "label": ""}]},
    "tree": {"title": "项目/任务树", "root": {"label": "会议主题", "children": [{"label": "子项"}]}}
  },
  "generated_at": "RFC3339",
  "model": "模型名"
}
`)
	b.WriteString("\n约束：actions 最多 20 条，projects 最多 5 个，goals 最多 5 个，questions 最多 5 个；")
	b.WriteString("flow.nodes 最多 10 个、edges 最多 15 条，kind 只能是 start/process/decision/end；")
	b.WriteString("tree 深度不超过 3 层、每层最多 8 个；confidence 是 0 到 1 的小数。\n\n")
	b.WriteString("转写全文：\n")
	b.WriteString(truncateTranscript(transcript))
	b.WriteString("\n")
	return b.String()
}

// buildExtractPrompt 是提取候选的提示词（必须含「候选」二字，供假 Agent 区分两轮调用）。
func buildExtractPrompt(rec recordingRow, transcript string, projects []plugin.ObjectInfo, mins RecordingMinutes) string {
	var b strings.Builder
	b.WriteString("请从下面的会议转写和纪要里提取「候选」：项目、任务、目标，以及需要用户确认的问题。\n\n")
	fmt.Fprintf(&b, "录音标题：%s\n", rec.Title)
	if list := projectListText(projects); list != "" {
		b.WriteString("已有项目（匹配项目时优先用这些）：\n")
		b.WriteString(list)
		b.WriteString("\n")
	}
	if strings.TrimSpace(mins.SummaryMD) != "" {
		b.WriteString("已有纪要摘要：\n")
		b.WriteString(truncateRunes(mins.SummaryMD, 2000))
		b.WriteString("\n")
	}
	b.WriteString("只输出一个 JSON 对象，不要代码块、不要解释。结构如下（字段缺失按空处理）：\n")
	b.WriteString(`{
  "projects": [{"name": "项目名", "confidence": 0.8, "reason": "为什么"}],
  "tasks": [{"title": "任务标题", "detail": "上下文", "owner": "负责人名字", "due": "YYYY-MM-DD", "project": "项目名", "confidence": 0.9, "kind": "task"}],
  "goals": [{"title": "目标", "confidence": 0.8, "reason": "为什么"}],
  "questions": [{"question": "需要用户确认的问题", "why": "为什么不确定", "confidence": 0.4}]
}
`)
	b.WriteString("\n约束：confidence 是 0 到 1 的小数；tasks 的 kind 只能是 task 或 goal；没有的字段给空数组。\n\n")
	b.WriteString("转写全文：\n")
	b.WriteString(truncateTranscript(transcript))
	b.WriteString("\n")
	return b.String()
}

// projectListText 把已有项目排成提示词里的一行一个。
func projectListText(projects []plugin.ObjectInfo) string {
	var b strings.Builder
	for _, p := range projects {
		if strings.TrimSpace(p.Title) == "" {
			continue
		}
		fmt.Fprintf(&b, "- %s（id: %s）\n", strings.TrimSpace(p.Title), p.ID)
	}
	return strings.TrimSpace(b.String())
}

// truncateTranscript 把超长的转写截到上限并注明；纯函数，单测用。
func truncateTranscript(transcript string) string {
	transcript = strings.TrimSpace(transcript)
	if n := len([]rune(transcript)); n > minutesTranscriptLimit {
		return truncateRunes(transcript, minutesTranscriptLimit) +
			fmt.Sprintf("\n\n（转写太长，已截断到前 %d 字）", minutesTranscriptLimit)
	}
	return transcript
}

// truncateRunes 按字符截断，不切坏 UTF-8。
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// completeMinutes 调一次 Agent 补全，超时 5 分钟；Provider/Model 空串用默认服务商。
func completeMinutes(ctx context.Context, c plugin.Core, s Settings, prompt string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, minutesAgentTimeout)
	defer cancel()
	out, err := c.Agent().Complete(ctx, plugin.CompleteRequest{
		System:   minutesSystemPrompt,
		Prompt:   prompt,
		Provider: strings.TrimSpace(s.MinutesProvider),
		Model:    strings.TrimSpace(s.MinutesModel),
		Scenario: plugin.ScenarioBackground,
		// 结构化 JSON 任务不需要长思考：开着思考时 qwen3.5 对几十字转写也能生成几千 token，纪要会等很久。
		Thinking: plugin.ThinkingOff,
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("本机模型 %s 内没生成完（模型较大或正忙），可在设置里换快一点的模型/服务商，或稍后重试", minutesAgentTimeout)
		}
		return "", fmt.Errorf("调用模型失败：%w", err)
	}
	if strings.TrimSpace(out) == "" {
		return "", errors.New("模型返回了空内容")
	}
	return out, nil
}

// extractJSONObject 宽松地取出模型输出里的 JSON 对象：去 ``` 围栏、截第一个 { 到最后一个 }。
func extractJSONObject(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	// 去掉 Markdown 代码围栏（```json ... ``` 或 ``` ... ```）
	if strings.HasPrefix(s, "```") {
		if i := strings.Index(s, "\n"); i >= 0 {
			s = s[i+1:]
		}
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < 0 || end < start {
		return "", errors.New("模型返回里没有 JSON 对象")
	}
	return s[start : end+1], nil
}

// decodeField 宽松解一个字段：类型对不上时忽略，不让单个坏字段坏掉整份。
func decodeField(raw map[string]json.RawMessage, key string, dst any) {
	v, ok := raw[key]
	if !ok {
		return
	}
	_ = json.Unmarshal(v, dst)
}

// parseMinutesJSON 宽松解析纪要 JSON；纯函数，单测用。
func parseMinutesJSON(raw string) (RecordingMinutes, error) {
	var mins RecordingMinutes
	obj, err := extractJSONObject(raw)
	if err != nil {
		return mins, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(obj), &fields); err != nil {
		return mins, fmt.Errorf("不是 JSON 对象：%w", err)
	}
	decodeField(fields, "summary_md", &mins.SummaryMD)
	decodeField(fields, "conclusions", &mins.Conclusions)
	decodeField(fields, "actions", &mins.Actions)
	decodeField(fields, "projects", &mins.Projects)
	decodeField(fields, "goals", &mins.Goals)
	decodeField(fields, "questions", &mins.Questions)
	decodeField(fields, "diagrams", &mins.Diagrams)
	decodeField(fields, "generated_at", &mins.GeneratedAt)
	decodeField(fields, "model", &mins.Model)
	if strings.TrimSpace(mins.SummaryMD) == "" && len(mins.Actions) == 0 && len(mins.Projects) == 0 &&
		len(mins.Goals) == 0 && len(mins.Questions) == 0 && len(mins.Diagrams.Flow.Nodes) == 0 {
		return mins, errors.New("JSON 里没有纪要字段")
	}
	normalizeMinutes(&mins)
	return mins, nil
}

// extractResult 是第二轮「提取候选」的 JSON。
type extractResult struct {
	Projects  []RecordingProject  `json:"projects"`
	Tasks     []RecordingAction   `json:"tasks"`
	Goals     []RecordingGoal     `json:"goals"`
	Questions []RecordingQuestion `json:"questions"`
}

// parseExtractJSON 宽松解析候选 JSON；纯函数，单测用。
func parseExtractJSON(raw string) (*extractResult, error) {
	obj, err := extractJSONObject(raw)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(obj), &fields); err != nil {
		return nil, fmt.Errorf("不是 JSON 对象：%w", err)
	}
	out := &extractResult{}
	decodeField(fields, "projects", &out.Projects)
	decodeField(fields, "tasks", &out.Tasks)
	decodeField(fields, "goals", &out.Goals)
	decodeField(fields, "questions", &out.Questions)
	return out, nil
}

// normalizeMinutes 把纪要里的字段截断/丢弃超限项（设计 §13.3 的约束），confidence 收敛到 0–1。
func normalizeMinutes(m *RecordingMinutes) {
	m.SummaryMD = strings.TrimSpace(m.SummaryMD)
	m.GeneratedAt = strings.TrimSpace(m.GeneratedAt)
	m.Model = strings.TrimSpace(m.Model)
	if m.GeneratedAt == "" {
		m.GeneratedAt = nowRFC()
	}
	m.Conclusions = cleanStrings(m.Conclusions)

	actions := make([]RecordingAction, 0, len(m.Actions))
	for _, a := range m.Actions {
		a.Title = strings.TrimSpace(a.Title)
		a.Detail = strings.TrimSpace(a.Detail)
		a.Owner = strings.TrimSpace(a.Owner)
		a.Due = strings.TrimSpace(a.Due)
		a.Project = strings.TrimSpace(a.Project)
		a.Confidence = clampConfidence(a.Confidence)
		if a.Kind != "goal" {
			a.Kind = "task"
		}
		if a.Title == "" && a.Detail == "" {
			continue
		}
		if a.Title == "" {
			a.Title = clip(a.Detail, 80)
		}
		actions = append(actions, a)
		if len(actions) >= maxMinutesActions {
			break
		}
	}
	m.Actions = actions

	projects := make([]RecordingProject, 0, len(m.Projects))
	for _, p := range m.Projects {
		p.Name = strings.TrimSpace(p.Name)
		p.Reason = strings.TrimSpace(p.Reason)
		p.ProjectID = strings.TrimSpace(p.ProjectID)
		p.ProjectTitle = strings.TrimSpace(p.ProjectTitle)
		p.Confidence = clampConfidence(p.Confidence)
		if p.Name == "" {
			continue
		}
		projects = append(projects, p)
		if len(projects) >= maxMinutesProjects {
			break
		}
	}
	m.Projects = projects

	goals := make([]RecordingGoal, 0, len(m.Goals))
	for _, g := range m.Goals {
		g.Title = strings.TrimSpace(g.Title)
		g.Reason = strings.TrimSpace(g.Reason)
		g.Confidence = clampConfidence(g.Confidence)
		if g.Title == "" {
			continue
		}
		goals = append(goals, g)
		if len(goals) >= maxMinutesGoals {
			break
		}
	}
	m.Goals = goals

	questions := make([]RecordingQuestion, 0, len(m.Questions))
	for _, q := range m.Questions {
		q.Question = strings.TrimSpace(q.Question)
		q.Why = strings.TrimSpace(q.Why)
		q.Confidence = clampConfidence(q.Confidence)
		if q.Question == "" {
			continue
		}
		questions = append(questions, q)
		if len(questions) >= maxMinutesQuestions {
			break
		}
	}
	m.Questions = questions
	m.Diagrams.Flow = normalizeFlow(m.Diagrams.Flow)
	m.Diagrams.Tree = normalizeTree(m.Diagrams.Tree)
}

// normalizeFlow 截断流程图节点/边，丢掉指向不存在节点的边，kind 收敛到四类。
func normalizeFlow(f RecordingFlow) RecordingFlow {
	f.Title = strings.TrimSpace(f.Title)
	nodes := make([]RecordingFlowNode, 0, len(f.Nodes))
	ids := map[string]bool{}
	for _, n := range f.Nodes {
		n.ID = strings.TrimSpace(n.ID)
		n.Label = strings.TrimSpace(n.Label)
		switch n.Kind {
		case "start", "process", "decision", "end":
		default:
			n.Kind = "process"
		}
		if n.ID == "" || ids[n.ID] {
			// 没给 id 或 id 撞了：按序号补一个没被用过的
			for i := len(nodes) + 1; ; i++ {
				if cand := fmt.Sprintf("n%d", i); !ids[cand] {
					n.ID = cand
					break
				}
			}
		}
		ids[n.ID] = true
		nodes = append(nodes, n)
		if len(nodes) >= maxFlowNodes {
			break
		}
	}
	f.Nodes = nodes
	edges := make([]RecordingFlowEdge, 0, len(f.Edges))
	for _, e := range f.Edges {
		e.From = strings.TrimSpace(e.From)
		e.To = strings.TrimSpace(e.To)
		e.Label = strings.TrimSpace(e.Label)
		if !ids[e.From] || !ids[e.To] {
			continue
		}
		edges = append(edges, e)
		if len(edges) >= maxFlowEdges {
			break
		}
	}
	f.Edges = edges
	return f
}

// normalizeTree 截断树：深度最多 3 层、每层最多 8 个。
func normalizeTree(t RecordingTree) RecordingTree {
	t.Title = strings.TrimSpace(t.Title)
	var prune func(n RecordingTreeNode, depth int) (RecordingTreeNode, bool)
	prune = func(n RecordingTreeNode, depth int) (RecordingTreeNode, bool) {
		n.Label = strings.TrimSpace(n.Label)
		children := make([]RecordingTreeNode, 0, len(n.Children))
		if depth < maxTreeDepth {
			for _, child := range n.Children {
				if c, ok := prune(child, depth+1); ok {
					children = append(children, c)
				}
				if len(children) >= maxTreeBreadth {
					break
				}
			}
		}
		n.Children = children
		if n.Label == "" && len(children) == 0 {
			return RecordingTreeNode{}, false
		}
		return n, true
	}
	if root, ok := prune(t.Root, 1); ok {
		t.Root = root
	} else {
		t.Root = RecordingTreeNode{}
	}
	return t
}

func cleanStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func clampConfidence(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 1:
		return 1
	default:
		return v
	}
}

// matchMinutesProjects 按名字把纪要里的项目候选对上已有项目（不区分大小写，重名取第一个）。
func matchMinutesProjects(mins *RecordingMinutes, projects []plugin.ObjectInfo) {
	for i := range mins.Projects {
		if mins.Projects[i].ProjectID != "" {
			continue
		}
		if p, ok := matchProject(projects, mins.Projects[i].Name); ok {
			mins.Projects[i].ProjectID = p.ID
			mins.Projects[i].ProjectTitle = p.Title
		}
	}
}

// matchProject 在已有项目里按名字找（去首尾空白、不分大小写）。
func matchProject(projects []plugin.ObjectInfo, name string) (plugin.ObjectInfo, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return plugin.ObjectInfo{}, false
	}
	for _, p := range projects {
		if strings.EqualFold(strings.TrimSpace(p.Title), name) {
			return p, true
		}
	}
	return plugin.ObjectInfo{}, false
}

// reportProgress 调进度回调；回调为空（SOP 节点等场景）时什么也不做。
func reportProgress(progress func(int), pct int) {
	if progress != nil {
		progress(pct)
	}
}

// summarizeRecording 是纪要流水线：生成纪要 → 提取候选 → 落库 → 写文件 → 高置信度通知。
// 调用方负责任务状态：成功置 ready，失败回 transcribed（worker 的 failJob）。
// progress 用来给后台任务上报进度（3 起步、45 纪要完成、80 候选提取完成、95 落库完成），可为 nil。
func (p *Plugin) summarizeRecording(ctx context.Context, c plugin.Core, rec recordingRow, s Settings, progress func(int)) (RecordingMinutes, []todoRow, error) {
	transcript := strings.TrimSpace(rec.Transcript)
	if transcript == "" {
		return RecordingMinutes{}, nil, apiErr(errValidation, "录音「%s」还没有转写全文，先转写再生成纪要", rec.Title)
	}
	projects, err := c.Objects().List(ctx, plugin.ObjectQuery{Type: "project", Limit: 50})
	if err != nil {
		c.Log().Warn("recording: 列项目失败，纪要里不做项目匹配", "err", err)
		projects = nil
	}

	prompt := buildMinutesPrompt(rec, transcript, projects)
	out, err := completeMinutes(ctx, c, s, prompt)
	if err != nil {
		return RecordingMinutes{}, nil, err
	}
	mins, parseErr := parseMinutesJSON(out)
	if parseErr != nil {
		c.Log().Warn("recording: 纪要 JSON 解析失败，重试一次", "recording", rec.ID, "err", parseErr)
		retry := prompt + "\n\n上一次输出不是合法的 JSON。只输出 JSON，不要解释，不要 Markdown 代码块。"
		out2, err2 := completeMinutes(ctx, c, s, retry)
		if err2 != nil {
			return RecordingMinutes{}, nil, err2
		}
		mins, parseErr = parseMinutesJSON(out2)
		if parseErr != nil {
			return RecordingMinutes{}, nil, fmt.Errorf("模型返回不是 JSON：%w", parseErr)
		}
	}
	reportProgress(progress, 45)
	if mins.Model == "" {
		mins.Model = strings.TrimSpace(s.MinutesModel)
	}
	matchMinutesProjects(&mins, projects)

	// 第二轮：提取候选（失败不挡纪要落库，用纪要里的数据兜底）。
	var extracted *extractResult
	if x, xerr := p.extractCandidates(ctx, c, s, rec, transcript, projects, mins); xerr != nil {
		c.Log().Warn("recording: 提取候选失败，用纪要里的数据兜底", "recording", rec.ID, "err", xerr)
	} else {
		extracted = x
	}
	reportProgress(progress, 80)
	candidates := buildCandidates(mins, extracted, projects, rec)

	now := nowRFC()
	body, err := json.Marshal(mins)
	if err != nil {
		return RecordingMinutes{}, nil, fmt.Errorf("纪要转 JSON 失败：%w", err)
	}
	if _, err := c.Store().Exec(ctx, `UPDATE recording_recordings SET minutes_json = ?, minutes_model = ?, status = 'ready', error = '', updated_at = ? WHERE id = ?`,
		string(body), mins.Model, now, rec.ID); err != nil {
		return RecordingMinutes{}, nil, err
	}
	if err := replaceTodos(ctx, c.Store(), rec.ID, candidates); err != nil {
		return RecordingMinutes{}, nil, err
	}
	rec.MinutesJSON, rec.MinutesModel, rec.Status, rec.UpdatedAt = string(body), mins.Model, "ready", now
	writeTranscriptFile(c, rec)
	writeMinutesFiles(c, rec, mins)
	notifyCandidates(c, rec, candidates, s)
	reportProgress(progress, 95)
	return mins, candidates, nil
}

// extractCandidates 跑第二轮 Agent，提取候选。
func (p *Plugin) extractCandidates(ctx context.Context, c plugin.Core, s Settings, rec recordingRow,
	transcript string, projects []plugin.ObjectInfo, mins RecordingMinutes) (*extractResult, error) {
	out, err := completeMinutes(ctx, c, s, buildExtractPrompt(rec, transcript, projects, mins))
	if err != nil {
		return nil, err
	}
	return parseExtractJSON(out)
}

// extractRecordingCandidates 只重跑候选提取（SOP 节点 recording_extract 用）：纪要必须已经生成。
func (p *Plugin) extractRecordingCandidates(ctx context.Context, c plugin.Core, rec recordingRow, s Settings) ([]todoRow, error) {
	transcript := strings.TrimSpace(rec.Transcript)
	if transcript == "" {
		return nil, apiErr(errValidation, "录音「%s」还没有转写全文", rec.Title)
	}
	if strings.TrimSpace(rec.MinutesJSON) == "" {
		return nil, apiErr(errValidation, "录音「%s」还没有生成纪要，先跑生成纪要", rec.Title)
	}
	var mins RecordingMinutes
	if err := json.Unmarshal([]byte(rec.MinutesJSON), &mins); err != nil {
		return nil, apiErr(errValidation, "录音「%s」的纪要数据坏了：%v", rec.Title, err)
	}
	projects, _ := c.Objects().List(ctx, plugin.ObjectQuery{Type: "project", Limit: 50})
	extracted, err := p.extractCandidates(ctx, c, s, rec, transcript, projects, mins)
	if err != nil {
		return nil, err
	}
	candidates := buildCandidates(mins, extracted, projects, rec)
	if err := replaceTodos(ctx, c.Store(), rec.ID, candidates); err != nil {
		return nil, err
	}
	notifyCandidates(c, rec, candidates, s)
	return candidates, nil
}

// buildCandidates 把两轮结果合成候选行：优先用第二轮提取的，再补第一轮纪要里的，按 kind+标题去重。
// 项目按名字对上已有项目；任务/目标优先用候选里的项目名，匹配不到就挂录音自己的项目。
func buildCandidates(mins RecordingMinutes, extracted *extractResult, projects []plugin.ObjectInfo, rec recordingRow) []todoRow {
	type cand struct {
		kind, title, detail, reason, owner, due, projectTitle string
		confidence                                            float64
	}
	var all []cand
	seen := map[string]bool{}
	add := func(c cand) {
		c.title = strings.TrimSpace(c.title)
		if c.title == "" {
			return
		}
		key := c.kind + "\x00" + strings.ToLower(c.title)
		if seen[key] {
			return
		}
		seen[key] = true
		all = append(all, c)
	}
	if extracted != nil {
		for _, x := range extracted.Projects {
			add(cand{kind: "project", title: x.Name, reason: x.Reason, confidence: x.Confidence})
		}
		for _, t := range extracted.Tasks {
			kind := "task"
			if t.Kind == "goal" {
				kind = "goal"
			}
			add(cand{kind: kind, title: t.Title, detail: t.Detail, owner: t.Owner, due: t.Due, projectTitle: t.Project, confidence: t.Confidence})
		}
		for _, g := range extracted.Goals {
			add(cand{kind: "goal", title: g.Title, reason: g.Reason, confidence: g.Confidence})
		}
	}
	for _, a := range mins.Actions {
		kind := "task"
		if a.Kind == "goal" {
			kind = "goal"
		}
		add(cand{kind: kind, title: a.Title, detail: a.Detail, owner: a.Owner, due: a.Due, projectTitle: a.Project, confidence: a.Confidence})
	}
	for _, g := range mins.Goals {
		add(cand{kind: "goal", title: g.Title, reason: g.Reason, confidence: g.Confidence})
	}
	for _, p := range mins.Projects {
		add(cand{kind: "project", title: p.Name, reason: p.Reason, confidence: p.Confidence})
	}

	now := nowRFC()
	out := make([]todoRow, 0, len(all))
	for _, c := range all {
		t := todoRow{
			RecordingID: rec.ID,
			Index:       len(out),
			Kind:        c.kind,
			Title:       c.title,
			Detail:      strings.TrimSpace(c.detail),
			Confidence:  clampConfidence(c.confidence),
			Status:      "pending",
			Reason:      strings.TrimSpace(c.reason),
			OwnerName:   strings.TrimSpace(c.owner),
			DueAt:       strings.TrimSpace(c.due),
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		t.ProjectTitle = strings.TrimSpace(c.projectTitle)
		if t.Kind == "project" {
			if proj, ok := matchProject(projects, t.Title); ok {
				t.ProjectID, t.ProjectTitle = proj.ID, proj.Title
			}
		} else if t.ProjectTitle != "" {
			if proj, ok := matchProject(projects, t.ProjectTitle); ok {
				t.ProjectID, t.ProjectTitle = proj.ID, proj.Title
			}
		}
		if t.Kind != "project" && t.ProjectID == "" && rec.ProjectID != "" {
			t.ProjectID = rec.ProjectID
			for _, proj := range projects {
				if proj.ID == rec.ProjectID {
					t.ProjectTitle = proj.Title
					break
				}
			}
		}
		out = append(out, t)
	}
	return out
}

// notifyCandidates 把高置信度（>= minutes_threshold）的待确认候选汇总成一条通知；发不出去只记日志。
func notifyCandidates(c plugin.Core, rec recordingRow, todos []todoRow, s Settings) {
	high := highConfidenceCount(todos, effectiveMinutesThreshold(s))
	if high == 0 {
		return
	}
	err := c.Notify(context.Background(), plugin.Notification{
		Kind:     "tasks_pending",
		Level:    plugin.NotifyInfo,
		Title:    fmt.Sprintf("%d 条待确认候选：%s", high, clip(rec.Title, 40)),
		Body:     "打开录音详情确认候选项目/任务/目标",
		ObjectID: rec.ID,
		Data: map[string]any{
			"recording_id":    rec.ID,
			"recording_title": rec.Title,
			"pending_count":   high,
		},
	})
	if err != nil {
		c.Log().Warn("recording: 发候选通知失败", "recording", rec.ID, "err", err)
	}
}

// highConfidenceCount 是待确认候选里置信度达到阈值（含）的条数；纯函数，单测用。
func highConfidenceCount(todos []todoRow, threshold float64) int {
	n := 0
	for _, t := range todos {
		if t.Status == "pending" && t.Confidence >= threshold {
			n++
		}
	}
	return n
}

// todoToView 把候选行转成接口视图。
func todoToView(t todoRow) RecordingTodo {
	return RecordingTodo{
		Index:        t.Index,
		Kind:         t.Kind,
		Title:        t.Title,
		Detail:       t.Detail,
		Confidence:   t.Confidence,
		Status:       t.Status,
		ProjectID:    t.ProjectID,
		ProjectTitle: t.ProjectTitle,
		ObjectID:     t.ObjectID,
		ObjectRef:    t.ObjectRef,
		Reason:       t.Reason,
		OwnerName:    t.OwnerName,
		DueAt:        t.DueAt,
		CreatedAt:    t.CreatedAt,
		UpdatedAt:    t.UpdatedAt,
	}
}

// todoViews 批量转视图。
func todoViews(rows []todoRow) []RecordingTodo {
	out := make([]RecordingTodo, 0, len(rows))
	for _, t := range rows {
		out = append(out, todoToView(t))
	}
	return out
}
