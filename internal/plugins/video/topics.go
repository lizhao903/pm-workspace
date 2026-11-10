// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 选题：表 video_topics，接口 /api/video/topics（VID-08a）。
// 选题和素材的关联在 video_topic_clips，两边的 clip_ids、topic_ids 都从这张表读。
// 立项（make）生成一集视频并回写 video_id，视频这边用 GET /api/video/topics?video_id= 反查。

// TopicStatuses 同原型 TOPIC_FLOW。
var TopicStatuses = []string{"idea", "research", "ready", "scheduled", "made", "dropped"}

// PlatformPrefer 同原型 PLATFORMS 的 prefer：立项时按目标平台定画面比例。
var PlatformPrefer = map[string]string{
	"bilibili": "landscape", "youtube": "landscape", "douyin": "portrait", "channels": "portrait", "xiaohongshu": "portrait",
}

// TopicScore 同原型 TopicScore，各 1 到 5。
type TopicScore struct {
	Demand int `json:"demand"`
	Fit    int `json:"fit"`
	Effort int `json:"effort"`
}

// Topic 同原型 Topic：series_id、planned_at、video_id、drop_reason 没有就不返回。
type Topic struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Angle      string     `json:"angle"`
	Audience   string     `json:"audience"`
	Status     string     `json:"status"`
	Score      TopicScore `json:"score"`
	Tags       []string   `json:"tags"`
	SeriesID   *string    `json:"series_id,omitempty"`
	Platforms  []string   `json:"platforms"`
	Outline    string     `json:"outline"`
	ClipIDs    []string   `json:"clip_ids"`
	PlannedAt  *string    `json:"planned_at,omitempty"`
	VideoID    *string    `json:"video_id,omitempty"`
	DropReason string     `json:"drop_reason,omitempty"`
	CreatedAt  string     `json:"created_at"`
	UpdatedAt  string     `json:"updated_at"`
}

const topicCols = `id, title, angle, audience, status, demand, fit, effort, tag_list, series_id, platforms, outline, planned_at,
	video_id, drop_reason, created_at, updated_at`

var topicFields = []string{"title", "angle", "audience", "status", "score", "tags", "series_id", "platforms", "outline", "clip_ids",
	"planned_at", "drop_reason"}

func scanTopic(row plugin.Row) (Topic, error) {
	var t Topic
	var tags, platforms string
	if err := row.Scan(&t.ID, &t.Title, &t.Angle, &t.Audience, &t.Status, &t.Score.Demand, &t.Score.Fit, &t.Score.Effort, &tags,
		&t.SeriesID, &platforms, &t.Outline, &t.PlannedAt, &t.VideoID, &t.DropReason, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return Topic{}, err
	}
	t.Tags, t.Platforms = jsonStrings(tags), jsonStrings(platforms)
	t.ClipIDs = []string{}
	return t, nil
}

func jsonStrings(s string) []string {
	var out []string
	if json.Unmarshal([]byte(s), &out) != nil || out == nil {
		return []string{}
	}
	return out
}

