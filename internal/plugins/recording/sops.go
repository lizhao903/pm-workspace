// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// SOP 节点和内置流程（M4a，设计 §13.5，plugin-api.md 2.7）。
// 节点内部复用 minutes.go 的同一份纪要/候选实现；内置流程「会议纪要整理」由后台任务每 1 分钟试写一次，
// 写过的记在 recording_flows，用户删了不补；卸载时撤下没改过的（同视频插件的 sopnodes.go）。

const (
	// NodeMinutes 是生成纪要节点。
	NodeMinutes = "recording_minutes"
	// NodeExtract 是提取候选节点。
	NodeExtract = "recording_extract"
	// MinutesFlowID 是内置流程「会议纪要整理」的 id（sop_<插件 id>_ 开头）。
	MinutesFlowID = "sop_recording_minutes"
)

// templateEvery 是多久试一次把内置流程写进 SOP；测试里可以调小。
var templateEvery = time.Minute

// registerSOP 登记两个 SOP 节点和写内置流程的后台任务。
func (h *handlers) registerSOP(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeMinutes, Group: "录音",
		Required: []plugin.SOPNodeField{{Key: "recording", Label: "录音"}},
		Run:      h.minutesNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeExtract, Group: "录音",
		Required: []plugin.SOPNodeField{{Key: "recording", Label: "录音"}},
		Run:      h.extractNode})
	r.Job(plugin.Job{Name: "recording_sop_templates", Every: templateEvery, Run: installTemplates})
}

// sopPlainErr 去掉错误分类的前缀，写进步骤的失败原因给人看。
func sopPlainErr(err error) error {
	if errors.Is(err, errValidation) || errors.Is(err, errConflict) || errors.Is(err, errNotFound) {
		_, msg, _ := strings.Cut(err.Error(), ": ")
		return errors.New(msg)
	}
	return err
}

// nodeRecording 按配置找录音：先当 id，再当标题（支持 {{字段}}）。
func nodeRecording(ctx context.Context, c plugin.Core, in plugin.SOPNodeInput) (recordingRow, error) {
	raw := strings.TrimSpace(sopRender(in.Config["recording"], in.Input))
	if raw == "" {
		return recordingRow{}, errors.New("没有指定录音")
	}
	rec, err := loadRecording(ctx, c.Store(), raw)
	if err == nil {
		return rec, nil
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return recordingRow{}, err
	}
	rec, err = findRecordingByTitle(ctx, c.Store(), raw)
	if err != nil {
		if errors.Is(err, plugin.ErrNoRows) {
			return recordingRow{}, fmt.Errorf("录音 %s 不存在", raw)
		}
		return recordingRow{}, err
	}
	return rec, nil
}

// minutesNode：生成纪要 + 提取候选，输出 with(input, "minutes", {...})。
func (h *handlers) minutesNode(ctx context.Context, c plugin.Core, in plugin.SOPNodeInput) (map[string]any, error) {
	rec, err := nodeRecording(ctx, c, in)
	if err != nil {
		return nil, err
	}
	settings, err := loadSettings(ctx, c)
	if err != nil {
		return nil, err
	}
	// provider / model 配置可选，填了覆盖设置里的
	if v := strings.TrimSpace(sopRender(in.Config["provider"], in.Input)); v != "" {
		settings.MinutesProvider = v
	}
	if v := strings.TrimSpace(sopRender(in.Config["model"], in.Input)); v != "" {
		settings.MinutesModel = v
	}
	mins, _, err := h.p.summarizeRecording(ctx, c, rec, settings, nil)
	if err != nil {
		return nil, sopPlainErr(err)
	}
	files := make([]string, 0, 5)
	for _, f := range listRecordingFiles(c, rec.ID) {
		files = append(files, f.Name)
	}
	return sopWith(in.Input, "minutes", map[string]any{
		"recording_id":      rec.ID,
		"title":             rec.Title,
		"summary":           mins.SummaryMD,
		"conclusions_count": len(mins.Conclusions),
		"actions_count":     len(mins.Actions),
		"files":             files,
	}), nil
}

// extractNode：从已有纪要里提取候选，输出 with(input, "recording_todos", {...})。
func (h *handlers) extractNode(ctx context.Context, c plugin.Core, in plugin.SOPNodeInput) (map[string]any, error) {
	rec, err := nodeRecording(ctx, c, in)
	if err != nil {
		return nil, err
	}
	settings, err := loadSettings(ctx, c)
	if err != nil {
		return nil, err
	}
	todos, err := h.p.extractRecordingCandidates(ctx, c, rec, settings)
	if err != nil {
		return nil, sopPlainErr(err)
	}
	threshold := effectiveMinutesThreshold(settings)
	pending, high, projectCandidates, taskCandidates := 0, 0, 0, 0
	for _, t := range todos {
		if t.Status == "pending" {
			pending++
			if t.Confidence >= threshold {
				high++
			}
		}
		switch t.Kind {
		case "project":
			projectCandidates++
		case "task":
			taskCandidates++
		}
	}
	return sopWith(in.Input, "recording_todos", map[string]any{
		"recording_id":          rec.ID,
		"pending_count":         pending,
		"high_confidence_count": high,
		"project_candidates":    projectCandidates,
		"task_count":            taskCandidates,
	}), nil
}

