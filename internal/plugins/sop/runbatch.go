package sop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 失败执行批量重跑（执行记录「失败」页的多选）。
//
// POST /api/sop/runs/batch-actions：body {"run_ids": [...], "action": "retry" | "relaunch"}，run_ids 1 到 batchMax 个。
//   - retry：在原执行里重试它所有失败的步骤（同单条 retry 动作，沿用发起时的流程快照）；
//   - relaunch：用原执行的输入、流程当前定义新发起一条执行（同 POST /api/sop/flows/{id}/runs），原执行保留不动。
//     子执行（parent_run_id 非空）不单独重新发起，换成它的顶层执行；同一批里落到同一条顶层执行的只发起一次。
//     新执行来源记 manual，source_ref 记被重新发起的那条（顶层）执行 id，source_name 记「批量重跑」；
//     逐步确认、关联对象照原执行（对象已经不在了就不关联）。
//
// 不是 failed 的、不存在的、同一批里重复的跳过并给原因；一条出错不影响别的。
//
// 幂等（迁移 0005 的 relaunched_to）：
//   - relaunch 先用条件更新给顶层执行占位（relaunched_to 从 NULL 改成 pending:<随机串>），占不到说明已经重跑过或正在重跑，跳过；
//     建好新执行换成新执行 id，并把顶层执行下面失败的子执行也记成它；建失败清掉占位。同一条失败执行并发点两次也只新起一条。
//     已重跑过的跳过，原因「已重跑过」并带那条新执行 id。
//   - retry 的动作交给这条执行的 runner 串行处理（engine.go），第二次进来时步骤已不是失败，跳过并写明现在的状态；
//     已重跑过的失败执行也不再重试，跳过「已重跑过」。
// 回 200 {done:[{run_id, new_run_id?, steps?}], skipped:[{run_id, reason, new_run_id?}], failed:[{run_id, error}]}：
// retry 的 done 带重试了的步骤 key；relaunch 的 done 带新执行 id，因同一顶层执行去重跳过的也带上那条新执行 id。
// 新执行和重试的步骤照常受调模型并发上限（gate.go）排队。

const (
	// relaunchSourceName 是批量重跑新发起的执行在来源上的名字
	relaunchSourceName = "批量重跑"
	actRetry           = "retry"
	actRelaunch        = "relaunch"
)

// RunBatchDone 是批量重跑里做成了的一条。
type RunBatchDone struct {
	RunID    string   `json:"run_id"`
	NewRunID string   `json:"new_run_id,omitempty"`
	Steps    []string `json:"steps,omitempty"`
}

// RunBatchSkipped 是跳过的一条和原因。
type RunBatchSkipped struct {
	RunID    string `json:"run_id"`
	Reason   string `json:"reason"`
	NewRunID string `json:"new_run_id,omitempty"`
}

// RunBatchFailed 是出错的一条。
type RunBatchFailed struct {
	RunID string `json:"run_id"`
	Error string `json:"error"`
}

// RunBatchResult 是批量重跑的结果。
type RunBatchResult struct {
	Done    []RunBatchDone    `json:"done"`
	Skipped []RunBatchSkipped `json:"skipped"`
	Failed  []RunBatchFailed  `json:"failed"`
}

var statusText = map[string]string{"running": "执行中", "waiting": "待我处理", "done": "已完成", "stopped": "已终止"}

