package video

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// 平台收的封面比例、方向默认的封面比例、封面比例的取值和原型一致（VID-02a）
func TestCoverTablesMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "videodata.ts"))
	if err != nil {
		t.Skip("没有原型 videodata.ts：", err)
	}
	src := string(b)
	list := func(s string) []string {
		var out []string
		for _, m := range regexp.MustCompile(`'(\w+)'`).FindAllStringSubmatch(s, -1) {
			out = append(out, m[1])
		}
		return out
	}
	plat := regexp.MustCompile(`\{ key: '(\w+)', label: '([^']*)'.*cover: \[([^\]]*)\] \}`)
	got := map[string][]string{}
	for _, m := range plat.FindAllStringSubmatch(src, -1) {
		got[m[1]] = list(m[3])
		if PlatformLabels[m[1]] != m[2] {
			t.Errorf("平台 %s 的名字原型是 %s，后端是 %s", m[1], m[2], PlatformLabels[m[1]])
		}
	}
	if !reflect.DeepEqual(got, PlatformCovers) {
		t.Errorf("PLATFORMS.cover 原型是 %v，后端是 %v", got, PlatformCovers)
	}
	m := regexp.MustCompile(`export type CoverRatio = ([^\n]*)`).FindStringSubmatch(src)
	if m == nil || !reflect.DeepEqual(list(m[1]), CoverRatios) {
		t.Errorf("CoverRatio 原型是 %v，后端是 %v", m, CoverRatios)
	}
	i := strings.Index(src, "export const DEFAULT_COVER_RATIOS")
	if i < 0 {
		t.Fatal("videodata.ts 里找不到 DEFAULT_COVER_RATIOS")
	}
	body := src[i:]
	body = body[:strings.Index(body, "\n}")]
	def := map[string][]string{}
	for _, m := range regexp.MustCompile(`(?m)^  (\w+): \[([^\]]*)\]`).FindAllStringSubmatch(body, -1) {
		def[m[1]] = list(m[2])
	}
	if !reflect.DeepEqual(def, DefaultCoverRatios) {
		t.Errorf("DEFAULT_COVER_RATIOS 原型是 %v，后端是 %v", def, DefaultCoverRatios)
	}
	for _, r := range CoverRatios {
		if !strings.Contains(src, "'"+r+"': { label: '"+CoverRatioLabels[r]+"'") {
			t.Errorf("COVER_RATIO.%s 的名字和后端 %s 对不上", r, CoverRatioLabels[r])
		}
	}
}

