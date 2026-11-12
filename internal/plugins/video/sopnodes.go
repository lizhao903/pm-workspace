// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

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

// SOP 节点和内置流程（VID-03d），经内核的 SOP 节点扩展点登记（plugin-api.md 2.7）。
// 等检查点 video_wait_checkpoint：检查点已经通过或跳过就直接往下走；没有就把视频推到这个检查点上（中间只隔着
// 不带检查点的阶段时），落一行 video_sop_waits、步骤挂起，人在视频页通过或跳过后由后台任务唤醒。退回不算，接着等。
// 跑阶段 video_run_stage：用视频这个阶段配的执行器跑一次（同 POST .../runners/{stage}/run，检查口径一样），
// 挂起等跑完：跑成了唤醒，没跑成让步骤失败。产出物照常进待验收，检查点仍由人确认。
// 发布到平台 video_publish（VID-06c）在 schedule.go 登记。
// 内置流程「视频周更」由后台任务写进 SOP（Core.SOP().InstallFlow），写过一次记在 video_sop_templates，用户删了不补回来；
// 卸载时撤下没改过的，用户复制的副本是另一条流程，不动。

const (
	NodeWaitCheckpoint = "video_wait_checkpoint"
	NodeRunStage       = "video_run_stage"

	// WeeklyFlowID 是内置流程「视频周更」的 id，同原型 sopflow.ts 的 sop_video_weekly。
	WeeklyFlowID = "sop_video_weekly"
)

// sopWaitEvery 是多久看一次挂起中的等待，templateEvery 是多久试一次写内置流程；测试里调小。
var (
	sopWaitEvery  = 3 * time.Second
	templateEvery = time.Minute
)

func (h *handler) registerSOP(r plugin.Registrar) {
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeWaitCheckpoint, Group: "视频",
		Required: []plugin.SOPNodeField{{Key: "video", Label: "视频"}, {Key: "checkpoint", Label: "检查点"}},
		Run:      h.waitCheckpointNode})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodeRunStage, Group: "视频",
		Required: []plugin.SOPNodeField{{Key: "video", Label: "视频"}, {Key: "stage", Label: "阶段"}},
		Run:      h.runStageNode})
	r.Job(plugin.Job{Name: "sop_waits", Every: sopWaitEvery, Run: h.sopWaitJob})
	r.Job(plugin.Job{Name: "sop_templates", Every: templateEvery, Run: installTemplates})
}

// plainErr 去掉错误分类的前缀，写进步骤的失败原因给人看。
func plainErr(err error) error {
	if errors.Is(err, errValidation) || errors.Is(err, errConflict) || errors.Is(err, errNotFound) {
		_, msg, _ := strings.Cut(err.Error(), ": ")
		return errors.New(msg)
	}
	return err
}

// nodeVideo 按配置找视频（视频 id，支持 {{字段}}）。
func (h *handler) nodeVideo(ctx context.Context, n plugin.SOPNodeInput) (Video, error) {
	id := strings.TrimSpace(render(n.Config["video"], n.Input))
	if id == "" {
		return Video{}, errors.New("没有指定视频")
	}
	v, err := h.getVideo(ctx, id)
	if errors.Is(err, errNotFound) {
		return v, fmt.Errorf("视频 %s 不存在", id)
	}
	return v, plainErr(err)
}

func videoLabel(v Video) string {
	if v.Title != "" {
		return "《" + v.Title + "》"
	}
	return "视频 " + v.ID
}

/* ---------- 等检查点 ---------- */

