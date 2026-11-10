// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流水线视图（AUTO-12）：
//   - GET /api/sop/pipeline/{id}：一条需求（任务）的流水线——跟它有关的执行和每步的状态、轮次、重试，Claude Code 账本，预算用量，卡点。
//     阶段变化不在这里（在内核审计 kind=stage 里），前端拼成一条时间线。
//   - GET /api/sop/waiting：所有等人的步骤（人工检查、人工判断、Agent 等确认、逐步确认、超出上限暂停）和失败了还没重跑的步骤，
//     今日页「待我处理」用。

// 一条执行算到哪个需求上：执行关联的对象（object_id）、输入里的 task_id（研发 pipeline）、
// Claude Code 节点配的关联任务（账本 task_id）、某一步输出里的 task.id（受理流程转任务、设阶段的输出），子执行跟着父执行。

const (
	pipelineMaxRuns = 50
	waitingMax      = 200
)

// 等人的种类（WaitingItem.Wait）
const (
	waitReview  = "review"  // 人工检查
	waitDecide  = "decide"  // 人工判断（选分支）
	waitAgent   = "agent"   // Agent 要调用需确认的工具
	waitConfirm = "confirm" // 逐步确认：执行前等确认输入
	waitHold    = "hold"    // 超出上限暂停（AUTO-12）
	waitFailed  = "failed"  // 失败了等人重试或跳过
	waitTimeout = "timeout" // 失败原因是超时
)

// WaitingItem 是一个等人的步骤。
type WaitingItem struct {
	RunID      string    `json:"run_id"`
	RunTitle   string    `json:"run_title"`
	FlowID     string    `json:"flow_id"`
	FlowName   string    `json:"flow_name"`
	StepKey    string    `json:"step_key"`
	StepName   string    `json:"step_name"`
	StepKind   string    `json:"step_kind"`
	StepStatus string    `json:"step_status"`
	Wait       string    `json:"wait"`
	Reason     string    `json:"reason"`
	Since      time.Time `json:"since"`
	TaskID     string    `json:"task_id,omitempty"`
	Cases      []Case    `json:"cases,omitempty"`
	Hold       *StepHold `json:"hold,omitempty"`
	ClaudeRun  string    `json:"claude_run_id,omitempty"`
}

// waitingOf 看一步是不是在等人；不是回 false。
func waitingOf(run *Run, def stepDef, s RunStep) (WaitingItem, bool) {
	it := WaitingItem{RunID: run.ID, RunTitle: run.Title, FlowID: run.FlowID, FlowName: run.FlowName, StepKey: s.Key,
		StepName: orDefault(def.Name, def.Key), StepKind: def.Kind, StepStatus: s.Status, Since: run.UpdatedAt}
	if s.StartedAt != nil {
		it.Since = *s.StartedAt
	}
	if s.Claude != nil {
		it.ClaudeRun = s.Claude.RunID
	}
	switch s.Status {
	case stReview:
		switch def.Kind {
		case "decide":
			it.Wait, it.Reason, it.Cases = waitDecide, "等人工判断走哪个分支", def.Cases
		case "agent":
			it.Wait, it.Reason = waitAgent, "Agent 要调用需确认的工具，等你在会话里确认"
		default:
			it.Wait, it.Reason = waitReview, "等人工检查"
		}
	case stPaused:
		if waitingHold(s) {
			it.Wait, it.Reason, it.Hold, it.Since = waitHold, s.Hold.Reason, s.Hold, s.Hold.Since
		} else {
			it.Wait, it.Reason = waitConfirm, "执行前暂停，等确认输入"
		}
	case stFailed:
		if run.RelaunchedTo != "" {
			return it, false
		}
		it.Wait, it.Reason = waitFailed, s.Error
		if strings.Contains(s.Error, "超时") {
			it.Wait = waitTimeout
		}
		if s.EndedAt != nil {
			it.Since = *s.EndedAt
		}
	default:
		return it, false
	}
	return it, true
}

// runTaskOf 是一条执行算到的需求（不看父执行）：object_id → 输入 task_id → Claude Code 步骤的关联任务 → 步骤输出的 task.id。
func runTaskOf(run *Run) string {
	if run.ObjectID != "" {
		return run.ObjectID
	}
	if v, ok := run.Input["task_id"].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	for _, s := range run.Steps {
		if s.Claude != nil && s.Claude.TaskID != "" {
			return s.Claude.TaskID
		}
	}
	for _, s := range run.Steps {
		if t, ok := s.Output["task"].(map[string]any); ok {
			if id, ok := t["id"].(string); ok && id != "" {
				return id
			}
		}
	}
	return ""
}

/* ---------- GET /api/sop/waiting ---------- */

type pipelineHandlers struct {
	c plugin.Core
	e *engine
}

