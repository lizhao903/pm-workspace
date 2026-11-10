// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// B 站网页端连接器（TSK-0455）：开放平台没有的账户数据（总播放、获赞、投币、收藏、充电、按天趋势）和私信走网页端接口。
//
// 这些都是非官方网页接口，可能变化：地址、字段按社区公开整理的文档（bilibili-API-collect）写，测试对接本机假服务端，
// 和真实返回对不上的地方要用户本人登录后核对再修。只做这几项，不做别的：
//   - 扫码登录：passport.bilibili.com/x/passport-login/web/qrcode/generate、/poll，成功时从 Set-Cookie 取 SESSDATA、bili_jct、DedeUserID 等
//   - 账号信息：api.bilibili.com/x/web-interface/nav（isLogin、mid、uname、face）
//   - 粉丝和关系：api.bilibili.com/x/relation/stat?vmid=（follower、following）
//   - 创作中心概览：member.bilibili.com/x/web/index/stat（total_* 总量、incr_fans、incr_click 昨日增量）
//   - 创作中心按天趋势：member.bilibili.com/x/web/data/pandect?type=（1 播放、5 投币、6 收藏、7 充电、8 点赞；data 是 [{date_key, total_inc}]）
//   - 私信会话：api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions（session_list[].talker_id、unread_count、last_msg、max_seqno）
//   - 会话对方的昵称头像：api.vc.bilibili.com/account/v1/user/cards?uids=
//   - 消息记录：api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs（messages[].sender_uid、msg_type、content、msg_seqno、timestamp、msg_key）
//   - 发文字私信：POST api.vc.bilibili.com/web_im/v1/web_im/send_msg（表单 msg[...]、csrf；回 msg_key）
//
// 凭证（整串 Cookie、csrf 即 bili_jct、refresh_token）经连接器框架存在 bilibili_web 实例的保险箱条目里，键是 _web_cookie、_web_csrf、_web_refresh；
// 只在 Connectors().With 的回调里取用，不进日志、错误、响应、通知和审计。
// 请求头只带浏览器常规的 User-Agent、Referer（发私信另带 Origin），不伪造设备指纹，不绕验证码。
// 所有网页接口共用一个限频（biliWebGap，按发出时刻排队），被限频、风控（-412、-352、-509、-799、要验证码）时按实例指数退避，见 biliguard.go。

// BiliWebTool 是网页端连接器的 tool。
const BiliWebTool = "bilibili_web"

// 会话凭证在保险箱条目里的键：_ 开头，同 OAuth 令牌，不出脱敏提示、断开实例时一起删。
const (
	biliKeyCookie  = "_web_cookie"
	biliKeyCSRF    = "_web_csrf"
	biliKeyRefresh = "_web_refresh"
)

// 网页端各域名；测试经 SetHTTPTransport 改投本机假服务端，域名检查照常。
const (
	biliWebAPI      = "https://api.bilibili.com"
	biliWebVC       = "https://api.vc.bilibili.com"
	biliWebPassport = "https://passport.bilibili.com"
	biliWebMember   = "https://member.bilibili.com"
)

// biliUA 是浏览器常规的 User-Agent（桌面 Chrome），所有网页请求一样，不随机、不伪造指纹。
const biliUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

var (
	// biliWebGap 是所有网页接口共用的最小间隔：一次请求发出后至少隔这么久才发下一次（全插件一个队列）。
	biliWebGap = 1500 * time.Millisecond
	// biliWebMaxWait 是排队最多等多久，再久就不发了，回「请求太多」。
	biliWebMaxWait = 45 * time.Second
)

// biliRiskCodes 是表示被限频、风控的返回码：-412 请求被拦截、-352 风控校验失败、-509 请求过于频繁、-799 请求过于频繁。
var biliRiskCodes = map[int]bool{-412: true, -352: true, -509: true, -799: true}

// biliLoginCodes 是表示登录失效的返回码：-101 账号未登录、-111 csrf 校验失败、-2 账号无效。
var biliLoginCodes = map[int]bool{-101: true, -111: true, -2: true}

// BiliWebError 是网页接口出的错。Risk 为 true 是被限频或风控，Captcha 是要求验证码，Login 是登录失效。
// Msg 是 B 站给的说明（截到 100 字），不带地址、请求头和 Cookie。
type BiliWebError struct {
	Code    int
	Msg     string
	Risk    bool
	Captcha bool
	Login   bool
	Net     bool
}

