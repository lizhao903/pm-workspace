package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 阶段执行器（VID-03b）：表 video_runners、video_runs，接口 /api/video/videos/{id}/runners/{stage}。
// 每个视频每个阶段可配一个执行器（技能、SOP、Agent），跑的时候经内核 Core.Runs 发起，不等跑完；
// 结束（run.finished，或者读视频时补收）后把这一阶段的产出物登记或升版成待验收，检查点仍由人确认。
// 技能交给本机 Claude Code，工作目录是视频工程目录，提示词带上 web-video-presentation 技能的阶段说明。

// RunnerTypes 同原型 RunnerType。
var RunnerTypes = []string{"skill", "sop", "agent"}

var runnerTypeLabels = map[string]string{"skill": "技能", "sop": "SOP", "agent": "Agent"}

// RunKinds 同原型 RUN_KINDS：每个阶段跑完登记哪些产出物，按比例区分的每个比例一份。
// 能配执行器的阶段就是这几个；规划检查、第一章验收只有人能做。
var RunKinds = map[string][]string{
	"script":       {"script", "outline"},
	"web":          {"presentation"},
	"chapters":     {"presentation"},
	"audio":        {"audio"},
	"record":       {"video", "subtitle"},
	"distribution": {"description", "chapters"},
}

// videoSkill 是能当执行器的技能：Skill 是本机 Claude Code 里的技能名。
type videoSkill struct {
	Name  string
	Skill string
}

// Skills 同原型 agentdata 的 SKILLS 里做视频的那个；别的技能 id 配上了也跑不起来。
var Skills = map[string]videoSkill{
	"sk_video": {Name: "网页演示做视频", Skill: "web-video-presentation"},
}

// stagePhases 是 web-video-presentation 技能每个阶段要做的事，写进交给 Claude Code 的提示词。
var stagePhases = map[string]string{
	"script":       "Phase 1 内容编写：按 references/SCRIPT-STYLE.md 和 references/OUTLINE-FORMAT.md 一次产出 script.md 和 outline.md；工程里有 article.md 就以它为原文。",
	"web":          "Phase 2.1 脚手架和 2.2 第 1 章：按选好的画面比例搭演示工程，第 1 章按 references/CHAPTER-CRAFT.md 完整做出来，第 2 到 N 章先不做。",
	"chapters":     "Phase 2.3 和 2.4 第 2 到 N 章：照第 1 章的样板做剩下的章节，每章按 references/CHAPTER-CRAFT.md 自检。",
	"audio":        "Phase 3 音频合成：按 references/AUDIO.md 从 narrations.ts 生成各章口播音频。",
	"record":       "Phase 4 录屏和后期：按 references/RECORDING.md 程序化录屏合成 mp4，按章节时间点出字幕。",
	"distribution": "Phase 5 分发包：按 references/COVER.md 出封面、description.md 和 chapters.md。",
}

var orientRatios = map[string]string{"landscape": "16:9", "portrait": "9:16", "square": "1:1"}

const maxRunnerRef = 100

func stageLabel(k string) string {
	if i := stageIndex(k); i >= 0 {
		return Stages[i].Label
	}
	return k
}

