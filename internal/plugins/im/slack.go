package im

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Slack 渠道（IM-01b）：Slack App 的 Bot Token（xoxb-）方式。连接器定义由本插件登记（tool slack，connector.Slack），
// Bot Token、Signing Secret 在连接器的保险箱条目里，调用时经 Core.Connectors().With 现取。
// 两种收法：事件订阅（Events API）推到 POST /api/im/callbacks/slack，按 Signing Secret 验签；
// 回调不可达时（工作台不在公网上）按连接器的同步间隔拉 conversations.history，进度存在 im_cursors。
// 可以接多个工作区（IM-01d）：每个实例各拉各的、各记各的同步结果，回调按签名认实例，回复走消息所属的实例。
// 收的范围：私信和多人私信，加上「监听频道」里列的频道（Bot 要先被加进频道）。
// 身份（IM-06）：连接器选「我本人」时 Token 是本人的 User Token（xoxp-），auth.test 回的就是本人：列的是本人所在的会话，
// @本人 算 @我（不用填 Member ID），回复以本人名义发出；本人自己发的不进待处理，记成那条会话里最近一条消息的回复（FromSelf）。
// 出网走 Core.HTTP("im")（域名清单里有 slack.com、*.slack.com）。回复走 chat.postMessage，附件按 url_private_download 下载。

const (
	slackPullTick    = 30 * time.Second // 后台多久看一次到没到同步间隔
	slackFirstLimit  = 20               // 一个频道第一次拉时只取最近这么多条，不翻全部历史
	slackPageLimit   = 200
	slackMaxPages    = 5 // 一个频道一次最多翻几页，剩下的下一轮接着拉
	slackConvPages   = 10
	slackMaxBody     = 1 << 20
	slackNameCacheN  = 2000
	slackLookupLimit = 50 // 一次同步最多查几个人名，查不到的先用编号
	// 本人身份一列就是几百个私信，每轮都逐个读历史必撞限流（conversations.history 约每分钟 50 次）。
	// 监听频道和这段时间里有过消息的会话每轮都拉；其余的按上次查过的时间轮流查，每轮至多 slackIdleBudget 个
	slackActiveWindow = 7 * 24 * time.Hour
	slackIdleBudget   = 20
)

// Slack 是 Slack 适配器，cmd/pmw 交给 New。每个 slack 连接器实例是一个工作区的 Bot（IM-01d）。
type Slack struct {
	api string
	c   plugin.Core

	mu       sync.Mutex
	lastPull map[string]time.Time // 连接器 id -> 上次拉的时间
	teams    map[string]string    // 连接器 id -> 工作区编号，回调按 team_id 认实例用
	users    map[string]string    // Member ID -> 显示名
	convs    map[string]slackConv // 会话 id -> 会话
	mail     slackMail            // 资料里的邮箱和各实例有没有读邮箱的权限（slackemail.go）
}

// SlackOptions：API 是 Web API 的根，空串取正式地址 https://slack.com/api。
// 联调时不改它，用 pmw --dev-upstream slack.com=<假服务地址> 把出网改投到本机假服务端（域名检查在改投之前照常做）。
type SlackOptions struct {
	API string
}

func NewSlack(o SlackOptions) *Slack {
	return &Slack{api: connector.SlackEndpoints{API: o.API}.Base(), lastPull: map[string]time.Time{}, teams: map[string]string{},
		users: map[string]string{}, convs: map[string]slackConv{}}
}

func (s *Slack) Key() string             { return connector.SlackTool }
func (s *Slack) Channel() string         { return connector.SlackTool }
func (s *Slack) Interval() time.Duration { return slackPullTick }

func (s *Slack) Bind(c plugin.Core) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.c = c
}

func (s *Slack) core() plugin.Core {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.c
}

// ConnectorDef 的连通测试也走插件的出网客户端。
func (s *Slack) ConnectorDef() plugin.ConnectorDef {
	return connector.Slack(connector.SlackEndpoints{API: s.api, Client: s.client})
}

func (s *Slack) client() (*http.Client, error) {
	c := s.core()
	if c == nil {
		return nil, errors.New("IM 插件还没启用")
	}
	return c.HTTP("im")
}

// instance 是最新建的 slack 实例，只给不带 connector_id 的旧消息回复、取附件用；没有时 ok 为 false。
func (s *Slack) instance(ctx context.Context) (plugin.ConnectorInfo, bool, error) {
	list, err := instancesOf(ctx, s.core(), connector.SlackTool)
	if err != nil || len(list) == 0 {
		return plugin.ConnectorInfo{}, false, err
	}
	return list[0], true, nil
}

func inactive(cn plugin.ConnectorInfo) bool {
	return cn.Status == "paused" || cn.Status == "disconnected"
}

// Due：有实例在用、设了同步间隔（分钟），离它上次拉够了间隔。间隔为 0 时只收回调和立即同步。
func (s *Slack) Due(ctx context.Context, now time.Time) bool {
	list, err := instancesOf(ctx, s.core(), connector.SlackTool)
	if err != nil {
		return false
	}
	for _, cn := range list {
		if s.due(cn, now) {
			return true
		}
	}
	return false
}

func (s *Slack) due(cn plugin.ConnectorInfo, now time.Time) bool {
	if inactive(cn) || cn.Interval <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	last := s.lastPull[cn.ID]
	return last.IsZero() || now.Sub(last) >= time.Duration(cn.Interval)*time.Minute
}

// slackCursor 是一个实例的进度：哪个实例、哪个工作区，每个会话拉到的最后一条 ts。工作区换了从头来。
type slackCursor struct {
	Connector string            `json:"connector"`
	Team      string            `json:"team"`
	Latest    map[string]string `json:"latest"`
	Checked   map[string]int64  `json:"checked,omitempty"` // 会话 -> 上次读过历史的时间（Unix 秒），轮流查不活跃会话用
	// 串里的回复（0010，slackthreads.go）：会话 -> 父消息 ts -> 这个串的进度；会话 -> 上次翻近期历史找串的时间（Unix 秒）
	Threads    map[string]map[string]*slackThread `json:"threads,omitempty"`
	ThreadScan map[string]int64                   `json:"thread_scan,omitempty"`
}

