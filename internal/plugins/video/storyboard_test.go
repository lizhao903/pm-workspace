// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
)

// setupPerms 同 setup，但视频插件只确认了 ps 这几项权限（模拟升级后新权限还没确认：先全装上，改状态表，再起一个注册表）；
// dataDir 不为空时接上数据目录（缩略图缓存在它下面）。
func setupPerms(t *testing.T, ps []string, dataDir string) env {
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
	start := func() *plugin.Registry {
		r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
		r.Migrations = plugin.NewSQLMigrationStore(d)
		r.DataDir = dataDir
		for _, p := range []plugin.Plugin{projects.New(), New()} {
			if err := r.Add(p); err != nil {
				t.Fatal(err)
			}
		}
		if err := r.Start(ctx); err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := start()
	for _, id := range []string{"projects", "video"} {
		pp := perms
		if id == "projects" {
			pp = []string{"process:spawn"}
		}
		if err := r.Install(ctx, id, pp); err != nil {
			t.Fatal(err)
		}
		if err := r.Enable(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(ps, perms) {
		r.Close()
		b, _ := json.Marshal(ps)
		if _, err := d.W.Exec(`UPDATE plugins SET permissions = ? WHERE id = 'video'`, string(b)); err != nil {
			t.Fatal(err)
		}
		r = start()
	}
	t.Cleanup(r.Close)
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return env{r, mux, d}
}

// list 调接口，要 want，回 data 数组。
func list(t *testing.T, h http.Handler, method, path, body string, want int) []any {
	t.Helper()
	code, out := call(t, h, method, path, body)
	if code != want {
		t.Fatalf("%s %s：要 %d，实际 %d %v", method, path, want, code, out)
	}
	xs, _ := out["data"].([]any)
	return xs
}

func obj(x any) map[string]any { m, _ := x.(map[string]any); return m }

func writePNG(t *testing.T, p string, w, h int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, x%h, color.RGBA{200, 80, 40, 255})
	}
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
}

// writeVideo 有 ffmpeg 时生成一段 2 秒 320x180 的 mp4，没有时写几个字节（取不到元数据，照样能列出来）。
func writeVideo(t *testing.T, p string) bool {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if bin := findTool("ffmpeg"); bin != "" {
		if err := exec.Command(bin, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=10",
			"-pix_fmt", "yuv420p", p).Run(); err == nil {
			return true
		}
	}
	if err := os.WriteFile(p, []byte("not really a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	return false
}

func TestShotsFromText(t *testing.T) {
	cases := []struct {
		in   string
		want []shotDraft
	}{
		{"## 开场\n大家好，今天讲本地大模型。\n\n## 第一部分\n- 为什么要本地跑\n- 要什么配置\n", []shotDraft{
			{Text: "大家好，今天讲本地大模型。", Visual: "开场"}, {Text: "为什么要本地跑\n要什么配置", Visual: "第一部分"}}},
		// 只有一个总标题、下面没正文的跳过；最后一个标题没正文的留着（画面说明是标题）
		{"# 本地跑大模型\n\n## 第 1 章 硬件\n- 显卡\n## 结尾\n", []shotDraft{{Text: "显卡", Visual: "第 1 章 硬件"}, {Visual: "结尾"}}},
		{"第一段口播。\n还是第一段。\n\n\n第二段口播。\n", []shotDraft{{Text: "第一段口播。\n还是第一段。"}, {Text: "第二段口播。"}}},
		{"开头没标题的一段\n\n## 正文\n内容", []shotDraft{{Text: "开头没标题的一段"}, {Text: "内容", Visual: "正文"}}},
		{"```\n## 代码里的不算标题\n```\n", []shotDraft{{Text: "## 代码里的不算标题"}}},
		{"   \n\n", []shotDraft{}},
	}
	for _, c := range cases {
		got := shotsFromText(c.in)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q：\n要 %#v\n实际 %#v", c.in, c.want, got)
		}
	}
	if n := estSeconds(strings.Repeat("字", 240)); n != 60 {
		t.Fatalf("240 字要估 60 秒：%d", n)
	}
	if n := estSeconds("hi"); n != 1 {
		t.Fatalf("有字至少 1 秒：%d", n)
	}
}

// 验收：分镜增删、插入、排序、编辑，序号连续，刷新（重新读）不丢
func TestStoryboardCRUD(t *testing.T) {
	e := setup(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"分镜"}`, 201)["id"].(string)
	base := "/api/video/videos/" + vid + "/shots"
	if xs := list(t, e.h, "GET", base, "", 200); len(xs) != 0 {
		t.Fatalf("新视频没有分镜：%v", xs)
	}
	xs := list(t, e.h, "POST", base, `{"text":"`+strings.Repeat("字", 120)+`","visual":"开场空镜"}`, 201)
	a := obj(xs[0])
	if a["no"] != 1.0 || a["est"] != 30.0 || a["duration"] != nil || a["visual"] != "开场空镜" || len(a["brolls"].([]any)) != 0 {
		t.Fatalf("第一个分镜：%v", a)
	}
	list(t, e.h, "POST", base, `{"text":"第三"}`, 201)
	xs = list(t, e.h, "POST", base, `{"text":"第二","position":2}`, 201)
	texts := func(xs []any) []string {
		var out []string
		for _, x := range xs {
			out = append(out, obj(x)["text"].(string))
		}
		return out
	}
	if got := texts(xs)[1:]; !reflect.DeepEqual(got, []string{"第二", "第三"}) {
		t.Fatalf("插到第 2 个：%v", texts(xs))
	}
	for body, want := range map[string]int{`{"position":9}`: 400, `{"duration":0}`: 400, `{"duration":"5"}`: 400, `{"x":1}`: 400, `{"visual":1}`: 400} {
		if code, out := call(t, e.h, "POST", base, body); code != want {
			t.Fatalf("%s 要 %d：%d %v", body, want, code, out)
		}
	}
	b := obj(xs[1])["id"].(string)
	xs = list(t, e.h, "PATCH", "/api/video/shots/"+b, `{"duration":12,"visual":"屏幕录制"}`, 200)
	if s := obj(xs[1]); s["duration"] != 12.0 || s["visual"] != "屏幕录制" || s["text"] != "第二" {
		t.Fatalf("改时长、画面：%v", s)
	}
	xs = list(t, e.h, "PATCH", "/api/video/shots/"+b, `{"duration":null}`, 200)
	if obj(xs[1])["duration"] != nil {
		t.Fatalf("时长传 null 回到估算：%v", xs[1])
	}
	if code, _ := call(t, e.h, "PATCH", "/api/video/shots/vsh_nope", `{"text":"x"}`); code != 404 {
		t.Fatalf("不存在的分镜 404：%d", code)
	}
	ids := []string{obj(xs[2])["id"].(string), obj(xs[0])["id"].(string), b}
	for _, body := range []string{`{"ids":["` + ids[0] + `"]}`, `{"ids":["` + ids[0] + `","` + ids[0] + `","` + b + `"]}`, `{"ids":"x"}`} {
		if code, out := call(t, e.h, "POST", base+"/reorder", body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body, code, out)
		}
	}
	jb, _ := json.Marshal(map[string]any{"ids": ids})
	xs = list(t, e.h, "POST", base+"/reorder", string(jb), 200)
	if got := texts(xs); got[0] != "第三" || got[2] != "第二" || obj(xs[2])["no"] != 3.0 {
		t.Fatalf("拖动排序：%v", got)
	}
	xs = list(t, e.h, "DELETE", "/api/video/shots/"+ids[1], "", 200)
	if len(xs) != 2 || obj(xs[1])["no"] != 2.0 || obj(xs[1])["id"] != b {
		t.Fatalf("删掉中间的，序号重排：%v", xs)
	}
	if xs = list(t, e.h, "GET", base, "", 200); len(xs) != 2 {
		t.Fatalf("重新读：%v", xs)
	}
	// 删视频连分镜一起删
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+vid, "", 200)
	var n int
	if err := e.d.W.QueryRow(`SELECT COUNT(*) FROM video_shots`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("删视频后分镜还剩 %d %v", n, err)
	}
}

// 验收：从口播稿（没有用大纲）一键生成；已有分镜时要选追加或覆盖
func TestGenerateShots(t *testing.T) {
	e := setup(t)
	root := t.TempDir()
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"生成","orientations":["portrait"],"root":"`+root+`"}`, 201)["id"].(string)
	gen := "/api/video/videos/" + vid + "/shots/generate"
	if code, out := call(t, e.h, "POST", gen, `{}`); code != 400 || !strings.Contains(errMsg(out), "还没有写好的口播稿和大纲") {
		t.Fatalf("没稿子 400：%d %v", code, out)
	}
	ol := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"outline","variant":"portrait","path":"outline.md"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", "/api/video/artifacts/"+ol+"/content", `{"content":"# 总标题\n## 第 1 章\n- 要点"}`, 200)
	res := mustCall(t, e.h, "POST", gen, `{}`, 200)
	if src := obj(res["source"]); src["kind"] != "outline" || len(res["shots"].([]any)) != 1 {
		t.Fatalf("没口播稿用大纲：%v", res)
	}
	sc := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"script","variant":"portrait","path":"script.md"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", "/api/video/artifacts/"+sc+"/content", `{"content":"## 开场\n一句话开场\n## 正文\n第二屏\n## 结尾\n关注"}`, 200)
	if code, out := call(t, e.h, "POST", gen, `{}`); code != 409 || errMsg(out) != "已经有 1 个分镜，选追加还是覆盖" {
		t.Fatalf("已有分镜不选方式 409：%d %v", code, out)
	}
	for _, body := range []string{`{"mode":"merge"}`, `{"source":"article"}`, `{"variant":"wide"}`} {
		if code, out := call(t, e.h, "POST", gen, body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body, code, out)
		}
	}
	res = mustCall(t, e.h, "POST", gen, `{"mode":"append"}`, 200)
	shots := res["shots"].([]any)
	if len(shots) != 4 || res["added"] != 3.0 || obj(res["source"])["kind"] != "script" || obj(shots[1])["visual"] != "开场" || obj(shots[3])["no"] != 4.0 {
		t.Fatalf("追加：%v", res)
	}
	// 覆盖时旧分镜的 B-roll 一起删
	media := t.TempDir()
	writePNG(t, filepath.Join(media, "a.png"), 8, 4)
	rid := mustCall(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+media+`"}`, 201)["id"].(string)
	list(t, e.h, "POST", "/api/video/shots/"+obj(shots[0])["id"].(string)+"/brolls", `{"items":[{"root_id":"`+rid+`","path":"a.png"}]}`, 200)
	res = mustCall(t, e.h, "POST", gen, `{"mode":"replace"}`, 200)
	shots = res["shots"].([]any)
	if len(shots) != 3 || obj(shots[0])["no"] != 1.0 || obj(shots[2])["no"] != 3.0 || obj(shots[0])["text"] != "一句话开场" {
		t.Fatalf("覆盖：%v", shots)
	}
	var n int
	if err := e.d.W.QueryRow(`SELECT COUNT(*) FROM video_shot_brolls`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("覆盖后旧 B-roll 要删掉：%d %v", n, err)
	}
	res = mustCall(t, e.h, "POST", gen, `{"mode":"replace","source":"outline"}`, 200)
	if obj(res["source"])["kind"] != "outline" || len(res["shots"].([]any)) != 1 {
		t.Fatalf("指定大纲：%v", res)
	}
}

