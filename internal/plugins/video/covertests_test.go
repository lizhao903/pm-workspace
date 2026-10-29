package video

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 一个视频登记 n 张同组封面，返回封面 id；第 1 张选用
func coverFixture(t *testing.T, e env, vd, variant, ratio string, n int) []string {
	t.Helper()
	var ids []string
	for o := 1; o <= n; o++ {
		picked := "false"
		if o == 1 {
			picked = "true"
		}
		a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"cover","variant":"`+variant+`","ratio":"`+ratio+`","option":`+string(rune('0'+o))+
			`,"path":"cover/`+ratio+`-`+string(rune('0'+o))+`.png","status":"final","picked":`+picked+`}`, 201)
		ids = append(ids, a["id"].(string))
	}
	return ids
}

func artifactOf(t *testing.T, e env, id string) map[string]any {
	t.Helper()
	return mustCall(t, e.h, "GET", "/api/video/artifacts/"+id, "", 200)
}

// 小号分发：三条发布各用一张封面，每天回填数据（快照落库）后重算；数据到齐判出胜者，胜者成主封面，其余归档，记录和文件都在
func TestCoverTestAccountsDecided(t *testing.T) {
	e := setup(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "cover"), 0o755); err != nil {
		t.Fatal(err)
	}
	for o := 1; o <= 3; o++ {
		if err := os.WriteFile(filepath.Join(root, "cover", "9x16-"+string(rune('0'+o))+".png"), []byte("png"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vd := newVideo(t, e, `{"title":"第 1 集","orientations":["portrait"],"root":"`+root+`"}`)
	covers := coverFixture(t, e, vd, "portrait", "9x16", 3)
	start := daysAgo(8)
	var pubs []string
	for i, c := range covers {
		p := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vd+`","platform":"channels","variant":"portrait","cover_id":"`+c+`","title":"今日待办一页清",
			"status":"published","published_at":"`+start+`","url":"https://channels.weixin.qq.com/web/pages/feed?id=ep01-`+string(rune('a'+i))+`"}`, 201)
		pubs = append(pubs, p["id"].(string))
	}
	ct := mustCall(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"channels","mode":"accounts","started_at":"`+start+`",
		"arms":[{"cover_id":"`+covers[0]+`","publish_id":"`+pubs[0]+`"},{"cover_id":"`+covers[1]+`","publish_id":"`+pubs[1]+`"},{"cover_id":"`+covers[2]+`","publish_id":"`+pubs[2]+`"}]}`, 201)
	id := ct["id"].(string)
	st := ct["state"].(map[string]any)
	if !strings.HasPrefix(id, "vct_") || ct["status"] != "running" || ct["min_days"] != 7.0 || ct["min_impressions"] != 10000.0 || ct["min_gap"] != 0.2 ||
		st["days"] != 8.0 || st["days_ok"] != true || st["imp_ok"] != false || st["data_incomplete"] != true {
		t.Fatalf("新开的测试：%v", ct)
	}
	// 每天的快照：第一天曝光不够，判不出
	day := daysAgo(6)
	for i, m := range []string{`"impressions":3000,"ctr":0.05`, `"impressions":3500,"ctr":0.07`, `"impressions":2800,"ctr":0.04`} {
		mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pubs[i], `{"metrics":{"views":100,"likes":1,"comments":0,"shares":0,`+m+`,"updated_at":"`+day+`"}}`, 200)
	}
	if got := mustCall(t, e.h, "GET", "/api/video/cover-tests/"+id, "", 200); got["status"] != "running" || got["state"].(map[string]any)["reached"] != 0.0 {
		t.Fatalf("曝光不够要还在进行中：%v", got)
	}
	// 后来的快照：曝光都到 1 万，第二张点击率领先 30%；最后一条落库时判出
	day = daysAgo(1)
	for i, m := range []string{`"impressions":12000,"ctr":0.05`, `"impressions":15000,"ctr":0.065`, `"impressions":11000,"ctr":0.04`} {
		mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pubs[i], `{"metrics":{"views":900,"likes":9,"comments":1,"shares":0,`+m+`,"updated_at":"`+day+`"}}`, 200)
		got := mustCall(t, e.h, "GET", "/api/video/cover-tests/"+id, "", 200)
		if want := map[bool]string{true: "decided", false: "running"}[i == 2]; got["status"] != want {
			t.Fatalf("第 %d 条快照后状态要 %s：%v", i+1, want, got)
		}
	}
	xs, _ := snapshots(t, e, pubs[1])
	if len(xs) != 2 {
		t.Fatalf("快照要两条：%v", xs)
	}
	got := mustCall(t, e.h, "GET", "/api/video/cover-tests/"+id, "", 200)
	if got["winner_id"] != covers[1] || got["ended_at"] == nil || got["state"].(map[string]any)["gap_ok"] != true {
		t.Fatalf("胜者要是第 2 张：%v", got)
	}
	w := artifactOf(t, e, covers[1])
	if w["picked"] != true || w["archived"] != false {
		t.Fatalf("胜者要是主封面：%v", w)
	}
	for _, c := range []string{covers[0], covers[2]} {
		a := artifactOf(t, e, c)
		if a["archived"] != true || a["picked"] != false || !strings.HasPrefix(a["path"].(string), "cover/9x16-") {
			t.Fatalf("其余要归档、不再选用：%v", a)
		}
		if _, err := os.Stat(filepath.Join(root, a["path"].(string))); err != nil {
			t.Fatalf("归档的封面文件要还在：%v", err)
		}
	}
	// 判出后再来数据不改结果；结束了不能改
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pubs[0], `{"metrics":{"views":1000,"likes":9,"comments":1,"shares":0,"impressions":20000,"ctr":0.09,"updated_at":"`+nowStr()+`"}}`, 200)
	if again := mustCall(t, e.h, "POST", "/api/video/cover-tests/"+id+"/evaluate", "", 200); again["winner_id"] != covers[1] || again["status"] != "decided" {
		t.Fatalf("判出后不再变：%v", again)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/cover-tests/"+id, `{"min_days":3}`); code != 409 {
		t.Fatalf("结束了还能改：%d %v", code, out)
	}
	// 归档的封面不能选用，也不能再拿来测试
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+covers[0], `{"picked":true}`); code != 400 || !strings.Contains(errMsg(out), "归档") {
		t.Fatalf("归档的封面选用：%d %v", code, out)
	}
	if code, out := call(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"channels","mode":"native",
		"arms":[{"cover_id":"`+covers[0]+`"},{"cover_id":"`+covers[1]+`"}]}`); code != 400 || !strings.Contains(errMsg(out), "已归档") {
		t.Fatalf("归档的封面再测：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+covers[0], `{"archived":false}`, 200)
	if a := artifactOf(t, e, covers[0]); a["archived"] != false {
		t.Fatalf("取消归档：%v", a)
	}
}

// 平台原生测试：曝光和天数都到了，点击率差距只有 10%，判没有结论，封面都不动
func TestCoverTestNativeInconclusive(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"第 2 集","orientations":["landscape"]}`)
	covers := coverFixture(t, e, vd, "landscape", "16x9", 2)
	ct := mustCall(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"youtube","mode":"native","started_at":"`+daysAgo(9)+`",
		"arms":[{"cover_id":"`+covers[0]+`","impressions":20000,"ctr":0.05},{"cover_id":"`+covers[1]+`","impressions":21000,"ctr":0.055}]}`, 201)
	st := ct["state"].(map[string]any)
	if ct["status"] != "inconclusive" || ct["winner_id"] != nil || ct["ended_at"] == nil || st["leader"] != covers[1] || st["gap_ok"] != false || st["imp_ok"] != true {
		t.Fatalf("差距不够要没有结论：%v", ct)
	}
	for i, c := range covers {
		a := artifactOf(t, e, c)
		if a["archived"] != false || a["picked"] != (i == 0) {
			t.Fatalf("没有结论封面不动：%v", a)
		}
	}
}

// 平台原生测试：天数没到照旧进行中；手填数据、放宽门槛后判出，差距正好 20% 也算到线
func TestCoverTestNativeThresholds(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"第 3 集","orientations":["landscape"]}`)
	covers := coverFixture(t, e, vd, "landscape", "16x9", 3)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vd+`","platform":"youtube","variant":"landscape","title":"第 3 集"}`, 201)["id"].(string)
	ct := mustCall(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"youtube","mode":"native","started_at":"`+daysAgo(2.5)+`","min_impressions":5000,
		"arms":[{"cover_id":"`+covers[0]+`","publish_id":"`+pb+`"},{"cover_id":"`+covers[1]+`","publish_id":"`+pb+`"},{"cover_id":"`+covers[2]+`","publish_id":"`+pb+`"}]}`, 201)
	id := ct["id"].(string)
	got := mustCall(t, e.h, "PATCH", "/api/video/cover-tests/"+id, `{"arms":[{"cover_id":"`+covers[0]+`","impressions":8000,"ctr":0.05},
		{"cover_id":"`+covers[1]+`","impressions":9000,"ctr":0.04},{"cover_id":"`+covers[2]+`","impressions":7000,"ctr":0.06}]}`, 200)
	if st := got["state"].(map[string]any); got["status"] != "running" || st["days"] != 2.0 || st["days_ok"] != false || st["imp_ok"] != true || st["gap_ok"] != true {
		t.Fatalf("天数没到要还在进行中：%v", got)
	}
	got = mustCall(t, e.h, "PATCH", "/api/video/cover-tests/"+id, `{"min_days":2}`, 200)
	if got["status"] != "decided" || got["winner_id"] != covers[2] {
		t.Fatalf("放宽天数后要判出第 3 张：%v", got)
	}
	if a := artifactOf(t, e, covers[2]); a["picked"] != true {
		t.Fatalf("胜者要选用：%v", a)
	}
	if a := artifactOf(t, e, covers[0]); a["picked"] != false || a["archived"] != true {
		t.Fatalf("原来选用的输了要归档：%v", a)
	}
	for q, want := range map[string]float64{"&status=decided": 1, "&status=running": 0} {
		if _, out := call(t, e.h, "GET", "/api/video/cover-tests?video_id="+vd+q, ""); out["meta"].(map[string]any)["total"] != want {
			t.Fatalf("列表 %s：%v", q, out)
		}
	}
	// 删视频连测试一起删
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+vd, "", 200)
	if code, _ := call(t, e.h, "GET", "/api/video/cover-tests/"+id, ""); code != 404 {
		t.Fatalf("视频删了测试要跟着删：%d", code)
	}
}

func TestCoverTestValidation(t *testing.T) {
	e := setup(t)
	vd := newVideo(t, e, `{"title":"第 4 集","orientations":["portrait"]}`)
	other := newVideo(t, e, `{"title":"别的","orientations":["portrait"]}`)
	covers := coverFixture(t, e, vd, "portrait", "9x16", 2)
	oc := coverFixture(t, e, other, "portrait", "9x16", 1)
	sc := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vd+`","kind":"script","variant":"portrait","path":"pc/script.md"}`, 201)["id"].(string)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vd+`","platform":"douyin","variant":"portrait","title":"第 4 集"}`, 201)["id"].(string)
	arms := func(a, b string) string { return `"arms":[{"cover_id":"` + a + `"},{"cover_id":"` + b + `"}]` }
	for _, c := range []struct{ body, want string }{
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native","arms":[{"cover_id":"` + covers[0] + `"}]}`, "2 到 5"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native",` + arms(covers[0], covers[0]) + `}`, "重复"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native",` + arms(covers[0], oc[0]) + `}`, "不是这个视频"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native",` + arms(covers[0], sc) + `}`, "要是封面"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"accounts",` + arms(covers[0], covers[1]) + `}`, "对应一条发布记录"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native","arms":[{"cover_id":"` + covers[0] + `","publish_id":"` + pb + `"},{"cover_id":"` + covers[1] + `"}]}`, "测试的平台"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"split",` + arms(covers[0], covers[1]) + `}`, "mode 只能是"},
		{`{"video_id":"` + vd + `","mode":"native",` + arms(covers[0], covers[1]) + `}`, "platform 必填"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native","min_gap":-1,` + arms(covers[0], covers[1]) + `}`, "min_gap"},
		{`{"video_id":"` + vd + `","platform":"channels","mode":"native","arms":[{"cover_id":"` + covers[0] + `","ctr":3},{"cover_id":"` + covers[1] + `"}]}`, "点击率"},
		{`{"video_id":"nope","platform":"channels","mode":"native",` + arms(covers[0], covers[1]) + `}`, "视频不存在"},
	} {
		if code, out := call(t, e.h, "POST", "/api/video/cover-tests", c.body); code != 400 || !strings.Contains(errMsg(out), c.want) {
			t.Errorf("%s：要 400 %q，实际 %d %v", c.body, c.want, code, out)
		}
	}
	id := mustCall(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"channels","mode":"native",`+arms(covers[0], covers[1])+`}`, 201)["id"].(string)
	if code, out := call(t, e.h, "POST", "/api/video/cover-tests", `{"video_id":"`+vd+`","platform":"channels","mode":"native",`+arms(covers[0], covers[1])+`}`); code != 409 {
		t.Fatalf("同平台第二个进行中的测试：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/cover-tests/"+id, `{"arms":[{"cover_id":"`+oc[0]+`","ctr":0.1}]}`); code != 400 || !strings.Contains(errMsg(out), "不能增删") {
		t.Fatalf("改不在测试里的封面：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/artifacts/"+sc, `{"archived":true}`); code != 400 || !strings.Contains(errMsg(out), "只有封面能归档") {
		t.Fatalf("口播稿归档：%d %v", code, out)
	}
	if a := artifactOf(t, e, sc); a["archived"] != nil {
		t.Fatalf("口播稿不该有 archived：%v", a)
	}
	mustCall(t, e.h, "DELETE", "/api/video/cover-tests/"+id, "", 200)
	if a := artifactOf(t, e, covers[0]); a["picked"] != true {
		t.Fatalf("删测试不动封面：%v", a)
	}
}
