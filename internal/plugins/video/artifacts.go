package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 产出物：表 video_artifacts、video_artifact_reviews，接口 /api/video/artifacts（VID-01b）。
// 路径相对视频工程目录，越出去的拒绝（fs:read:project 只管工程目录）；现在只登记，不读写磁盘。

const artifactCols = `id, video_id, kind, name, path, variant, option_no, version, status, duration, picked,
	source_type, source_label, source_id, session_id, run_id, core_artifact_id, created_at, updated_at`

// 能改的字段；video_id、kind、version、source、reviews 在 PATCH 里单独报错
var artifactFields = []string{"name", "path", "variant", "option", "status", "duration", "picked"}

func scanArtifact(row plugin.Row) (Artifact, error) {
	var a Artifact
	var option, duration *int64
	var picked int
	if err := row.Scan(&a.ID, &a.VideoID, &a.Kind, &a.Name, &a.Path, &a.Variant, &option, &a.Version, &a.Status, &duration, &picked,
		&a.Source.Type, &a.Source.Label, &a.Source.ID, &a.Source.SessionID, &a.Source.RunID, &a.Source.ArtifactID, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return Artifact{}, err
	}
	if option != nil {
		n := int(*option)
		a.Option = &n
	}
	if duration != nil {
		n := int(*duration)
		a.Duration = &n
	}
	if a.Kind == "cover" {
		p := picked == 1
		a.Picked = &p
	}
	a.Reviews = []Review{}
	return a, nil
}

