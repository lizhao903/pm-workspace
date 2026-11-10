// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 抖音连接器（VID-04d）：抖音开放平台（open.douyin.com）。
// 能力只声明 metrics、comments：代用户发布视频（video.create）要应用单独申请、过资质审核，个人创作者的应用拿不到，
// 也没有定时发布；所以发布退化为「生成发布包加打开创作者后台」（GET /api/video/publishes/{id}/package），发完回填链接。
// 认证用令牌：开放平台的 OAuth 用 client_key、令牌包在 data 里，内核 OAuth 流程接不上，先由用户填 open_id 和 access_token，
// 令牌 15 天过期，刷新和专门的授权归 VID-04e。
// 稿件号：链接里是作品 id（douyin.com/video/<数字>），开放平台的数据接口认 video_ids；评论接口要加密的 item_id，先经数据接口换。
// 接口形状按开放平台文档写，测试对接本机假服务端（testdata/douyin），真实接通归 VID-04e。

// DouyinTool 是连接器 tool。
const DouyinTool = "douyin"

const (
	dyAPI     = "https://open.douyin.com"
	dyMaxResp = 4 << 20
)

// dyAuthCodes 是令牌失效、过期、没授权这个能力的错误码，遇到时连接器置为异常。
var dyAuthCodes = map[int]bool{2190002: true, 2190004: true, 2190008: true, 2190015: true, 28001003: true, 28001008: true, 28003017: true}

var (
	dyVideoRe = regexp.MustCompile(`(?:^|douyin\.com/(?:video|note)/)([0-9]{15,22})(?:[/?#]|$)`)
	dyItemRe  = regexp.MustCompile(`^@[0-9A-Za-z+/=._-]{8,200}$`)
)

// Douyin 是抖音适配器。
type Douyin struct {
	c plugin.Core
}

func NewDouyin() *Douyin { return &Douyin{} }

func (d *Douyin) Platform() string   { return "douyin" }
func (d *Douyin) Caps() []string     { return []string{CapMetrics, CapComments} }
func (d *Douyin) Bind(c plugin.Core) { d.c = c }

func (d *Douyin) ConnectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: DouyinTool, Label: "抖音", Category: "media", Color: "#161823",
		Desc: "抖音开放平台：拉作品的播放、点赞、评论、分享数据和评论；开放平台不给个人号代发布，发布用发布包到创作者后台",
		Auth: []connector.AuthMode{connector.AuthToken},
		Fields: []connector.Field{
			{Key: "open_id", Label: "Open ID", Kind: "text", Placeholder: "用户授权后拿到的 open_id", Required: true},
			{Key: "access_token", Label: "Access Token", Kind: "secret", Placeholder: "用户授权后拿到的 access_token（15 天过期）", Required: true},
		},
		Test: d.test,
	}
}

// test 取授权用户的昵称。
func (d *Douyin) test(ctx context.Context, cfg plugin.ConnectorConfig) (string, error) {
	if d.c == nil {
		return "", errors.New("视频插件还没启用")
	}
	hc, err := d.c.HTTP("media-platforms")
	if err != nil {
		return "", err
	}
	var out struct {
		Nickname string `json:"nickname"`
		OpenID   string `json:"open_id"`
	}
	form := url.Values{"open_id": {cfg.Get("open_id")}, "access_token": {cfg.Secret("access_token")}}
	if err := d.call(ctx, Session{HTTP: hc, Config: cfg}, "/oauth/userinfo/", []byte(form.Encode()), "application/x-www-form-urlencoded", &out); err != nil {
		return "", err
	}
	if out.Nickname == "" {
		return out.OpenID, nil
	}
	return out.Nickname, nil
}

func (d *Douyin) netErr(err error) error {
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return &PlatformError{Platform: "douyin", Msg: "插件 video 的 network:media-platforms 不允许访问这个地址", Channel: true}
	}
	var ne *plugin.NotGrantedError
	if errors.As(err, &ne) {
		return &PlatformError{Platform: "douyin", Msg: ne.Error(), Channel: true}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return &PlatformError{Platform: "douyin", Msg: fmt.Sprintf("连不上抖音：%v", err), Channel: true}
}

// call 用 POST 调一个开放平台接口（path 可带查询串，open_id 自动加），带 access-token 头；data 解进 out。
// 开放平台的错误码在 data.error_code（新接口另在 extra.error_code），0 是成功。
func (d *Douyin) call(ctx context.Context, s Session, path string, body []byte, ctype string, out any) error {
	method := http.MethodPost
	if body == nil {
		method = http.MethodGet
	}
	u := dyAPI + path
	if !strings.HasPrefix(path, "/oauth/") {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		u += sep + "open_id=" + url.QueryEscape(s.Config.Get("open_id"))
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("access-token", s.Config.Secret("access_token"))
	resp, err := s.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return d.netErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, dyMaxResp))
	if err != nil {
		return d.netErr(err)
	}
	authHTTP := resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden
	var env struct {
		Data  json.RawMessage `json:"data"`
		Extra struct {
			ErrorCode   int    `json:"error_code"`
			Description string `json:"description"`
		} `json:"extra"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return &PlatformError{Platform: "douyin", Code: resp.StatusCode, Msg: "回的不是 JSON", Auth: authHTTP, Channel: true}
	}
	var head struct {
		ErrorCode   int    `json:"error_code"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(env.Data, &head)
	code, desc := head.ErrorCode, head.Description
	if code == 0 {
		code, desc = env.Extra.ErrorCode, env.Extra.Description
	}
	if code != 0 {
		auth := dyAuthCodes[code] || authHTTP
		return &PlatformError{Platform: "douyin", Code: code, Msg: clipText(desc, 200), Auth: auth, Channel: auth || resp.StatusCode >= 500}
	}
	if resp.StatusCode >= 400 {
		return &PlatformError{Platform: "douyin", Code: resp.StatusCode, Msg: "请求失败", Auth: authHTTP, Channel: true}
	}
	if out == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return &PlatformError{Platform: "douyin", Msg: "返回的数据解析不了：" + err.Error(), Channel: true}
	}
	return nil
}

