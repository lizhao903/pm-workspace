// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
	// dbg 是调试、模拟 IM 触发（TSK-0491），Agent 的 test_sop、explain_im_trigger 经它
	dbg *debugger
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
	filled, err := fillInput(f, input)
	if err != nil {
		// 定时到点补不齐必填输入：记一行没发起的原因（TSK-0491，skips.go），流程详情看得到
		if q.Source == SourceSchedule {
			_, msg, _ := cutKind(err)
			recordSkip(ctx, s.c, f.ID, SourceSchedule, strings.TrimSpace(q.SourceID), skipMissing, "输入"+msg+"，定时发起不带字段，又没有默认值",
				map[string]any{"missing": missingFields(f, input), "schedule": strings.TrimSpace(q.SourceName)})
		}
		return nil, plainErr(err)
	}
	input = filled
	objectID, err := checkObject(ctx, s.c, q.ObjectID)
	if err != nil {
		s.c.Log().Warn("sop run object skipped", "flow", f.ID, "object", q.ObjectID, "err", err)
		objectID = ""
	}
	run, err := s.e.create(ctx, f, input, false, origin{ObjectID: objectID, Source: hookSource(q.Source),
		SourceRef: strings.TrimSpace(q.SourceID), SourceName: strings.TrimSpace(q.SourceName)})
	if err != nil {
		if q.Source == SourceSchedule {
			_, msg, _ := cutKind(err)
			recordSkip(ctx, s.c, f.ID, SourceSchedule, strings.TrimSpace(q.SourceID), skipStartFailed, "发起出错："+msg,
				map[string]any{"schedule": strings.TrimSpace(q.SourceName)})
		}
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
	rows, err := s.c.Store().Query(ctx, `SELECT `+flowSel+` FROM sop_flows ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var list []Flow
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	_ = rows.Close()
	names, err := folderNames(ctx, s.c)
	if err != nil {
		return nil, err
	}
	out := []plugin.SOPFlowBrief{}
	for _, f := range list {
		out = append(out, s.brief(ctx, f, names))
	}
	return out, nil
}

// ListSOPFolders 列文件夹和未分类的流程数（TSK-0482），同 GET /api/sop/folders。
func (s *starter) ListSOPFolders(ctx context.Context) (plugin.SOPFolders, error) {
	list, none, err := listFolders(ctx, s.c)
	if err != nil {
		return plugin.SOPFolders{}, err
	}
	out := plugin.SOPFolders{Folders: []plugin.SOPFolderBrief{}, Uncategorized: none}
	for _, f := range list {
		out.Folders = append(out.Folders, plugin.SOPFolderBrief{ID: f.ID, Name: f.Name, Count: f.Count})
	}
	return out, nil
}

// folderNames 是文件夹 id → 名字。
func folderNames(ctx context.Context, c plugin.Core) (map[string]string, error) {
	list, _, err := listFolders(ctx, c)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(list))
	for _, f := range list {
		out[f.ID] = f.Name
	}
	return out, nil
}

// resolveFolder 认 Agent 给的 folder：空串、「未分类」是未分类；文件夹 id 或名字（不分大小写）对上已有的就用它；
// 都对不上时 create 为真，name 是要新建的文件夹名（已校验），由调用方在流程校验通过后再建。
func resolveFolder(ctx context.Context, c plugin.Core, ref string) (id *string, name string, create bool, err error) {
	ref = strings.TrimSpace(ref)
	if ref == "" || ref == uncategorized {
		return nil, "", false, nil
	}
	if f, err := getFolder(ctx, c, ref); err == nil {
		return &f.ID, f.Name, false, nil
	} else if !errors.Is(err, errNotFound) {
		return nil, "", false, err
	}
	if f, err := folderByName(ctx, c, ref); err == nil {
		return &f.ID, f.Name, false, nil
	} else if !errors.Is(err, errNotFound) {
		return nil, "", false, err
	}
	name, err = checkFolderName(ref)
	if err != nil {
		return nil, "", false, err
	}
	return nil, name, true, nil
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
	doc := s.doc(ctx, f)
	// 打开这条流程会看到的问题（含旧写法规则的提示，TSK-0490）
	doc.Warnings = issueLines(checkFlow(&f, kindsOf(s.c)))
	return doc, nil
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
	// folder 是文件夹名字或 id（TSK-0482）：对不上已有的就新建；新建的文件夹在流程存不上时删掉，不留空文件夹
	var created *Folder
	if v, ok := raw["folder"]; ok {
		delete(raw, "folder")
		var ref string
		if err := json.Unmarshal(v, &ref); err != nil && string(v) != "null" {
			return nil, errors.New("folder 必须是文件夹名字")
		}
		fid, name, create, err := resolveFolder(ctx, s.c, ref)
		if err != nil {
			return nil, plainErr(err)
		}
		if create {
			fd, err := createFolder(ctx, s.c, name)
			if err != nil {
				return nil, plainErr(err)
			}
			created, fid = &fd, &fd.ID
		}
		b, _ := json.Marshal(fid)
		raw["folder_id"] = b
	}
	var f Flow
	var err error
	if id := strings.TrimSpace(q.ID); id == "" {
		f, err = h.create(ctx, raw)
	} else {
		cur, ferr := findFlow(ctx, s.c, id)
		if errors.Is(ferr, errNotFound) {
			ferr = fmt.Errorf("流程 %s 不存在：%w", id, plugin.ErrSOPNotFound)
		} else if ferr != nil {
			ferr = plainErr(ferr)
		}
		if ferr != nil {
			dropEmptyFolder(ctx, s.c, created)
			return nil, ferr
		}
		f, err = h.patch(ctx, cur.ID, raw)
	}
	if err != nil {
		dropEmptyFolder(ctx, s.c, created)
		var ce *checkError
		if errors.As(err, &ce) {
			return nil, errors.New(issuesText(errorsOf(ce.issues)) + warnTail(warningsOf(ce.issues)))
		}
		return nil, plainErr(err)
	}
	doc := s.doc(ctx, f)
	doc.FolderCreated = created != nil
	doc.Warnings = issueLines(f.Issues)
	return doc, nil
}

// issueLines 是给模型看的问题，一条一行，带「第 n 步：」；警告前面标「（警告）」。
func issueLines(issues []Issue) []string {
	out := make([]string, 0, len(issues))
	for _, x := range issues {
		t := issueText(x)
		if x.Level == levelWarning {
			t = "（警告）" + t
		}
		out = append(out, t)
	}
	return out
}

// dropEmptyFolder 删掉 SaveSOP 为这次保存新建、流程却没存上的文件夹（还空着才删）。
func dropEmptyFolder(ctx context.Context, c plugin.Core, f *Folder) {
	if f == nil {
		return
	}
	if _, err := c.Store().Exec(ctx, `DELETE FROM sop_folders WHERE id = ? AND NOT EXISTS (SELECT 1 FROM sop_flows WHERE folder_id = ?)`, f.ID, f.ID); err != nil {
		c.Log().Warn("sop folder cleanup failed", "folder", f.ID, "err", err)
	}
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
	// 旧写法的一行规则换成结构化条件（TSK-0490）
	v = normalizeSteps(v)
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

// warnTail 是没存上时一并告诉模型的警告（改的时候顺手改掉）。
func warnTail(w []Issue) string {
	if len(w) == 0 {
		return ""
	}
	ts := make([]string, len(w))
	for i, x := range w {
		ts[i] = issueText(x)
	}
	return "。另有几处警告，改的时候一起改掉：" + strings.Join(ts, "；")
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

// brief 是目录里的一项；names 是文件夹 id → 名字，nil 时现查这一条的文件夹。
func (s *starter) brief(ctx context.Context, f Flow, names map[string]string) plugin.SOPFlowBrief {
	var steps []json.RawMessage
	_ = json.Unmarshal(f.Steps, &steps)
	b := plugin.SOPFlowBrief{ID: f.ID, Name: f.Name, Desc: f.Desc, Trigger: f.Trigger, Steps: len(steps), Version: f.Version,
		IMTrigger: imDescribe(ctx, s.c, f)}
	if f.FolderID != nil {
		if names != nil {
			b.Folder = names[*f.FolderID]
		} else if fd, err := getFolder(ctx, s.c, *f.FolderID); err == nil {
			b.Folder = fd.Name
		}
	}
	return b
}

func (s *starter) doc(ctx context.Context, f Flow) *plugin.SOPFlowDoc {
	return &plugin.SOPFlowDoc{SOPFlowBrief: s.brief(ctx, f, nil), Fields: f.Fields, StepDefs: f.Steps}
}

// --- 调试（TSK-0491）：Agent 的 test_sop、explain_im_trigger 经内核注册表到这里，同 POST /api/sop/debug、/api/sop/im-explain ---

var _ plugin.SOPCatalogDebugger = (*starter)(nil)

func (s *starter) TestSOP(ctx context.Context, q plugin.SOPTest) (string, error) {
	f, err := findFlow(ctx, s.c, strings.TrimSpace(q.FlowID))
	if err != nil {
		if errors.Is(err, errNotFound) {
			return "", fmt.Errorf("%w：%s", plugin.ErrSOPNotFound, strings.TrimSpace(q.FlowID))
		}
		return "", plainErr(err)
	}
	res, err := s.dbg.run(ctx, f, checkFlow(&f, kindsOf(s.c)), DebugReq{Input: q.Input, MessageID: strings.TrimSpace(q.MessageID), SkipModels: q.SkipModels})
	if err != nil {
		return "", plainErr(err)
	}
	return debugReport(res), nil
}

func (s *starter) ExplainIMTrigger(ctx context.Context, messageID string) (string, error) {
	id := strings.TrimSpace(messageID)
	if id == "" {
		return "", errors.New("message_id 是必填的")
	}
	res, err := s.dbg.explain(ctx, id, nil, nil)
	if err != nil {
		return "", plainErr(err)
	}
	return explainReport(res), nil
}
