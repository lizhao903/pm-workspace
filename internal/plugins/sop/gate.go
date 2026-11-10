// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 调模型的并发上限（SOP-07）：整个插件（跨所有执行）同时调模型的步骤不超过 model_concurrency 个。
// 调模型的节点是 ai、extract、classifier、iterate、agent（isModelKind）；knowledge 只做本地关键词检索，不调模型，不算。
// 拿不到名额的步骤仍是 running，日志记「排队等模型（前面还有 N 个）」，执行详情里这一步带 queue {ahead}；
// 排到了记「排到了，开始调模型」再执行。取消、终止、退回时排队的立即退出，不占名额。
// 排队顺序：先按所属顶层执行的发起时间（子流程算父执行的），同一执行里按进队先后——
// 先来的消息先跑完，不会被后来的消息一层层插队拖慢；每个步骤总会排到前面，不会饿死。
// 服务重启后排队的步骤按断点续跑重新进队。
// 设置在 sop_settings（迁移 0004），GET / PATCH /api/sop/settings；改了立即生效：调大马上放排队的进来，调小时已在跑的不打断。

const (
	defaultModelConcurrency = 2
	maxModelConcurrency     = 16
	settingModelConcurrency = "model_concurrency"
)

// isModelKind 是要调模型的节点。
func isModelKind(kind string) bool {
	switch kind {
	case "ai", "extract", "classifier", "iterate", "agent":
		return true
	}
	return false
}

// modelGate 是带优先级的计数信号量：名额满了按 (root, seq) 排队，放名额时给排最前的。
type modelGate struct {
	mu      sync.Mutex
	limit   int
	active  int
	seq     uint64
	waiters []*gateWaiter // 按 (root, seq) 排好
}

type gateWaiter struct {
	root    time.Time
	seq     uint64
	runID   string
	step    string
	ready   chan struct{}
	granted bool
}

func newModelGate(limit int) *modelGate { return &modelGate{limit: limit} }

func (w *gateWaiter) before(o *gateWaiter) bool {
	if !w.root.Equal(o.root) {
		return w.root.Before(o.root)
	}
	return w.seq < o.seq
}

// acquire 拿一个名额，拿到回 release；要排队时先调 queued(前面还有几个)。ctx 取消时退出队列回错误。
func (g *modelGate) acquire(ctx context.Context, root time.Time, runID, step string, queued func(ahead int)) (func(), error) {
	g.mu.Lock()
	if g.active < g.limit && len(g.waiters) == 0 {
		g.active++
		g.mu.Unlock()
		return g.releaser(), nil
	}
	g.seq++
	w := &gateWaiter{root: root, seq: g.seq, runID: runID, step: step, ready: make(chan struct{})}
	pos := len(g.waiters)
	for i, o := range g.waiters {
		if w.before(o) {
			pos = i
			break
		}
	}
	g.waiters = slices.Insert(g.waiters, pos, w)
	g.mu.Unlock()
	if queued != nil {
		queued(pos)
	}
	select {
	case <-w.ready:
		return g.releaser(), nil
	case <-ctx.Done():
		g.mu.Lock()
		if w.granted {
			// 刚好同时给了名额：还回去，让下一个进来
			g.active--
			g.grant()
		} else {
			g.waiters = slices.DeleteFunc(g.waiters, func(o *gateWaiter) bool { return o == w })
		}
		g.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (g *modelGate) releaser() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.active--
			g.grant()
			g.mu.Unlock()
		})
	}
}

// grant 在有空名额时按顺序放排队的进来，调用方持锁。
func (g *modelGate) grant() {
	for g.active < g.limit && len(g.waiters) > 0 {
		w := g.waiters[0]
		g.waiters = g.waiters[1:]
		w.granted = true
		g.active++
		close(w.ready)
	}
}

// setLimit 改上限：调大马上放排队的进来；调小时已在跑的不打断，跑完一个少放一个。
func (g *modelGate) setLimit(n int) {
	g.mu.Lock()
	g.limit = n
	g.grant()
	g.mu.Unlock()
}

// queued 回一条执行里正在排队的步骤 → 前面还有几个。
func (g *modelGate) queued(runID string) map[string]int {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out map[string]int
	for i, w := range g.waiters {
		if w.runID == runID {
			if out == nil {
				out = map[string]int{}
			}
			out[w.step] = i
		}
	}
	return out
}

// stats 回上限、在调模型的、排队的个数。
func (g *modelGate) stats() (limit, active, waiting int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.limit, g.active, len(g.waiters)
}