// attachRuns 给视频带上执行器和最近一次执行。idx 是视频 id 到下标。
func (h *handler) attachRuns(ctx context.Context, out []Video, idx map[string]int) error {
	for i := range out {
		out[i].Runners = []StageRunner{}
	}
	if len(out) == 0 {
		return nil
	}
	one := len(out) == 1
	q, args := `SELECT video_id, stage, type, ref_id, prompt FROM video_runners`, []any{}
	if one {
		q, args = q+` WHERE video_id = ?`, []any{out[0].ID}
	}
	rows, err := h.c.Store().Query(ctx, q, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var vid string
		var sr StageRunner
		if err := rows.Scan(&vid, &sr.Stage, &sr.Type, &sr.RefID, &sr.Prompt); err != nil {
			return err
		}
		if i, ok := idx[vid]; ok {
			out[i].Runners = append(out[i].Runners, sr)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range out {
		slices.SortFunc(out[i].Runners, func(a, b StageRunner) int { return stageIndex(a.Stage) - stageIndex(b.Stage) })
	}
	q = `SELECT ` + runCols + ` FROM video_runs WHERE id IN (SELECT max(id) FROM video_runs GROUP BY video_id)`
	args = nil
	if one {
		q = `SELECT ` + runCols + ` FROM video_runs WHERE video_id = ? ORDER BY id DESC LIMIT 1`
		args = []any{out[0].ID}
	}
	lrows, err := h.c.Store().Query(ctx, q, args...)
	if err != nil {
		return err
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		rr, err := scanRun(lrows)
		if err != nil {
			return err
		}
		if i, ok := idx[rr.videoID]; ok {
			lr := rr.lastRun()
			out[i].LastRun = &lr
		}
	}
	return lrows.Err()
}

const runCols = `id, video_id, stage, type, runner_type, ref_id, prompt, run_id, ref, status, error, artifact_ids, started_at, ended_at`

// runRow 是 video_runs 的一行。
type runRow struct {
	id                         int64
	videoID, stage, typ        string
	runnerType, refID, prompt  string
	runID, ref, status, errMsg string
	artifactIDs                []string
	startedAt                  string
	endedAt                    *string
}

func scanRun(row plugin.Row) (runRow, error) {
	var r runRow
	var arts string
	if err := row.Scan(&r.id, &r.videoID, &r.stage, &r.typ, &r.runnerType, &r.refID, &r.prompt, &r.runID, &r.ref, &r.status, &r.errMsg,
		&arts, &r.startedAt, &r.endedAt); err != nil {
		return runRow{}, err
	}
	_ = json.Unmarshal([]byte(arts), &r.artifactIDs)
	return r, nil
}

func (r runRow) lastRun() LastRun {
	lr := LastRun{Type: r.typ, ID: r.runID, Stage: r.stage, Status: r.status, StartedAt: r.startedAt, Error: r.errMsg, ArtifactIDs: r.artifactIDs, Ref: r.ref}
	if r.endedAt != nil {
		lr.EndedAt = *r.endedAt
	}
	return lr
}

func (h *handler) runnerOf(ctx context.Context, videoID, stage string) (*StageRunner, error) {
	sr := StageRunner{Stage: stage}
	err := h.c.Store().QueryRow(ctx, `SELECT type, ref_id, prompt FROM video_runners WHERE video_id = ? AND stage = ?`, videoID, stage).
		Scan(&sr.Type, &sr.RefID, &sr.Prompt)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sr, nil
}

// runnableStage 看阶段能不能配执行器，不能的 400。
func runnableStage(stage string) error {
	i := stageIndex(stage)
	if i < 0 {
		return apiErr(errValidation, "没有 %s 这个阶段", stage)
	}
	if _, ok := RunKinds[stage]; !ok {
		return apiErr(errValidation, "「%s」只有人能做，不能配执行器", Stages[i].Label)
	}
	return nil
}

// putRunner：配或换一个阶段的执行器，整条替换（同原型 saveRunner）。
func (h *handler) putRunner(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, stage := r.PathValue("id"), r.PathValue("stage")
	raw, err := readBody(r, "type", "ref_id", "prompt")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := runnableStage(stage); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.getVideo(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	sr := StageRunner{Stage: stage}
	if err := enumField(raw, "type", "type", &sr.Type, RunnerTypes); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if sr.Type == "" {
		fail(w, r, h.c, apiErr(errValidation, "type 必填，只能是 skill、sop、agent"))
		return
	}
	if err := strField(raw, "ref_id", "ref_id", &sr.RefID, maxRunnerRef); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if sr.RefID == "" {
		fail(w, r, h.c, apiErr(errValidation, "要选一个%s", runnerTypeLabels[sr.Type]))
		return
	}
	if _, ok := Skills[sr.RefID]; sr.Type == "skill" && !ok {
		fail(w, r, h.c, apiErr(errValidation, "找不到技能「%s」，现在能用的是 sk_video（网页演示做视频）", sr.RefID))
		return
	}
	if err := strField(raw, "prompt", "提示词", &sr.Prompt, 2000); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_runners (video_id, stage, type, ref_id, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (video_id, stage) DO UPDATE SET type = excluded.type, ref_id = excluded.ref_id, prompt = excluded.prompt, updated_at = excluded.updated_at`,
		id, stage, sr.Type, sr.RefID, sr.Prompt, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.respondVideo(w, r, http.StatusOK, id)
}

// removeRunner：这个阶段不用执行器了，没配过也回 200。执行记录留着。
func (h *handler) removeRunner(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, stage := r.PathValue("id"), r.PathValue("stage")
	if err := runnableStage(stage); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.getVideo(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_runners WHERE video_id = ? AND stage = ?`, id, stage); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.respondVideo(w, r, http.StatusOK, id)
}

// respondVideo 刷新视频的更新时间，读回视频写回。
func (h *handler) respondVideo(w http.ResponseWriter, r *http.Request, status int, id string) {
	ctx := r.Context()
	if err := h.touchVideo(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": out})
}

// runBlocked 是跑之前的检查，不过的 409 并说明原因，不写执行记录：
// 前面的检查点都要通过或跳过（规划检查没过不能开始网页开发），只能跑视频当前所在的阶段，检查点已经确认过的不能再跑。
func runBlocked(v Video, stage string) error {
	i := stageIndex(stage)
	for _, s := range Stages[:i] {
		if !s.Checkpoint {
			continue
		}
		switch v.checkpoint(s.Key).State {
		case "passed", "skipped":
			continue
		case "rejected":
			return apiErr(errConflict, "「%s」被退回了，改好通过后才能开始「%s」", s.Label, Stages[i].Label)
		default:
			return apiErr(errConflict, "「%s」还没通过，不能开始「%s」", s.Label, Stages[i].Label)
		}
	}
	if v.Stage != stage {
		if stageIndex(v.Stage) < i {
			return apiErr(errConflict, "视频还在「%s」，做到「%s」再跑", stageLabel(v.Stage), Stages[i].Label)
		}
		return apiErr(errConflict, "视频已经过了「%s」，现在在「%s」，只能跑当前阶段", Stages[i].Label, stageLabel(v.Stage))
	}
	if Stages[i].Checkpoint {
		if st := v.checkpoint(stage).State; st == "passed" || st == "skipped" {
			return apiErr(errConflict, "「%s」已经确认过了", Stages[i].Label)
		}
	}
	return nil
}

// readOptionalBody 认空请求体或 {}，带了字段 400。
func readOptionalBody(r *http.Request) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return apiErr(errValidation, "读请求体失败：%v", err)
	}
	if strings.TrimSpace(string(b)) == "" {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	for k := range m {
		return apiErr(errValidation, "不认识的字段 %s", k)
	}
	return nil
}

// runStage：用这个阶段配的执行器跑一次。检查不过 409；发起时就失败的（找不到技能、目录不可用、没确认权限）
// 记一条失败的执行回 200；发起成功回 202，last_run 是 running，跑完由 run.finished 收尾。
func (h *handler) runStage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, stage := r.PathValue("id"), r.PathValue("stage")
	if err := readOptionalBody(r); err != nil {
		fail(w, r, h.c, err)
		return
	}
	_, startErr, err := h.startStage(ctx, id, stage)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if startErr != nil {
		h.respondVideo(w, r, http.StatusOK, id)
		return
	}
	h.respondVideo(w, r, http.StatusAccepted, id)
}

// startStage 是 runStage 和 SOP 节点 video_run_stage 共用的发起：检查不过回 err（409 那些）；
// 发起时就失败的记一条失败的执行，回 startErr；发起成功回执行记录的行 id。
func (h *handler) startStage(ctx context.Context, id, stage string) (rowID int64, startErr, err error) {
	if err := runnableStage(stage); err != nil {
		return 0, nil, err
	}
	h.reconcileRuns(ctx)
	v, err := h.getVideo(ctx, id)
	if err != nil {
		return 0, nil, err
	}
	if err := runBlocked(v, stage); err != nil {
		return 0, nil, err
	}
	sr, err := h.runnerOf(ctx, id, stage)
	if err != nil {
		return 0, nil, err
	}
	if sr == nil {
		return 0, nil, apiErr(errConflict, "「%s」还没配执行器，先配一个再跑", stageLabel(stage))
	}
	if lr := v.LastRun; lr != nil && lr.Status == "running" {
		return 0, nil, apiErr(errConflict, "「%s」正在跑，等它跑完再试", stageLabel(lr.Stage))
	}
	typ := "agent"
	if sr.Type == "sop" {
		typ = "sop"
	}
	// 先写一行占住：同一视频同一时间只能有一条在跑，并发时撞部分唯一索引
	res, err := h.c.Store().Exec(ctx, `INSERT INTO video_runs (video_id, stage, type, runner_type, ref_id, prompt, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, stage, typ, sr.Type, sr.RefID, sr.Prompt, nowStr())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			err = apiErr(errConflict, "这个视频有一个阶段正在跑，等它跑完再试")
		}
		return 0, nil, err
	}
	rowID, err = res.LastInsertId()
	if err != nil {
		return 0, nil, err
	}
	runID, startErr := h.startRunner(ctx, v, *sr)
	if startErr != nil {
		if err := h.claimRun(ctx, rowID, "failed", startErr.Error(), ""); err != nil {
			return 0, nil, err
		}
		return rowID, startErr, nil
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_runs SET run_id = ? WHERE id = ?`, runID, rowID); err != nil {
		return 0, nil, err
	}
	// 跑得比回写 run_id 还快时，run.finished 已经错过了，这里补收
	if info, err := h.c.Runs().Get(runID); err == nil && info.Finished {
		h.finishRun(ctx, rowID, info)
	}
	return rowID, nil, nil
}

// startRunner 按执行器的类型经 Core.Runs 发起，回内核的运行 id。错误的文案直接记进 last_run.error。
func (h *handler) startRunner(ctx context.Context, v Video, sr StageRunner) (string, error) {
	for _, k := range RunKinds[sr.Stage] {
		if ak, _ := artifactKind(k); ak.PerVariant && len(v.Orientations) == 0 {
			return "", errors.New("还没定画面比例，先在规划检查里选好")
		}
	}
	runs := h.c.Runs()
	switch sr.Type {
	case "skill":
		sk, ok := Skills[sr.RefID]
		if !ok {
			return "", fmt.Errorf("找不到技能「%s」，可能已经删掉了，换一个再跑", sr.RefID)
		}
		wd, err := h.workdirOf(ctx, v)
		if err != nil {
			return "", err
		}
		if !h.c.Granted("process:spawn") {
			return "", errors.New("技能要在工程目录里写文件，先在插件管理里给视频插件确认「起子进程」（process:spawn）权限")
		}
		id, err := runs.StartClaudeCode(ctx, plugin.ClaudeCodeStart{
			Workdir: wd, Prompt: skillPrompt(v, sr, sk), AllowWrites: true, ScopeType: "video", ScopeID: v.ID,
		})
		return id, plainRunErr(err)
	case "agent":
		id, err := runs.StartAgent(ctx, plugin.AgentRunStart{Agent: sr.RefID, Prompt: agentPrompt(v, sr), Title: runTitle(v, sr.Stage)})
		return id, plainRunErr(err)
	default:
		id, err := runs.StartSOP(ctx, plugin.SOPRunStart{Flow: sr.RefID, Input: map[string]any{
			"video_id": v.ID, "title": v.Title, "stage": sr.Stage, "root": v.Root, "prompt": sr.Prompt,
		}})
		return id, plainRunErr(err)
	}
}

// plainRunErr 把内核的哨兵错误换成用户看得懂的话。
func plainRunErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, plugin.ErrNoSOPStarter):
		return errors.New("SOP 插件没启用，SOP 执行器跑不了")
	case errors.Is(err, plugin.ErrNoAgent):
		return errors.New("Agent 还没接上，Agent 执行器跑不了")
	case errors.Is(err, plugin.ErrNoClaudeRunner):
		return errors.New("本机 Claude Code 还没接上，技能跑不了")
	case errors.Is(err, plugin.ErrNotGranted):
		return errors.New("视频插件没确认「起子进程」（process:spawn）权限，技能写不了文件")
	}
	return err
}