func (h *handler) loadTopics(ctx context.Context, where string, args ...any) ([]Topic, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+topicCols+` FROM video_topics `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Topic{}
	idx := map[string]int{}
	for rows.Next() {
		t, err := scanTopic(rows)
		if err != nil {
			return nil, err
		}
		idx[t.ID] = len(out)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	q, qargs := `SELECT topic_id, clip_id FROM video_topic_clips`, []any{}
	if len(out) == 1 {
		q, qargs = q+` WHERE topic_id = ?`, []any{out[0].ID}
	}
	lrows, err := h.c.Store().Query(ctx, q+` ORDER BY at, rowid`, qargs...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		var tid, cid string
		if err := lrows.Scan(&tid, &cid); err != nil {
			return nil, err
		}
		if i, ok := idx[tid]; ok {
			out[i].ClipIDs = append(out[i].ClipIDs, cid)
		}
	}
	return out, lrows.Err()
}

func (h *handler) getTopic(ctx context.Context, id string) (Topic, error) {
	xs, err := h.loadTopics(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Topic{}, err
	}
	if len(xs) == 0 {
		return Topic{}, apiErr(errNotFound, "选题不存在")
	}
	return xs[0], nil
}

func (h *handler) listTopics(w http.ResponseWriter, r *http.Request) {
	var conds []string
	var args []any
	q := r.URL.Query()
	if s := q.Get("status"); s != "" {
		if !slices.Contains(TopicStatuses, s) {
			fail(w, r, h.c, apiErr(errValidation, "status 只能是 %s", strings.Join(TopicStatuses, "、")))
			return
		}
		conds, args = append(conds, "status = ?"), append(args, s)
	}
	for _, k := range []string{"series_id", "video_id"} {
		if s := q.Get(k); s != "" {
			conds, args = append(conds, k+" = ?"), append(args, s)
		}
	}
	if s := q.Get("clip_id"); s != "" {
		conds, args = append(conds, "id IN (SELECT topic_id FROM video_topic_clips WHERE clip_id = ?)"), append(args, s)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	out, err := h.loadTopics(r.Context(), where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showTopic(w http.ResponseWriter, r *http.Request) {
	t, err := h.getTopic(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": t})
}

// tagsField：字符串数组，去空白、去空串、去重保序；最多 50 个，每个最多 40 字。
func tagsField(raw map[string]json.RawMessage, key string, dst *[]string) error {
	b, ok := raw[key]
	if !ok {
		return nil
	}
	var xs []string
	if err := json.Unmarshal(b, &xs); err != nil || xs == nil {
		return apiErr(errValidation, "%s 必须是字符串数组", key)
	}
	out := []string{}
	for _, s := range xs {
		s = strings.TrimSpace(s)
		if s == "" || slices.Contains(out, s) {
			continue
		}
		if len([]rune(s)) > 40 {
			return apiErr(errValidation, "标签最多 40 字")
		}
		out = append(out, s)
	}
	if len(out) > 50 {
		return apiErr(errValidation, "标签最多 50 个")
	}
	*dst = out
	return nil
}

// idsField：id 数组，去重保序，不查存在（调用方查）。
func idsField(raw map[string]json.RawMessage, key string) ([]string, bool, error) {
	b, ok := raw[key]
	if !ok {
		return nil, false, nil
	}
	var xs []string
	if err := json.Unmarshal(b, &xs); err != nil || xs == nil {
		return nil, true, apiErr(errValidation, "%s 必须是 id 数组", key)
	}
	out := []string{}
	for _, s := range xs {
		if s = strings.TrimSpace(s); s != "" && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	if len(out) > 500 {
		return nil, true, apiErr(errValidation, "%s 最多 500 个", key)
	}
	return out, true, nil
}

// applyTopic 把 body 里传了的字段写进 t（clip_ids 由调用方处理）。
func (h *handler) applyTopic(ctx context.Context, t *Topic, raw map[string]json.RawMessage) error {
	for _, f := range []struct {
		key, label string
		dst        *string
		limit      int
	}{
		{"title", "标题", &t.Title, 200},
		{"angle", "切入角度", &t.Angle, 1000},
		{"audience", "受众", &t.Audience, 500},
		{"outline", "大纲", &t.Outline, 20000},
		{"drop_reason", "放弃原因", &t.DropReason, 500},
	} {
		if b, ok := raw[f.key]; ok && isNull(b) {
			*f.dst = ""
			continue
		}
		if err := strField(raw, f.key, f.label, f.dst, f.limit); err != nil {
			return err
		}
	}
	if err := enumField(raw, "status", "status", &t.Status, TopicStatuses); err != nil {
		return err
	}
	if b, ok := raw["score"]; ok {
		var s map[string]json.RawMessage
		if err := json.Unmarshal(b, &s); err != nil || s == nil {
			return apiErr(errValidation, "score 必须是 {demand, fit, effort}")
		}
		for k := range s {
			if k != "demand" && k != "fit" && k != "effort" {
				return apiErr(errValidation, "score 不认识的字段 %s", k)
			}
		}
		for _, f := range []struct {
			key, label string
			dst        *int
		}{{"demand", "需求度", &t.Score.Demand}, {"fit", "契合度", &t.Score.Fit}, {"effort", "成本", &t.Score.Effort}} {
			if err := intField(s, f.key, f.label, f.dst, 1, 5); err != nil {
				return err
			}
		}
	}
	if err := tagsField(raw, "tags", &t.Tags); err != nil {
		return err
	}
	if b, ok := raw["platforms"]; ok {
		var xs []string
		if err := json.Unmarshal(b, &xs); err != nil || xs == nil {
			return apiErr(errValidation, "platforms 必须是数组")
		}
		for _, p := range xs {
			if !slices.Contains(Platforms, p) {
				return apiErr(errValidation, "platforms 只能是 %s", strings.Join(Platforms, "、"))
			}
		}
		t.Platforms = slices.DeleteFunc(slices.Clone(Platforms), func(p string) bool { return !slices.Contains(xs, p) })
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
		t.SeriesID = id
	}
	if err := timeField(raw, "planned_at", "计划日期", &t.PlannedAt); err != nil {
		return err
	}
	// 已做成只能靠立项进入（同原型：没有视频时「已做成」不可选）
	if _, ok := raw["status"]; ok && t.Status == "made" && t.VideoID == nil {
		return apiErr(errValidation, "已做成要先立项成视频")
	}
	return nil
}

// checkClips 查素材都存在。
func (h *handler) checkClips(ctx context.Context, ids []string) error {
	for _, id := range ids {
		var x string
		err := h.c.Store().QueryRow(ctx, `SELECT id FROM video_clips WHERE id = ?`, id).Scan(&x)
		if errors.Is(err, plugin.ErrNoRows) {
			return apiErr(errValidation, "素材 %s 不存在", id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// linkClip 关联一条素材到选题，素材记为已整理；已关联的不重复记。
func (h *handler) linkClip(ctx context.Context, topicID, clipID, now string) error {
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_topic_clips (topic_id, clip_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
		topicID, clipID, now); err != nil {
		return err
	}
	_, err := h.c.Store().Exec(ctx, `UPDATE video_clips SET triaged = 1, updated_at = ? WHERE id = ? AND triaged = 0`, now, clipID)
	return err
}

// setTopicClips 整体替换选题的素材：去掉的解除关联（素材留着），新加的关联上并记为已整理。
func (h *handler) setTopicClips(ctx context.Context, topicID string, ids []string, now string) error {
	b, _ := json.Marshal(ids)
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_topic_clips WHERE topic_id = ? AND clip_id NOT IN (SELECT value FROM json_each(?))`,
		topicID, string(b)); err != nil {
		return err
	}
	for _, id := range ids {
		if err := h.linkClip(ctx, topicID, id, now); err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) insertTopic(ctx context.Context, t Topic) error {
	tags, _ := json.Marshal(t.Tags)
	platforms, _ := json.Marshal(t.Platforms)
	_, err := h.c.Store().Exec(ctx, `INSERT INTO video_topics (`+topicCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Title, t.Angle, t.Audience, t.Status, t.Score.Demand, t.Score.Fit, t.Score.Effort, string(tags), t.SeriesID,
		string(platforms), t.Outline, t.PlannedAt, t.VideoID, t.DropReason, t.CreatedAt, t.UpdatedAt)
	return err
}

func newTopic() Topic {
	return Topic{Status: "idea", Score: TopicScore{3, 3, 3}, Tags: []string{}, Platforms: []string{}, ClipIDs: []string{}}
}

func (h *handler) addTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, topicFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t := newTopic()
	if err := h.applyTopic(ctx, &t, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	clips, _, err := idsField(raw, "clip_ids")
	if err == nil {
		err = h.checkClips(ctx, clips)
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t.ID = idgen.Prefixed("tp")
	t.CreatedAt = nowStr()
	t.UpdatedAt = t.CreatedAt
	if err := h.insertTopic(ctx, t); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.setTopicClips(ctx, t.ID, clips, t.CreatedAt); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getTopic(ctx, t.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *handler) updateTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, append(topicFields, "video_id")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, ok := raw["video_id"]; ok {
		fail(w, r, h.c, apiErr(errValidation, "video_id 由立项接口写，不能直接改"))
		return
	}
	t, err := h.getTopic(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.applyTopic(ctx, &t, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	clips, setClips, err := idsField(raw, "clip_ids")
	if err == nil && setClips {
		err = h.checkClips(ctx, clips)
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	tags, _ := json.Marshal(t.Tags)
	platforms, _ := json.Marshal(t.Platforms)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_topics SET title = ?, angle = ?, audience = ?, status = ?, demand = ?, fit = ?, effort = ?,
		tag_list = ?, series_id = ?, platforms = ?, outline = ?, planned_at = ?, drop_reason = ?, updated_at = ? WHERE id = ?`,
		t.Title, t.Angle, t.Audience, t.Status, t.Score.Demand, t.Score.Fit, t.Score.Effort, string(tags), t.SeriesID, string(platforms),
		t.Outline, t.PlannedAt, t.DropReason, now, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if setClips {
		if err := h.setTopicClips(ctx, id, clips, now); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	out, err := h.getTopic(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// removeTopic：关联随外键一起删，素材留着；立项生成的视频不动。
func (h *handler) removeTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getTopic(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_topics WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// makeVideo：立项（开始制作），同原型 makeVideoFromTopic。
// 生成一集视频：在系列里时集数接着系列最大集数往下排、标题带「第 n 集：」；比例按目标平台的偏好，没选平台用横屏；
// 工程目录 videos/<选题 id>，章节数 3，记下 topic_id，阶段直接是内容编写（选题一步算已完成，VID-09a）。然后回写 video_id、状态变已做成。
func (h *handler) makeVideo(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, "project_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t, err := h.getTopic(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	switch {
	case t.VideoID != nil:
		fail(w, r, h.c, apiErr(errConflict, "这个选题已经立项了"))
		return
	case t.Status == "dropped":
		fail(w, r, h.c, apiErr(errConflict, "已放弃的选题不能立项"))
		return
	case t.Title == "":
		fail(w, r, h.c, apiErr(errValidation, "先写标题"))
		return
	}
	v := Video{Title: t.Title, SeriesID: t.SeriesID, TopicID: &t.ID, Stage: "script", Root: "videos/" + t.ID, Chapters: 3}
	// project_id 的校验和视频接口一样
	if b, ok := raw["project_id"]; ok {
		if err := h.applyVideo(ctx, &v, map[string]json.RawMessage{"project_id": b}); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	for _, o := range Orients {
		for _, p := range t.Platforms {
			if PlatformPrefer[p] == o && !slices.Contains(v.Orientations, o) {
				v.Orientations = append(v.Orientations, o)
			}
		}
	}
	if len(v.Orientations) == 0 {
		v.Orientations = []string{"landscape"}
	}
	if v.SeriesID != nil {
		var maxEp int
		if err := h.c.Store().QueryRow(ctx, `SELECT COALESCE(MAX(episode), 0) FROM video_videos WHERE series_id = ?`, *v.SeriesID).Scan(&maxEp); err != nil {
			fail(w, r, h.c, err)
			return
		}
		ep := maxEp + 1
		v.Episode = &ep
		v.Title = fmt.Sprintf("第 %d 集：%s", ep, t.Title)
		if n := []rune(v.Title); len(n) > 200 {
			v.Title = string(n[:200])
		}
	}
	v.ID = idgen.Prefixed("vd")
	now := nowStr()
	orients, _ := json.Marshal(v.Orientations)
	// 列名写全，视频表以后加列（有默认值）不影响这里
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_videos (id, title, project_id, series_id, episode, orientations, stage, root, chapters,
		created_at, updated_at, topic_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.Title, v.ProjectID, v.SeriesID, v.Episode, string(orients), v.Stage, v.Root, v.Chapters, now, now, v.TopicID); err != nil {
		fail(w, r, h.c, uniqueErr(err))
		return
	}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_checkpoints (video_id, stage) VALUES (?, 'plan'), (?, 'ch1'), (?, 'audio'), (?, 'distribution')`,
		v.ID, v.ID, v.ID, v.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 按读到的状态回写，中间被别处立项过就把刚建的视频删掉
	res, err := h.c.Store().Exec(ctx, `UPDATE video_topics SET video_id = ?, status = 'made', updated_at = ? WHERE id = ? AND video_id IS NULL AND status <> 'dropped'`,
		v.ID, now, id)
	n := int64(0)
	if err == nil {
		n, _ = res.RowsAffected()
	}
	if err != nil || n == 0 {
		_, _ = h.c.Store().Exec(ctx, `DELETE FROM video_videos WHERE id = ?`, v.ID)
		if err == nil {
			err = apiErr(errConflict, "选题刚被别处改过，刷新后再操作")
		}
		fail(w, r, h.c, err)
		return
	}
	topic, err := h.getTopic(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	video, err := h.getVideo(ctx, v.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"topic": topic, "video": video}})
}
