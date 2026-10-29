package video

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// 原型 videodata.ts 里 Artifact、Review 的字段，Go 结构里都要有；多出的只能是 updated_at 和验收记录的 version
func TestArtifactFieldsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "videodata.ts"))
	if err != nil {
		t.Skip("没有原型 videodata.ts：", err)
	}
	src := string(b)
	i := strings.Index(src, "export interface Artifact {")
	if i < 0 {
		t.Fatal("videodata.ts 里找不到 interface Artifact")
	}
	body := src[i:]
	body = body[:strings.Index(body, "\n}")]
	var proto []string
	for _, m := range regexp.MustCompile(`(?m)^  (\w+)\??:`).FindAllStringSubmatch(body, -1) {
		proto = append(proto, m[1])
	}
	m := regexp.MustCompile(`export interface Review \{([^}]*)\}`).FindStringSubmatch(src)
	if m == nil {
		t.Fatal("videodata.ts 里找不到 interface Review")
	}
	var reviewProto []string
	for _, f := range strings.Split(m[1], ";") {
		if k, _, ok := strings.Cut(strings.TrimSpace(f), ":"); ok {
			reviewProto = append(reviewProto, strings.TrimSuffix(k, "?"))
		}
	}
	for _, c := range []struct {
		name  string
		v     any
		proto []string
		extra []string
	}{
		{"Artifact", Artifact{}, proto, []string{"updated_at"}},
		{"Review", Review{}, reviewProto, []string{"version"}},
	} {
		if len(c.proto) < 3 {
			t.Fatalf("%s 只解析出 %v", c.name, c.proto)
		}
		var tags []string
		rt := reflect.TypeOf(c.v)
		for i := 0; i < rt.NumField(); i++ {
			tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
			tags = append(tags, tag)
		}
		for _, f := range c.proto {
			// Review.by 是 VID-08p 给原型加的，VID-08 后端落地时删掉
			if !slices.Contains(tags, f) && !(c.name == "Review" && f == "by") {
				t.Errorf("%s.%s 原型里有，Go 结构里没有", c.name, f)
			}
		}
		for _, f := range tags {
			if !slices.Contains(c.proto, f) && !slices.Contains(c.extra, f) {
				t.Errorf("%s.%s Go 结构多出来的，原型里没有", c.name, f)
			}
		}
	}
	// 类型、状态、来源的取值和原型一致
	kindRe := regexp.MustCompile(`(?m)^  (\w+): \{ label: '([^']*)', stage: '(\w+)', perVariant: (true|false) \},`)
	protoKinds := map[string]string{}
	for _, m := range kindRe.FindAllStringSubmatch(src, -1) {
		protoKinds[m[1]] = fmt.Sprintf("%s/%s/%s", m[2], m[3], m[4])
	}
	for _, k := range ArtifactKinds {
		want := fmt.Sprintf("%s/%s/%v", k.Label, k.Stage, k.PerVariant)
		if got := protoKinds[k.Key]; got != want {
			t.Errorf("ARTIFACT_KIND.%s 原型是 %q，后端是 %q", k.Key, got, want)
		}
		delete(protoKinds, k.Key)
	}
	for k := range protoKinds {
		t.Errorf("ARTIFACT_KIND.%s 原型里有，后端没有", k)
	}
	for _, s := range ArtifactStatuses {
		if !strings.Contains(src, "  "+s+": { label:") {
			t.Errorf("ARTIFACT_STATUS 里找不到 %s", s)
		}
	}
	if !strings.Contains(src, "source: { type: '"+strings.Join(SourceTypes, "' | '")+"'; label: string }") {
		t.Errorf("原型 source.type 和 %v 对不上", SourceTypes)
	}
}

func newVideo(t *testing.T, e env, body string) string {
	t.Helper()
	return mustCall(t, e.h, "POST", "/api/video/videos", body, 201)["id"].(string)
}

