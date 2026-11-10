// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 原型 videodata.ts 里 Deal 的字段，Go 结构里都要有；多出的只能是时间和后端算好的 report_state
func TestDealFieldsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "videodata.ts"))
	if err != nil {
		t.Skip("没有原型 videodata.ts：", err)
	}
	src := string(b)
	head := "export interface Deal {"
	i := strings.Index(src, head)
	if i < 0 {
		t.Fatal("videodata.ts 里找不到 interface Deal")
	}
	body := src[i+len(head):]
	body = body[:strings.Index(body, "\n}")]
	var proto []string
	for _, m := range regexp.MustCompile(`(?m)^\s*(\w+)\??:`).FindAllStringSubmatch(body, -1) {
		proto = append(proto, m[1])
	}
	if len(proto) == 0 {
		t.Fatal("Deal 一个字段都没解析出来")
	}
	var tags []string
	rt := reflect.TypeOf(Deal{})
	for i := 0; i < rt.NumField(); i++ {
		tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
		tags = append(tags, tag)
	}
	for _, f := range proto {
		if !slices.Contains(tags, f) {
			t.Errorf("Deal.%s 原型里有，Go 结构里没有", f)
		}
	}
	for _, f := range tags {
		if !slices.Contains(proto, f) && f != "created_at" && f != "updated_at" && f != "report_state" {
			t.Errorf("Deal.%s Go 结构多出来的，原型里没有", f)
		}
	}
	// 状态集同原型 DealStatus
	m := regexp.MustCompile(`export type DealStatus = ([^\n]+)`).FindStringSubmatch(src)
	if m == nil {
		t.Fatal("找不到 DealStatus")
	}
	var got []string
	for _, s := range regexp.MustCompile(`'(\w+)'`).FindAllStringSubmatch(m[1], -1) {
		got = append(got, s[1])
	}
	if !reflect.DeepEqual(got, DealStatuses) {
		t.Fatalf("DealStatus 原型 %v，后端 %v", got, DealStatuses)
	}
}

// 内核 store 和插件注册表用同一个库，插件能建文档
func setupWithObjects(t *testing.T) (env, *sqlite.Store) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(st.DB())
	r.SetObjectCreator(st)
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
	return env{r, mux, st.DB()}, st
}

