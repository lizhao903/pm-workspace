package im

// 串里的回复（0010）：Slack 在串里回复、没勾「同时发送到频道」的消息不在 conversations.history 里，
// 适配器拉取时按父消息的回复数另调 conversations.replies 收进来（slack.go），每条记下属于哪个串。
// 这里是读的一侧（Message.thread、reply_count）和一次性补拉入口 POST /api/im/connectors/{id}/backfill-threads。

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// MessageThread 是串里回复属于哪个串：父消息的 external_id；父消息在库里时 parent_message_id 是它的 id，
// 发信人和正文按库里的父消息给，不在库里（我发起的串、早于第一次拉取的）按到达时的快照给，都没有为空串。
// parent_text 是父消息正文的摘要（至多 80 字，换行压成空格）。
type MessageThread struct {
	ParentExternalID string  `json:"parent_external_id"`
	ParentMessageID  *string `json:"parent_message_id"`
	ParentSenderName string  `json:"parent_sender_name"`
	ParentText       string  `json:"parent_text"`
}

// fillThreads 补串的信息：串里回复认出父消息，每条消息数一下库里收到的串里回复（reply_count）。
func (in *inbox) fillThreads(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	type key struct{ ch, ext string }
	var (
		ph, chs []string
		args    []any
	)
	for _, m := range ms {
		if !slices.Contains(chs, m.Channel) {
			chs = append(chs, m.Channel)
		}
		ph, args = append(ph, "?"), append(args, m.ExternalID)
		if m.Thread != nil {
			ph, args = append(ph, "?"), append(args, m.Thread.ParentExternalID)
		}
	}
	// 按 (channel, 编号) 走索引：渠道一般就一两个
	chPh := strings.TrimSuffix(strings.Repeat("?,", len(chs)), ",")
	for _, c := range chs {
		args = append(args, c)
	}
	in1 := strings.Join(ph, ",")
	// 父消息
	parents := map[key]struct{ id, sender, text string }{}
	rows, err := in.c.Store().Query(ctx, `SELECT channel, external_id, id, sender_name, text FROM im_messages
		WHERE external_id IN (`+in1+`) AND channel IN (`+chPh+`)`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k key
		var p struct{ id, sender, text string }
		if err := rows.Scan(&k.ch, &k.ext, &p.id, &p.sender, &p.text); err != nil {
			_ = rows.Close()
			return err
		}
		parents[k] = p
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	// 回复数
	counts := map[key]int{}
	rows, err = in.c.Store().Query(ctx, `SELECT channel, thread_parent_external_id, COUNT(*) FROM im_messages
		WHERE thread_parent_external_id IN (`+in1+`) AND channel IN (`+chPh+`) AND thread_parent_external_id <> '' GROUP BY channel, thread_parent_external_id`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k key
		var n int
		if err := rows.Scan(&k.ch, &k.ext, &n); err != nil {
			_ = rows.Close()
			return err
		}
		counts[k] = n
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for i := range ms {
		m := &ms[i]
		m.ReplyCount = counts[key{m.Channel, m.ExternalID}]
		if m.Thread == nil {
			continue
		}
		if p, ok := parents[key{m.Channel, m.Thread.ParentExternalID}]; ok {
			id := p.id
			m.Thread.ParentMessageID = &id
			if p.sender != "" {
				m.Thread.ParentSenderName = p.sender
			}
			if t := strings.TrimSpace(p.text); t != "" {
				m.Thread.ParentText = t
			}
		}
		m.Thread.ParentText = clip(strings.Join(strings.Fields(m.Thread.ParentText), " "), threadTextMax)
	}
	return nil
}

// ThreadBackfiller 能把最近几天里有回复的串补拉回来（一次性，不动拉取进度）；回补到的串里回复和统计。
type ThreadBackfiller interface {
	Adapter
	BackfillThreads(ctx context.Context, connectorID string, days int) ([]Incoming, ThreadBackfill, error)
}

// ThreadBackfill 是适配器那边的统计：查了几个串，还剩几个串没查（限流或这一次的额度用完，再调一次接着查）；
// Complete 为假时还有会话没翻完（限流停下的），再调一次。
type ThreadBackfill struct {
	ThreadsChecked int  `json:"threads_checked"`
	Pending        int  `json:"pending"`
	Complete       bool `json:"complete"`
}

// BackfillThreadsResult 是 POST /api/im/connectors/{id}/backfill-threads 的结果：replies_added 是新收进来的串里回复条数。
type BackfillThreadsResult struct {
	ConnectorID    string `json:"connector_id"`
	Days           int    `json:"days"`
	ThreadsChecked int    `json:"threads_checked"`
	RepliesAdded   int    `json:"replies_added"`
	Pending        int    `json:"pending"`
	Complete       bool   `json:"complete"`
}

const (
	backfillDaysDefault = 7
	backfillDaysMax     = 30
)

func (in *inbox) threadBackfillerFor(tool string) ThreadBackfiller {
	for _, a := range in.adapters {
		if f, ok := a.(ThreadBackfiller); ok && a.Key() == tool {
			return f
		}
	}
	return nil
}

// backfillThreads：?days= 默认 7，1 到 30。连接器不在 404；渠道不支持、暂停、断开 409；渠道出错 502 backfill_failed。
// 和拉取共用同一把锁（不同时跑）；收进来的照普通到达处理（与我相关、通知、触发流程），已收过的去重。
func (in *inbox) backfillThreads(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	days := backfillDaysDefault
	if s := strings.TrimSpace(r.URL.Query().Get("days")); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > backfillDaysMax {
			fail(w, r, in.c, apiErr(errValidation, "days must be 1 to %d", backfillDaysMax))
			return
		}
		days = n
	}
	cn, err := in.c.Connectors().Get(ctx, id)
	switch {
	case errors.Is(err, plugin.ErrNoRows):
		fail(w, r, in.c, apiErr(errNotFound, "connector %s not found", id))
		return
	case err != nil:
		fail(w, r, in.c, err)
		return
	}
	f := in.threadBackfillerFor(cn.Tool)
	switch {
	case f == nil:
		fail(w, r, in.c, blocked("unsupported", "连接器「"+cn.Name+"」不支持补拉串里的回复"))
		return
	case cn.Status == "paused":
		fail(w, r, in.c, blocked("connector_paused", "连接器「"+cn.Name+"」已暂停"))
		return
	case cn.Status == "disconnected":
		fail(w, r, in.c, blocked("connector_disconnected", "连接器「"+cn.Name+"」已断开"))
		return
	}
	if mu := in.pullMu[f.Key()]; mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}
	msgs, st, err := f.BackfillThreads(ctx, id, days)
	if err != nil {
		in.c.Log().Warn("im backfill threads failed", "connector", id, "err", err)
		fail(w, r, in.c, &actionError{status: http.StatusBadGateway, code: "backfill_failed", msg: "补拉失败：" + err.Error()})
		return
	}
	res := BackfillThreadsResult{ConnectorID: id, Days: days, ThreadsChecked: st.ThreadsChecked, Pending: st.Pending, Complete: st.Complete}
	if len(msgs) > 0 {
		got, err := in.ingest(ctx, f, msgs, false)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		res.RepliesAdded = len(got.IDs)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res})
}
