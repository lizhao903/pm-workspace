package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 执行记录（SOP-01b）：表 sop_runs、sop_run_steps（插件迁移 0002_runs），接口 /api/sop/runs，
// 契约见 docs/api-contract.md「SOP 编排插件 sop」的「运行」。调度在 engine.go，节点执行在 nodes.go。

// 步骤状态，同原型 StepStatus。
const (
	stPending  = "pending"
	stRunning  = "running"
	stPaused   = "paused"
	stReview   = "review"
	stDone     = "done"
	stFailed   = "failed"
	stSkipped  = "skipped"
	stBypassed = "bypassed"
)

// 运行状态，同原型 RunStatus；由步骤算出，存一份只为了按状态筛。
var runStatuses = []string{"running", "waiting", "done", "failed", "stopped"}

func finished(s string) bool { return s == stDone || s == stSkipped || s == stBypassed }

// LogLine 是步骤日志的一行。
type LogLine struct {
	At   time.Time `json:"at"`
	Text string    `json:"text"`
}

// RunStep 是一次执行里一个步骤的记录，形状同原型 RunStep，多到点时间和子执行。
type RunStep struct {
	Key         string     `json:"key"`
	Status      string     `json:"status"`
	Input       Json       `json:"input"`
	Output      Json       `json:"output"`
	Route       string     `json:"route,omitempty"`
	RouteReason string     `json:"route_reason,omitempty"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
	Error       string     `json:"error,omitempty"`
	Edited      string     `json:"edited,omitempty"`
	Attempts    int        `json:"attempts"`
	Log         []LogLine  `json:"log"`
	WakeAt      *time.Time `json:"wake_at,omitempty"`
	ChildRunID  string     `json:"child_run_id,omitempty"`
}

// Run 是一次执行，形状同原型 SopRun：sop_id、sop 改叫 flow_id、flow，多运行状态和父执行。
type Run struct {
	ID          string     `json:"id"`
	FlowID      string     `json:"flow_id"`
	FlowName    string     `json:"flow_name"`
	FlowVersion int        `json:"flow_version"`
	Flow        *Flow      `json:"flow,omitempty"`
	Title       string     `json:"title"`
	Input       Json       `json:"input"`
	StepThrough bool       `json:"step_through"`
	Stopped     bool       `json:"stopped"`
	Status      string     `json:"status"`
	ParentRunID string     `json:"parent_run_id,omitempty"`
	ParentStep  string     `json:"parent_step,omitempty"`
	StartedAt   time.Time  `json:"started_at"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
	UpdatedAt   time.Time  `json:"updated_at"`
	Steps       []RunStep  `json:"steps"`
}

// runStatus 同原型 runStatus，按顺序判断。
func runStatus(r *Run) string {
	if r.Stopped {
		return "stopped"
	}
	if slices.ContainsFunc(r.Steps, func(s RunStep) bool { return s.Status == stFailed }) {
		return "failed"
	}
	if slices.ContainsFunc(r.Steps, func(s RunStep) bool { return s.Status == stPaused || s.Status == stReview }) {
		return "waiting"
	}
	if !slices.ContainsFunc(r.Steps, func(s RunStep) bool { return !finished(s.Status) }) {
		return "done"
	}
	return "running"
}

// focusIndex 同原型：先看等人处理的，再看执行中的，都没有就看最后完成的。
func focusIndex(r *Run) int {
	if i := slices.IndexFunc(r.Steps, func(s RunStep) bool {
		return s.Status == stPaused || s.Status == stReview || s.Status == stFailed
	}); i >= 0 {
		return i
	}
	if i := slices.IndexFunc(r.Steps, func(s RunStep) bool { return s.Status == stRunning }); i >= 0 {
		return i
	}
	last := 0
	for j, s := range r.Steps {
		if s.Status == stDone && s.EndedAt != nil && (r.Steps[last].EndedAt == nil || !s.EndedAt.Before(*r.Steps[last].EndedAt)) {
			last = j
		}
	}
	return last
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

const tsLayout = "2006-01-02T15:04:05.000Z07:00"

func ts(t time.Time) string { return t.UTC().Format(tsLayout) }

func tsPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return ts(*t)
}

func parseTS(s *string) *time.Time {
	if s == nil || *s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return nil
	}
	return &t
}

