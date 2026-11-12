// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 系列：表 video_series，接口 /api/video/series。stale 记在视频的 stale 列上，这里按集数汇总。

const seriesCols = `id, name, description, intro, outro, template, voice, voice_speed, created_at, updated_at`

var seriesFields = []string{"name", "desc", "intro", "outro", "template", "voice", "voice_speed"}

func (h *handler) loadSeries(ctx context.Context, where string, args ...any) ([]Series, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+seriesCols+` FROM video_series `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Series{}
	for rows.Next() {
		var s Series
		if err := rows.Scan(&s.ID, &s.Name, &s.Desc, &s.Intro, &s.Outro, &s.Template, &s.Voice, &s.VoiceSpeed, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		s.Stale = []string{}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 待同步的集一次查出来再分给各系列
	srows, err := h.c.Store().Query(ctx, `SELECT id, series_id FROM video_videos WHERE stale = 1 AND series_id IS NOT NULL
		ORDER BY episode IS NULL, episode, created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = srows.Close() }()
	idx := map[string]int{}
	for i, s := range out {
		idx[s.ID] = i
	}
	for srows.Next() {
		var vid, sid string
		if err := srows.Scan(&vid, &sid); err != nil {
			return nil, err
		}
		if i, ok := idx[sid]; ok {
			out[i].Stale = append(out[i].Stale, vid)
		}
	}
	return out, srows.Err()
}

func (h *handler) getSeries(ctx context.Context, id string) (Series, error) {
	xs, err := h.loadSeries(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Series{}, err
	}
	if len(xs) == 0 {
		return Series{}, apiErr(errNotFound, "系列不存在")
	}
	return xs[0], nil
}

func (h *handler) listSeries(w http.ResponseWriter, r *http.Request) {
	out, err := h.loadSeries(r.Context(), "")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showSeries(w http.ResponseWriter, r *http.Request) {
	s, err := h.getSeries(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": s})
}

func applySeries(s *Series, raw map[string]json.RawMessage) error {
	for _, f := range []struct {
		key, label string
		dst        *string
		limit      int
	}{
		{"name", "名称", &s.Name, 100},
		{"desc", "说明", &s.Desc, 1000},
		{"intro", "共用开场", &s.Intro, 500},
		{"outro", "共用收尾", &s.Outro, 500},
		{"template", "共用模板", &s.Template, 500},
	} {
		if err := strField(raw, f.key, f.label, f.dst, f.limit); err != nil {
			return err
		}
	}
	if err := strField(raw, "voice", "配音音色", &s.Voice, 100); err != nil {
		return err
	}
	if strings.ContainsAny(s.Voice, `/\\`) || strings.ContainsFunc(s.Voice, unicode.IsControl) {
		return apiErr(errValidation, "配音音色不能带路径分隔符或控制字符")
	}
	if v, ok := raw["voice_speed"]; ok {
		var f float64
		if err := json.Unmarshal(v, &f); err != nil {
			return apiErr(errValidation, "配音语速必须是数字")
		}
		if f < 0.5 || f > 2.0 {
			return apiErr(errValidation, "配音语速要在 0.5 到 2.0 之间")
		}
		s.VoiceSpeed = f
	} else if s.VoiceSpeed == 0 {
		// 新建没给时用 1.0；老数据读出来是 1.0，不会走到这里
		s.VoiceSpeed = 1
	}
	if s.Name == "" {
		return apiErr(errValidation, "名称必填")
	}
	return nil
}

func (h *handler) addSeries(w http.ResponseWriter, r *http.Request) {
	raw, err := readBody(r, seriesFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var s Series
	if err := applySeries(&s, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	s.ID = idgen.Prefixed("sr")
	now := nowStr()
	if _, err := h.c.Store().Exec(r.Context(), `INSERT INTO video_series (`+seriesCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.Name, s.Desc, s.Intro, s.Outro, s.Template, s.Voice, s.VoiceSpeed, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getSeries(r.Context(), s.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

// updateSeries：stale 整体替换，只能是本系列的集；改共用部分时前端把勾选的集并进去一起传。
func (h *handler) updateSeries(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, append(seriesFields, "stale")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	s, err := h.getSeries(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := applySeries(&s, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	var stale []string
	_, setStale := raw["stale"]
	if setStale {
		if err := json.Unmarshal(raw["stale"], &stale); err != nil || stale == nil {
			fail(w, r, h.c, apiErr(errValidation, "stale 必须是视频 id 数组"))
			return
		}
		eps, err := h.episodeIDs(ctx, id)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		for _, v := range stale {
			if !eps[v] {
				fail(w, r, h.c, apiErr(errValidation, "%s 不是这个系列的集", v))
				return
			}
		}
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_series SET name = ?, description = ?, intro = ?, outro = ?, template = ?, voice = ?, voice_speed = ?, updated_at = ? WHERE id = ?`,
		s.Name, s.Desc, s.Intro, s.Outro, s.Template, s.Voice, s.VoiceSpeed, nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if setStale {
		b, _ := json.Marshal(stale)
		if _, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET stale = (id IN (SELECT value FROM json_each(?))) WHERE series_id = ?`,
			string(b), id); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	out, err := h.getSeries(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handler) episodeIDs(ctx context.Context, seriesID string) (map[string]bool, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT id FROM video_videos WHERE series_id = ?`, seriesID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// removeSeries：各集变回单集（清掉系列、集数和待同步，规格 SPEC-videos-6.19），再删系列。
func (h *handler) removeSeries(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getSeries(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET series_id = NULL, episode = NULL, stale = 0, updated_at = ? WHERE series_id = ?`,
		nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_series WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

func (h *handler) seriesExists(ctx context.Context, id string) error {
	var x string
	err := h.c.Store().QueryRow(ctx, `SELECT id FROM video_series WHERE id = ?`, id).Scan(&x)
	if errors.Is(err, plugin.ErrNoRows) {
		return apiErr(errValidation, "系列不存在")
	}
	return err
}
