package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 定时发布和内容日历（VID-06c）。
// 定时发布：发布记录 status = scheduled、scheduled_at 到点、还没有稿件链接的，由常驻后台任务 publish_due 投稿
// （同 POST .../submit，走 submitOne）。定时就存在发布记录上，所以改时间、删发布不用另外同步。
// 内核的定时任务插件拿不到写句柄，这里登记定时任务动作 video_publish（参数 publish_id），用户在定时任务页建的
// 由调度器交过来，放进同一个队列；SOP 节点 video_publish 当场投稿。
// 投不成（平台报错、没有成片、平台不能自动投稿）的发布记录置为 failed、写上原因，并发一条通知。
// 内容日历 GET /api/video/calendar：按月、周或起止日返回发布和计划首发日，同原型 calendarItems；
// 离首发日不到 LateDays 天、第一章验收还没过的标 behind（同原型 isBehind）。日期按服务所在时区的本地日期算。

const (
	ActionPublish = "video_publish" // 定时任务动作
	NodePublish   = "video_publish" // SOP 节点
	// LateDays 同原型 LATE_DAYS
	LateDays = 7
)

// publishDueEvery 是多久看一次到点的发布；测试里调小。
var publishDueEvery = 30 * time.Second

func (h *handler) registerSchedule(r plugin.Registrar) {
	h.fire = make(chan string, 64)
	r.ScheduleAction(plugin.ScheduleActionDef{Kind: ActionPublish, Validate: h.validatePublishAction, Run: h.runPublishAction})
	r.SOPNode(plugin.SOPNodeDef{Kind: NodePublish, Group: "视频",
		Required: []plugin.SOPNodeField{{Key: "publish", Label: "发布记录"}},
		Run:      h.publishNode})
	r.Job(plugin.Job{Name: "publish_due", Run: h.publishLoop})
}

// dateField 认 YYYY-MM-DD；null 或空串清掉。
func dateField(raw map[string]json.RawMessage, key, label string, dst **string) error {
	v, ok := raw[key]
	if !ok {
		return nil
	}
	if isNull(v) {
		*dst = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return apiErr(errValidation, "%s 必须是日期字符串", label)
	}
	if s = strings.TrimSpace(s); s == "" {
		*dst = nil
		return nil
	}
	if _, err := time.Parse(time.DateOnly, s); err != nil {
		return apiErr(errValidation, "%s 要写成 YYYY-MM-DD", label)
	}
	*dst = &s
	return nil
}

/* ---------- 到点发布 ---------- */

// publishLoop 常驻：每 publishDueEvery 看一次到点的发布，定时任务动作交过来的随到随发。
func (h *handler) publishLoop(ctx context.Context, c plugin.Core) error {
	t := time.NewTicker(publishDueEvery)
	defer t.Stop()
	for {
		if err := h.publishDue(ctx); err != nil && ctx.Err() == nil {
			c.Log().Error("video publish due", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case id := <-h.fire:
			if _, err := h.firePublish(ctx, id, "定时任务"); err != nil && ctx.Err() == nil {
				c.Log().Warn("video publish from schedule", "publish", id, "err", err)
			}
		case <-t.C:
		}
	}
}

// publishDue 投到点的定时发布，一条一条来。
func (h *handler) publishDue(ctx context.Context) error {
	rows, err := h.c.Store().Query(ctx, `SELECT id FROM video_publishes WHERE status = 'scheduled' AND url = ''
		AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at, rowid`, nowStr())
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := h.firePublish(ctx, id, "定时发布"); err != nil && ctx.Err() == nil {
			h.c.Log().Warn("video scheduled publish failed", "publish", id, "err", err)
		}
	}
	return nil
}

// errBusy：这条发布正在投稿，这次不动它。
var errBusy = errors.New("这条发布正在投稿")