// sopWith 同原型 {...input, key: v}。
func sopWith(input map[string]any, key string, v any) map[string]any {
	out := make(map[string]any, len(input)+1)
	for k, x := range input {
		out[k] = x
	}
	out[key] = v
	return out
}

/* ---------- {{字段}} 模板 ---------- */

var (
	sopTplRe   = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)
	sopIndexRe = regexp.MustCompile(`\[(\d+)\]`)
)

// sopRender 同 SOP 的模板写法：{{a.b[0]}} 换成输入里的值，没有是空串，对象转 JSON。
func sopRender(tpl string, input map[string]any) string {
	return sopTplRe.ReplaceAllStringFunc(tpl, func(m string) string {
		return sopText(sopGetPath(input, sopTplRe.FindStringSubmatch(m)[1]))
	})
}

func sopGetPath(obj any, path string) any {
	p := sopIndexRe.ReplaceAllString(strings.TrimSpace(path), ".$1")
	cur := obj
	for _, k := range strings.Split(p, ".") {
		if k == "" {
			continue
		}
		switch v := cur.(type) {
		case map[string]any:
			cur = v[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(v) {
				return nil
			}
			cur = v[i]
		default:
			return nil
		}
	}
	return cur
}

func sopText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	}
	b, _ := json.Marshal(v)
	return string(b)
}

/* ---------- 内置流程 ---------- */

// minutesFlow 是「会议纪要整理」：step1 生成纪要 → step2 提取候选（after: [minutes]）。
func minutesFlow() plugin.SOPFlowTemplate {
	type step struct {
		Key    string            `json:"key"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Desc   string            `json:"desc"`
		Config map[string]string `json:"config"`
		After  []string          `json:"after,omitempty"`
	}
	steps := []step{
		{Key: "minutes", Name: "生成纪要", Kind: NodeMinutes,
			Desc:   "用本机 Agent 把转写生成结构化纪要，写 minutes.md / minutes.json / diagrams/*.mmd",
			Config: map[string]string{"recording": "{{recording_id}}"}},
		{Key: "extract", Name: "提取候选", Kind: NodeExtract,
			Desc:   "从纪要里提取候选项目/任务/目标，高置信度的推给用户确认",
			Config: map[string]string{"recording": "{{recording_id}}"}, After: []string{"minutes"}},
	}
	fields := []map[string]any{
		{"key": "recording_id", "label": "录音", "type": "text", "required": true, "placeholder": "录音 id，在录音详情的地址栏里"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID:      MinutesFlowID,
		Name:    "会议纪要整理",
		Desc:    "把一条录音的转写生成结构化纪要（摘要、结论、待办、图表），再提取候选项目/任务/目标等用户确认。要改先复制一份",
		Trigger: "manual",
		Fields:  fb,
		Steps:   sb,
	}
}

// templates 是本插件写进 SOP 的内置流程。
func templates() []plugin.SOPFlowTemplate { return []plugin.SOPFlowTemplate{minutesFlow()} }

// installTemplates 把还没写过的内置流程写进 SOP；SOP 插件没在跑就下次再试，已有同 id 的也算写过。
func installTemplates(ctx context.Context, c plugin.Core) error {
	for _, t := range templates() {
		var n int
		if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM recording_flows WHERE flow_id = ?`, t.ID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		created, err := c.SOP().InstallFlow(ctx, t)
		if errors.Is(err, plugin.ErrNoSOPFlowInstaller) {
			return nil
		}
		if err != nil {
			c.Log().Warn("recording sop template install failed", "flow", t.ID, "err", err)
			continue
		}
		if _, err := c.Store().Exec(ctx, `INSERT INTO recording_flows (flow_id, installed_at) VALUES (?, ?) ON CONFLICT (flow_id) DO NOTHING`,
			t.ID, nowRFC()); err != nil {
			return err
		}
		c.Log().Info("recording sop template installed", "flow", t.ID, "created", created)
	}
	return nil
}

// OnUninstall 撤下写进 SOP、用户没改过的内置流程；改过的、SOP 插件没在跑撤不了的留着，不挡卸载。
func (p *Plugin) OnUninstall(ctx context.Context, c plugin.Core, deleteData bool) error {
	for _, t := range templates() {
		var n int
		if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM recording_flows WHERE flow_id = ?`, t.ID).Scan(&n); err != nil || n == 0 {
			continue
		}
		removed, why, err := c.SOP().RemoveFlow(ctx, t.ID)
		if err != nil {
			c.Log().Warn("recording sop template remove failed", "flow", t.ID, "err", err)
			continue
		}
		if !removed && why != "" {
			c.Log().Info("recording sop template kept", "flow", t.ID, "reason", why)
			continue
		}
		if !deleteData {
			if _, err := c.Store().Exec(ctx, `DELETE FROM recording_flows WHERE flow_id = ?`, t.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
