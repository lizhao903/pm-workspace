// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

// Slack 串里的回复（0010）。在串里回复、没勾「同时发送到频道」的消息不在 conversations.history 里，
// 只能按串调 conversations.replies 取。工作台不在公网上时收不到事件订阅，只能靠拉取，所以拉取时：
//  1. history 拉到的新消息里，带回复的父消息（reply_count > 0 或有 latest_reply）记成要拉的串，从头拉；
//  2. 群组会话（频道、近期活跃的多人私信）每隔 slackThreadScanEvery 翻一页最近 slackThreadWindow 的历史，
//     看哪些串的最新回复比上次拉到的新（老消息下面来了新回复，history 按 oldest 拉是看不到的）；
//     一个会话第一次翻时只记下现有的串、不往回拉（往回补走 backfill-threads），之后新出现回复的串从头拉；
//  3. 有新回复的串调 conversations.replies 只取上次之后的（排除父消息），每轮每个会话至多 slackThreadBudget 个串，剩下的下轮接着拉。
// replies 和 history 同档限流（Tier 3，约每分钟 50 次）：撞上 429 这一轮停下，不算同步失败，下轮接着拉。
// 串里的回复 external_id 和普通消息同一规则（频道:ts），同时发到频道的那条从 history、replies 两边来都是同一条，落库去重。
// 进度在 Slack 的 cursor 里（slackCursor.Threads、ThreadScan），超过 slackThreadWindow、已拉完的串清掉。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// slackThreadScanEvery 是一个会话多久翻一次近期历史找串（测试里改成 0）。
var slackThreadScanEvery = 5 * time.Minute

const (
	slackThreadWindow     = 14 * 24 * time.Hour // 翻多久之内的历史找串；父消息比这早、已拉完的串清出进度
	slackThreadScanBudget = 5                   // 每轮至多翻几个会话（按上次翻的时间轮流）
	slackThreadBudget     = 5                   // 每轮每个会话至多拉几个串
	slackBackfillBudget   = 40                  // 一次补拉至多拉几个串（一分钟的 replies 额度以内）
)

// slackThread 是一个串的进度：L 是看到的最新回复 ts（history 的 latest_reply），S 是已经拉到的。L 比 S 新就要拉。
type slackThread struct {
	L string `json:"l"`
	S string `json:"s,omitempty"`
}

func (t *slackThread) pending() bool { return t.L != "" && (t.S == "" || tsLess(t.S, t.L)) }

// noteThread 记下一条带回复的父消息；不是父消息、没回复的不管。已记过的只把最新回复往后挪，拉到哪不动。
// baseline 为真时新记的串当作已拉完（第一次翻一个会话时只认现有的串，不往回拉）。
func (cur *slackCursor) noteThread(ch string, m slackMsg, baseline bool) {
	if m.TS == "" || (m.ThreadTS != "" && m.ThreadTS != m.TS) {
		return
	}
	latest := m.LatestReply
	if latest == "" && m.ReplyCount == 0 {
		return
	}
	if latest == "" {
		// 只给了回复数没给最新回复：按「有新的」处理，拉一次就知道
		latest = m.TS
	}
	if cur.Threads == nil {
		cur.Threads = map[string]map[string]*slackThread{}
	}
	ts := cur.Threads[ch]
	if ts == nil {
		ts = map[string]*slackThread{}
		cur.Threads[ch] = ts
	}
	t := ts[m.TS]
	if t == nil {
		t = &slackThread{}
		if baseline {
			t.S = latest
		}
		ts[m.TS] = t
	}
	if t.L == "" || tsLess(t.L, latest) {
		t.L = latest
	}
}

// pendingThreads 是一个会话里要拉的串（父消息 ts），早的在前。
func (cur *slackCursor) pendingThreads(ch string) []string {
	var out []string
	for ts, t := range cur.Threads[ch] {
		if t.pending() {
			out = append(out, ts)
		}
	}
	sort.Slice(out, func(i, j int) bool { return tsLess(out[i], out[j]) })
	return out
}

// pruneThreads 清掉父消息早于 slackThreadWindow、已经拉完的串，进度别越存越大。
func (cur *slackCursor) pruneThreads(now time.Time) {
	for ch, ts := range cur.Threads {
		for p, t := range ts {
			if !t.pending() && now.Sub(tsTime(p)) > slackThreadWindow {
				delete(ts, p)
			}
		}
		if len(ts) == 0 {
			delete(cur.Threads, ch)
		}
	}
}

