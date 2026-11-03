package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 商单（VID-08d，video-creator-analysis.md P2-1）：表 video_deals、video_deal_videos，形状同原型 web-next/src/videodata.ts 的 Deal。
// 商单挂在项目下，询价人是联系人，来源消息是 im 插件的消息（只存不查）；挂上的视频没有项目时归到商单的项目。
// 报价参考读数据快照算近 30 天均播；发布满 7 天出结案报告，经 Core.ObjectWriter 建一篇文档，id 回填 report_content_id。
// 账期今日卡片 video_deal_due：已交付没收款、离账期不到 7 天或已过。金额只是记录，不接收付款。

// DealStatuses 同原型 DEAL_STATUS 的顺序；DealFlow 是正常流转的七步，丢单可以从收款前的任一步进。
var DealStatuses = []string{"inquiry", "quoted", "signed", "producing", "client_review", "delivered", "paid", "lost"}

var DealStatusLabels = map[string]string{"inquiry": "询价", "quoted": "已报价", "signed": "已签约", "producing": "制作中",
	"client_review": "客户审核", "delivered": "已交付", "paid": "已收款", "lost": "丢单"}

// DealCurrencies 同原型 Deal.currency。
var DealCurrencies = []string{"CNY", "USD"}

const (
	// QuoteCPM 同原型 QUOTE_CPM：每千次播放折多少钱（元）
	QuoteCPM = 150
	// ReportDays 同原型 REPORT_DAYS：发布满几天出结案报告
	ReportDays = 7
	// PayWarnDays 同原型 payState：离账期不到几天开始提醒
	PayWarnDays = 7
	// quoteRefDays 是报价参考看近几天的发布
	quoteRefDays = 30
)

// DealHistory 是一次状态变化。
type DealHistory struct {
	Status string `json:"status"`
	At     string `json:"at"`
}

// Deal 同原型 Deal：contact_id、deadline、pay_due、source_message_id、report_content_id、lost_reason 没有就不返回。
// report_state 是原型 reportState 的结果，后端算好给前端，挂上的视频还没有发出去时不返回。
type Deal struct {
	ID              string         `json:"id"`
	ProjectID       string         `json:"project_id"`
	ContactID       *string        `json:"contact_id,omitempty"`
	Brand           string         `json:"brand"`
	Title           string         `json:"title"`
	Platforms       []string       `json:"platforms"`
	Deliverables    string         `json:"deliverables"`
	Quote           int            `json:"quote"`
	Currency        string         `json:"currency"`
	Status          string         `json:"status"`
	Deadline        *string        `json:"deadline,omitempty"`
	PayDue          *string        `json:"pay_due,omitempty"`
	VideoIDs        []string       `json:"video_ids"`
	SourceMessageID *string        `json:"source_message_id,omitempty"`
	ReportContentID *string        `json:"report_content_id,omitempty"`
	LostReason      string         `json:"lost_reason,omitempty"`
	History         []DealHistory  `json:"history"`
	ReportState     *DealReportRef `json:"report_state,omitempty"`
	CreatedAt       string         `json:"created_at"`
	UpdatedAt       string         `json:"updated_at"`
}

// DealReportRef 同原型 reportState：最早一条已发布记录满没满 7 天，还差几天。
type DealReportRef struct {
	Ready            bool   `json:"ready"`
	Left             int    `json:"left"`
	FirstPublishedAt string `json:"first_published_at"`
}

const dealCols = `id, project_id, contact_id, brand, title, platforms, deliverables, quote, currency, status, deadline, pay_due,
	source_message_id, report_content_id, lost_reason, history, created_at, updated_at`

var dealFields = []string{"project_id", "contact_id", "brand", "title", "platforms", "deliverables", "quote", "currency", "status",
	"deadline", "pay_due", "video_ids", "source_message_id", "lost_reason"}

