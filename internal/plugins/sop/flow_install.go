package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 别的插件随安装写进来的内置流程（VID-03d）：引擎实现 plugin.SOPFlowInstaller，内核的 Core.SOP().InstallFlow、RemoveFlow 转到这里。
// id 前缀（sop_<插件 id>_）内核已经查过；定义按 POST /api/sop/flows 的口径校验，节点认在跑的和清单里声明过的插件节点。
// 已有同 id 的流程不动（用户可能改过）；撤下只删还是第 1 版、没有进行中的执行、没被定时任务引用的。

var _ plugin.SOPFlowInstaller = (*engine)(nil)

func (e *engine) InstallFlow(ctx context.Context, caller string, t plugin.SOPFlowTemplate) (bool, error) {
	h := &flows{c: e.c}
	if _, err := h.get(ctx, t.ID); err == nil {
		return false, nil
	} else if !errors.Is(err, errNotFound) {
		return false, err
	}
	raw := map[string]json.RawMessage{}
	for k, v := range map[string]any{"name": t.Name, "desc": t.Desc, "trigger": t.Trigger} {
		b, _ := json.Marshal(v)
		raw[k] = b
	}
	raw["fields"], raw["steps"] = orArray(t.Fields), orArray(t.Steps)
	if len(t.Layout) > 0 {
		raw["layout"] = t.Layout
	}
	f := Flow{ID: t.ID, Fields: json.RawMessage(`[]`), Steps: json.RawMessage(`[]`), Version: 1}
	if err := apply(&f, raw, kindsOf(e.c)); err != nil {
		return false, fmt.Errorf("插件 %s 的内置流程 %s 不合法：%w", caller, t.ID, err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.c.Store().Exec(ctx, `INSERT INTO sop_flows (`+flowCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
		ON CONFLICT (id) DO NOTHING`,
		f.ID, f.Name, f.Desc, f.Trigger, string(f.Fields), string(f.Steps), layoutCol(f.Layout), now, now); err != nil {
		return false, err
	}
	return true, nil
}

func (e *engine) RemoveFlow(ctx context.Context, _ string, id string) (bool, string, error) {
	h := &flows{c: e.c}
	f, err := h.get(ctx, id)
	if errors.Is(err, errNotFound) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	if f.Version != 1 {
		return false, fmt.Sprintf("流程改过（第 %d 版），留给用户", f.Version), nil
	}
	n, err := countActive(ctx, e.c.Store(), id)
	if err != nil {
		return false, "", err
	}
	if n > 0 {
		return false, fmt.Sprintf("有 %d 个进行中的执行", n), nil
	}
	refs, err := userSchedules(ctx, e.c, id)
	if err != nil {
		return false, "", err
	}
	if len(refs) > 0 {
		return false, fmt.Sprintf("有 %d 个定时任务会发起它", len(refs)), nil
	}
	res, err := e.c.Store().Exec(ctx, `DELETE FROM sop_flows WHERE id = ? AND version = 1`, id)
	if err != nil {
		return false, "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, "流程刚被改过，留给用户", nil
	}
	if _, err := e.c.SOP().DeleteFlowSchedule(ctx, id); err != nil && !errors.Is(err, plugin.ErrNoSOPSchedules) {
		return true, "", err
	}
	return true, "", nil
}

func orArray(v json.RawMessage) json.RawMessage {
	if len(v) == 0 {
		return json.RawMessage(`[]`)
	}
	return v
}