func (h *handler) waitCheckpointNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	stage := strings.TrimSpace(render(n.Config["checkpoint"], n.Input))
	i := stageIndex(stage)
	if i < 0 || !Stages[i].Checkpoint {
		return nil, fmt.Errorf("检查点只能是 %s", strings.Join(CheckpointStages, "、"))
	}
	v, err := h.nodeVideo(ctx, n)
	if err != nil {
		return nil, err
	}
	if cp := v.checkpoint(stage); cp.State == "passed" || cp.State == "skipped" {
		return with(n.Input, "checkpoint", checkpointOut(v, cp)), nil
	}
	// 视频还在前面、中间没有别的检查点时推到这个检查点上，等人检查
	if j := stageIndex(v.Stage); j < i && !hasCheckpoint(j, i) {
		if err := h.moveStage(ctx, v.ID, v.Stage, stage); err != nil {
			return nil, plainErr(err)
		}
		if err := h.touchVideo(ctx, v.ID); err != nil {
			return nil, err
		}
	}
	if err := h.addWait(ctx, n, "checkpoint", v.ID, stage, nil); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("等%s的「%s」通过：%w", videoLabel(v), Stages[i].Label, plugin.ErrWaiting)
}

// hasCheckpoint 看 Stages[from:to] 里有没有带检查点的阶段。
func hasCheckpoint(from, to int) bool {
	for _, s := range Stages[from:to] {
		if s.Checkpoint {
			return true
		}
	}
	return false
}

func checkpointOut(v Video, cp Checkpoint) map[string]any {
	return map[string]any{"video_id": v.ID, "title": v.Title, "stage": cp.Stage, "label": stageLabel(cp.Stage),
		"state": cp.State, "note": cp.Note, "at": cp.At}
}

/* ---------- 跑阶段 ---------- */

func (h *handler) runStageNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	stage := strings.TrimSpace(render(n.Config["stage"], n.Input))
	v, err := h.nodeVideo(ctx, n)
	if err != nil {
		return nil, err
	}
	rowID, startErr, err := h.startStage(ctx, v.ID, stage)
	if err != nil {
		return nil, plainErr(err)
	}
	if startErr != nil {
		return nil, startErr
	}
	if err := h.addWait(ctx, n, "stage", v.ID, stage, &rowID); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("等%s的「%s」跑完：%w", videoLabel(v), stageLabel(stage), plugin.ErrWaiting)
}

func (h *handler) addWait(ctx context.Context, n plugin.SOPNodeInput, kind, videoID, stage string, runRow *int64) error {
	in := n.Input
	if in == nil {
		in = map[string]any{}
	}
	b, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("输入不能转成 JSON：%w", err)
	}
	_, err = h.c.Store().Exec(ctx, `INSERT INTO video_sop_waits (run_id, step, attempt, kind, video_id, stage, video_run_id, input, since)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (run_id, step) DO UPDATE SET attempt = excluded.attempt, kind = excluded.kind, video_id = excluded.video_id,
		stage = excluded.stage, video_run_id = excluded.video_run_id, input = excluded.input, since = excluded.since`,
		n.RunID, n.Step, n.Attempt, kind, videoID, stage, runRow, string(b), nowStr())
	return err
}

type sopWait struct {
	runID, step    string
	attempt        int
	kind           string
	videoID, stage string
	videoRunID     *int64
	input          string
}

