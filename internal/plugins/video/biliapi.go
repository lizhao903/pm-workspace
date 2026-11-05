package video

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// B 站组件的接口（TSK-0455）：/api/video/bili/...，网页端连接器 bilibili_web 见 biliweb.go。
// 一个 bilibili_web 实例一个 B 站账号：扫码登录、账户概览和按天趋势、私信会话和消息、发文字私信。
// 对外只给登录状态、昵称、头像和数据，不给 Cookie、csrf 等凭证。
// 新私信由后台任务 bili_inbox 每 biliInboxEvery 拉一轮，有新的发通知；账户数据由 bili_daily 每天拉一次快照。
// 发私信只在用户在界面上点发送时发生：一次一条、一个对方，带 client_msg_id 防重复提交，不提供批量、定时、自动回复。

var (
	// biliInboxEvery 是拉新私信的间隔
	biliInboxEvery = 60 * time.Second
	// biliDailyEvery 是看要不要拉当天快照的间隔，当天拉过就不拉
	biliDailyEvery = time.Hour
	// biliRefreshMin 是手动刷新账户数据的最小间隔
	biliRefreshMin = 10 * time.Minute
	// biliInboxMin 是手动刷新私信的最小间隔
	biliInboxMin = 10 * time.Second
	// biliGuardBase、biliGuardMax 是被限频、风控后的退避：第 n 次连续被拦等 base*2^(n-1)，最多 max；要验证码的至少 30 分钟
	biliGuardBase = 2 * time.Minute
	biliGuardMax  = 2 * time.Hour
)

const (
	biliMaxText       = 500
	biliFetchSessions = 5  // 一轮最多拉几个会话的新消息，剩下的下一轮
	biliPageSize      = 20 // 拉消息一页几条
)

// BiliGuard 是退避中的说明：到 until 之前不发网页接口请求。
type BiliGuard struct {
	Until  string `json:"until"`
	Reason string `json:"reason"`
	Code   int    `json:"code"`
}

// BiliAccount 是一个 bilibili_web 实例的登录状态和公开资料，不含凭证。
type BiliAccount struct {
	ConnectorID   string     `json:"connector_id"`
	Name          string     `json:"name"`
	Status        string     `json:"status"`
	Error         string     `json:"error,omitempty"`
	Login         string     `json:"login"` // logged_out / logged_in / expired
	MID           string     `json:"mid,omitempty"`
	Uname         string     `json:"uname,omitempty"`
	Face          string     `json:"face,omitempty"`
	Guard         *BiliGuard `json:"guard,omitempty"`
	Unread        int        `json:"unread"`
	InboxSyncedAt *string    `json:"inbox_synced_at,omitempty"`
	SnapshotAt    *string    `json:"snapshot_at,omitempty"`
	PollSec       int        `json:"poll_sec"`
}

// BiliSnapshot 是一天的账户数据，拿不到的项不返回。
type BiliSnapshot struct {
	Date       string `json:"date"`
	Source     string `json:"source"` // web / open+web
	Followers  *int64 `json:"followers,omitempty"`
	Following  *int64 `json:"following,omitempty"`
	Archives   *int64 `json:"archives,omitempty"`
	TotalClick *int64 `json:"total_click,omitempty"`
	TotalLike  *int64 `json:"total_like,omitempty"`
	TotalCoin  *int64 `json:"total_coin,omitempty"`
	TotalFav   *int64 `json:"total_fav,omitempty"`
	TotalReply *int64 `json:"total_reply,omitempty"`
	TotalDM    *int64 `json:"total_dm,omitempty"`
	TotalShare *int64 `json:"total_share,omitempty"`
	TotalElec  *int64 `json:"total_elec,omitempty"`
	IncrFans   *int64 `json:"incr_fans,omitempty"`
	IncrClick  *int64 `json:"incr_click,omitempty"`
	UpdatedAt  string `json:"updated_at"`
}

// BiliTrendPoint 是按天趋势的一天。
type BiliTrendPoint struct {
	Date  string `json:"date"`
	Value int64  `json:"value"`
}

// BiliTrend 是一项数据的按天增量（创作中心近 30 天）。
type BiliTrend struct {
	Metric string           `json:"metric"`
	Points []BiliTrendPoint `json:"points"`
}

// BiliOverview 是账户概览：最新快照、近 90 天每天的快照、创作中心的按天增量。
type BiliOverview struct {
	Account BiliAccount    `json:"account"`
	Latest  *BiliSnapshot  `json:"latest"`
	Days    []BiliSnapshot `json:"days"`
	Trends  []BiliTrend    `json:"trends"`
}

// BiliSession 是一个私信会话。
type BiliSession struct {
	TalkerID   string  `json:"talker_id"`
	TalkerName string  `json:"talker_name"`
	TalkerFace string  `json:"talker_face"`
	Unread     int     `json:"unread"`
	LastText   string  `json:"last_text"`
	LastAt     *string `json:"last_at,omitempty"`
	UpdatedAt  string  `json:"updated_at"`
}

// BiliMessage 是一条私信，收到的和发出的。
type BiliMessage struct {
	ID          string `json:"id"`
	TalkerID    string `json:"talker_id"`
	Direction   string `json:"direction"` // in / out
	MsgType     int    `json:"msg_type"`
	Text        string `json:"text"`
	At          string `json:"at"`
	Status      string `json:"status"` // received / sending / sent / failed
	Error       string `json:"error,omitempty"`
	ClientMsgID string `json:"client_msg_id,omitempty"`
	CreatedAt   string `json:"created_at"`
}

type biliProfile struct {
	MID, Uname, Face, Login, DevID string
	InboxReady                     bool
	InboxSyncedAt                  *string
	GuardUntil                     *string
	GuardReason                    string
	GuardCode, GuardStrikes        int
}

// biliState 是 B 站组件在进程里的状态：扫码登录的待确认项、拉私信的锁。
type biliState struct {
	web    *biliWeb
	mu     sync.Mutex
	logins map[string]biliPending
	inbox  sync.Map // 每个实例一把锁：后台任务和手动刷新不同时拉
}

type biliPending struct {
	cid, key string
	expires  time.Time
}