func (h *handler) registerDeals(m plugin.RouteRegistrar) {
	m.HandleFunc("GET /api/video/deals", h.listDeals)
	m.HandleFunc("POST /api/video/deals", h.addDeal)
	m.HandleFunc("GET /api/video/deals/quote-ref", h.quoteRef)
	m.HandleFunc("GET /api/video/deals/{id}", h.showDeal)
	m.HandleFunc("PATCH /api/video/deals/{id}", h.updateDeal)
	m.HandleFunc("DELETE /api/video/deals/{id}", h.removeDeal)
	m.HandleFunc("POST /api/video/deals/{id}/report", h.dealReport)
}

func scanDeal(row plugin.Row) (Deal, error) {
	var d Deal
	var platforms, history string
	if err := row.Scan(&d.ID, &d.ProjectID, &d.ContactID, &d.Brand, &d.Title, &platforms, &d.Deliverables, &d.Quote, &d.Currency, &d.Status,
		&d.Deadline, &d.PayDue, &d.SourceMessageID, &d.ReportContentID, &d.LostReason, &history, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return Deal{}, err
	}
	d.Platforms = jsonStrings(platforms)
	if json.Unmarshal([]byte(history), &d.History) != nil || d.History == nil {
		d.History = []DealHistory{}
	}
	d.VideoIDs = []string{}
	return d, nil
}

// loadDeals 按条件取商单，配上挂的视频和结案报告的进度。
func (h *handler) loadDeals(ctx context.Context, where string, args ...any) ([]Deal, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+dealCols+` FROM video_deals `+where+` ORDER BY created_at, rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Deal{}
	idx := map[string]int{}
	for rows.Next() {
		d, err := scanDeal(rows)
		if err != nil {
			return nil, err
		}
		idx[d.ID] = len(out)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	lrows, err := h.c.Store().Query(ctx, `SELECT deal_id, video_id FROM video_deal_videos ORDER BY deal_id, sort, rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		var did, vid string
		if err := lrows.Scan(&did, &vid); err != nil {
			return nil, err
		}
		if i, ok := idx[did]; ok {
			out[i].VideoIDs = append(out[i].VideoIDs, vid)
		}
	}
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	now := time.Now()
	for i := range out {
		pubs, err := h.dealPublishes(ctx, out[i])
		if err != nil {
			return nil, err
		}
		out[i].ReportState = reportState(pubs, now)
	}
	return out, nil
}

func (h *handler) getDeal(ctx context.Context, id string) (Deal, error) {
	xs, err := h.loadDeals(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Deal{}, err
	}
	if len(xs) == 0 {
		return Deal{}, apiErr(errNotFound, "商单不存在")
	}
	return xs[0], nil
}

