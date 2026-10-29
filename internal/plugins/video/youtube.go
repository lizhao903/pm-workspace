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
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// YouTube 连接器（VID-04d）：YouTube Data API v3。认证走内核的 OAuth（Google 的授权、令牌地址，令牌刷新也归内核），
// client_id、client_secret 由用户在设置页填（Google Cloud 的 Web 应用客户端）。
// 流程：videos.insert 断点续传（先私享），thumbnails.set 设缩略图，videos.update 写标题简介标签分类和公开方式
// （定时是 private 加 publishAt），给了播放列表再 playlistItems.insert；videos.list 查状态和数据，commentThreads.list 拉评论。
// 缩略图要稿件 id，所以 UploadCover 只核对文件，真正上传放在 Submit 里、改公开方式之前。
// 接口形状按官方文档写，测试对接本机假服务端（testdata/youtube），真实接通归 VID-04e。

// YouTubeTool 是连接器 tool。
const YouTubeTool = "youtube"

const (
	ytAPI      = "https://www.googleapis.com/youtube/v3"
	ytUpload   = "https://www.googleapis.com/upload/youtube/v3"
	ytAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	ytTokenURL = "https://oauth2.googleapis.com/token"
	// 断点续传的分片要是 256KB 的整数倍
	ytChunk    = 32 << 20
	ytMaxThumb = 2 << 20
	ytMaxResp  = 4 << 20
)

// ytScopes：上传、读频道和数据、评论和缩略图（force-ssl）。
var ytScopes = []string{
	"https://www.googleapis.com/auth/youtube.upload",
	"https://www.googleapis.com/auth/youtube.readonly",
	"https://www.googleapis.com/auth/youtube.force-ssl",
}

// ytCategories 是原型 PLATFORM_RULES.youtube 的分类名到 categoryId，也可以直接填 id；不填用「人物和博客」。
var ytCategories = map[string]string{"教育": "27", "科学和技术": "28", "人物和博客": "22"}

var ytIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// YouTube 是 YouTube 适配器。
type YouTube struct {
	c     plugin.Core
	chunk int64
}

func NewYouTube() *YouTube { return &YouTube{chunk: ytChunk} }

func (y *YouTube) Platform() string   { return "youtube" }
func (y *YouTube) Caps() []string     { return []string{CapUpload, CapSchedule, CapMetrics, CapComments} }
func (y *YouTube) Bind(c plugin.Core) { y.c = c }

func (y *YouTube) ConnectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: YouTubeTool, Label: "YouTube", Category: "media", Color: "#ff0033",
		Desc: "YouTube Data API：上传成片、设缩略图、定时公开，查稿件状态，拉观看、点赞、评论数据和评论",
		Auth: []connector.AuthMode{connector.AuthOAuth2},
		Fields: []connector.Field{
			{Key: "client_id", Label: "Client ID", Kind: "text", Placeholder: "xxxx.apps.googleusercontent.com", Required: true},
			{Key: "client_secret", Label: "Client Secret", Kind: "secret", Required: true},
		},
		// access_type=offline 才发 refresh_token，prompt=consent 让重新授权时也再发一次
		OAuth: &connector.OAuthSpec{AuthURL: ytAuthURL, TokenURL: ytTokenURL, Scopes: ytScopes,
			ClientIDField: "client_id", ClientSecretField: "client_secret",
			AuthParams: map[string]string{"access_type": "offline", "prompt": "consent"}},
		Test: y.test,
	}
}