func (h *handler) registerBili(r plugin.Registrar, w *biliWeb) {
	h.bili = &biliState{web: w, logins: map[string]biliPending{}}
	w.c = r.Core()
	r.Connector(w.ConnectorDef())
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/video/bili/accounts", h.listBiliAccounts)
		m.HandleFunc("POST /api/video/bili/{cid}/login/qrcode", h.biliLoginStart)
		m.HandleFunc("POST /api/video/bili/{cid}/login/poll", h.biliLoginPoll)
		m.HandleFunc("POST /api/video/bili/{cid}/logout", h.biliLogout)
		m.HandleFunc("GET /api/video/bili/{cid}/overview", h.biliOverview)
		m.HandleFunc("POST /api/video/bili/{cid}/overview/refresh", h.biliOverviewRefresh)
		m.HandleFunc("GET /api/video/bili/{cid}/sessions", h.biliSessions)
		m.HandleFunc("POST /api/video/bili/{cid}/sessions/refresh", h.biliSessionsRefresh)
		m.HandleFunc("GET /api/video/bili/{cid}/sessions/{talker}/messages", h.biliMessages)
		m.HandleFunc("POST /api/video/bili/{cid}/sessions/{talker}/sync", h.biliTalkerSync)
		m.HandleFunc("POST /api/video/bili/{cid}/sessions/{talker}/messages", h.biliSend)
	})
	r.Job(plugin.Job{Name: "bili_inbox", Every: biliInboxEvery, Run: h.biliInboxJob})
	r.Job(plugin.Job{Name: "bili_daily", Every: biliDailyEvery, Run: h.biliDailyJob})
}

// --- 实例、资料、退避 ---

// biliConnector 是 bilibili_web 的实例；不存在、不是这个工具的 404。
func (h *handler) biliConnector(ctx context.Context, id string) (plugin.ConnectorInfo, error) {
	cn, err := h.c.Connectors().Get(ctx, id)
	if errors.Is(err, plugin.ErrNoRows) || err == nil && cn.Tool != BiliWebTool {
		return cn, apiErr(errNotFound, "B 站网页登录连接器 %s 不存在", id)
	}
	return cn, err
}