func addContact(t *testing.T, e env, id, name string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := e.d.W.Exec(`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, id, name, now, now); err != nil {
		t.Fatal(err)
	}
}

// 新建、改、状态流转校验、history、挂视频归项目、删除
func TestDealCRUDAndFlow(t *testing.T) {
	e := setup(t)
	addProject(t, e.d, "obj_pj1")
	addProject(t, e.d, "obj_pj2")
	addContact(t, e, "stk_a", "梁晚晴")

	for _, c := range []struct{ body, msg string }{
		{`{"title":"x","project_id":"obj_pj1"}`, "品牌必填"},
		{`{"brand":"远川","project_id":"obj_pj1"}`, "商单名称必填"},
		{`{"brand":"远川","title":"x"}`, "选一个项目"},
		{`{"brand":"远川","title":"x","project_id":"obj_nope"}`, "项目不存在"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","contact_id":"stk_nope"}`, "联系人不存在"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","status":"lost"}`, "写一下丢单原因"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","status":"won"}`, "status 只能是"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","currency":"EUR"}`, "币种 只能是"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","quote":-1}`, "报价"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","pay_due":"11/03"}`, "YYYY-MM-DD"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","video_ids":["vd_nope"]}`, "视频 vd_nope 不存在"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","history":[]}`, "不认识的字段 history"},
		{`{"brand":"远川","title":"x","project_id":"obj_pj1","report_content_id":"obj_x"}`, "不认识的字段 report_content_id"},
	} {
		code, out := call(t, e.h, "POST", "/api/video/deals", c.body)
		if code != 400 || !strings.Contains(errMsg(out), c.msg) {
			t.Errorf("%s：要 400「%s」，实际 %d %v", c.body, c.msg, code, out)
		}
	}

	v1 := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"试点上线短片"}`, 201)["id"].(string)
	v2 := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"另一个","project_id":"obj_pj2"}`, 201)["id"].(string)
	d := mustCall(t, e.h, "POST", "/api/video/deals", `{"brand":" 远川科技 ","title":"试点上线短片","project_id":"obj_pj1","contact_id":"stk_a",
		"platforms":["channels","bilibili","channels"],"deliverables":"1 支横版","quote":12000,"deadline":"2026-11-10","pay_due":"2026-12-01",
		"video_ids":["`+v1+`","`+v2+`","`+v1+`"],"source_message_id":"msg_1"}`, 201)
	id := d["id"].(string)
	if !strings.HasPrefix(id, "deal_") || d["brand"] != "远川科技" || d["status"] != "inquiry" || d["currency"] != "CNY" || d["quote"] != 12000.0 ||
		!reflect.DeepEqual(d["platforms"], []any{"bilibili", "channels"}) || !reflect.DeepEqual(d["video_ids"], []any{v1, v2}) ||
		d["contact_id"] != "stk_a" || d["source_message_id"] != "msg_1" || d["deadline"] != "2026-11-10" || d["pay_due"] != "2026-12-01" ||
		d["report_content_id"] != nil || d["lost_reason"] != nil || d["report_state"] != nil {
		t.Fatalf("新建：%v", d)
	}
	if h := d["history"].([]any); len(h) != 1 || h[0].(map[string]any)["status"] != "inquiry" {
		t.Fatalf("新建的 history：%v", h)
	}
	// 没项目的视频归到商单的项目，有项目的不动
	if p := mustCall(t, e.h, "GET", "/api/video/videos/"+v1, "", 200)["project_id"]; p != "obj_pj1" {
		t.Fatalf("v1 的项目：%v", p)
	}
	if p := mustCall(t, e.h, "GET", "/api/video/videos/"+v2, "", 200)["project_id"]; p != "obj_pj2" {
		t.Fatalf("v2 的项目：%v", p)
	}

	// 状态流转：记 history，新的在前；没改状态不记
	mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"quoted"}`, 200)
	d = mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"delivered","deliverables":"1 支横版 + 置顶评论"}`, 200)
	d = mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"quote":13000}`, 200)
	var hs []string
	for _, x := range d["history"].([]any) {
		hs = append(hs, x.(map[string]any)["status"].(string))
	}
	if !reflect.DeepEqual(hs, []string{"delivered", "quoted", "inquiry"}) || d["quote"] != 13000.0 || d["deliverables"] != "1 支横版 + 置顶评论" {
		t.Fatalf("流转后：%v", d)
	}
	// 只改别的字段，挂的视频不丢
	if !reflect.DeepEqual(d["video_ids"], []any{v1, v2}) {
		t.Fatalf("没传 video_ids 时视频不动：%v", d["video_ids"])
	}
	// 丢单要原因；已收款不能丢单；离开丢单时原因清掉
	if code, out := call(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"lost"}`); code != 400 || errMsg(out) != "写一下丢单原因" {
		t.Fatalf("丢单不写原因：%d %v", code, out)
	}
	d = mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"lost","lost_reason":"预算没批下来"}`, 200)
	if d["lost_reason"] != "预算没批下来" {
		t.Fatalf("丢单：%v", d)
	}
	d = mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"paid"}`, 200)
	if d["lost_reason"] != nil {
		t.Fatalf("离开丢单原因要清掉：%v", d)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/deals/"+id, `{"status":"lost","lost_reason":"x"}`); code != 400 || errMsg(out) != "已收款的商单不能丢单" {
		t.Fatalf("已收款丢单：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/deals/"+id, `{"brand":""}`); code != 400 || errMsg(out) != "品牌必填" {
		t.Fatalf("清空品牌：%d %v", code, out)
	}
	// 清可选字段
	d = mustCall(t, e.h, "PATCH", "/api/video/deals/"+id, `{"contact_id":null,"pay_due":null,"video_ids":["`+v2+`"]}`, 200)
	if d["contact_id"] != nil || d["pay_due"] != nil || !reflect.DeepEqual(d["video_ids"], []any{v2}) {
		t.Fatalf("清可选字段：%v", d)
	}

	// 筛选
	mustCall(t, e.h, "POST", "/api/video/deals", `{"brand":"北岸物流","title":"审批流 demo","project_id":"obj_pj2"}`, 201)
	for q, n := range map[string]int{"": 2, "?project_id=obj_pj1": 1, "?project_id=obj_pj2": 1, "?source_message_id=msg_1": 1,
		"?video_id=" + v2: 1, "?video_id=" + v1: 0, "?status=paid": 1} {
		code, out := call(t, e.h, "GET", "/api/video/deals"+q, "")
		if xs, _ := out["data"].([]any); code != 200 || len(xs) != n {
			t.Errorf("GET deals%s：要 %d 条，实际 %d %v", q, n, code, out)
		}
	}

	// 视频删掉时关联跟着删；商单删掉时视频留着
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+v2, "", 200)
	if d = mustCall(t, e.h, "GET", "/api/video/deals/"+id, "", 200); len(d["video_ids"].([]any)) != 0 {
		t.Fatalf("视频删掉后：%v", d["video_ids"])
	}
	mustCall(t, e.h, "DELETE", "/api/video/deals/"+id, "", 200)
	if code, _ := call(t, e.h, "GET", "/api/video/deals/"+id, ""); code != 404 {
		t.Fatalf("删掉后 GET：%d", code)
	}
	mustCall(t, e.h, "GET", "/api/video/videos/"+v1, "", 200)
}

