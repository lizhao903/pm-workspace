// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// 补全消息（TSK-0724，im 0.30.0，不加迁移）：群组管理里对单个会话回渠道拉历史消息补进来，顺带补正文为空的消息。
// POST /api/im/conversations/{conversation_id}/backfill?range=7d|30d|all[&cursor=]。批量由前端逐个会话调、撞上限流就停。
//
// 口径：
//   - 从新往旧翻会话历史（Slack conversations.history），一次请求至多 historyPageBudget 页（一页 200 条）、
//     至多拉 historyThreadBudget 个消息列的回复（口径同 backfill-threads：最新回复在范围里、最新那条还没收过的串）；
//     没翻完回 cursor，带上再调接着往旧翻。range=all 一个会话累计至多翻 historyAllCap 条（cursor 里记着），到了就停。
//   - 已有的按渠道编号（external_id）去重，不重复入库；已有、正文为空的，用拉到的正文补上（同 refill 口径，只补空的）。
//   - 补进来的不当新消息：不发 im.message_received / im.message_muted（不触发 SOP、Agent，不通知），落库即已读（不计未读）；
//     发送超过 historyFreshFor（24 小时）的落成已过期（待处理 + expired_at，不进待处理），24 小时内的待处理；
//     发信人被自动忽略的照样落成已忽略。
//   - 撞上渠道限流停下，拿到的先落库，回 limited 和 cursor（「已补 N 条，剩余可再点」）。
//   - 不动定时拉取的进度，和拉取共用一把锁（不同时跑）。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	historyPageBudget   = 10 // 一次请求至多翻几页历史（Slack 一页 200 条；history 和 replies 同档限流约每分钟 50 次）
	historyThreadBudget = 30 // 一次请求至多拉几个消息列的回复
	historyFreshFor     = 24 * time.Hour
)

// historyAllCap 是 range=all 一个会话累计至多翻几条（不含消息列回复；测试里调小）。
var historyAllCap = 5000

// historyRanges 是可选的范围：天数，0 为全部。
var historyRanges = map[string]int{"7d": 7, "30d": 30, "all": 0}

// HistoryBackfiller 能按会话往回拉历史消息（一次性，不动拉取进度）。
type HistoryBackfiller interface {
	Adapter
	BackfillHistory(ctx context.Context, connectorID string, q HistoryQuery) ([]Incoming, HistoryPage, error)
}

// HistoryQuery 是一次拉历史：会话的渠道编号、从多久之前（零值为不限）、续补位置。
type HistoryQuery struct {
	ConversationExternalID string
	Since                  time.Time
	Cursor                 HistoryCursor
	// Cap 是累计至多翻几条（0 不限），算上 Cursor.Walked
	Cap int
}

// HistoryCursor 是续补位置：Before 之前（Inclusive 时含 Before）还没翻；Walked 是这一轮已经翻过的条数（range=all 的上限按它算）。
type HistoryCursor struct {
	Before    string `json:"b,omitempty"`
	Inclusive bool   `json:"i,omitempty"`
	Walked    int    `json:"w,omitempty"`
}

// HistoryPage 是适配器这一次的统计：Scanned 翻了几条（不含消息列回复），Threads 拉了几个串；
// Done 翻完了（到了范围起点或会话开头），Limited 撞上限流，Capped 到了累计上限；没 Done 时 Next 是续补位置。
type HistoryPage struct {
	Scanned int
	Threads int
	Done    bool
	Limited bool
	Capped  bool
	Next    HistoryCursor
}

// HistoryBackfillResult 是 POST /api/im/conversations/{conversation_id}/backfill 的结果。
// Added 新补进来的条数（其中 Expired 落成已过期、Muted 因自动忽略落成已忽略），Duplicates 已经有的，BodiesFilled 补上正文的；
// Complete 为真时这个范围补完了（Capped 时是到了全部的上限）；为假时带 Cursor 再调接着补，Limited 是撞上限流停下的。
type HistoryBackfillResult struct {
	ConversationID string `json:"conversation_id"`
	ConnectorID    string `json:"connector_id"`
	Range          string `json:"range"`
	Scanned        int    `json:"scanned"`
	ThreadsChecked int    `json:"threads_checked"`
	Added          int    `json:"added"`
	Expired        int    `json:"expired"`
	Muted          int    `json:"muted"`
	Duplicates     int    `json:"duplicates"`
	BodiesFilled   int    `json:"bodies_filled"`
	Complete       bool   `json:"complete"`
	Limited        bool   `json:"limited"`
	Capped         bool   `json:"capped"`
	Cursor         string `json:"cursor"`
}

func (in *inbox) historyBackfillerFor(channel string) HistoryBackfiller {
	for _, a := range in.adapters {
		if f, ok := a.(HistoryBackfiller); ok && a.Channel() == channel {
			return f
		}
	}
	return nil
}

// backfillNote 是会话不能补全消息的原因，能补为空串（会话统计的 backfill_note，按钮置灰时写在提示里）。
func (in *inbox) backfillNote(channel, connectorID string) string {
	switch {
	case in.historyBackfillerFor(channel) == nil && channel == "telegram":
		return "Telegram 的 Bot 只能收到加入之后的新消息，拉不到历史消息"
	case in.historyBackfillerFor(channel) == nil:
		return "这个渠道不支持拉历史消息"
	case connectorID == "":
		return "这个会话没有记下是哪个连接器收的，拉不了历史"
	}
	return ""
}

