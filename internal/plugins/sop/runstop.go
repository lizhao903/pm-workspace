package sop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 批量停止执行（TSK-0717）：执行记录列表的勾选停止、「停止全部运行中」，批量分诊的「立即停止」。
//
// 单条停止就是 POST /api/sop/runs/{id}/actions {kind:"stop"}（engine.go 的 apply）：执行记成 stopped、写 ended_at，
// 执行中、等确认、等检查的步骤回到 pending；节点协程的 ctx 取消，所以排队等模型名额的步骤立即出队（gate.go 的 acquire），
// 正在调模型的请求跟着 ctx 取消，挂起等服务商恢复的一起清掉；子流程起的子执行一起终止。这里只是把它批量做：
//
//   - POST /api/sop/runs/batch-actions {action:"stop", run_ids}：1 到 200 条，只停执行中、待我处理的，
//     别的（已完成、失败、已终止、不存在、重复）跳过并写明原因；done 只带 run_id。
//   - POST /api/sop/runs/stop {flow_id?, source?, batch_id?, all_running?, dry_run?}：一次停掉符合条件的全部执行中、待我处理的执行。
//     flow_id、source、batch_id 至少给一个，或者 all_running: true（不给条件时必须明说，免得手滑停掉全部）。
//     batch_id 是批量发起（batch.go）时带的批次：停止后这一批再发起的不再新起执行（内存里记着，服务重启后不记）。
//     父执行和子执行都符合条件时只停父执行，子执行随父执行一起终止，不重复算。
//     dry_run 只数不停：回将停止的条数和范围里各状态的条数，确认框用。
//
// 幂等：已经停了的再停跳过「已终止」，第二次按条件停时已经不在执行中了，matched 为 0。
// 已经建出的任务、写出的文档等不回滚。每次真停了执行记一条审计（action stop、target_type sop_runs）。

// batchIDRe 是批量发起的批次编号：spb_ 加 8 到 32 个小写字母数字（前端生成，同 idgen 的写法）
var batchIDRe = regexp.MustCompile(`^spb_[0-9a-z]{8,32}$`)

// runSources 是 source 能取的值（runs.go 的 Source* 常量）
var runSources = []string{SourceManual, SourceAgent, SourceSchedule, SourceIM, SourceSubflow, SourcePlugin}

// stoppableCond 是能停的执行：执行中、待我处理，没结束也没被终止
const stoppableCond = `status IN ('running', 'waiting') AND stopped = 0 AND ended_at IS NULL`

const actStop = "stop"

// RunStopResult 是按条件停止的结果。
type RunStopResult struct {
	// Matched 是符合条件、要停的执行数（子执行随父执行一起停的不算）
	Matched int      `json:"matched"`
	Stopped []string `json:"stopped"`
	// Skipped 是要停的时候已经结束或被别处停掉了的
	Skipped []RunStopSkipped `json:"skipped"`
	Failed  []RunBatchFailed `json:"failed"`
	// Summary 是范围内（不看状态）各运行状态的条数，停完之后算；dry_run 时是现在的
	Summary map[string]int `json:"summary"`
	DryRun  bool           `json:"dry_run"`
}

// RunStopSkipped 是按条件停止时跳过的一条和原因。
type RunStopSkipped struct {
	RunID  string `json:"run_id"`
	Reason string `json:"reason"`
}

/* ---------- 被停止的批次 ---------- */

// stoppedBatches 记被停止过的批次，批量发起每建一条前后都查。只在内存里，24 小时后清掉。
type stoppedBatches struct {
	mu sync.Mutex
	m  map[string]time.Time
}

const batchStopTTL = 24 * time.Hour

func (b *stoppedBatches) mark(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.m == nil {
		b.m = map[string]time.Time{}
	}
	t := time.Now()
	for k, at := range b.m {
		if t.Sub(at) > batchStopTTL {
			delete(b.m, k)
		}
	}
	b.m[id] = t
}

func (b *stoppedBatches) stopped(id string) bool {
	if id == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.m[id]
	return ok
}

/* ---------- 停一条 ---------- */

// notStoppableReason 是不能停的执行的跳过原因；能停回空串。
func notStoppableReason(run *Run) string {
	if run.Stopped {
		return "已终止"
	}
	if run.EndedAt != nil || (run.Status != "running" && run.Status != "waiting") {
		t := statusText[run.Status]
		if run.Status == stFailed {
			t = "失败"
		}
		if t == "" {
			t = run.Status
		}
		return "不在执行中或待我处理（" + t + "）"
	}
	return ""
}