func (h *runs) batchAct(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var action string
	if v, ok := raw["action"]; !ok || json.Unmarshal(v, &action) != nil || (action != actRetry && action != actRelaunch) {
		fail(w, r, h.c, apiErr(errValidation, "action 只能是 retry 或 relaunch"))
		return
	}
	var ids []string
	if v, ok := raw["run_ids"]; !ok || json.Unmarshal(v, &ids) != nil {
		fail(w, r, h.c, apiErr(errValidation, "run_ids 必须是字符串数组"))
		return
	}
	if len(ids) == 0 {
		fail(w, r, h.c, apiErr(errValidation, "run_ids 不能为空"))
		return
	}
	if len(ids) > batchMax {
		fail(w, r, h.c, apiErr(errValidation, "一次最多重跑 %d 条，这次有 %d 条", batchMax, len(ids)))
		return
	}
	out := RunBatchResult{Done: []RunBatchDone{}, Skipped: []RunBatchSkipped{}, Failed: []RunBatchFailed{}}
	seen := map[string]bool{}
	tops := map[string]string{} // 这一批里已重新发起的顶层执行 → 新执行 id
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: "重复或为空"})
			continue
		}
		seen[id] = true
		run, err := loadRun(ctx, h.c.Store(), id)
		if errors.Is(err, errNotFound) {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: "执行不存在"})
			continue
		}
		if err != nil {
			out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
			continue
		}
		if run.Status != stFailed {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: notFailedReason(run.Status)})
			continue
		}
		// relaunch 先换成顶层执行：同一批里已经一起重新发起的，按同一批去重说明（它的子执行这时已记上已重跑）
		var top *Run
		if action == actRelaunch {
			if top, err = topRun(ctx, h, run); err != nil {
				out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
				continue
			}
			if nid, ok := tops[top.ID]; ok {
				out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: "和同一批里的执行同属顶层执行 " + top.ID + "，已一起重新发起", NewRunID: nid})
				continue
			}
		}
		if run.RelaunchedTo != "" {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: reasonRelaunched, NewRunID: run.RelaunchedTo})
			continue
		}
		if run.relaunching {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: reasonRelaunching})
			continue
		}
		if action == actRetry {
			steps, err := h.retryFailed(ctx, run)
			if err != nil {
				// 并发的另一次已经重试上了（runner 串行处理，这次进去时步骤已不是失败）：按步骤现在的状态算跳过。
				// 运行行的 status 在步骤之后写，这里按步骤重算，不看那一列
				if cur, lerr := loadRun(ctx, h.c.Store(), id); lerr == nil && runStatus(cur) != stFailed {
					out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: notFailedReason(runStatus(cur))})
					continue
				}
				out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
				continue
			}
			out.Done = append(out.Done, RunBatchDone{RunID: id, Steps: steps})
			continue
		}
		nid, skip, err := h.relaunchOnce(ctx, top)
		if err != nil {
			out.Failed = append(out.Failed, RunBatchFailed{RunID: id, Error: plainErr(err).Error()})
			continue
		}
		if skip != "" {
			out.Skipped = append(out.Skipped, RunBatchSkipped{RunID: id, Reason: skip, NewRunID: nid})
			continue
		}
		tops[top.ID] = nid
		out.Done = append(out.Done, RunBatchDone{RunID: id, NewRunID: nid})
	}
	h.c.Log().Info("sop runs batch action", "action", action, "done", len(out.Done), "skipped", len(out.Skipped), "failed", len(out.Failed))
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

const (
	// reasonRelaunched 是已经按最新流程重跑过的失败执行再重跑时跳过的原因
	reasonRelaunched = "已重跑过"
	// reasonRelaunching 是另一次重跑正在给它新起执行（占位还没换成新执行 id）时跳过的原因
	reasonRelaunching = "正在重跑"
	// relaunchClaimPrefix 是重跑进行中写在 relaunched_to 里的占位前缀；执行 id 都是 spr_ 开头，不会撞
	relaunchClaimPrefix = "pending:"
)

func isRelaunchClaim(v string) bool { return strings.HasPrefix(v, relaunchClaimPrefix) }

func notFailedReason(status string) string {
	t := statusText[status]
	if t == "" {
		t = status
	}
	return "不是失败状态（" + t + "）"
}