// --- 不支持的能力：没声明 upload，接口层不会调到，这里兜底 ---

func (d *Douyin) Validate(PublishInput) error { return ErrUnsupported }
func (d *Douyin) UploadVideo(context.Context, Session, LocalFile) (string, error) {
	return "", ErrUnsupported
}
func (d *Douyin) UploadCover(context.Context, Session, LocalFile) (string, error) {
	return "", ErrUnsupported
}
func (d *Douyin) Submit(context.Context, Session, PublishInput, string, string) (RemoteRef, error) {
	return RemoteRef{}, ErrUnsupported
}
func (d *Douyin) Status(context.Context, Session, RemoteRef) (RemoteStatus, error) {
	return RemoteStatus{}, ErrUnsupported
}

// RefOf 认 douyin.com/video/<作品 id> 的链接、裸的作品 id 和开放平台的 item_id（@ 开头）。
func (d *Douyin) RefOf(s string) (RemoteRef, bool) {
	s = strings.TrimSpace(s)
	if dyItemRe.MatchString(s) {
		return RemoteRef{ID: s}, true
	}
	m := dyVideoRe.FindStringSubmatch(s)
	if m == nil {
		return RemoteRef{}, false
	}
	return RemoteRef{ID: m[1], URL: "https://www.douyin.com/video/" + m[1]}, true
}

type dyItem struct {
	ItemID     string `json:"item_id"`
	VideoID    string `json:"video_id"`
	Title      string `json:"title"`
	CreateTime int64  `json:"create_time"`
	Statistics struct {
		PlayCount    int `json:"play_count"`
		DiggCount    int `json:"digg_count"`
		CommentCount int `json:"comment_count"`
		ShareCount   int `json:"share_count"`
		ForwardCount int `json:"forward_count"`
	} `json:"statistics"`
}

// item 经 video_data 查一条作品：作品 id 用 video_ids，item_id 用 item_ids。
func (d *Douyin) item(ctx context.Context, s Session, ref RemoteRef) (dyItem, error) {
	body := map[string][]string{"video_ids": {ref.ID}}
	if strings.HasPrefix(ref.ID, "@") {
		body = map[string][]string{"item_ids": {ref.ID}}
	}
	raw, _ := json.Marshal(body)
	var out struct {
		List []dyItem `json:"list"`
	}
	if err := d.call(ctx, s, "/api/douyin/v1/video/video_data/", raw, "application/json", &out); err != nil {
		return dyItem{}, err
	}
	if len(out.List) == 0 {
		return dyItem{}, &PlatformError{Platform: "douyin", Msg: "作品 " + ref.ID + " 不存在，或不是这个账号的"}
	}
	return out.List[0], nil
}

func (d *Douyin) Stats(ctx context.Context, s Session, ref RemoteRef) (RemoteStats, error) {
	it, err := d.item(ctx, s, ref)
	if err != nil {
		return RemoteStats{}, err
	}
	st := it.Statistics
	return RemoteStats{Views: st.PlayCount, Likes: st.DiggCount, Comments: st.CommentCount, Shares: st.ShareCount + st.ForwardCount}, nil
}

// Comments 拉一页评论（每页 20 条），cursor 是上一页回的游标。开放平台的评论没有昵称，author 是评论人的 open_id。
func (d *Douyin) Comments(ctx context.Context, s Session, ref RemoteRef, cursor string) (CommentPage, error) {
	itemID := ref.ID
	if !strings.HasPrefix(itemID, "@") {
		it, err := d.item(ctx, s, ref)
		if err != nil {
			return CommentPage{}, err
		}
		if itemID = it.ItemID; itemID == "" {
			return CommentPage{}, &PlatformError{Platform: "douyin", Msg: "数据接口没回作品的 item_id", Channel: true}
		}
	}
	if cursor == "" {
		cursor = "0"
	}
	if _, err := strconv.ParseInt(cursor, 10, 64); err != nil {
		return CommentPage{}, &PlatformError{Platform: "douyin", Msg: "cursor 要是上一页回的数字游标"}
	}
	var out struct {
		Cursor  int64 `json:"cursor"`
		HasMore bool  `json:"has_more"`
		List    []struct {
			CommentID     string `json:"comment_id"`
			CommentUserID string `json:"comment_user_id"`
			Content       string `json:"content"`
			CreateTime    int64  `json:"create_time"`
			DiggCount     int    `json:"digg_count"`
		} `json:"list"`
	}
	path := "/item/comment/list/?count=20&cursor=" + cursor + "&item_id=" + url.QueryEscape(itemID)
	if err := d.call(ctx, s, path, nil, "", &out); err != nil {
		return CommentPage{}, err
	}
	page := CommentPage{Items: make([]Comment, 0, len(out.List))}
	if out.HasMore {
		page.Next = strconv.FormatInt(out.Cursor, 10)
	}
	for _, c := range out.List {
		at := ""
		if c.CreateTime > 0 {
			at = time.Unix(c.CreateTime, 0).UTC().Format(time.RFC3339)
		}
		page.Items = append(page.Items, Comment{ID: c.CommentID, Author: c.CommentUserID, Text: c.Content, Likes: c.DiggCount, At: at})
	}
	return page, nil
}
