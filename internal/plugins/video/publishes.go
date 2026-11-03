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

// 发布记录：表 video_publishes，接口 /api/video/publishes。经连接器投稿、拉数据见 remote.go（VID-04b）。
// 选了封面的按平台收的封面比例校验（VID-02a，平台表见 data.go 的 PlatformCovers）。
// VID-05a：挂平台账号、存标签分区合集；每次新建、修改按平台规则算 checks（rules.go），不过的不能切到 scheduled；
// 回填 metrics 时追加一条 manual 快照（snapshots.go）。

const publishCols = `id, video_id, platform, variant, cover_id, title, description, status, scheduled_at, published_at,
	url, error, metrics, account_id, tag_list, category, collection, checks, created_at, updated_at`

// checks 由后端按平台规则算，请求里带了不报错、也不用
var publishFields = []string{"platform", "variant", "cover_id", "title", "desc", "status", "scheduled_at", "published_at", "url", "error", "metrics",
	"account_id", "tags", "category", "collection", "checks"}

func scanPublish(row plugin.Row) (Publish, error) {
	var p Publish
	var metrics, checks *string
	var tags string
	if err := row.Scan(&p.ID, &p.VideoID, &p.Platform, &p.Variant, &p.CoverID, &p.Title, &p.Desc, &p.Status, &p.ScheduledAt, &p.PublishedAt,
		&p.URL, &p.Error, &metrics, &p.AccountID, &tags, &p.Category, &p.Collection, &checks, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return Publish{}, err
	}
	if json.Unmarshal([]byte(tags), &p.Tags) != nil || len(p.Tags) == 0 {
		p.Tags = nil
	}
	if checks != nil && json.Unmarshal([]byte(*checks), &p.Checks) != nil {
		p.Checks = nil
	}
	if metrics != nil {
		var m Metrics
		if json.Unmarshal([]byte(*metrics), &m) == nil {
			p.Metrics = &m
		}
	}
	return p, nil
}

