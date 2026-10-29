package video

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// B 站连接器（VID-04b）：对接 B 站开放平台（openhome.bilibili.com）的稿件接口。
// 认证用令牌：开放平台应用的 client_id、app_secret，加上用户授权后拿到的 access_token；开放平台的授权页用 gourl
// 而不是 redirect_uri，令牌接口回的也不是标准 OAuth 形状，内核的 OAuth 流程接不上，真实接通时（VID-04c）再看要不要做专门的授权。
// 每个请求按开放平台的签名规则带 x-bili-* 头和 HMAC-SHA256 的 Authorization。
// 流程：video/init 拿 upload_token，分片传到 openupos.bilivideo.com，video/complete 合片，cover/upload 传封面，
// add-by-utoken 投稿拿 BV 号；archive/view 查状态，data/arc/stat 拉数据。开放平台没有评论和定时投稿接口，这两项不声明。
// 接口形状按开放平台文档写，测试对接本机假服务端（testdata/bilibili 是响应样例），和真实返回对不上的地方归 VID-04c 修。

// BilibiliTool 是连接器 tool。
const BilibiliTool = "bilibili"

const (
	biliAPI      = "https://member.bilibili.com"
	biliUpos     = "https://openupos.bilivideo.com"
	biliChunk    = 8 << 20
	biliMaxCover = 5 << 20
	biliMaxResp  = 4 << 20
)

// biliAuthCodes 是开放平台表示令牌失效、没授权、没权限的错误码，遇到时连接器置为异常。
var biliAuthCodes = map[int]bool{-101: true, -401: true, -403: true, 10002: true, 10003: true, 10006: true}

var biliBVRe = regexp.MustCompile(`(?:^|/)(BV[0-9A-Za-z]{10})(?:[/?#]|$)`)

// Bilibili 是 B 站适配器。
type Bilibili struct {
	c     plugin.Core
	chunk int64
	now   func() time.Time
}

func NewBilibili() *Bilibili { return &Bilibili{chunk: biliChunk, now: time.Now} }

func (b *Bilibili) Platform() string   { return "bilibili" }
func (b *Bilibili) Caps() []string     { return []string{CapUpload, CapMetrics} }
func (b *Bilibili) Bind(c plugin.Core) { b.c = c }

func (b *Bilibili) ConnectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: BilibiliTool, Label: "B 站", Category: "media", Color: "#fb7299",
		Desc: "B 站开放平台：上传成片、设封面、投稿，查稿件状态，拉播放、点赞、投币、收藏数据",
		Auth: []connector.AuthMode{connector.AuthToken},
		Fields: []connector.Field{
			{Key: "client_id", Label: "Client ID", Kind: "text", Placeholder: "开放平台应用的 client_id", Required: true},
			{Key: "app_secret", Label: "App Secret", Kind: "secret", Placeholder: "开放平台应用的 app_secret", Required: true},
			{Key: "access_token", Label: "Access Token", Kind: "secret", Placeholder: "用户授权后拿到的 access_token", Required: true},
		},
		Test: b.test,
	}
}

func (b *Bilibili) test(ctx context.Context, cfg plugin.ConnectorConfig) (string, error) {
	if b.c == nil {
		return "", errors.New("视频插件还没启用")
	}
	hc, err := b.c.HTTP("media-platforms")
	if err != nil {
		return "", err
	}
	var info struct {
		Name   string `json:"name"`
		OpenID string `json:"openid"`
	}
	if err := b.call(ctx, Session{HTTP: hc, Config: cfg}, http.MethodGet, "/arcopen/fn/user/account/info", nil, &info); err != nil {
		return "", err
	}
	if info.Name == "" {
		return info.OpenID, nil
	}
	return info.Name, nil
}

// --- 调用和签名 ---

func (b *Bilibili) fail(code int, msg string) *PlatformError {
	return &PlatformError{Platform: "bilibili", Code: code, Msg: msg, Auth: biliAuthCodes[code], Channel: biliAuthCodes[code]}
}