// 原型种子里的几种产出物全部能存能读：多版本的口播稿、带时长的音频、按比例的成片、技能来源
func TestArtifactRoundTrip(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"第 1 集","root":"videos/ep01-today","orientations":["landscape","portrait"]}`)
	a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","name":"口播稿","path":"pc/script.md","variant":"landscape","version":3,"status":"final",
		"source":{"type":"skill","label":"web-video-presentation"}}`, 201)
	if !strings.HasPrefix(a["id"].(string), "vaf_") || a["version"] != 3.0 || a["status"] != "final" || a["path"] != "pc/script.md" || a["variant"] != "landscape" ||
		!reflect.DeepEqual(a["source"], map[string]any{"type": "skill", "label": "web-video-presentation"}) || len(a["reviews"].([]any)) != 0 {
		t.Fatalf("口播稿：%v", a)
	}
	for _, k := range []string{"ratio", "option", "lang", "duration", "picked"} {
		if _, ok := a[k]; ok {
			t.Fatalf("口播稿不该有 %s：%v", k, a)
		}
	}
	au := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"audio","name":"口播音频（5 章）","path":"audio/","duration":598}`, 201)
	if au["path"] != "audio/" || au["duration"] != 598.0 || au["status"] != "draft" || au["version"] != 1.0 ||
		!reflect.DeepEqual(au["source"], map[string]any{"type": "manual", "label": "手动登记"}) {
		t.Fatalf("音频：%v", au)
	}
	mv := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"video","name":"成片","path":"out/ep01-16x9.mp4","variant":"landscape","duration":602,"status":"published"}`, 201)
	if mv["variant"] != "landscape" || mv["duration"] != 602.0 || mv["status"] != "published" {
		t.Fatalf("成片：%v", mv)
	}
	// 没给名字用类型名；改名、改路径、改状态、清时长
	ch := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"chapters","variant":"portrait","path":"app/chapters.md"}`, 201)
	if ch["name"] != "章节时间轴" {
		t.Fatalf("默认名称：%v", ch)
	}
	got := mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+au["id"].(string), `{"name":"音频","path":"./audio/v2/","status":"review","duration":null}`, 200)
	if got["name"] != "音频" || got["path"] != "audio/v2/" || got["status"] != "review" || got["duration"] != nil {
		t.Fatalf("改音频：%v", got)
	}
	code, out := call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd+"&kind=video", "")
	if xs := out["data"].([]any); code != 200 || len(xs) != 1 || xs[0].(map[string]any)["id"] != mv["id"] {
		t.Fatalf("按类型筛：%d %v", code, out)
	}
	// 视频的更新时间跟着产出物刷新
	v := mustCall(t, e.h, "GET", "/api/video/videos/"+vd, "", 200)
	if v["updated_at"] == "" {
		t.Fatalf("视频：%v", v)
	}
	// 不认识的字段、不能改的字段
	for body, want := range map[string]string{
		`{"kind":"cover"}`:             "不能换类型",
		`{"version":4}`:                "升版本",
		`{"source":{"type":"manual"}}`: "来源",
		`{"reviews":[]}`:               "验收接口",
		`{"video_id":"vd_x"}`:          "不能换视频",
		`{"variant":null}`:             "要选 variant",
		`{"ratio":"3x4"}`:              "只有封面有封面比例",
		`{"lang":"zh"}`:                "只有字幕有语言",
		`{"duration":10}`:              "只有音频、视频有时长",
		`{"status":"done"}`:            "status 只能是",
		`{"foo":1}`:                    "不认识的字段",
	} {
		code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+a["id"].(string), body)
		if code != 400 || !strings.Contains(errMsg(out), want) {
			t.Errorf("PATCH %s：要 400 含「%s」，实际 %d %s", body, want, code, errMsg(out))
		}
	}
	for body, want := range map[string]string{
		`{"video_id":"vd_none","kind":"script","path":"a.md"}`:                           "视频不存在",
		`{"video_id":"` + vd + `","kind":"poster","path":"a.md"}`:                        "kind 只能是",
		`{"video_id":"` + vd + `","kind":"video","path":"a.mp4"}`:                        "要选 variant",
		`{"video_id":"` + vd + `","kind":"script","variant":"landscape"}`:                "路径必填",
		`{"video_id":"` + vd + `","kind":"script","variant":"landscape","path":"  "}`:    "路径必填",
		`{"video_id":"` + vd + `","kind":"script","path":"script.md"}`:                   "口播稿按画面比例区分",
		`{"video_id":"` + vd + `","kind":"article","variant":"landscape","path":"a.md"}`: "原文不分画面比例",
	} {
		code, out := call(t, e.h, "POST", "/api/video/artifacts", body)
		if code != 400 || !strings.Contains(errMsg(out), want) {
			t.Errorf("POST %s：要 400 含「%s」，实际 %d %s", body, want, code, errMsg(out))
		}
	}
	if code, _ := call(t, e.h, "GET", "/api/video/artifacts/vaf_none", ""); code != 404 {
		t.Fatalf("不存在要 404，实际 %d", code)
	}
}

// 同一类型同一比例存 5 个封面方案，选用其中一张；换一张选用时前一张自动取消
func TestCoverOptionsAndPick(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"封面","orientations":["landscape","portrait"]}`)
	var ids []string
	for o := 1; o <= 5; o++ {
		a := mustCall(t, e.h, "POST", "/api/video/artifacts", fmt.Sprintf(`{"video_id":"%s","kind":"cover","variant":"landscape","option":%d,"path":"cover/16x9-%d.png","status":"final"}`, vd, o, o), 201)
		if a["option"] != float64(o) || a["name"] != fmt.Sprintf("封面 %d", o) || a["picked"] != false {
			t.Fatalf("封面 %d：%v", o, a)
		}
		ids = append(ids, a["id"].(string))
	}
	// 竖屏同序号不冲突，并且登记时直接选用
	pt := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"cover","variant":"portrait","option":1,"path":"cover/9x16-1.png","picked":true}`, 201)
	if pt["picked"] != true {
		t.Fatalf("竖屏封面：%v", pt)
	}
	// 同比例同序号 409
	code, out := call(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"cover","variant":"landscape","option":3,"path":"cover/x.png"}`)
	if code != 409 || !strings.Contains(errMsg(out), "第 3 个方案") {
		t.Fatalf("重复序号：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+ids[0], `{"option":2}`); code != 409 {
		t.Fatalf("改成已占用的序号：%d %v", code, out)
	}
	pickedOf := func(variant string) []string {
		_, out := call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd+"&kind=cover&variant="+variant, "")
		var got []string
		for _, x := range out["data"].([]any) {
			if m := x.(map[string]any); m["picked"] == true {
				got = append(got, m["id"].(string))
			}
		}
		return got
	}
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+ids[1], `{"picked":true}`, 200)
	if got := pickedOf("landscape"); !reflect.DeepEqual(got, []string{ids[1]}) {
		t.Fatalf("选用第 2 张：%v", got)
	}
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+ids[4], `{"picked":true}`, 200)
	if got := pickedOf("landscape"); !reflect.DeepEqual(got, []string{ids[4]}) {
		t.Fatalf("换成第 5 张：%v", got)
	}
	// 另一个比例不受影响
	if got := pickedOf("portrait"); !reflect.DeepEqual(got, []string{pt["id"].(string)}) {
		t.Fatalf("竖屏的选用：%v", got)
	}
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+ids[4], `{"picked":false}`, 200)
	if got := pickedOf("landscape"); len(got) != 0 {
		t.Fatalf("取消选用：%v", got)
	}
	// 非封面不能选用、不能带序号
	sc := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"landscape","path":"script.md"}`, 201)
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+sc["id"].(string), `{"picked":true}`); code != 400 || !strings.Contains(errMsg(out), "只有封面") {
		t.Fatalf("口播稿选用：%d %v", code, out)
	}
	if code, _ := call(t, e.h, "PATCH", "/api/video/artifacts/"+sc["id"].(string), `{"option":1}`); code != 400 {
		t.Fatalf("口播稿序号：%d", code)
	}
	// 删掉被发布记录用作封面的那张，发布记录的 cover_id 清掉
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vd+`","platform":"bilibili","variant":"landscape","title":"t","cover_id":"`+ids[1]+`"}`, 201)
	mustCall(t, e.h, "DELETE", "/api/video/artifacts/"+ids[1], "", 200)
	if got := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb["id"].(string), "", 200); got["cover_id"] != nil {
		t.Fatalf("发布记录的封面没清：%v", got)
	}
	// 删视频，产出物一起没了
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+vd, "", 200)
	if _, out := call(t, e.h, "GET", "/api/video/artifacts?video_id="+vd, ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("删视频后还有产出物：%v", out)
	}
}