// 素材目录登记的校验和权限
func TestMediaRoots(t *testing.T) {
	e := setup(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "f.png")
	writePNG(t, file, 2, 2)
	for body, want := range map[string]int{
		`{}`: 400, `{"path":"relative/dir"}`: 400, `{"path":"/"}`: 400, `{"path":"/etc"}`: 400, `{"path":"/usr/bin"}`: 400,
		`{"path":"` + dir + `/nope"}`: 400, `{"path":"` + file + `"}`: 400, `{"path":"` + dir + `","x":1}`: 400,
	} {
		if code, out := call(t, e.h, "POST", "/api/video/media/roots", body); code != want {
			t.Fatalf("%s 要 %d：%d %v", body, want, code, out)
		}
	}
	hidden := filepath.Join(dir, ".secret")
	if err := os.Mkdir(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+hidden+`"}`); code != 400 {
		t.Fatalf("隐藏目录不能登记：%d %v", code, out)
	}
	r := mustCall(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+dir+`/"}`, 201)
	if r["name"] != filepath.Base(dir) || r["path"] != dir || r["available"] != true || r["builtin"] != false {
		t.Fatalf("登记：%v", r)
	}
	if code, out := call(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+dir+`"}`); code != 409 {
		t.Fatalf("重复登记 409：%d %v", code, out)
	}
	rid := r["id"].(string)
	if got := mustCall(t, e.h, "PATCH", "/api/video/media/roots/"+rid, `{"name":"素材库"}`, 200); got["name"] != "素材库" {
		t.Fatalf("改名：%v", got)
	}
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x"}`, 201)["id"].(string)
	xs := list(t, e.h, "GET", "/api/video/media/roots?video_id="+vid, "", 200)
	if len(xs) != 2 || obj(xs[0])["id"] != "project" || obj(xs[0])["available"] != false || obj(xs[0])["reason"] == "" || obj(xs[1])["id"] != rid {
		t.Fatalf("带视频时工程目录排第一（还没填，不可用）：%v", xs)
	}
	if xs := list(t, e.h, "GET", "/api/video/media/roots", "", 200); len(xs) != 1 {
		t.Fatalf("不带视频只有登记的：%v", xs)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/video/media/roots/project", ""); code != 400 {
		t.Fatalf("工程目录不能移除：%d", code)
	}
	mustCall(t, e.h, "DELETE", "/api/video/media/roots/"+rid, "", 200)
	if code, _ := call(t, e.h, "DELETE", "/api/video/media/roots/"+rid, ""); code != 404 {
		t.Fatalf("再删 404：%d", code)
	}

	// 没确认 fs:read:registered：不能登记，已登记的不可用
	e2 := setupPerms(t, []string{"fs:read:project", "fs:write:project", "network:media-platforms", "process:spawn"}, "")
	if code, out := call(t, e2.h, "POST", "/api/video/media/roots", `{"path":"`+dir+`"}`); code != 409 || !strings.Contains(errMsg(out), "fs:read:registered") {
		t.Fatalf("没确认权限 409：%d %v", code, out)
	}
	if _, err := e2.d.W.Exec(`INSERT INTO video_media_roots (id, name, path, created_at) VALUES ('vmr_x', 'x', ?, '2026-11-05T00:00:00Z')`, dir); err != nil {
		t.Fatal(err)
	}
	if xs := list(t, e2.h, "GET", "/api/video/media/roots", "", 200); obj(xs[0])["available"] != false {
		t.Fatalf("没权限不可用：%v", xs)
	}
	if code, out := call(t, e2.h, "GET", "/api/video/media/browse?root=vmr_x", ""); code != 400 || !strings.Contains(errMsg(out), "fs:read:registered") {
		t.Fatalf("没权限不能浏览：%d %v", code, out)
	}
}