// dealPublishes 是商单挂的视频的发布记录，按登记先后。
func (h *handler) dealPublishes(ctx context.Context, d Deal) ([]Publish, error) {
	if len(d.VideoIDs) == 0 {
		return nil, nil
	}
	b, _ := json.Marshal(d.VideoIDs)
	rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE video_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`, string(b))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Publish
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// reportState 同原型 reportState：没有已发布的记录返回 nil。
func reportState(pubs []Publish, now time.Time) *DealReportRef {
	var first time.Time
	var firstStr string
	for _, p := range pubs {
		if p.Status != "published" || p.PublishedAt == nil {
			continue
		}
		if t := parseTime(*p.PublishedAt); !t.IsZero() && (first.IsZero() || t.Before(first)) {
			first, firstStr = t, *p.PublishedAt
		}
	}
	if first.IsZero() {
		return nil
	}
	passed := int(math.Floor(now.Sub(first).Hours() / 24))
	return &DealReportRef{Ready: passed >= ReportDays, Left: max(0, ReportDays-passed), FirstPublishedAt: firstStr}
}

func (h *handler) listDeals(w http.ResponseWriter, r *http.Request) {
	var conds []string
	var args []any
	q := r.URL.Query()
	for _, f := range []struct{ key, col string }{{"project_id", "project_id"}, {"status", "status"}, {"source_message_id", "source_message_id"}} {
		if s := strings.TrimSpace(q.Get(f.key)); s != "" {
			conds, args = append(conds, f.col+` = ?`), append(args, s)
		}
	}
	if s := strings.TrimSpace(q.Get("video_id")); s != "" {
		conds, args = append(conds, `id IN (SELECT deal_id FROM video_deal_videos WHERE video_id = ?)`), append(args, s)
	}
	where := ""
	if len(conds) > 0 {
		where = `WHERE ` + strings.Join(conds, ` AND `)
	}
	xs, err := h.loadDeals(r.Context(), where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": xs, "meta": map[string]any{"total": len(xs)}})
}

func (h *handler) showDeal(w http.ResponseWriter, r *http.Request) {
	d, err := h.getDeal(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": d})
}

// applyDeal 把 body 里传了的字段写进 d；视频 id 单独回，由调用方写关联表。
func (h *handler) applyDeal(ctx context.Context, d *Deal, raw map[string]json.RawMessage) (videos []string, hasVideos bool, err error) {
	for _, f := range []struct {
		key, label string
		dst        *string
		limit      int
	}{
		{"brand", "品牌", &d.Brand, 100},
		{"title", "商单名称", &d.Title, 200},
		{"deliverables", "交付物", &d.Deliverables, 2000},
		{"lost_reason", "丢单原因", &d.LostReason, 500},
	} {
		if b, ok := raw[f.key]; ok && isNull(b) {
			*f.dst = ""
			continue
		}
		if err := strField(raw, f.key, f.label, f.dst, f.limit); err != nil {
			return nil, false, err
		}
	}
	if b, ok := raw["project_id"]; ok {
		id, err := optID(b, "project_id")
		if err != nil {
			return nil, false, err
		}
		if id == nil {
			return nil, false, apiErr(errValidation, "选一个项目")
		}
		o, err := h.c.Objects().Get(ctx, *id)
		if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Deleted || o.Type != "project")) {
			return nil, false, apiErr(errValidation, "项目不存在")
		}
		if err != nil {
			return nil, false, err
		}
		d.ProjectID = *id
	}
	if b, ok := raw["contact_id"]; ok {
		id, err := optID(b, "contact_id")
		if err != nil {
			return nil, false, err
		}
		if id != nil {
			if _, err := h.c.Contacts().Get(ctx, *id); errors.Is(err, plugin.ErrNoRows) {
				return nil, false, apiErr(errValidation, "联系人不存在")
			} else if err != nil {
				return nil, false, err
			}
		}
		d.ContactID = id
	}
	if b, ok := raw["source_message_id"]; ok {
		id, err := optID(b, "source_message_id")
		if err != nil {
			return nil, false, err
		}
		if id != nil && len(*id) > 200 {
			return nil, false, apiErr(errValidation, "source_message_id 太长")
		}
		d.SourceMessageID = id
	}
	if b, ok := raw["platforms"]; ok {
		var xs []string
		if err := json.Unmarshal(b, &xs); err != nil || xs == nil {
			return nil, false, apiErr(errValidation, "platforms 必须是数组")
		}
		for _, p := range xs {
			if !slices.Contains(Platforms, p) {
				return nil, false, apiErr(errValidation, "platforms 只能是 %s", strings.Join(Platforms, "、"))
			}
		}
		d.Platforms = slices.DeleteFunc(slices.Clone(Platforms), func(p string) bool { return !slices.Contains(xs, p) })
	}
	if err := intField(raw, "quote", "报价", &d.Quote, 0, 1_000_000_000); err != nil {
		return nil, false, err
	}
	if err := enumField(raw, "currency", "币种", &d.Currency, DealCurrencies); err != nil {
		return nil, false, err
	}
	if err := enumField(raw, "status", "status", &d.Status, DealStatuses); err != nil {
		return nil, false, err
	}
	if err := dateField(raw, "deadline", "交付截止", &d.Deadline); err != nil {
		return nil, false, err
	}
	if err := dateField(raw, "pay_due", "账期", &d.PayDue); err != nil {
		return nil, false, err
	}
	videos, hasVideos, err = idsField(raw, "video_ids")
	if err != nil {
		return nil, false, err
	}
	for _, id := range videos {
		var x string
		err := h.c.Store().QueryRow(ctx, `SELECT id FROM video_videos WHERE id = ?`, id).Scan(&x)
		if errors.Is(err, plugin.ErrNoRows) {
			return nil, false, apiErr(errValidation, "视频 %s 不存在", id)
		}
		if err != nil {
			return nil, false, err
		}
	}
	return videos, hasVideos, nil
}

// checkDeal 是存之前的整体校验和状态流转：必填项、丢单要写原因、已收款不能丢单；状态变了在 history 最前面记一条。
func checkDeal(d *Deal, from string, now string) error {
	if d.Brand == "" {
		return apiErr(errValidation, "品牌必填")
	}
	if d.Title == "" {
		return apiErr(errValidation, "商单名称必填")
	}
	if d.ProjectID == "" {
		return apiErr(errValidation, "选一个项目")
	}
	if d.Status == from {
		if d.Status == "lost" && d.LostReason == "" {
			return apiErr(errValidation, "写一下丢单原因")
		}
		return nil
	}
	if d.Status == "lost" {
		if from == "paid" {
			return apiErr(errValidation, "已收款的商单不能丢单")
		}
		if d.LostReason == "" {
			return apiErr(errValidation, "写一下丢单原因")
		}
	} else {
		// 离开丢单（重新跟进）时原因清掉
		d.LostReason = ""
	}
	d.History = append([]DealHistory{{Status: d.Status, At: now}}, d.History...)
	return nil
}

// saveDealVideos 整体替换挂的视频，并把没有项目的视频归到商单的项目。
func (h *handler) saveDealVideos(ctx context.Context, d Deal, ids []string, now string) error {
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_deal_videos WHERE deal_id = ?`, d.ID); err != nil {
		return err
	}
	for i, id := range ids {
		if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_deal_videos (deal_id, video_id, sort) VALUES (?, ?, ?)`, d.ID, id, i); err != nil {
			return err
		}
		if _, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET project_id = ?, updated_at = ? WHERE id = ? AND project_id IS NULL`,
			d.ProjectID, now, id); err != nil {
			return err
		}
	}
	return nil
}