// netErr 换成不带地址的说明：上传地址里有 upload_token。
func (b *Bilibili) netErr(err error) error {
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return &PlatformError{Platform: "bilibili", Msg: "插件 video 的 network:media-platforms 不允许访问这个地址", Channel: true}
	}
	var ne *plugin.NotGrantedError
	if errors.As(err, &ne) {
		return &PlatformError{Platform: "bilibili", Msg: ne.Error(), Channel: true}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return &PlatformError{Platform: "bilibili", Msg: fmt.Sprintf("连不上 B 站：%v", err), Channel: true}
}

func biliNonce() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// biliSignHeaders 是参与签名的头，按字典序。
var biliSignHeaders = []string{"x-bili-accesskeyid", "x-bili-content-md5", "x-bili-signature-method",
	"x-bili-signature-nonce", "x-bili-signature-version", "x-bili-timestamp"}

// biliSign 按开放平台规则算签名：参与签名的头按 key:value 一行一个拼起来，用 app_secret 做 HMAC-SHA256，十六进制小写。
func biliSign(secret string, h http.Header) string {
	lines := make([]string, len(biliSignHeaders))
	for i, k := range biliSignHeaders {
		lines[i] = k + ":" + h.Get(k)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(mac.Sum(nil))
}

func (b *Bilibili) sign(req *http.Request, cfg plugin.ConnectorConfig, body []byte) {
	sum := md5.Sum(body)
	h := req.Header
	h.Set("Accept", "application/json")
	h.Set("x-bili-accesskeyid", cfg.Get("client_id"))
	h.Set("x-bili-content-md5", hex.EncodeToString(sum[:]))
	h.Set("x-bili-signature-method", "HMAC-SHA256")
	h.Set("x-bili-signature-nonce", biliNonce())
	h.Set("x-bili-signature-version", "2.0")
	h.Set("x-bili-timestamp", strconv.FormatInt(b.now().Unix(), 10))
	h.Set("access-token", cfg.Secret("access_token"))
	h.Set("Authorization", biliSign(cfg.Secret("app_secret"), h))
}

// call 调一个开放平台接口：body 是 []byte 时原样发（Content-Type 由调用方写进 ctype），否则按 JSON 发；data 解进 out。
func (b *Bilibili) call(ctx context.Context, s Session, method, path string, body any, out any) error {
	var raw []byte
	ctype := "application/json"
	switch v := body.(type) {
	case nil:
	case multipartBody:
		raw, ctype = v.data, v.ctype
	default:
		var err error
		if raw, err = json.Marshal(v); err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, biliAPI+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", ctype)
	b.sign(req, s.Config, raw)
	return b.send(ctx, s, req, out)
}

func (b *Bilibili) send(ctx context.Context, s Session, req *http.Request, out any) error {
	resp, err := s.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return b.netErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, biliMaxResp))
	if err != nil {
		return b.netErr(err)
	}
	var env struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		pe := b.fail(resp.StatusCode, "回的不是 JSON")
		pe.Auth = resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden
		pe.Channel = true
		return pe
	}
	if env.Code != 0 {
		pe := b.fail(env.Code, clipText(env.Message, 200))
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			pe.Auth, pe.Channel = true, true
		}
		if resp.StatusCode >= 500 {
			pe.Channel = true
		}
		return pe
	}
	if resp.StatusCode >= 400 {
		return &PlatformError{Platform: "bilibili", Code: resp.StatusCode, Msg: "请求失败", Channel: true,
			Auth: resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden}
	}
	if out == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return &PlatformError{Platform: "bilibili", Msg: "返回的数据解析不了：" + err.Error(), Channel: true}
	}
	return nil
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

type multipartBody struct {
	data  []byte
	ctype string
}

// --- 投稿 ---

var biliLinkRe = regexp.MustCompile(`(?i)https?://|www\.`)