// workdirOf 是技能的工作目录：视频工程目录是绝对路径就用它；相对路径接在所属项目的工作区目录后面，不能越出去。
func (h *handler) workdirOf(ctx context.Context, v Video) (string, error) {
	root := strings.TrimSpace(v.Root)
	if root == "" {
		return "", errors.New("视频还没填工程目录，技能不知道在哪跑")
	}
	if filepath.IsAbs(root) {
		return filepath.Clean(root), nil
	}
	if v.ProjectID != nil {
		o, err := h.c.Objects().Get(ctx, *v.ProjectID)
		if err == nil && !o.Deleted && filepath.IsAbs(o.Workdir) {
			base := filepath.Clean(o.Workdir)
			wd := filepath.Join(base, root)
			if rel, err := filepath.Rel(base, wd); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return "", fmt.Errorf("工程目录 %s 越出了项目的工作区目录", root)
			}
			return wd, nil
		}
	}
	return "", fmt.Errorf("工程目录 %s 是相对路径：写成绝对路径，或者给视频挂一个设了工作区目录的项目", root)
}

func runTitle(v Video, stage string) string {
	t := v.Title
	if t == "" {
		t = "未命名视频"
	}
	return "视频《" + t + "》" + stageLabel(stage)
}

// stageBrief 是两种提示词共用的视频信息和这一阶段要做的事。
func stageBrief(v Video, stage string) string {
	var b strings.Builder
	ratios := make([]string, 0, len(v.Orientations))
	for _, o := range v.Orientations {
		ratios = append(ratios, orientLabel(o)+" "+orientRatios[o])
	}
	if len(ratios) == 0 {
		ratios = append(ratios, "还没定")
	}
	title := v.Title
	if title == "" {
		title = "未命名视频"
	}
	fmt.Fprintf(&b, "视频：《%s》\n", title)
	fmt.Fprintf(&b, "画面比例：%s", strings.Join(ratios, "、"))
	if len(v.Orientations) > 1 {
		b.WriteString("（两个方向用布局 B：横版写在 pc/、竖版写在 app/）")
	}
	fmt.Fprintf(&b, "\n章节数：%d\n", v.Chapters)
	fmt.Fprintf(&b, "这一阶段：「%s」，%s\n", stageLabel(stage), stagePhases[stage])
	b.WriteString("只做这一个阶段，做完就停；规划检查、第一章验收、音频、分发包这几个检查点由人在工作台确认，不要自己往下走。\n")
	return b.String()
}

