// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 假 Agent：按提示词里的标记返回纪要 / 候选 JSON，默认两轮都成功；responses 可以指定一轮坏的做重试测试。
type fakeMinutesComplete struct {
	mu        sync.Mutex
	calls     []string
	responses []string // 非空时按顺序返回；用完后回错误
}

func (a *fakeMinutesComplete) Complete(_ context.Context, req plugin.CompleteRequest) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, req.Prompt)
	if a.responses != nil {
		if len(a.calls) > len(a.responses) {
			return "", errors.New("假 Agent 没有更多回复了")
		}
		return a.responses[len(a.calls)-1], nil
	}
	switch {
	case strings.Contains(req.Prompt, "候选"):
		return fakeExtractJSONTest, nil
	case strings.Contains(req.Prompt, "会议纪要"):
		return fakeMinutesJSONTest, nil
	}
	return "", errors.New("假 Agent 不认识的提示词")
}

func (a *fakeMinutesComplete) RunAgent(context.Context, plugin.AgentRunRequest) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, errors.New("假 Agent 不支持跑一轮")
}
func (a *fakeMinutesComplete) AgentState(context.Context, string) (plugin.AgentRunResult, error) {
	return plugin.AgentRunResult{}, errors.New("假 Agent 不支持查状态")
}
func (a *fakeMinutesComplete) SearchKB(context.Context, []string, string, int) ([]plugin.KBHit, error) {
	return nil, nil
}

func (a *fakeMinutesComplete) callCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.calls)
}

func (a *fakeMinutesComplete) prompt(i int) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.calls[i]
}

const fakeMinutesJSONTest = `{
  "summary_md": "# 会议摘要\n\n会上确认官网改版范围，Q4 上线。",
  "conclusions": ["Q4 上线新版官网"],
  "actions": [{"title": "出改版方案", "detail": "下周给方案", "owner": "张三", "due": "2026-11-20", "project": "官网改版", "confidence": 0.92, "kind": "task"}],
  "projects": [{"name": "官网改版", "confidence": 0.88, "reason": "多次提到"}],
  "goals": [{"title": "Q4 上线新版官网", "confidence": 0.8, "reason": "明确结论"}],
  "questions": [{"question": "预算多少？", "why": "会里没说", "confidence": 0.3}],
  "diagrams": {
    "flow": {"title": "讨论脉络", "nodes": [{"id": "n1", "label": "现状", "kind": "start"}, {"id": "n2", "label": "Q4 上线", "kind": "end"}], "edges": [{"from": "n1", "to": "n2", "label": "决定"}]},
    "tree": {"title": "项目树", "root": {"label": "官网改版", "children": [{"label": "方案"}]}}
  },
  "generated_at": "2026-11-10T15:00:00+08:00",
  "model": "fake"
}`

const fakeExtractJSONTest = `{
  "projects": [{"name": "官网改版", "confidence": 0.9, "reason": "会上反复提到"}],
  "tasks": [
    {"title": "出改版方案", "detail": "下周给方案", "owner": "张三", "due": "2026-11-20", "project": "官网改版", "confidence": 0.92, "kind": "task"},
    {"title": "确认预算", "detail": "预算还没定", "confidence": 0.35, "kind": "task"}
  ],
  "goals": [{"title": "Q4 上线新版官网", "confidence": 0.8, "reason": "明确结论"}],
  "questions": [{"question": "预算多少？", "why": "会里没说", "confidence": 0.3}]
}`

// fakeRuns 记下 StartSOP 的参数，按设置回错误。
type fakeRuns struct {
	plugin.RunService
	got plugin.SOPRunStart
	err error
}

func (r *fakeRuns) StartSOP(_ context.Context, q plugin.SOPRunStart) (string, error) {
	r.got = q
	if r.err != nil {
		return "", r.err
	}
	return "run_1", nil
}

func newPipelineCore(t *testing.T) (*fakeCore, *fakeStore, *fakeMinutesComplete, string) {
	t.Helper()
	dir := t.TempDir()
	store := &fakeStore{}
	agent := &fakeMinutesComplete{}
	c := &fakeCore{
		store:         store,
		objects:       &fakeObjects{byID: map[string]plugin.ObjectInfo{"prj_1": {ID: "prj_1", Title: "官网改版", Type: "project"}}},
		contacts:      &fakeContacts{byName: map[string]plugin.ContactInfo{}},
		writer:        &fakeWriter{},
		audit:         &fakeAudit{},
		agentSvc:      agent,
		runs:          &fakeRuns{},
		attachmentDir: dir,
	}
	return c, store, agent, dir
}

/* ---------- 纪要流水线 ---------- */

