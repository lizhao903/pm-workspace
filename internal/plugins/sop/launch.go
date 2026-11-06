package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 内核「发起 SOP」钩子的实现（SOP-01d）：定时任务的 sop 动作、Agent 的 run_sop 工具经 Registry.StartSOP 到这里。
// 和 POST /api/sop/flows/{id}/runs 同一套：流程当前定义的快照、补默认值、必填空着回错误，不逐步确认；
// 人工检查点照常停下（发起时就停住的，Status 是 waiting）。
// 请求带 ObjectID（Agent 在挂着任务的会话里发起）时执行关联到那个对象（SOP-06）；对象已经不在了只记日志、照常发起，不关联。

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
	objectID, err := checkObject(ctx, s.c, q.ObjectID)
	if err != nil {
		s.c.Log().Warn("sop run object skipped", "flow", f.ID, "object", q.ObjectID, "err", err)
		objectID = ""
	}
	run, err := s.e.create(ctx, f, input, false, origin{ObjectID: objectID, Source: hookSource(q.Source),
		SourceRef: strings.TrimSpace(q.SourceID), SourceName: strings.TrimSpace(q.SourceName)})
	if err != nil {
		return nil, plainErr(err)
	}
	s.c.Log().Info("sop run started", "run", run.ID, "flow", f.ID, "source", q.Source, "source_id", q.SourceID, "object", objectID)
	return &plugin.SOPStarted{RunID: run.ID, FlowID: f.ID, FlowName: f.Name, Status: run.Status}, nil
}

// hookSource 是经钩子发起的来源：定时任务、Agent、别的插件（内核运行句柄）认得，其余记空串，不让钩子写进 manual 这类界面来源。
func hookSource(s string) string {
	switch s {
	case SourceSchedule, SourceAgent, SourcePlugin:
		return s
	}
	return ""
}

// --- 流程目录（TSK-0480）：Agent 的 list_sops / get_sop / create_sop / update_sop 经内核注册表到这里 ---
// 新建、修改和 POST / PATCH /api/sop/flows 同一套（flows.create / flows.patch）：同样的校验、版本号、随流程管理的定时任务。

var _ plugin.SOPCatalog = (*starter)(nil)

func (s *starter) ListSOPs(ctx context.Context) ([]plugin.SOPFlowBrief, error) {
	rows, err := s.c.Store().Query(ctx, `SELECT `+flowCols+` FROM sop_flows ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []plugin.SOPFlowBrief{}
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, flowBrief(f))
	}
	return out, rows.Err()
}

func (s *starter) GetSOP(ctx context.Context, ref string) (*plugin.SOPFlowDoc, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, errors.New("没有指定流程")
	}
	f, err := findFlow(ctx, s.c, ref)
	if errors.Is(err, errNotFound) {
		return nil, fmt.Errorf("流程 %s 不存在：%w", ref, plugin.ErrSOPNotFound)
	}
	if err != nil {
		return nil, plainErr(err)
	}
	return flowDoc(f), nil
}

func (s *starter) SaveSOP(ctx context.Context, q plugin.SOPSave) (*plugin.SOPFlowDoc, error) {
	h := &flows{c: s.c}
	raw := map[string]json.RawMessage{}
	for k, v := range q.Body {
		raw[k] = v
	}
	// 新建一律生成 id，不让 body 里夹带
	delete(raw, "id")
	if v, ok := raw["steps"]; ok {
		raw["steps"] = fillStepDefaults(v, kindsOf(s.c))
	}
	var f Flow
	var err error
	if id := strings.TrimSpace(q.ID); id == "" {
		f, err = h.create(ctx, raw)
	} else {
		cur, ferr := findFlow(ctx, s.c, id)
		if errors.Is(ferr, errNotFound) {
			return nil, fmt.Errorf("流程 %s 不存在：%w", id, plugin.ErrSOPNotFound)
		}
		if ferr != nil {
			return nil, plainErr(ferr)
		}
		f, err = h.patch(ctx, cur.ID, raw)
	}
	if err != nil {
		var ce *checkError
		if errors.As(err, &ce) {
			return nil, errors.New(issuesText(ce.issues))
		}
		return nil, plainErr(err)
	}
	return flowDoc(f), nil
}

func (s *starter) SOPNodeKinds(_ context.Context) ([]plugin.SOPNodeKind, error) {
	out := make([]plugin.SOPNodeKind, 0, len(NodeTypes))
	add := func(t NodeType) {
		k := plugin.SOPNodeKind{Kind: t.Kind, Label: kindLabels[t.Kind], Group: t.Group, Branching: t.Branching}
		for _, c := range t.DefaultCases {
			k.Cases = append(k.Cases, c.Key)
		}
		for _, r := range t.Required {
			k.Required = append(k.Required, r.Key+"（"+r.Label+"）")
		}
		out = append(out, k)
	}
	for _, t := range NodeTypes {
		add(t)
	}
	for _, n := range s.c.SOP().Nodes() {
		add(pluginNodeType(n))
	}
	return out, nil
}

// fillStepDefaults 补模型常漏的两样，编辑器里这两样是画布自动带的：分支节点没写 cases 时用节点类型的默认出口，
// 挂在分支下（有 branch.of）却没写 after 的依赖那个分支步骤。别的不动，解析不了的原样交给保存校验。
func fillStepDefaults(v json.RawMessage, kinds kindLookup) json.RawMessage {
	var steps []map[string]any
	if json.Unmarshal(v, &steps) != nil {
		return v
	}
	for _, st := range steps {
		if st == nil {
			continue
		}
		kind, _ := st["kind"].(string)
		if t, ok := kinds(kind); ok && t.Branching {
			if cs, _ := st["cases"].([]any); len(cs) == 0 && len(t.DefaultCases) > 0 {
				st["cases"] = t.DefaultCases
			}
		}
		if b, ok := st["branch"].(map[string]any); ok {
			if of, _ := b["of"].(string); of != "" && st["after"] == nil {
				st["after"] = []string{of}
			}
		}
	}
	out, err := json.Marshal(steps)
	if err != nil {
		return v
	}
	return out
}

// issuesText 把保存校验的问题拼成一段，带上第几步，给模型看了能对着改。
func issuesText(issues []Issue) string {
	ts := make([]string, len(issues))
	for i, x := range issues {
		if x.Step != nil {
			ts[i] = fmt.Sprintf("第 %d 步：%s", *x.Step+1, x.Text)
		} else {
			ts[i] = x.Text
		}
	}
	return "流程没存上：" + strings.Join(ts, "；")
}

func flowBrief(f Flow) plugin.SOPFlowBrief {
	var steps []json.RawMessage
	_ = json.Unmarshal(f.Steps, &steps)
	return plugin.SOPFlowBrief{ID: f.ID, Name: f.Name, Desc: f.Desc, Trigger: f.Trigger, Steps: len(steps), Version: f.Version}
}

func flowDoc(f Flow) *plugin.SOPFlowDoc {
	return &plugin.SOPFlowDoc{SOPFlowBrief: flowBrief(f), Fields: f.Fields, StepDefs: f.Steps}
}