func (h *handler) getPublish(ctx context.Context, id string) (Publish, error) {
	p, err := scanPublish(h.c.Store().QueryRow(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE id = ?`, id))
	if errors.Is(err, plugin.ErrNoRows) {
		return Publish{}, apiErr(errNotFound, "发布记录不存在")
	}
	return p, err
}

func (h *handler) listPublishes(w http.ResponseWriter, r *http.Request) {
	q, args := `SELECT `+publishCols+` FROM video_publishes`, []any{}
	if s := r.URL.Query().Get("video_id"); s != "" {
		q, args = q+` WHERE video_id = ?`, append(args, s)
	}
	rows, err := h.c.Store().Query(r.Context(), q+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	defer func() { _ = rows.Close() }()
	out := []Publish{}
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

func (h *handler) showPublish(w http.ResponseWriter, r *http.Request) {
	p, err := h.getPublish(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": p})
}

func enumField(raw map[string]json.RawMessage, key, label string, dst *string, values []string) error {
	if _, ok := raw[key]; !ok {
		return nil
	}
	var s string
	if err := strField(raw, key, label, &s, 40); err != nil {
		return err
	}
	if !slices.Contains(values, s) {
		return apiErr(errValidation, "%s 只能是 %s", label, strings.Join(values, "、"))
	}
	*dst = s
	return nil
}

func applyPublish(p *Publish, raw map[string]json.RawMessage) error {
	if err := enumField(raw, "platform", "platform", &p.Platform, Platforms); err != nil {
		return err
	}
	if err := enumField(raw, "variant", "variant", &p.Variant, Orients); err != nil {
		return err
	}
	if err := enumField(raw, "status", "status", &p.Status, PublishStatuses); err != nil {
		return err
	}
	for _, f := range []struct {
		key, label string
		dst        *string
		limit      int
	}{
		{"cover_id", "cover_id", &p.CoverID, 100},
		{"title", "标题", &p.Title, 200},
		{"desc", "简介", &p.Desc, 5000},
		{"url", "链接", &p.URL, 2000},
		{"error", "错误", &p.Error, 2000},
		{"account_id", "account_id", &p.AccountID, 100},
		{"category", "分区", &p.Category, 100},
		{"collection", "合集", &p.Collection, 200},
	} {
		if b, ok := raw[f.key]; ok && isNull(b) {
			*f.dst = ""
			continue
		}
		if err := strField(raw, f.key, f.label, f.dst, f.limit); err != nil {
			return err
		}
	}
	if _, ok := raw["tags"]; ok {
		tags, err := stringList(raw, "tags", 50)
		if err != nil {
			return err
		}
		// 同原型去重，保留先后
		p.Tags = nil
		for _, t := range tags {
			if len([]rune(t)) > 50 {
				return apiErr(errValidation, "标签「%s」超过 50 字", t)
			}
			if !slices.Contains(p.Tags, t) {
				p.Tags = append(p.Tags, t)
			}
		}
	}
	if err := timeField(raw, "scheduled_at", "scheduled_at", &p.ScheduledAt); err != nil {
		return err
	}
	if err := timeField(raw, "published_at", "published_at", &p.PublishedAt); err != nil {
		return err
	}
	if b, ok := raw["metrics"]; ok {
		if isNull(b) {
			p.Metrics = nil
		} else {
			m, err := parseMetrics(b)
			if err != nil {
				return err
			}
			p.Metrics = m
		}
	}
	switch {
	case p.Platform == "":
		return apiErr(errValidation, "platform 必填")
	case p.Variant == "":
		return apiErr(errValidation, "variant 必填")
	case p.Title == "":
		return apiErr(errValidation, "标题必填")
	case p.URL != "" && !strings.HasPrefix(p.URL, "http://") && !strings.HasPrefix(p.URL, "https://"):
		return apiErr(errValidation, "链接要是 http:// 或 https:// 开头")
	case p.Status == "scheduled" && p.ScheduledAt == nil:
		return apiErr(errValidation, "已定时的要给 scheduled_at")
	}
	return nil
}

// metricsKeys 同原型 Metrics 的字段。
var metricsKeys = []string{"views", "likes", "comments", "shares", "impressions", "ctr", "avg_watch_sec", "completion", "favorites", "coins", "followers_gained", "updated_at"}

func parseMetrics(b json.RawMessage) (*Metrics, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil || raw == nil {
		return nil, apiErr(errValidation, "metrics 必须是对象或 null")
	}
	m := &Metrics{}
	for k := range raw {
		if !slices.Contains(metricsKeys, k) {
			return nil, apiErr(errValidation, "metrics 里不认识的字段 %s", k)
		}
	}
	for _, f := range []struct {
		key string
		dst *int
	}{{"views", &m.Views}, {"likes", &m.Likes}, {"comments", &m.Comments}, {"shares", &m.Shares}} {
		if err := intField(raw, f.key, "metrics."+f.key, f.dst, 0, 1<<53); err != nil {
			return nil, err
		}
	}
	// 扩展的几项平台不提供就不传或传 null；涨粉可以是负的
	for _, f := range []struct {
		key    string
		dst    **int
		lo, hi int
	}{{"impressions", &m.Impressions, 0, 1 << 53}, {"favorites", &m.Favorites, 0, 1 << 53}, {"coins", &m.Coins, 0, 1 << 53},
		{"followers_gained", &m.FollowersGained, -(1 << 53), 1 << 53}} {
		if v, ok := raw[f.key]; !ok || isNull(v) {
			continue
		}
		var n int
		if err := intField(raw, f.key, "metrics."+f.key, &n, f.lo, f.hi); err != nil {
			return nil, err
		}
		*f.dst = &n
	}
	for _, f := range []struct {
		key string
		dst **float64
		hi  float64
	}{{"ctr", &m.CTR, 1}, {"completion", &m.Completion, 1}, {"avg_watch_sec", &m.AvgWatchSec, 86400}} {
		v, ok := raw[f.key]
		if !ok || isNull(v) {
			continue
		}
		var x float64
		if err := json.Unmarshal(v, &x); err != nil || x < 0 || x > f.hi {
			return nil, apiErr(errValidation, "metrics.%s 要是 0 到 %g 之间的数", f.key, f.hi)
		}
		*f.dst = &x
	}
	var at *string
	if err := timeField(raw, "updated_at", "metrics.updated_at", &at); err != nil {
		return nil, err
	}
	if at == nil {
		return nil, apiErr(errValidation, "metrics.updated_at 必填")
	}
	m.UpdatedAt = *at
	return m, nil
}

func metricsCol(m *Metrics) any {
	if m == nil {
		return nil
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func (h *handler) addPublish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, append(publishFields, "video_id")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	p := Publish{Status: "planned"}
	if err := strField(raw, "video_id", "video_id", &p.VideoID, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.VideoID == "" {
		fail(w, r, h.c, apiErr(errValidation, "video_id 必填"))
		return
	}
	if _, err := h.getVideo(ctx, p.VideoID); errors.Is(err, errNotFound) {
		fail(w, r, h.c, apiErr(errValidation, "视频不存在"))
		return
	} else if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := applyPublish(&p, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.checkPublishCover(ctx, p); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.checkPublishAccount(ctx, p); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.applyChecks(ctx, &p); err != nil {
		fail(w, r, h.c, err)
		return
	}
	p.ID = idgen.Prefixed("pb")
	now := nowStr()
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_publishes (`+publishCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.VideoID, p.Platform, p.Variant, p.CoverID, p.Title, p.Desc, p.Status, p.ScheduledAt, p.PublishedAt,
		p.URL, p.Error, metricsCol(p.Metrics), p.AccountID, encodeTags(p.Tags), p.Category, p.Collection, checksCol(p.Checks), now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.Metrics != nil {
		if err := h.addSnapshot(ctx, p, *p.Metrics, "manual"); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	out, err := h.getPublish(ctx, p.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *handler) updatePublish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, append(publishFields, "video_id")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	p, err := h.getPublish(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, ok := raw["video_id"]; ok {
		var vid string
		if err := strField(raw, "video_id", "video_id", &vid, 100); err != nil || vid != p.VideoID {
			fail(w, r, h.c, apiErr(errValidation, "发布记录不能换视频，删掉重新登记"))
			return
		}
	}
	if err := applyPublish(&p, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 换了封面、平台或方向才重新校验封面，老记录不动的照旧能改别的字段
	_, c1 := raw["cover_id"]
	_, c2 := raw["platform"]
	_, c3 := raw["variant"]
	if c1 || c2 || c3 {
		if err := h.checkPublishCover(ctx, p); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if _, ok := raw["account_id"]; ok || c2 {
		if err := h.checkPublishAccount(ctx, p); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if err := h.applyChecks(ctx, &p); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_publishes SET platform = ?, variant = ?, cover_id = ?, title = ?, description = ?, status = ?,
		scheduled_at = ?, published_at = ?, url = ?, error = ?, metrics = ?, account_id = ?, tag_list = ?, category = ?, collection = ?, checks = ?,
		updated_at = ? WHERE id = ?`,
		p.Platform, p.Variant, p.CoverID, p.Title, p.Desc, p.Status, p.ScheduledAt, p.PublishedAt, p.URL, p.Error, metricsCol(p.Metrics),
		p.AccountID, encodeTags(p.Tags), p.Category, p.Collection, checksCol(p.Checks), nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 回填一次追加一条快照，不覆盖之前的
	if b, ok := raw["metrics"]; ok && !isNull(b) {
		if err := h.addSnapshot(ctx, p, *p.Metrics, "manual"); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	out, err := h.getPublish(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// applyChecks 按平台规则算 checks 存在发布记录上；有一项不过的不能是「已定时」。
func (h *handler) applyChecks(ctx context.Context, p *Publish) error {
	cs, err := h.publishChecks(ctx, *p)
	if err != nil {
		return err
	}
	p.Checks = cs
	if bad := firstFailed(cs); bad != "" && p.Status == "scheduled" {
		return apiErr(errValidation, "发布前校验没通过，不能定时：%s", bad)
	}
	return nil
}

func checksCol(cs []PublishCheck) any {
	if cs == nil {
		return nil
	}
	b, _ := json.Marshal(cs)
	return string(b)
}

// checkPublishCover：选了封面的，封面要存在，并且对得上这条发布的视频、方向和平台要的比例（coverFits）。
func (h *handler) checkPublishCover(ctx context.Context, p Publish) error {
	if p.CoverID == "" {
		return nil
	}
	a, err := h.getArtifact(ctx, p.CoverID)
	if errors.Is(err, errNotFound) {
		return apiErr(errValidation, "封面 %s 不存在", p.CoverID)
	} else if err != nil {
		return err
	}
	return coverFits(a, p.VideoID, p.Platform, p.Variant)
}

func (h *handler) removePublish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getPublish(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_publishes WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}
