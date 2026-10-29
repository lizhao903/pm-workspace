package video

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
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
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

const (
	biliClientID  = "client-test-0001"
	biliAppSecret = "app-secret-test-only"
	biliGoodToken = "access-token-test-only"
)

// fakeBilibili 是本机假开放平台：响应取 testdata/bilibili 的样例，校验签名和令牌，记下收到的分片和投稿内容。
type fakeBilibili struct {
	t  *testing.T
	mu sync.Mutex
	// 可调的行为
	token     string // 认这个 access-token，别的回 token_invalid
	view      string // archive/view 回哪个样例
	rejectAdd bool   // 投稿回 submit_rejected
	calls     []string
	hosts     []string
	parts     [][]byte
	partNums  []string
	added     map[string]any
	coverBody []byte
	badSigned []string
}

func newFakeBilibili(t *testing.T) *fakeBilibili {
	return &fakeBilibili{t: t, token: biliGoodToken, view: "archive_view_reviewing"}
}

func (f *fakeBilibili) sample(w http.ResponseWriter, name string) {
	b, err := os.ReadFile(filepath.Join("testdata", "bilibili", name+".json"))
	if err != nil {
		f.t.Errorf("读样例 %s：%v", name, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}

func (f *fakeBilibili) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	f.hosts = append(f.hosts, r.Header.Get("X-Original-Host"))
	if r.URL.Path == "/video/v2/part/upload" {
		if r.URL.Query().Get("upload_token") != "utoken-test-0001" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"code":-403,"message":"upload_token 无效"}`)
			return
		}
		f.parts = append(f.parts, body)
		f.partNums = append(f.partNums, r.URL.Query().Get("part_number"))
		f.sample(w, "part_upload")
		return
	}
	// 开放平台接口都要签名：client_id、内容 md5、Authorization 对得上
	h := r.Header
	if h.Get("x-bili-accesskeyid") != biliClientID || h.Get("Authorization") != biliSign(biliAppSecret, h) ||
		h.Get("x-bili-signature-method") != "HMAC-SHA256" || h.Get("x-bili-content-md5") == "" {
		f.badSigned = append(f.badSigned, r.URL.Path)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"code":-401,"message":"签名错误"}`)
		return
	}
	if h.Get("access-token") != f.token {
		f.sample(w, "token_invalid")
		return
	}
	switch r.URL.Path {
	case "/arcopen/fn/user/account/info":
		f.sample(w, "account_info")
	case "/arcopen/fn/archive/video/init":
		f.sample(w, "video_init")
	case "/arcopen/fn/archive/video/complete":
		f.sample(w, "video_complete")
	case "/arcopen/fn/archive/cover/upload":
		r.Body = io.NopCloser(bytes.NewReader(body))
		mr, err := r.MultipartReader()
		if err == nil {
			if p, err := mr.NextPart(); err == nil && p.FormName() == "file" {
				f.coverBody, _ = io.ReadAll(p)
			}
		}
		f.sample(w, "cover_upload")
	case "/arcopen/fn/archive/add-by-utoken":
		if f.rejectAdd {
			f.sample(w, "submit_rejected")
			return
		}
		f.added = map[string]any{}
		_ = json.Unmarshal(body, &f.added)
		f.added["upload_token"] = r.URL.Query().Get("upload_token")
		f.sample(w, "add_by_utoken")
	case "/arcopen/fn/archive/view":
		f.sample(w, f.view)
	case "/arcopen/fn/data/arc/stat":
		f.sample(w, "arc_stat")
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"code":-404,"message":"啥都木有"}`)
	}
}

func (f *fakeBilibili) set(fn func(f *fakeBilibili)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// biliRewrite 把发往 B 站的请求改投到本机假服务，原来的域名写进 X-Original-Host；域名检查在它外面照常做。
type biliRewrite struct{ to *url.URL }

func (rw biliRewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	r2 := r.Clone(r.Context())
	r2.Header.Set("X-Original-Host", r.URL.Host)
	r2.URL.Scheme, r2.URL.Host, r2.Host = rw.to.Scheme, rw.to.Host, rw.to.Host
	return http.DefaultTransport.RoundTrip(r2)
}

type biliEnv struct {
	env
	conns *connector.Store
	fake  *fakeBilibili
	root  string
}

// setupBilibili 在真库上装好 projects、video（带 B 站适配器），接上真的连接器 store 和本机假开放平台。
func setupBilibili(t *testing.T, adapters ...PlatformAdapter) biliEnv {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "pm.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	v, _, err := vault.Open(ctx, path, vault.KeyOptions{UseKeychain: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = v.Close() })
	defs := connector.NewRegistry()
	conns := connector.New(d, v, defs)
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.SetConnectors(conns)
	defs.SetPluginDefs(r.ConnectorDefs)
	fake := newFakeBilibili(t)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	r.SetHTTPTransport(biliRewrite{u})
	if len(adapters) == 0 {
		b := NewBilibili()
		b.chunk = 10 // 测试文件小，分片也切小
		adapters = []PlatformAdapter{b}
	}
	for _, p := range []plugin.Plugin{projects.New(), newWith(adapters...)} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, id := range []string{"projects", "video"} {
		ps := perms
		if id == "projects" {
			ps = []string{"process:spawn"}
		}
		if err := r.Install(ctx, id, ps); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return biliEnv{env: env{r, mux, d}, conns: conns, fake: fake, root: t.TempDir()}
}

func (e biliEnv) addConnector(t *testing.T, token string) *connector.Connector {
	t.Helper()
	c, err := e.conns.Create(context.Background(), connector.Input{Tool: BilibiliTool,
		Config: map[string]string{"client_id": biliClientID}, Secrets: map[string]string{"app_secret": biliAppSecret, "access_token": token}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (e biliEnv) connector(t *testing.T, id string) *connector.Connector {
	t.Helper()
	c, err := e.conns.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// video 建一集横屏视频，工程目录是临时目录，登记成片和 16:9 封面，文件写在磁盘上；回视频 id 和发布记录 id。
func (e biliEnv) publishable(t *testing.T, film []byte) (string, string) {
	t.Helper()
	for p, b := range map[string][]byte{"pc/output/final.mp4": film, "pc/cover/cover-16x9.jpg": []byte("fake-jpeg-cover")} {
		full := filepath.Join(e.root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	root, _ := json.Marshal(e.root)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"十分钟上手","orientations":["landscape"],"root":`+string(root)+`}`, 201)
	vid := v["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"video","variant":"landscape","path":"pc/output/final.mp4","status":"final"}`, 201)
	cover := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"cover","variant":"landscape","ratio":"16x9","path":"pc/cover/cover-16x9.jpg"}`, 201)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"十分钟上手产品工作台","desc":"一集讲清楚","cover_id":"`+cover["id"].(string)+`"}`, 201)
	return vid, pb["id"].(string)
}

