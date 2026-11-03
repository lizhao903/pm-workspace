package video

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

func daysAgo(d float64) string {
	return time.Now().UTC().Add(-time.Duration(d * 24 * float64(time.Hour))).Format(time.RFC3339)
}

func snapshots(t *testing.T, e env, pb string) ([]any, []any) {
	t.Helper()
	_, out := call(t, e.h, "GET", "/api/video/publishes/"+pb+"/snapshots", "")
	xs, _ := out["data"].([]any)
	meta, _ := out["meta"].(map[string]any)
	days, _ := meta["days"].([]any)
	if meta["total"] != float64(len(xs)) {
		t.Fatalf("快照 total：%v", out)
	}
	return xs, days
}

// 同一条发布回填三次：三条快照，按天曲线同一天取最后一条；扩展指标没填的不返回
func TestSnapshotsBackfill(t *testing.T) {
	e := setup(t)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 1 集","orientations":["portrait"]}`, 201)
	pub := daysAgo(5)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+v["id"].(string)+`","platform":"channels","variant":"portrait","title":"今日待办一页清",
		"status":"published","published_at":"`+pub+`","url":"https://channels.weixin.qq.com/web/pages/feed?id=ep01"}`, 201)
	id := pb["id"].(string)
	if xs, _ := snapshots(t, e, id); len(xs) != 0 {
		t.Fatalf("没回填过不该有快照：%v", xs)
	}
	path := "/api/video/publishes/" + id
	for _, b := range []string{
		`{"views":100,"likes":5,"comments":1,"shares":0,"updated_at":"` + daysAgo(4.5) + `"}`,
		`{"views":180,"likes":9,"comments":2,"shares":1,"impressions":4000,"ctr":0.045,"updated_at":"` + daysAgo(4.2) + `"}`,
		`{"views":900,"likes":40,"comments":6,"shares":5,"impressions":12000,"ctr":0.075,"completion":0.31,"avg_watch_sec":141.5,"followers_gained":-3,"updated_at":"` + daysAgo(2) + `"}`,
	} {
		mustCall(t, e.h, "PATCH", path, `{"metrics":`+b+`}`, 200)
	}
	// 只改别的字段不记快照
	mustCall(t, e.h, "PATCH", path, `{"collection":"一人之下 10 分钟上手"}`, 200)
	xs, days := snapshots(t, e, id)
	if len(xs) != 3 {
		t.Fatalf("回填三次要三条快照：%v", xs)
	}
	s0, s2 := xs[0].(map[string]any), xs[2].(map[string]any)
	if s0["day"] != 1.0 || s0["source"] != "manual" || s0["views"] != 100.0 || s0["publish_id"] != id || s0["impressions"] != nil || s0["created_at"] == nil {
		t.Fatalf("第一条：%v", s0)
	}
	if s2["day"] != 3.0 || s2["ctr"] != 0.075 || s2["completion"] != 0.31 || s2["avg_watch_sec"] != 141.5 || s2["followers_gained"] != -3.0 || s2["coins"] != nil {
		t.Fatalf("第三条：%v", s2)
	}
	if len(days) != 2 || days[0].(map[string]any)["views"] != 180.0 || days[1].(map[string]any)["day"] != 3.0 {
		t.Fatalf("按天曲线同一天取最后一条：%v", days)
	}
	// 发布记录上的 metrics 是最新一条
	p := mustCall(t, e.h, "GET", path, "", 200)
	if m := p["metrics"].(map[string]any); m["views"] != 900.0 || m["impressions"] != 12000.0 || m["favorites"] != nil {
		t.Fatalf("metrics：%v", p["metrics"])
	}
	for _, bad := range []string{`{"views":1,"updated_at":"` + pub + `","ctr":1.5}`, `{"views":1,"updated_at":"` + pub + `","impressions":-1}`, `{"views":1,"updated_at":"` + pub + `","danmaku":3}`} {
		if code, out := call(t, e.h, "PATCH", path, `{"metrics":`+bad+`}`); code != 400 {
			t.Fatalf("%s 要 400：%d %v", bad, code, out)
		}
	}
	// 删发布记录快照一起删
	mustCall(t, e.h, "DELETE", path, "", 200)
	var n int
	if err := e.d.R.QueryRow(`SELECT COUNT(*) FROM video_metric_snapshots WHERE publish_id = ?`, id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("删发布记录后快照：%d %v", n, err)
	}
}