// Validate 按原型 PLATFORM_RULES.bilibili 和开放平台的必填项查：标题 80 字、简介 2000 字、标签 1 到 10 个、
// 简介不放外链、分区 id 必填、封面必填；合集、定时开放平台不支持。
func (b *Bilibili) Validate(in PublishInput) error {
	n := func(s string) int { return len([]rune(strings.TrimSpace(s))) }
	switch {
	case n(in.Title) > 80:
		return fmt.Errorf("标题超长：B 站最多 80 字，现在 %d 字", n(in.Title))
	case n(in.Desc) > 2000:
		return fmt.Errorf("简介超长：B 站最多 2000 字，现在 %d 字", n(in.Desc))
	case biliLinkRe.MatchString(in.Desc):
		return errors.New("简介带外链：B 站不允许放链接")
	case len(in.Tags) == 0:
		return errors.New("B 站投稿至少要一个标签")
	case len(in.Tags) > 10:
		return fmt.Errorf("标签太多：B 站最多 10 个，现在 %d 个", len(in.Tags))
	case in.Category == "":
		return errors.New("B 站投稿要选分区（category 填分区 id）")
	case in.Collection != "":
		return errors.New("B 站开放平台还不能加合集，去掉 collection 或投稿后到创作中心加")
	case in.ScheduledAt != "":
		return errors.New("B 站开放平台还不能定时投稿，清掉定时或到点再发")
	case in.Cover == nil:
		return errors.New("B 站投稿要封面：先给这条发布选一张封面")
	}
	for _, t := range in.Tags {
		if n(t) > 20 {
			return fmt.Errorf("标签「%s」超长：B 站每个标签最多 20 字", clipText(t, 20))
		}
		if strings.Contains(t, ",") {
			return fmt.Errorf("标签「%s」不能带英文逗号", t)
		}
	}
	if tid, err := strconv.Atoi(in.Category); err != nil || tid <= 0 {
		return fmt.Errorf("B 站分区要填分区 id（正整数），现在是 %s", in.Category)
	}
	if ext := strings.ToLower(filepath.Ext(in.Cover.Name)); ext != ".jpg" && ext != ".jpeg" && ext != ".png" {
		return errors.New("B 站封面只收 jpg、png")
	}
	if in.Cover.Size > biliMaxCover {
		return fmt.Errorf("B 站封面最大 %dMB", biliMaxCover>>20)
	}
	return nil
}

// UploadVideo：init 拿 upload_token，按 chunk 分片传，complete 合片。
func (b *Bilibili) UploadVideo(ctx context.Context, s Session, f LocalFile) (string, error) {
	var init struct {
		UploadToken string `json:"upload_token"`
	}
	if err := b.call(ctx, s, http.MethodPost, "/arcopen/fn/archive/video/init", map[string]string{"name": f.Name, "utype": "0"}, &init); err != nil {
		return "", err
	}
	if init.UploadToken == "" {
		return "", &PlatformError{Platform: "bilibili", Msg: "上传预处理没回 upload_token", Channel: true}
	}
	file, err := os.Open(f.Path)
	if err != nil {
		return "", fmt.Errorf("读不了成片：%w", err)
	}
	defer func() { _ = file.Close() }()
	q := url.QueryEscape(init.UploadToken)
	for part, off := 1, int64(0); off < f.Size; part, off = part+1, off+b.chunk {
		size := min(b.chunk, f.Size-off)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			fmt.Sprintf("%s/video/v2/part/upload?upload_token=%s&part_number=%d", biliUpos, q, part),
			io.NewSectionReader(file, off, size))
		if err != nil {
			return "", err
		}
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
		if err := b.send(ctx, s, req, nil); err != nil {
			return "", fmt.Errorf("传第 %d 片失败：%w", part, err)
		}
	}
	if err := b.call(ctx, s, http.MethodPost, "/arcopen/fn/archive/video/complete?upload_token="+q, nil, nil); err != nil {
		return "", err
	}
	return init.UploadToken, nil
}

// UploadCover 以表单字段 file 传封面。
func (b *Bilibili) UploadCover(ctx context.Context, s Session, f LocalFile) (string, error) {
	data, err := os.ReadFile(f.Path)
	if err != nil {
		return "", fmt.Errorf("读不了封面：%w", err)
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, f.Name))
	ctype := "image/jpeg"
	if strings.EqualFold(filepath.Ext(f.Name), ".png") {
		ctype = "image/png"
	}
	hdr.Set("Content-Type", ctype)
	pw, err := mw.CreatePart(hdr)
	if err != nil {
		return "", err
	}
	if _, err := pw.Write(data); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := b.call(ctx, s, http.MethodPost, "/arcopen/fn/archive/cover/upload", multipartBody{buf.Bytes(), mw.FormDataContentType()}, &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", &PlatformError{Platform: "bilibili", Msg: "封面上传没回地址", Channel: true}
	}
	return out.URL, nil
}