const submitBody = `{"tags":["效率","工具"],"category":"201"}`

// 假服务端上走完：连通测试、上传成片（分片）、设封面、投稿、查状态、拉数据
func TestBilibiliFullFlow(t *testing.T) {
	e := setupBilibili(t)
	ctx := context.Background()
	cn := e.addConnector(t, biliGoodToken)
	res, err := e.conns.Test(ctx, cn.ID)
	if err != nil || !res.OK || res.Connector.Account != "测试UP主" || res.Connector.Status != "connected" {
		t.Fatalf("连通测试：%+v %v", res, err)
	}

	// 平台表：B 站有连接器、能上传和拉数据，别的平台只能手动登记
	_, out := call(t, e.h, "GET", "/api/video/platforms", "")
	ps := out["data"].([]any)
	if len(ps) != len(Platforms) {
		t.Fatalf("平台表：%v", ps)
	}
	bl := ps[0].(map[string]any)
	if bl["key"] != "bilibili" || bl["tool"] != "bilibili" || !slices.Equal(anyStrings(bl["caps"]), []string{"upload", "metrics"}) ||
		len(bl["connectors"].([]any)) != 1 || bl["connectors"].([]any)[0].(map[string]any)["account"] != "测试UP主" {
		t.Fatalf("B 站：%v", bl)
	}
	if yt := ps[1].(map[string]any); yt["tool"] != nil || len(yt["caps"].([]any)) != 0 {
		t.Fatalf("YouTube 还没接：%v", yt)
	}

	film := []byte("0123456789abcdefghijKLMNO") // 25 字节，按 10 字节分 3 片
	_, pb := e.publishable(t, film)
	p := mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody, 200)
	if p["status"] != "published" || p["url"] != "https://www.bilibili.com/video/BV1Te5tTst01" || p["error"] != nil || p["published_at"] == nil {
		t.Fatalf("投稿后：%v", p)
	}
	f := e.fake
	if len(f.badSigned) != 0 {
		t.Fatalf("签名不对：%v", f.badSigned)
	}
	if !slices.Equal(f.partNums, []string{"1", "2", "3"}) || !bytes.Equal(bytes.Join(f.parts, nil), film) || len(f.parts[2]) != 5 {
		t.Fatalf("分片：%v %q", f.partNums, f.parts)
	}
	wantCalls := []string{"GET /arcopen/fn/user/account/info", "POST /arcopen/fn/archive/video/init", "POST /video/v2/part/upload",
		"POST /video/v2/part/upload", "POST /video/v2/part/upload", "POST /arcopen/fn/archive/video/complete",
		"POST /arcopen/fn/archive/cover/upload", "POST /arcopen/fn/archive/add-by-utoken"}
	if !slices.Equal(f.calls, wantCalls) {
		t.Fatalf("调用顺序：%v", f.calls)
	}
	// 接口发到开放平台的域名，分片发到上传域名
	if f.hosts[1] != "member.bilibili.com" || f.hosts[2] != "openupos.bilivideo.com" {
		t.Fatalf("域名：%v", f.hosts)
	}
	if string(f.coverBody) != "fake-jpeg-cover" {
		t.Fatalf("封面：%q", f.coverBody)
	}
	a := f.added
	if a["title"] != "十分钟上手产品工作台" || a["desc"] != "一集讲清楚" || a["tag"] != "效率,工具" || a["tid"] != 201.0 ||
		a["cover"] != "https://archive.biliimg.com/bfs/archive/test-cover-0001.jpg" || a["upload_token"] != "utoken-test-0001" || a["copyright"] != 1.0 {
		t.Fatalf("投稿内容：%v", a)
	}
	// 投过的不能再投
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody); code != 409 {
		t.Fatalf("再投一次要 409：%d %v", code, out)
	}

	// 查状态和数据：审核中照样拉数据，状态保持已发布
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	p = data(out)
	m, _ := p["metrics"].(map[string]any)
	meta := out["meta"].(map[string]any)
	if code != 200 || p["status"] != "published" || m["views"] != 1234.0 || m["likes"] != 567.0 || m["comments"] != 78.0 || m["shares"] != 34.0 ||
		meta["remote"].(map[string]any)["state"] != "reviewing" || meta["stats"].(map[string]any)["coins"] != 12.0 || meta["stats"].(map[string]any)["favorites"] != 90.0 {
		t.Fatalf("同步：%d %v", code, out)
	}
	// 开放后：状态说明换成平台的
	e.fake.set(func(f *fakeBilibili) { f.view = "archive_view_open" })
	code, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", `{"connector_id":"`+cn.ID+`"}`)
	if code != 200 || out["meta"].(map[string]any)["remote"].(map[string]any)["label"] != "开放浏览" {
		t.Fatalf("开放后同步：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" || c.LastSyncAt == nil {
		t.Fatalf("连接器：%+v", c)
	}
	// 退回：发布记录置为失败，原因是平台给的
	e.fake.set(func(f *fakeBilibili) { f.view = "archive_view_rejected" })
	p = mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "{}", 200)
	if p["status"] != "failed" || p["error"] != "B 站：封面与内容不符" {
		t.Fatalf("退回后：%v", p)
	}
}

func anyStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// 令牌失效：投稿失败，发布记录置为失败带原因，连接器置为异常；换上好令牌后重投成功，连接器恢复
func TestBilibiliTokenInvalid(t *testing.T) {
	e := setupBilibili(t)
	cn := e.addConnector(t, "access-token-revoked")
	_, pb := e.publishable(t, []byte("film-bytes"))
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody)
	er := out["error"].(map[string]any)
	if code != 502 || er["code"] != "publish_failed" || er["publish_id"] != pb || !strings.Contains(er["message"].(string), "令牌失效") {
		t.Fatalf("令牌失效要 502：%d %v", code, out)
	}
	p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200)
	if p["status"] != "failed" || !strings.Contains(p["error"].(string), "-101") || !strings.Contains(p["error"].(string), "账号未登录") {
		t.Fatalf("发布记录：%v", p)
	}
	c := e.connector(t, cn.ID)
	if c.Status != "error" || !strings.Contains(c.Error, "令牌失效") {
		t.Fatalf("连接器要置为异常：%s %s", c.Status, c.Error)
	}
	if strings.Contains(c.Error, "access-token-revoked") || strings.Contains(p["error"].(string), "access-token-revoked") {
		t.Fatal("错误里不能带令牌原文")
	}
	// 平台表里也看得到异常
	_, out = call(t, e.h, "GET", "/api/video/platforms", "")
	if got := out["data"].([]any)[0].(map[string]any)["connectors"].([]any)[0].(map[string]any); got["status"] != "error" || got["error"] == nil {
		t.Fatalf("平台表：%v", got)
	}
	// 用户在设置里换上新令牌：失败的发布可以重投，成功后连接器回到已连接
	tok := biliGoodToken
	if _, err := e.conns.Update(context.Background(), cn.ID, connector.Patch{Secrets: map[string]string{"access_token": tok}}); err != nil {
		t.Fatal(err)
	}
	p = mustCall(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody, 200)
	if p["status"] != "published" || p["error"] != nil {
		t.Fatalf("重投：%v", p)
	}
	if c := e.connector(t, cn.ID); c.Status != "connected" || c.Error != "" {
		t.Fatalf("连接器要恢复：%s %s", c.Status, c.Error)
	}
	// 同步时令牌失效：502 sync_failed，连接器异常，发布记录不动
	e.fake.set(func(f *fakeBilibili) { f.token = "rotated" })
	code, out = call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", "")
	if code != 502 || out["error"].(map[string]any)["code"] != "sync_failed" {
		t.Fatalf("同步失败：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "error" {
		t.Fatalf("同步失败后连接器：%s", c.Status)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["status"] != "published" {
		t.Fatalf("同步失败不改发布记录：%v", p)
	}
}

// 平台不收这次投稿（内容问题）：发布记录失败带原因，连接器不置为异常
func TestBilibiliSubmitRejected(t *testing.T) {
	e := setupBilibili(t)
	cn := e.addConnector(t, biliGoodToken)
	e.fake.set(func(f *fakeBilibili) { f.rejectAdd = true })
	_, pb := e.publishable(t, []byte("film-bytes"))
	code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody)
	if code != 502 {
		t.Fatalf("要 502：%d %v", code, out)
	}
	p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200)
	if p["status"] != "failed" || p["error"] != "B 站返回 21012：标题包含敏感词" {
		t.Fatalf("发布记录：%v", p)
	}
	if c := e.connector(t, cn.ID); c.Status == "error" {
		t.Fatalf("内容被拒不算渠道异常：%s %s", c.Status, c.Error)
	}
}