// markQueued 给回给前端的执行标上排队中的步骤（只在内存里，不落库）。
func (e *engine) markQueued(run *Run) {
	e.markProviderWait(run)
	if run == nil || e.gate == nil {
		return
	}
	q, cq := e.gate.queued(run.ID), e.claudeQueued(run.ID)
	for i := range run.Steps {
		if run.Steps[i].Status != stRunning {
			continue
		}
		if n, ok := q[run.Steps[i].Key]; ok {
			run.Steps[i].Queue = &StepQueue{Ahead: n}
		} else if n, ok := cq[run.Steps[i].Key]; ok {
			run.Steps[i].Queue = &StepQueue{Ahead: n, Slot: claudeKind}
		}
	}
}

/* ---------- 设置 ---------- */

func modelConcurrency(ctx context.Context, st plugin.Store) (int, error) {
	var v string
	err := st.QueryRow(ctx, `SELECT value FROM sop_settings WHERE key = ?`, settingModelConcurrency).Scan(&v)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return defaultModelConcurrency, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > maxModelConcurrency {
		return defaultModelConcurrency, nil
	}
	return n, nil
}

// sopSettings 是 GET / PATCH /api/sop/settings 的响应；running、queued、claude_running、claude_queued 是此刻的数，只读。
// claude_concurrency、task_max_claude_runs、task_max_claude_minutes 是流水线治理（AUTO-12，governance.go）；
// token_limit_supported 恒为 false：Claude Code 的运行记录里没有 token 用量，只按次数和时长控制。
type sopSettings struct {
	ModelConcurrency     int  `json:"model_concurrency"`
	Running              int  `json:"running"`
	Queued               int  `json:"queued"`
	ClaudeConcurrency    int  `json:"claude_concurrency"`
	ClaudeRunning        int  `json:"claude_running"`
	ClaudeQueued         int  `json:"claude_queued"`
	TaskMaxClaudeRuns    int  `json:"task_max_claude_runs"`
	TaskMaxClaudeMinutes int  `json:"task_max_claude_minutes"`
	TokenLimitSupported  bool `json:"token_limit_supported"`
}

type settings struct {
	c plugin.Core
	e *engine
}

func (h *settings) get(w http.ResponseWriter, r *http.Request) {
	n, err := modelConcurrency(r.Context(), h.c.Store())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	g, err := loadGovernance(r.Context(), h.c.Store())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	_, active, waiting := h.e.gate.stats()
	_, cActive, cWaiting := h.e.cgate.stats()
	writeJSON(w, http.StatusOK, map[string]any{"data": sopSettings{ModelConcurrency: n, Running: active, Queued: waiting,
		ClaudeConcurrency: g.ClaudeConcurrency, ClaudeRunning: cActive, ClaudeQueued: cWaiting,
		TaskMaxClaudeRuns: g.TaskMaxRuns, TaskMaxClaudeMinutes: g.TaskMaxMinutes}})
}

// patch 改设置：每项只校验给了的；有一项不合法整个请求 400、都不改。值变了各记一条审计。
func (h *settings) patch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	specs := append([]govSpec{{settingModelConcurrency, 1, maxModelConcurrency, defaultModelConcurrency, "同时调模型的步骤数", ""}}, govSpecs...)
	type change struct {
		sp  govSpec
		val int
	}
	var changes []change
	for _, sp := range specs {
		v, ok := raw[sp.key]
		if !ok {
			continue
		}
		n, err := strconv.Atoi(string(v))
		if err != nil || n < sp.min || n > sp.max {
			fail(w, r, h.c, apiErr(errValidation, "%s 要是 %d 到 %d 的整数", sp.key, sp.min, sp.max))
			return
		}
		changes = append(changes, change{sp, n})
	}
	old, err := modelConcurrency(ctx, h.c.Store())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	g, err := loadGovernance(ctx, h.c.Store())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	before := map[string]int{settingModelConcurrency: old, settingClaudeConcurrency: g.ClaudeConcurrency,
		settingTaskMaxRuns: g.TaskMaxRuns, settingTaskMaxMinutes: g.TaskMaxMinutes}
	for _, c := range changes {
		if _, err := h.c.Store().Exec(ctx, `INSERT INTO sop_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			c.sp.key, strconv.Itoa(c.val), ts(now())); err != nil {
			fail(w, r, h.c, err)
			return
		}
		switch c.sp.key {
		case settingModelConcurrency:
			h.e.gate.setLimit(c.val)
		case settingClaudeConcurrency:
			h.e.cgate.setLimit(c.val)
		}
		if from := before[c.sp.key]; from != c.val {
			h.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "sop_settings", TargetID: c.sp.key,
				Summary: c.sp.label + " " + limitText(from) + " → " + limitText(c.val), Detail: map[string]any{"from": from, "to": c.val}}, plugin.WriteMeta{})
		}
	}
	h.get(w, r)
}

// limitText 是审计里的值：0 写成「不限」（只有次数、时长两项能是 0）。
func limitText(n int) string {
	if n == 0 {
		return "不限"
	}
	return strconv.Itoa(n)
}