// loadArtifacts 查产出物并带上验收记录（按先后）。
func (h *handler) loadArtifacts(ctx context.Context, where string, args ...any) ([]Artifact, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+artifactCols+` FROM video_artifacts `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Artifact{}
	idx := map[string]int{}
	for rows.Next() {
		a, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		idx[a.ID] = len(out)
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	q, qargs := `SELECT artifact_id, version, ok, comment, at FROM video_artifact_reviews`, []any{}
	if len(out) == 1 {
		q, qargs = q+` WHERE artifact_id = ?`, []any{out[0].ID}
	} else if where != "" {
		q, qargs = q+` WHERE artifact_id IN (SELECT id FROM video_artifacts `+where+`)`, args
	}
	rrows, err := h.c.Store().Query(ctx, q+` ORDER BY id`, qargs...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rrows.Close() }()
	for rrows.Next() {
		var aid string
		var rv Review
		var ok int
		if err := rrows.Scan(&aid, &rv.Version, &ok, &rv.Comment, &rv.At); err != nil {
			return nil, err
		}
		if i, has := idx[aid]; has {
			rv.OK = ok == 1
			out[i].Reviews = append(out[i].Reviews, rv)
		}
	}
	return out, rrows.Err()
}

func (h *handler) getArtifact(ctx context.Context, id string) (Artifact, error) {
	xs, err := h.loadArtifacts(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Artifact{}, err
	}
	if len(xs) == 0 {
		return Artifact{}, apiErr(errNotFound, "产出物不存在")
	}
	return xs[0], nil
}

func (h *handler) listArtifacts(w http.ResponseWriter, r *http.Request) {
	var conds []string
	var args []any
	q := r.URL.Query()
	for _, f := range []struct{ param, col string }{
		{"video_id", "video_id"}, {"kind", "kind"}, {"variant", "variant"}, {"status", "status"},
		{"source_type", "source_type"}, {"run_id", "run_id"}, {"session_id", "session_id"},
	} {
		if s := q.Get(f.param); s != "" {
			conds, args = append(conds, f.col+" = ?"), append(args, s)
		}
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	out, err := h.loadArtifacts(r.Context(), where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showArtifact(w http.ResponseWriter, r *http.Request) {
	a, err := h.getArtifact(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": a})
}

// cleanRelPath 把路径规整成相对视频工程目录的形式；绝对路径、带盘符、越出工程目录的 400。
// 结尾的 / 保留（原型用 audio/ 表示目录）。
func cleanRelPath(s string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", apiErr(errValidation, "路径必填")
	case len([]rune(s)) > 1000:
		return "", apiErr(errValidation, "路径最多 1000 字")
	case strings.ContainsAny(s, "\\\x00"):
		return "", apiErr(errValidation, "路径用 / 分隔，不能有反斜杠")
	case strings.HasPrefix(s, "/") || strings.HasPrefix(s, "~") || strings.Contains(s, "://") || driveRe.MatchString(s):
		return "", apiErr(errValidation, "路径要相对视频工程目录写，不能是绝对路径")
	}
	dir := strings.HasSuffix(s, "/")
	c := path.Clean(s)
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", apiErr(errValidation, "路径越出了视频工程目录")
	}
	if c == "." {
		return "", apiErr(errValidation, "路径不能是工程目录本身")
	}
	if dir {
		c += "/"
	}
	return c, nil
}

var (
	driveRe = regexp.MustCompile(`^[A-Za-z]:`)
	refIDRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,100}$`)
)

// parseSource 认 {type, label?, id?, session_id?, run_id?, artifact_id?}。
// Agent 产出要带运行或会话 id，SOP 产出要带运行 id，手动登记的不带出处。
func parseSource(b json.RawMessage) (ArtifactSource, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil || raw == nil {
		return ArtifactSource{}, apiErr(errValidation, "source 必须是对象")
	}
	keys := []string{"type", "label", "id", "session_id", "run_id", "artifact_id"}
	for k := range raw {
		if !slices.Contains(keys, k) {
			return ArtifactSource{}, apiErr(errValidation, "source 里不认识的字段 %s", k)
		}
	}
	var s ArtifactSource
	if err := enumField(raw, "type", "source.type", &s.Type, SourceTypes); err != nil {
		return s, err
	}
	if s.Type == "" {
		return s, apiErr(errValidation, "source.type 必填")
	}
	if err := strField(raw, "label", "source.label", &s.Label, 100); err != nil {
		return s, err
	}
	if err := strField(raw, "id", "source.id", &s.ID, 100); err != nil {
		return s, err
	}
	for _, f := range []struct {
		key string
		dst *string
	}{{"session_id", &s.SessionID}, {"run_id", &s.RunID}, {"artifact_id", &s.ArtifactID}} {
		if err := strField(raw, f.key, "source."+f.key, f.dst, 100); err != nil {
			return s, err
		}
		if *f.dst != "" && !refIDRe.MatchString(*f.dst) {
			return s, apiErr(errValidation, "source.%s 只能有字母、数字和 . _ : -", f.key)
		}
	}
	switch s.Type {
	case "manual":
		if s.ID != "" || s.SessionID != "" || s.RunID != "" || s.ArtifactID != "" {
			return s, apiErr(errValidation, "手动登记的不带 Agent、SOP 的出处，来源要写成 agent、sop 或 skill")
		}
	case "agent":
		if s.RunID == "" && s.SessionID == "" {
			return s, apiErr(errValidation, "Agent 的产出要带 run_id 或 session_id，才能追到是哪次运行")
		}
	case "sop":
		if s.RunID == "" {
			return s, apiErr(errValidation, "SOP 的产出要带 run_id，才能追到是哪次执行")
		}
	}
	if s.Label == "" {
		s.Label = s.ID
	}
	if s.Label == "" {
		s.Label = SourceLabels[s.Type]
	}
	return s, nil
}

// applyArtifact 把 body 里传了的可改字段写进 a，再按类型校验整条。
func applyArtifact(a *Artifact, raw map[string]json.RawMessage) error {
	if err := strField(raw, "name", "名称", &a.Name, 200); err != nil {
		return err
	}
	if b, ok := raw["path"]; ok {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return apiErr(errValidation, "路径必须是字符串")
		}
		p, err := cleanRelPath(s)
		if err != nil {
			return err
		}
		a.Path = p
	}
	if b, ok := raw["variant"]; ok {
		if isNull(b) || strings.TrimSpace(string(b)) == `""` {
			a.Variant = ""
		} else if err := enumField(raw, "variant", "variant", &a.Variant, Orients); err != nil {
			return err
		}
	}
	if err := enumField(raw, "status", "status", &a.Status, ArtifactStatuses); err != nil {
		return err
	}
	for _, f := range []struct {
		key, label string
		dst        **int
		hi         int
	}{{"option", "方案序号", &a.Option, 99}, {"duration", "时长", &a.Duration, 86400}} {
		b, ok := raw[f.key]
		if !ok {
			continue
		}
		if isNull(b) {
			*f.dst = nil
			continue
		}
		lo := 0
		if f.key == "option" {
			lo = 1
		}
		var n int
		if err := intField(raw, f.key, f.label, &n, lo, f.hi); err != nil {
			return err
		}
		*f.dst = &n
	}
	if b, ok := raw["picked"]; ok {
		var p bool
		if !isNull(b) {
			if err := json.Unmarshal(b, &p); err != nil {
				return apiErr(errValidation, "picked 必须是布尔值")
			}
		}
		a.Picked = &p
	}
	k, _ := artifactKind(a.Kind)
	switch {
	case k.PerVariant && a.Variant == "":
		return apiErr(errValidation, "%s按画面比例区分，要选 variant", k.Label)
	case !k.PerVariant && a.Variant != "":
		return apiErr(errValidation, "%s不分画面比例，不能带 variant", k.Label)
	case a.Kind != "cover" && a.Option != nil:
		return apiErr(errValidation, "只有封面有方案序号")
	case a.Kind != "audio" && a.Kind != "video" && a.Duration != nil:
		return apiErr(errValidation, "只有音频、视频有时长")
	case a.Kind != "cover" && a.Picked != nil && *a.Picked:
		return apiErr(errValidation, "只有封面能选用")
	case a.Path == "":
		return apiErr(errValidation, "路径必填")
	}
	if a.Kind != "cover" {
		a.Picked = nil
	} else if a.Picked == nil {
		f := false
		a.Picked = &f
	}
	if a.Name == "" {
		a.Name = k.Label
		if a.Option != nil {
			a.Name = k.Label + " " + strconv.Itoa(*a.Option)
		}
	}
	return nil
}

func pickedCol(a Artifact) int {
	if a.Picked != nil && *a.Picked {
		return 1
	}
	return 0
}

// checkSlot 看同组的方案序号是不是被别的占了，并在选用这张时先取消同组其余的。
func (h *handler) checkSlot(ctx context.Context, a Artifact) error {
	if a.Option != nil {
		var n int
		if err := h.c.Store().QueryRow(ctx, `SELECT count(*) FROM video_artifacts WHERE video_id = ? AND kind = ? AND variant = ? AND option_no = ? AND id <> ?`,
			a.VideoID, a.Kind, a.Variant, *a.Option, a.ID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return apiErr(errConflict, "这个比例的第 %d 个方案已经登记过了，换一个序号或者改那一条", *a.Option)
		}
	}
	if pickedCol(a) == 1 {
		if _, err := h.c.Store().Exec(ctx, `UPDATE video_artifacts SET picked = 0, updated_at = ? WHERE video_id = ? AND kind = ? AND variant = ? AND picked = 1 AND id <> ?`,
			nowStr(), a.VideoID, a.Kind, a.Variant, a.ID); err != nil {
			return err
		}
	}
	return nil
}

// uniqueErr 把并发撞上唯一索引的写入转成 409。
func uniqueErr(err error) error {
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return apiErr(errConflict, "刚被别处改过，刷新后再操作")
	}
	return err
}

// touchVideo 改了产出物，视频的更新时间跟着刷新（同原型 SPEC-videos-12.3）。
func (h *handler) touchVideo(ctx context.Context, videoID string) error {
	_, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET updated_at = ? WHERE id = ?`, nowStr(), videoID)
	return err
}

func (h *handler) addArtifact(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, append(artifactFields, "video_id", "kind", "version", "source")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a := Artifact{Version: 1, Status: "draft", Source: ArtifactSource{Type: "manual", Label: SourceLabels["manual"]}}
	if err := strField(raw, "video_id", "video_id", &a.VideoID, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if a.VideoID == "" {
		fail(w, r, h.c, apiErr(errValidation, "video_id 必填"))
		return
	}
	if _, err := h.getVideo(ctx, a.VideoID); errors.Is(err, errNotFound) {
		fail(w, r, h.c, apiErr(errValidation, "视频不存在"))
		return
	} else if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := strField(raw, "kind", "kind", &a.Kind, 40); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, ok := artifactKind(a.Kind); !ok {
		keys := make([]string, 0, len(ArtifactKinds))
		for _, k := range ArtifactKinds {
			keys = append(keys, k.Key)
		}
		fail(w, r, h.c, apiErr(errValidation, "kind 只能是 %s", strings.Join(keys, "、")))
		return
	}
	if err := intField(raw, "version", "版本", &a.Version, 1, 9999); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if b, ok := raw["source"]; ok && !isNull(b) {
		s, err := parseSource(b)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		a.Source = s
	}
	if _, ok := raw["path"]; !ok {
		fail(w, r, h.c, apiErr(errValidation, "路径必填"))
		return
	}
	if err := applyArtifact(&a, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	a.ID = idgen.Prefixed("vaf")
	if err := h.checkSlot(ctx, a); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_artifacts (`+artifactCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.VideoID, a.Kind, a.Name, a.Path, a.Variant, a.Option, a.Version, a.Status, a.Duration, pickedCol(a),
		a.Source.Type, a.Source.Label, a.Source.ID, a.Source.SessionID, a.Source.RunID, a.Source.ArtifactID, now, now); err != nil {
		fail(w, r, h.c, uniqueErr(err))
		return
	}
	h.respondArtifact(w, r, http.StatusCreated, a)
}

// respondArtifact 刷新视频的更新时间，读回产出物写回。
func (h *handler) respondArtifact(w http.ResponseWriter, r *http.Request, status int, a Artifact) {
	ctx := r.Context()
	if err := h.touchVideo(ctx, a.VideoID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getArtifact(ctx, a.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": out})
}

func (h *handler) updateArtifact(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, append(artifactFields, "video_id", "kind", "version", "source", "reviews")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	for _, f := range []struct{ key, msg string }{
		{"video_id", "产出物不能换视频，删掉重新登记"},
		{"kind", "产出物不能换类型，删掉重新登记"},
		{"version", "版本号用升版本接口加一，不能直接改"},
		{"source", "来源是登记时定的，不能改"},
		{"reviews", "验收记录用验收接口追加，不能直接改"},
	} {
		if _, ok := raw[f.key]; ok {
			fail(w, r, h.c, apiErr(errValidation, "%s", f.msg))
			return
		}
	}
	if err := applyArtifact(&a, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.checkSlot(ctx, a); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_artifacts SET name = ?, path = ?, variant = ?, option_no = ?, status = ?, duration = ?, picked = ?,
		updated_at = ? WHERE id = ?`, a.Name, a.Path, a.Variant, a.Option, a.Status, a.Duration, pickedCol(a), nowStr(), a.ID); err != nil {
		fail(w, r, h.c, uniqueErr(err))
		return
	}
	h.respondArtifact(w, r, http.StatusOK, a)
}

// removeArtifact：验收记录随外键一起删；发布记录里用了它当封面的清掉 cover_id。只删记录，文件不动。
func (h *handler) removeArtifact(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_publishes SET cover_id = '', updated_at = ? WHERE cover_id = ?`, nowStr(), a.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_artifacts WHERE id = ?`, a.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.touchVideo(ctx, a.VideoID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// review：追加一条验收记录（同原型 ArtifactDrawer 的 review）。
// 通过没写意见存「通过」，状态变已定稿（已发布的保持）；退回必须写意见，状态回到草稿。
func (h *handler) review(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "ok", "comment")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	b, has := raw["ok"]
	var ok bool
	if !has || json.Unmarshal(b, &ok) != nil {
		fail(w, r, h.c, apiErr(errValidation, "ok 必填，true 是通过，false 是退回"))
		return
	}
	var comment string
	if err := strField(raw, "comment", "意见", &comment, 2000); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if !ok && comment == "" {
		fail(w, r, h.c, apiErr(errValidation, "退回要写意见"))
		return
	}
	status := "draft"
	if ok {
		if comment == "" {
			comment = "通过"
		}
		status = "final"
		if a.Status == "published" {
			status = "published"
		}
	}
	now := nowStr()
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_artifact_reviews (artifact_id, version, ok, comment, at) VALUES (?, ?, ?, ?, ?)`,
		a.ID, a.Version, ok, comment, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_artifacts SET status = ?, updated_at = ? WHERE id = ?`, status, now, a.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.respondArtifact(w, r, http.StatusOK, a)
}

// bump：升版本，版本号加一、状态回到草稿，验收记录都留着（带着各自的版本号）。
// from 给了就要和当前版本一致，防止重复点。
func (h *handler) bump(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "from")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	from := a.Version
	if err := intField(raw, "from", "from", &from, 1, 9999); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if from != a.Version {
		fail(w, r, h.c, apiErr(errConflict, "已经是第 %d 版了，刷新后再操作", a.Version))
		return
	}
	if a.Version >= 9999 {
		fail(w, r, h.c, apiErr(errConflict, "版本号到头了"))
		return
	}
	res, err := h.c.Store().Exec(ctx, `UPDATE video_artifacts SET version = version + 1, status = 'draft', updated_at = ? WHERE id = ? AND version = ?`,
		nowStr(), a.ID, a.Version)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, h.c, apiErr(errConflict, "刚被别处升过版本，刷新后再操作"))
		return
	}
	h.respondArtifact(w, r, http.StatusOK, a)
}
