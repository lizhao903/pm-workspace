package video

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
)

var perms = []string{"fs:read:project", "fs:write:project", "network:media-platforms"}

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "video" || m.TablePrefix != "video_" || !reflect.DeepEqual(m.Permissions, perms) {
		t.Fatalf("id=%s table_prefix=%s permissions=%v", m.ID, m.TablePrefix, m.Permissions)
	}
	if _, ok := m.Depends["projects"]; !ok || len(m.Depends) != 1 {
		t.Fatalf("depends=%v，要强依赖 projects", m.Depends)
	}
	if _, ok := m.OptionalDepends["im"]; !ok {
		t.Fatalf("optional_depends=%v，要弱依赖 im", m.OptionalDepends)
	}
	// 模块 key 和工作台目录（0023 的 ws_video）一致
	if !reflect.DeepEqual(m.Provides.Modules, []string{"videos"}) {
		t.Fatalf("provides.modules=%v", m.Provides.Modules)
	}
}

func TestMigrationsEmbedded(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 || New().Migrations() == nil {
		t.Fatalf("migrations/ 里有 %d 条迁移，Migrations() 不能是 nil", len(files))
	}
}

type env struct {
	r *plugin.Registry
	h http.Handler
	d *db.DB
}

// 在真库上装好、启用 projects 和 video，返回注册表、挂了插件路由的 handler 和库
func setup(t *testing.T) env {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	for _, p := range []plugin.Plugin{projects.New(), New()} {
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
	return env{r, mux, d}
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func data(out map[string]any) map[string]any { m, _ := out["data"].(map[string]any); return m }

func errMsg(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["message"].(string)
	return s
}

func mustCall(t *testing.T, h http.Handler, method, path, body string, want int) map[string]any {
	t.Helper()
	code, out := call(t, h, method, path, body)
	if code != want {
		t.Fatalf("%s %s：要 %d，实际 %d %v", method, path, want, code, out)
	}
	return data(out)
}

func addProject(t *testing.T, d *db.DB, id string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES (?, 'project', ?, '项目', ?, ?)`,
		id, "PRJ-"+id, now, now); err != nil {
		t.Fatal(err)
	}
}

func cpState(v map[string]any, stage string) map[string]any {
	for _, c := range v["checkpoints"].([]any) {
		if m := c.(map[string]any); m["stage"] == stage {
			return m
		}
	}
	return nil
}

// 原型 videodata.ts 里 Video、Series、Checkpoint、Publish、Metrics 的字段，Go 结构里都要有（多出的只能是时间）
func TestFieldsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "videodata.ts"))
	if err != nil {
		t.Skip("没有原型 videodata.ts：", err)
	}
	src := string(b)
	fieldRe := regexp.MustCompile(`(?m)^\s*(\w+)\??:`)
	for name, v := range map[string]any{"Video": Video{}, "Series": Series{}, "Publish": Publish{}, "Metrics": Metrics{}, "Checkpoint": Checkpoint{}} {
		var body string
		if i := strings.Index(src, "export interface "+name+" {"); i >= 0 {
			body = src[i+len("export interface "+name+" {"):]
			// 单行的 interface 在本行的 } 结束，多行的在行首的 } 结束
			if nl, end := strings.Index(body, "\n"), strings.Index(body, "}"); end < nl {
				body = body[:end]
			} else {
				body = body[:strings.Index(body, "\n}")]
			}
		} else {
			t.Fatalf("videodata.ts 里找不到 interface %s", name)
		}
		var proto []string
		if name == "Checkpoint" || name == "Metrics" {
			// 单行的 interface
			for _, f := range strings.Split(body, ";") {
				if k, _, ok := strings.Cut(strings.TrimSpace(f), ":"); ok {
					proto = append(proto, strings.TrimSuffix(k, "?"))
				}
			}
		} else {
			for _, m := range fieldRe.FindAllStringSubmatch(body, -1) {
				proto = append(proto, m[1])
			}
		}
		var tags []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
			tags = append(tags, tag)
		}
		if len(proto) == 0 {
			t.Fatalf("%s 一个字段都没解析出来", name)
		}
		for _, f := range proto {
			// runners、last_run 是原型为 VID-03（阶段执行器）新加的，后端还没跟上；VID-03 落地时删掉这个例外
			if !slices.Contains(tags, f) && !(name == "Video" && (f == "runners" || f == "last_run")) {
				t.Errorf("%s.%s 原型里有，Go 结构里没有", name, f)
			}
		}
		for _, f := range tags {
			if !slices.Contains(proto, f) && f != "created_at" && f != "updated_at" {
				t.Errorf("%s.%s Go 结构多出来的，原型里没有", name, f)
			}
		}
	}
}

// 原型种子数据的字段全部能存能读：vd1 这种全字段的视频、带 stale 的系列、四种状态的发布记录
func TestPrototypeFieldsRoundTrip(t *testing.T) {
	e := setup(t)
	addProject(t, e.d, "obj_pj")
	sr := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"一人之下 10 分钟上手","desc":"每集 10 分钟","intro":"shared/intro-v2.tsx","outro":"shared/outro.tsx","template":"templates/pmw-theme"}`, 201)
	srID := sr["id"].(string)
	if !strings.HasPrefix(srID, "sr_") || sr["desc"] != "每集 10 分钟" || sr["intro"] != "shared/intro-v2.tsx" || sr["outro"] != "shared/outro.tsx" ||
		sr["template"] != "templates/pmw-theme" || len(sr["stale"].([]any)) != 0 {
		t.Fatalf("系列：%v", sr)
	}
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 1 集：今日待办一页清","project_id":"obj_pj","series_id":"`+srID+
		`","episode":1,"orientations":["portrait","landscape","portrait"],"root":"videos/ep01-today","chapters":5}`, 201)
	vid := v["id"].(string)
	if !strings.HasPrefix(vid, "vd_") || v["project_id"] != "obj_pj" || v["series_id"] != srID || v["episode"] != 1.0 ||
		!reflect.DeepEqual(v["orientations"], []any{"landscape", "portrait"}) || v["stage"] != "script" || v["root"] != "videos/ep01-today" ||
		v["chapters"] != 5.0 || v["created_at"] == "" || v["updated_at"] == "" {
		t.Fatalf("视频：%v", v)
	}
	cps := v["checkpoints"].([]any)
	if len(cps) != 4 {
		t.Fatalf("检查点要 4 个：%v", cps)
	}
	for i, k := range []string{"plan", "ch1", "audio", "distribution"} {
		c := cps[i].(map[string]any)
		if c["stage"] != k || c["state"] != "pending" || c["at"] != nil || c["note"] != nil {
			t.Fatalf("检查点 %d：%v", i, c)
		}
	}
	// 走完整条流程：每个检查点都带上 at，通过时也能写意见
	path := "/api/video/videos/" + vid
	mustCall(t, e.h, "POST", path+"/advance", `{"from":"script"}`, 200)
	mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed","note":"比例定了"}`, 200)
	mustCall(t, e.h, "POST", path+"/advance", `{}`, 200)
	mustCall(t, e.h, "POST", path+"/checkpoints/ch1", `{"state":"passed"}`, 200)
	mustCall(t, e.h, "POST", path+"/advance", `{}`, 200)
	mustCall(t, e.h, "POST", path+"/checkpoints/audio", `{"state":"skipped"}`, 200)
	mustCall(t, e.h, "POST", path+"/advance", `{}`, 200)
	v = mustCall(t, e.h, "POST", path+"/checkpoints/distribution", `{"state":"passed"}`, 200)
	if v["stage"] != "distribution" {
		t.Fatalf("分发包通过后停在分发包：%v", v["stage"])
	}
	for _, k := range []string{"plan", "ch1", "audio", "distribution"} {
		c := cpState(v, k)
		if c["at"] == nil || (k == "audio") != (c["state"] == "skipped") {
			t.Fatalf("检查点 %s：%v", k, c)
		}
	}
	if cpState(v, "plan")["note"] != "比例定了" {
		t.Fatalf("意见没存：%v", cpState(v, "plan"))
	}
	if code, out := call(t, e.h, "POST", path+"/checkpoints/distribution", `{"state":"passed"}`); code != 409 {
		t.Fatalf("已完成再通过要 409：%d %v", code, out)
	}

	// 发布记录：原型 pb1（带数据）、pb3（失败）、pb4（定时）
	pb1 := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","cover_id":"af10",
		"title":"一人之下 10 分钟上手 01｜今日待办一页清","desc":"把散在各处的待办收到一页……","status":"published","published_at":"2026-10-23T08:00:00.123Z",
		"url":"https://www.bilibili.com/video/BV1xx","metrics":{"views":12840,"likes":931,"comments":87,"shares":64,"updated_at":"2026-10-29T03:00:00Z"}}`, 201)
	if !strings.HasPrefix(pb1["id"].(string), "pb_") || pb1["video_id"] != vid || pb1["platform"] != "bilibili" || pb1["variant"] != "landscape" ||
		pb1["cover_id"] != "af10" || pb1["desc"] != "把散在各处的待办收到一页……" || pb1["status"] != "published" ||
		pb1["published_at"] != "2026-10-23T08:00:00Z" || pb1["url"] != "https://www.bilibili.com/video/BV1xx" {
		t.Fatalf("pb1：%v", pb1)
	}
	if m := pb1["metrics"].(map[string]any); m["views"] != 12840.0 || m["likes"] != 931.0 || m["comments"] != 87.0 || m["shares"] != 64.0 || m["updated_at"] != "2026-10-29T03:00:00Z" {
		t.Fatalf("metrics：%v", m)
	}
	pb3 := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"douyin","variant":"portrait","title":"今日待办一页清","desc":"","status":"failed","error":"封面尺寸不符合要求（需要 3:4）"}`, 201)
	if pb3["error"] != "封面尺寸不符合要求（需要 3:4）" || pb3["cover_id"] != nil || pb3["metrics"] != nil {
		t.Fatalf("pb3：%v", pb3)
	}
	pb4 := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"youtube","variant":"landscape","title":"One Page for Today","status":"scheduled","scheduled_at":"2026-11-01T10:00:00+08:00"}`, 201)
	if pb4["scheduled_at"] != "2026-11-01T02:00:00Z" {
		t.Fatalf("pb4：%v", pb4)
	}
	// 读回来一致；按视频筛
	code, out := call(t, e.h, "GET", "/api/video/publishes?video_id="+vid, "")
	if code != 200 || len(out["data"].([]any)) != 3 {
		t.Fatalf("列表：%d %v", code, out)
	}
	if got := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb1["id"].(string), "", 200); !reflect.DeepEqual(got, pb1) {
		t.Fatalf("读回来不一致：\n%v\n%v", got, pb1)
	}
	// 回填链接、清掉错误、改状态
	pb3 = mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb3["id"].(string), `{"status":"published","error":null,"url":"https://www.douyin.com/video/1"}`, 200)
	if pb3["error"] != nil || pb3["status"] != "published" {
		t.Fatalf("改发布记录：%v", pb3)
	}

	// 系列 stale：勾选的集标待同步，读系列能看到
	v2 := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 2 集","series_id":"`+srID+`","episode":2}`, 201)
	sr = mustCall(t, e.h, "PATCH", "/api/video/series/"+srID, `{"intro":"shared/intro-v3.tsx","stale":["`+v2["id"].(string)+`","`+vid+`"]}`, 200)
	if !reflect.DeepEqual(sr["stale"], []any{vid, v2["id"]}) || sr["intro"] != "shared/intro-v3.tsx" {
		t.Fatalf("stale 要按集数排：%v", sr)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/series/"+srID, `{"stale":["vd_nope"]}`); code != 400 {
		t.Fatalf("不是本系列的集要 400：%d %v", code, out)
	}
	// 标已同步
	sr = mustCall(t, e.h, "PATCH", "/api/video/series/"+srID, `{"stale":["`+v2["id"].(string)+`"]}`, 200)
	if !reflect.DeepEqual(sr["stale"], []any{v2["id"]}) {
		t.Fatalf("标已同步：%v", sr["stale"])
	}
	// 移出系列，待同步跟着没了
	if got := mustCall(t, e.h, "PATCH", "/api/video/videos/"+v2["id"].(string), `{"series_id":null}`, 200); got["series_id"] != nil || got["episode"] != nil {
		t.Fatalf("移出系列要清掉系列和集数：%v", got)
	}
	if sr = mustCall(t, e.h, "GET", "/api/video/series/"+srID, "", 200); len(sr["stale"].([]any)) != 0 {
		t.Fatalf("移出系列后 stale：%v", sr["stale"])
	}
	// 删系列：各集变回单集
	mustCall(t, e.h, "PATCH", "/api/video/videos/"+v2["id"].(string), `{"series_id":"`+srID+`","episode":2}`, 200)
	mustCall(t, e.h, "PATCH", "/api/video/series/"+srID, `{"stale":["`+v2["id"].(string)+`"]}`, 200)
	mustCall(t, e.h, "DELETE", "/api/video/series/"+srID, "", 200)
	if got := mustCall(t, e.h, "GET", "/api/video/videos/"+v2["id"].(string), "", 200); got["series_id"] != nil || got["episode"] != nil {
		t.Fatalf("删系列后要变回单集：%v", got)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/series/"+srID, ""); code != 404 {
		t.Fatalf("删掉的系列要 404：%d", code)
	}
	// 删视频，发布记录跟着删
	mustCall(t, e.h, "DELETE", path, "", 200)
	if code, out := call(t, e.h, "GET", "/api/video/publishes?video_id="+vid, ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("删视频后发布记录：%v", out)
	}
}