func TestSummarizeRecordingPipeline(t *testing.T) {
	c, store, agent, dir := newPipelineCore(t)
	p := &Plugin{}
	rec := recordingRow{ID: "rec_1", Title: "官网改版评审", ProjectID: "prj_1",
		Transcript: "张三：官网改版 Q4 上线。李四：方案下周给。"}
	mins, todos, err := p.summarizeRecording(context.Background(), c, rec, Settings{MinutesThreshold: 0.7}, nil)
	if err != nil {
		t.Fatalf("生成纪要失败：%v", err)
	}
	if agent.callCount() != 2 {
		t.Fatalf("应调 Agent 两次（纪要+候选），实际 %d", agent.callCount())
	}
	if !strings.Contains(agent.prompt(0), "会议纪要") || strings.Contains(agent.prompt(0), "候选") {
		t.Errorf("第一轮应是生成纪要的提示词：%q", clip(agent.prompt(0), 120))
	}
	if !strings.Contains(agent.prompt(1), "候选") {
		t.Errorf("第二轮应是提取候选的提示词：%q", clip(agent.prompt(1), 120))
	}
	if !strings.Contains(mins.SummaryMD, "会议摘要") {
		t.Errorf("纪要没解析出来：%+v", mins)
	}
	if len(mins.Diagrams.Flow.Nodes) != 2 {
		t.Errorf("流程图不对：%+v", mins.Diagrams.Flow)
	}
	if len(mins.Projects) != 1 || mins.Projects[0].ProjectID != "prj_1" {
		t.Errorf("项目候选应匹配到已有项目：%+v", mins.Projects)
	}
	if len(todos) < 3 {
		t.Fatalf("候选太少：%+v", todos)
	}
	// 候选落库。
	if !store.hasExec("UPDATE recording_recordings SET minutes_json") {
		t.Errorf("没把纪要写回录音：%v", store.execs)
	}
	if !store.hasExec("INSERT INTO recording_todos") {
		t.Errorf("没把候选落库：%v", store.execs)
	}
	// 文件。
	base := filepath.Join(dir, "recording", "rec_1")
	for _, name := range []string{"transcript.md", "minutes.md", "minutes.json", "diagrams/flow.mmd", "diagrams/tree.mmd"} {
		body, err := os.ReadFile(filepath.Join(base, filepath.FromSlash(name)))
		if err != nil || len(body) == 0 {
			t.Errorf("文件 %s 没写出来：%v", name, err)
		}
	}
	if body, _ := os.ReadFile(filepath.Join(base, "minutes.md")); !strings.Contains(string(body), "会议摘要") {
		t.Errorf("minutes.md 内容不对：%s", body)
	}
	// 高置信度通知（0.92 的任务、0.9 的项目、0.8 的目标 >= 0.7）。
	if len(c.notified) != 1 {
		t.Fatalf("应有 1 条通知，实际 %d", len(c.notified))
	}
	if !strings.Contains(c.notified[0].Title, "待确认候选") || c.notified[0].ObjectID != "rec_1" {
		t.Errorf("通知不对：%+v", c.notified[0])
	}
	if got := c.notified[0].Data["pending_count"]; got != 3 {
		t.Errorf("高置信度候选数应为 3，实际 %v", got)
	}
}

func TestSummarizeRetriesBadJSONOnce(t *testing.T) {
	c, _, agent, _ := newPipelineCore(t)
	agent.responses = []string{"模型胡说八道没有 JSON", fakeMinutesJSONTest, fakeExtractJSONTest}
	p := &Plugin{}
	rec := recordingRow{ID: "rec_1", Title: "周会", Transcript: "聊了官网改版"}
	mins, _, err := p.summarizeRecording(context.Background(), c, rec, Settings{}, nil)
	if err != nil {
		t.Fatalf("解析失败应重试一次并成功：%v", err)
	}
	if agent.callCount() != 3 {
		t.Fatalf("应调 Agent 3 次（坏→重试→候选），实际 %d", agent.callCount())
	}
	if !strings.Contains(mins.SummaryMD, "会议摘要") {
		t.Errorf("重试后纪要不对：%+v", mins)
	}
}

func TestSummarizeFailsAfterRetry(t *testing.T) {
	c, _, agent, _ := newPipelineCore(t)
	agent.responses = []string{"坏", "还是坏"}
	p := &Plugin{}
	if _, _, err := p.summarizeRecording(context.Background(), c, recordingRow{ID: "rec_1", Title: "x", Transcript: "x"}, Settings{}, nil); err == nil {
		t.Fatal("两次都不是 JSON 应该报错（任务重试）")
	}
	if agent.callCount() != 2 {
		t.Errorf("应只重试一次，实际 %d 次", agent.callCount())
	}
}

