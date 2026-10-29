package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 视频：表 video_videos、video_checkpoints，接口 /api/video/videos。
// 阶段只往前走：没有检查点的阶段用 advance，有检查点的阶段通过或跳过后进下一阶段，退回停在原地。

const videoCols = `id, title, project_id, series_id, episode, orientations, stage, root, chapters, created_at, updated_at`

var videoFields = []string{"title", "project_id", "series_id", "episode", "orientations", "root", "chapters"}

func scanVideo(row plugin.Row) (Video, error) {
	var v Video
	var episode *int64
	var orients string
	if err := row.Scan(&v.ID, &v.Title, &v.ProjectID, &v.SeriesID, &episode, &orients, &v.Stage, &v.Root, &v.Chapters, &v.CreatedAt, &v.UpdatedAt); err != nil {
		return Video{}, err
	}
	if episode != nil {
		n := int(*episode)
		v.Episode = &n
	}
	if err := json.Unmarshal([]byte(orients), &v.Orientations); err != nil || v.Orientations == nil {
		v.Orientations = []string{}
	}
	return v, nil
}

// loadVideos 查视频并带上检查点；缺的检查点行按 pending 补（新建时 4 行和视频不在一个事务里）。
func (h *handler) loadVideos(ctx context.Context, where string, args ...any) ([]Video, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+videoCols+` FROM video_videos `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Video{}
	idx := map[string]int{}
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}
		idx[v.ID] = len(out)
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	cps := map[string]map[string]Checkpoint{}
	if len(out) > 0 {
		q, qargs := `SELECT video_id, stage, state, note, at FROM video_checkpoints`, []any{}
		if len(out) == 1 {
			q, qargs = q+` WHERE video_id = ?`, []any{out[0].ID}
		}
		crows, err := h.c.Store().Query(ctx, q, qargs...)
		if err != nil {
			return nil, err
		}
		defer func() { _ = crows.Close() }()
		for crows.Next() {
			var vid string
			var cp Checkpoint
			var at *string
			if err := crows.Scan(&vid, &cp.Stage, &cp.State, &cp.Note, &at); err != nil {
				return nil, err
			}
			if _, ok := idx[vid]; !ok {
				continue
			}
			if at != nil {
				cp.At = *at
			}
			if cps[vid] == nil {
				cps[vid] = map[string]Checkpoint{}
			}
			cps[vid][cp.Stage] = cp
		}
		if err := crows.Err(); err != nil {
			return nil, err
		}
	}
	for i := range out {
		out[i].Checkpoints = make([]Checkpoint, 0, len(CheckpointStages))
		for _, k := range CheckpointStages {
			cp, ok := cps[out[i].ID][k]
			if !ok {
				cp = Checkpoint{Stage: k, State: "pending"}
			}
			out[i].Checkpoints = append(out[i].Checkpoints, cp)
		}
	}
	if err := h.attachRuns(ctx, out, idx); err != nil {
		return nil, err
	}
	return out, nil
}

func (h *handler) getVideo(ctx context.Context, id string) (Video, error) {
	xs, err := h.loadVideos(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Video{}, err
	}
	if len(xs) == 0 {
		return Video{}, apiErr(errNotFound, "视频不存在")
	}
	return xs[0], nil
}

func (v Video) checkpoint(stage string) Checkpoint {
	for _, c := range v.Checkpoints {
		if c.Stage == stage {
			return c
		}
	}
	return Checkpoint{Stage: stage, State: "pending"}
}

// orientLocked：规划检查通过后画面比例不能再改（同原型 orientLocked）。
func (v Video) orientLocked() bool { return v.checkpoint("plan").State == "passed" }

