// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

const ytGoodToken = "yt-access-test-0001"

// writeSample 回 testdata/<dir>/<name>.json，状态码是 status。
func writeSample(t *testing.T, w http.ResponseWriter, dir, name string, status int) {
	b, err := os.ReadFile(filepath.Join("testdata", dir, name+".json"))
	if err != nil {
		t.Errorf("读样例 %s/%s：%v", dir, name, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// fakeYouTube 是本机假 Google：令牌接口、Data API 和上传接口，响应取 testdata/youtube。
type fakeYouTube struct {
	t        *testing.T
	mu       sync.Mutex
	token    string // 认这个 Bearer，别的回 401
	status   string // videos?part=status 回哪个样例
	failWith string // 设了时 videos.update 回这个错误样例
	calls    []string
	hosts    []string
	ranges   []string
	chunks   [][]byte
	thumb    []byte
	thumbCT  string
	insert   map[string]any
	update   map[string]any
	playlist map[string]any
	tokenReq url.Values
}

func newFakeYouTube(t *testing.T) *fakeYouTube {
	return &fakeYouTube{t: t, token: ytGoodToken, status: "videos_processing"}
}

func (f *fakeYouTube) set(fn func(f *fakeYouTube)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeYouTube) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	f.hosts = append(f.hosts, r.Header.Get("X-Original-Host"))
	q := r.URL.Query()
	if r.URL.Path == "/token" {
		f.tokenReq, _ = url.ParseQuery(string(body))
		writeSample(f.t, w, "youtube", "token", 200)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		writeSample(f.t, w, "youtube", "error_unauthorized", 401)
		return
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/youtube/v3/channels" && q.Get("mine") == "true":
		writeSample(f.t, w, "youtube", "channels_mine", 200)
	case r.Method == "POST" && r.URL.Path == "/upload/youtube/v3/videos" && q.Get("uploadType") == "resumable":
		f.insert = map[string]any{}
		_ = json.Unmarshal(body, &f.insert)
		f.insert["length"] = r.Header.Get("X-Upload-Content-Length")
		w.Header().Set("Location", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=up-test-0001")
		w.WriteHeader(200)
	case r.Method == "PUT" && r.URL.Path == "/upload/youtube/v3/videos" && q.Get("upload_id") == "up-test-0001":
		cr := r.Header.Get("Content-Range")
		f.ranges = append(f.ranges, cr)
		f.chunks = append(f.chunks, body)
		var start, end, total int64
		if _, err := fmt.Sscanf(cr, "bytes %d-%d/%d", &start, &end, &total); err != nil || end-start+1 != int64(len(body)) {
			f.t.Errorf("Content-Range 不对：%q，%d 字节", cr, len(body))
		}
		if end+1 < total {
			w.Header().Set("Range", fmt.Sprintf("bytes=0-%d", end))
			w.WriteHeader(http.StatusPermanentRedirect)
			return
		}
		writeSample(f.t, w, "youtube", "video_inserted", 200)
	case r.Method == "POST" && r.URL.Path == "/upload/youtube/v3/thumbnails/set" && q.Get("videoId") == "Te5tVid0001":
		f.thumb, f.thumbCT = body, r.Header.Get("Content-Type")
		writeSample(f.t, w, "youtube", "thumbnails_set", 200)
	case r.Method == "PUT" && r.URL.Path == "/youtube/v3/videos":
		if f.failWith != "" {
			writeSample(f.t, w, "youtube", f.failWith, map[string]int{"error_bad_category": 400, "error_quota": 403}[f.failWith])
			return
		}
		f.update = map[string]any{}
		_ = json.Unmarshal(body, &f.update)
		f.update["part"] = q.Get("part")
		writeSample(f.t, w, "youtube", "video_updated", 200)
	case r.Method == "POST" && r.URL.Path == "/youtube/v3/playlistItems":
		f.playlist = map[string]any{}
		_ = json.Unmarshal(body, &f.playlist)
		writeSample(f.t, w, "youtube", "playlist_item", 200)
	case r.Method == "GET" && r.URL.Path == "/youtube/v3/videos" && q.Get("id") == "Te5tVid0001":
		if q.Get("part") == "statistics" {
			writeSample(f.t, w, "youtube", "videos_stats", 200)
		} else {
			writeSample(f.t, w, "youtube", f.status, 200)
		}
	case r.Method == "GET" && r.URL.Path == "/youtube/v3/videos":
		writeSample(f.t, w, "youtube", "videos_empty", 200)
	case r.Method == "GET" && r.URL.Path == "/youtube/v3/commentThreads" && q.Get("videoId") == "Te5tVid0001":
		if q.Get("pageToken") == "page-2-token" {
			writeSample(f.t, w, "youtube", "comments_page2", 200)
		} else {
			writeSample(f.t, w, "youtube", "comments_page1", 200)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":404,"message":"not found","errors":[{"reason":"notFound"}]}}`)
	}
}

type ytEnv struct {
	biliEnv
	yt *fakeYouTube
}

// setupYouTube 装好带 YouTube 适配器的视频插件，出网和 OAuth 令牌请求都改投到假 Google。
func setupYouTube(t *testing.T) ytEnv {
	t.Helper()
	y := NewYouTube()
	y.chunk = 10
	e := setupBilibili(t, NewBilibili(), y, NewDouyin())
	fake := newFakeYouTube(t)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	e.r.SetHTTPTransport(biliRewrite{u})
	e.conns.SetHTTPClient(&http.Client{Transport: biliRewrite{u}, Timeout: 5 * time.Second})
	return ytEnv{biliEnv: e, yt: fake}
}

// connect 新建 YouTube 连接器并走完 OAuth：发起授权、模拟浏览器回调、换令牌、连通测试。
func (e ytEnv) connect(t *testing.T) *connector.Connector {
	t.Helper()
	ctx := context.Background()
	c, err := e.conns.Create(ctx, connector.Input{Tool: YouTubeTool,
		Config: map[string]string{"client_id": "yt-client.apps.googleusercontent.com"}, Secrets: map[string]string{"client_secret": "yt-secret-test-only"}})
	if err != nil {
		t.Fatal(err)
	}
	if c.AuthMode != connector.AuthOAuth2 || c.Status != "connecting" {
		t.Fatalf("新建：%s %s", c.AuthMode, c.Status)
	}
	st, err := e.conns.StartOAuth(ctx, c.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	au, _ := url.Parse(st.AuthorizeURL)
	aq := au.Query()
	if au.Host != "accounts.google.com" || aq.Get("access_type") != "offline" || aq.Get("prompt") != "consent" ||
		!strings.Contains(aq.Get("scope"), "youtube.upload") || !strings.Contains(aq.Get("scope"), "youtube.force-ssl") {
		t.Fatalf("授权地址：%s", st.AuthorizeURL)
	}
	res, err := e.conns.CompleteOAuth(ctx, aq.Get("state"), "code-test-0001", "", "")
	if err != nil || !res.OK {
		t.Fatalf("回调：%+v %v", res, err)
	}
	if res.Connector.Status != "connected" || res.Connector.Account != "测试频道" {
		t.Fatalf("授权后：%s %s %s", res.Connector.Status, res.Connector.Account, res.Connector.Error)
	}
	if e.yt.tokenReq.Get("code") != "code-test-0001" || e.yt.tokenReq.Get("grant_type") != "authorization_code" {
		t.Fatalf("换令牌：%v", e.yt.tokenReq)
	}
	return res.Connector
}

// ytPublishable 建一集横屏视频，登记成片和 16:9 封面（文件写在磁盘上），建一条 YouTube 发布；extra 是发布记录多的字段。
func (e ytEnv) ytPublishable(t *testing.T, film []byte, extra string) string {
	t.Helper()
	for p, b := range map[string][]byte{"pc/output/final.mp4": film, "pc/cover/cover-16x9.png": []byte("fake-png-thumb")} {
		full := filepath.Join(e.root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	root, _ := json.Marshal(e.root)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"十分钟上手","orientations":["landscape"],"root":`+string(root)+`}`, 201)["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"video","variant":"landscape","path":"pc/output/final.mp4","status":"final"}`, 201)
	cover := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"cover","variant":"landscape","ratio":"16x9","path":"pc/cover/cover-16x9.png"}`, 201)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"youtube","variant":"landscape","title":"Ten minutes with the workbench","desc":"详见 https://example.com","cover_id":"`+cover["id"].(string)+`"`+extra+`}`, 201)
	return pb["id"].(string)
}

const ytSubmitBody = `{"tags":["效率","工具"],"category":"教育","collection":"PLtest0000000001"}`

// 假服务端上走完：OAuth 授权、断点续传上传、设缩略图、定时公开、加播放列表、查状态、拉数据和评论
func TestYouTubeFullFlow(t *testing.T) {
	e := setupYouTube(t)
	cn := e.connect(t)

	_, out := call(t, e.h, "GET", "/api/video/platforms", "")
	yt := out["data"].([]any)[1].(map[string]any)
	if yt["key"] != "youtube" || yt["tool"] != "youtube" || !slices.Equal(anyStrings(yt["caps"]), []string{"upload", "schedule", "metrics", "comments"}) ||
		yt["creator_url"] != "https://studio.youtube.com" || yt["connectors"].([]any)[0].(map[string]any)["account"] != "测试频道" {
		t.Fatalf("YouTube：%v", yt)
	}

	at := time.Now().Add(72 * time.Hour).UTC().Truncate(time.Second).Format(time.RFC3339)
	film := []byte("0123456789abcdefghijKLMNO") // 25 字节，按 10 字节分 3 片
	pb := e.ytPublishable(t, film, `,"status":"scheduled","scheduled_at":"`+at+`"`)
	f := e.yt
	f.set(func(f *fakeYouTube) { f.calls, f.hosts = nil, nil })
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", ytSubmitBody)
	p := data(out)
	if code != 200 || p["status"] != "scheduled" || p["url"] != "https://www.youtube.com/watch?v=Te5tVid0001" || p["error"] != nil {
		t.Fatalf("投稿后：%d %v", code, out)
	}
	if meta := out["meta"].(map[string]any); meta["remote_id"] != "Te5tVid0001" || meta["connector_id"] != cn.ID {
		t.Fatalf("meta：%v", meta)
	}
	want := []string{"POST /upload/youtube/v3/videos", "PUT /upload/youtube/v3/videos", "PUT /upload/youtube/v3/videos", "PUT /upload/youtube/v3/videos",
		"POST /upload/youtube/v3/thumbnails/set", "PUT /youtube/v3/videos", "POST /youtube/v3/playlistItems"}
	if !slices.Equal(f.calls, want) {
		t.Fatalf("调用顺序：%v", f.calls)
	}
	for _, h := range f.hosts {
		if h != "www.googleapis.com" {
			t.Fatalf("域名：%v", f.hosts)
		}
	}
	if !slices.Equal(f.ranges, []string{"bytes 0-9/25", "bytes 10-19/25", "bytes 20-24/25"}) || !bytes.Equal(bytes.Join(f.chunks, nil), film) {
		t.Fatalf("分片：%v %q", f.ranges, f.chunks)
	}
	if f.insert["length"] != "25" || f.insert["status"].(map[string]any)["privacyStatus"] != "private" {
		t.Fatalf("先私享上传：%v", f.insert)
	}
	if string(f.thumb) != "fake-png-thumb" || f.thumbCT != "image/png" {
		t.Fatalf("缩略图：%q %s", f.thumb, f.thumbCT)
	}
	u := f.update
	sn, st := u["snippet"].(map[string]any), u["status"].(map[string]any)
	if u["id"] != "Te5tVid0001" || u["part"] != "snippet,status" || sn["title"] != "Ten minutes with the workbench" || sn["description"] != "详见 https://example.com" ||
		sn["categoryId"] != "27" || !slices.Equal(anyStrings(sn["tags"]), []string{"效率", "工具"}) ||
		st["privacyStatus"] != "private" || st["publishAt"] != at || st["selfDeclaredMadeForKids"] != false {
		t.Fatalf("改元数据：%v", u)
	}
	if sn := f.playlist["snippet"].(map[string]any); sn["playlistId"] != "PLtest0000000001" || sn["resourceId"].(map[string]any)["videoId"] != "Te5tVid0001" {
		t.Fatalf("播放列表：%v", f.playlist)
	}

	// 处理中：状态不变，照样拉数据
	code, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	p, meta := data(out), out["meta"].(map[string]any)
	m, _ := p["metrics"].(map[string]any)
	if code != 200 || p["status"] != "scheduled" || meta["remote"].(map[string]any)["label"] != "处理中" ||
		m["views"] != 4321.0 || m["likes"] != 210.0 || m["comments"] != 37.0 || m["shares"] != 0.0 {
		t.Fatalf("处理中同步：%d %v", code, out)
	}
	e.yt.set(func(f *fakeYouTube) { f.status = "videos_scheduled" })
	_, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	if r := out["meta"].(map[string]any)["remote"].(map[string]any); r["state"] != "reviewing" || !strings.Contains(r["label"].(string), "已定时") {
		t.Fatalf("定时中：%v", out)
	}
	// 到点公开：发布记录置为已发布，发布时间取平台的
	e.yt.set(func(f *fakeYouTube) { f.status = "videos_public" })
	p = mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "", 200)
	if p["status"] != "published" || p["published_at"] != "2026-11-01T12:00:00Z" {
		t.Fatalf("公开后：%v", p)
	}

	// 评论两页
	code, out = call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments", "")
	items := out["data"].([]any)
	if code != 200 || len(items) != 2 || out["meta"].(map[string]any)["next"] != "page-2-token" {
		t.Fatalf("评论：%d %v", code, out)
	}
	c0, c1 := items[0].(map[string]any), items[1].(map[string]any)
	if c0["id"] != "UgxComment0001" || c0["author"] != "@viewer-one" || c0["text"] != "讲得清楚" || c0["likes"] != 5.0 || c0["at"] != "2026-10-29T09:00:00Z" || c1["text"] != "下一集什么时候" {
		t.Fatalf("评论内容：%v", items)
	}
	_, out = call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments?cursor=page-2-token", "")
	if items := out["data"].([]any); len(items) != 1 || out["meta"].(map[string]any)["next"] != "" {
		t.Fatalf("第二页：%v", out)
	}

	// 退回：失败带中文原因
	e.yt.set(func(f *fakeYouTube) { f.status = "videos_rejected" })
	if p := mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "", 200); p["status"] != "failed" || p["error"] != "YouTube：侵犯版权" {
		t.Fatalf("退回：%v", p)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" || c.LastSyncAt == nil {
		t.Fatalf("连接器：%+v", c)
	}
}

// 立即公开、没封面、没播放列表：不调缩略图和播放列表，公开方式是 public
func TestYouTubeSubmitNow(t *testing.T) {
	e := setupYouTube(t)
	e.connect(t)
	pb := e.ytPublishable(t, []byte("film"), "")
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"cover_id":null}`, 200)
	e.yt.set(func(f *fakeYouTube) { f.calls = nil })
	p := mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", `{"category":"28"}`, 200)
	if p["status"] != "published" || p["published_at"] == nil {
		t.Fatalf("投稿：%v", p)
	}
	if want := []string{"POST /upload/youtube/v3/videos", "PUT /upload/youtube/v3/videos", "PUT /youtube/v3/videos"}; !slices.Equal(e.yt.calls, want) {
		t.Fatalf("调用：%v", e.yt.calls)
	}
	if st := e.yt.update["status"].(map[string]any); st["privacyStatus"] != "public" || st["publishAt"] != nil || e.yt.update["snippet"].(map[string]any)["categoryId"] != "28" {
		t.Fatalf("改元数据：%v", e.yt.update)
	}
}

// 元数据被拒只算这次失败；配额用完算渠道异常；令牌失效时连接器异常、错误里不带令牌
func TestYouTubeErrors(t *testing.T) {
	e := setupYouTube(t)
	cn := e.connect(t)
	pb := e.ytPublishable(t, []byte("film"), "")
	path := "/api/video/publishes/" + pb + "/submit"

	e.yt.set(func(f *fakeYouTube) { f.failWith = "error_bad_category" })
	code, out := call(t, e.h, "POST", path, "{}")
	if code != 502 || out["error"].(map[string]any)["code"] != "publish_failed" || !strings.Contains(errMsg(out), "invalidCategoryId") {
		t.Fatalf("分类被拒：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" {
		t.Fatalf("内容被拒不算渠道异常：%s %s", c.Status, c.Error)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["status"] != "failed" || !strings.Contains(p["error"].(string), "YouTube返回 400") {
		t.Fatalf("发布记录：%v", p)
	}

	e.yt.set(func(f *fakeYouTube) { f.failWith = "error_quota" })
	if code, out := call(t, e.h, "POST", path, "{}"); code != 502 || !strings.Contains(errMsg(out), "quotaExceeded") {
		t.Fatalf("配额：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "error" {
		t.Fatalf("配额用完要置为异常：%s", c.Status)
	}

	// 失败的可以重投，成功后连接器恢复
	e.yt.set(func(f *fakeYouTube) { f.failWith = "" })
	if p := mustCall(t, e.h, "POST", path, "{}", 200); p["status"] != "published" || p["error"] != nil {
		t.Fatalf("重投：%v", p)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" || c.Error != "" {
		t.Fatalf("连接器要恢复：%s %s", c.Status, c.Error)
	}

	e.yt.set(func(f *fakeYouTube) { f.token = "rotated" })
	code, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	if code != 502 || out["error"].(map[string]any)["code"] != "sync_failed" || !strings.Contains(errMsg(out), "令牌失效") {
		t.Fatalf("令牌失效：%d %v", code, out)
	}
	c := e.connector(t, cn.ID)
	if c.Status != "error" || strings.Contains(c.Error, ytGoodToken) || strings.Contains(errMsg(out), ytGoodToken) {
		t.Fatalf("连接器：%s %s", c.Status, c.Error)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["status"] != "published" {
		t.Fatalf("同步失败不改发布记录：%v", p)
	}
}

// 上传之前就拦下的：400，不发请求
func TestYouTubeValidation(t *testing.T) {
	e := setupYouTube(t)
	e.connect(t)
	pb := e.ytPublishable(t, []byte("film"), "")
	e.yt.set(func(f *fakeYouTube) { f.calls = nil })
	path := "/api/video/publishes/" + pb + "/submit"
	for _, c := range []struct{ body, want string }{
		{`{"category":"游戏"}`, "分类要填分类 id"},
		{`{"tags":["<b>"]}`, "尖括号"},
		{`{"tags":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16"]}`, "标签太多"},
	} {
		if code, out := call(t, e.h, "POST", path, c.body); code != 400 || !strings.Contains(errMsg(out), c.want) {
			t.Errorf("%s：要 400「%s」，实际 %d %v", c.body, c.want, code, out)
		}
	}
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"title":"a <b> c"}`, 200)
	if code, out := call(t, e.h, "POST", path, "{}"); code != 400 || !strings.Contains(errMsg(out), "尖括号") {
		t.Errorf("标题尖括号：%d %v", code, out)
	}
	if len(e.yt.calls) != 0 {
		t.Fatalf("拦下的不该发请求：%v", e.yt.calls)
	}
	// 稿件不在平台上了：同步把发布记录置为失败
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"title":"ok","status":"published","url":"https://youtu.be/Gone0000001"}`, 200)
	if p := mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "", 200); p["status"] != "failed" || !strings.Contains(p["error"].(string), "不存在") {
		t.Fatalf("稿件不在：%v", p)
	}
}

func TestYouTubeRefOf(t *testing.T) {
	y := NewYouTube()
	for in, want := range map[string]string{
		"Te5tVid0001": "Te5tVid0001", "https://www.youtube.com/watch?v=Te5tVid0001&t=3s": "Te5tVid0001",
		"https://youtu.be/Te5tVid0001?si=x": "Te5tVid0001", "https://m.youtube.com/shorts/Te5tVid0001": "Te5tVid0001",
		"https://studio.youtube.com/video/Te5tVid0001/edit": "Te5tVid0001", "https://www.youtube.com/@channel": "",
		"https://example.com/watch?v=Te5tVid0001": "", "short": "",
	} {
		ref, ok := y.RefOf(in)
		if ok != (want != "") || ref.ID != want || ok && ref.URL != "https://www.youtube.com/watch?v="+want {
			t.Errorf("RefOf(%q) = %v %v", in, ref, ok)
		}
	}
}