func TestSummarizeEmptyTranscript(t *testing.T) {
	c, _, agent, _ := newPipelineCore(t)
	p := &Plugin{}
	if _, _, err := p.summarizeRecording(context.Background(), c, recordingRow{ID: "rec_1", Title: "x"}, Settings{}, nil); !errors.Is(err, errValidation) {
		t.Fatalf("没有转写应该校验失败：%v", err)
	}
	if agent.callCount() != 0 {
		t.Errorf("没有转写不该调 Agent，实际 %d 次", agent.callCount())
	}
}

func TestSummarizeFallsBackWhenExtractFails(t *testing.T) {
	c, store, agent, _ := newPipelineCore(t)
	agent.responses = []string{fakeMinutesJSONTest, "提取坏了没有 JSON"}
	p := &Plugin{}
	_, todos, err := p.summarizeRecording(context.Background(), c, recordingRow{ID: "rec_1", Title: "x", Transcript: "转写"}, Settings{}, nil)
	if err != nil {
		t.Fatalf("候选提取失败不该挡纪要：%v", err)
	}
	if len(todos) == 0 {
		t.Fatal("应该用纪要里的数据兜底出候选")
	}
	if !store.hasExec("INSERT INTO recording_todos") {
		t.Errorf("兜底候选没落库")
	}
}

/* ---------- 自动纪要触发 ---------- */

func TestAutoSummarizeQueuesJob(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	p := &Plugin{}
	p.autoSummarize(context.Background(), c, recordingRow{ID: "rec_1", Transcript: "有内容"}, Settings{AutoSummarize: true})
	if !store.hasExec("INSERT INTO recording_jobs") {
		t.Fatalf("没排队 summarize 任务：%v", store.execs)
	}
	q, args := store.lastExec()
	if !strings.Contains(q, "INSERT INTO recording_jobs") || len(args) < 3 || args[2] != "summarize" {
		t.Errorf("任务类型不对：%v %v", q, args)
	}
}

func TestAutoSummarizeUsesSOP(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	runs := &fakeRuns{}
	c.runs = runs
	p := &Plugin{}
	p.autoSummarize(context.Background(), c, recordingRow{ID: "rec_1", ProjectID: "prj_1", Transcript: "有内容"},
		Settings{AutoSummarize: true, MinutesFlow: "sop_recording_minutes"})
	if runs.got.Flow != "sop_recording_minutes" || runs.got.ObjectID != "prj_1" {
		t.Errorf("StartSOP 参数不对：%+v", runs.got)
	}
	if runs.got.Input["recording_id"] != "rec_1" {
		t.Errorf("StartSOP 输入不对：%+v", runs.got.Input)
	}
	if store.hasExec("INSERT INTO recording_jobs") {
		t.Errorf("走 SOP 了就不该再排 summarize：%v", store.execs)
	}
}

func TestAutoSummarizeFallsBackWhenNoSOP(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	c.runs = &fakeRuns{err: plugin.ErrNoSOPStarter}
	p := &Plugin{}
	p.autoSummarize(context.Background(), c, recordingRow{ID: "rec_1", Transcript: "有内容"},
		Settings{AutoSummarize: true, MinutesFlow: "sop_recording_minutes"})
	if !store.hasExec("INSERT INTO recording_jobs") {
		t.Fatalf("SOP 没启用应回退到插件内直连：%v", store.execs)
	}
}

func TestAutoSummarizeSkips(t *testing.T) {
	c, store, _, _ := newPipelineCore(t)
	p := &Plugin{}
	p.autoSummarize(context.Background(), c, recordingRow{ID: "rec_1", Transcript: "有内容"}, Settings{})
	if len(store.execs) != 0 {
		t.Errorf("没开自动纪要不该排任务：%v", store.execs)
	}
	p.autoSummarize(context.Background(), c, recordingRow{ID: "rec_1"}, Settings{AutoSummarize: true})
	if len(store.execs) != 0 {
		t.Errorf("转写为空不该排任务：%v", store.execs)
	}
}

// TestSummarizeRecordingProgress 纪要流水线应当上报进度，前端/任务条才不会一直 0%。
func TestSummarizeRecordingProgress(t *testing.T) {
	c, _, _, _ := newPipelineCore(t)
	p := &Plugin{}
	rec := recordingRow{ID: "rec_1", Title: "官网改版评审", Transcript: "张三：官网改版 Q4 上线。"}
	var got []int
	if _, _, err := p.summarizeRecording(context.Background(), c, rec, Settings{}, func(pct int) {
		got = append(got, pct)
	}); err != nil {
		t.Fatalf("生成纪要失败：%v", err)
	}
	want := []int{45, 80, 95}
	if len(got) != len(want) {
		t.Fatalf("进度回调 = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("进度回调 = %v，期望 %v", got, want)
		}
	}
}