// test 取授权账号的频道名。
func (y *YouTube) test(ctx context.Context, cfg plugin.ConnectorConfig) (string, error) {
	if y.c == nil {
		return "", errors.New("视频插件还没启用")
	}
	hc, err := y.c.HTTP("media-platforms")
	if err != nil {
		return "", err
	}
	var out struct {
		Items []struct {
			ID      string `json:"id"`
			Snippet struct {
				Title string `json:"title"`
			} `json:"snippet"`
		} `json:"items"`
	}
	if err := y.call(ctx, Session{HTTP: hc, Config: cfg}, http.MethodGet, ytAPI+"/channels?part=snippet&mine=true", nil, "", &out); err != nil {
		return "", err
	}
	if len(out.Items) == 0 {
		return "", errors.New("这个 Google 账号下还没有 YouTube 频道")
	}
	if t := out.Items[0].Snippet.Title; t != "" {
		return t, nil
	}
	return out.Items[0].ID, nil
}

// --- 调用 ---

func (y *YouTube) netErr(err error) error {
	var hn *plugin.HostNotAllowedError
	if errors.As(err, &hn) {
		return &PlatformError{Platform: "youtube", Msg: "插件 video 的 network:media-platforms 不允许访问这个地址", Channel: true}
	}
	var ne *plugin.NotGrantedError
	if errors.As(err, &ne) {
		return &PlatformError{Platform: "youtube", Msg: ne.Error(), Channel: true}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return &PlatformError{Platform: "youtube", Msg: fmt.Sprintf("连不上 YouTube：%v", err), Channel: true}
}

// ytChannelReasons 是 403 里算渠道异常的原因：配额、频控、没权限；Auth 的那几个要重新授权。
var ytChannelReasons = map[string]bool{"quotaExceeded": true, "rateLimitExceeded": true, "dailyLimitExceeded": true,
	"userRateLimitExceeded": true, "accessNotConfigured": true, "insufficientPermissions": true, "forbidden": true,
	"youtubeSignupRequired": true}
var ytAuthReasons = map[string]bool{"insufficientPermissions": true, "forbidden": true, "authError": true}

// ytError 把 Google 的错误信封换成 PlatformError：401 是令牌失效；403 看原因；5xx、429 算渠道异常；其余是这次请求的内容不被接受。
func ytError(status int, data []byte) *PlatformError {
	var env struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &env)
	reason := ""
	if len(env.Error.Errors) > 0 {
		reason = env.Error.Errors[0].Reason
	}
	msg := strings.TrimSpace(env.Error.Message)
	if msg == "" {
		msg = http.StatusText(status)
	}
	if reason != "" {
		msg = reason + "：" + msg
	}
	pe := &PlatformError{Platform: "youtube", Code: status, Msg: clipText(msg, 200)}
	switch {
	case status == http.StatusUnauthorized:
		pe.Auth, pe.Channel = true, true
	case status == http.StatusForbidden && ytChannelReasons[reason]:
		pe.Auth, pe.Channel = ytAuthReasons[reason], true
	case status == http.StatusTooManyRequests || status >= 500:
		pe.Channel = true
	}
	return pe
}

// call 调一个接口：body 是 []byte 时原样发（ctype 给 Content-Type），否则按 JSON 发；回的 JSON 解进 out。
func (y *YouTube) call(ctx context.Context, s Session, method, u string, body any, ctype string, out any) error {
	var raw []byte
	switch v := body.(type) {
	case nil:
	case []byte:
		raw = v
	default:
		var err error
		if raw, err = json.Marshal(v); err != nil {
			return err
		}
		ctype = "application/json; charset=UTF-8"
	}
	var rd io.Reader
	if raw != nil {
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, data, err := y.do(ctx, s, req)
	if err != nil {
		return err
	}
	return y.decode(resp.StatusCode, data, out)
}

func (y *YouTube) do(ctx context.Context, s Session, req *http.Request) (*http.Response, []byte, error) {
	req.Header.Set("Authorization", "Bearer "+s.Config.AccessToken())
	req.Header.Set("Accept", "application/json")
	resp, err := s.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, y.netErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, ytMaxResp))
	if err != nil {
		return nil, nil, y.netErr(err)
	}
	return resp, data, nil
}