// 连不上平台：发布失败、连接器异常
func TestBilibiliUnreachable(t *testing.T) {
	e := setupBilibili(t)
	cn := e.addConnector(t, biliGoodToken)
	_, pb := e.publishable(t, []byte("film-bytes"))
	e.r.SetHTTPTransport(roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF }))
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/submit", submitBody); code != 502 || !strings.Contains(errMsg(out), "连不上 B 站") {
		t.Fatalf("连不上：%d %v", code, out)
	}
	if c := e.connector(t, cn.ID); c.Status != "error" {
		t.Fatalf("连接器：%s", c.Status)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// 上传之前就拦下的：400，发布记录和连接器都不动，也不发请求
func TestBilibiliSubmitValidation(t *testing.T) {
	e := setupBilibili(t)
	vid, pb := e.publishable(t, []byte("film-bytes"))
	path := "/api/video/publishes/" + pb + "/submit"
	for _, c := range []struct{ body, want string }{
		{`{"category":"201"}`, "至少要一个标签"},
		{`{"tags":["a"]}`, "要选分区"},
		{`{"tags":["a"],"category":"知识"}`, "分区 id"},
		{`{"tags":["a"],"category":"201","collection":"合集一"}`, "合集"},
		{`{"tags":["1","2","3","4","5","6","7","8","9","10","11"],"category":"201"}`, "标签太多"},
		{`{"tags":["a"],"category":"201","file_id":"vaf_nope"}`, "不存在"},
		{`{"tags":["a"],"category":"201","oops":1}`, "不认识的字段"},
		{submitBody, "还没接入B 站"},
	} {
		if code, out := call(t, e.h, "POST", path, c.body); code != 400 || !strings.Contains(errMsg(out), c.want) {
			t.Errorf("%s：要 400「%s」，实际 %d %v", c.body, c.want, code, out)
		}
	}
	e.addConnector(t, biliGoodToken)
	// 简介带外链、定时
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"desc":"详见 https://example.com"}`, 200)
	if code, out := call(t, e.h, "POST", path, submitBody); code != 400 || !strings.Contains(errMsg(out), "外链") {
		t.Errorf("外链：%d %v", code, out)
	}
	at := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"desc":"","status":"scheduled","scheduled_at":"`+at+`"}`, 200)
	if code, out := call(t, e.h, "POST", path, submitBody); code != 400 || !strings.Contains(errMsg(out), "定时") {
		t.Errorf("定时：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"status":"planned","scheduled_at":null,"cover_id":null}`, 200)
	if code, out := call(t, e.h, "POST", path, submitBody); code != 400 || !strings.Contains(errMsg(out), "要封面") {
		t.Errorf("没封面：%d %v", code, out)
	}
	// 成片文件不在磁盘上
	_ = os.Remove(filepath.Join(e.root, "pc", "output", "final.mp4"))
	if code, out := call(t, e.h, "POST", path, submitBody); code != 400 || !strings.Contains(errMsg(out), "不在工程目录里") {
		t.Errorf("成片不在：%d %v", code, out)
	}
	// 竖屏没有成片
	pp := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"portrait","title":"竖版"}`, 201)
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pp["id"].(string)+"/submit", submitBody); code != 400 || !strings.Contains(errMsg(out), "竖屏成片") {
		t.Errorf("没有竖屏成片：%d %v", code, out)
	}
	// 没有连接器的平台、没稿件链接的同步、B 站不支持的评论
	yt := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"youtube","variant":"landscape","title":"YT"}`, 201)
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+yt["id"].(string)+"/submit", submitBody); code != 400 || !strings.Contains(errMsg(out), "YouTube还不能经连接器投稿") {
		t.Errorf("YouTube：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/video/publishes/"+pb+"/sync", ""); code != 400 || !strings.Contains(errMsg(out), "还没有B 站的稿件链接") {
		t.Errorf("没链接同步：%d %v", code, out)
	}
	if code, out := call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments", ""); code != 400 || !strings.Contains(errMsg(out), "拉评论") {
		t.Errorf("B 站评论：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "POST", "/api/video/publishes/pb_nope/submit", submitBody); code != 404 {
		t.Errorf("不存在的发布记录要 404：%d", code)
	}
	if len(e.fake.calls) != 0 {
		t.Fatalf("拦下的不该发请求：%v", e.fake.calls)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["status"] != "planned" || p["error"] != nil {
		t.Fatalf("发布记录不动：%v", p)
	}
}

// 接了两个 B 站账号要指定；暂停的 409
func TestBilibiliPickConnector(t *testing.T) {
	e := setupBilibili(t)
	a := e.addConnector(t, biliGoodToken)
	e.addConnector(t, biliGoodToken)
	_, pb := e.publishable(t, []byte("film-bytes"))
	path := "/api/video/publishes/" + pb + "/submit"
	if code, out := call(t, e.h, "POST", path, submitBody); code != 400 || !strings.Contains(errMsg(out), "connector_id") {
		t.Fatalf("两个账号：%d %v", code, out)
	}
	on := false
	if _, err := e.conns.Update(context.Background(), a.ID, connector.Patch{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "POST", path, `{"tags":["a"],"category":"201","connector_id":"`+a.ID+`"}`); code != 409 || !strings.Contains(errMsg(out), "已暂停") {
		t.Fatalf("暂停：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", path, `{"tags":["a"],"category":"201","connector_id":"cn_nope"}`); code != 400 || !strings.Contains(errMsg(out), "不存在") {
		t.Fatalf("不存在：%d %v", code, out)
	}
}

// commentsBili 给 B 站适配器加上评论能力，测试评论接口的通路（B 站开放平台本身没有评论接口）
type commentsBili struct{ *Bilibili }

func (c commentsBili) Caps() []string { return []string{CapUpload, CapMetrics, CapComments} }

func (c commentsBili) Comments(_ context.Context, s Session, ref RemoteRef, cursor string) (CommentPage, error) {
	if s.Config.Secret("access_token") == "" || s.HTTP == nil {
		return CommentPage{}, &PlatformError{Platform: "bilibili", Msg: "没拿到配置"}
	}
	if cursor == "" {
		return CommentPage{Items: []Comment{{ID: "c1", Author: "路人", Text: ref.ID + " 讲得好", Likes: 3, At: "2026-10-29T08:00:00Z"}}, Next: "p2"}, nil
	}
	return CommentPage{}, nil
}

func TestPlatformComments(t *testing.T) {
	b := NewBilibili()
	e := setupBilibili(t, commentsBili{b})
	e.addConnector(t, biliGoodToken)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x"}`, 201)["id"].(string)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"t","status":"published","url":"https://www.bilibili.com/video/BV1Te5tTst01/?spm=1"}`, 201)["id"].(string)
	code, out := call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments", "")
	items := out["data"].([]any)
	if code != 200 || len(items) != 1 || items[0].(map[string]any)["text"] != "BV1Te5tTst01 讲得好" || out["meta"].(map[string]any)["next"] != "p2" {
		t.Fatalf("评论：%d %v", code, out)
	}
	_, out = call(t, e.h, "GET", "/api/video/publishes/"+pb+"/comments?cursor=p2", "")
	if items := out["data"].([]any); len(items) != 0 || out["meta"].(map[string]any)["next"] != "" {
		t.Fatalf("第二页：%v", out)
	}
}

func TestBilibiliRefOfAndSign(t *testing.T) {
	b := NewBilibili()
	for in, want := range map[string]string{
		"BV1Te5tTst01": "BV1Te5tTst01", "https://www.bilibili.com/video/BV1Te5tTst01": "BV1Te5tTst01",
		"https://www.bilibili.com/video/BV1Te5tTst01/?p=2": "BV1Te5tTst01", "https://b23.tv/xyz": "", "BV1short": "",
	} {
		ref, ok := b.RefOf(in)
		if ok != (want != "") || ref.ID != want {
			t.Errorf("RefOf(%q) = %v %v", in, ref, ok)
		}
	}
	// 签名只取 x-bili-* 那几个头，按字典序，和别的头无关
	h := http.Header{}
	for _, k := range biliSignHeaders {
		h.Set(k, "v-"+k)
	}
	s1 := biliSign("secret", h)
	h.Set("access-token", "whatever")
	if s2 := biliSign("secret", h); s1 != s2 || len(s1) != 64 || biliSign("other", h) == s1 {
		t.Fatalf("签名：%s %s", s1, s2)
	}
}