func (h *handler) listVideos(w http.ResponseWriter, r *http.Request) {
	h.reconcileRuns(r.Context())
	var conds []string
	var args []any
	q := r.URL.Query()
	if s := q.Get("series_id"); s != "" {
		conds, args = append(conds, "series_id = ?"), append(args, s)
	}
	if s := q.Get("project_id"); s != "" {
		conds, args = append(conds, "project_id = ?"), append(args, s)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	out, err := h.loadVideos(r.Context(), where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showVideo(w http.ResponseWriter, r *http.Request) {
	h.reconcileRuns(r.Context())
	v, err := h.getVideo(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": v})
}

// applyVideo 把 body 里传了的字段写进 v。画面比例锁定的检查在调用方（要和旧值比）。
func (h *handler) applyVideo(ctx context.Context, v *Video, raw map[string]json.RawMessage) error {
	if err := strField(raw, "title", "标题", &v.Title, 200); err != nil {
		return err
	}
	if err := strField(raw, "root", "工程目录", &v.Root, 1000); err != nil {
		return err
	}
	if err := intField(raw, "chapters", "章节数", &v.Chapters, 0, 999); err != nil {
		return err
	}
	if b, ok := raw["project_id"]; ok {
		id, err := optID(b, "project_id")
		if err != nil {
			return err
		}
		if id != nil {
			o, err := h.c.Objects().Get(ctx, *id)
			if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Deleted || o.Type != "project")) {
				return apiErr(errValidation, "项目不存在")
			}
			if err != nil {
				return err
			}
		}
		v.ProjectID = id
	}
	if b, ok := raw["series_id"]; ok {
		id, err := optID(b, "series_id")
		if err != nil {
			return err
		}
		if id != nil {
			if err := h.seriesExists(ctx, *id); err != nil {
				return err
			}
		}
		// 移出系列（变回单集）没给集数时，集数跟着清掉
		if id == nil {
			if _, ok := raw["episode"]; !ok {
				v.Episode = nil
			}
		}
		v.SeriesID = id
	}
	if b, ok := raw["episode"]; ok {
		if isNull(b) {
			v.Episode = nil
		} else {
			var n int
			if err := json.Unmarshal(b, &n); err != nil || n < 1 || n > 9999 {
				return apiErr(errValidation, "集数要是 1 到 9999 的整数")
			}
			v.Episode = &n
		}
	}
	if b, ok := raw["orientations"]; ok {
		var xs []string
		if err := json.Unmarshal(b, &xs); err != nil || xs == nil {
			return apiErr(errValidation, "orientations 必须是数组")
		}
		for _, o := range xs {
			if !slices.Contains(Orients, o) {
				return apiErr(errValidation, "画面比例只能是 landscape、portrait、square")
			}
		}
		// 去重，按原型 ORIENTS 的顺序存
		v.Orientations = slices.DeleteFunc(slices.Clone(Orients), func(o string) bool { return !slices.Contains(xs, o) })
	}
	return nil
}

// optID 认字符串或 null；空串也当 null。
func optID(b json.RawMessage, key string) (*string, error) {
	if isNull(b) {
		return nil, nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, apiErr(errValidation, "%s 必须是字符串或 null", key)
	}
	if s = strings.TrimSpace(s); s == "" {
		return nil, nil
	}
	return &s, nil
}

func (h *handler) addVideo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, videoFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v := Video{Orientations: []string{}, Stage: Stages[0].Key}
	if err := h.applyVideo(ctx, &v, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	v.ID = idgen.Prefixed("vd")
	now := nowStr()
	orients, _ := json.Marshal(v.Orientations)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_videos (`+videoCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.Title, v.ProjectID, v.SeriesID, v.Episode, string(orients), v.Stage, v.Root, v.Chapters, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_checkpoints (video_id, stage) VALUES (?, 'plan'), (?, 'ch1'), (?, 'audio'), (?, 'distribution')`,
		v.ID, v.ID, v.ID, v.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getVideo(ctx, v.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *handler) updateVideo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, append(videoFields, "stage", "checkpoints")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, ok := raw["stage"]; ok {
		fail(w, r, h.c, apiErr(errValidation, "阶段用 advance 或检查点接口推进，不能直接改"))
		return
	}
	if _, ok := raw["checkpoints"]; ok {
		fail(w, r, h.c, apiErr(errValidation, "检查点用检查点接口处理，不能直接改"))
		return
	}
	old, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v := old
	if err := h.applyVideo(ctx, &v, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if old.orientLocked() && !slices.Equal(old.Orientations, v.Orientations) {
		fail(w, r, h.c, apiErr(errConflict, "规划检查已通过，画面比例锁定了，要换比例得新开工程"))
		return
	}
	// 移出系列或换了系列，待同步标记跟着清掉
	stale := "stale"
	if !eqPtr(old.SeriesID, v.SeriesID) {
		stale = "0"
	}
	orients, _ := json.Marshal(v.Orientations)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET title = ?, project_id = ?, series_id = ?, episode = ?, orientations = ?,
		root = ?, chapters = ?, stale = `+stale+`, updated_at = ? WHERE id = ?`,
		v.Title, v.ProjectID, v.SeriesID, v.Episode, string(orients), v.Root, v.Chapters, nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func eqPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// removeVideo：检查点、发布记录、产出物和验收记录随外键一起删。
func (h *handler) removeVideo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getVideo(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_videos WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// advance：没有检查点的阶段做完了，进下一阶段。from 给了就要和当前阶段一致，防止重复点。
func (h *handler) advance(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, "from")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	from := v.Stage
	if err := strField(raw, "from", "from", &from, 20); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if from != v.Stage {
		fail(w, r, h.c, apiErr(errConflict, "视频已经在「%s」了，刷新后再操作", Stages[stageIndex(v.Stage)].Label))
		return
	}
	i := stageIndex(v.Stage)
	if Stages[i].Checkpoint {
		fail(w, r, h.c, apiErr(errConflict, "「%s」是检查点，要通过或跳过才能往下走", Stages[i].Label))
		return
	}
	if i == len(Stages)-1 {
		fail(w, r, h.c, apiErr(errConflict, "已经是最后一个阶段了"))
		return
	}
	if err := h.moveStage(ctx, id, v.Stage, Stages[i+1].Key); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// moveStage 按读到的阶段更新，中间被别处推进过算冲突。
func (h *handler) moveStage(ctx context.Context, id, from, to string) error {
	res, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET stage = ?, updated_at = ? WHERE id = ? AND stage = ?`, to, nowStr(), id, from)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return apiErr(errConflict, "视频刚被别处推进过，刷新后再操作")
	}
	return nil
}

// decide：当前阶段的检查点通过、退回或跳过（同原型 decide）。
// 退回必须写意见，停在原地；只有音频能跳过；规划检查通过前要先选画面比例；分发包通过后停在分发包，算已完成。
func (h *handler) decide(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, stage := r.PathValue("id"), r.PathValue("stage")
	raw, err := readBody(r, "state", "note")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	i := stageIndex(stage)
	if i < 0 || !Stages[i].Checkpoint {
		fail(w, r, h.c, apiErr(errValidation, "%s 不是检查点，检查点只有 plan、ch1、audio、distribution", stage))
		return
	}
	var state, note string
	if err := strField(raw, "state", "state", &state, 20); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := strField(raw, "note", "意见", &note, 2000); err != nil {
		fail(w, r, h.c, err)
		return
	}
	switch state {
	case "passed", "rejected", "skipped":
	default:
		fail(w, r, h.c, apiErr(errValidation, "state 只能是 passed、rejected、skipped"))
		return
	}
	if state == "rejected" && note == "" {
		fail(w, r, h.c, apiErr(errValidation, "退回要写意见"))
		return
	}
	if state == "skipped" && stage != "audio" {
		fail(w, r, h.c, apiErr(errValidation, "只有音频合成能跳过"))
		return
	}
	if v.Stage != stage {
		fail(w, r, h.c, apiErr(errConflict, "视频现在在「%s」，只能处理当前阶段的检查点", Stages[stageIndex(v.Stage)].Label))
		return
	}
	if cur := v.checkpoint(stage).State; cur == "passed" || cur == "skipped" {
		fail(w, r, h.c, apiErr(errConflict, "这个检查点已经处理过了"))
		return
	}
	if stage == "plan" && state == "passed" && len(v.Orientations) == 0 {
		fail(w, r, h.c, apiErr(errValidation, "先选至少一个画面比例"))
		return
	}
	next := stage
	if state != "rejected" && i < len(Stages)-1 {
		next = Stages[i+1].Key
	}
	// 先按读到的阶段改视频（并发时这一步冲突），再写检查点
	if err := h.moveStage(ctx, id, stage, next); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_checkpoints (video_id, stage, state, note, at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (video_id, stage) DO UPDATE SET state = excluded.state, note = excluded.note, at = excluded.at`,
		id, stage, state, note, nowStr()); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}