func encodeHistoryCursor(c HistoryCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeHistoryCursor(s string) (HistoryCursor, error) {
	var c HistoryCursor
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	if err != nil || c.Walked < 0 {
		return c, errors.New("cursor 不对：用上一次补全结果里的 cursor")
	}
	return c, nil
}

// historyExpiry 是补全历史时一条消息的过期时间：发送超过 historyFreshFor 的落成已过期（记补入的时刻），否则 nil。
func historyExpiry(now time.Time, sentAt string) *string {
	at, err := time.Parse(timeLayout, sentAt)
	if err != nil || now.Sub(at) <= historyFreshFor {
		return nil
	}
	s := now.UTC().Format(timeLayout)
	return &s
}

// backfillConversation：POST /api/im/conversations/{conversation_id}/backfill。
// range 不对、cursor 不对 400；会话不存在 404；渠道不支持、没有连接器、连接器暂停或断开 409；渠道整次调不了 502 backfill_failed。
func (in *inbox) backfillConversation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	rng := strings.TrimSpace(q.Get("range"))
	if rng == "" {
		rng = "7d"
	}
	days, ok := historyRanges[rng]
	if !ok {
		fail(w, r, in.c, apiErr(errValidation, "range must be 7d, 30d or all"))
		return
	}
	var cur HistoryCursor
	if s := strings.TrimSpace(q.Get("cursor")); s != "" {
		var err error
		if cur, err = decodeHistoryCursor(s); err != nil {
			fail(w, r, in.c, apiErr(errValidation, "%s", err.Error()))
			return
		}
	}
	cv, err := in.conversation(ctx, r.PathValue("conversation_id"))
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	f := in.historyBackfillerFor(cv.Channel)
	if f == nil {
		fail(w, r, in.c, blocked("unsupported", in.backfillNote(cv.Channel, "")))
		return
	}
	connID, err := in.lastConnector(ctx, cv.ID)
	if err != nil {
		fail(w, r, in.c, err)
		return
	}
	cn, err := in.c.Connectors().Get(ctx, connID)
	switch {
	case connID == "" || errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, blocked("no_connector", "这个会话没有记下是哪个连接器收的，或连接器已经删了，拉不了历史"))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	hq := HistoryQuery{ConversationExternalID: cv.ExternalID, Cursor: cur}
	if days > 0 {
		hq.Since = in.clock().Add(-time.Duration(days) * 24 * time.Hour)
	} else {
		hq.Cap = historyAllCap
	}
	if mu := in.pullMu[f.Key()]; mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}
	msgs, pg, err := f.BackfillHistory(ctx, connID, hq)
	if err != nil {
		in.c.Log().Warn("im backfill history failed", "connector", connID, "conversation", cv.ID, "err", err)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "backfill_failed", msg: "补全失败：" + err.Error()})
		return
	}
	res := HistoryBackfillResult{ConversationID: cv.ID, ConnectorID: connID, Range: rng, Scanned: pg.Scanned, ThreadsChecked: pg.Threads,
		Complete: pg.Done || pg.Capped, Limited: pg.Limited, Capped: pg.Capped}
	if !res.Complete {
		res.Cursor = encodeHistoryCursor(pg.Next)
	}
	// 会话按工作台里登记的算（适配器没列过会话时猜不准类型和名字）
	for i := range msgs {
		msgs[i].ConversationKind = cv.Kind
		if cv.Kind == "direct" {
			msgs[i].ConversationName = ""
		} else if cv.Name != "" {
			msgs[i].ConversationName = cv.Name
		}
	}
	// 先补已有的空正文（新落库的还不在，不会算进去），再落新的
	for _, m := range msgs {
		ok, err := in.fillBody(ctx, cv.Channel, m)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		if ok {
			res.BodiesFilled++
		}
	}
	if len(msgs) > 0 {
		got, err := in.ingestAs(ctx, f, msgs, false, true)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		res.Added, res.Duplicates, res.Expired, res.Muted = len(got.IDs), got.Duplicates, got.expired, got.muted
	}
	if res.Added > 0 || res.BodiesFilled > 0 {
		in.c.Audit().Note(ctx, plugin.AuditNote{Action: "update", TargetType: "conversation", TargetID: cv.ID,
			Summary: "补全 IM 消息：新补 " + strconv.Itoa(res.Added) + " 条，补上正文 " + strconv.Itoa(res.BodiesFilled) + " 条",
			Detail: map[string]any{"field": "history", "range": rng, "added": res.Added, "bodies_filled": res.BodiesFilled,
				"expired": res.Expired, "muted": res.Muted, "complete": res.Complete}}, plugin.WriteMeta{})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}

// fillBody 已收过、正文为空的消息用拉到的正文补上（只补空的，不改状态）；补上了回 true。
// 拉到的也没正文的不动；只带附件的只补原来没附件的。
func (in *inbox) fillBody(ctx context.Context, channel string, m Incoming) (bool, error) {
	if m.Text == "" && len(m.Attachments) == 0 {
		return false, nil
	}
	atts := "[]"
	if len(m.Attachments) > 0 {
		atts = string(m.Attachments)
	}
	r, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET text = ?,
		sender_name = CASE WHEN sender_name = '' THEN ? ELSE sender_name END,
		attachments = CASE WHEN attachments = '[]' THEN ? ELSE attachments END
		WHERE channel = ? AND external_id = ? AND text = '' AND (? <> '' OR attachments = '[]')`,
		clip(m.Text, maxText), m.SenderName, atts, channel, m.ExternalID, m.Text)
	if err != nil {
		return false, err
	}
	n, _ := r.RowsAffected()
	return n == 1, nil
}