// skillPrompt 是交给 Claude Code 的提示词：用哪个技能、做哪个阶段，加上执行器配的补充要求。
func skillPrompt(v Video, sr StageRunner, sk videoSkill) string {
	var b strings.Builder
	fmt.Fprintf(&b, "用 %s 技能做视频的「%s」阶段，当前目录就是这个视频的工程目录。\n\n", sk.Skill, stageLabel(sr.Stage))
	b.WriteString(stageBrief(v, sr.Stage))
	if sr.Prompt != "" {
		fmt.Fprintf(&b, "\n补充要求：%s\n", sr.Prompt)
	}
	return b.String()
}

func agentPrompt(v Video, sr StageRunner) string {
	var b strings.Builder
	fmt.Fprintf(&b, "做视频的「%s」阶段，视频工程目录是 %s，做法按 web-video-presentation 技能。\n\n", stageLabel(sr.Stage), v.Root)
	b.WriteString(stageBrief(v, sr.Stage))
	if sr.Prompt != "" {
		fmt.Fprintf(&b, "\n补充要求：%s\n", sr.Prompt)
	}
	return b.String()
}

// claimRun 把在跑的一行改成结束状态，已经收尾过的不动（返回 errRunClaimed）。
func (h *handler) claimRun(ctx context.Context, rowID int64, status, msg, ref string) error {
	res, err := h.c.Store().Exec(ctx, `UPDATE video_runs SET status = ?, error = ?, ref = CASE WHEN ? = '' THEN ref ELSE ? END, ended_at = ?
		WHERE id = ? AND status = 'running'`, status, msg, ref, ref, nowStr(), rowID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errRunClaimed
	}
	return nil
}

