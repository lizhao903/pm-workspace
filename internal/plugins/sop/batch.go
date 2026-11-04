package sop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 批量发起和按输入字段查执行（IM 消息页的批量分诊、处理队列）。
//
// POST /api/sop/flows/{id}/runs/batch：body {"inputs": [{...}, ...], "skip_existing_key": "message_id"}，
// 每个输入发起一次执行（同 POST /api/sop/flows/{id}/runs：当前定义的快照、补默认值、必填空着记失败），最多 batchMax 个。
// 给了 skip_existing_key 时，这条流程里已经有执行（任意状态）的输入里这个字段值相同的跳过，同一批里重复的也只发起一次；
// 不给就都发起（「已跑过的也重跑」）。来源记 manual（界面上发起），source_name 记「批量发起」。
// 回 200 {started:[{index, run_id, key}], skipped:[{index, run_id, key}], failed:[{index, key, error}]}，
// index 是 inputs 里的下标，key 是 skip_existing_key 字段的值（没给 skip_existing_key 时为空串）；一条失败不影响别的。
//
// GET /api/sop/runs 加两个筛选（runs.go 的 list）：input_key=<字段> 只列输入里这个字段非空的执行，
// 每条多回 input_value（这个字段的值）；input_value=<值,值> 再按值筛。列表的步骤带 queue（在排队等模型名额时，同 RunStep.queue）。

const (
	// batchMax 是一次批量发起的上限，同 IM 页「当前筛选结果全部」的上限
	batchMax = 200
	// batchSourceName 是批量发起的执行在来源上的名字
	batchSourceName = "批量发起"
)

// inputKeyRe 是能用来查重、筛选的输入字段名：同流程字段 key 的规则，进 JSON 路径前先过一遍
var inputKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// BatchItem 是批量发起结果里的一项。
type BatchItem struct {
	Index int    `json:"index"`
	RunID string `json:"run_id,omitempty"`
	Key   string `json:"key"`
	Error string `json:"error,omitempty"`
}

// BatchResult 是批量发起的结果。
type BatchResult struct {
	Started []BatchItem `json:"started"`
	Skipped []BatchItem `json:"skipped"`
	Failed  []BatchItem `json:"failed"`
}