// pullOrder 排这一轮要读历史的会话：监听频道和 slackActiveWindow 里有过消息的全拉，其余取至多 slackIdleBudget 个。
// 两组都按上次查过的时间从早到晚（从没查过的最先）：限流总在第几十个截断，固定顺序会让排在后面的永远轮不到。
func (cur slackCursor) pullOrder(convs []slackConv, now time.Time) []slackConv {
	var active, idle []slackConv
	for _, cv := range convs {
		l := cur.Latest[cv.ID]
		if !(cv.IsIM || cv.MPIM) || (l != "" && now.Sub(tsTime(l)) < slackActiveWindow) {
			active = append(active, cv)
			continue
		}
		idle = append(idle, cv)
	}
	byChecked := func(cs []slackConv) {
		sort.SliceStable(cs, func(i, j int) bool { return cur.Checked[cs[i].ID] < cur.Checked[cs[j].ID] })
	}
	byChecked(active)
	byChecked(idle)
	return append(active, idle[:min(len(idle), slackIdleBudget)]...)
}

// slackRateLimited 是不是被 Slack 限流：等一会儿自己就好，这一轮停下，剩下的下一轮接着拉，不记成异常。
func slackRateLimited(err error) bool {
	var se *connector.SlackError
	return errors.As(err, &se) && se.RateLimited()
}

// slackConv 是一个会话：im 是私信，mpim 是多人私信，别的是频道。
type slackConv struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	IsIM bool   `json:"is_im"`
	MPIM bool   `json:"is_mpim"`
	User string `json:"user"` // 私信的对方
}

func (c slackConv) kind() string {
	if c.IsIM {
		return "direct"
	}
	return "group"
}

func (c slackConv) title() string {
	switch {
	case c.IsIM:
		return ""
	case c.MPIM:
		return "多人私信"
	}
	return "#" + c.Name
}

// label 是报错里指认会话用的名字：私信 title 为空，换成「私信」。
func (c slackConv) label() string {
	if c.IsIM {
		return "私信"
	}
	return c.title()
}

// slackMsg 是 conversations.history 和事件里的一条消息。
type slackMsg struct {
	Type     string      `json:"type"`
	Subtype  string      `json:"subtype"`
	User     string      `json:"user"`
	BotID    string      `json:"bot_id"`
	Username string      `json:"username"`
	Text     string      `json:"text"`
	TS       string      `json:"ts"`
	Channel  string      `json:"channel"`
	ChType   string      `json:"channel_type"`
	Files    []slackFile `json:"files"`
	// 机器人、工作流、Incoming Webhook 发的卡片：text 常是空的，内容在 blocks 或旧版 attachments 里
	Blocks      []slackBlock      `json:"blocks"`
	Attachments []slackAttachment `json:"attachments"`
	BotProfile  *struct {
		Name string `json:"name"`
	} `json:"bot_profile"`
	// 串（0010）：父消息的 thread_ts 等于自己的 ts，带回复数和最新回复的 ts；串里的回复 thread_ts 是父消息的 ts，
	// parent_user_id 是父消息的发信人
	ThreadTS    string `json:"thread_ts"`
	ReplyCount  int    `json:"reply_count"`
	LatestReply string `json:"latest_reply"`
	ParentUser  string `json:"parent_user_id"`
}

// slackAttachment 是旧版的消息附件（彩条卡片），不是文件。
type slackAttachment struct {
	AuthorName string `json:"author_name"`
	Pretext    string `json:"pretext"`
	Title      string `json:"title"`
	Text       string `json:"text"`
	Fallback   string `json:"fallback"`
	Footer     string `json:"footer"`
	Fields     []struct {
		Title string `json:"title"`
		Value string `json:"value"`
	} `json:"fields"`
	Blocks []slackBlock `json:"blocks"`
}

// slackBlock 是 Block Kit 的一块，只取看得到的文字：section、header、context、rich_text。
type slackBlock struct {
	Type     string          `json:"type"`
	Text     *slackTextObj   `json:"text"`
	Fields   []slackTextObj  `json:"fields"`
	Elements []slackRichElem `json:"elements"`
}

type slackTextObj struct {
	Text string `json:"text"`
}

// slackRichElem 是 context 的元素或 rich_text 的一层；嵌套的用 Elements 往下走。
type slackRichElem struct {
	Type     string          `json:"type"`
	Text     json.RawMessage `json:"text"`
	URL      string          `json:"url"`
	UserID   string          `json:"user_id"`
	Channel  string          `json:"channel_id"`
	Range    string          `json:"range"`
	Name     string          `json:"name"`
	Elements []slackRichElem `json:"elements"`
}

type slackFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Mimetype string `json:"mimetype"`
	Size     int64  `json:"size"`
	URL      string `json:"url_private_download"`
	Link     string `json:"permalink"`
}

// 收的子类型：普通消息、带文件的、串里回复同时发到频道的、/me。编辑、删除、进出频道之类不收。
var slackSubtypes = []string{"", "file_share", "thread_broadcast", "me_message", "bot_message"}

// call 调一个 Web API 方法；出网错误换成不带地址的说明。
func (s *Slack) call(ctx context.Context, hc *http.Client, token, method string, params url.Values, out any) error {
	err := connector.SlackCall(ctx, hc, s.api, token, method, params, out)
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return errors.New("插件 im 的 network:im 不允许访问这个地址")
	}
	return err
}