// 平台规则：标题超长的发布照样能登记成计划中，checks 记下原因；不能切到已定时，改短了才行
func TestPublishChecksBlockSchedule(t *testing.T) {
	e := setup(t)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 1 集","orientations":["portrait"]}`, 201)
	vid := v["id"].(string)
	long := strings.Repeat("长", 31)
	later := time.Now().UTC().Add(48 * time.Hour).Format(time.RFC3339)
	if code, out := call(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"douyin","variant":"portrait","title":"`+long+`","status":"scheduled","scheduled_at":"`+later+`"}`); code != 400 ||
		errMsg(out) != "发布前校验没通过，不能定时：标题超长：抖音最多 30 字，现在 31 字" {
		t.Fatalf("新建就定时：%d %v", code, out)
	}
	p := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"douyin","variant":"portrait","title":"`+long+`",
		"desc":"看 https://example.com","tags":["a","b","a"],"checks":[{"key":"x","ok":true,"text":"前端算的不用"}]}`, 201)
	path := "/api/video/publishes/" + p["id"].(string)
	cs := p["checks"].([]any)
	want := []string{"title:false:标题超长：抖音最多 30 字，现在 31 字", "desc:true:简介 21 / 1000 字", "tags:true:标签 2 / 5 个", "link:false:简介带外链：抖音不允许放链接"}
	var got []string
	for _, c := range cs {
		m := c.(map[string]any)
		ok := "false"
		if m["ok"] == true {
			ok = "true"
		}
		got = append(got, m["key"].(string)+":"+ok+":"+m["text"].(string))
	}
	if !slices.Equal(got, want) || !reflect.DeepEqual(p["tags"], []any{"a", "b"}) || p["status"] != "planned" {
		t.Fatalf("checks：%v tags=%v", got, p["tags"])
	}
	if code, out := call(t, e.h, "PATCH", path, `{"status":"scheduled","scheduled_at":"`+later+`"}`); code != 400 || !strings.Contains(errMsg(out), "标题超长") {
		t.Fatalf("超长切已定时：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", path, `{"title":"今日待办一页清","status":"scheduled","scheduled_at":"`+later+`"}`); code != 400 || !strings.Contains(errMsg(out), "外链") {
		t.Fatalf("还带外链：%d %v", code, out)
	}
	p = mustCall(t, e.h, "PATCH", path, `{"title":"今日待办一页清","desc":"一页看完今天","status":"scheduled","scheduled_at":"`+later+`"}`, 200)
	if p["status"] != "scheduled" || firstFailedAny(p["checks"]) != "" {
		t.Fatalf("改短后：%v", p)
	}
	// 已定时的改回超长也不行
	if code, _ := call(t, e.h, "PATCH", path, `{"title":"`+long+`"}`); code != 400 {
		t.Fatalf("已定时改超长要 400：%d", code)
	}
	// 成片时长算进去：抖音最长 15 分钟
	mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"video","variant":"portrait","path":"app/out.mp4","duration":1000}`, 201)
	if code, out := call(t, e.h, "PATCH", path, `{"desc":"一页看完今天的事"}`); code != 400 || !strings.Contains(errMsg(out), "时长超出：抖音最长 15 分钟") {
		t.Fatalf("超时长：%d %v", code, out)
	}
}

func firstFailedAny(v any) string {
	for _, c := range v.([]any) {
		if m := c.(map[string]any); m["ok"] != true {
			return m["text"].(string)
		}
	}
	return ""
}

// 平台规则和原型 PLATFORM_RULES 一致
func TestPlatformRulesMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "videodata.ts"))
	if err != nil {
		t.Skip("没有原型 videodata.ts：", err)
	}
	src := string(b)
	re := regexp.MustCompile(`(?m)^\s*(\w+): \{ platform: '\w+', title_max: (\d+), desc_max: (\d+), tags_max: (\d+), allow_link: (true|false), cover: coverOf\('\w+'\)(?:, categories: \[([^\]]*)\])?(?:, duration_max_sec: (\d+))? \},$`)
	ms := re.FindAllStringSubmatch(src, -1)
	if len(ms) != len(Platforms) {
		t.Fatalf("PLATFORM_RULES 解析出 %d 条", len(ms))
	}
	for _, m := range ms {
		r := PlatformRules[m[1]]
		var cats []string
		for _, c := range strings.Split(m[6], ",") {
			if c = strings.Trim(strings.TrimSpace(c), "'"); c != "" {
				cats = append(cats, c)
			}
		}
		got := []string{r.Platform, strconv.Itoa(r.TitleMax), strconv.Itoa(r.DescMax), strconv.Itoa(r.TagsMax), map[bool]string{true: "true", false: "false"}[r.AllowLink], strings.Join(r.Categories, ","), strconv.Itoa(r.DurationMaxSec)}
		want := []string{m[1], m[2], m[3], m[4], m[5], strings.Join(cats, ","), m[7]}
		if want[6] == "" {
			want[6] = "0"
		}
		if !slices.Equal(got, want) || !slices.Equal(r.Cover, PlatformCovers[m[1]]) {
			t.Errorf("%s：Go %v，原型 %v", m[1], got, want)
		}
	}
	// 新加的几个类型字段对齐：PlatformAccount、PlatformRule、PublishCheck，MetricSnapshot 只比自己的几个
	fieldRe := regexp.MustCompile(`(?m)^\s*(\w+)\??:`)
	for name, v := range map[string]any{"PlatformAccount": PlatformAccount{}, "PlatformRule": PlatformRule{}, "PublishCheck": PublishCheck{}, "MetricSnapshot extends Metrics": MetricSnapshot{}} {
		i := strings.Index(src, "export interface "+name+" {")
		if i < 0 {
			t.Fatalf("videodata.ts 里找不到 interface %s", name)
		}
		body := src[i+len("export interface "+name+" {"):]
		if nl, end := strings.Index(body, "\n"), strings.Index(body, "}"); end < nl {
			body = body[:end]
		} else {
			body = body[:strings.Index(body, "\n}")]
		}
		var proto []string
		for _, m := range fieldRe.FindAllStringSubmatch(strings.ReplaceAll(body, ";", "\n"), -1) {
			proto = append(proto, m[1])
		}
		var tags []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			if rt.Field(i).Anonymous {
				continue
			}
			tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
			tags = append(tags, tag)
		}
		if len(proto) == 0 {
			t.Fatalf("%s 一个字段都没解析出来", name)
		}
		for _, f := range proto {
			if !slices.Contains(tags, f) {
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

// 平台账号：打角色、挂连接器；发布记录挂账号，同步时没给 connector_id 用账号的连接器
func TestPlatformAccounts(t *testing.T) {
	e := setupBilibili(t)
	c1 := e.addConnector(t, biliGoodToken)
	c2 := e.addConnector(t, biliGoodToken)
	// 手动登记的视频号小号
	ab := mustCall(t, e.h, "POST", "/api/video/accounts", `{"platform":"channels","handle":"一人之下·试封面 A","uid":"sphAbc02","role":"ab","caps":["metrics","upload","metrics"],"followers":640}`, 201)
	if !strings.HasPrefix(ab["id"].(string), "pa_") || ab["role"] != "ab" || !reflect.DeepEqual(ab["caps"], []any{"upload", "metrics"}) || ab["followers"] != 640.0 || ab["connector_id"] != nil {
		t.Fatalf("手动账号：%v", ab)
	}
	for _, bad := range []string{`{"platform":"channels","handle":"x","role":"boss"}`, `{"platform":"channels","handle":"x","caps":["fly"]}`, `{"platform":"channels"}`,
		`{"platform":"channels","handle":"x","connector_id":"` + c1.ID + `"}`, `{"platform":"bilibili","handle":"x","connector_id":"cn_nope"}`} {
		if code, out := call(t, e.h, "POST", "/api/video/accounts", bad); code != 400 {
			t.Fatalf("%s 要 400：%d %v", bad, code, out)
		}
	}
	// 挂连接器的 B 站客户号，昵称没给用连接器的账号名（没连通测试时为空，要自己给）
	main := mustCall(t, e.h, "POST", "/api/video/accounts", `{"platform":"bilibili","handle":"主号","connector_id":"`+c2.ID+`","caps":["upload","metrics"]}`, 201)
	if main["connector_id"] != c2.ID || main["role"] != "main" {
		t.Fatalf("B 站账号：%v", main)
	}
	if code, _ := call(t, e.h, "POST", "/api/video/accounts", `{"platform":"bilibili","handle":"又一个","connector_id":"`+c2.ID+`"}`); code != 409 {
		t.Fatalf("同一个连接器挂两个账号要 409：%d", code)
	}
	if got := mustCall(t, e.h, "PATCH", "/api/video/accounts/"+main["id"].(string), `{"role":"client"}`, 200); got["role"] != "client" || got["connector_id"] != c2.ID {
		t.Fatalf("改角色：%v", got)
	}
	_, out := call(t, e.h, "GET", "/api/video/accounts?platform=bilibili", "")
	if out["meta"].(map[string]any)["total"] != 1.0 {
		t.Fatalf("按平台筛：%v", out)
	}

	// 发布记录挂账号：平台要对得上
	_, pb := e.publishable(t, []byte("film"))
	path := "/api/video/publishes/" + pb
	if code, out := call(t, e.h, "PATCH", path, `{"account_id":"`+ab["id"].(string)+`"}`); code != 400 || !strings.Contains(errMsg(out), "视频号") {
		t.Fatalf("挂别的平台的账号：%d %v", code, out)
	}
	p := mustCall(t, e.h, "PATCH", path, `{"account_id":"`+main["id"].(string)+`","url":"https://www.bilibili.com/video/BV1Te5tTst01","status":"published","published_at":"`+daysAgo(2)+`"}`, 200)
	if p["account_id"] != main["id"] {
		t.Fatalf("挂账号：%v", p)
	}
	// 接了两个 B 站连接器，没给 connector_id 时用账号挂的那个
	code, out := call(t, e.h, "POST", path+"/sync", "")
	if code != 200 || out["meta"].(map[string]any)["connector_id"] != c2.ID {
		t.Fatalf("用账号的连接器同步：%d %v", code, out)
	}
	if c := e.connector(t, c1.ID); c.LastSyncAt != nil {
		t.Fatalf("没挂的连接器不该用：%+v", c)
	}
	// 同步也追加快照：B 站给收藏和投币，不给曝光
	xs, _ := snapshots(t, e.env, pb)
	if len(xs) != 1 {
		t.Fatalf("同步后快照：%v", xs)
	}
	s := xs[0].(map[string]any)
	if s["source"] != "connector" || s["day"] != 2.0 || s["views"] != 1234.0 || s["coins"] != 12.0 || s["favorites"] != 90.0 || s["impressions"] != nil || s["ctr"] != nil {
		t.Fatalf("同步快照：%v", s)
	}
	if code, _ := call(t, e.h, "DELETE", "/api/video/accounts/"+main["id"].(string), ""); code != 409 {
		t.Fatalf("挂着发布记录的账号不能删：%d", code)
	}
	if code, _ := call(t, e.h, "PATCH", "/api/video/accounts/"+main["id"].(string), `{"platform":"youtube"}`); code != 409 {
		t.Fatalf("挂着发布记录的账号不能换平台：%d", code)
	}
	mustCall(t, e.h, "DELETE", "/api/video/accounts/"+ab["id"].(string), "", 200)
	if code, _ := call(t, e.h, "GET", "/api/video/accounts/"+ab["id"].(string), ""); code != 404 {
		t.Fatalf("删掉后要 404：%d", code)
	}
}

// 后台任务 metrics_daily：对着假 B 站按天落快照，同一天只拉一次；暂停的连接器跳过；视频号这类没有连接器的不拉
func TestMetricsDailyJob(t *testing.T) {
	old := metricsEvery
	metricsEvery = 50 * time.Millisecond
	t.Cleanup(func() { metricsEvery = old })
	e := setupBilibili(t)
	cn := e.addConnector(t, biliGoodToken)
	vid, pb := e.publishable(t, []byte("film"))
	path := "/api/video/publishes/" + pb
	mustCall(t, e.h, "PATCH", path, `{"url":"https://www.bilibili.com/video/BV1Te5tTst01","status":"published","published_at":"`+daysAgo(3.5)+`"}`, 200)
	// 视频号手动登记的不拉
	ch := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"channels","variant":"landscape","title":"视频号版","status":"published",
		"url":"https://channels.weixin.qq.com/x","published_at":"`+daysAgo(1)+`"}`, 201)

	wait := func(n int) []any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			xs, _ := snapshots(t, e.env, pb)
			if len(xs) >= n || time.Now().After(deadline) {
				return xs
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	xs := wait(1)
	if len(xs) != 1 || xs[0].(map[string]any)["day"] != 3.0 || xs[0].(map[string]any)["source"] != "connector" || xs[0].(map[string]any)["views"] != 1234.0 {
		t.Fatalf("第一轮：%v", xs)
	}
	// 同一天再跑几轮也不重复拉
	time.Sleep(300 * time.Millisecond)
	if xs, _ := snapshots(t, e.env, pb); len(xs) != 1 {
		t.Fatalf("同一天只拉一次：%v", xs)
	}
	// 过了一天（把发布时间往前挪一天）：再落一条第 4 天
	mustCall(t, e.h, "PATCH", path, `{"published_at":"`+daysAgo(4.5)+`"}`, 200)
	xs = wait(2)
	_, days := snapshots(t, e.env, pb)
	if len(xs) != 2 || xs[1].(map[string]any)["day"] != 4.0 || len(days) != 2 {
		t.Fatalf("第二天：%v %v", xs, days)
	}
	if p := mustCall(t, e.h, "GET", path, "", 200); p["metrics"].(map[string]any)["coins"] != 12.0 {
		t.Fatalf("metrics 跟着更新：%v", p["metrics"])
	}
	if cs, _ := snapshots(t, e.env, ch["id"].(string)); len(cs) != 0 {
		t.Fatalf("视频号不该拉：%v", cs)
	}
	// 暂停连接器后不再拉（过了一天也一样）
	on := false
	if _, err := e.conns.Update(context.Background(), cn.ID, connector.Patch{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	mustCall(t, e.h, "PATCH", path, `{"published_at":"`+daysAgo(5.5)+`"}`, 200)
	time.Sleep(300 * time.Millisecond)
	if xs, _ := snapshots(t, e.env, pb); len(xs) != 2 {
		t.Fatalf("暂停后不该拉：%v", xs)
	}
}