func biliUsable(cn plugin.ConnectorInfo) error {
	switch cn.Status {
	case "paused":
		return apiErr(errConflict, "连接器「%s」已暂停", cn.Name)
	case "disconnected":
		return apiErr(errConflict, "连接器「%s」已断开", cn.Name)
	}
	return nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// biliDevID 是发私信要带的消息设备号：随机 UUID 形状，每个实例一个。
func biliDevID() string {
	s := strings.ToUpper(randHex(16))
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func (h *handler) biliProfile(ctx context.Context, cid string) (biliProfile, error) {
	var p biliProfile
	var ready int
	err := h.c.Store().QueryRow(ctx, `SELECT mid, uname, face, login, dev_id, inbox_ready, inbox_synced_at, guard_until, guard_reason, guard_code, guard_strikes
		FROM video_bili_profiles WHERE connector_id = ?`, cid).Scan(&p.MID, &p.Uname, &p.Face, &p.Login, &p.DevID, &ready, &p.InboxSyncedAt,
		&p.GuardUntil, &p.GuardReason, &p.GuardCode, &p.GuardStrikes)
	if errors.Is(err, plugin.ErrNoRows) {
		p = biliProfile{Login: "logged_out", DevID: biliDevID()}
		now := nowStr()
		_, err = h.c.Store().Exec(ctx, `INSERT INTO video_bili_profiles (connector_id, login, dev_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(connector_id) DO NOTHING`, cid, p.Login, p.DevID, now, now)
		if err != nil {
			return p, err
		}
		return h.biliProfile(ctx, cid)
	}
	p.InboxReady = ready == 1
	return p, err
}

func (p biliProfile) guard(now time.Time) *BiliGuard {
	if p.GuardUntil == nil || !parseTime(*p.GuardUntil).After(now) {
		return nil
	}
	return &BiliGuard{Until: *p.GuardUntil, Reason: p.GuardReason, Code: p.GuardCode}
}

// biliGuardedError 是退避中、这次没有发请求。
type biliGuardedError struct{ g BiliGuard }

func (e *biliGuardedError) Error() string {
	return fmt.Sprintf("B 站请求暂停到 %s：%s", parseTime(e.g.Until).In(biliTZ).Format("01-02 15:04"), e.g.Reason)
}

// bumpGuard 记一次被限频、风控：连续次数加一，退避翻倍。
func (h *handler) bumpGuard(ctx context.Context, cid string, p biliProfile, be *BiliWebError) BiliGuard {
	n := p.GuardStrikes + 1
	d := biliGuardBase << min(n-1, 10)
	if d > biliGuardMax || d <= 0 {
		d = biliGuardMax
	}
	if be.Captcha && d < 30*time.Minute {
		d = 30 * time.Minute
	}
	g := BiliGuard{Until: time.Now().UTC().Add(d).Format(time.RFC3339), Reason: be.Error(), Code: be.Code}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET guard_until = ?, guard_reason = ?, guard_code = ?, guard_strikes = ?, updated_at = ?
		WHERE connector_id = ?`, g.Until, g.Reason, g.Code, n, nowStr(), cid); err != nil {
		h.c.Log().Warn("record bilibili guard", "connector", cid, "err", err)
	}
	h.c.Log().Warn("bilibili web rate limited, backing off", "connector", cid, "code", be.Code, "strikes", n, "until", g.Until)
	return g
}

// biliRun 跑一组网页接口调用：退避中直接回、不发请求；needLogin 时从保险箱取登录态（没登录回登录失效）。
// 结束后按错误归类：被限频、风控记退避；登录失效把账号标成过期、连接器置为异常；连不上的连接器置为异常；成功清掉退避、恢复连接器。
func (h *handler) biliRun(ctx context.Context, cn plugin.ConnectorInfo, needLogin bool, fn func(s biliSession, p biliProfile) error) error {
	if err := biliUsable(cn); err != nil {
		return err
	}
	p, err := h.biliProfile(ctx, cn.ID)
	if err != nil {
		return err
	}
	if g := p.guard(time.Now()); g != nil {
		return &biliGuardedError{*g}
	}
	hc, err := h.c.HTTP("media-platforms")
	if err != nil {
		return err
	}
	if needLogin {
		err = h.c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
			s := biliSessionOf(hc, cfg)
			if s.cookie == "" || p.Login == "logged_out" {
				return &BiliWebError{Code: -101, Msg: "还没扫码登录", Login: true}
			}
			return fn(s, p)
		})
	} else {
		err = fn(biliSession{hc: hc}, p)
	}
	if ctx.Err() != nil {
		return err
	}
	be := biliWebErr(err)
	switch {
	case err == nil:
		if p.GuardStrikes > 0 || p.GuardUntil != nil {
			_, _ = h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET guard_until = NULL, guard_reason = '', guard_code = 0, guard_strikes = 0, updated_at = ?
				WHERE connector_id = ?`, nowStr(), cn.ID)
		}
		if needLogin {
			h.biliRecord(ctx, cn.ID, nil)
		}
	case be != nil && be.Risk:
		return &biliGuardedError{h.bumpGuard(ctx, cn.ID, p, be)}
	case be != nil && be.Login:
		if p.Login == "logged_in" {
			_, _ = h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET login = 'expired', updated_at = ? WHERE connector_id = ?`, nowStr(), cn.ID)
		}
		h.biliRecord(ctx, cn.ID, errors.New("B 站登录已失效，到「视频 / B 站」重新扫码登录"))
	case be != nil && be.Net:
		h.biliRecord(ctx, cn.ID, err)
	}
	return err
}

func (h *handler) biliRecord(ctx context.Context, cid string, err error) {
	if _, rerr := h.c.Connectors().RecordSync(ctx, cid, err); rerr != nil {
		h.c.Log().Warn("record bilibili connector", "connector", cid, "err", rerr)
	}
}

// biliFail 写回错误：退避中 429 bili_guarded（带 guard）；登录失效 409 bili_login_required；别的网页接口错误 502 bili_failed。
func (h *handler) biliFail(w http.ResponseWriter, r *http.Request, err error, extra map[string]any) {
	var ge *biliGuardedError
	e := map[string]any{"message": err.Error()}
	for k, v := range extra {
		e[k] = v
	}
	status := 0
	if errors.As(err, &ge) {
		status, e["code"], e["guard"] = http.StatusTooManyRequests, "bili_guarded", ge.g
	} else if be := biliWebErr(err); be != nil && be.Login {
		status, e["code"] = http.StatusConflict, "bili_login_required"
	} else if be != nil {
		status, e["code"] = http.StatusBadGateway, "bili_failed"
	}
	if status == 0 {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"error": e})
}

// --- 账号 ---

func (h *handler) biliAccount(ctx context.Context, cn plugin.ConnectorInfo) (BiliAccount, error) {
	p, err := h.biliProfile(ctx, cn.ID)
	if err != nil {
		return BiliAccount{}, err
	}
	a := BiliAccount{ConnectorID: cn.ID, Name: cn.Name, Status: cn.Status, Error: cn.Error, Login: p.Login, MID: p.MID, Uname: p.Uname, Face: p.Face,
		Guard: p.guard(time.Now()), InboxSyncedAt: p.InboxSyncedAt, PollSec: int(biliInboxEvery / time.Second)}
	if err := h.c.Store().QueryRow(ctx, `SELECT COALESCE(SUM(unread), 0) FROM video_bili_sessions WHERE connector_id = ?`, cn.ID).Scan(&a.Unread); err != nil {
		return a, err
	}
	var at sql.NullString
	if err := h.c.Store().QueryRow(ctx, `SELECT MAX(updated_at) FROM video_bili_snapshots WHERE connector_id = ?`, cn.ID).Scan(&at); err != nil {
		return a, err
	}
	if at.Valid {
		a.SnapshotAt = &at.String
	}
	return a, nil
}

func (h *handler) listBiliAccounts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := h.c.Connectors().List(ctx, BiliWebTool)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out := []BiliAccount{}
	// 先建的在前，同连接器页
	for i := len(list) - 1; i >= 0; i-- {
		a, err := h.biliAccount(ctx, list[i])
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// --- 扫码登录 ---

func (h *handler) biliLoginStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var loginURL, key string
	err = h.biliRun(ctx, cn, false, func(s biliSession, _ biliProfile) error {
		var err error
		loginURL, key, err = h.bili.web.qrGenerate(ctx, s.hc)
		return err
	})
	if err != nil {
		h.biliFail(w, r, err, nil)
		return
	}
	svg, err := qrSVG(loginURL)
	if err != nil {
		h.biliFail(w, r, &BiliWebError{Msg: "登录地址太长，生成不了二维码"}, nil)
		return
	}
	id := randHex(12)
	exp := time.Now().Add(biliQRLifetime)
	h.bili.mu.Lock()
	for k, v := range h.bili.logins {
		if time.Now().After(v.expires) || v.cid == cn.ID {
			delete(h.bili.logins, k)
		}
	}
	h.bili.logins[id] = biliPending{cid: cn.ID, key: key, expires: exp}
	h.bili.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"login_id": id, "qr_svg": svg, "expires_at": exp.UTC().Format(time.RFC3339)}})
}

func (h *handler) biliLoginPoll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	raw, err := readBody(r, "login_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var id string
	if err := strField(raw, "login_id", "login_id", &id, 64); err != nil || id == "" {
		fail(w, r, h.c, apiErr(errValidation, "login_id 必填"))
		return
	}
	h.bili.mu.Lock()
	pend, ok := h.bili.logins[id]
	h.bili.mu.Unlock()
	res := func(state, msg string) {
		out := map[string]any{"state": state, "message": msg}
		if state == "done" {
			if cur, err := h.c.Connectors().Get(ctx, cn.ID); err == nil {
				cn = cur
			}
			if a, err := h.biliAccount(ctx, cn); err == nil {
				out["account"] = a
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": out})
	}
	if !ok || pend.cid != cn.ID || time.Now().After(pend.expires) {
		res("expired", "二维码已过期，重新生成一个")
		return
	}
	var state int
	var msg string
	err = h.biliRun(ctx, cn, false, func(s biliSession, p biliProfile) error {
		var login *biliLogin
		var err error
		state, msg, login, err = h.bili.web.qrPoll(ctx, s.hc, pend.key)
		if err != nil || login == nil {
			return err
		}
		// 拿新登录态查一次账号，再一起写进保险箱
		ls := biliSession{hc: s.hc, cookie: login.Cookie, csrf: login.CSRF}
		nav, err := h.bili.web.nav(ctx, ls)
		if err != nil {
			return err
		}
		if _, err := h.c.Connectors().SaveSession(ctx, cn.ID, map[string]string{
			biliKeyCookie: login.Cookie, biliKeyCSRF: login.CSRF, biliKeyRefresh: login.Refresh,
		}, nav.Uname); err != nil {
			return err
		}
		mid := strconv.FormatInt(nav.MID, 10)
		if p.MID != "" && p.MID != mid {
			// 换了账号：上一个账号的会话、消息、数据不混进来
			for _, t := range []string{"video_bili_sessions", "video_bili_messages", "video_bili_snapshots", "video_bili_trends"} {
				if _, err := h.c.Store().Exec(ctx, `DELETE FROM `+t+` WHERE connector_id = ?`, cn.ID); err != nil {
					return err
				}
			}
			p.InboxReady = false
		}
		ready := 0
		if p.InboxReady {
			ready = 1
		}
		_, err = h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET mid = ?, uname = ?, face = ?, login = 'logged_in', inbox_ready = ?, updated_at = ?
			WHERE connector_id = ?`, mid, nav.Uname, nav.Face, ready, nowStr(), cn.ID)
		return err
	})
	if err != nil {
		h.biliFail(w, r, err, nil)
		return
	}
	switch state {
	case biliQRDone:
		h.bili.mu.Lock()
		delete(h.bili.logins, id)
		h.bili.mu.Unlock()
		h.biliRecord(ctx, cn.ID, nil)
		res("done", "登录成功")
	case biliQRScanned:
		res("scanned", "已扫码，在手机上确认登录")
	case biliQRExpired:
		h.bili.mu.Lock()
		delete(h.bili.logins, id)
		h.bili.mu.Unlock()
		res("expired", "二维码已过期，重新生成一个")
	case biliQRWaiting:
		res("waiting", "等待扫码")
	default:
		res("waiting", clipText(msg, 100))
	}
}