// 验收：从一条 IM 询价建商单，关联视频，发布 7 天后能生成结案报告文档
func TestDealFromMessageToReport(t *testing.T) {
	e, st := setupWithObjects(t)
	ctx := context.Background()
	addProject(t, e.d, "obj_pj1")
	addContact(t, e, "stk_a", "梁晚晴")

	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"试点上线短片","orientations":["landscape"]}`, 201)["id"].(string)
	d := mustCall(t, e.h, "POST", "/api/video/deals", `{"brand":"远川科技","title":"试点上线短片","project_id":"obj_pj1","contact_id":"stk_a",
		"source_message_id":"msg_ask","platforms":["bilibili"],"deliverables":"1 支 3 分钟横版","quote":12000,"video_ids":["`+vid+`"]}`, 201)
	id := d["id"].(string)

	// 还没发布：不能出
	if code, out := call(t, e.h, "POST", "/api/video/deals/"+id+"/report", `{}`); code != 409 || !strings.Contains(errMsg(out), "还没有发出去") {
		t.Fatalf("没发布就出报告：%d %v", code, out)
	}
	at := func(days int) string {
		return time.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	pub := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"试点上线短片",
		"status":"published","published_at":"`+at(3)+`","url":"https://www.bilibili.com/video/BV1demo"}`, 201)["id"].(string)
	d = mustCall(t, e.h, "GET", "/api/video/deals/"+id, "", 200)
	if rs, _ := d["report_state"].(map[string]any); rs == nil || rs["ready"] != false || rs["left"] != 4.0 {
		t.Fatalf("发布 3 天：%v", d["report_state"])
	}
	if code, out := call(t, e.h, "POST", "/api/video/deals/"+id+"/report", `{}`); code != 409 || errMsg(out) != "最早一条发布还差 4 天满 7 天" {
		t.Fatalf("没满 7 天：%d %v", code, out)
	}
	// 发布满 8 天，回填一次数据
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pub, `{"published_at":"`+at(8)+`","metrics":{"views":32100,"likes":1200,"comments":86,"shares":40,
		"ctr":0.052,"updated_at":"`+at(0)+`"}}`, 200)
	out := mustCall(t, e.h, "POST", "/api/video/deals/"+id+"/report", `{}`, 201)
	doc := out["doc"].(map[string]any)
	deal := out["deal"].(map[string]any)
	if deal["report_content_id"] != doc["id"] || doc["title"] != "远川科技 · 试点上线短片 结案报告" {
		t.Fatalf("出报告：%v", out)
	}
	o, err := st.GetObject(ctx, doc["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if o.TypeID != "doc" || o.ProjectID == nil || *o.ProjectID != "obj_pj1" || o.Source != "video" || !slices.Contains(o.Tags, "结案报告") {
		t.Fatalf("文档：type=%s project=%v source=%s tags=%v", o.TypeID, o.ProjectID, o.Source, o.Tags)
	}
	for _, s := range []string{"## 合作概况", "- 品牌：远川科技", "- 报价：¥12,000", "- 投放平台：B 站", "- 视频：试点上线短片",
		"- 播放 32,100，点赞 1,200，评论 86，转发 40", "B 站「试点上线短片」：发布 8 天，播放 32,100，点击率 5.2%，链接 https://www.bilibili.com/video/BV1demo"} {
		if !strings.Contains(o.Body, s) {
			t.Errorf("报告正文少了「%s」：\n%s", s, o.Body)
		}
	}
	// 重出：新建一篇，report_content_id 换成新的
	again := mustCall(t, e.h, "POST", "/api/video/deals/"+id+"/report", `{}`, 201)
	if again["doc"].(map[string]any)["id"] == doc["id"] || again["deal"].(map[string]any)["report_content_id"] != again["doc"].(map[string]any)["id"] {
		t.Fatalf("重出：%v", again)
	}
}

