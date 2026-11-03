package video

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// fakeReplies 是本机假评论接口：按稿件号和游标回一页评论，记下收到的请求。
type fakeReplies struct {
	mu    sync.Mutex
	pages map[string][]string // 稿件号 -> 每页的评论 JSON
	fail  map[string]bool     // 这些稿件号回 500
	calls []string
}

func (f *fakeReplies) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	oid, cursor := r.URL.Query().Get("oid"), r.URL.Query().Get("cursor")
	f.calls = append(f.calls, r.Header.Get("X-Original-Host")+r.URL.Path+"?oid="+oid+"&cursor="+cursor)
	if f.fail[oid] {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	i := 0
	if cursor != "" {
		_, _ = fmt.Sscanf(cursor, "p%d", &i)
	}
	pages := f.pages[oid]
	items, next := "[]", ""
	if i < len(pages) {
		items = pages[i]
	}
	if i+1 < len(pages) {
		next = fmt.Sprintf("p%d", i+1)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprintf(w, `{"items":%s,"next":%q}`, items, next)
}

func (f *fakeReplies) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// replyBili 是带评论能力的 B 站适配器：评论经出网客户端从假评论接口拉，其余照 B 站
type replyBili struct{ *Bilibili }

func (b replyBili) Caps() []string { return []string{CapUpload, CapMetrics, CapComments} }

func (b replyBili) Comments(ctx context.Context, s Session, ref RemoteRef, cursor string) (CommentPage, error) {
	if s.Config.Secret("access_token") == "" {
		return CommentPage{}, &PlatformError{Platform: "bilibili", Msg: "没拿到令牌"}
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.bilibili.com/x/v2/reply?oid="+url.QueryEscape(ref.ID)+"&cursor="+url.QueryEscape(cursor), nil)
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return CommentPage{}, &PlatformError{Platform: "bilibili", Msg: err.Error(), Channel: true}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return CommentPage{}, &PlatformError{Platform: "bilibili", Code: resp.StatusCode, Msg: "评论接口出错"}
	}
	var out struct {
		Items []Comment `json:"items"`
		Next  string    `json:"next"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return CommentPage{}, &PlatformError{Platform: "bilibili", Msg: err.Error()}
	}
	return CommentPage{Items: out.Items, Next: out.Next}, nil
}

func setupReplies(t *testing.T) (biliEnv, *fakeReplies) {
	t.Helper()
	e := setupBilibili(t, replyBili{NewBilibili()})
	f := &fakeReplies{pages: map[string][]string{}, fail: map[string]bool{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	e.r.SetHTTPTransport(biliRewrite{u})
	e.addConnector(t, biliGoodToken)
	return e, f
}

func publishedOn(t *testing.T, e biliEnv, vid, bv, title string) string {
	t.Helper()
	return mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"`+title+`",
		"status":"published","url":"https://www.bilibili.com/video/`+bv+`"}`, 201)["id"].(string)
}

// 假服务端上拉两次评论，同一条评论只落一份；评论素材转成选题后，从选题能看到原评论和对应发布
func TestCollectCommentsDedup(t *testing.T) {
	e, f := setupReplies(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 3 集：Agent 怎么配"}`, 201)["id"].(string)
	pb := publishedOn(t, e, vid, "BV1Te5tTst01", "第 3 集")
	f.mu.Lock()
	f.pages["BV1Te5tTst01"] = []string{
		`[{"id":"9001","author":"路人甲","text":"能不能讲讲 Agent 怎么接自己公司的系统，MCP 那块看不太懂","likes":15400,"at":"2026-10-29T08:00:00Z"},
		  {"id":"9002","author":"路人乙","text":"讲得好","likes":3}]`,
		`[{"id":"9003","author":"","text":"求出一期本地跑大模型的","likes":0},{"id":"9004","text":"   "}]`,
	}
	f.mu.Unlock()

	_, out := call(t, e.h, "POST", "/api/video/clips/comments", "")
	if out["meta"] == nil {
		t.Fatalf("第一次：%v", out)
	}
	_, out2 := call(t, e.h, "POST", "/api/video/clips/comments", `{}`)
	m2 := out2["meta"].(map[string]any)
	if m2["added"] != 0.0 || m2["duplicates"].(float64) < 2 || len(m2["skipped"].([]any)) != 0 || m2["publishes"] != 1.0 {
		t.Fatalf("第二次不该再落：%v", out2)
	}
	clips := listData(t, e.env, "/api/video/clips?publish_id="+pb)
	if len(clips) != 3 {
		t.Fatalf("三条评论应该只落三份：%d %v", len(clips), clips)
	}
	var first map[string]any
	for _, x := range clips {
		c := x.(map[string]any)
		if c["kind"] != "comment" || c["publish_id"] != pb || c["remote_id"] != nil {
			t.Fatalf("评论素材：%v", c)
		}
		if strings.HasPrefix(c["content"].(string), "能不能讲讲") {
			first = c
		}
	}
	if first == nil || first["title"] != "能不能讲讲 Agent 怎么接自己公司的系统，MCP 那块看不太懂" || first["heat"] != 15400.0 ||
		first["source"] != "B 站评论 · 第 3 集 · 路人甲" || first["triaged"] != false {
		t.Fatalf("第一条评论：%v", first)
	}
	// 第二次第一页全是收过的，不往下翻
	f.mu.Lock()
	calls := append([]string(nil), f.calls...)
	f.mu.Unlock()
	if calls[len(calls)-1] != "api.bilibili.com/x/v2/reply?oid=BV1Te5tTst01&cursor=" || !strings.HasSuffix(calls[1], "cursor=p1") {
		t.Fatalf("请求：%v", calls)
	}
	// 平台上多了一条新评论，再拉只收新的
	f.mu.Lock()
	f.pages["BV1Te5tTst01"][0] = `[{"id":"9005","author":"新来的","text":"第 4 集什么时候出"},` + strings.TrimPrefix(f.pages["BV1Te5tTst01"][0], "[")
	f.mu.Unlock()
	_, out = call(t, e.h, "POST", "/api/video/clips/comments", `{"publish_id":"`+pb+`"}`)
	if added := out["data"].([]any); len(added) != 1 || added[0].(map[string]any)["title"] != "第 4 集什么时候出" {
		t.Fatalf("只收新评论：%v", out)
	}
	if n := len(listData(t, e.env, "/api/video/clips?publish_id="+pb)); n != 4 {
		t.Fatalf("评论素材数：%d", n)
	}

	// 转为选题：从选题反查素材能看到原评论，素材带着发布记录，发布记录指回视频
	clID := first["id"].(string)
	res := mustCall(t, e.h, "POST", "/api/video/clips/"+clID+"/topic", `{}`, 201)
	tp := res["topic"].(map[string]any)
	if tp["outline"] != first["content"] || tp["score"].(map[string]any)["demand"] != 4.0 || !reflect.DeepEqual(tp["clip_ids"], []any{clID}) {
		t.Fatalf("转出来的选题：%v", tp)
	}
	got := listData(t, e.env, "/api/video/clips?topic_id="+tp["id"].(string))
	if len(got) != 1 || got[0].(map[string]any)["content"] != first["content"] || got[0].(map[string]any)["publish_id"] != pb {
		t.Fatalf("选题里的原评论：%v", got)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["video_id"] != vid || p["title"] != "第 3 集" {
		t.Fatalf("对应发布：%v", p)
	}
	// 转过选题的评论再拉一次也不会重复落、不会把已整理冲掉
	call(t, e.h, "POST", "/api/video/clips/comments", "")
	if c := mustCall(t, e.h, "GET", "/api/video/clips/"+clID, "", 200); c["triaged"] != true {
		t.Fatalf("转过选题的评论：%v", c)
	}
	if n := len(listData(t, e.env, "/api/video/clips?publish_id="+pb)); n != 4 {
		t.Fatalf("评论素材数：%d", n)
	}
}

// 拉不了的发布记录：全部拉时记进 skipped，别的照拉；单条拉时直接报错
func TestCollectCommentsSkips(t *testing.T) {
	e, f := setupReplies(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x"}`, 201)["id"].(string)
	good := publishedOn(t, e, vid, "BV1Te5tTst01", "好的")
	bad := publishedOn(t, e, vid, "BV1Te5tTst02", "坏的")
	// 没公开的、别的平台的不拉
	planned := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"还没发"}`, 201)["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"douyin","variant":"portrait","title":"抖音","status":"published","url":"https://www.douyin.com/video/1"}`, 201)
	f.mu.Lock()
	f.pages["BV1Te5tTst01"] = []string{`[{"id":"1","text":"好"}]`}
	f.fail["BV1Te5tTst02"] = true
	f.mu.Unlock()
	code, out := call(t, e.h, "POST", "/api/video/clips/comments", "")
	m := out["meta"].(map[string]any)
	sk := m["skipped"].([]any)
	if code != 200 || m["publishes"] != 1.0 || len(sk) != 1 || sk[0].(map[string]any)["publish_id"] != bad || !strings.Contains(sk[0].(map[string]any)["reason"].(string), "500") {
		t.Fatalf("全部拉：%d %v", code, out)
	}
	if n := len(listData(t, e.env, "/api/video/clips?publish_id="+good)); n != 1 {
		t.Fatalf("好的那条照拉：%d", n)
	}
	if code, out := call(t, e.h, "POST", "/api/video/clips/comments", `{"publish_id":"`+bad+`"}`); code != 502 || out["error"].(map[string]any)["code"] != "fetch_failed" {
		t.Fatalf("单条出错：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/video/clips/comments", `{"publish_id":"`+planned+`"}`); code != 400 || !strings.Contains(errMsg(out), "稿件链接") {
		t.Fatalf("没投稿的：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/video/clips/comments", `{"publish_id":"pb_nope"}`); code != 404 {
		t.Fatalf("不存在：%d", code)
	}
	if code, _ := call(t, e.h, "POST", "/api/video/clips/comments", `{"what":1}`); code != 400 {
		t.Fatalf("不认识的字段：%d", code)
	}
	// 连接器暂停：记进 skipped，不出网
	before := f.callCount()
	list, _ := e.conns.List(context.Background(), BilibiliTool)
	off := false
	if _, err := e.conns.Update(context.Background(), list[0].ID, connector.Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	_, out = call(t, e.h, "POST", "/api/video/clips/comments", "")
	if sk := out["meta"].(map[string]any)["skipped"].([]any); len(sk) != 2 || !strings.Contains(sk[0].(map[string]any)["reason"].(string), "已暂停") || f.callCount() != before {
		t.Fatalf("暂停：%v", out)
	}
}

// 平台都没有评论能力（现在的 B 站）：后台任务什么都不做，按钮回 400；没装 IM 插件时 IM 素材照收，同一条消息只收一份
func TestCollectCommentsWithoutCapsAndIM(t *testing.T) {
	e := setupBilibili(t)
	if code, out := call(t, e.h, "POST", "/api/video/clips/comments", ""); code != 400 || !strings.Contains(errMsg(out), "拉评论") {
		t.Fatalf("没有评论能力：%d %v", code, out)
	}
	for _, p := range e.r.List() {
		if p.Manifest.ID == "im" {
			t.Fatal("这个测试要在没装 IM 插件时跑")
		}
	}
	body := `{"kind":"im","title":"同事问：周报能不能全自动","content":"周报能不能全自动","source":"Slack · #product","message_id":"msg_01abc"}`
	a := mustCall(t, e.h, "POST", "/api/video/clips", body, 201)
	code, out := call(t, e.h, "POST", "/api/video/clips", body)
	if code != 200 || data(out)["id"] != a["id"] || out["meta"].(map[string]any)["existing"] != true {
		t.Fatalf("同一条消息再收：%d %v", code, out)
	}
	if n := len(listData(t, e.env, "/api/video/clips?message_id=msg_01abc")); n != 1 {
		t.Fatalf("只收一份：%d", n)
	}
}

// 后台任务：启用时先跑一轮，按发布记录把评论收进来，不用点按钮
func TestCommentJobOnEnable(t *testing.T) {
	e, f := setupReplies(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x"}`, 201)["id"].(string)
	pb := publishedOn(t, e, vid, "BV1Te5tTst01", "第 1 集")
	f.mu.Lock()
	f.pages["BV1Te5tTst01"] = []string{`[{"id":"1","text":"好"},{"id":"2","text":"再来一集"}]`}
	f.mu.Unlock()
	ctx := context.Background()
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, out := call(t, e.h, "GET", "/api/video/clips?publish_id="+pb, "")
		if xs, _ := out["data"].([]any); len(xs) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("后台任务没收进评论：%v", out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