// firePublish 投一条发布，by 是谁发起的（写进通知标题）。已经有稿件的直接回；投不成的置为 failed、写原因、发通知。
func (h *handler) firePublish(ctx context.Context, id, by string) (Publish, error) {
	p, err := h.getPublish(ctx, id)
	if err != nil {
		return p, plainErr(err)
	}
	if p.Status == "published" || p.URL != "" {
		return p, nil
	}
	if _, busy := h.submitting.Load(id); busy {
		return p, errBusy
	}
	in := PublishInput{Title: p.Title, Desc: p.Desc, Tags: p.Tags, Category: p.Category, Collection: p.Collection}
	out, _, _, err := h.submitOne(ctx, p, "", "", in)
	if err == nil {
		return out, nil
	}
	if ctx.Err() != nil {
		return p, err
	}
	var ue *upstreamErr
	msg := ""
	if errors.As(err, &ue) {
		// 平台报错的 submitOne 已经记了 failed
		msg = ue.err.Error()
	} else {
		msg = plainErr(err).Error()
		if errors.Is(err, errUnsupported) {
			msg += "；到点了，请用发布包手动发布后回填链接"
		}
		if errors.Is(err, errConflict) && strings.Contains(msg, "正在投稿") {
			return p, errBusy
		}
		wctx := context.WithoutCancel(ctx)
		if _, uerr := h.c.Store().Exec(wctx, `UPDATE video_publishes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
			clipText(msg, 2000), nowStr(), id); uerr != nil {
			return p, uerr
		}
	}
	h.notifyFailed(context.WithoutCancel(ctx), p, by, msg)
	if got, gerr := h.getPublish(context.WithoutCancel(ctx), id); gerr == nil {
		p = got
	}
	return p, errors.New(msg)
}

func (h *handler) notifyFailed(ctx context.Context, p Publish, by, msg string) {
	// 平台的报错和校验文字多半已经带平台名
	body := msg
	if label := PlatformLabels[p.Platform]; !strings.HasPrefix(msg, label) {
		body = label + "：" + msg
	}
	n := plugin.Notification{Kind: "publish_failed", Level: plugin.NotifyError,
		Title: by + "失败：《" + p.Title + "》",
		Body:  clipText(body, 500),
		Data:  map[string]any{"publish_id": p.ID, "video_id": p.VideoID, "platform": p.Platform}}
	if err := h.c.Notify(ctx, n); err != nil {
		h.c.Log().Warn("video publish failed notify", "publish", p.ID, "err", err)
	}
}

/* ---------- 定时任务动作 ---------- */

func paramID(params map[string]any) (string, error) {
	id, _ := params["publish_id"].(string)
	if id = strings.TrimSpace(id); id == "" {
		return "", errors.New("publish_id 必填")
	}
	return id, nil
}

func (h *handler) validatePublishAction(ctx context.Context, _ plugin.Core, params map[string]any) (map[string]any, error) {
	for k := range params {
		if k != "publish_id" {
			return nil, fmt.Errorf("不认识的参数 %s", k)
		}
	}
	id, err := paramID(params)
	if err != nil {
		return nil, err
	}
	if _, err := h.getPublish(ctx, id); err != nil {
		return nil, fmt.Errorf("发布记录 %s 不存在", id)
	}
	return map[string]any{"publish_id": id}, nil
}

// runPublishAction 不等投稿：放进常驻任务的队列就回，结果写在发布记录上，失败另发通知。
func (h *handler) runPublishAction(ctx context.Context, _ plugin.Core, in plugin.ScheduleActionInput) (*plugin.ScheduleActionResult, error) {
	id, err := paramID(in.Params)
	if err != nil {
		return nil, err
	}
	p, err := h.getPublish(ctx, id)
	if err != nil {
		return nil, plainErr(err)
	}
	if p.Status == "published" || p.URL != "" {
		return &plugin.ScheduleActionResult{Text: "《" + p.Title + "》已经发布过了，没有再投"}, nil
	}
	select {
	case h.fire <- id:
	default:
		return nil, errors.New("待发布的太多了，稍后再试")
	}
	return &plugin.ScheduleActionResult{Text: "开始发布《" + p.Title + "》到" + PlatformLabels[p.Platform] + "，记录 " + id}, nil
}

/* ---------- SOP 节点 ---------- */

// publishNode 当场投稿（同「投稿」按钮），输出 publish：发布记录的 id、平台、状态、链接。
func (h *handler) publishNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	id := strings.TrimSpace(render(n.Config["publish"], n.Input))
	if id == "" {
		return nil, errors.New("没有指定发布记录")
	}
	p, err := h.firePublish(ctx, id, "SOP 发布")
	if err != nil {
		if errors.Is(err, errNotFound) || strings.Contains(err.Error(), "不存在") {
			return nil, fmt.Errorf("发布记录 %s 不存在", id)
		}
		return nil, err
	}
	return with(n.Input, "publish", map[string]any{"publish_id": p.ID, "video_id": p.VideoID, "platform": p.Platform,
		"title": p.Title, "status": p.Status, "url": p.URL}), nil
}

/* ---------- 内容日历 ---------- */

// CalendarItem 同原型 CalendarItem；behind 是原型 isBehind 的结果，只有计划首发日有。
// deal_deadline（商单截止）等商单后端落地再加。
type CalendarItem struct {
	Date     string `json:"date"`
	Kind     string `json:"kind"`
	RefID    string `json:"ref_id"`
	Label    string `json:"label"`
	Tone     string `json:"tone"`
	At       string `json:"at,omitempty"`
	Status   string `json:"status,omitempty"`
	Platform string `json:"platform,omitempty"`
	VideoID  string `json:"video_id,omitempty"`
	Movable  bool   `json:"movable"`
	Behind   bool   `json:"behind,omitempty"`
}

// calendarRange 认 month=YYYY-MM、week=YYYY-MM-DD（那一周，周一起）、from&to=YYYY-MM-DD；都没给是本月。
func calendarRange(q map[string][]string, today time.Time) (time.Time, time.Time, error) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	month, week, from, to := get("month"), get("week"), get("from"), get("to")
	n := 0
	for _, s := range []string{month, week, from + to} {
		if s != "" {
			n++
		}
	}
	if n > 1 {
		return time.Time{}, time.Time{}, apiErr(errValidation, "month、week、from/to 只能给一种")
	}
	switch {
	case month != "":
		t, err := time.ParseInLocation("2006-01", month, time.Local)
		if err != nil {
			return time.Time{}, time.Time{}, apiErr(errValidation, "month 要写成 YYYY-MM")
		}
		return t, t.AddDate(0, 1, -1), nil
	case week != "":
		t, err := time.ParseInLocation(time.DateOnly, week, time.Local)
		if err != nil {
			return time.Time{}, time.Time{}, apiErr(errValidation, "week 要写成 YYYY-MM-DD")
		}
		start := t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7))
		return start, start.AddDate(0, 0, 6), nil
	case from != "" || to != "":
		f, err1 := time.ParseInLocation(time.DateOnly, from, time.Local)
		e, err2 := time.ParseInLocation(time.DateOnly, to, time.Local)
		if err1 != nil || err2 != nil {
			return time.Time{}, time.Time{}, apiErr(errValidation, "from、to 都要给，写成 YYYY-MM-DD")
		}
		if e.Before(f) {
			return time.Time{}, time.Time{}, apiErr(errValidation, "to 不能早于 from")
		}
		if e.Sub(f) > 92*24*time.Hour {
			return time.Time{}, time.Time{}, apiErr(errValidation, "一次最多查 93 天")
		}
		return f, e, nil
	}
	start := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.Local)
	return start, start.AddDate(0, 1, -1), nil
}

func localDate(t time.Time) string { return t.In(time.Local).Format(time.DateOnly) }

// daysBetween 同原型：从 a 到 b 隔几天，按本地日期算。
func daysBetween(a, b string) int {
	ta, _ := time.ParseInLocation(time.DateOnly, a, time.Local)
	tb, _ := time.ParseInLocation(time.DateOnly, b, time.Local)
	return int(tb.Sub(ta).Round(24*time.Hour) / (24 * time.Hour))
}

// videoDone 同原型 videoState 的「已完成」：到了分发包、分发包检查点通过。
func videoDone(v Video) bool {
	return v.Stage == "distribution" && v.checkpoint("distribution").State == "passed"
}

// isBehind 同原型 isBehind：排了首发日，离首发日不到 LateDays 天（或已经过了），第一章验收还没通过。
func isBehind(v Video, today string) bool {
	if v.TargetDate == nil {
		return false
	}
	if v.checkpoint("ch1").State == "passed" {
		return false
	}
	return daysBetween(today, *v.TargetDate) <= LateDays
}

// calendarItems 同原型 calendarItems（不含商单）：没有日期的发布不上日历；按日期、时刻排。
func calendarItems(videos []Video, publishes []Publish, today, from, to string) []CalendarItem {
	out := []CalendarItem{}
	titles := map[string]string{}
	for _, v := range videos {
		titles[v.ID] = v.Title
	}
	for _, p := range publishes {
		at := p.ScheduledAt
		if p.Status == "published" {
			at = p.PublishedAt
		}
		if at == nil {
			continue
		}
		d := localDate(parseTime(*at))
		if d < from || d > to {
			continue
		}
		label := p.Title
		if label == "" {
			label = titles[p.VideoID]
		}
		if label == "" {
			label = "未填标题"
		}
		tone := "muted"
		switch p.Status {
		case "failed":
			tone = "danger"
		case "published":
			tone = "ok"
		}
		out = append(out, CalendarItem{Date: d, Kind: "publish", RefID: p.ID, Label: label, Tone: tone, At: *at, Status: p.Status,
			Platform: p.Platform, VideoID: p.VideoID, Movable: p.Status == "planned" || p.Status == "scheduled"})
	}
	for _, v := range videos {
		if v.TargetDate == nil || *v.TargetDate < from || *v.TargetDate > to {
			continue
		}
		done := videoDone(v)
		behind := !done && isBehind(v, today)
		tone := "muted"
		switch {
		case done:
			tone = "ok"
		case behind:
			tone = "danger"
		}
		out = append(out, CalendarItem{Date: *v.TargetDate, Kind: "target", RefID: v.ID, Label: v.Title, Tone: tone, VideoID: v.ID,
			Movable: !done, Behind: behind})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].At < out[j].At
	})
	return out
}

// listCalendar 是 GET /api/video/calendar。
func (h *handler) listCalendar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := time.Now().In(time.Local)
	start, end, err := calendarRange(r.URL.Query(), now)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	from, to := start.Format(time.DateOnly), end.Format(time.DateOnly)
	videos, err := h.loadVideos(ctx, "")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes
		WHERE scheduled_at IS NOT NULL OR published_at IS NOT NULL ORDER BY created_at, rowid`)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	defer func() { _ = rows.Close() }()
	var pubs []Publish
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		pubs = append(pubs, p)
	}
	if err := rows.Err(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	today := localDate(now)
	out := calendarItems(videos, pubs, today, from, to)
	behind := 0
	for _, it := range out {
		if it.Behind {
			behind++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"total": len(out), "from": from, "to": to,
		"today": today, "late_days": LateDays, "behind": behind}})
}