// waiting 列出所有等人的步骤：在等人（waiting）或失败了还没重跑的执行里，每个等人的步骤一条，最近的在前。
func (h *pipelineHandlers) waiting(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	runs, err := loadRunsWhere(ctx, h.c.Store(), pendingStatusCond, nil, waitingMax)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	tasks := taskResolver(ctx, h.c.Store(), runs)
	items := []WaitingItem{}
	for _, run := range runs {
		defs, err := parseSteps(run.Flow)
		if err != nil {
			continue
		}
		for i, s := range run.Steps {
			if i >= len(defs) {
				break
			}
			if it, ok := waitingOf(run, defs[i], s); ok {
				it.TaskID = tasks(run)
				items = append(items, it)
			}
		}
	}
	slices.SortStableFunc(items, func(a, b WaitingItem) int { return b.Since.Compare(a.Since) })
	writeJSON(w, http.StatusOK, map[string]any{"data": items, "meta": map[string]int{"total": len(items)}})
}

// loadRunsWhere 读满足条件的执行（带快照和步骤），最近开始的在前。
func loadRunsWhere(ctx context.Context, st plugin.Store, cond string, args []any, limit int) ([]*Run, error) {
	rows, err := st.Query(ctx, `SELECT id FROM sop_runs WHERE `+cond+` ORDER BY started_at DESC, id DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]*Run, 0, len(ids))
	for _, id := range ids {
		run, err := loadRun(ctx, st, id)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, nil
}

// taskResolver 回一个函数：执行 → 它算到的需求，自己认不出时沿父执行往上找（父执行不在手上的去库里读）。
func taskResolver(ctx context.Context, st plugin.Store, runs []*Run) func(*Run) string {
	known := map[string]*Run{}
	for _, r := range runs {
		known[r.ID] = r
	}
	return func(run *Run) string {
		cur := run
		for depth := 0; cur != nil && depth <= maxSubflowDepth; depth++ {
			if t := runTaskOf(cur); t != "" {
				return t
			}
			if cur.ParentRunID == "" {
				return ""
			}
			p, ok := known[cur.ParentRunID]
			if !ok {
				loaded, err := loadRun(ctx, st, cur.ParentRunID)
				if err != nil {
					return ""
				}
				known[loaded.ID], p = loaded, loaded
			}
			cur = p
		}
		return ""
	}
}

/* ---------- GET /api/sop/pipeline/{id} ---------- */

// PipelineStep 是时间线上的一步。
type PipelineStep struct {
	Key          string     `json:"key"`
	Name         string     `json:"name"`
	Kind         string     `json:"kind"`
	Status       string     `json:"status"`
	Attempts     int        `json:"attempts"`
	Round        int        `json:"round,omitempty"`
	Loops        int        `json:"loops,omitempty"`
	ReworkReason string     `json:"rework_reason,omitempty"`
	Route        string     `json:"route,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	EndedAt      *time.Time `json:"ended_at,omitempty"`
	Error        string     `json:"error,omitempty"`
	Hold         *StepHold  `json:"hold,omitempty"`
	ChildRunID   string     `json:"child_run_id,omitempty"`
	ClaudeRunID  string     `json:"claude_run_id,omitempty"`
	Queue        *StepQueue `json:"queue,omitempty"`
}

// PipelineRun 是时间线上的一次执行。
type PipelineRun struct {
	ID          string         `json:"id"`
	FlowID      string         `json:"flow_id"`
	FlowName    string         `json:"flow_name"`
	Title       string         `json:"title"`
	Status      string         `json:"status"`
	ParentRunID string         `json:"parent_run_id,omitempty"`
	ParentStep  string         `json:"parent_step,omitempty"`
	Relaunched  string         `json:"relaunched_to,omitempty"`
	StartedAt   time.Time      `json:"started_at"`
	EndedAt     *time.Time     `json:"ended_at,omitempty"`
	Steps       []PipelineStep `json:"steps"`
}

// ClaudeUsage 是账本里的一次 Claude Code 运行。
type ClaudeUsage struct {
	ID        string     `json:"id"`
	RunID     string     `json:"run_id"`
	Step      string     `json:"step"`
	Attempt   int        `json:"attempt"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	Status    string     `json:"status"`
}

// PipelineBudget 是这条需求的预算用量；上限 0 是不限。
type PipelineBudget struct {
	ClaudeRuns    int `json:"claude_runs"`
	ClaudeMinutes int `json:"claude_minutes"`
	MaxRuns       int `json:"max_runs"`
	MaxMinutes    int `json:"max_minutes"`
}

// Pipeline 是 GET /api/sop/pipeline/{id} 的响应。
type Pipeline struct {
	TaskID   string         `json:"task_id"`
	Runs     []PipelineRun  `json:"runs"`
	Claude   []ClaudeUsage  `json:"claude"`
	Budget   PipelineBudget `json:"budget"`
	Blockers []WaitingItem  `json:"blockers"`
}

func (h *pipelineHandlers) pipeline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		fail(w, r, h.c, apiErr(errValidation, "要带任务 id"))
		return
	}
	p, err := buildPipeline(ctx, h.c.Store(), h.e, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}

func buildPipeline(ctx context.Context, st plugin.Store, e *engine, task string) (*Pipeline, error) {
	runs, err := loadRunsWhere(ctx, st, `object_id = ? OR json_extract(input, '$.task_id') = ?
		OR id IN (SELECT run_id FROM sop_claude_usage WHERE task_id = ?)
		OR id IN (SELECT run_id FROM sop_run_steps WHERE json_extract(output, '$.task.id') = ?)`,
		[]any{task, task, task, task}, pipelineMaxRuns)
	if err != nil {
		return nil, err
	}
	// 子执行跟着父执行（受理流程末尾接的研发 pipeline）
	seen := map[string]bool{}
	for _, r := range runs {
		seen[r.ID] = true
	}
	frontier := runs
	for depth := 0; depth < maxSubflowDepth && len(frontier) > 0 && len(runs) < pipelineMaxRuns; depth++ {
		var ids []any
		var ph []string
		for _, r := range frontier {
			ids, ph = append(ids, r.ID), append(ph, "?")
		}
		kids, err := loadRunsWhere(ctx, st, `parent_run_id IN (`+strings.Join(ph, ", ")+`)`, ids, pipelineMaxRuns)
		if err != nil {
			return nil, err
		}
		frontier = nil
		for _, k := range kids {
			if !seen[k.ID] {
				seen[k.ID] = true
				runs, frontier = append(runs, k), append(frontier, k)
			}
		}
	}
	slices.SortStableFunc(runs, func(a, b *Run) int { return a.StartedAt.Compare(b.StartedAt) })

	out := &Pipeline{TaskID: task, Runs: []PipelineRun{}, Claude: []ClaudeUsage{}, Blockers: []WaitingItem{}}
	for _, run := range runs {
		if e != nil {
			e.markQueued(run)
		}
		defs, err := parseSteps(run.Flow)
		if err != nil {
			continue
		}
		pr := PipelineRun{ID: run.ID, FlowID: run.FlowID, FlowName: run.FlowName, Title: run.Title, Status: run.Status,
			ParentRunID: run.ParentRunID, ParentStep: run.ParentStep, Relaunched: run.RelaunchedTo, StartedAt: run.StartedAt,
			EndedAt: run.EndedAt, Steps: []PipelineStep{}}
		for i, s := range run.Steps {
			if i >= len(defs) {
				break
			}
			d := defs[i]
			ps := PipelineStep{Key: s.Key, Name: orDefault(d.Name, d.Key), Kind: d.Kind, Status: s.Status, Attempts: s.Attempts,
				Round: s.Round, Loops: s.Loops, ReworkReason: s.ReworkReason, Route: s.Route, StartedAt: s.StartedAt, EndedAt: s.EndedAt,
				Error: s.Error, Hold: s.Hold, ChildRunID: s.ChildRunID, Queue: s.Queue}
			if s.Claude != nil {
				ps.ClaudeRunID = s.Claude.RunID
			}
			pr.Steps = append(pr.Steps, ps)
			if it, ok := waitingOf(run, d, s); ok && !run.Stopped {
				it.TaskID = task
				out.Blockers = append(out.Blockers, it)
			}
		}
		out.Runs = append(out.Runs, pr)
	}

	// 账本：按任务记的，加上这些执行里没配任务的步骤
	var ids []any
	var ph []string
	for _, r := range runs {
		ids, ph = append(ids, r.ID), append(ph, "?")
	}
	cond := `task_id = ?`
	args := []any{task}
	if len(ids) > 0 {
		cond += ` OR run_id IN (` + strings.Join(ph, ", ") + `)`
		args = append(args, ids...)
	}
	rows, err := st.Query(ctx, `SELECT id, run_id, step, attempt, started_at, ended_at, status FROM sop_claude_usage
		WHERE `+cond+` ORDER BY started_at, id`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var u ClaudeUsage
		var started string
		var ended *string
		if err := rows.Scan(&u.ID, &u.RunID, &u.Step, &u.Attempt, &started, &ended, &u.Status); err != nil {
			return nil, err
		}
		if t := parseTS(&started); t != nil {
			u.StartedAt = *t
		}
		u.EndedAt = parseTS(ended)
		out.Claude = append(out.Claude, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	g, err := loadGovernance(ctx, st)
	if err != nil {
		return nil, err
	}
	n, used, err := claudeUsage(ctx, st, task, now())
	if err != nil {
		return nil, err
	}
	out.Budget = PipelineBudget{ClaudeRuns: n, ClaudeMinutes: int(used / time.Minute), MaxRuns: g.TaskMaxRuns, MaxMinutes: g.TaskMaxMinutes}
	return out, nil
}