// 验收：浏览图片、视频，子目录、类型筛选、搜索、分页；只读不改原文件
func TestBrowseMedia(t *testing.T) {
	dd := t.TempDir()
	e := setupPerms(t, perms, dd)
	dir := t.TempDir()
	writePNG(t, filepath.Join(dir, "b-cover.png"), 64, 32)
	writePNG(t, filepath.Join(dir, "a-shot.png"), 10, 10)
	realVideo := writeVideo(t, filepath.Join(dir, "clip.mp4"))
	writePNG(t, filepath.Join(dir, "sub", "deep-shot.png"), 4, 4)
	writePNG(t, filepath.Join(dir, ".hidden", "x.png"), 4, 4)
	writePNG(t, filepath.Join(dir, ".dot.png"), 4, 4)
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := snapshotDir(t, dir)
	rid := mustCall(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+dir+`"}`, 201)["id"].(string)
	browse := "/api/video/media/browse?root=" + rid
	code, out := call(t, e.h, "GET", browse, "")
	if code != 200 {
		t.Fatalf("浏览：%d %v", code, out)
	}
	l := data(out)
	files := l["files"].([]any)
	if l["dir"] != "" || l["parent"] != nil || len(l["dirs"].([]any)) != 1 || obj(l["dirs"].([]any)[0])["path"] != "sub" || len(files) != 3 {
		t.Fatalf("根目录：%v", l)
	}
	if f := obj(files[0]); f["name"] != "a-shot.png" || f["kind"] != "image" || f["width"] != 10.0 || f["height"] != 10.0 || f["size"].(float64) <= 0 || f["modified_at"] == "" {
		t.Fatalf("图片信息：%v", f)
	}
	v := obj(files[2])
	if v["kind"] != "video" {
		t.Fatalf("视频：%v", v)
	}
	tools := obj(l["tools"])
	if realVideo && tools["probe"] == true && (v["duration"] == nil || v["width"] != 320.0 || v["height"] != 180.0) {
		t.Fatalf("有 ffprobe 时要有时长、尺寸：%v", v)
	}
	if out["meta"].(map[string]any)["total"] != 3.0 {
		t.Fatalf("meta：%v", out["meta"])
	}
	if l := data(mustGet(t, e.h, browse+"&type=video")); len(l["files"].([]any)) != 1 {
		t.Fatalf("只看视频：%v", l)
	}
	if l := data(mustGet(t, e.h, browse+"&dir=sub")); *strPtr(l["parent"]) != "" || obj(l["files"].([]any)[0])["path"] != "sub/deep-shot.png" {
		t.Fatalf("进子目录：%v", l)
	}
	l = data(mustGet(t, e.h, browse+"&q=SHOT"))
	if fs := l["files"].([]any); len(fs) != 2 || obj(fs[1])["path"] != "sub/deep-shot.png" || len(l["dirs"].([]any)) != 0 {
		t.Fatalf("按文件名搜（含子目录，不分大小写，不搜隐藏的）：%v", l)
	}
	o := mustGet(t, e.h, browse+"&page=2&page_size=2")
	if fs := data(o)["files"].([]any); len(fs) != 1 || obj(fs[0])["name"] != "clip.mp4" || o["meta"].(map[string]any)["page"] != 2.0 {
		t.Fatalf("分页：%v", o)
	}
	for _, q := range []string{"&type=doc", "&page=0", "&page_size=x"} {
		if code, out := call(t, e.h, "GET", browse+q, ""); code != 400 {
			t.Fatalf("%s 要 400：%d %v", q, code, out)
		}
	}
	// 预览原图、视频 Range
	req := httptest.NewRequest("GET", "/api/video/media/file?root="+rid+"&path=clip.mp4", nil)
	req.Header.Set("Range", "bytes=0-3")
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	if w.Code != 206 || w.Body.Len() != 4 || w.Header().Get("Content-Type") != "video/mp4" || w.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("视频 Range：%d %v %d", w.Code, w.Header(), w.Body.Len())
	}
	w = httptest.NewRecorder()
	e.h.ServeHTTP(w, httptest.NewRequest("GET", "/api/video/media/file?root="+rid+"&path=a-shot.png", nil))
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("原图：%d %v", w.Code, w.Header())
	}
	if code, _ := call(t, e.h, "GET", "/api/video/media/file?root="+rid+"&path=notes.txt", ""); code != 400 {
		t.Fatalf("不是图片视频 400：%d", code)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/media/file?root="+rid+"&path=gone.png", ""); code != 404 {
		t.Fatalf("不存在 404：%d", code)
	}
	// 缩略图：有 ffmpeg 时生成 JPEG 缓存在插件缓存目录，第二次直接读缓存
	if tools["thumbs"] == true {
		for _, p := range []string{"b-cover.png", "clip.mp4"} {
			w = httptest.NewRecorder()
			e.h.ServeHTTP(w, httptest.NewRequest("GET", "/api/video/media/thumb?root="+rid+"&path="+p, nil))
			if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" || w.Body.Len() == 0 {
				t.Fatalf("%s 缩略图：%d %v %s", p, w.Code, w.Header(), w.Body.String())
			}
			if cfg, _, err := image.DecodeConfig(w.Body); err != nil || max(cfg.Width, cfg.Height) > 320 {
				t.Fatalf("%s 缩略图要是最长边不过 320 的 JPEG：%v %v", p, cfg, err)
			}
		}
		thumbs, _ := filepath.Glob(filepath.Join(dd, "cache", "video", "thumbs", "*", "*.jpg"))
		if len(thumbs) != 2 {
			t.Fatalf("缩略图要缓存在插件缓存目录：%v", thumbs)
		}
	}
	if after := snapshotDir(t, dir); !reflect.DeepEqual(before, after) {
		t.Fatalf("浏览、预览、缩略图不能改素材目录：\n前 %v\n后 %v", before, after)
	}
}

