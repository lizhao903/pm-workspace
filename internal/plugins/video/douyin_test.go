// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
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

	"github.com/lizhao903/pm-workspace/internal/connector"
)

const (
	dyOpenID    = "open-id-test-0001"
	dyGoodToken = "dy-access-test-0001"
)

// fakeDouyin 是本机假抖音开放平台，响应取 testdata/douyin。
type fakeDouyin struct {
	t      *testing.T
	mu     sync.Mutex
	token  string
	calls  []string
	hosts  []string
	bodies []map[string]any
	query  []url.Values
}

func (f *fakeDouyin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	f.hosts = append(f.hosts, r.Header.Get("X-Original-Host"))
	f.query = append(f.query, r.URL.Query())
	if r.URL.Path == "/oauth/userinfo/" {
		form, _ := url.ParseQuery(string(body))
		if form.Get("access_token") != f.token || form.Get("open_id") != dyOpenID {
			writeSample(f.t, w, "douyin", "token_expired", 200)
			return
		}
		writeSample(f.t, w, "douyin", "userinfo", 200)
		return
	}
	if r.Header.Get("access-token") != f.token || r.URL.Query().Get("open_id") != dyOpenID {
		writeSample(f.t, w, "douyin", "token_expired", 200)
		return
	}
	switch {
	case r.Method == "POST" && r.URL.Path == "/api/douyin/v1/video/video_data/":
		var in map[string]any
		_ = json.Unmarshal(body, &in)
		f.bodies = append(f.bodies, in)
		ids, _ := in["video_ids"].([]any)
		items, _ := in["item_ids"].([]any)
		if len(ids) == 1 && ids[0] == "7300000000000000001" || len(items) == 1 && items[0] == "@9VwAtestItem0001xyzABC==" {
			writeSample(f.t, w, "douyin", "video_data", 200)
		} else {
			writeSample(f.t, w, "douyin", "video_data_empty", 200)
		}
	case r.Method == "GET" && r.URL.Path == "/item/comment/list/" && r.URL.Query().Get("item_id") == "@9VwAtestItem0001xyzABC==":
		if r.URL.Query().Get("cursor") == "20" {
			writeSample(f.t, w, "douyin", "comments_page2", 200)
		} else {
			writeSample(f.t, w, "douyin", "comments_page1", 200)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"data":{"error_code":404,"description":"not found"}}`)
	}
}

type dyEnv struct {
	biliEnv
	dy *fakeDouyin
}

func setupDouyin(t *testing.T) dyEnv {
	t.Helper()
	e := setupBilibili(t, NewBilibili(), NewYouTube(), NewDouyin())
	fake := &fakeDouyin{t: t, token: dyGoodToken}
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	e.r.SetHTTPTransport(biliRewrite{u})
	return dyEnv{biliEnv: e, dy: fake}
}

func (e dyEnv) addDouyin(t *testing.T, token string) *connector.Connector {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: DouyinTool,
		Config: map[string]string{"open_id": dyOpenID}, Secrets: map[string]string{"access_token": token}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// dyPublishable 建一集竖屏视频，登记成片和 3:4 封面，建一条抖音发布。
func (e dyEnv) dyPublishable(t *testing.T) (string, string) {
	t.Helper()
	for p, b := range map[string][]byte{"app/output/final.mp4": []byte("portrait-film"), "app/cover/cover-3x4.jpg": []byte("fake-jpeg")} {
		full := filepath.Join(e.root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	root, _ := json.Marshal(e.root)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"十分钟上手","orientations":["portrait"],"root":`+string(root)+`}`, 201)["id"].(string)
	film := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"video","variant":"portrait","path":"app/output/final.mp4","status":"final"}`, 201)
	cover := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"cover","variant":"portrait","ratio":"3x4","path":"app/cover/cover-3x4.jpg"}`, 201)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"douyin","variant":"portrait","title":"十分钟上手","desc":"一集讲清楚","cover_id":"`+cover["id"].(string)+`"}`, 201)
	return pb["id"].(string), film["id"].(string)
}

// 抖音：连通测试取昵称；投稿、定时回 unsupported，发布包给齐要手动填的东西；回填链接后拉数据、评论
func TestDouyinFlow(t *testing.T) {
	e := setupDouyin(t)
	ctx := context.Background()
	cn := e.addDouyin(t, dyGoodToken)
	res, err := e.conns.Test(ctx, cn.ID)
	if err != nil || !res.OK || res.Connector.Account != "测试抖音号" {
		t.Fatalf("连通测试：%+v %v", res, err)
	}
	if e.dy.hosts[0] != "open.douyin.com" {
		t.Fatalf("域名：%v", e.dy.hosts)
	}

	_, out := call(t, e.h, "GET", "/api/video/platforms", "")
	dy := out["data"].([]any)[2].(map[string]any)
	if dy["key"] != "douyin" || dy["tool"] != "douyin" || !slices.Equal(anyStrings(dy["caps"]), []string{"metrics", "comments"}) ||
		dy["creator_url"] != "https://creator.douyin.com/creator-micro/content/upload" || len(dy["connectors"].([]any)) != 1 {
		t.Fatalf("抖音：%v", dy)
	}
	// 视频号、小红书不做连接器：只有创作者后台地址
	for _, i := range []int{3, 4} {
		if p := out["data"].([]any)[i].(map[string]any); p["tool"] != nil || len(p["caps"].([]any)) != 0 || p["creator_url"] == "" {
			t.Fatalf("手动平台：%v", p)
		}
	}

	pb, filmID := e.dyPublishable(t)
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", `{"tags":["效率"]}`)
	if er := out["error"].(map[string]any); code != 400 || er["code"] != "unsupported" || !strings.Contains(er["message"].(string), "抖音还不能经连接器投稿") || !strings.Contains(er["message"].(string), "package") {
		t.Fatalf("投稿要 400 unsupported：%d %v", code, out)
	}
	// 没稿件链接时同步、评论 400
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", ""); code != 400 || !strings.Contains(errMsg(out), "还没有抖音的稿件链接") {
		t.Fatalf("没链接同步：%d %v", code, out)
	}

	// 发布包
	pk := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb+"/package", "", 200)
	v, cv := pk["video"].(map[string]any), pk["cover"].(map[string]any)
	if pk["platform"] != "douyin" || pk["upload"] != false || pk["creator_url"] != "https://creator.douyin.com/creator-micro/content/upload" ||
		pk["title"] != "十分钟上手" || pk["desc"] != "一集讲清楚" || v["artifact_id"] != filmID ||
		v["path"] != filepath.Join(e.root, "app", "output", "final.mp4") || v["size"] != 13.0 ||
		cv["path"] != filepath.Join(e.root, "app", "cover", "cover-3x4.jpg") || cv["ratio"] != "3x4" ||
		len(pk["checks"].([]any)) == 0 || len(pk["steps"].([]any)) != 5 {
		t.Fatalf("发布包：%v", pk)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/publishes/"+pb+"/package?file_id=vaf_nope", ""); code != 400 {
		t.Fatalf("不存在的成片要 400：%d", code)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/publishes/pb_nope/package", ""); code != 404 {
		t.Fatalf("不存在的发布要 404：%d", code)
	}
	if len(e.dy.calls) != 1 {
		t.Fatalf("发布包不出网：%v", e.dy.calls)
	}

	// 手动发完回填链接：拉数据（只拉数据，不查状态），分享数含转发
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"status":"published","url":"https://www.douyin.com/video/7300000000000000001?previous_page=app"}`, 200)
	code, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	p := data(out)
	m, _ := p["metrics"].(map[string]any)
	if code != 200 || p["status"] != "published" || m["views"] != 8888.0 || m["likes"] != 666.0 || m["comments"] != 55.0 || m["shares"] != 47.0 ||
		out["meta"].(map[string]any)["remote"] != nil || out["meta"].(map[string]any)["remote_id"] != "7300000000000000001" {
		t.Fatalf("同步：%d %v", code, out)
	}
	if b := e.dy.bodies[len(e.dy.bodies)-1]; !slices.Equal(anyStrings(b["video_ids"]), []string{"7300000000000000001"}) {
		t.Fatalf("数据接口：%v", b)
	}

	// 评论：先经数据接口换 item_id，再拉两页
	code, out = call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments", "")
	items := out["data"].([]any)
	if code != 200 || len(items) != 1 || out["meta"].(map[string]any)["next"] != "20" {
		t.Fatalf("评论：%d %v", code, out)
	}
	if c := items[0].(map[string]any); c["id"] != "@cmt-test-0001" || c["author"] != "@user-test-0001" || c["text"] != "求教程链接" || c["likes"] != 9.0 || c["at"] != "2025-10-29T09:00:00Z" {
		t.Fatalf("评论内容：%v", c)
	}
	_, out = call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments?cursor=20", "")
	if items := out["data"].([]any); len(items) != 1 || out["meta"].(map[string]any)["next"] != "" {
		t.Fatalf("第二页：%v", out)
	}
	if code, out := call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments?cursor=abc", ""); code != 502 || !strings.Contains(errMsg(out), "cursor") {
		t.Fatalf("坏游标：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" {
		t.Fatalf("坏游标不算渠道异常：%s", c.Status)
	}
}