var errRunClaimed = errors.New("执行已经收尾过了")

// runFailText 是没跑成时记进 last_run.error 的话。
func runFailText(info plugin.RunInfo) string {
	switch info.Status {
	case plugin.RunWaiting:
		return "Agent 停在要确认的调用上：" + info.Error + "；到 Agent 会话里确认后接着跑，产出物要手动登记"
	case plugin.RunCanceled:
		return "运行被取消了"
	case plugin.RunStopped:
		return "SOP 执行被停止了"
	}
	if info.Error != "" {
		return info.Error
	}
	return "运行失败，没有返回原因"
}

// finishRun 收尾一次执行（只收一次）：跑成了把这一阶段的产出物登记或升版成待验收，没跑成记失败。检查点都不动。
// 出错只记日志：调用方是事件处理和读视频时的补收，不该因为这一步失败。
func (h *handler) finishRun(ctx context.Context, rowID int64, info plugin.RunInfo) {
	if !info.OK {
		if err := h.claimRun(ctx, rowID, "failed", runFailText(info), info.Ref); err != nil && !errors.Is(err, errRunClaimed) {
			h.c.Log().Warn("video run finish failed", "run", info.ID, "err", err)
		}
		return
	}
	h.finishMu.Lock()
	defer h.finishMu.Unlock()
	var status string
	if err := h.c.Store().QueryRow(ctx, `SELECT status FROM video_runs WHERE id = ?`, rowID).Scan(&status); err != nil || status != "running" {
		return // 已经收尾过了（事件和读视频时的补收会撞上）
	}
	ids, err := h.registerRunArtifacts(ctx, rowID, info)
	if err != nil {
		h.c.Log().Warn("video run artifacts failed", "run", info.ID, "err", err)
		if err := h.claimRun(ctx, rowID, "failed", "跑完了，但产出物没登记上："+err.Error(), info.Ref); err != nil && !errors.Is(err, errRunClaimed) {
			h.c.Log().Warn("video run finish failed", "run", info.ID, "err", err)
		}
		return
	}
	arts, _ := json.Marshal(ids)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_runs SET artifact_ids = ? WHERE id = ?`, string(arts), rowID); err != nil {
		h.c.Log().Warn("video run finish failed", "run", info.ID, "err", err)
	}
	if err := h.claimRun(ctx, rowID, "done", "", info.Ref); err != nil && !errors.Is(err, errRunClaimed) {
		h.c.Log().Warn("video run finish failed", "run", info.ID, "err", err)
	}
}

// registerRunArtifacts 同原型 run 的收尾：这一阶段的每种产出物（按比例区分的每个比例一份），已有的取最新一版升版本，
// 没有的按默认路径登记第 1 版，状态都是待验收（review），来源记执行器。
func (h *handler) registerRunArtifacts(ctx context.Context, rowID int64, info plugin.RunInfo) ([]string, error) {
	rr, err := scanRun(h.c.Store().QueryRow(ctx, `SELECT `+runCols+` FROM video_runs WHERE id = ?`, rowID))
	if err != nil {
		return nil, err
	}
	v, err := h.getVideo(ctx, rr.videoID)
	if err != nil {
		return nil, err
	}
	if err := h.upgradeLegacy(ctx); err != nil {
		return nil, err
	}
	src := ArtifactSource{Type: rr.runnerType, Label: rr.refID, ID: rr.refID}
	switch rr.runnerType {
	case "skill":
		if sk, ok := Skills[rr.refID]; ok {
			src.Label = sk.Name
		}
	case "agent":
		src.SessionID = info.Ref
	case "sop":
		src.RunID = info.Ref
	}
	st := h.c.Store()
	now := nowStr()
	ids := []string{}
	for _, kind := range RunKinds[rr.stage] {
		ak, _ := artifactKind(kind)
		variants := []string{""}
		if ak.PerVariant {
			variants = v.Orientations
			if len(variants) == 0 {
				return nil, errors.New("还没定画面比例")
			}
		}
		name := runArtifactName(rr.stage, kind, v)
		for _, o := range variants {
			var oldID string
			err := st.QueryRow(ctx, `SELECT id FROM video_artifacts WHERE video_id = ? AND kind = ? AND variant = ? ORDER BY version DESC, rowid DESC LIMIT 1`,
				v.ID, kind, o).Scan(&oldID)
			switch {
			case err == nil:
				if _, err := st.Exec(ctx, `UPDATE video_artifacts SET name = ?, version = min(version + 1, 9999), status = 'review', source_type = ?, source_label = ?,
					source_id = ?, session_id = ?, run_id = ?, core_artifact_id = '', updated_at = ? WHERE id = ?`,
					name, src.Type, src.Label, src.ID, src.SessionID, src.RunID, now, oldID); err != nil {
					return nil, err
				}
				ids = append(ids, oldID)
			case errors.Is(err, plugin.ErrNoRows):
				a := Artifact{VideoID: v.ID, Kind: kind, Name: name, Path: defaultRunPath(kind, v, o), Variant: o, Version: 1, Status: "review", Source: src}
				if kind == "subtitle" {
					a.Lang = "zh"
				}
				a.ID = idgen.Prefixed("vaf")
				if _, err := st.Exec(ctx, `INSERT INTO video_artifacts (`+artifactCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					a.ID, a.VideoID, a.Kind, a.Name, a.Path, a.Variant, a.Ratio, a.Option, a.Lang, a.Version, a.Status, a.Duration, 0,
					src.Type, src.Label, src.ID, src.SessionID, src.RunID, "", now, now); err != nil {
					return nil, err
				}
				ids = append(ids, a.ID)
			default:
				return nil, err
			}
		}
	}
	if err := h.touchVideo(ctx, v.ID); err != nil {
		return nil, err
	}
	return ids, nil
}

// runArtifactName 同原型 runName。
func runArtifactName(stage, kind string, v Video) string {
	switch kind {
	case "presentation":
		if stage == "web" {
			return "演示工程（第 1 章）"
		}
		return "演示工程"
	case "audio":
		return fmt.Sprintf("口播音频（%d 章）", v.Chapters)
	case "video":
		return "成片"
	}
	return kindLabel(kind)
}

// defaultRunPath 同原型 defaultPath（不含封面）：相对视频工程目录。
func defaultRunPath(kind string, v Video, variant string) string {
	base := "video"
	if parts := strings.FieldsFunc(v.Root, func(r rune) bool { return r == '/' }); len(parts) > 0 {
		base = parts[len(parts)-1]
	}
	o := variant
	if o == "" {
		o = "landscape"
	}
	slug := strings.ReplaceAll(orientRatios[o], ":", "x")
	switch kind {
	case "presentation":
		return "presentation-" + o
	case "audio":
		return "audio/"
	case "video":
		return "out/" + base + "-" + slug + ".mp4"
	case "subtitle":
		return "subtitle/" + base + "-" + slug + ".srt"
	}
	if ak, _ := artifactKind(kind); ak.PerVariant {
		return kind + "-" + o + ".md"
	}
	return kind + ".md"
}

// runStaleAfter：写了执行记录却一直没拿到运行 id 的（发起到一半进程没了），过了这么久算失败。
const runStaleAfter = time.Minute

// reconcileRuns 收尾错过 run.finished 的执行：内核的运行已经结束的照常收尾；内核查不到的（服务重启过，
// 运行记录只在内存里）记失败。出错只记日志，不挡读视频。
func (h *handler) reconcileRuns(ctx context.Context) {
	rows, err := h.c.Store().Query(ctx, `SELECT id, run_id, started_at FROM video_runs WHERE status = 'running'`)
	if err != nil {
		h.c.Log().Warn("video reconcile runs failed", "err", err)
		return
	}
	type pending struct {
		id           int64
		runID, start string
	}
	var ps []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.runID, &p.start); err != nil {
			break
		}
		ps = append(ps, p)
	}
	_ = rows.Close()
	for _, p := range ps {
		if p.runID == "" {
			if time.Since(parseTime(p.start)) > runStaleAfter {
				_ = h.claimRun(ctx, p.id, "failed", "发起到一半中断了，没跑起来，重试一次", "")
			}
			continue
		}
		info, err := h.c.Runs().Get(p.runID)
		switch {
		case errors.Is(err, plugin.ErrRunNotFound):
			_ = h.claimRun(ctx, p.id, "failed", "工作台重启过，这次运行的结果拿不到了，重试一次", "")
		case err == nil && info.Finished:
			h.finishRun(ctx, p.id, info)
		}
	}
}

// onRunFinished 是 run.finished 的处理：本插件发起的、对得上执行记录的才收尾，任务执行的那条跳过。
func (h *handler) onRunFinished(ctx context.Context, c plugin.Core, e plugin.Event) error {
	var p struct {
		RunID string `json:"run_id"`
	}
	if json.Unmarshal(e.Payload, &p) != nil || p.RunID == "" {
		return nil
	}
	info, err := c.Runs().Get(p.RunID)
	if errors.Is(err, plugin.ErrRunNotFound) || (err == nil && !info.Finished) {
		return nil
	}
	if err != nil {
		return err
	}
	var rowID int64
	err = c.Store().QueryRow(ctx, `SELECT id FROM video_runs WHERE run_id = ? AND status = 'running'`, p.RunID).Scan(&rowID)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	h.finishRun(ctx, rowID, info)
	return nil
}