// sopWaitJob 看每个挂起中的等待：有结果就唤醒或让步骤失败，然后删掉这一行。
// 唤醒出错（执行还没调度上、SOP 插件没在跑）留着下次再试，同 IM 的等回复。
func (h *handler) sopWaitJob(ctx context.Context, c plugin.Core) error {
	rows, err := c.Store().Query(ctx, `SELECT run_id, step, attempt, kind, video_id, stage, video_run_id, input FROM video_sop_waits ORDER BY since`)
	if err != nil {
		return err
	}
	var ws []sopWait
	for rows.Next() {
		var w sopWait
		if err := rows.Scan(&w.runID, &w.step, &w.attempt, &w.kind, &w.videoID, &w.stage, &w.videoRunID, &w.input); err != nil {
			_ = rows.Close()
			return err
		}
		ws = append(ws, w)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil || len(ws) == 0 {
		return err
	}
	h.reconcileRuns(ctx)
	for _, w := range ws {
		if err := ctx.Err(); err != nil {
			return err
		}
		out, reason, err := h.waitResult(ctx, w)
		if err != nil {
			return err
		}
		switch {
		case out != nil:
			if err := c.SOP().Resume(ctx, w.runID, w.step, out); err != nil {
				c.Log().Debug("video sop wait resume failed, retry later", "run", w.runID, "step", w.step, "err", err)
				continue
			}
		case reason != "":
			if err := c.SOP().Fail(ctx, w.runID, w.step, reason); err != nil {
				c.Log().Debug("video sop wait fail failed, retry later", "run", w.runID, "step", w.step, "err", err)
				continue
			}
		default:
			continue
		}
		if _, err := c.Store().Exec(ctx, `DELETE FROM video_sop_waits WHERE run_id = ? AND step = ? AND attempt = ?`,
			w.runID, w.step, w.attempt); err != nil {
			return err
		}
	}
	return nil
}

// waitResult 是一条等待的结果：out 非 nil 是唤醒的输出，reason 非空是失败原因，都没有就接着等。
func (h *handler) waitResult(ctx context.Context, w sopWait) (map[string]any, string, error) {
	var input map[string]any
	_ = json.Unmarshal([]byte(w.input), &input)
	v, err := h.getVideo(ctx, w.videoID)
	if errors.Is(err, errNotFound) {
		return nil, "视频 " + w.videoID + " 已经删了", nil
	}
	if err != nil {
		return nil, "", err
	}
	if w.kind == "checkpoint" {
		if cp := v.checkpoint(w.stage); cp.State == "passed" || cp.State == "skipped" {
			return with(input, "checkpoint", checkpointOut(v, cp)), "", nil
		}
		return nil, "", nil
	}
	if w.videoRunID == nil {
		return nil, "没有对应的执行记录", nil
	}
	rr, err := scanRun(h.c.Store().QueryRow(ctx, `SELECT `+runCols+` FROM video_runs WHERE id = ?`, *w.videoRunID))
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, "执行记录不见了", nil
	}
	if err != nil {
		return nil, "", err
	}
	switch rr.status {
	case "done":
		lr := rr.lastRun()
		return with(input, "stage_run", map[string]any{"video_id": v.ID, "title": v.Title, "stage": rr.stage, "label": stageLabel(rr.stage),
			"status": lr.Status, "run_id": lr.ID, "ref": lr.Ref, "artifact_ids": orEmptyIDs(lr.ArtifactIDs), "ended_at": lr.EndedAt}), "", nil
	case "failed":
		return nil, "「" + stageLabel(rr.stage) + "」没跑成：" + rr.errMsg, nil
	}
	return nil, "", nil
}

func orEmptyIDs(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}

// with 同原型 {...input, key: v}。
func with(input map[string]any, key string, v any) map[string]any {
	out := make(map[string]any, len(input)+1)
	for k, x := range input {
		out[k] = x
	}
	out[key] = v
	return out
}

/* ---------- {{字段}} ---------- */

var (
	tplRe   = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)
	indexRe = regexp.MustCompile(`\[(\d+)\]`)
)

// render 同 SOP 的模板写法：{{a.b[0]}} 换成输入里的值，没有是空串，对象转 JSON。
func render(tpl string, input map[string]any) string {
	return tplRe.ReplaceAllStringFunc(tpl, func(m string) string {
		return txt(getPath(input, tplRe.FindStringSubmatch(m)[1]))
	})
}

