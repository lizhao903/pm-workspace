// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 今日卡片（VID-07a，video-creator-analysis.md P0-1）：待验收、24 小时内定时、发布失败。
// 数据和视频接口同一份：视频走 loadVideos，产出物走 loadArtifacts，发布记录走 scanPublish。
// 每条带 link，是前端路由（/videos/v/<id> 起），前端点了直接跳。

// todayCardMax 是每张卡片最多返回几条，同内核的 TodayCardLimit
const todayCardMax = 50

// todayScheduledWithin 是「待发布」卡片看多远：定时在这之内的，已过点还没发出去的也算
const todayScheduledWithin = 24 * time.Hour

func (h *handler) registerToday(r plugin.Registrar) {
	r.TodayCard(plugin.TodayCardDef{Key: "video_waiting", Title: "视频待验收", Order: 60, Load: h.waitingCard})
	r.TodayCard(plugin.TodayCardDef{Key: "video_scheduled", Title: "视频待发布", Order: 61, Load: h.scheduledCard})
	r.TodayCard(plugin.TodayCardDef{Key: "video_failed", Title: "视频发布失败", Order: 62, Load: h.failedCard})
}

// TodayWaiting 是「视频待验收」的一条：kind 是 checkpoint（当前阶段的检查点待验收或被退回）或 artifact（待验收的产出物）。
type TodayWaiting struct {
	Kind         string `json:"kind"`
	VideoID      string `json:"video_id"`
	VideoTitle   string `json:"video_title"`
	Stage        string `json:"stage,omitempty"`
	StageLabel   string `json:"stage_label,omitempty"`
	State        string `json:"state,omitempty"`
	Note         string `json:"note,omitempty"`
	ArtifactID   string `json:"artifact_id,omitempty"`
	ArtifactName string `json:"artifact_name,omitempty"`
	ArtifactKind string `json:"artifact_kind,omitempty"`
	Version      int    `json:"version,omitempty"`
	Label        string `json:"label"`
	At           string `json:"at"`
	Link         string `json:"link"`
}

// TodayPublish 是「视频待发布」「视频发布失败」的一条，字段取自发布记录。
type TodayPublish struct {
	ID            string  `json:"id"`
	VideoID       string  `json:"video_id"`
	VideoTitle    string  `json:"video_title"`
	Platform      string  `json:"platform"`
	PlatformLabel string  `json:"platform_label"`
	Variant       string  `json:"variant"`
	Title         string  `json:"title"`
	Status        string  `json:"status"`
	ScheduledAt   *string `json:"scheduled_at,omitempty"`
	Error         string  `json:"error,omitempty"`
	At            string  `json:"at"`
	Link          string  `json:"link"`
}

func videoLink(id string) string { return "/videos/v/" + id }

// waitingCheckpoint 同原型 videoState 的 warn：停在带检查点的阶段，检查点 pending 或 rejected。
// 分发包检查通过就是已完成，不在这里。
func waitingCheckpoint(v Video) (Checkpoint, bool) {
	i := stageIndex(v.Stage)
	if i < 0 || !Stages[i].Checkpoint {
		return Checkpoint{}, false
	}
	cp := v.checkpoint(v.Stage)
	return cp, cp.State == "pending" || cp.State == "rejected"
}

func (h *handler) waitingCard(ctx context.Context, _ plugin.Core) (*plugin.TodayCardData, error) {
	vs, err := h.loadVideos(ctx, "")
	if err != nil {
		return nil, err
	}
	titles := map[string]string{}
	var items []TodayWaiting
	for _, v := range vs {
		titles[v.ID] = v.Title
		cp, ok := waitingCheckpoint(v)
		if !ok {
			continue
		}
		label := Stages[stageIndex(v.Stage)].Label
		it := TodayWaiting{Kind: "checkpoint", VideoID: v.ID, VideoTitle: v.Title, Stage: v.Stage, StageLabel: label,
			State: cp.State, Note: cp.Note, Label: "待" + label, At: v.UpdatedAt, Link: videoLink(v.ID)}
		if cp.State == "rejected" {
			it.Label = "退回修改"
			if cp.At != "" {
				it.At = cp.At
			}
		}
		items = append(items, it)
	}
	arts, err := h.loadArtifacts(ctx, `WHERE status = 'review'`)
	if err != nil {
		return nil, err
	}
	for _, a := range arts {
		t, ok := titles[a.VideoID]
		if !ok {
			continue
		}
		items = append(items, TodayWaiting{Kind: "artifact", VideoID: a.VideoID, VideoTitle: t, ArtifactID: a.ID, ArtifactName: a.Name,
			ArtifactKind: a.Kind, Version: a.Version, Label: kindLabel(a.Kind) + "待验收", At: a.UpdatedAt,
			Link: videoLink(a.VideoID) + "/artifacts?a=" + a.ID})
	}
	if len(items) == 0 {
		return nil, nil
	}
	// 最近有动静的在前
	slices.SortStableFunc(items, func(x, y TodayWaiting) int { return strings.Compare(y.At, x.At) })
	return &plugin.TodayCardData{Total: len(items), Items: items[:min(len(items), todayCardMax)]}, nil
}

func (h *handler) scheduledCard(ctx context.Context, _ plugin.Core) (*plugin.TodayCardData, error) {
	until := time.Now().Add(todayScheduledWithin).UTC().Format(time.RFC3339)
	// 定时早的在前
	return h.publishCard(ctx, `status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at, rowid`, until)
}

func (h *handler) failedCard(ctx context.Context, _ plugin.Core) (*plugin.TodayCardData, error) {
	// 最近失败的在前
	return h.publishCard(ctx, `status = 'failed' ORDER BY updated_at DESC, rowid DESC`)
}

// publishCard 按条件取发布记录，配上视频标题。视频已删的发布记录跟着级联删了，这里不会落单。
func (h *handler) publishCard(ctx context.Context, cond string, args ...any) (*plugin.TodayCardData, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE `+cond, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ps []Publish
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			return nil, err
		}
		ps = append(ps, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ps) == 0 {
		return nil, nil
	}
	titles, err := h.videoTitles(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]TodayPublish, 0, min(len(ps), todayCardMax))
	for _, p := range ps[:min(len(ps), todayCardMax)] {
		items = append(items, TodayPublish{ID: p.ID, VideoID: p.VideoID, VideoTitle: titles[p.VideoID], Platform: p.Platform,
			PlatformLabel: PlatformLabels[p.Platform], Variant: p.Variant, Title: p.Title, Status: p.Status, ScheduledAt: p.ScheduledAt,
			Error: p.Error, At: p.UpdatedAt, Link: videoLink(p.VideoID) + "?p=" + p.ID})
	}
	return &plugin.TodayCardData{Total: len(ps), Items: items}, nil
}

func (h *handler) videoTitles(ctx context.Context) (map[string]string, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT id, title FROM video_videos`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var id, t string
		if err := rows.Scan(&id, &t); err != nil {
			return nil, err
		}
		out[id] = t
	}
	return out, rows.Err()
}
