package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流水线治理（AUTO-12，docs/auto-delivery-flow.md 第 5 节「每个回退环都有上限」）。
//
// 三项上限，存在 sop_settings（迁移 0004 的 key / value 表），GET / PATCH /api/sop/settings 改，立即生效：
//   - claude_concurrency：整个插件同时在跑的 Claude Code 步骤数。拿不到名额的步骤仍是 running，
//     日志记「排队等 Claude Code 名额」，执行详情里带 queue {ahead, slot: "claude_code"}；排队规则同调模型的名额（gate.go）。
//   - task_max_claude_runs：每个需求（任务）累计发起 Claude Code 的次数，含重试、条件回退的每一轮；0 是不限。
//   - task_max_claude_minutes：每个需求累计 Claude Code 跑的分钟数（在跑的按到现在算）；0 是不限。
//
// 次数和时长记在账本 sop_claude_usage（迁移 0007），一次发起一行：步骤被退回、重试后旧行还在，所以每一轮都算。
// 「需求」是这一步配的关联任务（config.task）；没配任务时按顶层执行算（同一次流水线共享一份预算）。
//
// 超限：Claude Code 步骤发起前查一次（排队前、排到后各一次），超了就不发起，这一步转 paused（执行转「等人」），
// 步骤上记 hold {kind, reason, since}，发一条错误级通知。人在执行页点「继续」（confirm-input）放行这一次尝试，
// 或「跳过」；也可以到设置里调高上限后再点「继续」。正在跑的那次不打断（它有自己的超时）。
//
// token 用量：内核的 Claude Code 运行记录（plugin.RunInfo）里没有 usage，所以本期只按次数和时长控制，不按 token。

const (
	defaultClaudeConcurrency = 3
	maxClaudeConcurrency     = 10
	defaultTaskMaxRuns       = 30
	maxTaskMaxRuns           = 1000
	defaultTaskMaxMinutes    = 1440
	maxTaskMaxMinutes        = 100000

	settingClaudeConcurrency = "claude_concurrency"
	settingTaskMaxRuns       = "task_max_claude_runs"
	settingTaskMaxMinutes    = "task_max_claude_minutes"
)

// 暂停的原因
const (
	holdRuns     = "runs"     // 次数到上限
	holdDuration = "duration" // 时长到上限
)

// 账本里一次运行的状态
const (
	usageRunning  = "running"
	usageDone     = "done"
	usageFailed   = "failed"
	usageCanceled = "canceled"
)

// StepHold 是一步因为超出上限被暂停的记录（RunStep.Hold，落在 sop_run_steps.hold）。
type StepHold struct {
	// Kind 是 runs（次数）或 duration（时长）
	Kind   string    `json:"kind"`
	Reason string    `json:"reason"`
	Since  time.Time `json:"since"`
	// Released 是人点了「继续」放行；Attempt 是放行的那次尝试，同一次尝试不再拦
	Released   bool       `json:"released,omitempty"`
	ReleasedAt *time.Time `json:"released_at,omitempty"`
	Attempt    int        `json:"attempt,omitempty"`
}

func holdCol(h *StepHold) any {
	if h == nil {
		return nil
	}
	b, _ := json.Marshal(h)
	return string(b)
}

// waitingHold 是这一步正停在「超出上限」上等人。
func waitingHold(s RunStep) bool {
	return s.Status == stPaused && s.Hold != nil && !s.Hold.Released
}

// governance 是三项上限。
type governance struct {
	ClaudeConcurrency int
	TaskMaxRuns       int
	TaskMaxMinutes    int
}

// govSpec 是一项设置的取值范围和默认值；min 为 0 的项 0 表示不限。
type govSpec struct {
	key           string
	min, max, def int
	label, unit   string
}

var govSpecs = []govSpec{
	{settingClaudeConcurrency, 1, maxClaudeConcurrency, defaultClaudeConcurrency, "同时跑的 Claude Code 步骤数", "个"},
	{settingTaskMaxRuns, 0, maxTaskMaxRuns, defaultTaskMaxRuns, "每个需求最多跑 Claude Code 的次数", "次"},
	{settingTaskMaxMinutes, 0, maxTaskMaxMinutes, defaultTaskMaxMinutes, "每个需求 Claude Code 累计时长上限", "分钟"},
}