// 竖屏同时出 9:16、3:4、1:1 封面，各比例的序号和选用各管各的；抖音选 16:9 封面 400 并说明原因
func TestCoverRatioAndPlatform(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"双方向","orientations":["landscape","portrait"]}`)
	art := func(body string) map[string]any {
		t.Helper()
		return mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`",`+body+`}`, 201)
	}
	c34 := art(`"kind":"cover","variant":"portrait","ratio":"3x4","option":1,"path":"cover/3x4-1.png","picked":true`)
	if c34["ratio"] != "3x4" || c34["option"] != 1.0 || c34["picked"] != true || c34["name"] != "封面 1" {
		t.Fatalf("3:4 封面：%v", c34)
	}
	// 没给比例取方向的默认：竖屏是 9:16；同方向不同比例的第 1 个方案、选用互不影响
	c916 := art(`"kind":"cover","variant":"portrait","option":1,"path":"cover/9x16-1.png","picked":true`)
	c11 := art(`"kind":"cover","variant":"portrait","ratio":"1x1","option":1,"path":"cover/1x1-1.png"`)
	c169 := art(`"kind":"cover","variant":"landscape","option":1,"path":"cover/16x9-1.png","picked":true`)
	if c916["ratio"] != "9x16" || c11["ratio"] != "1x1" || c169["ratio"] != "16x9" {
		t.Fatalf("默认比例：%v %v %v", c916["ratio"], c11["ratio"], c169["ratio"])
	}
	for id, want := range map[string]bool{c34["id"].(string): true, c916["id"].(string): true} {
		if got := mustCall(t, e.h, "GET", "/api/video/artifacts/"+id, "", 200); got["picked"] != want {
			t.Fatalf("%s 的选用：%v", id, got)
		}
	}
	code, out := call(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"cover","variant":"portrait","ratio":"3x4","option":1,"path":"cover/x.png"}`)
	if code != 409 || !strings.Contains(errMsg(out), "竖屏封面 3:4 的第 1 个方案") {
		t.Fatalf("同比例同序号：%d %v", code, out)
	}
	// 选用 3:4 的另一张，只取消 3:4 那张
	c34b := art(`"kind":"cover","variant":"portrait","ratio":"3x4","option":2,"path":"cover/3x4-2.png","picked":true`)
	if got := mustCall(t, e.h, "GET", "/api/video/artifacts/"+c34["id"].(string), "", 200); got["picked"] != false {
		t.Fatalf("3:4 第 1 张应取消选用：%v", got)
	}
	if got := mustCall(t, e.h, "GET", "/api/video/artifacts/"+c916["id"].(string), "", 200); got["picked"] != true {
		t.Fatalf("9:16 的选用不该动：%v", got)
	}
	_, out = call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd+"&kind=cover&ratio=3x4", "")
	if xs := out["data"].([]any); len(xs) != 2 {
		t.Fatalf("按比例筛：%v", xs)
	}
	for body, want := range map[string]string{
		`"kind":"cover","variant":"portrait","ratio":"2x3","path":"c.png"`:   "ratio 只能是",
		`"kind":"video","variant":"portrait","ratio":"9x16","path":"o.mp4"`:  "只有封面有封面比例",
		`"kind":"cover","ratio":"3x4","path":"c.png"`:                        "要选 variant",
		`"kind":"subtitle","variant":"portrait","lang":"中文","path":"s.srt"`:  "语言代码",
		`"kind":"subtitle","path":"s.srt"`:                                   "字幕按画面比例区分",
		`"kind":"script","variant":"portrait","lang":"zh","path":"app/s.md"`: "只有字幕有语言",
		`"kind":"description","variant":"portrait","option":1,"path":"d.md"`: "只有封面有方案序号",
	} {
		code, out := call(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`",`+body+`}`)
		if code != 400 || !strings.Contains(errMsg(out), want) {
			t.Errorf("POST %s：要 400 含「%s」，实际 %d %s", body, want, code, errMsg(out))
		}
	}

	// 发布记录：抖音收 3:4、9:16
	pub := func(body string) (int, map[string]any) {
		return call(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vd+`","title":"t",`+body+`}`)
	}
	code, out = pub(`"platform":"douyin","variant":"landscape","cover_id":"` + c169["id"].(string) + `"`)
	if code != 400 || errMsg(out) != "封面比例不符合要求：抖音要 3:4 或 9:16，这次用的是 16:9" {
		t.Fatalf("抖音选 16:9 封面：%d %v", code, out)
	}
	code, out = pub(`"platform":"douyin","variant":"portrait","cover_id":"` + c169["id"].(string) + `"`)
	if code != 400 || !strings.Contains(errMsg(out), "封面是横屏的，这条发布是竖屏") {
		t.Fatalf("方向对不上：%d %v", code, out)
	}
	code, out = pub(`"platform":"douyin","variant":"portrait","cover_id":"vaf_none"`)
	if code != 400 || !strings.Contains(errMsg(out), "不存在") {
		t.Fatalf("封面不存在：%d %v", code, out)
	}
	sc := art(`"kind":"script","variant":"portrait","path":"app/script.md"`)
	code, out = pub(`"platform":"douyin","variant":"portrait","cover_id":"` + sc["id"].(string) + `"`)
	if code != 400 || !strings.Contains(errMsg(out), "要是封面") {
		t.Fatalf("拿口播稿当封面：%d %v", code, out)
	}
	other := newVideo(t, e, `{"title":"另一集","orientations":["portrait"]}`)
	code, out = call(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+other+`","title":"t","platform":"douyin","variant":"portrait","cover_id":"`+c34b["id"].(string)+`"}`)
	if code != 400 || !strings.Contains(errMsg(out), "不是这个视频的") {
		t.Fatalf("别的视频的封面：%d %v", code, out)
	}
	code, out = pub(`"platform":"douyin","variant":"portrait","cover_id":"` + c34b["id"].(string) + `"`)
	pb := data(out)
	if code != 201 || pb["cover_id"] != c34b["id"] {
		t.Fatalf("抖音选 3:4 封面：%d %v", code, out)
	}
	pbID := pb["id"].(string)
	// 只改标题不重新校验；换到 YouTube（只收 16:9）400
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pbID, `{"title":"新标题"}`, 200)
	if code, out := call(t, e.h, "PATCH", "/api/video/publishes/"+pbID, `{"platform":"youtube"}`); code != 400 || !strings.Contains(errMsg(out), "YouTube要 16:9") {
		t.Fatalf("换平台：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pbID, `{"platform":"xiaohongshu"}`, 200)
	// 发布记录在用的封面改成平台不收的比例 400；改成收的可以
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+c34b["id"].(string), `{"ratio":"9x16"}`); code != 400 || !strings.Contains(errMsg(out), "小红书的发布记录在用这张封面") {
		t.Fatalf("改在用封面的比例：%d %v", code, out)
	}
	if got := mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+c34b["id"].(string), `{"ratio":"1x1"}`, 200); got["ratio"] != "1x1" || got["picked"] != true {
		t.Fatalf("改成 1:1：%v", got)
	}
	// 只换方向：原比例不是新方向默认出的，回到新方向的默认
	if got := mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+c11["id"].(string), `{"variant":"square"}`, 200); got["ratio"] != "1x1" {
		t.Fatalf("1:1 换到方形保留：%v", got)
	}
	if got := mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+c11["id"].(string), `{"variant":"landscape","option":3}`, 200); got["ratio"] != "16x9" {
		t.Fatalf("1:1 换到横屏回到 16:9：%v", got)
	}
}