func (e *BiliWebError) Error() string {
	var s string
	if e.Code == 0 {
		s = "B 站网页接口：" + e.Msg
	} else {
		s = fmt.Sprintf("B 站网页接口返回 %d：%s", e.Code, e.Msg)
	}
	switch {
	case e.Captcha:
		s += "（B 站要求验证，本工具不绕过验证码：到浏览器里打开 B 站完成验证后再试）"
	case e.Risk:
		s += "（被限频或风控，已暂停请求，稍后自动再试）"
	case e.Login:
		s += "（登录已失效，到「视频 / B 站」重新扫码登录）"
	}
	return s
}

func biliWebErr(err error) *BiliWebError {
	var e *BiliWebError
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// biliWeb 是网页端接口的客户端：全插件一个，管限频队列。
type biliWeb struct {
	c   plugin.Core
	now func() time.Time
	mu  sync.Mutex
	// next 是下一个请求最早什么时候能发
	next time.Time
}

func newBiliWeb() *biliWeb { return &biliWeb{now: time.Now} }

// wait 按全局队列排一个发送时刻，等到它；等太久回错误，不发。
func (w *biliWeb) wait(ctx context.Context) error {
	w.mu.Lock()
	now := w.now()
	at := w.next
	if at.Before(now) {
		at = now
	}
	if at.Sub(now) > biliWebMaxWait {
		w.mu.Unlock()
		return &BiliWebError{Msg: "排队的请求太多，稍后再试", Risk: false}
	}
	w.next = at.Add(biliWebGap)
	w.mu.Unlock()
	d := at.Sub(now)
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// biliSession 是一次调用要用的出网客户端和登录态；只在 Connectors().With 的回调里有效，不要留存。
type biliSession struct {
	hc     *http.Client
	cookie string
	csrf   string
}

func biliSessionOf(hc *http.Client, cfg plugin.ConnectorConfig) biliSession {
	return biliSession{hc: hc, cookie: cfg.Secret(biliKeyCookie), csrf: cfg.Secret(biliKeyCSRF)}
}

// netErr 换成不带地址的说明：地址里可能有 qrcode_key。
func biliNetErr(err error) error {
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return &BiliWebError{Msg: "插件 video 的 network:media-platforms 不允许访问这个地址", Net: true}
	}
	var ne *plugin.NotGrantedError
	if errors.As(err, &ne) {
		return &BiliWebError{Msg: ne.Error(), Net: true}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return &BiliWebError{Msg: fmt.Sprintf("连不上 B 站：%v", err), Net: true}
}

// do 发一个网页接口请求：先排限频队列，带 UA、Referer、Cookie；form 不为 nil 时按表单 POST。
// 回包是 {code, message, data}，data 解进 out；resp 回给要读 Set-Cookie 的扫码轮询。
func (w *biliWeb) do(ctx context.Context, s biliSession, method, rawURL, referer string, form url.Values, out any) (*http.Response, error) {
	if err := w.wait(ctx); err != nil {
		return nil, err
	}
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", biliUA)
	req.Header.Set("Referer", referer)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if u, err := url.Parse(referer); err == nil {
			req.Header.Set("Origin", u.Scheme+"://"+u.Host)
		}
	}
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	resp, err := s.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, biliNetErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, biliMaxResp))
	if err != nil {
		return nil, biliNetErr(err)
	}
	if resp.StatusCode == http.StatusPreconditionFailed {
		return nil, &BiliWebError{Code: -412, Msg: "请求被拦截", Risk: true}
	}
	var env struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Msg     string          `json:"msg"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		e := &BiliWebError{Code: resp.StatusCode, Msg: "回的不是 JSON", Net: true}
		if resp.StatusCode == http.StatusTooManyRequests {
			e.Risk = true
		}
		return nil, e
	}
	msg := env.Message
	if msg == "" {
		msg = env.Msg
	}
	if env.Code != 0 {
		e := &BiliWebError{Code: env.Code, Msg: clipText(msg, 100)}
		e.Captcha = biliNeedsCaptcha(msg, env.Data)
		e.Risk = biliRiskCodes[env.Code] || e.Captcha || strings.Contains(msg, "风控") || strings.Contains(msg, "频繁")
		e.Login = !e.Risk && biliLoginCodes[env.Code]
		return nil, e
	}
	if resp.StatusCode >= 400 {
		return nil, &BiliWebError{Code: resp.StatusCode, Msg: "请求失败", Net: true, Risk: resp.StatusCode == http.StatusTooManyRequests}
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return nil, &BiliWebError{Msg: "返回的数据解析不了，接口可能变了：" + clipText(err.Error(), 100)}
		}
	}
	return resp, nil
}

// biliNeedsCaptcha：B 站要求做验证（回包里带 v_voucher，或说明里提到验证码）。
func biliNeedsCaptcha(msg string, data json.RawMessage) bool {
	return strings.Contains(msg, "验证码") || strings.Contains(string(data), "v_voucher")
}

// --- 扫码登录 ---

// 轮询状态码：0 登录成功、86101 未扫码、86090 已扫码未确认、86038 二维码已失效。
const (
	biliQRDone      = 0
	biliQRWaiting   = 86101
	biliQRScanned   = 86090
	biliQRExpired   = 86038
	biliQRLifetime  = 180 * time.Second
	biliPassportRef = "https://www.bilibili.com/"
)

func (w *biliWeb) qrGenerate(ctx context.Context, hc *http.Client) (loginURL, key string, err error) {
	var out struct {
		URL       string `json:"url"`
		QRCodeKey string `json:"qrcode_key"`
	}
	if _, err := w.do(ctx, biliSession{hc: hc}, http.MethodGet, biliWebPassport+"/x/passport-login/web/qrcode/generate", biliPassportRef, nil, &out); err != nil {
		return "", "", err
	}
	if out.URL == "" || out.QRCodeKey == "" {
		return "", "", &BiliWebError{Msg: "生成二维码没回地址"}
	}
	return out.URL, out.QRCodeKey, nil
}

// biliLogin 是扫码成功拿到的登录态：凭证三项只交给 SaveSession，别处不用。
type biliLogin struct {
	Cookie  string
	CSRF    string
	Refresh string
	MID     string
}

// biliCookieNames 是要留下的 Cookie，拼成一串存进保险箱，请求时整串带上。
var biliCookieNames = []string{"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"}

func (w *biliWeb) qrPoll(ctx context.Context, hc *http.Client, key string) (state int, msg string, login *biliLogin, err error) {
	var out struct {
		Code         int    `json:"code"`
		Message      string `json:"message"`
		URL          string `json:"url"`
		RefreshToken string `json:"refresh_token"`
	}
	resp, err := w.do(ctx, biliSession{hc: hc}, http.MethodGet,
		biliWebPassport+"/x/passport-login/web/qrcode/poll?qrcode_key="+url.QueryEscape(key), biliPassportRef, nil, &out)
	if err != nil {
		return 0, "", nil, err
	}
	if out.Code != biliQRDone {
		return out.Code, clipText(out.Message, 100), nil, nil
	}
	got := map[string]string{}
	for _, c := range resp.Cookies() {
		if c.Value != "" {
			got[c.Name] = c.Value
		}
	}
	// 没给 Set-Cookie 时，跳转地址的查询串里也带着这几项
	if got["SESSDATA"] == "" {
		if u, err := url.Parse(out.URL); err == nil {
			for _, k := range biliCookieNames {
				if v := u.Query().Get(k); v != "" {
					got[k] = v
				}
			}
		}
	}
	if got["SESSDATA"] == "" || got["bili_jct"] == "" {
		return 0, "", nil, &BiliWebError{Msg: "扫码成功了，但没拿到登录 Cookie，接口可能变了"}
	}
	var parts []string
	for _, k := range biliCookieNames {
		if v := got[k]; v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	return biliQRDone, "", &biliLogin{Cookie: strings.Join(parts, "; "), CSRF: got["bili_jct"], Refresh: out.RefreshToken, MID: got["DedeUserID"]}, nil
}

// --- 账号和数据 ---

type biliNav struct {
	IsLogin bool   `json:"isLogin"`
	MID     int64  `json:"mid"`
	Uname   string `json:"uname"`
	Face    string `json:"face"`
}

func (w *biliWeb) nav(ctx context.Context, s biliSession) (biliNav, error) {
	var out biliNav
	if _, err := w.do(ctx, s, http.MethodGet, biliWebAPI+"/x/web-interface/nav", "https://www.bilibili.com/", nil, &out); err != nil {
		return out, err
	}
	if !out.IsLogin || out.MID == 0 {
		return out, &BiliWebError{Code: -101, Msg: "账号未登录", Login: true}
	}
	return out, nil
}

type biliRelation struct {
	Follower  int64 `json:"follower"`
	Following int64 `json:"following"`
}

func (w *biliWeb) relation(ctx context.Context, s biliSession, mid string) (biliRelation, error) {
	var out biliRelation
	_, err := w.do(ctx, s, http.MethodGet, biliWebAPI+"/x/relation/stat?vmid="+url.QueryEscape(mid), "https://space.bilibili.com/", nil, &out)
	return out, err
}

// biliIndexStat 是创作中心「数据概览」：total_* 是累计，incr_fans、incr_click 是昨日新增。
type biliIndexStat struct {
	TotalFans  *int64 `json:"total_fans"`
	TotalClick *int64 `json:"total_click"`
	TotalLike  *int64 `json:"total_like"`
	TotalCoin  *int64 `json:"total_coin"`
	TotalFav   *int64 `json:"total_fav"`
	TotalReply *int64 `json:"total_reply"`
	TotalDM    *int64 `json:"total_dm"`
	TotalShare *int64 `json:"total_share"`
	TotalElec  *int64 `json:"total_elec"`
	IncrFans   *int64 `json:"incr_fans"`
	IncrClick  *int64 `json:"incr_click"`
}

func (w *biliWeb) indexStat(ctx context.Context, s biliSession) (biliIndexStat, error) {
	var out biliIndexStat
	_, err := w.do(ctx, s, http.MethodGet, biliWebMember+"/x/web/index/stat", "https://member.bilibili.com/platform/home", nil, &out)
	return out, err
}

// BiliTrendMetrics 是拉按天趋势的几项和创作中心 pandect 的 type：播放、点赞、投币、收藏、充电。
var BiliTrendMetrics = []string{"click", "like", "coin", "fav", "elec"}

var biliPandectType = map[string]int{"click": 1, "dm": 2, "reply": 3, "share": 4, "coin": 5, "fav": 6, "elec": 7, "like": 8}

type biliDayValue struct {
	Date  string
	Value int64
}

// pandect 是一项数据近 30 天的按天增量；date_key 是那一天的时间戳，换成北京时间的日期。
func (w *biliWeb) pandect(ctx context.Context, s biliSession, metric string) ([]biliDayValue, error) {
	var out []struct {
		DateKey  int64 `json:"date_key"`
		TotalInc int64 `json:"total_inc"`
	}
	if _, err := w.do(ctx, s, http.MethodGet, biliWebMember+"/x/web/data/pandect?type="+strconv.Itoa(biliPandectType[metric]),
		"https://member.bilibili.com/platform/data/overview", nil, &out); err != nil {
		return nil, err
	}
	res := make([]biliDayValue, 0, len(out))
	for _, x := range out {
		if x.DateKey <= 0 {
			continue
		}
		res = append(res, biliDayValue{Date: time.Unix(x.DateKey, 0).In(biliTZ).Format(time.DateOnly), Value: x.TotalInc})
	}
	return res, nil
}

// --- 私信 ---

const biliMsgRef = "https://message.bilibili.com/"

type biliRawMsg struct {
	SenderUID  int64  `json:"sender_uid"`
	ReceiverID int64  `json:"receiver_id"`
	MsgType    int    `json:"msg_type"`
	Content    string `json:"content"`
	MsgSeqno   int64  `json:"msg_seqno"`
	Timestamp  int64  `json:"timestamp"`
	MsgKey     int64  `json:"msg_key"`
}

type biliRawSession struct {
	TalkerID    int64       `json:"talker_id"`
	SessionType int         `json:"session_type"`
	UnreadCount int         `json:"unread_count"`
	MaxSeqno    int64       `json:"max_seqno"`
	SessionTS   int64       `json:"session_ts"`
	LastMsg     *biliRawMsg `json:"last_msg"`
}

// sessions 是最近的私信会话（一页，只要和个人的会话，session_type 1）。
func (w *biliWeb) sessions(ctx context.Context, s biliSession) ([]biliRawSession, error) {
	var out struct {
		SessionList []biliRawSession `json:"session_list"`
	}
	if _, err := w.do(ctx, s, http.MethodGet, biliWebVC+"/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web",
		biliMsgRef, nil, &out); err != nil {
		return nil, err
	}
	res := out.SessionList[:0:0]
	for _, x := range out.SessionList {
		if x.SessionType == 1 && x.TalkerID > 0 {
			res = append(res, x)
		}
	}
	return res, nil
}

type biliCard struct {
	MID  int64  `json:"mid"`
	Name string `json:"name"`
	Face string `json:"face"`
}

func (w *biliWeb) cards(ctx context.Context, s biliSession, uids []string) ([]biliCard, error) {
	var out []biliCard
	_, err := w.do(ctx, s, http.MethodGet, biliWebVC+"/account/v1/user/cards?uids="+url.QueryEscape(strings.Join(uids, ",")), biliMsgRef, nil, &out)
	return out, err
}

// messages 是和 talker 的消息，begin 之后的（0 是最近一页），最多 size 条。
func (w *biliWeb) messages(ctx context.Context, s biliSession, talker string, begin int64, size int) ([]biliRawMsg, error) {
	var out struct {
		Messages []biliRawMsg `json:"messages"`
	}
	q := url.Values{"talker_id": {talker}, "session_type": {"1"}, "size": {strconv.Itoa(size)}, "build": {"0"}, "mobi_app": {"web"}}
	if begin > 0 {
		q.Set("begin_seqno", strconv.FormatInt(begin, 10))
	}
	if _, err := w.do(ctx, s, http.MethodGet, biliWebVC+"/svr_sync/v1/svr_sync/fetch_session_msgs?"+q.Encode(), biliMsgRef, nil, &out); err != nil {
		return nil, err
	}
	return out.Messages, nil
}

// send 发一条文字私信，回 B 站的消息号。dev_id 是每个实例一个的消息设备号（随机 UUID），不是设备指纹。
func (w *biliWeb) send(ctx context.Context, s biliSession, mid, talker, devID, text string, at time.Time) (string, error) {
	content, _ := json.Marshal(map[string]string{"content": text})
	form := url.Values{
		"msg[sender_uid]": {mid}, "msg[receiver_type]": {"1"}, "msg[receiver_id]": {talker}, "msg[msg_type]": {"1"},
		"msg[msg_status]": {"0"}, "msg[dev_id]": {devID}, "msg[timestamp]": {strconv.FormatInt(at.Unix(), 10)},
		"msg[new_face_version]": {"0"}, "msg[content]": {string(content)},
		"csrf": {s.csrf}, "csrf_token": {s.csrf}, "build": {"0"}, "mobi_app": {"web"},
	}
	var out struct {
		MsgKey int64 `json:"msg_key"`
	}
	if _, err := w.do(ctx, s, http.MethodPost, biliWebVC+"/web_im/v1/web_im/send_msg", biliMsgRef, form, &out); err != nil {
		return "", err
	}
	if out.MsgKey == 0 {
		return "", nil
	}
	return strconv.FormatInt(out.MsgKey, 10), nil
}

// biliMsgText 把消息内容换成给人看的文字：文字消息取 content 里的 content，别的类型给个占位。
func biliMsgText(t int, content string) string {
	switch t {
	case 1:
		var c struct {
			Content string `json:"content"`
		}
		if json.Unmarshal([]byte(content), &c) == nil {
			return c.Content
		}
		return content
	case 2:
		return "[图片]"
	case 5:
		return "[撤回了一条消息]"
	case 6:
		return "[表情]"
	case 7:
		return "[分享]"
	}
	return fmt.Sprintf("[暂不支持显示的消息类型 %d]", t)
}

// biliTZ 是 B 站数据按天切分用的时区（北京时间）；系统没有时区数据时退到固定 +8。
var biliTZ = func() *time.Location {
	if l, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return l
	}
	return time.FixedZone("CST", 8*3600)
}()

// --- 连接器定义 ---

func (w *biliWeb) ConnectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: BiliWebTool, Label: "B 站网页登录", Category: "media", Color: "#fb7299",
		Desc: "B 站网页端（非官方接口，可能变化）：扫码登录后查账户数据和趋势、收发私信。到「视频 / B 站」页扫码登录，凭证进保险箱",
		Auth: []connector.AuthMode{connector.AuthNone},
		Test: w.test,
	}
}

func (w *biliWeb) test(ctx context.Context, cfg plugin.ConnectorConfig) (string, error) {
	if w.c == nil {
		return "", errors.New("视频插件还没启用")
	}
	if cfg.Secret(biliKeyCookie) == "" {
		return "", errors.New("还没扫码登录：到「视频 / B 站」页扫码登录")
	}
	hc, err := w.c.HTTP("media-platforms")
	if err != nil {
		return "", err
	}
	nav, err := w.nav(ctx, biliSessionOf(hc, cfg))
	if err != nil {
		return "", err
	}
	return nav.Uname, nil
}
