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
// 收的范围：私信和多人私信，加上「监听频道」里列的频道（Bot 要先被加进频道）。
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
)

// Slack 是 Slack 适配器，cmd/pmw 交给 New。一个工具只接一个账号，所以只认第一个 slack 实例。
type Slack struct {
	api string
	c   plugin.Core

	mu       sync.Mutex
	lastPull time.Time
	users    map[string]string    // Member ID -> 显示名
	convs    map[string]slackConv // 会话 id -> 会话
}

// SlackOptions：API 是 Web API 的根，空串取正式地址 https://slack.com/api。
// 联调时不改它，用 pmw --dev-upstream slack.com=<假服务地址> 把出网改投到本机假服务端（域名检查在改投之前照常做）。
type SlackOptions struct {
	API string
}

func NewSlack(o SlackOptions) *Slack {
	return &Slack{api: connector.SlackEndpoints{API: o.API}.Base(), users: map[string]string{}, convs: map[string]slackConv{}}
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

// instance 是在用的 slack 实例；没有时 ok 为 false。
func (s *Slack) instance(ctx context.Context) (plugin.ConnectorInfo, bool, error) {
	c := s.core()
	if c == nil {
		return plugin.ConnectorInfo{}, false, nil
	}
	list, err := c.Connectors().List(ctx, connector.SlackTool)
	if err != nil || len(list) == 0 {
		return plugin.ConnectorInfo{}, false, err
	}
	return list[0], true, nil
}

func inactive(cn plugin.ConnectorInfo) bool {
	return cn.Status == "paused" || cn.Status == "disconnected"
}

// Due：实例在用、设了同步间隔（分钟），离上次拉够了间隔。间隔为 0 时只收回调和立即同步。
func (s *Slack) Due(ctx context.Context, now time.Time) bool {
	cn, ok, err := s.instance(ctx)
	if err != nil || !ok || inactive(cn) || cn.Interval <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastPull.IsZero() || now.Sub(s.lastPull) >= time.Duration(cn.Interval)*time.Minute
}

// slackCursor 是 im_cursors 里的进度：哪个实例、哪个工作区，每个会话拉到的最后一条 ts。实例或工作区换了从头来。
type slackCursor struct {
	Connector string            `json:"connector"`
	Team      string            `json:"team"`
	Latest    map[string]string `json:"latest"`
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

// Pull 拉一轮：auth.test（顺带认出 Token 失效）、列会话、逐个拉新消息。拉完把结果记到连接器：
// 失败（invalid_auth 等）实例置为异常并写原因；监听频道里有找不到的也记成异常，找到的照收。
func (s *Slack) Pull(ctx context.Context, cursor string) ([]Incoming, string, error) {
	cn, ok, err := s.instance(ctx)
	if err != nil || !ok || inactive(cn) {
		return nil, cursor, err
	}
	s.mu.Lock()
	s.lastPull = time.Now()
	s.mu.Unlock()
	var cur slackCursor
	_ = json.Unmarshal([]byte(cursor), &cur)
	var (
		msgs   []Incoming
		warn   error
		hc     *http.Client
		c      = s.core()
		nextCu = cursor
	)
	err = c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
		var err error
		if hc, err = s.client(); err != nil {
			return err
		}
		token := cfg.Secret("bot_token")
		me, err := connector.SlackAuthTest(ctx, hc, s.api, token)
		if err != nil {
			return err
		}
		if cur.Connector != cn.ID || cur.Team != me.TeamID || cur.Latest == nil {
			cur = slackCursor{Connector: cn.ID, Team: me.TeamID, Latest: map[string]string{}}
		}
		convs, missing, err := s.conversations(ctx, hc, token, cfg.Get("channels"))
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			warn = fmt.Errorf("这些频道找不到或 Bot 没被加进去：%s", strings.Join(missing, "、"))
		}
		var raw []slackMsg
		for _, cv := range convs {
			got, latest, err := s.history(ctx, hc, token, cv.ID, cur.Latest[cv.ID])
			if err != nil {
				return err
			}
			if latest != "" {
				cur.Latest[cv.ID] = latest
			}
			for i := range got {
				got[i].Channel = cv.ID
			}
			raw = append(raw, got...)
		}
		s.lookupUsers(ctx, hc, token, raw)
		for _, m := range raw {
			cv, known := s.conv(m.Channel)
			if in, ok := s.toIncoming(cn.ID, me, cfg.Get("self_user_id"), cv, known, m); ok {
				msgs = append(msgs, in)
			}
		}
		b, _ := json.Marshal(cur)
		nextCu = string(b)
		return nil
	})
	if ctx.Err() != nil {
		return nil, cursor, ctx.Err()
	}
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, cursor, nil
	}
	rec := err
	if rec == nil {
		rec = warn
	}
	if _, rerr := c.Connectors().RecordSync(ctx, cn.ID, rec); rerr != nil {
		c.Log().Warn("record slack sync failed", "connector", cn.ID, "err", rerr)
	}
	if err != nil {
		return nil, cursor, err
	}
	sort.SliceStable(msgs, func(i, j int) bool { return msgs[i].At.Before(msgs[j].At) })
	return msgs, nextCu, nil
}

// conversations 列 Bot 所在的会话：私信、多人私信全收，频道只收 channels 里列的（名字或编号，# 可带可不带）。
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