// 双方向视频横竖两套口播稿各自升版本、各自验收；字幕按比例登记，带语言
func TestScriptsAndSubtitlesPerVariant(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"双方向","root":"videos/ep01","orientations":["landscape","portrait"]}`)
	pc := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"landscape","path":"pc/script.md","status":"review"}`, 201)
	app := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"portrait","path":"app/script.md","status":"review"}`, 201)
	pcID, appID := pc["id"].(string), app["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/artifacts/"+pcID+"/reviews", `{"ok":true}`, 200)
	mustCall(t, e.h, "POST", "/api/video/artifacts/"+appID+"/reviews", `{"ok":false,"comment":"竖版第 2 屏字太多"}`, 200)
	mustCall(t, e.h, "POST", "/api/video/artifacts/"+appID+"/bump", `{"from":1}`, 200)
	mustCall(t, e.h, "POST", "/api/video/artifacts/"+appID+"/reviews", `{"ok":true,"comment":"可以"}`, 200)
	gpc := mustCall(t, e.h, "GET", "/api/video/artifacts/"+pcID, "", 200)
	gapp := mustCall(t, e.h, "GET", "/api/video/artifacts/"+appID, "", 200)
	if gpc["version"] != 1.0 || gpc["status"] != "final" || len(gpc["reviews"].([]any)) != 1 {
		t.Fatalf("横版口播稿：%v", gpc)
	}
	rv := gapp["reviews"].([]any)
	if gapp["version"] != 2.0 || gapp["status"] != "final" || len(rv) != 2 ||
		rv[0].(map[string]any)["version"] != 1.0 || rv[1].(map[string]any)["version"] != 2.0 {
		t.Fatalf("竖版口播稿：%v", gapp)
	}
	_, out := call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd+"&kind=script&variant=portrait", "")
	if xs := out["data"].([]any); len(xs) != 1 || xs[0].(map[string]any)["id"] != appID {
		t.Fatalf("按比例筛口播稿：%v", xs)
	}

	s1 := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"subtitle","variant":"landscape","lang":"zh","path":"subtitle/ep01-16x9.srt","status":"final"}`, 201)
	s2 := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"subtitle","variant":"portrait","lang":"zh-Hans","path":"subtitle/ep01-9x16.srt"}`, 201)
	s3 := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"subtitle","variant":"landscape","lang":"en","path":"subtitle/ep01-16x9.en.srt"}`, 201)
	if s1["name"] != "字幕" || s1["lang"] != "zh" || s1["variant"] != "landscape" || s2["lang"] != "zh-Hans" || s3["lang"] != "en" {
		t.Fatalf("字幕：%v %v %v", s1, s2, s3)
	}
	for _, k := range []string{"ratio", "option", "picked", "duration"} {
		if _, ok := s1[k]; ok {
			t.Fatalf("字幕不该有 %s：%v", k, s1)
		}
	}
	_, out = call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd+"&kind=subtitle&lang=en", "")
	if xs := out["data"].([]any); len(xs) != 1 || xs[0].(map[string]any)["id"] != s3["id"] {
		t.Fatalf("按语言筛：%v", xs)
	}
	if got := mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+s3["id"].(string), `{"lang":null}`, 200); got["lang"] != nil {
		t.Fatalf("清掉语言：%v", got)
	}
}