// stopRun 停一条执行：成功回空串；停的时候它已经结束或被别处停掉了回跳过原因；别的错误回 err。
func (e *engine) stopRun(ctx context.Context, id string) (skip string, err error) {
	_, err = e.act(ctx, id, Action{Kind: actStop})
	if err == nil {
		return "", nil
	}
	cur, lerr := loadRun(ctx, e.c.Store(), id)
	if errors.Is(lerr, errNotFound) {
		return "执行不存在", nil
	}
	if lerr == nil {
		if why := notStoppableReason(cur); why != "" {
			return why, nil
		}
	}
	return "", err
}

// queuedFirst 把有步骤在排队（等模型名额、等 Claude Code 名额）的执行挪到前面，其余顺序不变。
// 先停排队的、最后停占着名额的：停一条占名额的就会放队里下一条进来开始调模型，队里先清空就不会白调。
func (e *engine) queuedFirst(ids []string) []string {
	var q, rest []string
	for _, id := range ids {
		if len(e.gate.queued(id)) > 0 || len(e.cgate.queued(id)) > 0 {
			q = append(q, id)
		} else {
			rest = append(rest, id)
		}
	}
	return append(q, rest...)
}

/* ---------- batch-actions 的 stop ---------- */

// batchStop 是 batch-actions 的 action=stop；ids 已校验过个数。
func (h *runs) batchStop(ctx context.Context, ids []string) RunBatchResult {
	out := RunBatchResult{Done: []RunBatchDone{}, Skipped: []RunBatchSkipped{}, Failed: []RunBatchFailed{}}
	seen := map[string]bool{}
	var todo []string
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: "重复或为空"})
			continue
		}
		seen[id] = true
		todo = append(todo, id)
	}
	for _, id := range h.e.queuedFirst(todo) {
		run, err := loadRun(ctx, h.c.Store(), id)
		if errors.Is(err, errNotFound) {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: "执行不存在"})
			continue
		}
		if err != nil {
			out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
			continue
		}
		if why := notStoppableReason(run); why != "" {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: why})
			continue
		}
		skip, err := h.e.stopRun(ctx, id)
		switch {
		case err != nil:
			out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
		case skip != "":
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: skip})
		default:
			out.Done = append(out.Done, RunBatchDone{RunID: id})
		}
	}
	if len(out.Done) > 0 {
		ids := make([]string, len(out.Done))
		for i, d := range out.Done {
			ids[i] = d.RunID
		}
		h.c.Audit().Note(ctx, plugin.AuditNote{Action: actStop, TargetType: "sop_runs", Summary: "批量停止勾选的 " + strconv.Itoa(len(ids)) + " 条执行",
			Detail: map[string]any{"run_ids": ids, "skipped": len(out.Skipped), "failed": len(out.Failed)}}, plugin.WriteMeta{})
	}
	return out
}

/* ---------- 按条件停止 ---------- */

type stopScope struct {
	FlowID     string
	Source     string
	BatchID    string
	AllRunning bool
	DryRun     bool
}

func parseStopScope(raw map[string]json.RawMessage) (stopScope, error) {
	var sc stopScope
	str := func(k string, dst *string) error {
		v, ok := raw[k]
		if !ok || string(v) == "null" {
			return nil
		}
		if err := json.Unmarshal(v, dst); err != nil {
			return apiErr(errValidation, "%s 必须是字符串", k)
		}
		*dst = strings.TrimSpace(*dst)
		return nil
	}
	flag := func(k string, dst *bool) error {
		v, ok := raw[k]
		if !ok || string(v) == "null" {
			return nil
		}
		if err := json.Unmarshal(v, dst); err != nil {
			return apiErr(errValidation, "%s 必须是布尔值", k)
		}
		return nil
	}
	for _, f := range []func() error{
		func() error { return str("flow_id", &sc.FlowID) },
		func() error { return str("source", &sc.Source) },
		func() error { return str("batch_id", &sc.BatchID) },
		func() error { return flag("all_running", &sc.AllRunning) },
		func() error { return flag("dry_run", &sc.DryRun) },
	} {
		if err := f(); err != nil {
			return sc, err
		}
	}
	if sc.Source != "" && !slices.Contains(runSources, sc.Source) {
		return sc, apiErr(errValidation, "source 只能是 %s", strings.Join(runSources, "、"))
	}
	if sc.BatchID != "" && !batchIDRe.MatchString(sc.BatchID) {
		return sc, apiErr(errValidation, "batch_id 不对：要是 spb_ 加 8 到 32 个小写字母或数字")
	}
	if sc.FlowID == "" && sc.Source == "" && sc.BatchID == "" && !sc.AllRunning {
		return sc, apiErr(errValidation, "要给 flow_id、source、batch_id 中至少一个；要停全部执行中的执行，明确传 all_running: true")
	}
	return sc, nil
}