func loadGovernance(ctx context.Context, st plugin.Store) (governance, error) {
	vals := map[string]int{}
	for _, sp := range govSpecs {
		vals[sp.key] = sp.def
	}
	rows, err := st.Query(ctx, `SELECT key, value FROM sop_settings WHERE key IN (?, ?, ?)`,
		settingClaudeConcurrency, settingTaskMaxRuns, settingTaskMaxMinutes)
	if err != nil {
		return governance{}, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return governance{}, err
		}
		for _, sp := range govSpecs {
			if sp.key == k {
				if n, err := strconv.Atoi(v); err == nil && n >= sp.min && n <= sp.max {
					vals[k] = n
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return governance{}, err
	}
	return governance{ClaudeConcurrency: vals[settingClaudeConcurrency], TaskMaxRuns: vals[settingTaskMaxRuns],
		TaskMaxMinutes: vals[settingTaskMaxMinutes]}, nil
}

/* ---------- Claude Code 并发名额 ---------- */

// take 不排队直接占一个名额（可以超过上限）：停用再启用后接着等已经发起了的运行，它已经在跑了。
func (g *modelGate) take() func() {
	g.mu.Lock()
	g.active++
	g.mu.Unlock()
	return g.releaser()
}

func (e *engine) claudeQueued(runID string) map[string]int {
	if e == nil || e.cgate == nil {
		return nil
	}
	return e.cgate.queued(runID)
}

// claudeGrant 是 Claude Code 步骤排到名额后发回 runner 的通知；token 对不上（步骤已经被收掉）就把名额还回去。
type claudeGrant struct {
	step, token int
	release     func()
}

// dispatchClaude 放出一个 Claude Code 步骤：已经发起过的（停用后恢复）占名额接着等；
// 没发起的先看预算，超了暂停；没超就排队等名额，排到了由 runner 发起（claudeGranted）。
func (r *runner) dispatchClaude(ctx context.Context, i int) {
	s := &r.run.Steps[i]
	if s.Claude != nil && s.Claude.RunID != "" {
		r.watchClaude(ctx, i, r.e.cgate.take())
		return
	}
	task := r.claudeTask(i)
	if r.holdIfOverBudget(ctx, i, task) {
		return
	}
	r.seq++
	token := r.seq
	sctx, cancel := context.WithCancel(ctx)
	r.inflight[i] = inflight{token: token, cancel: cancel}
	root, runID, key := r.rootStart(), r.run.ID, r.defs[i].Key
	r.e.wg.Add(1)
	go func() {
		defer r.e.wg.Done()
		waited := false
		rel, err := r.e.cgate.acquire(sctx, root, runID, key, func(ahead int) {
			waited = true
			r.note(sctx, gateMsg{step: i, token: token, queued: true, ahead: ahead, claude: true})
		})
		if err != nil {
			return
		}
		if waited {
			r.note(sctx, gateMsg{step: i, token: token, claude: true})
		}
		select {
		case r.inbox <- claudeGrant{step: i, token: token, release: rel}:
		case <-sctx.Done():
			rel()
		}
	}()
}

// claudeGranted 是排到名额了：步骤还在等这个名额就发起，不然还回去。
func (r *runner) claudeGranted(ctx context.Context, m claudeGrant) {
	f, ok := r.inflight[m.step]
	s := r.run.Steps[m.step]
	if !ok || f.token != m.token || s.Status != stRunning || s.Claude != nil || r.over() {
		m.release()
		return
	}
	f.cancel()
	delete(r.inflight, m.step)
	r.startClaude(ctx, m.step, m.release)
}

// drainGrants 是 runner 退出时把信箱里没处理的名额还回去。
func (r *runner) drainGrants() {
	for {
		select {
		case m := <-r.inbox:
			if g, ok := m.(claudeGrant); ok {
				g.release()
			}
		default:
			return
		}
	}
}

/* ---------- 预算 ---------- */

// claudeTask 是这一步配的关联任务（config.task 按输入渲染），没配为空串。
func (r *runner) claudeTask(i int) string {
	return strings.TrimSpace(render(r.defs[i].Config["task"], orEmpty(r.run.Steps[i].Input)))
}

// budgetKey 是按谁算预算：有任务按任务 id，没有按顶层执行 id。
func (r *runner) budgetKey(ctx context.Context, task string) string {
	if task != "" {
		return task
	}
	id, parent := r.run.ID, r.run.ParentRunID
	for depth := 0; parent != "" && depth <= maxSubflowDepth; depth++ {
		id = parent
		var p *string
		if err := r.e.c.Store().QueryRow(ctx, `SELECT parent_run_id FROM sop_runs WHERE id = ?`, parent).Scan(&p); err != nil || p == nil {
			break
		}
		parent = *p
	}
	return "run:" + id
}

// claudeUsage 是一份预算已经用了的次数和时长（在跑的按到 at 算）。
func claudeUsage(ctx context.Context, st plugin.Store, key string, at time.Time) (int, time.Duration, error) {
	rows, err := st.Query(ctx, `SELECT started_at, ended_at FROM sop_claude_usage WHERE budget_key = ?`, key)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = rows.Close() }()
	n, total := 0, time.Duration(0)
	for rows.Next() {
		var started string
		var ended *string
		if err := rows.Scan(&started, &ended); err != nil {
			return 0, 0, err
		}
		n++
		s := parseTS(&started)
		e := parseTS(ended)
		if s == nil {
			continue
		}
		end := at
		if e != nil {
			end = *e
		}
		if end.After(*s) {
			total += end.Sub(*s)
		}
	}
	return n, total, rows.Err()
}

// holdIfOverBudget 在发起 Claude Code 前查预算；超了把这一步转 paused、记 hold、发通知，回 true。
// 人放行过的这一次尝试不再拦；查预算出错时不拦（只记日志），免得治理本身把流水线卡死。
func (r *runner) holdIfOverBudget(ctx context.Context, i int, task string) bool {
	s := &r.run.Steps[i]
	if h := s.Hold; h != nil && h.Released && h.Attempt == s.Attempts {
		return false
	}
	st := r.e.c.Store()
	g, err := loadGovernance(ctx, st)
	if err != nil {
		r.e.c.Log().Warn("sop governance not loaded", "err", err)
		return false
	}
	if g.TaskMaxRuns == 0 && g.TaskMaxMinutes == 0 {
		return false
	}
	t := now()
	key := r.budgetKey(ctx, task)
	n, used, err := claudeUsage(ctx, st, key, t)
	if err != nil {
		r.e.c.Log().Warn("sop claude usage not loaded", "err", err)
		return false
	}
	who := r.budgetName(ctx, task)
	var kind, reason string
	switch {
	case g.TaskMaxRuns > 0 && n >= g.TaskMaxRuns:
		kind, reason = holdRuns, fmt.Sprintf("%s已经跑了 %d 次 Claude Code，到了上限 %d 次", who, n, g.TaskMaxRuns)
	case g.TaskMaxMinutes > 0 && used >= time.Duration(g.TaskMaxMinutes)*time.Minute:
		kind, reason = holdDuration, fmt.Sprintf("%sClaude Code 累计跑了 %d 分钟，到了上限 %d 分钟", who, int(used/time.Minute), g.TaskMaxMinutes)
	default:
		return false
	}
	s.Status, s.Hold = stPaused, &StepHold{Kind: kind, Reason: reason, Since: t}
	if s.Attempts > 0 {
		// 这次尝试没真正发起，放行时再加回来
		s.Attempts--
	}
	r.log(i, t, "超出上限，暂停："+reason+"。点「继续」放行这一次，或到 SOP 设置里调高上限")
	r.notifyHold(i, task, reason)
	return true
}

// budgetName 是预算归属的说法：「需求 TSK-0001 」或「这次流水线」。
func (r *runner) budgetName(ctx context.Context, task string) string {
	if task == "" {
		return "这次流水线"
	}
	if o, err := r.e.c.Objects().Get(ctx, task); err == nil && o.Ref != "" {
		return "需求 " + o.Ref + " "
	}
	return "需求 " + task + " "
}

// notifyHold 发一条错误级通知：哪个流程的哪一步超出上限暂停了。发不出去只记日志。
func (r *runner) notifyHold(i int, task, reason string) {
	def := r.defs[i]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := r.e.c.Notify(ctx, plugin.Notification{
		Kind:     "budget_hold",
		Level:    plugin.NotifyError,
		Title:    "「" + r.run.FlowName + "」" + orDefault(def.Name, def.Key) + "超出上限，已暂停",
		Body:     reason + "。到执行页点「继续」放行这一次，或到 SOP 设置里调高上限。",
		ObjectID: task,
		Data:     map[string]any{"run_id": r.run.ID, "step": def.Key},
	})
	if err != nil && !errors.Is(err, plugin.ErrNoNotifier) {
		r.e.c.Log().Warn("sop budget hold not notified", "run", r.run.ID, "step", def.Key, "err", err)
	}
}

/* ---------- 账本 ---------- */

// recordUsage 在账本上记一次发起。写失败只记日志：预算会少算这一次，但不该让执行失败。
func (r *runner) recordUsage(ctx context.Context, i int, claudeRun, task string, at time.Time) {
	s := r.run.Steps[i]
	_, err := r.e.c.Store().Exec(ctx, `INSERT INTO sop_claude_usage (id, run_id, step, attempt, task_id, budget_key, started_at, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
		claudeRun, r.run.ID, s.Key, s.Attempts, task, r.budgetKey(ctx, task), ts(at), usageRunning)
	if err != nil {
		r.e.c.Log().Warn("sop claude usage not recorded", "run", r.run.ID, "step", s.Key, "err", err)
	}
}

// finishUsage 记下一次运行结束；已经记过的不改。
func finishUsage(st plugin.Store, claudeRun, status string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = st.Exec(ctx, `UPDATE sop_claude_usage SET ended_at = ?, status = ? WHERE id = ? AND ended_at IS NULL`, ts(now()), status, claudeRun)
}