func getPath(obj any, path string) any {
	p := indexRe.ReplaceAllString(strings.TrimSpace(path), ".$1")
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

func txt(v any) string {
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

// weeklyFlow 是「视频周更」：同原型 sopflow.ts 的 sop_video_weekly，八步换成视频节点，
// 做的事交给视频各阶段配的执行器，四个检查点停下等人在视频页确认。
func weeklyFlow() plugin.SOPFlowTemplate {
	type step struct {
		Key    string            `json:"key"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Desc   string            `json:"desc"`
		Config map[string]string `json:"config"`
	}
	run := func(key, name, stage, desc string) step {
		return step{Key: key, Name: name, Kind: NodeRunStage, Desc: desc, Config: map[string]string{"video": "{{video_id}}", "stage": stage}}
	}
	wait := func(key, name, stage, desc string) step {
		return step{Key: key, Name: name, Kind: NodeWaitCheckpoint, Desc: desc, Config: map[string]string{"video": "{{video_id}}", "checkpoint": stage}}
	}
	steps := []step{
		run("script", "文稿处理", "script", "用「内容编写」配的执行器把原文改成口播稿和大纲；双方向的横版、竖版各写一套"),
		wait("plan", "规划检查", "plan", "对齐稿子、大纲、主题、素材和画面比例；在视频页通过后比例锁定，接着往下走"),
		run("ch1", "开发第 1 章", "web", "用「网页开发」配的执行器搭演示工程，第 1 章做完整，作为后面各章的样板"),
		wait("ch1_review", "检查第 1 章", "ch1", "第 1 章是样板：版式、节奏、动效都在这里定，不行就在视频页退回重做"),
		run("rest", "并行开发其余章节", "chapters", "用「其余章节」配的执行器照第 1 章的样板开发第 2 到 N 章"),
		wait("audio", "音频检查", "audio", "决定要不要合成口播音频；要的话按章节听一遍，不要就在视频页跳过"),
		run("render", "渲染", "record", "用「录屏渲染」配的执行器逐章录屏，合成 mp4，按章节时间点出字幕"),
		wait("dist", "分发包检查", "distribution", "封面、简介、章节时间轴都齐了再放行，之后去发布记录按平台发"),
	}
	fields := []map[string]any{
		{"key": "video_id", "label": "视频", "type": "text", "required": true, "placeholder": "视频 id，在视频详情的地址栏里"},
	}
	sb, _ := json.Marshal(steps)
	fb, _ := json.Marshal(fields)
	return plugin.SOPFlowTemplate{
		ID:      WeeklyFlowID,
		Name:    "视频周更",
		Desc:    "按 web-video-presentation 技能把一集从原文做到分发包：各阶段交给视频里配的执行器，四个检查点停下等人在视频页确认。要改先复制一份",
		Trigger: "manual",
		Fields:  fb,
		Steps:   sb,
	}
}

// templates 是本插件写进 SOP 的内置流程。
func templates() []plugin.SOPFlowTemplate { return []plugin.SOPFlowTemplate{weeklyFlow()} }

// installTemplates 把还没写过的内置流程写进 SOP。SOP 插件没在跑就下次再试；已经有同 id 的流程也算写过。
func installTemplates(ctx context.Context, c plugin.Core) error {
	for _, t := range templates() {
		var n int
		if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM video_sop_templates WHERE flow_id = ?`, t.ID).Scan(&n); err != nil {
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
			c.Log().Warn("video sop template install failed", "flow", t.ID, "err", err)
			continue
		}
		if _, err := c.Store().Exec(ctx, `INSERT INTO video_sop_templates (flow_id, installed_at) VALUES (?, ?) ON CONFLICT (flow_id) DO NOTHING`,
			t.ID, nowStr()); err != nil {
			return err
		}
		c.Log().Info("video sop template installed", "flow", t.ID, "created", created)
	}
	return nil
}

// OnUninstall 撤下写进 SOP、用户没改过的内置流程；改过的、SOP 插件没在跑撤不了的留着，不挡卸载。
func (p *Plugin) OnUninstall(ctx context.Context, c plugin.Core, deleteData bool) error {
	for _, t := range templates() {
		var n int
		if err := c.Store().QueryRow(ctx, `SELECT count(*) FROM video_sop_templates WHERE flow_id = ?`, t.ID).Scan(&n); err != nil || n == 0 {
			continue
		}
		removed, why, err := c.SOP().RemoveFlow(ctx, t.ID)
		if err != nil {
			c.Log().Warn("video sop template remove failed", "flow", t.ID, "err", err)
			continue
		}
		if !removed && why != "" {
			c.Log().Info("video sop template kept", "flow", t.ID, "reason", why)
			continue
		}
		if !deleteData {
			if _, err := c.Store().Exec(ctx, `DELETE FROM video_sop_templates WHERE flow_id = ?`, t.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