// 退回必须写意见；通过变已定稿；升版本回到草稿，旧版的验收记录还在、带着旧版本号
func TestReviewAndBump(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"验收"}`)
	a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"landscape","path":"script.md","status":"review"}`, 201)
	id := a["id"].(string)
	for _, body := range []string{`{"ok":false}`, `{"ok":false,"comment":"   "}`} {
		code, out := call(t, e.h, "POST", "/api/video/artifacts/"+id+"/reviews", body)
		if code != 400 || errMsg(out) != "退回要写意见" {
			t.Fatalf("退回不写意见 %s：%d %v", body, code, out)
		}
	}
	if code, _ := call(t, e.h, "POST", "/api/video/artifacts/"+id+"/reviews", `{"comment":"x"}`); code != 400 {
		t.Fatalf("没给 ok 要 400，实际 %d", code)
	}
	got := mustCall(t, e.h, "POST", "/api/video/artifacts/"+id+"/reviews", `{"ok":false,"comment":"第 3 段太长，拆成两屏"}`, 200)
	if got["status"] != "draft" || len(got["reviews"].([]any)) != 1 {
		t.Fatalf("退回：%v", got)
	}
	got = mustCall(t, e.h, "POST", "/api/video/artifacts/"+id+"/bump", `{"from":1}`, 200)
	if got["version"] != 2.0 || got["status"] != "draft" {
		t.Fatalf("升版本：%v", got)
	}
	// 重复点：from 对不上 409
	if code, _ := call(t, e.h, "POST", "/api/video/artifacts/"+id+"/bump", `{"from":1}`); code != 409 {
		t.Fatalf("重复升版本要 409，实际 %d", code)
	}
	got = mustCall(t, e.h, "POST", "/api/video/artifacts/"+id+"/reviews", `{"ok":true}`, 200)
	if got["status"] != "final" {
		t.Fatalf("通过：%v", got)
	}
	got = mustCall(t, e.h, "POST", "/api/video/artifacts/"+id+"/bump", `{}`, 200)
	if got["version"] != 3.0 || got["status"] != "draft" {
		t.Fatalf("再升版本：%v", got)
	}
	got = mustCall(t, e.h, "GET", "/api/video/artifacts/"+id, "", 200)
	rv := got["reviews"].([]any)
	if len(rv) != 2 {
		t.Fatalf("验收记录：%v", rv)
	}
	r1, r2 := rv[0].(map[string]any), rv[1].(map[string]any)
	if r1["ok"] != false || r1["comment"] != "第 3 段太长，拆成两屏" || r1["version"] != 1.0 || r1["at"] == "" ||
		r2["ok"] != true || r2["comment"] != "通过" || r2["version"] != 2.0 {
		t.Fatalf("验收记录：%v", rv)
	}
	// 已发布的通过后保持已发布
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+id, `{"status":"published"}`, 200)
	if got := mustCall(t, e.h, "POST", "/api/video/artifacts/"+id+"/reviews", `{"ok":true,"comment":"可以"}`, 200); got["status"] != "published" {
		t.Fatalf("已发布的通过：%v", got)
	}
}