// Submit：add-by-utoken 投稿，自制（copyright 1）、禁止转载。
func (b *Bilibili) Submit(ctx context.Context, s Session, in PublishInput, upload, cover string) (RemoteRef, error) {
	tid, _ := strconv.Atoi(in.Category)
	tags := make([]string, len(in.Tags))
	for i, t := range in.Tags {
		tags[i] = strings.TrimSpace(t)
	}
	body := map[string]any{"title": strings.TrimSpace(in.Title), "cover": cover, "tid": tid, "no_reprint": 1,
		"desc": in.Desc, "tag": strings.Join(tags, ","), "copyright": 1}
	var out struct {
		ResourceID string `json:"resource_id"`
	}
	if err := b.call(ctx, s, http.MethodPost, "/arcopen/fn/archive/add-by-utoken?upload_token="+url.QueryEscape(upload), body, &out); err != nil {
		return RemoteRef{}, err
	}
	ref, ok := b.RefOf(out.ResourceID)
	if !ok {
		return RemoteRef{}, &PlatformError{Platform: "bilibili", Msg: "投稿没回 BV 号", Channel: true}
	}
	return ref, nil
}

func (b *Bilibili) RefOf(s string) (RemoteRef, bool) {
	m := biliBVRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return RemoteRef{}, false
	}
	return RemoteRef{ID: m[1], URL: "https://www.bilibili.com/video/" + m[1]}, true
}

// Status：archive/view 的 state 0 是开放浏览，-2 退回、-4 锁定、-16 转码失败、-100 删除，其余负数是转码审核中。
func (b *Bilibili) Status(ctx context.Context, s Session, ref RemoteRef) (RemoteStatus, error) {
	var out struct {
		State        int    `json:"state"`
		StateDesc    string `json:"state_desc"`
		RejectReason string `json:"reject_reason"`
		PTime        int64  `json:"ptime"`
	}
	if err := b.call(ctx, s, http.MethodGet, "/arcopen/fn/archive/view?resource_id="+url.QueryEscape(ref.ID), nil, &out); err != nil {
		return RemoteStatus{}, err
	}
	st := RemoteStatus{Label: out.StateDesc}
	switch {
	case out.State >= 0:
		st.State = RemotePublished
		if out.PTime > 0 {
			st.PublishedAt = time.Unix(out.PTime, 0).UTC().Format(time.RFC3339)
		}
	case out.State == -2 || out.State == -4 || out.State == -16 || out.State == -100:
		st.State = RemoteFailed
		st.Reason = strings.TrimSpace(out.RejectReason)
		if st.Reason == "" {
			st.Reason = out.StateDesc
		}
		if st.Reason == "" {
			st.Reason = fmt.Sprintf("稿件状态 %d", out.State)
		}
		st.Reason = "B 站：" + clipText(st.Reason, 500)
	default:
		st.State = RemoteReviewing
	}
	if st.Label == "" {
		st.Label = map[string]string{RemotePublished: "已开放", RemoteFailed: "未通过", RemoteReviewing: "审核中"}[st.State]
	}
	return st, nil
}

func (b *Bilibili) Stats(ctx context.Context, s Session, ref RemoteRef) (RemoteStats, error) {
	var out struct {
		View     int `json:"view"`
		Danmaku  int `json:"danmaku"`
		Reply    int `json:"reply"`
		Favorite int `json:"favorite"`
		Coin     int `json:"coin"`
		Share    int `json:"share"`
		Like     int `json:"like"`
	}
	if err := b.call(ctx, s, http.MethodGet, "/arcopen/fn/data/arc/stat?resource_id="+url.QueryEscape(ref.ID), nil, &out); err != nil {
		return RemoteStats{}, err
	}
	return RemoteStats{Views: out.View, Likes: out.Like, Comments: out.Reply, Shares: out.Share,
		Favorites: out.Favorite, Coins: out.Coin, Danmaku: out.Danmaku}, nil
}

func (b *Bilibili) Comments(context.Context, Session, RemoteRef, string) (CommentPage, error) {
	return CommentPage{}, ErrUnsupported
}
