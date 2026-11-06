package im

// Slack 的补全消息（TSK-0724，history.go）：按会话从新往旧翻 conversations.history（latest 往前挪，oldest 是范围起点），
// 翻到的父消息里最新回复在范围里、最新那条还没收过的串，调 conversations.replies 取范围里的回复（同 backfill-threads）。
// 一次至多 historyPageBudget 页、historyThreadBudget 个串；撞上 429 停下，拿到的先回，续补位置记在 HistoryCursor：
// 翻到哪条（Before，不含）；串没来得及拉时停在那条父消息上（Before 含它），续补时从它重翻。

import (
	"context"
	"errors"
	"net/url"
	"sort"
	"strconv"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// historyPageSize 是补全时一页取几条（测试里调小）。
var historyPageSize = slackPageLimit

// BackfillHistory 见 HistoryBackfiller。Token 失效、会话读不到等整次调不了回 error；翻到一半出错（非限流）停下回已拿到的。
func (s *Slack) BackfillHistory(ctx context.Context, connectorID string, q HistoryQuery) ([]Incoming, HistoryPage, error) {
	var pg HistoryPage
	c := s.core()
	if c == nil {
		return nil, pg, errors.New("IM 插件还没启用")
	}
	ch := q.ConversationExternalID
	since := ""
	if !q.Since.IsZero() {
		since = tsOf(q.Since)
	}
	var out []Incoming
	err := c.Connectors().With(ctx, connectorID, func(cfg plugin.ConnectorConfig) error {
		hc, err := s.client()
		if err != nil {
			return err
		}
		token := cfg.Secret("bot_token")
		as := connector.SlackAs(cfg.Get(connector.SlackIdentityField))
		me, err := connector.SlackAuthTest(ctx, hc, s.api, as, token)
		if err != nil {
			return err
		}
		walked := q.Cursor.Walked
		before, incl := q.Cursor.Before, q.Cursor.Inclusive
		stop := func(b string, i bool) { pg.Next = HistoryCursor{Before: b, Inclusive: i, Walked: walked} }
		threadsLeft := historyThreadBudget
		var got, replies []slackMsg
		parents := map[string]slackMsg{}
	pages:
		for page := 0; ; page++ {
			if q.Cap > 0 && walked >= q.Cap {
				pg.Capped = true
				break
			}
			if page >= historyPageBudget {
				stop(before, incl)
				break
			}
			limit := historyPageSize
			if q.Cap > 0 {
				limit = min(limit, q.Cap-walked)
			}
			params := url.Values{"channel": {ch}, "limit": {strconv.Itoa(limit)}}
			if before != "" {
				params.Set("latest", before)
				if incl {
					params.Set("inclusive", "true")
				}
			}
			if since != "" {
				params.Set("oldest", since)
			}
			var res struct {
				Messages []slackMsg `json:"messages"`
				HasMore  bool       `json:"has_more"`
			}
			if err := s.call(ctx, hc, token, "conversations.history", params, &res); err != nil {
				if slackRateLimited(err) {
					pg.Limited = true
					stop(before, incl)
					break
				}
				if len(got) == 0 && len(replies) == 0 {
					return err
				}
				c.Log().Warn("slack history backfill stopped", "connector", connectorID, "conversation", ch, "err", err)
				stop(before, incl)
				break
			}
			// 对方按时间倒序给，这里再保险排一次
			sort.SliceStable(res.Messages, func(i, j int) bool { return tsLess(res.Messages[j].TS, res.Messages[i].TS) })
			for _, m := range res.Messages {
				if m.TS == "" {
					continue
				}
				m.Channel = ch
				if m.ThreadTS == m.TS && m.LatestReply != "" && (since == "" || !tsLess(m.LatestReply, since)) {
					done, err := s.received(ctx, c, ch+":"+m.LatestReply)
					if err != nil {
						return err
					}
					if !done {
						if threadsLeft == 0 {
							stop(m.TS, true)
							break pages
						}
						parent, rs, _, err := s.replies(ctx, hc, token, ch, m.TS, since)
						if slackRateLimited(err) {
							pg.Limited = true
							stop(m.TS, true)
							break pages
						}
						if err != nil {
							c.Log().Warn("slack history backfill: replies failed", "connector", connectorID, "conversation", ch, "thread", m.TS, "err", err)
						} else {
							threadsLeft--
							pg.Threads++
							if parent != nil {
								parents[ch+":"+m.TS] = *parent
							}
							replies = append(replies, rs...)
						}
					}
				}
				got = append(got, m)
				walked++
				pg.Scanned++
				before, incl = m.TS, false
			}
			if !res.HasMore || len(res.Messages) == 0 {
				pg.Done = true
				break
			}
		}
		s.lookupUsers(ctx, hc, token, append(append(got, replies...), mapValues(parents)...))
		cv, known := s.conv(ch)
		for _, m := range got {
			if in, ok := s.toIncoming(connectorID, me, as, cfg.Get("self_user_id"), cv, known, m); ok {
				out = append(out, in)
			}
		}
		out = append(out, s.threadIncoming(connectorID, me, as, cfg.Get("self_user_id"), replies, parents)...)
		return nil
	})
	if err != nil {
		return nil, pg, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, pg, nil
}