// Pull 是后台的一轮：到了同步间隔的实例逐个拉，各自记同步结果；有的实例失败不耽误别的，都失败才算这一轮失败。
// 已删掉的实例的进度顺手清掉。
func (s *Slack) Pull(ctx context.Context, cursor string) ([]Incoming, string, error) {
	list, err := instancesOf(ctx, s.core(), connector.SlackTool)
	if err != nil || len(list) == 0 {
		return nil, cursor, err
	}
	curs := readCursors(cursor)
	keep := map[string]json.RawMessage{}
	var (
		msgs  []Incoming
		errs  []error
		tried int
		now   = time.Now()
	)
	for _, cn := range list {
		if v, ok := curs[cn.ID]; ok {
			keep[cn.ID] = v
		}
		if !s.due(cn, now) {
			continue
		}
		tried++
		got, next, err := s.pullInstance(ctx, cn, keep[cn.ID])
		if ctx.Err() != nil {
			return nil, cursor, ctx.Err()
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		msgs = append(msgs, got...)
		if next != nil {
			keep[cn.ID] = next
		}
	}
	if err := pullErrors(tried, errs); err != nil {
		return nil, cursor, err
	}
	sort.SliceStable(msgs, func(i, j int) bool { return msgs[i].At.Before(msgs[j].At) })
	return msgs, writeCursors(keep), nil
}

// PullConnector 是立即同步：只拉这一个实例，不看同步间隔，别的实例的进度原样留着。
func (s *Slack) PullConnector(ctx context.Context, id, cursor string) ([]Incoming, string, error) {
	c := s.core()
	if c == nil {
		return nil, cursor, nil
	}
	cn, err := c.Connectors().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (cn.Tool != connector.SlackTool || inactive(cn))) {
		return nil, cursor, nil
	}
	if err != nil {
		return nil, cursor, err
	}
	curs := readCursors(cursor)
	msgs, next, err := s.pullInstance(ctx, cn, curs[cn.ID])
	if err != nil {
		return nil, cursor, err
	}
	if next != nil {
		curs[cn.ID] = next
	}
	sort.SliceStable(msgs, func(i, j int) bool { return msgs[i].At.Before(msgs[j].At) })
	return msgs, writeCursors(curs), nil
}

// pullInstance 拉一个实例：auth.test（顺带认出 Token 失效）、列会话、逐个拉新消息。拉完把结果记到这个实例：
// 失败（invalid_auth 等）置为异常并写原因；监听频道里有找不到的也记成异常，找到的照收。
// 回这个实例的新进度；实例已删时 next 为 nil。
func (s *Slack) pullInstance(ctx context.Context, cn plugin.ConnectorInfo, raw json.RawMessage) ([]Incoming, json.RawMessage, error) {
	s.mu.Lock()
	s.lastPull[cn.ID] = time.Now()
	s.mu.Unlock()
	var cur slackCursor
	_ = json.Unmarshal(raw, &cur)
	var (
		msgs []Incoming
		warn error
		next json.RawMessage
		c    = s.core()
	)
	err := c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
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
		s.setTeam(cn.ID, me.TeamID)
		if cur.Connector != cn.ID || cur.Team != me.TeamID || cur.Latest == nil {
			cur = slackCursor{Connector: cn.ID, Team: me.TeamID, Latest: map[string]string{}}
		}
		if cur.Checked == nil {
			cur.Checked = map[string]int64{}
		}
		convs, missing, err := s.conversations(ctx, hc, token, cfg.Get("channels"))
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			who := "Bot 没被加进去"
			if as == connector.SlackAsUser {
				who = "你不在里面"
			}
			warn = fmt.Errorf("这些频道找不到或%s：%s", who, strings.Join(missing, "、"))
		}
		var got []slackMsg
		var convWarn []string
		now := time.Now()
		limited := false
		for _, cv := range cur.pullOrder(convs, now) {
			ms, latest, err := s.history(ctx, hc, token, cv.ID, cur.Latest[cv.ID])
			if slackRateLimited(err) {
				c.Log().Info("slack rate limited, rest of conversations next round", "connector", cn.ID, "conversation", cv.ID, "err", err)
				limited = true
				break
			}
			if err != nil {
				// 单个会话拉取失败不阻断整实例，继续拉别的会话。私信、多人私信是 Slack 自己列出来的，
				// 读不到（对方已停用、跨工作区的 Slack Connect 私信等）用户也没法处理，只记日志不置异常；
				// 监听频道读不到才记成异常，写明是哪个
				var se *connector.SlackError
				if (cv.IsIM || cv.MPIM) && errors.As(err, &se) && (se.Code == "channel_not_found" || se.Code == "not_in_channel") {
					c.Log().Warn("slack conversation unreadable, skipped", "connector", cn.ID, "conversation", cv.ID, "code", se.Code)
					continue
				}
				convWarn = append(convWarn, fmt.Sprintf("%s（%s）：%v", cv.label(), cv.ID, err))
				continue
			}
			if latest != "" {
				cur.Latest[cv.ID] = latest
			}
			cur.Checked[cv.ID] = now.Unix()
			for i := range ms {
				ms[i].Channel = cv.ID
				// 新到的父消息带着回复：这个串从头拉
				cur.noteThread(cv.ID, ms[i], false)
			}
			got = append(got, ms...)
		}
		if warn == nil && len(convWarn) > 0 {
			warn = fmt.Errorf("部分会话没拉到：%s", strings.Join(convWarn, "；"))
		}
		// 串里的回复：不在 history 里，翻近期历史找有新回复的串，再按串拉（slackthreads.go）
		var parents map[string]slackMsg
		var replies []slackMsg
		if !limited {
			replies, parents = s.pullThreads(ctx, c, cn.ID, hc, token, &cur, convs, now)
		}
		s.lookupUsers(ctx, hc, token, append(append(got, replies...), mapValues(parents)...))
		for _, m := range got {
			cv, known := s.conv(m.Channel)
			if in, ok := s.toIncoming(cn.ID, me, as, cfg.Get("self_user_id"), cv, known, m); ok {
				msgs = append(msgs, in)
			}
		}
		msgs = append(msgs, s.threadIncoming(cn.ID, me, as, cfg.Get("self_user_id"), replies, parents)...)
		next, _ = json.Marshal(cur)
		return nil
	})
	if ctx.Err() != nil {
		return nil, nil, ctx.Err()
	}
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, nil, nil
	}
	if slackRateLimited(err) {
		// auth.test、列会话就被限流：这一轮什么都没拉，进度和连接器状态都不动
		c.Log().Info("slack rate limited, skip this round", "connector", cn.ID, "err", err)
		return nil, nil, nil
	}
	rec := err
	if rec == nil {
		rec = warn
	}
	if _, rerr := c.Connectors().RecordSync(ctx, cn.ID, rec); rerr != nil {
		c.Log().Warn("record slack sync failed", "connector", cn.ID, "err", rerr)
	}
	if err != nil {
		return nil, nil, err
	}
	return msgs, next, nil
}