func TestCheckpointRules(t *testing.T) {
	e := setup(t)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"t"}`, 201)
	path := "/api/video/videos/" + v["id"].(string)
	// 不是当前阶段的检查点 409
	if code, _ := call(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`); code != 409 {
		t.Fatalf("不是当前阶段要 409：%d", code)
	}
	mustCall(t, e.h, "POST", path+"/advance", `{}`, 200)
	// 检查点阶段不能 advance
	if code, _ := call(t, e.h, "POST", path+"/advance", `{}`); code != 409 {
		t.Fatalf("检查点阶段 advance 要 409：%d", code)
	}
	// from 和当前阶段不一致 409
	if code, _ := call(t, e.h, "POST", path+"/advance", `{"from":"script"}`); code != 409 {
		t.Fatalf("from 过期要 409：%d", code)
	}
	// 退回不写意见 400
	for _, body := range []string{`{"state":"rejected"}`, `{"state":"rejected","note":"  "}`} {
		code, out := call(t, e.h, "POST", path+"/checkpoints/plan", body)
		if code != 400 || errMsg(out) != "退回要写意见" {
			t.Fatalf("退回不写意见要 400：%d %v", code, out)
		}
	}
	// 只有音频能跳过；不是检查点的阶段 400；不认的状态 400
	for _, c := range []struct{ path, body string }{
		{"/checkpoints/plan", `{"state":"skipped"}`},
		{"/checkpoints/web", `{"state":"passed"}`},
		{"/checkpoints/plan", `{"state":"pending"}`},
		{"/checkpoints/plan", `{"state":"passed","x":1}`},
	} {
		if code, out := call(t, e.h, "POST", path+c.path, c.body); code != 400 {
			t.Fatalf("%s %s 要 400：%d %v", c.path, c.body, code, out)
		}
	}
	// 没选比例不能通过规划检查
	if code, out := call(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`); code != 400 {
		t.Fatalf("没选比例要 400：%d %v", code, out)
	}
	// 退回停在原地，带意见
	got := mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"rejected","note":"比例再想想"}`, 200)
	if got["stage"] != "plan" || cpState(got, "plan")["state"] != "rejected" || cpState(got, "plan")["note"] != "比例再想想" {
		t.Fatalf("退回：%v", got)
	}
	// 退回后还能改比例，再通过
	mustCall(t, e.h, "PATCH", path, `{"orientations":["landscape"]}`, 200)
	got = mustCall(t, e.h, "POST", path+"/checkpoints/plan", `{"state":"passed"}`, 200)
	if got["stage"] != "web" || cpState(got, "plan")["state"] != "passed" || cpState(got, "plan")["note"] != nil {
		t.Fatalf("通过：%v", got)
	}
	// 规划检查通过后改比例 409；传同样的值不算改
	code, out := call(t, e.h, "PATCH", path, `{"orientations":["landscape","square"]}`)
	if code != 409 || !strings.Contains(errMsg(out), "锁定") {
		t.Fatalf("锁定后改比例要 409：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", path, `{"orientations":["landscape"],"title":"t2","chapters":3}`, 200)
	// 阶段、检查点不能直接改
	for _, body := range []string{`{"stage":"record"}`, `{"checkpoints":[]}`} {
		if code, _ := call(t, e.h, "PATCH", path, body); code != 400 {
			t.Fatalf("%s 要 400：%d", body, code)
		}
	}
}