// 令牌过期：同步 502，连接器异常，错误里不带令牌
func TestDouyinTokenExpired(t *testing.T) {
	e := setupDouyin(t)
	cn := e.addDouyin(t, "dy-access-expired")
	pb, _ := e.dyPublishable(t)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"status":"published","url":"https://www.douyin.com/video/7300000000000000001"}`, 200)
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	if code != 502 || !strings.Contains(errMsg(out), "2190008") || !strings.Contains(errMsg(out), "令牌失效") {
		t.Fatalf("令牌过期：%d %v", code, out)
	}
	c := e.connector(t, cn.ID)
	if c.Status != "error" || strings.Contains(c.Error, "dy-access-expired") {
		t.Fatalf("连接器：%s %s", c.Status, c.Error)
	}
	// 作品不是这个账号的：只算这次失败
	tok := dyGoodToken
	if _, err := e.conns.Update(context.Background(), cn.ID, connector.Patch{Secrets: map[string]string{"access_token": tok}}); err != nil {
		t.Fatal(err)
	}
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"url":"https://www.douyin.com/video/7300000000000000999"}`, 200)
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", ""); code != 502 || !strings.Contains(errMsg(out), "不存在") {
		t.Fatalf("别人的作品：%d %v", code, out)
	}
}

func TestDouyinRefOf(t *testing.T) {
	d := NewDouyin()
	for in, want := range map[string]string{
		"https://www.douyin.com/video/7300000000000000001": "7300000000000000001", "7300000000000000001": "7300000000000000001",
		"https://www.douyin.com/video/7300000000000000001?modeFrom=": "7300000000000000001", "@9VwAtestItem0001xyzABC==": "@9VwAtestItem0001xyzABC==",
		"https://v.douyin.com/abcde/": "", "https://www.douyin.com/user/MS4wLjAB": "", "123": "",
	} {
		ref, ok := d.RefOf(in)
		if ok != (want != "") || ref.ID != want {
			t.Errorf("RefOf(%q) = %v %v", in, ref, ok)
		}
	}
}

// 两个连接器登记进连接器目录；停用视频插件后不在目录里，再启用回来
func TestMediaConnectorsFollowPlugin(t *testing.T) {
	e := setupDouyin(t)
	ctx := context.Background()
	tools := func() []string {
		var out []string
		for _, d := range e.conns.Defs().List() {
			if d.Category == "media" {
				out = append(out, d.Tool)
			}
		}
		return out
	}
	if got := tools(); !slices.Equal(got, []string{"bilibili", "youtube", "douyin", BiliWebTool}) {
		t.Fatalf("连接器目录：%v", got)
	}
	if d, ok := e.conns.Defs().Get(YouTubeTool); !ok || d.Source != "video" || d.OAuth == nil || !slices.Equal(d.Auth, []connector.AuthMode{connector.AuthOAuth2}) {
		t.Fatalf("YouTube 定义：%+v", d)
	}
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if got := tools(); len(got) != 0 {
		t.Fatalf("停用后还在：%v", got)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if got := tools(); len(got) != 4 {
		t.Fatalf("启用后：%v", got)
	}
}