// conversations 列 Token 身份（Bot 或本人）所在的会话：私信、多人私信全收，频道只收 channels 里列的（名字或编号，# 可带可不带）。
// 回列出来的会话和没找到的频道。
func (s *Slack) conversations(ctx context.Context, hc *http.Client, token, channels string) ([]slackConv, []string, error) {
	want := splitChannels(channels)
	types := "im,mpim"
	if len(want) > 0 {
		types = "public_channel,private_channel,im,mpim"
	}
	var all []slackConv
	next := ""
	for page := 0; page < slackConvPages; page++ {
		q := url.Values{"types": {types}, "exclude_archived": {"true"}, "limit": {strconv.Itoa(slackPageLimit)}}
		if next != "" {
			q.Set("cursor", next)
		}
		var out struct {
			Channels []slackConv `json:"channels"`
			Meta     struct {
				Next string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := s.call(ctx, hc, token, "users.conversations", q, &out); err != nil {
			return nil, nil, err
		}
		all = append(all, out.Channels...)
		if next = out.Meta.Next; next == "" {
			break
		}
	}
	found := map[string]bool{}
	var keep []slackConv
	for _, cv := range all {
		s.remember(cv)
		if cv.IsIM || cv.MPIM {
			// 私信、多人私信本来就全收；监听频道里勾了多人私信（列表里能选）也算找到，不报找不到
			for _, w := range want {
				if w == cv.ID || (cv.MPIM && strings.EqualFold(w, cv.Name)) {
					found[w] = true
				}
			}
			keep = append(keep, cv)
			continue
		}
		for _, w := range want {
			if strings.EqualFold(w, cv.Name) || w == cv.ID {
				keep = append(keep, cv)
				found[w] = true
			}
		}
	}
	var missing []string
	for _, w := range want {
		if !found[w] {
			missing = append(missing, "#"+w)
		}
	}
	return keep, missing, nil
}

// splitChannels 拆「监听频道」：逗号、顿号、空白分隔，去掉开头的 #，去重。
func splitChannels(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '，' || r == '、' || r == ' ' || r == '\n' || r == '\t' }) {
		p = strings.TrimPrefix(strings.TrimSpace(p), "#")
		if p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

// slackListPages 是列会话给「监听频道」选时最多翻几页（每页 slackPageLimit 个），再多就标为不完整。
const slackListPages = 25

// ListConversations 列这个实例的 Token 身份所在的群组会话（公开频道、私有频道、多人私信，含已归档），给「监听频道」选。
// 用 users.conversations：拉取时也是按它认会话，列出来的就是选了能收到的（Bot 没被加进的频道不在里面）。
// 翻页途中被限流或页数到顶时回已拿到的，Complete 为 false；第一页就失败回错误。
func (s *Slack) ListConversations(ctx context.Context, connectorID string) (ConversationList, error) {
	c := s.core()
	if c == nil {
		return ConversationList{}, errors.New("IM 插件还没启用")
	}
	res := ConversationList{ConnectorID: connectorID, Complete: true}
	err := c.Connectors().With(ctx, connectorID, func(cfg plugin.ConnectorConfig) error {
		token := cfg.Secret("bot_token")
		if strings.TrimSpace(token) == "" {
			return errNoToken
		}
		hc, err := s.client()
		if err != nil {
			return err
		}
		next := ""
		for page := 0; ; page++ {
			if page == slackListPages {
				res.Complete = false
				res.Note = fmt.Sprintf("会话太多，只列出了前 %d 个；没列出的可以在文本框里直接填编号或 #名字", len(res.Items))
				break
			}
			q := url.Values{"types": {"public_channel,private_channel,mpim"}, "exclude_archived": {"false"}, "limit": {strconv.Itoa(slackPageLimit)}}
			if next != "" {
				q.Set("cursor", next)
			}
			var out struct {
				Channels []struct {
					slackConv
					IsPrivate  bool  `json:"is_private"`
					IsGroup    bool  `json:"is_group"`
					IsArchived bool  `json:"is_archived"`
					IsMember   *bool `json:"is_member"`
				} `json:"channels"`
				Meta struct {
					Next string `json:"next_cursor"`
				} `json:"response_metadata"`
			}
			if err := s.call(ctx, hc, token, "users.conversations", q, &out); err != nil {
				if page > 0 && slackRateLimited(err) {
					res.Complete = false
					res.Note = fmt.Sprintf("Slack 限流，只列出了前 %d 个，稍后再刷新", len(res.Items))
					break
				}
				return err
			}
			for _, ch := range out.Channels {
				if ch.IsIM {
					continue
				}
				s.remember(ch.slackConv)
				kind := ConvPublic
				switch {
				case ch.MPIM:
					kind = ConvMPIM
				case ch.IsPrivate || ch.IsGroup:
					kind = ConvPrivate
				}
				// users.conversations 只回所在的会话，没给 is_member 时按在里面算
				member := ch.IsMember == nil || *ch.IsMember
				res.Items = append(res.Items, ConversationOption{ID: ch.ID, Name: ch.Name, Kind: kind, IsMember: member, IsArchived: ch.IsArchived})
			}
			if next = out.Meta.Next; next == "" {
				break
			}
		}
		return nil
	})
	if err != nil {
		return ConversationList{}, err
	}
	// 频道在前、多人私信在后，各自按名字排
	sort.SliceStable(res.Items, func(i, j int) bool {
		a, b := res.Items[i], res.Items[j]
		if (a.Kind == ConvMPIM) != (b.Kind == ConvMPIM) {
			return b.Kind == ConvMPIM
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return res, nil
}

// history 拉一个会话 oldest 之后的消息（不含 oldest），回按时间正序的消息和拉到的最新 ts。
// 第一次拉（oldest 为空）只取最近 slackFirstLimit 条。
func (s *Slack) history(ctx context.Context, hc *http.Client, token, ch, oldest string) ([]slackMsg, string, error) {
	return s.historyPages(ctx, hc, token, ch, oldest, slackMaxPages)
}

// historyPages 同 history，最多翻 pages 页。
func (s *Slack) historyPages(ctx context.Context, hc *http.Client, token, ch, oldest string, pages int) ([]slackMsg, string, error) {
	var got []slackMsg
	next := ""
	for page := 0; page < pages; page++ {
		q := url.Values{"channel": {ch}, "limit": {strconv.Itoa(slackPageLimit)}}
		if oldest != "" {
			q.Set("oldest", oldest)
		} else {
			q.Set("limit", strconv.Itoa(slackFirstLimit))
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
		if err := s.call(ctx, hc, token, "conversations.history", q, &out); err != nil {
			return nil, "", err
		}
		got = append(got, out.Messages...)
		if oldest == "" || !out.HasMore || out.Meta.Next == "" {
			break
		}
		next = out.Meta.Next
	}
	// 对方按时间倒序给；ts 是定长小数，按数值排
	sort.SliceStable(got, func(i, j int) bool { return tsLess(got[i].TS, got[j].TS) })
	latest := oldest
	for _, m := range got {
		if m.TS != "" && (latest == "" || tsLess(latest, m.TS)) {
			latest = m.TS
		}
	}
	if oldest != "" {
		// oldest 本身不算（对方默认不含，这里再保险一次）
		got = slices.DeleteFunc(got, func(m slackMsg) bool { return !tsLess(oldest, m.TS) })
	}
	return got, latest, nil
}

func tsLess(a, b string) bool {
	x, _ := strconv.ParseFloat(a, 64)
	y, _ := strconv.ParseFloat(b, 64)
	return x < y
}

func tsTime(ts string) time.Time {
	sec, frac, _ := strings.Cut(ts, ".")
	n, err := strconv.ParseInt(sec, 10, 64)
	if err != nil {
		return time.Time{}
	}
	us, _ := strconv.ParseInt((frac + "000000")[:6], 10, 64)
	return time.Unix(n, us*1000).UTC()
}

func (s *Slack) remember(cv slackConv) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.convs) >= slackNameCacheN {
		s.convs = map[string]slackConv{}
	}
	s.convs[cv.ID] = cv
}

func (s *Slack) conv(id string) (slackConv, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cv, ok := s.convs[id]
	return cv, ok
}

func (s *Slack) userName(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.users[id]
}

// mentionRe 认正文里的 <@U123>、<@U123|name>。
var mentionRe = regexp.MustCompile(`<@([UW][A-Z0-9]+)(?:\|[^>]*)?>`)

// lookupUsers 查这批消息里发送人和被 @ 的人的名字，记进缓存（slacknames.go 的 lookupOne）；查不到的不报错，显示编号。
func (s *Slack) lookupUsers(ctx context.Context, hc *http.Client, token string, msgs []slackMsg) {
	need := []string{}
	for _, m := range msgs {
		ids := []string{m.User}
		for _, x := range mentionRe.FindAllStringSubmatch(m.Text, -1) {
			ids = append(ids, x[1])
		}
		for _, id := range ids {
			if id != "" && s.userName(id) == "" && !slices.Contains(need, id) {
				need = append(need, id)
			}
		}
	}
	for i, id := range need {
		if i >= slackLookupLimit || ctx.Err() != nil {
			return
		}
		// 撞上限流后面的也查不到，停下（TSK-0494）；查不到的名字之后收到这个人的消息、或群组管理「查询回填」时补回
		if _, err := s.lookupOne(ctx, hc, token, id); slackRateLimited(err) {
			return
		}
	}
}

// toIncoming 把一条 Slack 消息翻成 Incoming；不收的子类型、没有发送人的跳过。Bot 身份时 Bot 自己发的跳过；
// 我本人身份（as 为 SlackAsUser）时本人发的标成 FromSelf，插件不把它当新消息，记成会话里的回复。
func (s *Slack) toIncoming(connID string, me connector.SlackIdentity, as, self string, cv slackConv, known bool, m slackMsg) (Incoming, bool) {
	if !slices.Contains(slackSubtypes, m.Subtype) || m.TS == "" || m.Channel == "" {
		return Incoming{}, false
	}
	mine := me.UserID != "" && m.User == me.UserID
	if (mine && as != connector.SlackAsUser) || (me.BotID != "" && m.BotID == me.BotID) {
		return Incoming{}, false
	}
	sender, name := m.User, s.userName(m.User)
	if sender == "" {
		sender, name = m.BotID, m.botName()
	}
	if sender == "" {
		return Incoming{}, false
	}
	raw := m.body()
	if !known {
		// 事件里的会话还没列过：按 channel_type 猜
		cv = slackConv{ID: m.Channel, IsIM: m.ChType == "im", MPIM: m.ChType == "mpim"}
	}
	in := Incoming{
		ExternalID: m.Channel + ":" + m.TS, ConnectorID: connID,
		ConversationID: m.Channel, ConversationKind: cv.kind(), ConversationName: cv.title(),
		SenderID: sender, SenderName: name, Text: s.plainText(raw), At: tsTime(m.TS),
		Mention:  slackMention(raw, me.UserID, strings.TrimSpace(self)),
		FromSelf: mine,
	}
	if m.ThreadTS != "" && m.ThreadTS != m.TS {
		// 串里的回复（含同时发到频道的）：记下父消息；父消息是我（本人或 Bot）发的算我发起的串
		in.ThreadParentID = m.Channel + ":" + m.ThreadTS
		in.ThreadParentMine = m.ParentUser != "" && m.ParentUser == me.UserID
	}
	if cv.IsIM {
		in.ConversationName = ""
	}
	if len(m.Files) > 0 {
		atts := make([]map[string]any, 0, len(m.Files))
		for _, f := range m.Files {
			kind := "file"
			if strings.HasPrefix(f.Mimetype, "image/") {
				kind = "image"
			}
			name := f.Name
			if name == "" {
				name = f.Title
			}
			atts = append(atts, map[string]any{"id": f.ID, "name": name, "kind": kind, "size": f.Size, "url": f.Link,
				"url_private_download": f.URL})
		}
		in.Attachments, _ = json.Marshal(atts)
	}
	return in, true
}

// botName 是机器人消息的发送人名字：自定的 username，没有用 App 的名字，再没有用卡片的作者名。
func (m slackMsg) botName() string {
	if m.Username != "" {
		return m.Username
	}
	if m.BotProfile != nil && m.BotProfile.Name != "" {
		return m.BotProfile.Name
	}
	for _, a := range m.Attachments {
		if a.AuthorName != "" {
			return a.AuthorName
		}
	}
	return ""
}

// body 是消息的完整正文（还是 Slack 的标记写法）：text 有就用，空的从 blocks 拼；
// 再接上旧版 attachments 卡片里的文字（反馈机器人、告警之类全在这里，text 是空的）。
func (m slackMsg) body() string {
	parts := []string{strings.TrimSpace(m.Text)}
	if parts[0] == "" {
		parts[0] = blocksText(m.Blocks)
	}
	for _, a := range m.Attachments {
		parts = append(parts, a.body())
	}
	return joinNonEmpty(parts, "\n\n")
}

func (a slackAttachment) body() string {
	lines := []string{a.Pretext, a.Title, a.Text}
	for _, f := range a.Fields {
		switch {
		case f.Title != "" && f.Value != "":
			lines = append(lines, f.Title+"："+f.Value)
		default:
			lines = append(lines, f.Title+f.Value)
		}
	}
	lines = append(lines, blocksText(a.Blocks))
	out := joinNonEmpty(lines, "\n")
	if out == "" {
		out = strings.TrimSpace(a.Fallback)
	}
	return joinNonEmpty([]string{out, a.Footer}, "\n")
}

// blocksText 把 Block Kit 里看得到的文字按块拼成几行；按钮、图片、分隔线不要。
func blocksText(blocks []slackBlock) string {
	lines := make([]string, 0, len(blocks))
	for _, b := range blocks {
		switch b.Type {
		case "section", "header":
			var ls []string
			if b.Text != nil {
				ls = append(ls, b.Text.Text)
			}
			for _, f := range b.Fields {
				ls = append(ls, f.Text)
			}
			lines = append(lines, joinNonEmpty(ls, "\n"))
		case "context":
			var ls []string
			for _, e := range b.Elements {
				ls = append(ls, elemString(e.Text))
			}
			lines = append(lines, joinNonEmpty(ls, " "))
		case "rich_text":
			var sb strings.Builder
			richText(&sb, b.Elements)
			lines = append(lines, sb.String())
		}
	}
	return joinNonEmpty(lines, "\n")
}

// richText 把 rich_text 的元素写回 Slack 的标记写法，交给 plainText 统一换成看得懂的。
func richText(sb *strings.Builder, els []slackRichElem) {
	for i, e := range els {
		switch e.Type {
		case "text":
			sb.WriteString(elemString(e.Text))
		case "link":
			if t := elemString(e.Text); t != "" {
				sb.WriteString("<" + e.URL + "|" + t + ">")
			} else {
				sb.WriteString("<" + e.URL + ">")
			}
		case "user":
			sb.WriteString("<@" + e.UserID + ">")
		case "channel":
			sb.WriteString("<#" + e.Channel + ">")
		case "broadcast":
			sb.WriteString("<!" + e.Range + ">")
		case "emoji":
			sb.WriteString(":" + e.Name + ":")
		case "rich_text_list":
			for _, item := range e.Elements {
				sb.WriteString("• ")
				richText(sb, item.Elements)
				sb.WriteString("\n")
			}
		default:
			// rich_text_section、rich_text_quote、rich_text_preformatted：往下走，段与段之间换行
			richText(sb, e.Elements)
			if i < len(els)-1 && !strings.HasSuffix(sb.String(), "\n") {
				sb.WriteString("\n")
			}
		}
	}
}

// elemString 取元素的 text：rich_text 里是字符串，context 里是 {text: …} 对象。
func elemString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var o slackTextObj
	_ = json.Unmarshal(raw, &o)
	return o.Text
}

func joinNonEmpty(parts []string, sep string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// slackMention：@ 到 Bot 或「我的 Member ID」算 me，<!here> <!channel> <!everyone> 算 all；都没有为空，交给正文判断。
func slackMention(text, bot, self string) string {
	for _, x := range mentionRe.FindAllStringSubmatch(text, -1) {
		if (bot != "" && x[1] == bot) || (self != "" && x[1] == self) {
			return "me"
		}
	}
	for _, h := range []string{"<!here", "<!channel", "<!everyone"} {
		if strings.Contains(text, h) {
			return "all"
		}
	}
	return ""
}

// slackTokenRe 认 Slack 正文里的尖括号写法。
var slackTokenRe = regexp.MustCompile(`<([^<>]+)>`)

// plainText 把 Slack 的标记换成看得懂的：<@U1> → @名字，<#C1|product> → #product，<!here> → @here，
// <https://x|说明> → 说明 (https://x)；再还原 &lt; &gt; &amp;。
func (s *Slack) plainText(text string) string {
	out := slackTokenRe.ReplaceAllStringFunc(text, func(tok string) string {
		body := tok[1 : len(tok)-1]
		ref, label, _ := strings.Cut(body, "|")
		switch {
		case strings.HasPrefix(ref, "@"):
			if label == "" {
				label = s.userName(ref[1:])
			}
			if label == "" {
				label = ref[1:]
			}
			return "@" + strings.TrimPrefix(label, "@")
		case strings.HasPrefix(ref, "#"):
			if label == "" {
				if cv, ok := s.conv(ref[1:]); ok {
					label = cv.Name
				}
			}
			if label == "" {
				label = ref[1:]
			}
			return "#" + label
		case strings.HasPrefix(ref, "!"):
			if label != "" {
				return label
			}
			name, _, _ := strings.Cut(ref[1:], "^")
			return "@" + name
		case label != "" && label != ref:
			return label + " (" + ref + ")"
		}
		return ref
	})
	return strings.NewReplacer("&lt;", "<", "&gt;", ">", "&amp;", "&").Replace(out)
}

// --- 事件订阅（Events API） ---

// slackEnvelope 是一次事件回调。
type slackEnvelope struct {
	Type      string   `json:"type"`
	Challenge string   `json:"challenge"`
	Event     slackMsg `json:"event"`
}

// Receive 收 Slack 推来的一次事件：按各实例的 Signing Secret 验签，对上哪个就算哪个实例的（IM-01d）；
// 多个实例共用一个 Slack App（Secret 一样）时再比事件的 team_id，都不是已接入的工作区回 200 不落库。
// 都对不上、没填、还没接入 Slack 回 401。url_verification 原样回 challenge；消息事件按这个实例收的范围筛过再交给插件落库。
// 在用的实例都对不上而有暂停、断开的实例时回 200 不落库（暂停的取不到 Secret，认不出是不是它），免得 Slack 一直重试。
func (s *Slack) Receive(r *http.Request) ([]Incoming, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, slackMaxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "read body: %v", err)
	}
	if len(body) > slackMaxBody {
		return nil, apiErr(errValidation, "body too large")
	}
	ctx := r.Context()
	list, err := instancesOf(ctx, s.core(), connector.SlackTool)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, Unauthorized("还没接入 Slack 渠道")
	}
	c := s.core()
	var (
		env     slackEnvelope
		msgs    []Incoming
		paused  string
		cn      plugin.ConnectorInfo
		vErr    error
		lastErr error
		hit     bool
	)
	ts, sig := r.Header.Get("X-Slack-Request-Timestamp"), r.Header.Get("X-Slack-Signature")
	// 同一个 Slack App 装进两个工作区时两个实例的 Signing Secret 一样，再按事件带的 team_id 认（验签过了才看它）
	var head struct {
		TeamID string `json:"team_id"`
	}
	_ = json.Unmarshal(body, &head)
	active := 0
	for _, x := range list {
		if !inactive(x) {
			active++
		}
	}
	other := false
	for _, x := range list {
		if inactive(x) {
			if paused == "" {
				paused = x.Name
			}
			continue
		}
		err = c.Connectors().With(ctx, x.ID, func(cfg plugin.ConnectorConfig) error {
			if err := connector.SlackVerify(cfg.Secret("signing_secret"), ts, sig, body, time.Now()); err != nil {
				vErr = err
				return nil
			}
			if active > 1 && head.TeamID != "" {
				if team := s.teamOf(ctx, x.ID, connector.SlackAs(cfg.Get(connector.SlackIdentityField)), cfg.Secret("bot_token")); team != "" && team != head.TeamID {
					other = true
					return nil
				}
			}
			hit, cn = true, x
			return s.handleEvent(ctx, x, cfg, body, &env, &msgs)
		})
		if hit {
			break
		}
		if err != nil && !errors.Is(err, plugin.ErrNoRows) {
			lastErr = err
		}
	}
	if !hit {
		switch {
		case other:
			return nil, &CallbackReply{Status: http.StatusOK, Body: map[string]any{"data": map[string]any{"ignored": "工作区 " + head.TeamID + " 没接入"}}}
		case paused != "":
			return nil, &CallbackReply{Status: http.StatusOK, Body: map[string]any{"data": map[string]any{"ignored": "连接器「" + paused + "」已暂停或断开"}}}
		case vErr == nil && lastErr != nil:
			return nil, lastErr
		case vErr == nil:
			vErr = errors.New("签名不对")
		}
		return nil, Unauthorized(vErr.Error())
	}
	var cr *CallbackReply
	switch {
	case errors.As(err, &cr):
		return nil, cr
	case err != nil:
		return nil, err
	}
	if len(msgs) > 0 {
		if _, rerr := c.Connectors().RecordSync(ctx, cn.ID, nil); rerr != nil {
			c.Log().Warn("record slack sync failed", "connector", cn.ID, "err", rerr)
		}
	}
	return msgs, nil
}

// handleEvent 处理验签对上的一次事件：握手回 challenge，消息按这个实例的收的范围筛过翻成 Incoming。
func (s *Slack) handleEvent(ctx context.Context, cn plugin.ConnectorInfo, cfg plugin.ConnectorConfig, body []byte, env *slackEnvelope, msgs *[]Incoming) error {
	if err := json.Unmarshal(body, env); err != nil {
		return apiErr(errValidation, "invalid json: %v", err)
	}
	if env.Type == "url_verification" {
		return &CallbackReply{Status: http.StatusOK, Body: map[string]string{"challenge": env.Challenge}}
	}
	m := env.Event
	if env.Type != "event_callback" || m.Type != "message" {
		return nil
	}
	cv, known := s.conv(m.Channel)
	direct := m.ChType == "im" || m.ChType == "mpim" || cv.IsIM || cv.MPIM
	token := cfg.Secret("bot_token")
	hc, err := s.client()
	if err != nil {
		return err
	}
	if !direct {
		if !known {
			cv, known = s.lookupConv(ctx, hc, token, m.Channel)
		}
		want := splitChannels(cfg.Get("channels"))
		if !slices.ContainsFunc(want, func(w string) bool { return w == m.Channel || (known && strings.EqualFold(w, cv.Name)) }) {
			return nil
		}
	}
	as := connector.SlackAs(cfg.Get(connector.SlackIdentityField))
	me := s.identity(ctx, hc, as, token)
	s.lookupUsers(ctx, hc, token, []slackMsg{m})
	if in, ok := s.toIncoming(cn.ID, me, as, cfg.Get("self_user_id"), cv, known, m); ok {
		*msgs = append(*msgs, in)
	}
	return nil
}

// lookupConv 查一个还没见过的会话（conversations.info），查不到当作不认识。
func (s *Slack) lookupConv(ctx context.Context, hc *http.Client, token, id string) (slackConv, bool) {
	var out struct {
		Channel slackConv `json:"channel"`
	}
	if err := s.call(ctx, hc, token, "conversations.info", url.Values{"channel": {id}}, &out); err != nil || out.Channel.ID == "" {
		return slackConv{}, false
	}
	s.remember(out.Channel)
	return out.Channel, true
}

// teamOf 是实例所在的工作区编号：拉取时记下，没记过现查一次 auth.test；查不到为空。
func (s *Slack) teamOf(ctx context.Context, id, as, token string) string {
	s.mu.Lock()
	team := s.teams[id]
	s.mu.Unlock()
	if team != "" {
		return team
	}
	hc, err := s.client()
	if err != nil {
		return ""
	}
	me := s.identity(ctx, hc, as, token)
	s.setTeam(id, me.TeamID)
	return me.TeamID
}

func (s *Slack) setTeam(id, team string) {
	if team == "" {
		return
	}
	s.mu.Lock()
	s.teams[id] = team
	s.mu.Unlock()
}

// identity 是 Token 自己的身份（Bot 或本人），用来认自己发的消息、认 @我；查不到时为空，不拦收消息。
func (s *Slack) identity(ctx context.Context, hc *http.Client, as, token string) connector.SlackIdentity {
	id, _ := connector.SlackAuthTest(ctx, hc, s.api, as, token)
	return id
}

// --- 回复、附件 ---

// Reply 经 chat.postMessage 用消息所属的实例发出去（Bot 身份以 Bot 名义，我本人身份用 User Token 以本人名义）：
// 频道里串在原消息下面（thread_ts），私信直接发；
// 没有会话编号时发给对方的 Member ID。消息没记实例（旧数据）时用最新建的实例。
func (s *Slack) Reply(ctx context.Context, out Outgoing) (string, error) {
	c := s.core()
	if c == nil {
		return "", errors.New("IM 插件还没启用")
	}
	id := out.ConnectorID
	if id == "" {
		cn, ok, err := s.instance(ctx)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", errors.New("还没接入 Slack 渠道")
		}
		id = cn.ID
	}
	ch := out.ConversationID
	if ch == "" {
		ch = out.RecipientID
	}
	if ch == "" {
		return "", errors.New("不知道发到哪个会话")
	}
	// 正文里的「@名字」换成 <@MemberID> 才会通知到人（mention.go）
	q := url.Values{"channel": {ch}, "text": {renderSlackMentions(out.Text, out.Mentions)}}
	if _, ts, ok := strings.Cut(out.ThreadOf, ":"); ok && ts != "" {
		// 回串里的回复：发到同一个串（thread_ts 要用父消息的，私信里的串也一样）
		q.Set("thread_ts", ts)
	} else if _, ts, ok := strings.Cut(out.ReplyTo, ":"); ok && out.ConversationKind == "group" && ts != "" {
		q.Set("thread_ts", ts)
	}
	var res struct {
		Channel string `json:"channel"`
		TS      string `json:"ts"`
	}
	err := c.Connectors().With(ctx, id, func(cfg plugin.ConnectorConfig) error {
		hc, err := s.client()
		if err != nil {
			return err
		}
		return s.call(ctx, hc, cfg.Secret("bot_token"), "chat.postMessage", q, &res)
	})
	if err != nil {
		return "", err
	}
	if res.Channel == "" {
		res.Channel = ch
	}
	return res.Channel + ":" + res.TS, nil
}