func jsonCol(v Json) any {
	if v == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func parseJSONCol(s *string) Json {
	if s == nil {
		return nil
	}
	var v Json
	if err := json.Unmarshal([]byte(*s), &v); err != nil {
		return nil
	}
	return v
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

/* ---------- 存取 ---------- */

const runCols = `id, flow_id, flow_version, title, flow, input, step_through, stopped, status, parent_run_id, parent_step, started_at, ended_at, updated_at`

// scanRun 读一行 sop_runs；withFlow 为假时不解析快照（列表用），只取流程名。
func scanRun(row plugin.Row, withFlow bool) (*Run, error) {
	var r Run
	var flow, input, started, updated string
	var parent, parentStep, ended *string
	var through, stopped int
	if err := row.Scan(&r.ID, &r.FlowID, &r.FlowVersion, &r.Title, &flow, &input, &through, &stopped, &r.Status,
		&parent, &parentStep, &started, &ended, &updated); err != nil {
		return nil, err
	}
	var f Flow
	if err := json.Unmarshal([]byte(flow), &f); err != nil {
		return nil, fmt.Errorf("执行 %s 的流程快照坏了：%w", r.ID, err)
	}
	r.FlowName = f.Name
	if withFlow {
		r.Flow = &f
	}
	r.Input = parseJSONCol(&input)
	if r.Input == nil {
		r.Input = Json{}
	}
	r.StepThrough, r.Stopped = through != 0, stopped != 0
	if parent != nil {
		r.ParentRunID = *parent
	}
	if parentStep != nil {
		r.ParentStep = *parentStep
	}
	r.StartedAt = *parseTS(&started)
	r.EndedAt = parseTS(ended)
	if u := parseTS(&updated); u != nil {
		r.UpdatedAt = *u
	}
	return &r, nil
}

const stepCols = `idx, step_key, status, input, output, route, route_reason, error, edited, attempts, log, started_at, ended_at, wake_at, child_run_id`

func scanStep(row plugin.Row) (int, RunStep, error) {
	var s RunStep
	var idx int
	var input, output, started, ended, wake, child *string
	var logs string
	if err := row.Scan(&idx, &s.Key, &s.Status, &input, &output, &s.Route, &s.RouteReason, &s.Error, &s.Edited, &s.Attempts,
		&logs, &started, &ended, &wake, &child); err != nil {
		return 0, s, err
	}
	s.Input, s.Output = parseJSONCol(input), parseJSONCol(output)
	if err := json.Unmarshal([]byte(logs), &s.Log); err != nil || s.Log == nil {
		s.Log = []LogLine{}
	}
	s.StartedAt, s.EndedAt, s.WakeAt = parseTS(started), parseTS(ended), parseTS(wake)
	if child != nil {
		s.ChildRunID = *child
	}
	return idx, s, nil
}

// loadRun 读一次执行和它的步骤；缺的步骤行（写到一半断电）按快照补成未开始。
func loadRun(ctx context.Context, st plugin.Store, id string) (*Run, error) {
	r, err := scanRun(st.QueryRow(ctx, `SELECT `+runCols+` FROM sop_runs WHERE id = ?`, id), true)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, apiErr(errNotFound, "执行 %s 不存在", id)
	}
	if err != nil {
		return nil, err
	}
	defs, err := parseSteps(r.Flow)
	if err != nil {
		return nil, err
	}
	r.Steps = make([]RunStep, len(defs))
	have := make([]bool, len(defs))
	rows, err := st.Query(ctx, `SELECT `+stepCols+` FROM sop_run_steps WHERE run_id = ? ORDER BY idx`, id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		i, s, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		if i >= 0 && i < len(defs) {
			r.Steps[i], have[i] = s, true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, ok := range have {
		if !ok {
			r.Steps[i] = RunStep{Key: defs[i].Key, Status: stPending, Log: []LogLine{}}
		}
	}
	return r, nil
}

func parseSteps(f *Flow) ([]stepDef, error) {
	var defs []stepDef
	if err := json.Unmarshal(f.Steps, &defs); err != nil {
		return nil, fmt.Errorf("流程快照里的步骤坏了：%w", err)
	}
	return defs, nil
}

func insertRun(ctx context.Context, st plugin.Store, r *Run) error {
	flow, _ := json.Marshal(r.Flow)
	if _, err := st.Exec(ctx, `INSERT INTO sop_runs (`+runCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.FlowID, r.FlowVersion, r.Title, string(flow), jsonCol(r.Input), boolInt(r.StepThrough), boolInt(r.Stopped),
		r.Status, nullStr(r.ParentRunID), nullStr(r.ParentStep), ts(r.StartedAt), tsPtr(r.EndedAt), ts(r.UpdatedAt)); err != nil {
		return err
	}
	for i, s := range r.Steps {
		logs, _ := json.Marshal(s.Log)
		if _, err := st.Exec(ctx, `INSERT INTO sop_run_steps (run_id, `+stepCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			r.ID, i, s.Key, s.Status, jsonCol(s.Input), jsonCol(s.Output), s.Route, s.RouteReason, s.Error, s.Edited, s.Attempts,
			string(logs), tsPtr(s.StartedAt), tsPtr(s.EndedAt), tsPtr(s.WakeAt), nullStr(s.ChildRunID)); err != nil {
			return err
		}
	}
	return nil
}

func updateStep(ctx context.Context, st plugin.Store, runID string, i int, s RunStep) error {
	logs, _ := json.Marshal(s.Log)
	_, err := st.Exec(ctx, `UPDATE sop_run_steps SET status = ?, input = ?, output = ?, route = ?, route_reason = ?, error = ?, edited = ?,
		attempts = ?, log = ?, started_at = ?, ended_at = ?, wake_at = ?, child_run_id = ? WHERE run_id = ? AND idx = ?`,
		s.Status, jsonCol(s.Input), jsonCol(s.Output), s.Route, s.RouteReason, s.Error, s.Edited, s.Attempts, string(logs),
		tsPtr(s.StartedAt), tsPtr(s.EndedAt), tsPtr(s.WakeAt), nullStr(s.ChildRunID), runID, i)
	return err
}

func updateRunRow(ctx context.Context, st plugin.Store, r *Run) error {
	_, err := st.Exec(ctx, `UPDATE sop_runs SET step_through = ?, stopped = ?, status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
		boolInt(r.StepThrough), boolInt(r.Stopped), r.Status, tsPtr(r.EndedAt), ts(r.UpdatedAt), r.ID)
	return err
}

// unfinishedRuns 是没结束也没被终止的执行，服务启动时接着调度。
func unfinishedRuns(ctx context.Context, st plugin.Store) ([]string, error) {
	rows, err := st.Query(ctx, `SELECT id FROM sop_runs WHERE ended_at IS NULL AND stopped = 0 ORDER BY started_at, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func countActive(ctx context.Context, st plugin.Store, flowID string) (int, error) {
	var n int
	err := st.QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE flow_id = ? AND ended_at IS NULL AND stopped = 0`, flowID).Scan(&n)
	return n, err
}

/* ---------- 接口 ---------- */

type runs struct {
	c plugin.Core
	e *engine
}

// start 是 POST /api/sop/flows/{id}/runs：用当前定义的快照发起一次执行。
func (h *runs) start(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fl := &flows{c: h.c}
	f, err := fl.get(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	input := Json{}
	if v, ok := raw["input"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &input); err != nil || input == nil {
			fail(w, r, h.c, apiErr(errValidation, "input 必须是对象"))
			return
		}
	}
	var through bool
	if v, ok := raw["step_through"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &through); err != nil {
			fail(w, r, h.c, apiErr(errValidation, "step_through 必须是布尔值"))
			return
		}
	}
	input, err = fillInput(f, input)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	run, err := h.e.create(ctx, f, input, through, "", "")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": run})
}

// fillInput 补上没传的字段默认值，必填的空着回 400；没定义的 key 原样留着。
func fillInput(f Flow, input Json) (Json, error) {
	var fields []sopField
	_ = json.Unmarshal(f.Fields, &fields)
	out := Json{}
	for k, v := range input {
		out[k] = v
	}
	var missing []string
	for _, fd := range fields {
		v, ok := out[fd.Key]
		if !ok || v == nil {
			out[fd.Key] = fd.Default
		}
		if fd.Required && strings.TrimSpace(txt(out[fd.Key])) == "" {
			missing = append(missing, "「"+fd.Label+"」")
		}
	}
	if len(missing) > 0 {
		return nil, apiErr(errValidation, "%s必填", strings.Join(missing, "、"))
	}
	return out, nil
}

// runTitle 同原型：流程名 · 第一个输入值的第一行（按换行或 | 切，前 16 个字）。
func runTitle(f Flow, input Json) string {
	var fields []sopField
	_ = json.Unmarshal(f.Fields, &fields)
	first := ""
	if len(fields) > 0 {
		first = txt(input[fields[0].Key])
	}
	if i := strings.IndexAny(first, "\n|"); i >= 0 {
		first = first[:i]
	}
	first = strings.TrimSpace(first)
	if utf8.RuneCountInString(first) > 16 {
		first = string([]rune(first)[:16])
	}
	if first == "" {
		return f.Name
	}
	return f.Name + " · " + first
}

// RunBrief 是列表里的一次执行：不带快照和每步的输入输出、日志，步骤只给 key、名称、状态。
type RunBrief struct {
	ID          string      `json:"id"`
	FlowID      string      `json:"flow_id"`
	FlowName    string      `json:"flow_name"`
	FlowVersion int         `json:"flow_version"`
	Title       string      `json:"title"`
	StepThrough bool        `json:"step_through"`
	Stopped     bool        `json:"stopped"`
	Status      string      `json:"status"`
	ParentRunID string      `json:"parent_run_id,omitempty"`
	StartedAt   time.Time   `json:"started_at"`
	EndedAt     *time.Time  `json:"ended_at,omitempty"`
	UpdatedAt   time.Time   `json:"updated_at"`
	Focus       int         `json:"focus"`
	Steps       []StepBrief `json:"steps"`
}

type StepBrief struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

func brief(r *Run) RunBrief {
	defs, _ := parseSteps(r.Flow)
	out := RunBrief{ID: r.ID, FlowID: r.FlowID, FlowName: r.FlowName, FlowVersion: r.FlowVersion, Title: r.Title,
		StepThrough: r.StepThrough, Stopped: r.Stopped, Status: r.Status, ParentRunID: r.ParentRunID,
		StartedAt: r.StartedAt, EndedAt: r.EndedAt, UpdatedAt: r.UpdatedAt, Focus: focusIndex(r), Steps: make([]StepBrief, len(r.Steps))}
	for i, s := range r.Steps {
		b := StepBrief{Key: s.Key, Status: s.Status}
		if i < len(defs) {
			b.Name, b.Kind = defs[i].Name, defs[i].Kind
		}
		out.Steps[i] = b
	}
	return out
}

const (
	defaultRunLimit = 200
	maxRunLimit     = 500
)

// list 是 GET /api/sop/runs：按开始时间倒序，可按流程、状态、待我处理筛。
func (h *runs) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	where, args := []string{"1 = 1"}, []any{}
	if v := q.Get("flow_id"); v != "" {
		where, args = append(where, "flow_id = ?"), append(args, v)
	}
	var sts []string
	if v := q.Get("status"); v != "" {
		for _, s := range strings.Split(v, ",") {
			s = strings.TrimSpace(s)
			if !slices.Contains(runStatuses, s) {
				fail(w, r, h.c, apiErr(errValidation, "status 只能是 %s", strings.Join(runStatuses, "、")))
				return
			}
			sts = append(sts, s)
		}
	}
	switch q.Get("mine") {
	case "", "false", "0":
	case "true", "1":
		sts = append(sts, "waiting", "failed")
	default:
		fail(w, r, h.c, apiErr(errValidation, "mine 只能是 true 或 false"))
		return
	}
	if len(sts) > 0 {
		where = append(where, "status IN (?"+strings.Repeat(", ?", len(sts)-1)+")")
		for _, s := range sts {
			args = append(args, s)
		}
	}
	limit := defaultRunLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > maxRunLimit {
			fail(w, r, h.c, apiErr(errValidation, "limit 要在 1 到 %d 之间", maxRunLimit))
			return
		}
		limit = n
	}
	cond := strings.Join(where, " AND ")
	var total int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE `+cond, args...).Scan(&total); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := listRuns(ctx, h.c.Store(), cond, args, limit)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": total}})
}

func listRuns(ctx context.Context, st plugin.Store, cond string, args []any, limit int) ([]RunBrief, error) {
	rows, err := st.Query(ctx, `SELECT `+runCols+` FROM sop_runs WHERE `+cond+` ORDER BY started_at DESC, id DESC LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	var ids []string
	byID := map[string]*Run{}
	for rows.Next() {
		run, err := scanRun(rows, true)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, run.ID)
		byID[run.ID] = run
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []RunBrief{}
	for _, id := range ids {
		run := byID[id]
		defs, err := parseSteps(run.Flow)
		if err != nil {
			return nil, err
		}
		run.Steps = make([]RunStep, len(defs))
		for i, d := range defs {
			run.Steps[i] = RunStep{Key: d.Key, Status: stPending}
		}
		srows, err := st.Query(ctx, `SELECT idx, status, ended_at FROM sop_run_steps WHERE run_id = ?`, id)
		if err != nil {
			return nil, err
		}
		for srows.Next() {
			var i int
			var status string
			var ended *string
			if err := srows.Scan(&i, &status, &ended); err != nil {
				_ = srows.Close()
				return nil, err
			}
			if i >= 0 && i < len(run.Steps) {
				run.Steps[i].Status, run.Steps[i].EndedAt = status, parseTS(ended)
			}
		}
		_ = srows.Close()
		out = append(out, brief(run))
	}
	return out, nil
}

func (h *runs) show(w http.ResponseWriter, r *http.Request) {
	run, err := loadRun(r.Context(), h.c.Store(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": run})
}

// Action 是动作请求体，同原型 RunAction；step 可以是下标（从 0 起）或步骤 key。
type Action struct {
	Kind   string          `json:"kind"`
	Step   json.RawMessage `json:"step"`
	Input  Json            `json:"input"`
	Output Json            `json:"output"`
	Route  string          `json:"route"`
	On     *bool           `json:"on"`
}

var actionKinds = []string{"confirm-input", "approve", "route", "rework", "retry", "skip", "stop", "step-through"}

func (h *runs) act(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	b, _ := json.Marshal(raw)
	var a Action
	if err := json.Unmarshal(b, &a); err != nil {
		fail(w, r, h.c, apiErr(errValidation, "动作格式不对：%s", jsonReason(err)))
		return
	}
	if !slices.Contains(actionKinds, a.Kind) {
		fail(w, r, h.c, apiErr(errValidation, "kind 只能是 %s", strings.Join(actionKinds, "、")))
		return
	}
	for _, k := range []string{"input", "output"} {
		if v, ok := raw[k]; ok && string(v) != "null" && (len(v) == 0 || v[0] != '{') {
			fail(w, r, h.c, apiErr(errValidation, "%s 必须是对象", k))
			return
		}
	}
	if a.Kind == "step-through" && a.On == nil {
		fail(w, r, h.c, apiErr(errValidation, "step-through 要带 on"))
		return
	}
	out, err := h.e.act(ctx, r.PathValue("id"), a)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// pendingCard 是今日卡片「SOP 待我处理」：等人处理（waiting）和失败的执行，最多 5 条。
func pendingCard(ctx context.Context, c plugin.Core) (*plugin.TodayCardData, error) {
	st := c.Store()
	var n int
	if err := st.QueryRow(ctx, `SELECT COUNT(*) FROM sop_runs WHERE status IN ('waiting', 'failed')`).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil
	}
	rs, err := listRuns(ctx, st, `status IN ('waiting', 'failed')`, nil, 5)
	if err != nil {
		return nil, err
	}
	type item struct {
		ID         string    `json:"id"`
		Title      string    `json:"title"`
		FlowID     string    `json:"flow_id"`
		FlowName   string    `json:"flow_name"`
		Status     string    `json:"status"`
		StepKey    string    `json:"step_key"`
		StepName   string    `json:"step_name"`
		StepStatus string    `json:"step_status"`
		StartedAt  time.Time `json:"started_at"`
		UpdatedAt  time.Time `json:"updated_at"`
	}
	items := make([]item, 0, len(rs))
	for _, r := range rs {
		it := item{ID: r.ID, Title: r.Title, FlowID: r.FlowID, FlowName: r.FlowName, Status: r.Status, StartedAt: r.StartedAt, UpdatedAt: r.UpdatedAt}
		if r.Focus < len(r.Steps) {
			s := r.Steps[r.Focus]
			it.StepKey, it.StepName, it.StepStatus = s.Key, s.Name, s.Status
		}
		items = append(items, it)
	}
	return &plugin.TodayCardData{Total: n, Items: items}, nil
}

func newRunID() string { return idgen.Prefixed("spr") }