func (y *YouTube) decode(status int, data []byte, out any) error {
	if status >= 400 {
		return ytError(status, data)
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &PlatformError{Platform: "youtube", Msg: "返回的数据解析不了：" + err.Error(), Channel: true}
	}
	return nil
}

// --- 投稿 ---

// Validate 按原型 PLATFORM_RULES.youtube 和 Data API 的限制查：标题必填、最多 100 字，简介 5000 字，
// 标题简介不能有尖括号，标签最多 15 个、合计 500 字，分类是 id 或原型的分类名，缩略图 jpg、png 最大 2MB（可不传）。
func (y *YouTube) Validate(in PublishInput) error {
	n := func(s string) int { return len([]rune(strings.TrimSpace(s))) }
	switch {
	case n(in.Title) == 0:
		return errors.New("YouTube 投稿要标题")
	case n(in.Title) > 100:
		return fmt.Errorf("标题超长：YouTube最多 100 字，现在 %d 字", n(in.Title))
	case n(in.Desc) > 5000:
		return fmt.Errorf("简介超长：YouTube最多 5000 字，现在 %d 字", n(in.Desc))
	case strings.ContainsAny(in.Title+in.Desc, "<>"):
		return errors.New("YouTube 的标题和简介不能有尖括号 < >")
	case len(in.Tags) > 15:
		return fmt.Errorf("标签太多：YouTube最多 15 个，现在 %d 个", len(in.Tags))
	}
	total := 0
	for _, t := range in.Tags {
		total += n(t)
		if strings.ContainsAny(t, "<>") {
			return fmt.Errorf("标签「%s」不能有尖括号", clipText(t, 20))
		}
	}
	if total > 500 {
		return fmt.Errorf("标签合计超长：YouTube最多 500 字，现在 %d 字", total)
	}
	if _, err := ytCategory(in.Category); err != nil {
		return err
	}
	if in.Cover != nil {
		if ext := strings.ToLower(filepath.Ext(in.Cover.Name)); ext != ".jpg" && ext != ".jpeg" && ext != ".png" {
			return errors.New("YouTube 缩略图只收 jpg、png")
		}
		if in.Cover.Size > ytMaxThumb {
			return fmt.Errorf("YouTube 缩略图最大 %dMB", ytMaxThumb>>20)
		}
	}
	return nil
}

func ytCategory(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "22", nil
	}
	if id, ok := ytCategories[s]; ok {
		return id, nil
	}
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return s, nil
	}
	return "", fmt.Errorf("YouTube 分类要填分类 id（正整数）或 教育、科学和技术、人物和博客，现在是 %s", s)
}

