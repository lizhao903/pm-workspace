package sop

import (
	"context"
	"errors"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内核「发起 SOP」钩子的实现（SOP-01d）：定时任务的 sop 动作、Agent 的 run_sop 工具经 Registry.StartSOP 到这里。
// 和 POST /api/sop/flows/{id}/runs 同一套：流程当前定义的快照、补默认值、必填空着回错误，不逐步确认；
// 人工检查点照常停下（发起时就停住的，Status 是 waiting）。

type starter struct {
	c plugin.Core
	e *engine
}

func (s *starter) StartSOP(ctx context.Context, q plugin.SOPStartRequest) (*plugin.SOPStarted, error) {
	ref := strings.TrimSpace(q.FlowID)
	if ref == "" {
		return nil, errors.New("没有指定流程")
	}
	f, err := findFlow(ctx, s.c, ref)
	if err != nil {
		return nil, plainErr(err)
	}
	input := Json{}
	for k, v := range q.Input {
		input[k] = v
	}
	if input, err = fillInput(f, input); err != nil {
		return nil, plainErr(err)
	}
	run, err := s.e.create(ctx, f, input, false, "", "")
	if err != nil {
		return nil, plainErr(err)
	}
	s.c.Log().Info("sop run started", "run", run.ID, "flow", f.ID, "source", q.Source, "source_id", q.SourceID)
	return &plugin.SOPStarted{RunID: run.ID, FlowID: f.ID, FlowName: f.Name, Status: run.Status}, nil
}