// where 是范围条件（不看状态）。批次：批量发起的执行来源 manual、source_name「批量发起」、source_ref 记批次。
func (sc stopScope) where() (string, []any) {
	w, args := []string{"1 = 1"}, []any{}
	if sc.FlowID != "" {
		w, args = append(w, "flow_id = ?"), append(args, sc.FlowID)
	}
	if sc.Source != "" {
		w, args = append(w, "source = ?"), append(args, sc.Source)
	}
	if sc.BatchID != "" {
		w, args = append(w, "source = ? AND source_name = ? AND source_ref = ?"), append(args, SourceManual, batchSourceName, sc.BatchID)
	}
	return strings.Join(w, " AND "), args
}

func (sc stopScope) text() string {
	var parts []string
	if sc.BatchID != "" {
		parts = append(parts, "批量发起 "+sc.BatchID)
	}
	if sc.FlowID != "" {
		parts = append(parts, "流程 "+sc.FlowID)
	}
	if sc.Source != "" {
		parts = append(parts, "来源 "+sc.Source)
	}
	if len(parts) == 0 {
		return "全部"
	}
	return strings.Join(parts, "、")
}

// stopWhere 是 POST /api/sop/runs/stop。
func (h *runs) stopWhere(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	sc, err := parseStopScope(raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 停到一半请求断了也接着停完：用户要的就是停
	ctx := context.WithoutCancel(r.Context())
	if sc.BatchID != "" && !sc.DryRun {
		// 先记批次再查：之后这一批还在发起的，建之前、建之后都会看到（batch.go）
		h.e.batches.mark(sc.BatchID)
	}
	scope, args := sc.where()
	ids, err := stoppableIDs(ctx, h.c.Store(), scope, args)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out := RunStopResult{Matched: len(ids), Stopped: []string{}, Skipped: []RunStopSkipped{}, Failed: []RunBatchFailed{}, DryRun: sc.DryRun}
	if !sc.DryRun {
		for _, id := range h.e.queuedFirst(ids) {
			skip, err := h.e.stopRun(ctx, id)
			switch {
			case err != nil:
				out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
			case skip != "":
				out.Skipped = append(out.Skipped, RunStopSkipped{RunID: id, Reason: skip})
			default:
				out.Stopped = append(out.Stopped, id)
			}
		}
		if len(out.Stopped) > 0 {
			h.c.Audit().Note(ctx, plugin.AuditNote{Action: actStop, TargetType: "sop_runs", TargetID: sc.BatchID,
				Summary: "按条件停止 " + strconv.Itoa(len(out.Stopped)) + " 条执行（" + sc.text() + "）",
				Detail: map[string]any{"flow_id": sc.FlowID, "source": sc.Source, "batch_id": sc.BatchID, "all_running": sc.AllRunning,
					"run_ids": out.Stopped, "skipped": len(out.Skipped), "failed": len(out.Failed)}}, plugin.WriteMeta{})
		}
		h.c.Log().Info("sop runs stopped", "scope", sc.text(), "matched", out.Matched, "stopped", len(out.Stopped),
			"skipped", len(out.Skipped), "failed", len(out.Failed))
	}
	if out.Summary, err = statusSummary(ctx, h.c.Store(), scope, args); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// stoppableIDs 是范围内能停的执行，后发起的在前；父执行也在里面的子执行去掉（随父执行一起停）。
// 停的时候再把排队的挪到最前（queuedFirst），后发起的先停：调模型的队列按顶层执行发起时间排，先停队尾，
// 最后才停占着名额的那几条，免得停一条放一条进来、刚排到就开始调模型（一次停几百条时会白调几百次模型）。
func stoppableIDs(ctx context.Context, st plugin.Store, scope string, args []any) ([]string, error) {
	rows, err := st.Query(ctx, `SELECT id, COALESCE(parent_run_id, '') FROM sop_runs WHERE `+stoppableCond+` AND `+scope+
		` ORDER BY started_at DESC, id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	type row struct{ id, parent string }
	var all []row
	in := map[string]bool{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.parent); err != nil {
			return nil, err
		}
		all = append(all, x)
		in[x.id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := []string{}
	for _, x := range all {
		if x.parent != "" && in[x.parent] {
			continue
		}
		ids = append(ids, x.id)
	}
	return ids, nil
}

// statusSummary 是范围内各运行状态的条数，五个状态都给（没有的为 0）。
func statusSummary(ctx context.Context, st plugin.Store, scope string, args []any) (map[string]int, error) {
	out := map[string]int{}
	for _, s := range runStatuses {
		out[s] = 0
	}
	rows, err := st.Query(ctx, `SELECT status, COUNT(*) FROM sop_runs WHERE `+scope+` GROUP BY status`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var s string
		var n int
		if err := rows.Scan(&s, &n); err != nil {
			return nil, err
		}
		if _, ok := out[s]; ok {
			out[s] += n
		}
	}
	return out, rows.Err()
}