// 0002 时登记的产出物：封面补默认比例、序号和选用挪到新列；口播稿等补成视频的第一个比例
func TestLegacyArtifactsUpgraded(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"老数据","orientations":["portrait"]}`)
	vn := newVideo(t, e, `{"title":"还没选比例"}`)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, row := range [][]any{
		{"vaf_old1", vd, "cover", "封面 1", "cover/9x16-1.png", "portrait", 1, 1},
		{"vaf_old2", vd, "cover", "封面 2", "cover/9x16-2.png", "portrait", 2, 0},
		{"vaf_old3", vd, "script", "口播稿", "script.md", "", nil, 0},
		{"vaf_old4", vn, "outline", "大纲", "outline.md", "", nil, 0},
		{"vaf_old5", vd, "audio", "音频", "audio/", "", nil, 0},
	} {
		if _, err := e.d.W.Exec(`INSERT INTO video_artifacts (id, video_id, kind, name, path, variant, option_no, picked, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, append(row, now, now)...); err != nil {
			t.Fatal(err)
		}
	}
	got := map[string]map[string]any{}
	_, out := call(t, e.h, "GET", "/api/video/artifacts", "")
	for _, x := range out["data"].([]any) {
		m := x.(map[string]any)
		got[m["id"].(string)] = m
	}
	if a := got["vaf_old1"]; a["ratio"] != "9x16" || a["option"] != 1.0 || a["picked"] != true {
		t.Fatalf("老封面 1：%v", a)
	}
	if a := got["vaf_old2"]; a["ratio"] != "9x16" || a["option"] != 2.0 || a["picked"] != false {
		t.Fatalf("老封面 2：%v", a)
	}
	if got["vaf_old3"]["variant"] != "portrait" || got["vaf_old4"]["variant"] != "landscape" {
		t.Fatalf("老文稿的比例：%v %v", got["vaf_old3"], got["vaf_old4"])
	}
	if _, ok := got["vaf_old5"]["variant"]; ok {
		t.Fatalf("音频不分比例：%v", got["vaf_old5"])
	}
	var legacy int
	if err := e.d.R.QueryRow(`SELECT count(*) FROM video_artifacts WHERE option_no IS NOT NULL OR picked = 1`).Scan(&legacy); err != nil || legacy != 0 {
		t.Fatalf("旧列还有值：%d %v", legacy, err)
	}
	// 搬过来的序号和选用照样占位
	code, out := call(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"cover","variant":"portrait","option":2,"path":"cover/x.png"}`)
	if code != 409 {
		t.Fatalf("老封面的序号要占位：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/vaf_old2", `{"picked":true}`, 200)
	if a := mustCall(t, e.h, "GET", "/api/video/artifacts/vaf_old1", "", 200); a["picked"] != false {
		t.Fatalf("选用老封面 2 后老封面 1：%v", a)
	}
}