// Refetch 按消息编号（频道:ts）重取已收的消息，补全以前没解析出来的正文（refill.go）。
// 频道消息用 conversations.history 精确取那一条，取不到（串里的回复）再用 conversations.replies；
// 撞上限流就停，回已经取到的。
func (s *Slack) Refetch(ctx context.Context, connectorID string, ids []string) (map[string]Incoming, error) {
	c := s.core()
	if c == nil {
		return nil, errors.New("IM 插件还没启用")
	}
	out := map[string]Incoming{}
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
		var got []slackMsg
		for _, id := range ids {
			ch, ts, ok := strings.Cut(id, ":")
			if !ok || ch == "" || ts == "" {
				continue
			}
			m, err := s.oneMessage(ctx, hc, token, ch, ts)
			if slackRateLimited(err) {
				c.Log().Info("slack rate limited, refill stops here", "connector", connectorID, "err", err)
				break
			}
			if err != nil {
				c.Log().Warn("slack refetch failed", "connector", connectorID, "message", id, "err", err)
				continue
			}
			if m != nil {
				m.Channel = ch
				got = append(got, *m)
			}
		}
		s.lookupUsers(ctx, hc, token, got)
		for _, m := range got {
			cv, known := s.conv(m.Channel)
			if in, ok := s.toIncoming(connectorID, me, as, cfg.Get("self_user_id"), cv, known, m); ok {
				out[in.ExternalID] = in
			}
		}
		return nil
	})
	return out, err
}