// UploadVideo 用断点续传上传成片，先设为私享，标题先用文件名，Submit 再改；回稿件 id。
func (y *YouTube) UploadVideo(ctx context.Context, s Session, f LocalFile) (string, error) {
	meta, _ := json.Marshal(map[string]any{
		"snippet": map[string]any{"title": clipText(strings.TrimSuffix(f.Name, filepath.Ext(f.Name)), 90)},
		"status":  map[string]any{"privacyStatus": "private"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ytUpload+"/videos?uploadType=resumable&part=snippet,status", bytes.NewReader(meta))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	req.Header.Set("X-Upload-Content-Length", strconv.FormatInt(f.Size, 10))
	req.Header.Set("X-Upload-Content-Type", "video/*")
	resp, data, err := y.do(ctx, s, req)
	if err != nil {
		return "", err
	}
	if err := y.decode(resp.StatusCode, data, nil); err != nil {
		return "", err
	}
	loc := resp.Header.Get("Location")
	if lu, err := url.Parse(loc); loc == "" || err != nil || lu.Scheme != "https" {
		return "", &PlatformError{Platform: "youtube", Msg: "断点续传没回上传地址", Channel: true}
	}
	file, err := os.Open(f.Path)
	if err != nil {
		return "", fmt.Errorf("读不了成片：%w", err)
	}
	defer func() { _ = file.Close() }()
	for off := int64(0); off < f.Size; {
		size := min(y.chunk, f.Size-off)
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, loc, io.NewSectionReader(file, off, size))
		if err != nil {
			return "", err
		}
		req.ContentLength = size
		req.Header.Set("Content-Type", "video/*")
		req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", off, off+size-1, f.Size))
		resp, data, err := y.do(ctx, s, req)
		if err != nil {
			return "", fmt.Errorf("传 %d 字节处失败：%w", off, err)
		}
		// 308 是这片收到了，Range 是平台已收到的范围
		if resp.StatusCode == http.StatusPermanentRedirect {
			next := off + size
			if r := resp.Header.Get("Range"); strings.HasPrefix(r, "bytes=0-") {
				if end, err := strconv.ParseInt(strings.TrimPrefix(r, "bytes=0-"), 10, 64); err == nil && end+1 <= next {
					next = end + 1
				}
			}
			off = next
			continue
		}
		var out struct {
			ID string `json:"id"`
		}
		if err := y.decode(resp.StatusCode, data, &out); err != nil {
			return "", err
		}
		if out.ID == "" {
			return "", &PlatformError{Platform: "youtube", Msg: "上传完没回稿件 id", Channel: true}
		}
		return out.ID, nil
	}
	return "", &PlatformError{Platform: "youtube", Msg: "成片传完了平台还在等后续数据", Channel: true}
}

// UploadCover 只核对文件在，回本机路径；缩略图要稿件 id，Submit 里再传。
func (y *YouTube) UploadCover(_ context.Context, _ Session, f LocalFile) (string, error) {
	if _, err := os.Stat(f.Path); err != nil {
		return "", fmt.Errorf("读不了封面：%w", err)
	}
	return f.Path, nil
}

// Submit：先设缩略图（稿件还是私享），再写标题简介和公开方式，最后加进播放列表。
func (y *YouTube) Submit(ctx context.Context, s Session, in PublishInput, upload, cover string) (RemoteRef, error) {
	ref := RemoteRef{ID: upload, URL: "https://www.youtube.com/watch?v=" + upload}
	if !ytIDRe.MatchString(upload) {
		return RemoteRef{}, &PlatformError{Platform: "youtube", Msg: "上传没回合法的稿件 id", Channel: true}
	}
	q := url.QueryEscape(upload)
	if cover != "" && in.Cover != nil {
		img, err := os.ReadFile(in.Cover.Path)
		if err != nil {
			return RemoteRef{}, fmt.Errorf("读不了封面：%w", err)
		}
		ctype := "image/jpeg"
		if strings.EqualFold(filepath.Ext(in.Cover.Name), ".png") {
			ctype = "image/png"
		}
		if err := y.call(ctx, s, http.MethodPost, ytUpload+"/thumbnails/set?videoId="+q, img, ctype, nil); err != nil {
			return RemoteRef{}, fmt.Errorf("设缩略图失败：%w", err)
		}
	}
	cat, _ := ytCategory(in.Category)
	tags := make([]string, 0, len(in.Tags))
	for _, t := range in.Tags {
		tags = append(tags, strings.TrimSpace(t))
	}
	status := map[string]any{"privacyStatus": "public", "selfDeclaredMadeForKids": false}
	if in.ScheduledAt != "" {
		status["privacyStatus"], status["publishAt"] = "private", in.ScheduledAt
	}
	body := map[string]any{"id": upload, "status": status,
		"snippet": map[string]any{"title": strings.TrimSpace(in.Title), "description": in.Desc, "tags": tags, "categoryId": cat}}
	if err := y.call(ctx, s, http.MethodPut, ytAPI+"/videos?part=snippet,status", body, "", nil); err != nil {
		return RemoteRef{}, err
	}
	if in.Collection != "" {
		item := map[string]any{"snippet": map[string]any{"playlistId": in.Collection,
			"resourceId": map[string]string{"kind": "youtube#video", "videoId": upload}}}
		if err := y.call(ctx, s, http.MethodPost, ytAPI+"/playlistItems?part=snippet", item, "", nil); err != nil {
			return RemoteRef{}, fmt.Errorf("加进播放列表失败：%w", err)
		}
	}
	return ref, nil
}

// RefOf 认 watch?v=、youtu.be/、shorts/、live/、Studio 的 video/ 链接和裸的 11 位 id。
func (y *YouTube) RefOf(s string) (RemoteRef, bool) {
	s = strings.TrimSpace(s)
	id := ""
	if ytIDRe.MatchString(s) {
		id = s
	} else if u, err := url.Parse(s); err == nil && u.Host != "" {
		host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
		host = strings.TrimPrefix(host, "m.")
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		switch {
		case host == "youtu.be" && len(parts) >= 1:
			id = parts[0]
		case host != "youtube.com" && host != "studio.youtube.com":
		case u.Path == "/watch":
			id = u.Query().Get("v")
		case len(parts) >= 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed" || parts[0] == "video"):
			id = parts[1]
		}
	}
	if !ytIDRe.MatchString(id) {
		return RemoteRef{}, false
	}
	return RemoteRef{ID: id, URL: "https://www.youtube.com/watch?v=" + id}, true
}

type ytVideo struct {
	Snippet struct {
		PublishedAt string `json:"publishedAt"`
	} `json:"snippet"`
	Status struct {
		UploadStatus    string `json:"uploadStatus"`
		FailureReason   string `json:"failureReason"`
		RejectionReason string `json:"rejectionReason"`
		PrivacyStatus   string `json:"privacyStatus"`
		PublishAt       string `json:"publishAt"`
	} `json:"status"`
	Statistics struct {
		ViewCount     string `json:"viewCount"`
		LikeCount     string `json:"likeCount"`
		FavoriteCount string `json:"favoriteCount"`
		CommentCount  string `json:"commentCount"`
	} `json:"statistics"`
}

func (y *YouTube) video(ctx context.Context, s Session, ref RemoteRef, part string) (ytVideo, error) {
	var out struct {
		Items []ytVideo `json:"items"`
	}
	if err := y.call(ctx, s, http.MethodGet, ytAPI+"/videos?part="+part+"&id="+url.QueryEscape(ref.ID), nil, "", &out); err != nil {
		return ytVideo{}, err
	}
	if len(out.Items) == 0 {
		return ytVideo{}, errNoVideo
	}
	return out.Items[0], nil
}

var errNoVideo = errors.New("no video")

// ytFailReasons 是 failureReason、rejectionReason 的中文说明。
var ytFailReasons = map[string]string{
	"codec": "编码不支持", "conversion": "转码失败", "emptyFile": "文件是空的", "invalidFile": "文件格式不对",
	"tooSmall": "文件太小", "uploadAborted": "上传中断", "claim": "版权声明", "copyright": "侵犯版权",
	"duplicate": "重复上传", "inappropriate": "内容不当", "legal": "法律原因", "length": "时长超限",
	"termsOfUse": "违反服务条款", "trademark": "商标问题", "uploaderAccountClosed": "账号已关闭",
	"uploaderAccountSuspended": "账号已暂停",
}

// Status：uploadStatus 的 failed、rejected、deleted 是失败；processed 且公开是已公开；私享带 publishAt 是已定时；其余处理中。
func (y *YouTube) Status(ctx context.Context, s Session, ref RemoteRef) (RemoteStatus, error) {
	v, err := y.video(ctx, s, ref, "snippet,status")
	if errors.Is(err, errNoVideo) {
		return RemoteStatus{State: RemoteFailed, Label: "不存在", Reason: "YouTube：稿件不存在或已删除"}, nil
	} else if err != nil {
		return RemoteStatus{}, err
	}
	st := v.Status
	switch {
	case st.UploadStatus == "failed" || st.UploadStatus == "rejected" || st.UploadStatus == "deleted":
		why := st.RejectionReason
		if why == "" {
			why = st.FailureReason
		}
		if zh := ytFailReasons[why]; zh != "" {
			why = zh
		}
		if why == "" {
			why = st.UploadStatus
		}
		label := map[string]string{"failed": "处理失败", "rejected": "已拒绝", "deleted": "已删除"}[st.UploadStatus]
		return RemoteStatus{State: RemoteFailed, Label: label, Reason: "YouTube：" + clipText(why, 500)}, nil
	case st.PrivacyStatus == "public" && st.UploadStatus == "processed":
		return RemoteStatus{State: RemotePublished, Label: "公开", PublishedAt: v.Snippet.PublishedAt}, nil
	case st.PublishAt != "":
		return RemoteStatus{State: RemoteReviewing, Label: "已定时，" + st.PublishAt + " 公开"}, nil
	case st.UploadStatus == "processed":
		return RemoteStatus{State: RemoteReviewing, Label: map[string]string{"private": "私享", "unlisted": "不公开"}[st.PrivacyStatus]}, nil
	default:
		return RemoteStatus{State: RemoteReviewing, Label: "处理中"}, nil
	}
}

func ytCount(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// Stats：Data API 没有分享数，shares 是 0；favoriteCount 已停用，一般也是 0。
func (y *YouTube) Stats(ctx context.Context, s Session, ref RemoteRef) (RemoteStats, error) {
	v, err := y.video(ctx, s, ref, "statistics")
	if errors.Is(err, errNoVideo) {
		return RemoteStats{}, &PlatformError{Platform: "youtube", Msg: "稿件 " + ref.ID + " 不存在或已删除"}
	} else if err != nil {
		return RemoteStats{}, err
	}
	st := v.Statistics
	return RemoteStats{Views: ytCount(st.ViewCount), Likes: ytCount(st.LikeCount), Comments: ytCount(st.CommentCount),
		Favorites: ytCount(st.FavoriteCount)}, nil
}

// Comments 拉一页顶层评论，按时间倒序，每页 50 条。
func (y *YouTube) Comments(ctx context.Context, s Session, ref RemoteRef, cursor string) (CommentPage, error) {
	u := ytAPI + "/commentThreads?part=snippet&order=time&textFormat=plainText&maxResults=50&videoId=" + url.QueryEscape(ref.ID)
	if cursor != "" {
		u += "&pageToken=" + url.QueryEscape(cursor)
	}
	var out struct {
		NextPageToken string `json:"nextPageToken"`
		Items         []struct {
			Snippet struct {
				TopLevelComment struct {
					ID      string `json:"id"`
					Snippet struct {
						AuthorDisplayName string `json:"authorDisplayName"`
						TextOriginal      string `json:"textOriginal"`
						TextDisplay       string `json:"textDisplay"`
						LikeCount         int    `json:"likeCount"`
						PublishedAt       string `json:"publishedAt"`
					} `json:"snippet"`
				} `json:"topLevelComment"`
			} `json:"snippet"`
		} `json:"items"`
	}
	if err := y.call(ctx, s, http.MethodGet, u, nil, "", &out); err != nil {
		return CommentPage{}, err
	}
	page := CommentPage{Items: make([]Comment, 0, len(out.Items)), Next: out.NextPageToken}
	for _, it := range out.Items {
		c := it.Snippet.TopLevelComment
		text := c.Snippet.TextOriginal
		if text == "" {
			text = c.Snippet.TextDisplay
		}
		page.Items = append(page.Items, Comment{ID: c.ID, Author: c.Snippet.AuthorDisplayName, Text: text, Likes: c.Snippet.LikeCount, At: c.Snippet.PublishedAt})
	}
	return page, nil
}