func mustGet(t *testing.T, h http.Handler, path string) map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", path, "")
	if code != 200 {
		t.Fatalf("GET %s：%d %v", path, code, out)
	}
	return out
}

func strPtr(x any) *string {
	s, ok := x.(string)
	if !ok {
		return nil
	}
	return &s
}

// snapshotDir 记下目录里每个文件的大小和修改时间，看有没有被改。
func snapshotDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err == nil {
			out[p] = fmt.Sprintf("%s/%s/%d", fi.ModTime(), fi.Mode(), fi.Size())
		}
		return nil
	})
	return out
}

// 验收：素材目录外的路径一律拒绝（../ 穿越、绝对路径、反斜杠、隐藏项、指到外面的符号链接）
func TestMediaPathSafety(t *testing.T) {
	e := setup(t)
	outside := t.TempDir()
	writePNG(t, filepath.Join(outside, "secret.png"), 2, 2)
	dir := t.TempDir()
	writePNG(t, filepath.Join(dir, "ok.png"), 2, 2)
	writePNG(t, filepath.Join(dir, "sub", "in.png"), 2, 2)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(dir, "leak.png")))
	must(os.Symlink(outside, filepath.Join(dir, "leakdir")))
	must(os.Symlink(filepath.Join(dir, "sub", "in.png"), filepath.Join(dir, "inner.png"))) // 根里的链接可以
	rid := mustCall(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+dir+`"}`, 201)["id"].(string)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x"}`, 201)["id"].(string)
	shot := obj(list(t, e.h, "POST", "/api/video/videos/"+vid+"/shots", `{}`, 201)[0])["id"].(string)

	bad := []string{"../" + filepath.Base(outside) + "/secret.png", "sub/../../x.png", "..", "/etc/hosts", outside + "/secret.png", "sub\\in.png",
		"~/x.png", ".hidden.png", "sub/./../../secret.png", "leak.png", "leakdir/secret.png", "C:/x.png"}
	for _, p := range bad {
		q := "root=" + rid + "&path=" + urlq(p)
		for _, ep := range []string{"/api/video/media/file?", "/api/video/media/thumb?"} {
			if code, out := call(t, e.h, "GET", ep+q, ""); code != 400 {
				t.Fatalf("%s%s 要 400：%d %v", ep, p, code, out)
			}
		}
		body, _ := json.Marshal(map[string]any{"items": []any{map[string]string{"root_id": rid, "path": p}}})
		if code, out := call(t, e.h, "POST", "/api/video/shots/"+shot+"/brolls", string(body)); code != 400 {
			t.Fatalf("加 B-roll %s 要 400：%d %v", p, code, out)
		}
	}
	for _, d := range []string{"..", "../" + filepath.Base(outside), "leakdir", "/tmp", "sub/../.."} {
		if code, out := call(t, e.h, "GET", "/api/video/media/browse?root="+rid+"&dir="+urlq(d), ""); code != 400 {
			t.Fatalf("浏览 %s 要 400：%d %v", d, code, out)
		}
	}
	// 列目录不列指到外面的链接，根里的链接照常
	l := data(mustGet(t, e.h, "/api/video/media/browse?root="+rid))
	var names []string
	for _, f := range l["files"].([]any) {
		names = append(names, obj(f)["name"].(string))
	}
	for _, d := range l["dirs"].([]any) {
		names = append(names, obj(d)["name"].(string))
	}
	if !reflect.DeepEqual(names, []string{"inner.png", "ok.png", "sub"}) {
		t.Fatalf("列目录：%v", names)
	}
	if l := data(mustGet(t, e.h, "/api/video/media/browse?root="+rid+"&q=secret")); len(l["files"].([]any)) != 0 {
		t.Fatalf("搜索不能顺着链接出去：%v", l)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/media/file?root="+rid+"&path=inner.png", ""); code != 200 {
		t.Fatalf("根里的链接能读：%d", code)
	}
	// 工程目录：要带视频，视频没填工程目录时不可用
	for _, q := range []string{"root=project", "root=project&video_id=" + vid, "root=", "root=vmr_nope"} {
		if code, out := call(t, e.h, "GET", "/api/video/media/browse?"+q, ""); code != 400 && code != 404 {
			t.Fatalf("%s 要拒绝：%d %v", q, code, out)
		}
	}
}