// 报价参考读快照：每条发布最新一条快照的播放，近 30 天、按平台
func TestDealQuoteRef(t *testing.T) {
	e := setup(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"甲","orientations":["landscape","portrait"]}`, 201)["id"].(string)
	at := func(days int) string {
		return time.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	add := func(platform, variant string, days, views int) {
		p := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"`+platform+`","variant":"`+variant+`","title":"t",
			"status":"published","published_at":"`+at(days)+`"}`, 201)["id"].(string)
		// 两次回填，取后一次
		mustCall(t, e.h, "PATCH", "/api/video/publishes/"+p, `{"metrics":{"views":1,"likes":0,"comments":0,"shares":0,"updated_at":"`+at(1)+`"}}`, 200)
		mustCall(t, e.h, "PATCH", "/api/video/publishes/"+p, `{"metrics":{"views":`+strconv.Itoa(views)+`,"likes":0,"comments":0,"shares":0,"updated_at":"`+at(0)+`"}}`, 200)
	}
	add("bilibili", "landscape", 5, 20000)
	add("bilibili", "landscape", 10, 40000)
	add("douyin", "portrait", 3, 90000)
	add("bilibili", "landscape", 40, 999999) // 超过 30 天不算
	// 没发布的不算
	mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"bilibili","variant":"landscape","title":"t"}`, 201)

	ref := mustCall(t, e.h, "GET", "/api/video/deals/quote-ref?platforms=bilibili", "", 200)
	if ref["avg"] != 30000.0 || ref["n"] != 2.0 || ref["cpm"] != 150.0 || ref["value"] != 4500.0 {
		t.Fatalf("B 站：%v", ref)
	}
	ref = mustCall(t, e.h, "GET", "/api/video/deals/quote-ref", "", 200)
	if ref["avg"] != 50000.0 || ref["n"] != 3.0 || len(ref["platforms"].([]any)) != 0 {
		t.Fatalf("各平台：%v", ref)
	}
	ref = mustCall(t, e.h, "GET", "/api/video/deals/quote-ref?platforms=xiaohongshu", "", 200)
	if ref["avg"] != 0.0 || ref["n"] != 0.0 || ref["value"] != 0.0 {
		t.Fatalf("没数据：%v", ref)
	}
	if code, _ := call(t, e.h, "GET", "/api/video/deals/quote-ref?platforms=weibo", ""); code != 400 {
		t.Fatalf("不认识的平台：%d", code)
	}
}

// 验收：账期到期出现在今日页（已交付没收款、离账期不到 7 天或已过；别的状态、远的不出）
func TestDealDueCard(t *testing.T) {
	e := setup(t)
	addProject(t, e.d, "obj_pj1")
	if _, ok := todayCards(t, e)["video_deal_due"]; ok {
		t.Fatal("没有商单时不出卡片")
	}
	day := func(n int) string { return time.Now().AddDate(0, 0, n).Format(time.DateOnly) }
	add := func(title, status string, due int) string {
		return mustCall(t, e.h, "POST", "/api/video/deals", `{"brand":"远川科技","title":"`+title+`","project_id":"obj_pj1","quote":12000,
			"status":"`+status+`","pay_due":"`+day(due)+`"}`, 201)["id"].(string)
	}
	soon := add("三天后", "delivered", 3)
	late := add("过了两天", "delivered", -2)
	add("还远", "delivered", 20)
	add("已收款", "paid", 1)
	add("制作中", "producing", 1)
	card, ok := todayCards(t, e)["video_deal_due"]
	if !ok || card.Total != 2 || card.Title != "商单账期" {
		t.Fatalf("卡片：%+v", card)
	}
	items := cardItems(t, card)
	if items[0]["id"] != late || items[0]["tone"] != "danger" || items[0]["title"] != "远川科技「过了两天」账期已过 2 天" ||
		items[1]["id"] != soon || items[1]["tone"] != "warn" || items[1]["label"] != "3 天后到账期" ||
		items[1]["sub"] != "已交付待收款 · ¥12,000" || items[1]["link"] != "/projects/obj_pj1/deals?deal="+soon {
		t.Fatalf("条目：%v", items)
	}
	// 收了款就不在了
	mustCall(t, e.h, "PATCH", "/api/video/deals/"+late, `{"status":"paid"}`, 200)
	mustCall(t, e.h, "PATCH", "/api/video/deals/"+soon, `{"status":"paid"}`, 200)
	if _, ok := todayCards(t, e)["video_deal_due"]; ok {
		t.Fatal("都收款了还有卡片")
	}
}

func TestThousands(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 12000: "12,000", 1234567: "1,234,567", -4500: "-4,500"} {
		if got := thousands(n); got != want {
			t.Errorf("thousands(%d) = %s，要 %s", n, got, want)
		}
	}
}