// history 拉一个会话 oldest 之后的消息（不含 oldest），回按时间正序的消息和拉到的最新 ts。
// 第一次拉（oldest 为空）只取最近 slackFirstLimit 条。
func (s *Slack) history(ctx context.Context, hc *http.Client, token, ch, oldest string) ([]slackMsg, string, error) {
	var got []slackMsg
	next := ""
	for page := 0; page < slackMaxPages; page++ {
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

// lookupUsers 查这批消息里发送人和被 @ 的人的名字，记进缓存；查不到的不报错，显示编号。
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
		var out struct {
			User struct {
				Name    string `json:"name"`
				Profile struct {
					Display string `json:"display_name"`
					Real    string `json:"real_name"`
				} `json:"profile"`
			} `json:"user"`
		}
		if err := s.call(ctx, hc, token, "users.info", url.Values{"user": {id}}, &out); err != nil {
			continue
		}
		name := out.User.Profile.Display
		if name == "" {
			name = out.User.Profile.Real
		}
		if name == "" {
			name = out.User.Name
		}
		if name != "" {
			s.mu.Lock()
			if len(s.users) >= slackNameCacheN {
				s.users = map[string]string{}
			}
			s.users[id] = name
			s.mu.Unlock()
		}
	}
}

// toIncoming 把一条 Slack 消息翻成 Incoming；Bot 自己发的、不收的子类型、没有发送人的跳过。
func (s *Slack) toIncoming(connID string, me connector.SlackIdentity, self string, cv slackConv, known bool, m slackMsg) (Incoming, bool) {
	if !slices.Contains(slackSubtypes, m.Subtype) || m.TS == "" || m.Channel == "" {
		return Incoming{}, false
	}
	if (me.UserID != "" && m.User == me.UserID) || (me.BotID != "" && m.BotID == me.BotID) {
		return Incoming{}, false
	}
	sender, name := m.User, s.userName(m.User)
	if sender == "" {
		sender, name = m.BotID, m.Username
	}
	if sender == "" {
		return Incoming{}, false
	}
	if !known {
		// 事件里的会话还没列过：按 channel_type 猜
		cv = slackConv{ID: m.Channel, IsIM: m.ChType == "im", MPIM: m.ChType == "mpim"}
	}
	in := Incoming{
		ExternalID: m.Channel + ":" + m.TS, ConnectorID: connID,
		ConversationID: m.Channel, ConversationKind: cv.kind(), ConversationName: cv.title(),
		SenderID: sender, SenderName: name, Text: s.plainText(m.Text), At: tsTime(m.TS),
		Mention: slackMention(m.Text, me.UserID, strings.TrimSpace(self)),
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

// Receive 收 Slack 推来的一次事件：先按 Signing Secret 验签（不对、没填都回 401），
// url_verification 原样回 challenge；消息事件按收的范围筛过再交给插件落库。实例暂停、断开时回 200 不落库，免得 Slack 一直重试。
func (s *Slack) Receive(r *http.Request) ([]Incoming, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, slackMaxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "read body: %v", err)
	}
	if len(body) > slackMaxBody {
		return nil, apiErr(errValidation, "body too large")
	}
	ctx := r.Context()
	cn, ok, err := s.instance(ctx)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, Unauthorized("还没接入 Slack 渠道")
	}
	if inactive(cn) {
		return nil, &CallbackReply{Status: http.StatusOK, Body: map[string]any{"data": map[string]any{"ignored": "连接器「" + cn.Name + "」已暂停或断开"}}}
	}
	c := s.core()
	var (
		env  slackEnvelope
		msgs []Incoming
	)
	err = c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
		if err := connector.SlackVerify(cfg.Secret("signing_secret"), r.Header.Get("X-Slack-Request-Timestamp"),
			r.Header.Get("X-Slack-Signature"), body, time.Now()); err != nil {
			return Unauthorized(err.Error())
		}
		if err := json.Unmarshal(body, &env); err != nil {
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
		me := s.botIdentity(ctx, hc, token)
		s.lookupUsers(ctx, hc, token, []slackMsg{m})
		if in, ok := s.toIncoming(cn.ID, me, cfg.Get("self_user_id"), cv, known, m); ok {
			msgs = append(msgs, in)
		}
		return nil
	})
	var cr *CallbackReply
	switch {
	case errors.As(err, &cr):
		return nil, cr
	case errors.Is(err, errValidation):
		return nil, err
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

// botIdentity 是 Bot 自己的身份，用来跳过自己发的消息、认 @Bot；查不到时为空，不拦收消息。
func (s *Slack) botIdentity(ctx context.Context, hc *http.Client, token string) connector.SlackIdentity {
	id, _ := connector.SlackAuthTest(ctx, hc, s.api, token)
	return id
}

// --- 回复、附件 ---

// Reply 经 chat.postMessage 发出去：频道里串在原消息下面（thread_ts），私信直接发；没有会话编号时发给对方的 Member ID。
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
	q := url.Values{"channel": {ch}, "text": {out.Text}}
	if _, ts, ok := strings.Cut(out.ReplyTo, ":"); ok && out.ConversationKind == "group" && ts != "" {
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

// Fetch 带 Bot Token 下载附件（url_private_download，要 files:read）。
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
		body = resp.Body
		return nil
	})
	if err != nil {
		return nil, err
	}
	return body, nil
}