// scanOrder 是这一轮要翻近期历史的会话：频道、私有频道，加上近期有过消息的多人私信（私信不翻）；
// 离上次翻够了 slackThreadScanEvery 的，按上次翻的时间从早到晚，至多 slackThreadScanBudget 个。
func (cur *slackCursor) scanOrder(convs []slackConv, now time.Time) []slackConv {
	var out []slackConv
	for _, cv := range convs {
		if cv.IsIM {
			continue
		}
		if l := cur.Latest[cv.ID]; cv.MPIM && (l == "" || now.Sub(tsTime(l)) >= slackActiveWindow) {
			continue
		}
		if last := cur.ThreadScan[cv.ID]; last != 0 && now.Sub(time.Unix(last, 0)) < slackThreadScanEvery {
			continue
		}
		out = append(out, cv)
	}
	sort.SliceStable(out, func(i, j int) bool { return cur.ThreadScan[out[i].ID] < cur.ThreadScan[out[j].ID] })
	return out[:min(len(out), slackThreadScanBudget)]
}

// tsOf 把时间写成 Slack 的 ts（秒.微秒）。
func tsOf(t time.Time) string { return fmt.Sprintf("%d.%06d", t.Unix(), t.Nanosecond()/1000) }

// pullThreads 是拉取一轮里串的部分：翻近期历史找串，再按串拉新回复。回拉到的回复（Channel 已填）和父消息（键是 频道:ts）。
// 撞上限流就停，进度记到停下的地方。
func (s *Slack) pullThreads(ctx context.Context, c plugin.Core, connID string, hc *http.Client, token string, cur *slackCursor,
	convs []slackConv, now time.Time) ([]slackMsg, map[string]slackMsg) {
	if cur.ThreadScan == nil {
		cur.ThreadScan = map[string]int64{}
	}
	defer cur.pruneThreads(now)
	parents := map[string]slackMsg{}
	since := tsOf(now.Add(-slackThreadWindow))
	for _, cv := range cur.scanOrder(convs, now) {
		ms, _, err := s.historyPages(ctx, hc, token, cv.ID, since, 1)
		if slackRateLimited(err) {
			c.Log().Info("slack rate limited while scanning threads, next round", "connector", connID, "conversation", cv.ID, "err", err)
			return nil, parents
		}
		if err != nil {
			// 读不到历史的会话前面 history 已经记过原因，这里不重复报
			continue
		}
		first := cur.ThreadScan[cv.ID] == 0
		for _, m := range ms {
			cur.noteThread(cv.ID, m, first)
		}
		cur.ThreadScan[cv.ID] = now.Unix()
	}
	var got []slackMsg
	for _, cv := range convs {
		pend := cur.pendingThreads(cv.ID)
		for i, p := range pend {
			if i >= slackThreadBudget {
				break
			}
			t := cur.Threads[cv.ID][p]
			parent, rs, more, err := s.replies(ctx, hc, token, cv.ID, p, t.S)
			if slackRateLimited(err) {
				c.Log().Info("slack rate limited while pulling thread replies, next round", "connector", connID, "conversation", cv.ID, "err", err)
				return got, parents
			}
			var se *connector.SlackError
			if errors.As(err, &se) && (se.Code == "thread_not_found" || se.Code == "message_not_found" || se.Code == "channel_not_found") {
				// 父消息删了、会话没了：这个串不再拉
				delete(cur.Threads[cv.ID], p)
				continue
			}
			if err != nil {
				c.Log().Warn("slack thread replies failed, retry next round", "connector", connID, "conversation", cv.ID, "thread", p, "err", err)
				continue
			}
			for _, m := range rs {
				if tsLess(t.S, m.TS) || t.S == "" {
					t.S = m.TS
				}
			}
			if !more && (t.S == "" || tsLess(t.S, t.L)) {
				// 拉完了：最新回复是不收的子类型、已删掉时也算拉到了，免得每轮重拉
				t.S = t.L
			}
			if parent != nil {
				parents[cv.ID+":"+p] = *parent
			}
			got = append(got, rs...)
		}
	}
	return got, parents
}