func (h *handler) biliLogout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.biliProfile(ctx, cn.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Connectors().SaveSession(ctx, cn.ID, map[string]string{biliKeyCookie: "", biliKeyCSRF: "", biliKeyRefresh: ""}, ""); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET login = 'logged_out', updated_at = ? WHERE connector_id = ?`, nowStr(), cn.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.biliRecord(ctx, cn.ID, errors.New("已退出 B 站登录，到「视频 / B 站」扫码登录"))
	cn, _ = h.c.Connectors().Get(ctx, cn.ID)
	a, err := h.biliAccount(ctx, cn)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": a})
}

// --- 账户概览 ---

const biliSnapCols = `date, source, followers, following, archives, total_click, total_like, total_coin, total_fav, total_reply, total_dm,
	total_share, total_elec, incr_fans, incr_click, updated_at`

func scanBiliSnapshot(row plugin.Row) (BiliSnapshot, error) {
	var s BiliSnapshot
	err := row.Scan(&s.Date, &s.Source, &s.Followers, &s.Following, &s.Archives, &s.TotalClick, &s.TotalLike, &s.TotalCoin, &s.TotalFav,
		&s.TotalReply, &s.TotalDM, &s.TotalShare, &s.TotalElec, &s.IncrFans, &s.IncrClick, &s.UpdatedAt)
	return s, err
}

func (h *handler) biliOverviewOf(ctx context.Context, cn plugin.ConnectorInfo) (BiliOverview, error) {
	a, err := h.biliAccount(ctx, cn)
	if err != nil {
		return BiliOverview{}, err
	}
	out := BiliOverview{Account: a, Days: []BiliSnapshot{}, Trends: []BiliTrend{}}
	from := time.Now().In(biliTZ).AddDate(0, 0, -90).Format(time.DateOnly)
	rows, err := h.c.Store().Query(ctx, `SELECT `+biliSnapCols+` FROM video_bili_snapshots WHERE connector_id = ? AND date >= ? ORDER BY date`, cn.ID, from)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		s, err := scanBiliSnapshot(rows)
		if err != nil {
			_ = rows.Close()
			return out, err
		}
		out.Days = append(out.Days, s)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if n := len(out.Days); n > 0 {
		last := out.Days[n-1]
		out.Latest = &last
	}
	for _, m := range BiliTrendMetrics {
		t := BiliTrend{Metric: m, Points: []BiliTrendPoint{}}
		rows, err := h.c.Store().Query(ctx, `SELECT date, value FROM video_bili_trends WHERE connector_id = ? AND metric = ? AND date >= ? ORDER BY date`, cn.ID, m, from)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var p BiliTrendPoint
			if err := rows.Scan(&p.Date, &p.Value); err != nil {
				_ = rows.Close()
				return out, err
			}
			t.Points = append(t.Points, p)
		}
		_ = rows.Close()
		out.Trends = append(out.Trends, t)
	}
	return out, nil
}

func (h *handler) biliOverview(w http.ResponseWriter, r *http.Request) {
	cn, err := h.biliConnector(r.Context(), r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.biliOverviewOf(r.Context(), cn)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (h *handler) biliOverviewRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var last sql.NullString
	if err := h.c.Store().QueryRow(ctx, `SELECT MAX(updated_at) FROM video_bili_snapshots WHERE connector_id = ?`, cn.ID).Scan(&last); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if last.Valid {
		if left := biliRefreshMin - time.Since(parseTime(last.String)); left > 0 {
			fail(w, r, h.c, apiErr(errConflict, "刚刷新过，%d 分钟后再刷新", int(left.Minutes())+1))
			return
		}
	}
	if err := h.biliPullOverview(ctx, cn); err != nil {
		h.biliFail(w, r, err, nil)
		return
	}
	out, err := h.biliOverviewOf(ctx, cn)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

func i64(v int64) *int64 { return &v }

// biliPullOverview 拉一次账户数据存成当天快照：网页端拿账号、粉丝关注、创作中心概览和按天趋势；
// 接了开放平台、而且是同一个账号（昵称对得上）的，粉丝、关注、过审稿件数取开放平台。
func (h *handler) biliPullOverview(ctx context.Context, cn plugin.ConnectorInfo) error {
	web := h.bili.web
	var snap BiliSnapshot
	trends := map[string][]biliDayValue{}
	var uname string
	err := h.biliRun(ctx, cn, true, func(s biliSession, p biliProfile) error {
		nav, err := web.nav(ctx, s)
		if err != nil {
			return err
		}
		uname = nav.Uname
		mid := strconv.FormatInt(nav.MID, 10)
		if nav.Uname != p.Uname || nav.Face != p.Face || mid != p.MID {
			if _, err := h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET mid = ?, uname = ?, face = ?, updated_at = ? WHERE connector_id = ?`,
				mid, nav.Uname, nav.Face, nowStr(), cn.ID); err != nil {
				return err
			}
		}
		rel, err := web.relation(ctx, s, mid)
		if err != nil {
			return err
		}
		st, err := web.indexStat(ctx, s)
		if err != nil {
			return err
		}
		snap = BiliSnapshot{Source: "web", Followers: i64(rel.Follower), Following: i64(rel.Following), TotalClick: st.TotalClick,
			TotalLike: st.TotalLike, TotalCoin: st.TotalCoin, TotalFav: st.TotalFav, TotalReply: st.TotalReply, TotalDM: st.TotalDM,
			TotalShare: st.TotalShare, TotalElec: st.TotalElec, IncrFans: st.IncrFans, IncrClick: st.IncrClick}
		for _, m := range BiliTrendMetrics {
			xs, err := web.pandect(ctx, s, m)
			if err != nil {
				return err
			}
			trends[m] = xs
		}
		return nil
	})
	if err != nil {
		return err
	}
	if ost, ok := h.biliOpenStat(ctx, uname); ok {
		snap.Source = "open+web"
		snap.Followers, snap.Following, snap.Archives = i64(ost.Follower), i64(ost.Following), i64(ost.Archives)
	}
	snap.Date = time.Now().In(biliTZ).Format(time.DateOnly)
	snap.UpdatedAt = nowStr()
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_bili_snapshots (connector_id, `+biliSnapCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(connector_id, date) DO UPDATE SET source = excluded.source, followers = excluded.followers, following = excluded.following,
		archives = excluded.archives, total_click = excluded.total_click, total_like = excluded.total_like, total_coin = excluded.total_coin,
		total_fav = excluded.total_fav, total_reply = excluded.total_reply, total_dm = excluded.total_dm, total_share = excluded.total_share,
		total_elec = excluded.total_elec, incr_fans = excluded.incr_fans, incr_click = excluded.incr_click, updated_at = excluded.updated_at`,
		cn.ID, snap.Date, snap.Source, snap.Followers, snap.Following, snap.Archives, snap.TotalClick, snap.TotalLike, snap.TotalCoin, snap.TotalFav,
		snap.TotalReply, snap.TotalDM, snap.TotalShare, snap.TotalElec, snap.IncrFans, snap.IncrClick, snap.UpdatedAt); err != nil {
		return err
	}
	for m, xs := range trends {
		for _, x := range xs {
			if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_bili_trends (connector_id, metric, date, value) VALUES (?, ?, ?, ?)
				ON CONFLICT(connector_id, metric, date) DO UPDATE SET value = excluded.value`, cn.ID, m, x.Date, x.Value); err != nil {
				return err
			}
		}
	}
	return nil
}

// biliOpenStat 找一个接着的开放平台连接器、昵称和网页端账号对得上的，取粉丝、关注、过审稿件数；没有或出错回 false。
func (h *handler) biliOpenStat(ctx context.Context, uname string) (BiliOpenStat, bool) {
	b, ok := h.platforms["bilibili"].(*Bilibili)
	if !ok || uname == "" {
		return BiliOpenStat{}, false
	}
	list, err := h.c.Connectors().List(ctx, BilibiliTool)
	if err != nil {
		return BiliOpenStat{}, false
	}
	for _, cn := range list {
		if cn.Status == "paused" || cn.Status == "disconnected" || cn.Account != "" && cn.Account != uname {
			continue
		}
		var st BiliOpenStat
		err := h.withPlatform(ctx, cn, func(s Session) error {
			var err error
			st, err = b.UserStat(ctx, s)
			return err
		})
		if err != nil {
			h.c.Log().Warn("bilibili open platform user stat", "connector", cn.ID, "err", err)
			continue
		}
		if st.Name == uname {
			return st, true
		}
	}
	return BiliOpenStat{}, false
}

// --- 私信 ---

const biliSessionCols = `talker_id, talker_name, talker_face, unread, last_text, last_at, updated_at`

func (h *handler) biliSessionList(ctx context.Context, cid string) ([]BiliSession, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+biliSessionCols+` FROM video_bili_sessions WHERE connector_id = ?
		ORDER BY COALESCE(last_at, '') DESC, talker_id`, cid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []BiliSession{}
	for rows.Next() {
		var s BiliSession
		if err := rows.Scan(&s.TalkerID, &s.TalkerName, &s.TalkerFace, &s.Unread, &s.LastText, &s.LastAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (h *handler) writeBiliSessions(w http.ResponseWriter, r *http.Request, cn plugin.ConnectorInfo) {
	list, err := h.biliSessionList(r.Context(), cn.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.biliAccount(r.Context(), cn)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": list, "meta": map[string]any{"total": len(list), "unread": a.Unread, "account": a}})
}

func (h *handler) biliSessions(w http.ResponseWriter, r *http.Request) {
	cn, err := h.biliConnector(r.Context(), r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeBiliSessions(w, r, cn)
}

func (h *handler) biliSessionsRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	p, err := h.biliProfile(ctx, cn.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.InboxSyncedAt != nil {
		if left := biliInboxMin - time.Since(parseTime(*p.InboxSyncedAt)); left > 0 {
			fail(w, r, h.c, apiErr(errConflict, "刚拉过，%d 秒后再刷新", int(left.Seconds())+1))
			return
		}
	}
	if _, err := h.biliSyncInbox(ctx, cn, true); err != nil {
		h.biliFail(w, r, err, nil)
		return
	}
	h.writeBiliSessions(w, r, cn)
}

func (h *handler) inboxLock(cid string) *sync.Mutex {
	v, _ := h.bili.inbox.LoadOrStore(cid, &sync.Mutex{})
	return v.(*sync.Mutex)
}

func biliTime(ts int64) *string {
	if ts <= 0 {
		return nil
	}
	s := time.Unix(ts, 0).UTC().Format(time.RFC3339)
	return &s
}

// biliSyncInbox 拉一轮私信：会话列表一次；第一次登录后只记基线、不拉历史消息、不发通知；
// 之后对方发来了新消息的会话（最多 biliFetchSessions 个）拉新消息落库，有新收到的发一条通知。回新收到的条数。
func (h *handler) biliSyncInbox(ctx context.Context, cn plugin.ConnectorInfo, notify bool) (int, error) {
	mu := h.inboxLock(cn.ID)
	mu.Lock()
	defer mu.Unlock()
	web := h.bili.web
	newIn := 0
	var senders []string
	err := h.biliRun(ctx, cn, true, func(s biliSession, p biliProfile) error {
		list, err := web.sessions(ctx, s)
		if err != nil {
			return err
		}
		now := nowStr()
		fetched := 0
		var unnamed []string
		for _, x := range list {
			tid := strconv.FormatInt(x.TalkerID, 10)
			remote := x.MaxSeqno
			text, at := "", (*string)(nil)
			if x.LastMsg != nil {
				remote = max(remote, x.LastMsg.MsgSeqno)
				text, at = clipText(biliMsgText(x.LastMsg.MsgType, x.LastMsg.Content), 100), biliTime(x.LastMsg.Timestamp)
			}
			if at == nil {
				at = biliTime(x.SessionTS / 1e6)
			}
			var local int64
			var name string
			err := h.c.Store().QueryRow(ctx, `SELECT last_seqno, talker_name FROM video_bili_sessions WHERE connector_id = ? AND talker_id = ?`, cn.ID, tid).Scan(&local, &name)
			known := err == nil
			if err != nil && !errors.Is(err, plugin.ErrNoRows) {
				return err
			}
			if !p.InboxReady {
				local = remote // 基线：之前的不算新的
			}
			if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_bili_sessions (connector_id, talker_id, unread, last_text, last_at, last_seqno, remote_seqno, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connector_id, talker_id) DO UPDATE SET unread = excluded.unread, last_text = excluded.last_text,
				last_at = excluded.last_at, remote_seqno = excluded.remote_seqno, updated_at = excluded.updated_at`,
				cn.ID, tid, x.UnreadCount, text, at, local, remote, now); err != nil {
				return err
			}
			if !known || name == "" {
				unnamed = append(unnamed, tid)
			}
			if !p.InboxReady || remote <= local || fetched >= biliFetchSessions {
				continue
			}
			fetched++
			n, err := h.biliPullTalker(ctx, cn.ID, s, p, tid, local)
			if err != nil {
				return err
			}
			if n > 0 {
				newIn += n
				senders = append(senders, tid)
			}
		}
		if len(unnamed) > 0 {
			cards, err := web.cards(ctx, s, unnamed[:min(len(unnamed), 20)])
			if err != nil {
				return err
			}
			for _, c := range cards {
				if _, err := h.c.Store().Exec(ctx, `UPDATE video_bili_sessions SET talker_name = ?, talker_face = ? WHERE connector_id = ? AND talker_id = ?`,
					clipText(c.Name, 100), c.Face, cn.ID, strconv.FormatInt(c.MID, 10)); err != nil {
					return err
				}
			}
		}
		_, err = h.c.Store().Exec(ctx, `UPDATE video_bili_profiles SET inbox_ready = 1, inbox_synced_at = ?, updated_at = ? WHERE connector_id = ?`, now, now, cn.ID)
		return err
	})
	if err != nil {
		return 0, err
	}
	if notify && newIn > 0 {
		h.biliNotify(ctx, cn, senders, newIn)
	}
	return newIn, nil
}

