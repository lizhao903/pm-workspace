// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// fakeGitHub 是本机假 GitHub API：回一段 Release JSON 或指定的状态码，记下收到的请求。
// 经 Registry.SetHTTPTransport + biliRewrite 把发往 api.github.com 的请求改投到这里，全程不出网。
type fakeGitHub struct {
	mu      sync.Mutex
	body    string
	status  int
	headers map[string]string
	calls   []fakeGitHubCall
}

type fakeGitHubCall struct {
	host, uri, ua, accept string
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeGitHubCall{
		host: r.Header.Get("X-Original-Host"), uri: r.URL.RequestURI(),
		ua: r.Header.Get("User-Agent"), accept: r.Header.Get("Accept"),
	})
	for k, v := range f.headers {
		w.Header().Set(k, v)
	}
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, f.body)
}

func (f *fakeGitHub) set(fn func(f *fakeGitHub)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeGitHub) lastCall() fakeGitHubCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

// setupGitHub 在真库上装好、启用 projects 和 video，把出网改投到本机假 GitHub。
func setupGitHub(t *testing.T) (env, *fakeGitHub) {
	t.Helper()
	e := setup(t)
	f := &fakeGitHub{body: "[]"}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	e.r.SetHTTPTransport(biliRewrite{u})
	return e, f
}

// 拉一次 Release：字段映射、按旧到新落库（返回新在前）、草稿和预发布跳过、再拉去重、kind 筛选、转选题沿用标题和大纲
func TestPullGitHubReleases(t *testing.T) {
	e, f := setupGitHub(t)
	f.set(func(f *fakeGitHub) {
		f.body = `[
		 {"tag_name":"v2.0.0","name":"正式版","body":"  新功能 A\n修复 B  ","html_url":"https://github.com/foo/bar/releases/tag/v2.0.0","published_at":"2026-11-10T08:00:00Z"},
		 {"tag_name":"v1.5.0-rc.1","name":"","body":"预发布说明","html_url":"https://github.com/foo/bar/releases/tag/v1.5.0-rc.1","published_at":"2026-11-01T00:00:00Z","prerelease":true},
		 {"tag_name":"v1.0.0","name":"","body":"第一版说明","html_url":"https://github.com/foo/bar/releases/tag/v1.0.0","published_at":"2026-10-01T00:00:00Z"},
		 {"tag_name":"v3.0.0-draft","name":"草稿","body":"还没发","html_url":"https://github.com/foo/bar/releases/tag/v3.0.0-draft","published_at":"2026-11-15T00:00:00Z","draft":true}
		]`
	})
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 {
		t.Fatalf("拉 Release：%d %v", code, out)
	}
	meta := out["meta"].(map[string]any)
	if meta["repo"] != "foo/bar" || meta["added"] != 2.0 || meta["duplicates"] != 0.0 || meta["releases"] != 4.0 {
		t.Fatalf("meta：%v", meta)
	}
	sk := meta["skipped"].([]any)
	if len(sk) != 2 || sk[0].(map[string]any)["tag"] != "v3.0.0-draft" || sk[0].(map[string]any)["reason"] != "草稿" ||
		sk[1].(map[string]any)["tag"] != "v1.5.0-rc.1" || sk[1].(map[string]any)["reason"] != "预发布" {
		t.Fatalf("skipped：%v", sk)
	}
	data := out["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("落了 %d 条：%v", len(data), data)
	}
	first := data[0].(map[string]any)
	if first["kind"] != "release" || first["title"] != "v2.0.0 正式版" || first["content"] != "新功能 A\n修复 B" ||
		first["url"] != "https://github.com/foo/bar/releases/tag/v2.0.0" || first["source"] != "GitHub · foo/bar" ||
		!reflect.DeepEqual(first["tags"], []any{"v2.0.0", "2026-11-10"}) ||
		first["starred"] != false || first["triaged"] != false || first["heat"] != nil {
		t.Fatalf("第一条：%v", first)
	}
	second := data[1].(map[string]any)
	if second["title"] != "v1.0.0" || second["content"] != "第一版说明" ||
		!reflect.DeepEqual(second["tags"], []any{"v1.0.0", "2026-10-01"}) {
		t.Fatalf("第二条：%v", second)
	}
	// 列表接口能按 kind=release 筛到，顺序同响应（新在前）
	clips := listData(t, e, "/api/video/clips?kind=release")
	if len(clips) != 2 || clips[0].(map[string]any)["title"] != "v2.0.0 正式版" || clips[1].(map[string]any)["title"] != "v1.0.0" {
		t.Fatalf("kind=release：%v", clips)
	}
	// 请求头、域名和路径
	call0 := f.lastCall()
	if call0.host != "api.github.com" || call0.uri != "/repos/foo/bar/releases?per_page=30" ||
		call0.ua != "pmw-video-plugin" || call0.accept != "application/vnd.github+json" {
		t.Fatalf("请求：%+v", call0)
	}
	// 再拉一次：按 remote_id 去重，不重复落
	code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	meta = out["meta"].(map[string]any)
	if code != 200 || meta["added"] != 0.0 || meta["duplicates"] != 2.0 || meta["releases"] != 4.0 {
		t.Fatalf("第二次：%d %v", code, out)
	}
	if n := len(listData(t, e, "/api/video/clips?kind=release")); n != 2 {
		t.Fatalf("去重后素材数：%d", n)
	}
	// 转选题：标题用 Release 标题，大纲用 Release 说明
	clID := first["id"].(string)
	res := mustCall(t, e.h, "POST", "/api/video/clips/"+clID+"/topic", `{}`, 201)
	tp := res["topic"].(map[string]any)
	if tp["title"] != "v2.0.0 正式版" || tp["outline"] != "新功能 A\n修复 B" || tp["status"] != "idea" {
		t.Fatalf("转选题：%v", tp)
	}
}