func TestVideoValidation(t *testing.T) {
	e := setup(t)
	addProject(t, e.d, "obj_pj")
	if _, err := e.d.W.Exec(`UPDATE objects SET deleted_at = '2026-10-29T00:00:00Z' WHERE id = 'obj_pj'`); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"project_id":"obj_nope"}`,
		`{"project_id":"obj_pj"}`,
		`{"series_id":"sr_nope"}`,
		`{"episode":0}`,
		`{"orientations":["wide"]}`,
		`{"chapters":-1}`,
		`{"stage":"web"}`,
		`[]`,
	} {
		if code, out := call(t, e.h, "POST", "/api/video/videos", body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body, code, out)
		}
	}
	for _, body := range []string{`{}`, `{"name":"  "}`} {
		if code, _ := call(t, e.h, "POST", "/api/video/series", body); code != 400 {
			t.Fatalf("系列 %s 要 400：%d", body, code)
		}
	}
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{}`, 201)
	for _, body := range []string{
		`{"platform":"bilibili","variant":"landscape","title":"x"}`,
		`{"video_id":"` + v["id"].(string) + `","platform":"tiktok","variant":"landscape","title":"x"}`,
		`{"video_id":"` + v["id"].(string) + `","platform":"bilibili","variant":"landscape","title":""}`,
		`{"video_id":"` + v["id"].(string) + `","platform":"bilibili","variant":"landscape","title":"x","status":"scheduled"}`,
		`{"video_id":"` + v["id"].(string) + `","platform":"bilibili","variant":"landscape","title":"x","url":"ftp://a"}`,
		`{"video_id":"` + v["id"].(string) + `","platform":"bilibili","variant":"landscape","title":"x","metrics":{"views":-1,"updated_at":"2026-10-29T00:00:00Z"}}`,
		`{"video_id":"vd_nope","platform":"bilibili","variant":"landscape","title":"x"}`,
	} {
		if code, out := call(t, e.h, "POST", "/api/video/publishes", body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body, code, out)
		}
	}
	for _, p := range []string{"/api/video/videos/vd_nope", "/api/video/series/sr_nope", "/api/video/publishes/pb_nope"} {
		if code, _ := call(t, e.h, "GET", p, ""); code != 404 {
			t.Fatalf("%s 要 404：%d", p, code)
		}
	}
}

// 停用后接口 404，再启用数据还在；停用 projects 时报出 video 跟着要停
func TestDisableKeepsData(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"留着"}`, 201)
	err := e.r.Disable(ctx, "projects")
	var de *plugin.DependentsError
	if !errors.As(err, &de) || !slices.Contains(de.Dependents, "video") {
		t.Fatalf("停用 projects 要报出 video：%v", err)
	}
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/api/video/videos", "/api/video/series", "/api/video/publishes", "/api/video/artifacts", "/api/video/videos/" + v["id"].(string)} {
		if code, _ := call(t, e.h, "GET", p, ""); code != 404 {
			t.Fatalf("停用后 %s 要 404，实际 %d", p, code)
		}
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if got := mustCall(t, e.h, "GET", "/api/video/videos/"+v["id"].(string), "", 200); got["title"] != "留着" {
		t.Fatalf("启用后数据：%v", got)
	}
}
