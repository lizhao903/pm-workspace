package video

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 数据按天快照（VID-05a）：表 video_metric_snapshots，同原型 MetricSnapshot。
// 回填（PATCH 带 metrics）记一条 manual，拉取（sync、后台任务 metrics_daily）记一条 connector，都是追加，不覆盖；
// 发布记录的 metrics 是最新一条。后台任务每小时看一遍，已发布、有稿件链接、平台能拉数据的，当天还没拉过才拉。

// SnapshotSources 同原型 MetricSnapshot.source。
var SnapshotSources = []string{"manual", "connector"}

// MetricSnapshot 同原型 MetricSnapshot，多 created_at（落库时间；updated_at 是数据本身的时间）。
type MetricSnapshot struct {
	Metrics
	PublishID string `json:"publish_id"`
	Day       int    `json:"day"`
	Source    string `json:"source"`
	CreatedAt string `json:"created_at"`
}

// metricsEvery 是后台任务看一遍的间隔，同一条发布一天只拉一次。
var metricsEvery = time.Hour

// dayAfter 同原型 dayAfter：发布后第几天，满一天算 1，不足一天也算 1；没有发布时间按数据时间算（第 1 天）。
func dayAfter(publishedAt *string, at string) int {
	from := at
	if publishedAt != nil {
		from = *publishedAt
	}
	d := int(math.Floor(parseTime(at).Sub(parseTime(from)).Hours() / 24))
	return max(1, d)
}

const snapshotCols = `publish_id, day, source, views, likes, comments, shares, impressions, ctr, avg_watch_sec, completion,
	favorites, coins, followers_gained, updated_at, created_at`

func scanSnapshot(row plugin.Row) (MetricSnapshot, error) {
	var s MetricSnapshot
	var imp, fav, coins, fol *int64
	if err := row.Scan(&s.PublishID, &s.Day, &s.Source, &s.Views, &s.Likes, &s.Comments, &s.Shares, &imp, &s.CTR, &s.AvgWatchSec, &s.Completion,
		&fav, &coins, &fol, &s.UpdatedAt, &s.CreatedAt); err != nil {
		return MetricSnapshot{}, err
	}
	s.Impressions, s.Favorites, s.Coins, s.FollowersGained = intPtr(imp), intPtr(fav), intPtr(coins), intPtr(fol)
	return s, nil
}

func intPtr(v *int64) *int {
	if v == nil {
		return nil
	}
	n := int(*v)
	return &n
}

// addSnapshot 给发布记录追加一条快照，day 按发布时间和数据时间算。
func (h *handler) addSnapshot(ctx context.Context, p Publish, m Metrics, source string) error {
	_, err := h.c.Store().Exec(ctx, `INSERT INTO video_metric_snapshots (`+snapshotCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, dayAfter(p.PublishedAt, m.UpdatedAt), source, m.Views, m.Likes, m.Comments, m.Shares, m.Impressions, m.CTR, m.AvgWatchSec, m.Completion,
		m.Favorites, m.Coins, m.FollowersGained, m.UpdatedAt, nowStr())
	if err != nil {
		return err
	}
	// 快照落库后重算挂着这条发布的封面测试（VID-05b）
	h.evaluateCoverTestsFor(ctx, p.ID)
	return nil
}

func (h *handler) snapshotsOf(ctx context.Context, publishID string) ([]MetricSnapshot, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+snapshotCols+` FROM video_metric_snapshots WHERE publish_id = ? ORDER BY day, updated_at, rowid`, publishID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []MetricSnapshot{}
	for rows.Next() {
		s, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// lastPerDay 同原型 lastPerDay：同一天有几条时取最后一条，按天排。
func lastPerDay(xs []MetricSnapshot) []MetricSnapshot {
	out := []MetricSnapshot{}
	for _, s := range xs {
		if n := len(out); n > 0 && out[n-1].Day == s.Day {
			out[n-1] = s
		} else {
			out = append(out, s)
		}
	}
	return out
}

// listSnapshots 是 GET /api/video/publishes/{id}/snapshots：全部快照按天、按先后排，meta.days 是按天曲线（每天最后一条）。
func (h *handler) listSnapshots(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := h.getPublish(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	xs, err := h.snapshotsOf(ctx, p.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": xs, "meta": map[string]any{"total": len(xs), "days": lastPerDay(xs)}})
}

// metricsFromStats 把平台数据换成 metrics：平台不给的留空。
func metricsFromStats(a PlatformAdapter, st RemoteStats, at string) Metrics {
	m := Metrics{Views: st.Views, Likes: st.Likes, Comments: st.Comments, Shares: st.Shares, UpdatedAt: at,
		Impressions: st.Impressions, CTR: st.CTR, AvgWatchSec: st.AvgWatchSec, Completion: st.Completion, FollowersGained: st.FollowersGained}
	if sk, ok := a.(StatsKeys); ok {
		keys := sk.StatsKeys()
		if slices.Contains(keys, "favorites") {
			n := st.Favorites
			m.Favorites = &n
		}
		if slices.Contains(keys, "coins") {
			n := st.Coins
			m.Coins = &n
		}
	}
	return m
}

// metricsJob 是后台任务 metrics_daily 的一轮：逐条拉当天还没拉过的，单条出错只记日志，接着拉下一条。
func (h *handler) metricsJob(ctx context.Context, _ plugin.Core) error {
	now := nowStr()
	rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE url != '' AND status IN ('published', 'scheduled')
		ORDER BY created_at, rowid`)
	if err != nil {
		return err
	}
	var due []Publish
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			_ = rows.Close()
			return err
		}
		if a := h.platforms[p.Platform]; hasCap(a, CapMetrics) && (p.Status == "published" || p.ScheduledAt != nil && !parseTime(*p.ScheduledAt).After(parseTime(now))) {
			due = append(due, p)
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range due {
		if ctx.Err() != nil {
			return nil
		}
		var n int
		if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_metric_snapshots WHERE publish_id = ? AND source = 'connector' AND day = ?`,
			p.ID, dayAfter(p.PublishedAt, now)).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if _, err := h.syncOne(ctx, p, ""); err != nil && ctx.Err() == nil {
			h.c.Log().Warn("pull publish metrics", "publish", p.ID, "err", err)
		}
	}
	return nil
}

func encodeTags(tags []string) string {
	if tags == nil {
		tags = []string{}
	}
	b, _ := json.Marshal(tags)
	return string(b)
}