func urlq(s string) string {
	r := strings.NewReplacer("%", "%25", "&", "%26", "+", "%2B", "#", "%23", " ", "%20", "\\", "%5C", "?", "%3F")
	return r.Replace(s)
}

// 验收：多选加进分镜，排序、备注、入出点，挪到别的分镜，文件没了标缺失不报错；工程目录默认就能用
func TestBrolls(t *testing.T) {
	e := setup(t)
	root := t.TempDir()
	writePNG(t, filepath.Join(root, "assets", "logo.png"), 4, 4)
	media := t.TempDir()
	writePNG(t, filepath.Join(media, "a.png"), 4, 4)
	writePNG(t, filepath.Join(media, "b.png"), 4, 4)
	writeVideo(t, filepath.Join(media, "c.mp4"))
	rid := mustCall(t, e.h, "POST", "/api/video/media/roots", `{"path":"`+media+`"}`, 201)["id"].(string)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"x","root":"`+root+`"}`, 201)["id"].(string)
	xs := list(t, e.h, "GET", "/api/video/media/roots?video_id="+vid, "", 200)
	if p := obj(xs[0]); p["id"] != "project" || p["available"] != true || p["path"] != root || p["builtin"] != true {
		t.Fatalf("工程目录：%v", p)
	}
	if l := data(mustGet(t, e.h, "/api/video/media/browse?root=project&video_id="+vid+"&dir=assets")); len(l["files"].([]any)) != 1 {
		t.Fatalf("浏览工程目录：%v", l)
	}
	base := "/api/video/videos/" + vid + "/shots"
	list(t, e.h, "POST", base, `{"text":"一"}`, 201)
	xs = list(t, e.h, "POST", base, `{"text":"二"}`, 201)
	s1, s2 := obj(xs[0])["id"].(string), obj(xs[1])["id"].(string)
	add := "/api/video/shots/" + s1 + "/brolls"
	xs = list(t, e.h, "POST", add, `{"items":[{"root_id":"`+rid+`","path":"a.png"},{"root_id":"`+rid+`","path":"c.mp4"},{"root_id":"project","path":"assets/logo.png"}]}`, 200)
	bs := obj(xs[0])["brolls"].([]any)
	if len(bs) != 3 || obj(bs[0])["name"] != "a.png" || obj(bs[1])["kind"] != "video" || obj(bs[2])["root_id"] != "project" || obj(bs[0])["missing"] != false {
		t.Fatalf("加 B-roll：%v", bs)
	}
	// 重复的跳过；position 插到前面
	xs = list(t, e.h, "POST", add, `{"items":[{"root_id":"`+rid+`","path":"a.png"},{"root_id":"`+rid+`","path":"b.png"}],"position":1}`, 200)
	bs = obj(xs[0])["brolls"].([]any)
	if len(bs) != 4 || obj(bs[0])["name"] != "b.png" || obj(bs[1])["name"] != "a.png" {
		t.Fatalf("去重、插到前面：%v", bs)
	}
	for _, body := range []string{`{"items":[]}`, `{"items":[{"root_id":"vmr_nope","path":"a.png"}]}`, `{"items":[{"root_id":"` + rid + `","path":"nope.png"}]}`} {
		if code, out := call(t, e.h, "POST", add, body); code != 400 && code != 404 {
			t.Fatalf("%s 要拒绝：%d %v", body, code, out)
		}
	}
	img, vidb := obj(bs[0])["id"].(string), obj(bs[2])["id"].(string)
	if code, out := call(t, e.h, "PATCH", "/api/video/brolls/"+img, `{"in":1}`); code != 400 || errMsg(out) != "图片没有入点、出点" {
		t.Fatalf("图片不能设入点：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/brolls/"+vidb, `{"in":3,"out":2}`); code != 400 || errMsg(out) != "出点要晚于入点" {
		t.Fatalf("出点早于入点：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "PATCH", "/api/video/brolls/"+vidb, `{"in":-1}`); code != 400 {
		t.Fatalf("负的入点 400：%d", code)
	}
	xs = list(t, e.h, "PATCH", "/api/video/brolls/"+vidb, `{"in":0.5,"out":1.75,"note":"只要转场那段"}`, 200)
	if b := obj(obj(xs[0])["brolls"].([]any)[2]); b["in"] != 0.5 || b["out"] != 1.75 || b["note"] != "只要转场那段" {
		t.Fatalf("入出点、备注：%v", b)
	}
	xs = list(t, e.h, "PATCH", "/api/video/brolls/"+vidb, `{"out":null}`, 200)
	if b := obj(obj(xs[0])["brolls"].([]any)[2]); b["in"] != 0.5 || b["out"] != nil {
		t.Fatalf("清出点：%v", b)
	}
	// 排序
	ids := []string{}
	for _, b := range obj(xs[0])["brolls"].([]any) {
		ids = append([]string{obj(b)["id"].(string)}, ids...)
	}
	jb, _ := json.Marshal(map[string]any{"ids": ids})
	xs = list(t, e.h, "POST", add+"/reorder", string(jb), 200)
	if got := obj(obj(xs[0])["brolls"].([]any)[0])["root_id"]; got != "project" {
		t.Fatalf("B-roll 排序：%v", xs[0])
	}
	// 挪到另一个分镜
	xs = list(t, e.h, "PATCH", "/api/video/brolls/"+img, `{"shot_id":"`+s2+`"}`, 200)
	if len(obj(xs[0])["brolls"].([]any)) != 3 || len(obj(xs[1])["brolls"].([]any)) != 1 {
		t.Fatalf("挪到第二个分镜：%v", xs)
	}
	other := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"别的"}`, 201)["id"].(string)
	os2 := obj(list(t, e.h, "POST", "/api/video/videos/"+other+"/shots", `{}`, 201)[0])["id"].(string)
	if code, _ := call(t, e.h, "PATCH", "/api/video/brolls/"+img, `{"shot_id":"`+os2+`"}`); code != 400 {
		t.Fatalf("不能挪到别的视频：%d", code)
	}
	// 文件被移走、目录被移除：标缺失，不报错，原文件不动
	if err := os.Rename(filepath.Join(media, "a.png"), filepath.Join(media, "moved.png")); err != nil {
		t.Fatal(err)
	}
	xs = list(t, e.h, "GET", base, "", 200)
	missing := map[string]bool{}
	for _, s := range xs {
		for _, b := range obj(s)["brolls"].([]any) {
			missing[obj(b)["name"].(string)] = obj(b)["missing"].(bool)
		}
	}
	if !reflect.DeepEqual(missing, map[string]bool{"a.png": true, "b.png": false, "c.mp4": false, "logo.png": false}) {
		t.Fatalf("缺失标记：%v", missing)
	}
	mustCall(t, e.h, "DELETE", "/api/video/media/roots/"+rid, "", 200)
	xs = list(t, e.h, "GET", base, "", 200)
	for _, b := range obj(xs[0])["brolls"].([]any) {
		if want := obj(b)["root_id"] != "project"; obj(b)["missing"] != want {
			t.Fatalf("目录移除后标缺失：%v", b)
		}
	}
	if _, err := os.Stat(filepath.Join(media, "b.png")); err != nil {
		t.Fatalf("移除目录不动磁盘：%v", err)
	}
	// 移除一条
	xs = list(t, e.h, "DELETE", "/api/video/brolls/"+vidb, "", 200)
	if len(obj(xs[0])["brolls"].([]any)) != 2 {
		t.Fatalf("移除：%v", xs[0])
	}
	if _, err := os.Stat(filepath.Join(media, "c.mp4")); err != nil {
		t.Fatalf("移除 B-roll 不删原文件：%v", err)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/video/brolls/"+vidb, ""); code != 404 {
		t.Fatalf("再删 404：%d", code)
	}
}