// relaunchOnce 给顶层执行占位后新起一条执行，回新执行 id；已重跑过、正在重跑的不新起，回那条新执行 id（正在重跑时为空）和跳过原因。
func (h *runs) relaunchOnce(ctx context.Context, top *Run) (newID, skip string, err error) {
	// 引擎起来前不占位：启动时会把残留的占位修掉（engine.go 的 job），先等它做完
	if _, err := h.e.waitReady(ctx); err != nil {
		return "", "", err
	}
	st := h.c.Store()
	claim := relaunchClaimPrefix + idgen.Prefixed("spr")
	res, err := st.Exec(ctx, `UPDATE sop_runs SET relaunched_to = ? WHERE id = ? AND relaunched_to IS NULL`, claim, top.ID)
	if err != nil {
		return "", "", err
	}
	if n, err := res.RowsAffected(); err != nil {
		return "", "", err
	} else if n == 0 {
		var cur *string
		if err := st.QueryRow(ctx, `SELECT relaunched_to FROM sop_runs WHERE id = ?`, top.ID).Scan(&cur); err != nil {
			return "", "", err
		}
		if cur == nil || isRelaunchClaim(*cur) {
			return "", reasonRelaunching, nil
		}
		// 顶层重跑之后才失败的子执行也补记上，点过一次就从「失败」里拿掉
		markChildren(ctx, h.c, top.ID, *cur)
		return *cur, reasonRelaunched, nil
	}
	nr, err := h.relaunch(ctx, top)
	if err != nil {
		// 没建成：清掉占位，下次还能重跑。用后台 ctx，请求断了也要清
		if _, cerr := st.Exec(context.WithoutCancel(ctx), `UPDATE sop_runs SET relaunched_to = NULL WHERE id = ? AND relaunched_to = ?`, top.ID, claim); cerr != nil {
			h.c.Log().Error("sop relaunch claim not released", "run", top.ID, "err", cerr)
		}
		return "", "", err
	}
	bg := context.WithoutCancel(ctx)
	if _, err := st.Exec(bg, `UPDATE sop_runs SET relaunched_to = ? WHERE id = ? AND relaunched_to = ?`, nr.ID, top.ID, claim); err != nil {
		h.c.Log().Error("sop relaunch not recorded", "run", top.ID, "new_run", nr.ID, "err", err)
	}
	// 顶层执行下面失败的子执行也算已重跑，从「失败」里一起拿掉
	markChildren(bg, h.c, top.ID, nr.ID)
	return nr.ID, "", nil
}

// markChildren 把顶层执行下面（各层）失败了、还没记的子执行记成已重跑到 newID。出错只记日志。
func markChildren(ctx context.Context, c plugin.Core, topID, newID string) {
	if _, err := c.Store().Exec(ctx, `WITH RECURSIVE sop_tree(id) AS (
			SELECT id FROM sop_runs WHERE parent_run_id = ?
			UNION
			SELECT c.id FROM sop_runs c JOIN sop_tree t ON c.parent_run_id = t.id
		)
		UPDATE sop_runs SET relaunched_to = ? WHERE status = 'failed' AND relaunched_to IS NULL AND id IN (SELECT id FROM sop_tree)`, topID, newID); err != nil {
		c.Log().Error("sop relaunch not recorded on children", "run", topID, "new_run", newID, "err", err)
	}
}

// backfillRelaunched 是服务启动时补记「已重跑」（迁移 0005 只加列，存量在这里补；每次启动都跑，补过的不再动）：
//   - 以前批量重跑过、还没记的原执行，和上次重跑到一半停了留下占位的，按新起的执行（source manual、source_name「批量重跑」、
//     source_ref 原执行 id）记上最新那条；占位的没建成新执行清回 NULL；
//   - 记了的执行下面失败的子执行记成同一条。
func backfillRelaunched(ctx context.Context, st plugin.Store) error {
	if _, err := st.Exec(ctx, `UPDATE sop_runs SET relaunched_to = (
			SELECT n.id FROM sop_runs n
			WHERE n.source = ? AND n.source_name = ? AND n.source_ref = sop_runs.id
			ORDER BY n.started_at DESC, n.id DESC LIMIT 1
		) WHERE relaunched_to LIKE ?
			OR (relaunched_to IS NULL AND id IN (SELECT source_ref FROM sop_runs WHERE source = ? AND source_name = ?))`,
		SourceManual, relaunchSourceName, relaunchClaimPrefix+"%", SourceManual, relaunchSourceName); err != nil {
		return err
	}
	_, err := st.Exec(ctx, `WITH RECURSIVE sop_tree(id, target) AS (
			SELECT id, relaunched_to FROM sop_runs WHERE relaunched_to IS NOT NULL
			UNION
			SELECT c.id, t.target FROM sop_runs c JOIN sop_tree t ON c.parent_run_id = t.id
		)
		UPDATE sop_runs SET relaunched_to = (SELECT t.target FROM sop_tree t WHERE t.id = sop_runs.id LIMIT 1)
		WHERE relaunched_to IS NULL AND status = 'failed' AND id IN (SELECT id FROM sop_tree)`)
	return err
}