// oneMessage 取一个会话里 ts 那一条；没有回 nil。
func (s *Slack) oneMessage(ctx context.Context, hc *http.Client, token, ch, ts string) (*slackMsg, error) {
	for _, method := range []string{"conversations.history", "conversations.replies"} {
		q := url.Values{"channel": {ch}, "limit": {"1"}, "inclusive": {"true"}}
		if method == "conversations.history" {
			q.Set("latest", ts)
			q.Set("oldest", ts)
		} else {
			q.Set("ts", ts)
		}
		var res struct {
			Messages []slackMsg `json:"messages"`
		}
		if err := s.call(ctx, hc, token, method, q, &res); err != nil {
			return nil, err
		}
		for i := range res.Messages {
			if res.Messages[i].TS == ts {
				return &res.Messages[i], nil
			}
		}
	}
	return nil, nil
}

// errSlackFileLogin 是下载附件拿回网页登录页的情况。
var errSlackFileLogin = errors.New("Slack 回的是网页登录页而不是文件：这个连接的 Token 缺 files:read 权限，" +
	"到 Slack App 的 OAuth & Permissions 里给对应的 Token（本人身份是 User Token Scopes）加上 files:read，重新安装到工作区后再获取")

// Fetch 带实例的 Token 下载附件（url_private_download，要 files:read）。
func (s *Slack) Fetch(ctx context.Context, ref AttachmentRef) (io.ReadCloser, error) {
	c := s.core()
	if c == nil {
		return nil, errors.New("IM 插件还没启用")
	}
	var meta struct {
		URL string `json:"url_private_download"`
	}
	_ = json.Unmarshal(ref.Raw, &meta)
	if meta.URL == "" {
		return nil, errors.New("附件没有下载地址")
	}
	id := ref.ConnectorID
	if id == "" {
		cn, ok, err := s.instance(ctx)
		if err != nil || !ok {
			return nil, errors.New("还没接入 Slack 渠道")
		}
		id = cn.ID
	}
	var body io.ReadCloser
	err := c.Connectors().With(ctx, id, func(cfg plugin.ConnectorConfig) error {
		hc, err := s.client()
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, meta.URL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.Secret("bot_token"))
		resp, err := hc.Do(req)
		if err != nil {
			var hn *plugin.HostNotAllowedError
			if errors.As(err, &hn) {
				return errors.New("插件 im 的 network:im 不允许访问这个地址")
			}
			return fmt.Errorf("下载失败：%w", err)
		}
		if resp.StatusCode != http.StatusOK {
			_ = resp.Body.Close()
			return fmt.Errorf("Slack 返回 HTTP %d", resp.StatusCode)
		}
		// Token 没有 files:read（或文件不对这个身份公开）时，Slack 不报错，而是 200 回一张网页登录页。
		// 不拦住的话登录页会被存成 .png、标成已获取，打开就是坏图
		if ct := strings.ToLower(resp.Header.Get("Content-Type")); strings.HasPrefix(ct, "text/html") {
			_ = resp.Body.Close()
			return errSlackFileLogin
		}
		body = resp.Body
		return nil
	})
	if err != nil {
		return nil, err
	}
	return body, nil
}