func (h *handler) writeDeal(ctx context.Context, d Deal, insert bool) error {
	platforms, _ := json.Marshal(d.Platforms)
	history, _ := json.Marshal(d.History)
	if insert {
		_, err := h.c.Store().Exec(ctx, `INSERT INTO video_deals (`+dealCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			d.ID, d.ProjectID, d.ContactID, d.Brand, d.Title, string(platforms), d.Deliverables, d.Quote, d.Currency, d.Status, d.Deadline, d.PayDue,
			d.SourceMessageID, d.ReportContentID, d.LostReason, string(history), d.CreatedAt, d.UpdatedAt)
		return err
	}
	_, err := h.c.Store().Exec(ctx, `UPDATE video_deals SET project_id = ?, contact_id = ?, brand = ?, title = ?, platforms = ?, deliverables = ?,
		quote = ?, currency = ?, status = ?, deadline = ?, pay_due = ?, source_message_id = ?, report_content_id = ?, lost_reason = ?, history = ?,
		updated_at = ? WHERE id = ?`,
		d.ProjectID, d.ContactID, d.Brand, d.Title, string(platforms), d.Deliverables, d.Quote, d.Currency, d.Status, d.Deadline, d.PayDue,
		d.SourceMessageID, d.ReportContentID, d.LostReason, string(history), d.UpdatedAt, d.ID)
	return err
}