func (h *runs) startBatch(w http.ResponseWriter, r *http.Request) {
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
	var inputs []Json
	if v, ok := raw["inputs"]; !ok || json.Unmarshal(v, &inputs) != nil {
		fail(w, r, h.c, apiErr(errValidation, "inputs 必须是对象数组"))
		return
	}
	if len(inputs) == 0 {
		fail(w, r, h.c, apiErr(errValidation, "inputs 不能为空"))
		return
	}
	if len(inputs) > batchMax {
		fail(w, r, h.c, apiErr(errValidation, "一次最多发起 %d 个，这次有 %d 个", batchMax, len(inputs)))
		return
	}
	var key string
	if v, ok := raw["skip_existing_key"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &key); err != nil {
			fail(w, r, h.c, apiErr(errValidation, "skip_existing_key 必须是字符串"))
			return
		}
		if key = strings.TrimSpace(key); key != "" && !inputKeyRe.MatchString(key) {
			fail(w, r, h.c, apiErr(errValidation, "skip_existing_key 只能是字母、数字、下划线"))
			return
		}
	}
	out := BatchResult{Started: []BatchItem{}, Skipped: []BatchItem{}, Failed: []BatchItem{}}
	seen := map[string]string{} // 这一批里已发起的值 → 执行 id
	for i, in := range inputs {
		if in == nil {
			in = Json{}
		}
		val := ""
		if key != "" {
			val = strings.TrimSpace(txt(in[key]))
			if val != "" {
				if id, ok := seen[val]; ok {
					out.Skipped = append(out.Skipped, BatchItem{Index: i, RunID: id, Key: val})
					continue
				}
				id, err := existingRun(ctx, h, f.ID, key, val)
				if err != nil {
					fail(w, r, h.c, err)
					return
				}
				if id != "" {
					out.Skipped = append(out.Skipped, BatchItem{Index: i, RunID: id, Key: val})
					continue
				}
			}
		}
		filled, err := fillInput(f, in)
		if err != nil {
			out.Failed = append(out.Failed, BatchItem{Index: i, Key: val, Error: plainErr(err).Error()})
			continue
		}
		run, err := h.e.create(ctx, f, filled, false, origin{Source: SourceManual, SourceName: batchSourceName})
		if err != nil {
			out.Failed = append(out.Failed, BatchItem{Index: i, Key: val, Error: plainErr(err).Error()})
			continue
		}
		if val != "" {
			seen[val] = run.ID
		}
		out.Started = append(out.Started, BatchItem{Index: i, RunID: run.ID, Key: val})
	}
	h.c.Log().Info("sop batch started", "flow", f.ID, "started", len(out.Started), "skipped", len(out.Skipped), "failed", len(out.Failed))
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// existingRun 回这条流程里输入字段 key 等于 val 的最近一次执行 id，没有为空串。
func existingRun(ctx context.Context, h *runs, flowID, key, val string) (string, error) {
	var id string
	err := h.c.Store().QueryRow(ctx, `SELECT id FROM sop_runs WHERE flow_id = ? AND json_extract(input, ?) = ?
		ORDER BY started_at DESC, id DESC LIMIT 1`, flowID, "$."+key, val).Scan(&id)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// inputFilter 是 GET /api/sop/runs 的 input_key、input_value 筛选；没给 input_key 时回空。
func inputFilter(key, values string) (where []string, args []any, err error) {
	key = strings.TrimSpace(key)
	if key == "" {
		if strings.TrimSpace(values) != "" {
			return nil, nil, apiErr(errValidation, "input_value 要和 input_key 一起用")
		}
		return nil, nil, nil
	}
	if !inputKeyRe.MatchString(key) {
		return nil, nil, apiErr(errValidation, "input_key 只能是字母、数字、下划线")
	}
	path := "$." + key
	where = append(where, "COALESCE(json_extract(input, ?), '') <> ''")
	args = append(args, path)
	var vs []string
	for _, v := range strings.Split(values, ",") {
		if v = strings.TrimSpace(v); v != "" {
			vs = append(vs, v)
		}
	}
	if len(vs) > maxRunLimit {
		return nil, nil, apiErr(errValidation, "input_value 最多 %d 个", maxRunLimit)
	}
	if len(vs) > 0 {
		where = append(where, "json_extract(input, ?) IN (?"+strings.Repeat(", ?", len(vs)-1)+")")
		args = append(args, path)
		for _, v := range vs {
			args = append(args, v)
		}
	}
	return where, args, nil
}

// fillInputValues 给列表里的执行补上输入字段 key 的值。
func fillInputValues(ctx context.Context, h *runs, key string, list []RunBrief) error {
	if key == "" || len(list) == 0 {
		return nil
	}
	ph := make([]string, len(list))
	args := []any{"$." + key}
	idx := map[string]int{}
	for i, b := range list {
		ph[i] = "?"
		args = append(args, b.ID)
		idx[b.ID] = i
	}
	rows, err := h.c.Store().Query(ctx, `SELECT id, CAST(json_extract(input, ?) AS TEXT) FROM sop_runs WHERE id IN (`+strings.Join(ph, ", ")+`)`, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id string
		var v *string
		if err := rows.Scan(&id, &v); err != nil {
			return err
		}
		if i, ok := idx[id]; ok && v != nil {
			list[i].InputValue = *v
		}
	}
	return rows.Err()
}

// markBriefQueued 给列表里在排队等模型名额的步骤标上 queue（同 engine.markQueued，按步骤 key 对）。
func (e *engine) markBriefQueued(list []RunBrief) {
	if e == nil || e.gate == nil {
		return
	}
	for i := range list {
		q, cq := e.gate.queued(list[i].ID), e.claudeQueued(list[i].ID)
		if len(q) == 0 && len(cq) == 0 {
			continue
		}
		for j := range list[i].Steps {
			st := &list[i].Steps[j]
			if st.Status != stRunning {
				continue
			}
			if n, ok := q[st.Key]; ok {
				st.Queue = &StepQueue{Ahead: n}
			} else if n, ok := cq[st.Key]; ok {
				st.Queue = &StepQueue{Ahead: n, Slot: claudeKind}
			}
		}
	}
}