// biliNotify 发「B 站新私信」通知：只写谁发来、几条，不写消息内容，更不带任何凭证。
func (h *handler) biliNotify(ctx context.Context, cn plugin.ConnectorInfo, senders []string, n int) {
	var name string
	_ = h.c.Store().QueryRow(ctx, `SELECT talker_name FROM video_bili_sessions WHERE connector_id = ? AND talker_id = ?`, cn.ID, senders[0]).Scan(&name)
	if name == "" {
		name = "UID " + senders[0]
	}
	body := fmt.Sprintf("「%s」发来 %d 条私信", name, n)
	if len(senders) > 1 {
		body = fmt.Sprintf("「%s」等 %d 人发来 %d 条私信", name, len(senders), n)
	}
	if err := h.c.Notify(ctx, plugin.Notification{Kind: "bili_dm", Title: "B 站新私信", Body: body,
		Data: map[string]any{"connector_id": cn.ID, "talker_id": senders[0], "count": n}}); err != nil {
		h.c.Log().Warn("notify bilibili dm", "connector", cn.ID, "err", err)
	}
}

// biliPullTalker 拉和 talker 在 after 之后的消息落库（已经有的按 msg_key 跳过），更新会话的 last_seqno，回新收到（对方发来）的条数。
func (h *handler) biliPullTalker(ctx context.Context, cid string, s biliSession, p biliProfile, tid string, after int64) (int, error) {
	msgs, err := h.bili.web.messages(ctx, s, tid, after, biliPageSize)
	if err != nil {
		return 0, err
	}
	newIn := 0
	top := after
	for _, m := range msgs {
		if m.MsgSeqno <= after {
			continue
		}
		top = max(top, m.MsgSeqno)
		dir, status := "in", "received"
		if strconv.FormatInt(m.SenderUID, 10) == p.MID {
			dir, status = "out", "sent"
		}
		key := ""
		if m.MsgKey != 0 {
			key = strconv.FormatInt(m.MsgKey, 10)
		}
		at := biliTime(m.Timestamp)
		if at == nil {
			now := nowStr()
			at = &now
		}
		res, err := h.c.Store().Exec(ctx, `INSERT INTO video_bili_messages (id, connector_id, talker_id, direction, sender_uid, seqno, msg_key, msg_type, text, at, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			idgen.Prefixed("bpm"), cid, tid, dir, strconv.FormatInt(m.SenderUID, 10), m.MsgSeqno, key, m.MsgType,
			clipText(biliMsgText(m.MsgType, m.Content), 2000), *at, status, nowStr())
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n == 0 && key != "" {
			// 自己发的那条早就落库了：补上序号
			_, _ = h.c.Store().Exec(ctx, `UPDATE video_bili_messages SET seqno = ? WHERE connector_id = ? AND msg_key = ?`, m.MsgSeqno, cid, key)
		} else if n > 0 && dir == "in" {
			newIn++
		}
	}
	if top > after {
		if _, err := h.c.Store().Exec(ctx, `UPDATE video_bili_sessions SET last_seqno = ? WHERE connector_id = ? AND talker_id = ? AND last_seqno < ?`,
			top, cid, tid, top); err != nil {
			return 0, err
		}
	}
	return newIn, nil
}

const biliMsgCols = `id, talker_id, direction, msg_type, text, at, status, error, client_msg_id, created_at`

func scanBiliMessage(row plugin.Row) (BiliMessage, error) {
	var m BiliMessage
	err := row.Scan(&m.ID, &m.TalkerID, &m.Direction, &m.MsgType, &m.Text, &m.At, &m.Status, &m.Error, &m.ClientMsgID, &m.CreatedAt)
	return m, err
}

func (h *handler) biliTalker(ctx context.Context, cid, tid string) (BiliSession, error) {
	var s BiliSession
	s.TalkerID = tid
	err := h.c.Store().QueryRow(ctx, `SELECT talker_name, talker_face, unread, last_text, last_at, updated_at FROM video_bili_sessions
		WHERE connector_id = ? AND talker_id = ?`, cid, tid).Scan(&s.TalkerName, &s.TalkerFace, &s.Unread, &s.LastText, &s.LastAt, &s.UpdatedAt)
	if errors.Is(err, plugin.ErrNoRows) {
		return s, apiErr(errNotFound, "会话不存在：先刷新私信")
	}
	return s, err
}

// listBiliMessages 是一个会话的消息，按时间先后；before 给了只要更早的，limit 默认 50、最多 200（取最近的这么多条）。
func (h *handler) listBiliMessages(ctx context.Context, cid, tid, before string, limit int) ([]BiliMessage, bool, error) {
	q, args := `SELECT `+biliMsgCols+` FROM video_bili_messages WHERE connector_id = ? AND talker_id = ?`, []any{cid, tid}
	if before != "" {
		q, args = q+` AND at < ?`, append(args, before)
	}
	rows, err := h.c.Store().Query(ctx, q+` ORDER BY at DESC, rowid DESC LIMIT ?`, append(args, limit+1)...)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()
	out := []BiliMessage{}
	for rows.Next() {
		m, err := scanBiliMessage(rows)
		if err != nil {
			return nil, false, err
		}
		out = append(out, m)
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, more, rows.Err()
}

func (h *handler) writeBiliMessages(w http.ResponseWriter, r *http.Request, cid string, s BiliSession) {
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			fail(w, r, h.c, apiErr(errValidation, "limit 要在 1 到 200 之间"))
			return
		}
		limit = n
	}
	before := q.Get("before")
	if before != "" {
		t, err := time.Parse(time.RFC3339, before)
		if err != nil {
			fail(w, r, h.c, apiErr(errValidation, "before 不是合法的 RFC3339 时间"))
			return
		}
		before = t.UTC().Format(time.RFC3339)
	}
	list, more, err := h.listBiliMessages(r.Context(), cid, s.TalkerID, before, limit)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": list, "meta": map[string]any{"total": len(list), "has_more": more, "session": s}})
}

func (h *handler) biliMessages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	s, err := h.biliTalker(ctx, cn.ID, r.PathValue("talker"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeBiliMessages(w, r, cn.ID, s)
}

// biliTalkerSync 拉这个会话的新消息（打开会话时点「拉取消息」）；本地还没有消息的拉最近一页。
func (h *handler) biliTalkerSync(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	s, err := h.biliTalker(ctx, cn.ID, r.PathValue("talker"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var have int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_bili_messages WHERE connector_id = ? AND talker_id = ?`, cn.ID, s.TalkerID).Scan(&have); err != nil {
		fail(w, r, h.c, err)
		return
	}
	var after int64
	if have > 0 {
		if err := h.c.Store().QueryRow(ctx, `SELECT last_seqno FROM video_bili_sessions WHERE connector_id = ? AND talker_id = ?`, cn.ID, s.TalkerID).Scan(&after); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	mu := h.inboxLock(cn.ID)
	mu.Lock()
	err = h.biliRun(ctx, cn, true, func(bs biliSession, p biliProfile) error {
		_, err := h.biliPullTalker(ctx, cn.ID, bs, p, s.TalkerID, after)
		return err
	})
	mu.Unlock()
	if err != nil {
		h.biliFail(w, r, err, nil)
		return
	}
	h.writeBiliMessages(w, r, cn.ID, s)
}

var biliClientIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func (h *handler) biliMessageByClient(ctx context.Context, cid, client string) (BiliMessage, error) {
	m, err := scanBiliMessage(h.c.Store().QueryRow(ctx, `SELECT `+biliMsgCols+` FROM video_bili_messages WHERE connector_id = ? AND client_msg_id = ?`, cid, client))
	if errors.Is(err, plugin.ErrNoRows) {
		return m, errNotFound
	}
	return m, err
}

// biliSend 发一条文字私信：只在用户点发送时调。同一个 client_msg_id 只发一次：已经发过（成功或失败）的原样回 200、不再发，
// 正在发的 409。会话要已经在列表里（不能给任意 UID 发）。失败不自动重试，消息记成 failed，换一个 client_msg_id 才会再发。
func (h *handler) biliSend(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cn, err := h.biliConnector(ctx, r.PathValue("cid"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	raw, err := readBody(r, "client_msg_id", "text")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var client, text string
	if err := strField(raw, "client_msg_id", "client_msg_id", &client, 64); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if !biliClientIDRe.MatchString(client) {
		fail(w, r, h.c, apiErr(errValidation, "client_msg_id 必填，8 到 64 位字母、数字、- 或 _"))
		return
	}
	if err := strField(raw, "text", "私信内容", &text, biliMaxText); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if text == "" {
		fail(w, r, h.c, apiErr(errValidation, "私信内容不能为空"))
		return
	}
	s, err := h.biliTalker(ctx, cn.ID, r.PathValue("talker"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	dup := func() bool {
		m, err := h.biliMessageByClient(ctx, cn.ID, client)
		if errors.Is(err, errNotFound) {
			return false
		}
		if err != nil {
			fail(w, r, h.c, err)
			return true
		}
		if m.TalkerID != s.TalkerID || m.Text != text {
			fail(w, r, h.c, apiErr(errConflict, "client_msg_id 已经用在另一条消息上了"))
			return true
		}
		if m.Status == "sending" {
			fail(w, r, h.c, apiErr(errConflict, "这条消息正在发送"))
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": m, "meta": map[string]any{"duplicate": true}})
		return true
	}
	if dup() {
		return
	}
	id, now := idgen.Prefixed("bpm"), nowStr()
	res, err := h.c.Store().Exec(ctx, `INSERT INTO video_bili_messages (id, connector_id, talker_id, direction, msg_type, text, at, status, client_msg_id, created_at)
		VALUES (?, ?, ?, 'out', 1, ?, ?, 'sending', ?, ?) ON CONFLICT DO NOTHING`, id, cn.ID, s.TalkerID, text, now, client, now)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 并发的同一条抢先落库了
		dup()
		return
	}
	var key string
	sendErr := h.biliRun(ctx, cn, true, func(bs biliSession, p biliProfile) error {
		if p.MID == "" {
			return &BiliWebError{Code: -101, Msg: "还没扫码登录", Login: true}
		}
		var err error
		key, err = h.bili.web.send(ctx, bs, p.MID, s.TalkerID, p.DevID, text, time.Now())
		return err
	})
	// 请求已经结束：落库不跟着请求取消
	wctx := context.WithoutCancel(ctx)
	if sendErr != nil {
		msg := clipText(sendErr.Error(), 300)
		if _, err := h.c.Store().Exec(wctx, `UPDATE video_bili_messages SET status = 'failed', error = ? WHERE id = ?`, msg, id); err != nil {
			h.c.Log().Warn("record bilibili send failure", "message", id, "err", err)
		}
		h.biliFail(w, r, sendErr, map[string]any{"message_id": id})
		return
	}
	if _, err := h.c.Store().Exec(wctx, `UPDATE video_bili_messages SET status = 'sent', msg_key = ? WHERE id = ?`, key, id); err != nil {
		// msg_key 撞上已经拉到的同一条（极少见）：只标已发送，两条都留着
		_, _ = h.c.Store().Exec(wctx, `UPDATE video_bili_messages SET status = 'sent' WHERE id = ?`, id)
	}
	if _, err := h.c.Store().Exec(wctx, `UPDATE video_bili_sessions SET last_text = ?, last_at = ?, updated_at = ? WHERE connector_id = ? AND talker_id = ?`,
		clipText(text, 100), now, now, cn.ID, s.TalkerID); err != nil {
		h.c.Log().Warn("update bilibili session", "connector", cn.ID, "err", err)
	}
	m, err := scanBiliMessage(h.c.Store().QueryRow(wctx, `SELECT `+biliMsgCols+` FROM video_bili_messages WHERE id = ?`, id))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": m})
}

// --- 后台任务 ---

// biliActive 是登录着、没暂停断开的实例。
func (h *handler) biliActive(ctx context.Context) ([]plugin.ConnectorInfo, error) {
	list, err := h.c.Connectors().List(ctx, BiliWebTool)
	if err != nil {
		return nil, err
	}
	var out []plugin.ConnectorInfo
	for _, cn := range list {
		if biliUsable(cn) != nil {
			continue
		}
		p, err := h.biliProfile(ctx, cn.ID)
		if err != nil {
			return nil, err
		}
		if p.Login == "logged_in" && p.guard(time.Now()) == nil {
			out = append(out, cn)
		}
	}
	return out, nil
}

// biliInboxJob 是后台任务 bili_inbox 的一轮：每个登录着的实例拉一次私信，出错只记日志（退避、登录失效由 biliRun 记下）。
func (h *handler) biliInboxJob(ctx context.Context, _ plugin.Core) error {
	list, err := h.biliActive(ctx)
	if err != nil {
		return err
	}
	for _, cn := range list {
		if ctx.Err() != nil {
			return nil
		}
		if _, err := h.biliSyncInbox(ctx, cn, true); err != nil && ctx.Err() == nil {
			h.c.Log().Warn("pull bilibili messages", "connector", cn.ID, "err", err)
		}
	}
	return nil
}

// biliDailyJob 是后台任务 bili_daily 的一轮：当天（北京时间）还没有快照的拉一次。
func (h *handler) biliDailyJob(ctx context.Context, _ plugin.Core) error {
	list, err := h.biliActive(ctx)
	if err != nil {
		return err
	}
	today := time.Now().In(biliTZ).Format(time.DateOnly)
	for _, cn := range list {
		if ctx.Err() != nil {
			return nil
		}
		var n int
		if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_bili_snapshots WHERE connector_id = ? AND date = ?`, cn.ID, today).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if err := h.biliPullOverview(ctx, cn); err != nil && ctx.Err() == nil {
			h.c.Log().Warn("pull bilibili overview", "connector", cn.ID, "err", err)
		}
	}
	return nil
}