func (h *handler) addDeal(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, dealFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	d := Deal{Platforms: []string{}, Currency: "CNY", Status: "inquiry", History: []DealHistory{}}
	videos, _, err := h.applyDeal(ctx, &d, raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	if err := checkDeal(&d, "", now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	d.ID = idgen.Prefixed("deal")
	d.CreatedAt, d.UpdatedAt = now, now
	if err := h.writeDeal(ctx, d, true); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.saveDealVideos(ctx, d, videos, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getDeal(ctx, d.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

func (h *handler) updateDeal(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, dealFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	d, err := h.getDeal(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	from := d.Status
	videos, hasVideos, err := h.applyDeal(ctx, &d, raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	if err := checkDeal(&d, from, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	d.UpdatedAt = now
	if err := h.writeDeal(ctx, d, false); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if !hasVideos {
		videos = d.VideoIDs
	}
	// 没换视频也重写一遍：项目换了时，挂着的没项目的视频跟着归过去
	if err := h.saveDealVideos(ctx, d, videos, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getDeal(ctx, d.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// removeDeal 只删商单，视频和结案报告文档都留着。
func (h *handler) removeDeal(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	d, err := h.getDeal(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_deals WHERE id = ?`, d.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

/* ---------- 报价参考 ---------- */

// QuoteRef 同原型 avgViews30 加上报价：近 30 天这些平台已发布记录的平均播放，value 是按每千次播放 ¥150 折的投放价值，取整到百。
type QuoteRef struct {
	Platforms []string `json:"platforms"`
	Avg       int      `json:"avg"`
	N         int      `json:"n"`
	CPM       int      `json:"cpm"`
	Value     int      `json:"value"`
}

func (h *handler) quoteRef(w http.ResponseWriter, r *http.Request) {
	var platforms []string
	for _, p := range strings.Split(r.URL.Query().Get("platforms"), ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		if !slices.Contains(Platforms, p) {
			fail(w, r, h.c, apiErr(errValidation, "platforms 只能是 %s", strings.Join(Platforms, "、")))
			return
		}
		if !slices.Contains(platforms, p) {
			platforms = append(platforms, p)
		}
	}
	ref, err := h.quoteRefOf(r.Context(), platforms, time.Now())
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": ref})
}

// quoteRefOf 读快照：每条发布取最新一条快照的播放，没有快照的用发布记录上的 metrics，都没有的不算。
func (h *handler) quoteRefOf(ctx context.Context, platforms []string, now time.Time) (QuoteRef, error) {
	since := now.Add(-quoteRefDays * 24 * time.Hour).UTC().Format(time.RFC3339)
	rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE status = 'published' AND published_at IS NOT NULL AND published_at >= ?
		ORDER BY published_at, rowid`, since)
	if err != nil {
		return QuoteRef{}, err
	}
	var pubs []Publish
	for rows.Next() {
		p, err := scanPublish(rows)
		if err != nil {
			_ = rows.Close()
			return QuoteRef{}, err
		}
		if len(platforms) == 0 || slices.Contains(platforms, p.Platform) {
			pubs = append(pubs, p)
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return QuoteRef{}, err
	}
	sum, n := 0, 0
	for _, p := range pubs {
		var views int
		err := h.c.Store().QueryRow(ctx, `SELECT views FROM video_metric_snapshots WHERE publish_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`, p.ID).Scan(&views)
		if errors.Is(err, plugin.ErrNoRows) {
			if p.Metrics == nil {
				continue
			}
			views = p.Metrics.Views
		} else if err != nil {
			return QuoteRef{}, err
		}
		sum, n = sum+views, n+1
	}
	ref := QuoteRef{Platforms: platforms, CPM: QuoteCPM}
	if ref.Platforms == nil {
		ref.Platforms = []string{}
	}
	if n > 0 {
		ref.N = n
		ref.Avg = int(math.Round(float64(sum) / float64(n)))
		ref.Value = int(math.Round(float64(ref.Avg)/1000*QuoteCPM/100)) * 100
	}
	return ref, nil
}

/* ---------- 结案报告 ---------- */

// dealReport 出结案报告：最早一条发布满 7 天才能出，建一篇文档（归到商单的项目，标签「商单」「结案报告」），回填 report_content_id。
// 插件只能建对象不能改，「按最新数据重出」是再建一篇新的，report_content_id 换成新的那篇，旧的留在文档里。
func (h *handler) dealReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	d, err := h.getDeal(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	rs := d.ReportState
	if rs == nil {
		fail(w, r, h.c, apiErr(errConflict, "挂上的视频还没有发出去；发布满 %d 天后可以出结案报告", ReportDays))
		return
	}
	if !rs.Ready {
		fail(w, r, h.c, apiErr(errConflict, "最早一条发布还差 %d 天满 %d 天", rs.Left, ReportDays))
		return
	}
	pubs, err := h.dealPublishes(ctx, d)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	titles, err := h.videoTitles(ctx)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := time.Now()
	pid := d.ProjectID
	var project *string
	if o, err := h.c.Objects().Get(ctx, pid); err == nil && !o.Deleted && o.Type == "project" {
		project = &pid
	}
	doc, err := h.c.ObjectWriter().CreateAs(ctx, plugin.NewObject{
		TypeID: "doc", Title: d.Brand + " · " + d.Title + " 结案报告", Body: dealReportBody(d, titles, pubs, now),
		ProjectID: project, Tags: []string{"商单", "结案报告"},
		Props: map[string]any{domain.PropSourceRef: map[string]any{"deal_id": d.ID, "deal": d.Title}},
	}, plugin.WriteMeta{Session: d.ID, Detail: map[string]any{"deal_id": d.ID}})
	if err != nil {
		if errors.Is(err, domain.ErrValidation) {
			fail(w, r, h.c, apiErr(errValidation, "建结案报告文档失败：%v", err))
			return
		}
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_deals SET report_content_id = ?, updated_at = ? WHERE id = ?`, doc.ID, nowStr(), d.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getDeal(ctx, d.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]any{"deal": out, "doc": map[string]any{"id": doc.ID, "ref": doc.Ref, "title": doc.Title}}})
}

// thousands 同原型 toLocaleString('zh-CN')：整数三位一逗号。
func thousands(n int) string {
	s := fmt.Sprint(n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func dealMoney(d Deal) string {
	sym := "$"
	if d.Currency == "CNY" {
		sym = "¥"
	}
	return sym + thousands(d.Quote)
}

// dealReportBody 同原型 dealReport：标题就是文档标题，正文从说明开始；每节一段，节内列表一行一条。
func dealReportBody(d Deal, titles map[string]string, pubs []Publish, now time.Time) string {
	var done []Publish
	for _, p := range pubs {
		if p.Status == "published" {
			done = append(done, p)
		}
	}
	sum := func(f func(m *Metrics) int) int {
		n := 0
		for _, p := range done {
			if p.Metrics != nil {
				n += f(p.Metrics)
			}
		}
		return n
	}
	plat := func(k string) string {
		if s, ok := PlatformLabels[k]; ok {
			return s
		}
		return k
	}
	var platforms, videos []string
	for _, k := range d.Platforms {
		platforms = append(platforms, plat(k))
	}
	for _, id := range d.VideoIDs {
		t, ok := titles[id]
		if !ok {
			t = "已删除的视频"
		}
		videos = append(videos, t)
	}
	orNone := func(xs []string, none string) string {
		if len(xs) == 0 {
			return none
		}
		return strings.Join(xs, "、")
	}
	deliverables := d.Deliverables
	if deliverables == "" {
		deliverables = "未填"
	}
	var lines []string
	for _, p := range done {
		m := p.Metrics
		views, extra := 0, ""
		if m != nil {
			views = m.Views
			if m.CTR != nil {
				extra += fmt.Sprintf("，点击率 %.1f%%", *m.CTR*100)
			}
			if m.Completion != nil {
				extra += fmt.Sprintf("，完播率 %.0f%%", *m.Completion*100)
			}
		}
		if p.URL != "" {
			extra += "，链接 " + p.URL
		}
		lines = append(lines, fmt.Sprintf("- %s「%s」：发布 %d 天，播放 %s%s", plat(p.Platform), p.Title,
			dayAfter(p.PublishedAt, now.UTC().Format(time.RFC3339)), thousands(views), extra))
	}
	if len(lines) == 0 {
		lines = []string{"- 还没有已发布的记录"}
	}
	return strings.Join([]string{
		"> 生成于 " + now.Local().Format("2006-01-02 15:04") + "，数据取各平台最近一次回填",
		"## 合作概况",
		strings.Join([]string{
			"- 品牌：" + d.Brand,
			"- 交付物：" + deliverables,
			"- 报价：" + dealMoney(d),
			"- 投放平台：" + orNone(platforms, "未填"),
			"- 视频：" + orNone(videos, "没有关联视频"),
		}, "\n"),
		"## 数据汇总",
		fmt.Sprintf("- 播放 %s，点赞 %s，评论 %s，转发 %s",
			thousands(sum(func(m *Metrics) int { return m.Views })), thousands(sum(func(m *Metrics) int { return m.Likes })),
			thousands(sum(func(m *Metrics) int { return m.Comments })), thousands(sum(func(m *Metrics) int { return m.Shares }))),
		"## 各平台明细",
		strings.Join(lines, "\n"),
		"## 结论",
		"- 待补充：客户反馈、是否续约",
	}, "\n\n")
}

/* ---------- 今日卡片：商单账期 ---------- */

// TodayDeal 是「商单账期」的一条：已交付没收款，离账期不到 7 天（days 为负是已过）。
type TodayDeal struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Brand     string `json:"brand"`
	DealTitle string `json:"deal_title"`
	Quote     int    `json:"quote"`
	Currency  string `json:"currency"`
	PayDue    string `json:"pay_due"`
	Days      int    `json:"days"`
	Tone      string `json:"tone"`
	Label     string `json:"label"`
	Title     string `json:"title"`
	Sub       string `json:"sub"`
	At        string `json:"at"`
	Link      string `json:"link"`
}

// dealLink 是商单在项目里的前端路由：项目详情的「商单」标签，带 deal 打开抽屉。
func dealLink(projectID, id string) string { return "/projects/" + projectID + "/deals?deal=" + id }

// payDays 同原型 payState：已交付、有账期、离账期不到 7 天的回天数（负数是已过），否则 ok 为 false。today 是本地日期。
func payDays(d Deal, today time.Time) (int, bool) {
	if d.Status != "delivered" || d.PayDue == nil {
		return 0, false
	}
	due, err := time.ParseInLocation(time.DateOnly, *d.PayDue, today.Location())
	if err != nil {
		return 0, false
	}
	days := int(math.Round(due.Sub(today).Hours() / 24))
	return days, days <= PayWarnDays
}

func payLabel(days int) string {
	switch {
	case days < 0:
		return fmt.Sprintf("账期已过 %d 天", -days)
	case days == 0:
		return "今天到账期"
	default:
		return fmt.Sprintf("%d 天后到账期", days)
	}
}

func (h *handler) dealDueCard(ctx context.Context, _ plugin.Core) (*plugin.TodayCardData, error) {
	ds, err := h.loadDeals(ctx, `WHERE status = 'delivered' AND pay_due IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var items []TodayDeal
	for _, d := range ds {
		days, ok := payDays(d, today)
		if !ok {
			continue
		}
		tone := "warn"
		if days < 0 {
			tone = "danger"
		}
		label := payLabel(days)
		items = append(items, TodayDeal{ID: d.ID, ProjectID: d.ProjectID, Brand: d.Brand, DealTitle: d.Title, Quote: d.Quote, Currency: d.Currency,
			PayDue: *d.PayDue, Days: days, Tone: tone, Label: label, Title: d.Brand + "「" + d.Title + "」" + label,
			Sub: "已交付待收款 · " + dealMoney(d), At: d.UpdatedAt, Link: dealLink(d.ProjectID, d.ID)})
	}
	if len(items) == 0 {
		return nil, nil
	}
	// 账期早的（过得最久的）在前
	slices.SortStableFunc(items, func(x, y TodayDeal) int { return x.Days - y.Days })
	return &plugin.TodayCardData{Total: len(items), Items: items[:min(len(items), todayCardMax)]}, nil
}

func (h *handler) registerDealCard(r plugin.Registrar) {
	r.TodayCard(plugin.TodayCardDef{Key: "video_deal_due", Title: "商单账期", Order: 63, Load: h.dealDueCard})
}