// notRelaunched 挡掉在已重跑过的失败执行上单条重试、跳过（POST /api/sop/runs/{id}/actions），免得原执行和新执行两头都在跑。
func (h *runs) notRelaunched(ctx context.Context, id string) error {
	var cur *string
	err := h.c.Store().QueryRow(ctx, `SELECT relaunched_to FROM sop_runs WHERE id = ?`, id).Scan(&cur)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil // 不存在的交给 act 回 404
	}
	if err != nil {
		return err
	}
	if cur == nil {
		return nil
	}
	if isRelaunchClaim(*cur) {
		return apiErr(errConflict, "这次执行正在按最新流程重跑，不能再重试")
	}
	return apiErr(errConflict, "这次执行已按最新流程重跑为 %s，到新执行里处理", *cur)
}

// retryFailed 在原执行里逐个重试失败的步骤，回重试了的步骤 key；第一步就出错时回错误。
func (h *runs) retryFailed(ctx context.Context, run *Run) ([]string, error) {
	var keys []string
	for i, s := range run.Steps {
		if s.Status != stFailed {
			continue
		}
		step, _ := json.Marshal(i)
		if _, err := h.e.act(ctx, run.ID, Action{Kind: actRetry, Step: step}); err != nil {
			// 别的已经重试上了就算做成；一步都没成回错误
			if len(keys) > 0 {
				break
			}
			return nil, err
		}
		keys = append(keys, s.Key)
	}
	if len(keys) == 0 {
		return nil, apiErr(errConflict, "没有失败的步骤")
	}
	return keys, nil
}

// topRun 沿 parent_run_id 找到顶层执行；父执行已经不在了就停在能找到的最上面一层。
func topRun(ctx context.Context, h *runs, run *Run) (*Run, error) {
	cur := run
	for d := 0; cur.ParentRunID != "" && d <= maxSubflowDepth; d++ {
		p, err := loadRun(ctx, h.c.Store(), cur.ParentRunID)
		if errors.Is(err, errNotFound) {
			break
		}
		if err != nil {
			return nil, err
		}
		cur = p
	}
	return cur, nil
}

// relaunch 用原执行的输入、流程当前定义发起一条新执行。
func (h *runs) relaunch(ctx context.Context, run *Run) (*Run, error) {
	fl := &flows{c: h.c}
	f, err := fl.get(ctx, run.FlowID)
	if errors.Is(err, errNotFound) {
		return nil, apiErr(errConflict, "流程「%s」已删除", run.FlowName)
	}
	if err != nil {
		return nil, err
	}
	input, err := fillInput(f, run.Input)
	if err != nil {
		return nil, err
	}
	objectID, err := checkObject(ctx, h.c, run.ObjectID)
	if err != nil {
		h.c.Log().Warn("sop relaunch object skipped", "run", run.ID, "object", run.ObjectID, "err", err)
		objectID = ""
	}
	return h.e.create(ctx, f, input, run.StepThrough, origin{ObjectID: objectID, Source: SourceManual, SourceRef: run.ID, SourceName: relaunchSourceName})
}