// Agent、SOP 产出的产出物带运行 id，能按运行 id 反查；手动登记不能带出处；来源登记后不能改
func TestArtifactProvenance(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"溯源","orientations":["landscape"]}`)
	ag := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"presentation","variant":"landscape","path":"presentation-landscape",
		"source":{"type":"agent","id":"ag_writer","label":"视频助手","run_id":"ar_01","session_id":"ags_01","artifact_id":"art_01"}}`, 201)
	want := map[string]any{"type": "agent", "id": "ag_writer", "label": "视频助手", "run_id": "ar_01", "session_id": "ags_01", "artifact_id": "art_01"}
	if !reflect.DeepEqual(ag["source"], want) {
		t.Fatalf("Agent 来源：%v", ag["source"])
	}
	sop := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"description","variant":"landscape","path":"description.md","source":{"type":"sop","id":"sop_weekly","run_id":"spr_02"}}`, 201)
	if !reflect.DeepEqual(sop["source"], map[string]any{"type": "sop", "id": "sop_weekly", "label": "sop_weekly", "run_id": "spr_02"}) {
		t.Fatalf("SOP 来源：%v", sop["source"])
	}
	for q, wantID := range map[string]string{"run_id=ar_01": ag["id"].(string), "session_id=ags_01": ag["id"].(string), "run_id=spr_02": sop["id"].(string), "source_type=sop": sop["id"].(string)} {
		_, out := call(t, e.h, "GET", "/api/video/artifacts?"+q, "")
		xs := out["data"].([]any)
		if len(xs) != 1 || xs[0].(map[string]any)["id"] != wantID {
			t.Errorf("按 %s 查：%v", q, xs)
		}
	}
	for body, want := range map[string]string{
		`{"type":"agent","id":"ag_writer"}`:    "run_id 或 session_id",
		`{"type":"sop","session_id":"ags_1"}`:  "SOP 的产出要带 run_id",
		`{"type":"manual","run_id":"ar_1"}`:    "手动登记的不带",
		`{"type":"robot"}`:                     "source.type 只能是",
		`{"label":"x"}`:                        "source.type 必填",
		`{"type":"skill","run_id":"ar 1; --"}`: "source.run_id 只能有",
		`{"type":"skill","extra":1}`:           "不认识的字段 extra",
		`"agent"`:                              "source 必须是对象",
	} {
		code, out := call(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"landscape","path":"s.md","source":`+body+`}`)
		if code != 400 || !strings.Contains(errMsg(out), want) {
			t.Errorf("source %s：要 400 含「%s」，实际 %d %s", body, want, code, errMsg(out))
		}
	}
	if code, _ := call(t, e.h, "PATCH", "/api/video/artifacts/"+ag["id"].(string), `{"source":{"type":"manual"}}`); code != 400 {
		t.Fatalf("改来源要 400，实际 %d", code)
	}
}