// replies 拉一个串里 oldest 之后的回复（不含父消息、不含 oldest），按时间正序；Channel 已填。
// parent 是父消息（对方给了才有）；more 为真时翻页到顶还没拉完，下轮接着拉。
func (s *Slack) replies(ctx context.Context, hc *http.Client, token, ch, ts, oldest string) (*slackMsg, []slackMsg, bool, error) {
	var (
		parent *slackMsg
		got    []slackMsg
		next   string
		more   bool
	)
	for page := 0; page < slackMaxPages; page++ {
		q := url.Values{"channel": {ch}, "ts": {ts}, "limit": {strconv.Itoa(slackPageLimit)}}
		if oldest != "" {
			q.Set("oldest", oldest)
		}
		if next != "" {
			q.Set("cursor", next)
		}
		var out struct {
			Messages []slackMsg `json:"messages"`
			HasMore  bool       `json:"has_more"`
			Meta     struct {
				Next string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := s.call(ctx, hc, token, "conversations.replies", q, &out); err != nil {
			if page > 0 && slackRateLimited(err) {
				// 翻到一半被限流：拿到的先收，下轮接着拉
				more = true
				break
			}
			return nil, nil, false, err
		}
		for i := range out.Messages {
			m := out.Messages[i]
			m.Channel = ch
			if m.TS == ts {
				parent = &m
				continue
			}
			if oldest != "" && !tsLess(oldest, m.TS) {
				continue
			}
			got = append(got, m)
		}
		more = out.HasMore && out.Meta.Next != ""
		if !more {
			break
		}
		next = out.Meta.Next
	}
	sort.SliceStable(got, func(i, j int) bool { return tsLess(got[i].TS, got[j].TS) })
	return parent, got, more, nil
}

// threadIncoming 把拉到的串里回复翻成 Incoming，带上父消息的发信人和正文快照。
func (s *Slack) threadIncoming(connID string, me connector.SlackIdentity, as, self string, rs []slackMsg, parents map[string]slackMsg) []Incoming {
	var out []Incoming
	for _, m := range rs {
		cv, known := s.conv(m.Channel)
		in, ok := s.toIncoming(connID, me, as, self, cv, known, m)
		if !ok {
			continue
		}
		if p, ok := parents[in.ThreadParentID]; ok {
			in.ThreadParentSender = s.userName(p.User)
			if in.ThreadParentSender == "" {
				in.ThreadParentSender = p.botName()
			}
			in.ThreadParentText = clip(strings.Join(strings.Fields(s.plainText(p.body())), " "), threadTextMax)
			mine := me.UserID != "" && p.User == me.UserID
			if me.BotID != "" && p.BotID == me.BotID {
				mine = true
			}
			in.ThreadParentMine = in.ThreadParentMine || mine
		}
		out = append(out, in)
	}
	return out
}

func mapValues[K comparable, V any](m map[K]V) []V {
	out := make([]V, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// BackfillThreads 一次性把最近 days 天里有回复的串补拉回来：群组会话（频道、多人私信）翻 days 天的历史，
// 最新回复在这段时间里、最新那条还没收过的串，调 replies 取这段时间里的回复。不动拉取进度，已收过的落库时去重。
// 一次至多拉 slackBackfillBudget 个串，剩下的记在 pending 里，再调一次接着补；撞上限流停下，拿到的先回。
func (s *Slack) BackfillThreads(ctx context.Context, connectorID string, days int) ([]Incoming, ThreadBackfill, error) {
	c := s.core()
	st := ThreadBackfill{Complete: true}
	if c == nil {
		return nil, st, errors.New("IM 插件还没启用")
	}
	now := time.Now()
	since := tsOf(now.Add(-time.Duration(days) * 24 * time.Hour))
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
		convs, _, err := s.conversations(ctx, hc, token, cfg.Get("channels"))
		if err != nil {
			return err
		}
		type thread struct{ ch, ts string }
		var todo []thread
		for _, cv := range convs {
			if cv.IsIM {
				continue
			}
			ms, _, err := s.historyPages(ctx, hc, token, cv.ID, since, slackMaxPages)
			if slackRateLimited(err) {
				st.Complete = false
				break
			}
			if err != nil {
				c.Log().Warn("slack backfill: history failed", "connector", connectorID, "conversation", cv.ID, "err", err)
				continue
			}
			for _, m := range ms {
				if m.ThreadTS != m.TS || m.LatestReply == "" || tsLess(m.LatestReply, since) {
					continue
				}
				done, err := s.received(ctx, c, cv.ID+":"+m.LatestReply)
				if err != nil {
					return err
				}
				if !done {
					todo = append(todo, thread{cv.ID, m.TS})
				}
			}
		}
		var got []slackMsg
		parents := map[string]slackMsg{}
		for i, t := range todo {
			if i >= slackBackfillBudget {
				st.Pending = len(todo) - i
				break
			}
			parent, rs, _, err := s.replies(ctx, hc, token, t.ch, t.ts, since)
			if slackRateLimited(err) {
				st.Pending = len(todo) - i
				break
			}
			if err != nil {
				c.Log().Warn("slack backfill: replies failed", "connector", connectorID, "conversation", t.ch, "thread", t.ts, "err", err)
				continue
			}
			st.ThreadsChecked++
			if parent != nil {
				parents[t.ch+":"+t.ts] = *parent
			}
			got = append(got, rs...)
		}
		s.lookupUsers(ctx, hc, token, append(got, mapValues(parents)...))
		out = s.threadIncoming(connectorID, me, as, cfg.Get("self_user_id"), got, parents)
		return nil
	})
	if st.Pending > 0 {
		st.Complete = false
	}
	return out, st, err
}

// received 这条（频道:ts）收过没有：落成了消息，或是我发的（记成了回复）。
func (s *Slack) received(ctx context.Context, c plugin.Core, ext string) (bool, error) {
	var x int
	err := c.Store().QueryRow(ctx, `SELECT 1 FROM im_messages WHERE channel = ? AND external_id = ?
		UNION ALL SELECT 1 FROM im_replies WHERE external_id = ? LIMIT 1`, s.Channel(), ext, ext).Scan(&x)
	if errors.Is(err, plugin.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