// include_prerelease 勾上后预发布也落；limit 体现在 per_page；repo 也认 GitHub 仓库地址（带 .git、结尾 /）
func TestPullGitHubReleasesOptions(t *testing.T) {
	e, f := setupGitHub(t)
	f.set(func(f *fakeGitHub) {
		f.body = `[{"tag_name":"v2.0.0-beta.1","name":"","body":"beta 说明","html_url":"https://github.com/foo/bar/releases/tag/v2.0.0-beta.1","published_at":"2026-11-12T00:00:00Z","prerelease":true}]`
	})
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"https://github.com/foo/bar.git/","limit":7,"include_prerelease":true}`)
	if code != 200 {
		t.Fatalf("预发布：%d %v", code, out)
	}
	meta := out["meta"].(map[string]any)
	if meta["repo"] != "foo/bar" || meta["added"] != 1.0 || len(meta["skipped"].([]any)) != 0 {
		t.Fatalf("meta：%v", meta)
	}
	first := out["data"].([]any)[0].(map[string]any)
	if first["title"] != "v2.0.0-beta.1" || first["kind"] != "release" {
		t.Fatalf("预发布素材：%v", first)
	}
	if c := f.lastCall(); c.uri != "/repos/foo/bar/releases?per_page=7" {
		t.Fatalf("per_page：%+v", c)
	}
}

// 各种合法 repo 写法规整成 owner/repo，非法的不认
func TestGitHubRepoParsing(t *testing.T) {
	for _, tc := range []struct {
		in, owner, repo string
		ok              bool
	}{
		{"foo/bar", "foo", "bar", true},
		{" foo/bar/ ", "foo", "bar", true},
		{"foo/bar.git", "foo", "bar", true},
		{"foo/bar/", "foo", "bar", true},
		{"https://github.com/foo/bar", "foo", "bar", true},
		{"https://github.com/foo/bar.git", "foo", "bar", true},
		{"https://github.com/foo/bar/", "foo", "bar", true},
		{"http://github.com/foo/bar", "foo", "bar", true},
		{"github.com/foo/bar", "foo", "bar", true},
		{"Foo/Bar", "Foo", "Bar", true},
		{"", "", "", false},
		{"foo", "", "", false},
		{"foo/bar/baz", "", "", false},
		{"https://gitlab.com/foo/bar", "", "", false},
		{"https://github.com/foo", "", "", false},
		{"foo bar/baz", "", "", false},
		{"-foo/bar", "", "", false},
		{"foo/ba r", "", "", false},
		{"foo/..", "", "", false},
		{"foo/.", "", "", false},
	} {
		owner, repo, ok := parseGitHubRepo(tc.in)
		if ok != tc.ok || (ok && (owner != tc.owner || repo != tc.repo)) {
			t.Errorf("parseGitHubRepo(%q) = %q, %q, %v，期望 %q, %q, %v", tc.in, owner, repo, ok, tc.owner, tc.repo, tc.ok)
		}
	}
	// 接口层的非法 body 都 400，不出网
	e, f := setupGitHub(t)
	for _, body := range []string{
		`{}`, `{"repo":""}`, `{"repo":"nope"}`, `{"repo":"https://gitlab.com/a/b"}`,
		`{"repo":123}`, `{"repo":"foo/bar","limit":0}`, `{"repo":"foo/bar","limit":101}`,
		`{"repo":"foo/bar","include_prerelease":"yes"}`, `{"what":1}`,
	} {
		if code, out := call(t, e.h, "POST", "/api/video/clips/github", body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body, code, out)
		}
	}
	if n := len(f.calls); n != 0 {
		t.Fatalf("非法请求不该出网：%d", n)
	}
}

// 仓库不存在 400；限流、别的非 200、网络错误、JSON 解析失败都 502 fetch_failed
func TestPullGitHubReleasesErrors(t *testing.T) {
	e, f := setupGitHub(t)
	// 404：不是公开仓库
	f.set(func(f *fakeGitHub) { f.status = http.StatusNotFound })
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 400 || errMsg(out) != "GitHub 上没有这个仓库，或者它不是公开仓库" {
		t.Fatalf("404：%d %v", code, out)
	}
	// 403 且匿名额度用光：502，说明限流
	f.set(func(f *fakeGitHub) {
		f.status = http.StatusForbidden
		f.headers = map[string]string{"X-RateLimit-Remaining": "0"}
	})
	code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 502 || out["error"].(map[string]any)["code"] != "fetch_failed" || !strings.Contains(errMsg(out), "60") {
		t.Fatalf("403 限流：%d %v", code, out)
	}
	// 429 同 403
	f.set(func(f *fakeGitHub) {
		f.status = http.StatusTooManyRequests
		f.headers = map[string]string{"X-RateLimit-Remaining": "0"}
	})
	if code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`); code != 502 ||
		out["error"].(map[string]any)["code"] != "fetch_failed" {
		t.Fatalf("429 限流：%d %v", code, out)
	}
	// 403 不是限流、500：都是 502 fetch_failed
	for _, status := range []int{http.StatusForbidden, http.StatusInternalServerError} {
		f.set(func(f *fakeGitHub) {
			f.status = status
			f.headers = nil
		})
		if code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`); code != 502 ||
			out["error"].(map[string]any)["code"] != "fetch_failed" {
			t.Fatalf("%d：%d %v", status, code, out)
		}
	}
	// JSON 解析不了
	f.set(func(f *fakeGitHub) {
		f.status = 0
		f.body = "{"
	})
	if code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`); code != 502 ||
		out["error"].(map[string]any)["code"] != "fetch_failed" {
		t.Fatalf("解析失败：%d %v", code, out)
	}
	// 网络错误
	e.r.SetHTTPTransport(roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF }))
	if code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`); code != 502 ||
		out["error"].(map[string]any)["code"] != "fetch_failed" {
		t.Fatalf("网络错误：%d %v", code, out)
	}
}

// 升级到 0.10.0 后 network:github 还没确认：400，提示去插件管理确认，不出网
func TestPullGitHubReleasesNeedsPermission(t *testing.T) {
	e := setupPerms(t, []string{"fs:read:project", "fs:write:project", "network:media-platforms", "process:spawn", "fs:read:registered"}, "")
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 400 || !strings.Contains(errMsg(out), "network:github") {
		t.Fatalf("没确认权限：%d %v", code, out)
	}
}

// 没有 tag_name 的 Release 跳过：记进 skipped（tag 为空串，原因「没有版本号」），不落库
func TestPullGitHubReleasesSkipNoTag(t *testing.T) {
	e, f := setupGitHub(t)
	f.set(func(f *fakeGitHub) {
		f.body = `[{"tag_name":"","name":"只有名字","body":"没有版本号的说明","html_url":"https://github.com/foo/bar/releases/tag/none","published_at":"2026-11-10T08:00:00Z"}]`
	})
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 {
		t.Fatalf("没有版本号：%d %v", code, out)
	}
	meta := out["meta"].(map[string]any)
	if meta["added"] != 0.0 || meta["duplicates"] != 0.0 || meta["releases"] != 1.0 {
		t.Fatalf("meta：%v", meta)
	}
	sk := meta["skipped"].([]any)
	if len(sk) != 1 || sk[0].(map[string]any)["tag"] != "" || sk[0].(map[string]any)["reason"] != "没有版本号" {
		t.Fatalf("skipped：%v", sk)
	}
	if n := len(listData(t, e, "/api/video/clips?kind=release")); n != 0 {
		t.Fatalf("没有版本号不该落库：%d", n)
	}
}

// 空列表：200，data 是空数组（不是 null），meta 各计数都是 0、skipped 是空数组
func TestPullGitHubReleasesEmptyList(t *testing.T) {
	e, f := setupGitHub(t) // setupGitHub 默认假服务就回 []
	f.set(func(f *fakeGitHub) { f.body = "[]" })
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 {
		t.Fatalf("空列表：%d %v", code, out)
	}
	if data, ok := out["data"].([]any); !ok || len(data) != 0 {
		t.Fatalf("data 要是空数组：%#v", out["data"])
	}
	meta := out["meta"].(map[string]any)
	if meta["repo"] != "foo/bar" || meta["added"] != 0.0 || meta["duplicates"] != 0.0 || meta["releases"] != 0.0 {
		t.Fatalf("meta：%v", meta)
	}
	if sk, ok := meta["skipped"].([]any); !ok || len(sk) != 0 {
		t.Fatalf("skipped 要是空数组：%#v", meta["skipped"])
	}
	if n := len(listData(t, e, "/api/video/clips?kind=release")); n != 0 {
		t.Fatalf("空列表不该落库：%d", n)
	}
}

// html_url 不是 http(s)（javascript:、相对路径）时不带 url，其余字段照常落库
func TestPullGitHubReleasesDropNonHTTPURL(t *testing.T) {
	e, f := setupGitHub(t)
	f.set(func(f *fakeGitHub) {
		f.body = `[
		 {"tag_name":"v2.0.0","name":"","body":"第二条","html_url":"/foo/bar","published_at":"2026-11-11T08:00:00Z"},
		 {"tag_name":"v1.0.0","name":"","body":"第一条","html_url":"javascript:alert(1)","published_at":"2026-11-10T08:00:00Z"}
		]`
	})
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 {
		t.Fatalf("非 http 链接：%d %v", code, out)
	}
	data := out["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("落库条数：%v", data)
	}
	// 新的在前：v2.0.0（相对路径）、v1.0.0（javascript:）
	for i, want := range []string{"v2.0.0", "v1.0.0"} {
		c := data[i].(map[string]any)
		if c["url"] != nil || c["title"] != want || c["kind"] != "release" ||
			c["source"] != "GitHub · foo/bar" || c["content"] == "" {
			t.Fatalf("第 %d 条：%v", i+1, c)
		}
	}
	// 读回来也不带 url
	for _, x := range listData(t, e, "/api/video/clips?kind=release") {
		c := x.(map[string]any)
		if c["url"] != nil || c["source"] != "GitHub · foo/bar" {
			t.Fatalf("读回来：%v", c)
		}
	}
}

// 再拉同一条不冲掉已整理状态：重复只计 duplicates，改过的标题、内容、来源和已归的选题都留着
func TestPullGitHubReleasesDedupKeepsState(t *testing.T) {
	e, f := setupGitHub(t)
	f.set(func(f *fakeGitHub) {
		f.body = `[{"tag_name":"v1.0.0","name":"","body":"第一版说明","html_url":"https://github.com/foo/bar/releases/tag/v1.0.0","published_at":"2026-11-10T08:00:00Z"}]`
	})
	code, out := call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("第一次：%d %v", code, out)
	}
	cl := out["data"].([]any)[0].(map[string]any)
	clID := cl["id"].(string)
	// 整理：改标题、标已整理
	cl = mustCall(t, e.h, "PATCH", "/api/video/clips/"+clID, `{"triaged":true,"title":"v1.0.0 改过的标题"}`, 200)
	if cl["triaged"] != true || cl["title"] != "v1.0.0 改过的标题" {
		t.Fatalf("整理后：%v", cl)
	}
	// 转成选题，素材关联上
	res := mustCall(t, e.h, "POST", "/api/video/clips/"+clID+"/topic", `{}`, 201)
	tpID := res["topic"].(map[string]any)["id"].(string)
	// 再拉同仓库同 Release：不重复落，状态和改动都不冲掉
	code, out = call(t, e.h, "POST", "/api/video/clips/github", `{"repo":"foo/bar"}`)
	if code != 200 {
		t.Fatalf("第二次：%d %v", code, out)
	}
	meta := out["meta"].(map[string]any)
	if meta["added"] != 0.0 || meta["duplicates"] != 1.0 || meta["releases"] != 1.0 {
		t.Fatalf("第二次 meta：%v", meta)
	}
	if clips := listData(t, e, "/api/video/clips?kind=release"); len(clips) != 1 {
		t.Fatalf("去重后素材数：%d", len(clips))
	}
	got := mustCall(t, e.h, "GET", "/api/video/clips/"+clID, "", 200)
	if got["triaged"] != true || !reflect.DeepEqual(got["topic_ids"], []any{tpID}) ||
		got["title"] != "v1.0.0 改过的标题" || got["content"] != "第一版说明" || got["source"] != "GitHub · foo/bar" {
		t.Fatalf("去重冲掉了状态：%v", got)
	}
}