// 路径只许在视频工程目录内：绝对路径、盘符、越出工程目录的 .. 一律 400；目录内的 .. 规整掉
func TestArtifactPathStaysInProject(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"路径","root":"videos/ep01"}`)
	for _, p := range []string{"../secret.md", "a/../../x.md", "..", "/etc/passwd", "~/x.md", `C:\\x.md`, "C:/x.md", `a\\b.md`, "file:///etc/passwd", ".", "./", "a/.."} {
		body := fmt.Sprintf(`{"video_id":"%s","kind":"script","variant":"landscape","path":%q}`, vd, p)
		if code, out := call(t, e.h, "POST", "/api/video/artifacts", body); code != 400 {
			t.Errorf("路径 %q：要 400，实际 %d %v", p, code, out)
		}
	}
	for in, want := range map[string]string{"./script.md": "script.md", "a/../script.md": "script.md", "cover//16x9-1.png": "cover/16x9-1.png", "audio/": "audio/", "...md": "...md"} {
		a := mustCall(t, e.h, "POST", "/api/video/artifacts", fmt.Sprintf(`{"video_id":"%s","kind":"script","variant":"landscape","path":%q}`, vd, in), 201)
		if a["path"] != want {
			t.Errorf("路径 %q 存成 %v，要 %s", in, a["path"], want)
		}
	}
	a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"outline","variant":"landscape","path":"outline.md"}`, 201)
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+a["id"].(string), `{"path":"../../outline.md"}`); code != 400 || !strings.Contains(errMsg(out), "越出") {
		t.Fatalf("PATCH 越界路径：%d %v", code, out)
	}
}
