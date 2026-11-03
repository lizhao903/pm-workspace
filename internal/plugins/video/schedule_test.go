package video

import (
	"context"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// biliExtra 是 setupBilibili 额外装进注册表的插件（要在 Start 之前加）。
var biliExtra []plugin.Plugin

// coreProbe 只为拿到一个 Core，从它调别的插件登记的 SOP 节点。
type coreProbe struct{ c plugin.Core }

var probeManifest = plugin.MustParse([]byte(`{"id":"probe","name":"探针","version":"0.1.0","core":">=1.0.0 <2.0.0",
	"provides":{"modules":[],"settings":[],"object_types":[],"connectors":[],"skills":[],"agent_tools":[],"sop_nodes":[],"today_cards":[],"commands":[],"search":[]},
	"emits":[],"subscribes":[],"permissions":[]}`))

func (p *coreProbe) Manifest() plugin.Manifest         { return probeManifest }
func (p *coreProbe) Migrations() fs.FS                 { return nil }
func (p *coreProbe) Register(r plugin.Registrar) error { p.c = r.Core(); return nil }

type fakeNotifier struct {
	mu  sync.Mutex
	got []plugin.Notification
}

func (f *fakeNotifier) NotifyFromPlugin(_ context.Context, n plugin.Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, n)
	return nil
}

func (f *fakeNotifier) list() []plugin.Notification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]plugin.Notification(nil), f.got...)
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("等不到：%s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func publishStatus(t *testing.T, e biliEnv, id string) map[string]any {
	t.Helper()
	return mustCall(t, e.h, "GET", "/api/video/publishes/"+id, "", 200)
}

// 定时发布：到点前不动，到点由后台任务投稿，状态变为已发布；改时间、删发布不用另外同步
func TestScheduledPublishFires(t *testing.T) {
	old := publishDueEvery
	publishDueEvery = 50 * time.Millisecond
	t.Cleanup(func() { publishDueEvery = old })
	e := setupBilibili(t)
	n := &fakeNotifier{}
	e.r.SetNotifier(n)
	e.addConnector(t, biliGoodToken)
	_, pb := e.publishable(t, []byte("0123456789abcdefghij"))

	at := time.Now().Add(2 * time.Second).UTC().Format(time.RFC3339)
	p := mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"status":"scheduled","scheduled_at":"`+at+`","tags":["效率"],"category":"201"}`, 200)
	if p["status"] != "scheduled" {
		t.Fatalf("定时：%v", p)
	}
	time.Sleep(300 * time.Millisecond)
	if p := publishStatus(t, e, pb); p["status"] != "scheduled" || p["url"] != nil {
		t.Fatalf("没到点就发了：%v", p)
	}
	waitUntil(t, "到点发布", func() bool { return publishStatus(t, e, pb)["status"] == "published" })
	p = publishStatus(t, e, pb)
	if p["url"] != "https://www.bilibili.com/video/BV1Te5tTst01" || p["published_at"] == nil || p["error"] != nil {
		t.Fatalf("发布后：%v", p)
	}
	if len(n.list()) != 0 {
		t.Fatalf("成功不发通知：%v", n.list())
	}
	// 再跑一轮也不会重投
	calls := len(e.fake.calls)
	time.Sleep(200 * time.Millisecond)
	if len(e.fake.calls) != calls {
		t.Fatalf("发过的又投了一次：%v", e.fake.calls)
	}

	// 改到很久以后：到时间才发；删掉的不会再发
	_, pb2 := e.publishable(t, []byte("abc"))
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb2, `{"status":"scheduled","scheduled_at":"`+later+`","tags":["效率"],"category":"201"}`, 200)
	time.Sleep(200 * time.Millisecond)
	if p := publishStatus(t, e, pb2); p["status"] != "scheduled" {
		t.Fatalf("一小时以后的提前发了：%v", p)
	}
	mustCall(t, e.h, "DELETE", "/api/video/publishes/"+pb2, "", 200)
	if code, _ := call(t, e.h, "GET", "/api/video/publishes/"+pb2, ""); code != 404 {
		t.Fatalf("删掉的还在：%d", code)
	}
}

// 平台报错：发布记录置为失败、带原因，发一条通知；投之前就过不了的（没有成片）也一样
func TestScheduledPublishFailureNotifies(t *testing.T) {
	old := publishDueEvery
	publishDueEvery = 50 * time.Millisecond
	t.Cleanup(func() { publishDueEvery = old })
	e := setupBilibili(t)
	n := &fakeNotifier{}
	e.r.SetNotifier(n)
	e.addConnector(t, biliGoodToken)
	e.fake.set(func(f *fakeBilibili) { f.rejectAdd = true })
	vid, pb := e.publishable(t, []byte("0123456789"))

	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"status":"scheduled","scheduled_at":"`+past+`","tags":["效率"],"category":"201"}`, 200)
	waitUntil(t, "发布失败", func() bool { return publishStatus(t, e, pb)["status"] == "failed" })
	p := publishStatus(t, e, pb)
	if msg, _ := p["error"].(string); msg == "" {
		t.Fatalf("失败要带原因：%v", p)
	}
	waitUntil(t, "失败通知", func() bool { return len(n.list()) == 1 })
	got := n.list()[0]
	if got.Kind != "video.publish_failed" || got.Level != plugin.NotifyError || !strings.Contains(got.Title, "定时发布失败") ||
		!strings.Contains(got.Body, "B 站") || strings.Contains(got.Body, "B 站：B 站") || got.Data["publish_id"] != pb || got.Data["video_id"] != vid || got.Data["source"] != "video" {
		t.Fatalf("通知：%+v", got)
	}
	// 失败的不再重试，也不再发通知
	time.Sleep(200 * time.Millisecond)
	if len(n.list()) != 1 {
		t.Fatalf("失败后又发了通知：%v", n.list())
	}

	// 没有成片的：投之前就失败，同样置为失败、发通知
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"空的","orientations":["landscape"]}`, 201)
	pb3 := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+v["id"].(string)+`","platform":"bilibili","variant":"landscape","title":"空的一集","tags":["效率"],"category":"201"}`, 201)["id"].(string)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb3, `{"status":"scheduled","scheduled_at":"`+past+`"}`, 200)
	waitUntil(t, "没有成片的失败", func() bool { return publishStatus(t, e, pb3)["status"] == "failed" })
	if msg, _ := publishStatus(t, e, pb3)["error"].(string); !strings.Contains(msg, "成片") {
		t.Fatalf("原因：%q", msg)
	}
	waitUntil(t, "第二条通知", func() bool { return len(n.list()) == 2 })
}

// 定时任务动作 video_publish：校验 publish_id，执行时交给常驻任务投稿
func TestPublishScheduleAction(t *testing.T) {
	e := setupBilibili(t)
	e.r.SetNotifier(&fakeNotifier{})
	e.addConnector(t, biliGoodToken)
	_, pb := e.publishable(t, []byte("0123456789"))
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"tags":["效率"],"category":"201"}`, 200)
	ctx := context.Background()
	if _, err := e.r.ValidateScheduleAction(ctx, ActionPublish, map[string]any{"publish_id": "pb_none"}); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("不存在的发布要报错：%v", err)
	}
	if _, err := e.r.ValidateScheduleAction(ctx, ActionPublish, map[string]any{"publish_id": pb, "x": 1}); err == nil {
		t.Fatal("多余参数要报错")
	}
	params, err := e.r.ValidateScheduleAction(ctx, ActionPublish, map[string]any{"publish_id": " " + pb + " "})
	if err != nil || params["publish_id"] != pb {
		t.Fatalf("校验：%v %v", params, err)
	}
	res, err := e.r.RunScheduleAction(ctx, plugin.ScheduleActionInput{Kind: ActionPublish, RunID: "srun_1", At: time.Now(), Params: params})
	if err != nil || !strings.Contains(res.Text, "开始发布") {
		t.Fatalf("执行：%+v %v", res, err)
	}
	waitUntil(t, "定时任务交过来的发布", func() bool { return publishStatus(t, e, pb)["status"] == "published" })
	res, err = e.r.RunScheduleAction(ctx, plugin.ScheduleActionInput{Kind: ActionPublish, RunID: "srun_2", At: time.Now(), Params: params})
	if err != nil || !strings.Contains(res.Text, "已经发布过了") {
		t.Fatalf("再执行一次：%+v %v", res, err)
	}
}

// SOP 节点 video_publish 当场投稿，输出发布记录
func TestPublishSOPNode(t *testing.T) {
	probe := &coreProbe{}
	biliExtra = []plugin.Plugin{probe}
	e := setupBilibili(t)
	biliExtra = nil
	if err := e.r.Install(context.Background(), "probe", nil); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(context.Background(), "probe"); err != nil {
		t.Fatal(err)
	}
	e.r.SetNotifier(&fakeNotifier{})
	e.addConnector(t, biliGoodToken)
	_, pb := e.publishable(t, []byte("0123456789"))
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+pb, `{"tags":["效率"],"category":"201"}`, 200)
	ctx := context.Background()
	sop := probe.c.SOP()
	in := plugin.SOPNodeInput{RunID: "sr_1", Step: "s1", Attempt: 1, Input: map[string]any{"pb": pb}, Config: map[string]string{"publish": "{{pb}}"}}
	out, err := sop.RunNode(ctx, NodePublish, in)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := out["publish"].(map[string]any)
	if got["publish_id"] != pb || got["status"] != "published" || got["url"] == "" {
		t.Fatalf("输出：%v", out)
	}
	in.Config["publish"] = "pb_none"
	if _, err := sop.RunNode(ctx, NodePublish, in); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("不存在的发布：%v", err)
	}
}

func ptr(s string) *string { return &s }

func TestCalendarItems(t *testing.T) {
	today := "2026-10-29"
	ch1 := func(state string) []Checkpoint {
		return []Checkpoint{{Stage: "plan", State: "passed"}, {Stage: "ch1", State: state}, {Stage: "audio", State: "pending"}, {Stage: "distribution", State: "pending"}}
	}
	videos := []Video{
		{ID: "vd1", Title: "落后的", Stage: "web", Checkpoints: ch1("pending"), TargetDate: ptr("2026-11-03")},
		{ID: "vd2", Title: "第一章过了", Stage: "chapters", Checkpoints: ch1("passed"), TargetDate: ptr("2026-11-01")},
		{ID: "vd3", Title: "还早", Stage: "script", Checkpoints: ch1("pending"), TargetDate: ptr("2026-11-20")},
		{ID: "vd4", Title: "做完了", Stage: "distribution", Checkpoints: []Checkpoint{{Stage: "plan", State: "passed"}, {Stage: "ch1", State: "passed"},
			{Stage: "audio", State: "passed"}, {Stage: "distribution", State: "passed"}}, TargetDate: ptr("2026-10-20")},
		{ID: "vd5", Title: "没排日子", Stage: "script", Checkpoints: ch1("pending")},
		{ID: "vd6", Title: "已经过了", Stage: "web", Checkpoints: ch1("pending"), TargetDate: ptr("2026-10-25")},
	}
	pubs := []Publish{
		{ID: "pb1", VideoID: "vd1", Platform: "bilibili", Title: "定时的", Status: "scheduled", ScheduledAt: ptr("2026-11-02T02:00:00Z")},
		{ID: "pb2", VideoID: "vd4", Platform: "youtube", Status: "published", PublishedAt: ptr("2026-10-21T03:00:00Z"), ScheduledAt: ptr("2026-10-01T00:00:00Z")},
		{ID: "pb3", VideoID: "vd1", Platform: "douyin", Title: "失败的", Status: "failed", ScheduledAt: ptr("2026-11-02T01:00:00Z")},
		{ID: "pb4", VideoID: "vd1", Platform: "bilibili", Title: "没日期", Status: "planned"},
		{ID: "pb5", VideoID: "vd1", Platform: "bilibili", Title: "范围外", Status: "planned", ScheduledAt: ptr("2027-01-01T01:00:00Z")},
	}
	items := calendarItems(videos, pubs, today, "2026-10-01", "2026-11-30")
	by := map[string]CalendarItem{}
	for _, it := range items {
		by[it.RefID] = it
	}
	if len(items) != 8 {
		t.Fatalf("条数：%+v", items)
	}
	if _, ok := by["pb4"]; ok {
		t.Fatal("没日期的发布不上日历")
	}
	if _, ok := by["pb5"]; ok {
		t.Fatal("范围外的不返回")
	}
	if it := by["vd1"]; it.Kind != "target" || !it.Behind || it.Tone != "danger" || !it.Movable {
		t.Fatalf("落后：%+v", it)
	}
	if it := by["vd6"]; !it.Behind {
		t.Fatalf("过了首发日还没过第一章也算落后：%+v", it)
	}
	if it := by["vd2"]; it.Behind || it.Tone != "muted" {
		t.Fatalf("第一章过了不算落后：%+v", it)
	}
	if it := by["vd3"]; it.Behind {
		t.Fatalf("还有 22 天不算落后：%+v", it)
	}
	if it := by["vd4"]; it.Behind || it.Tone != "ok" || it.Movable {
		t.Fatalf("做完了：%+v", it)
	}
	if it := by["pb2"]; it.At != "2026-10-21T03:00:00Z" || it.Tone != "ok" || it.Movable || it.Label != "做完了" {
		t.Fatalf("已发布按发布时间、没标题用视频标题：%+v", it)
	}
	if it := by["pb3"]; it.Tone != "danger" || it.Movable || it.Platform != "douyin" {
		t.Fatalf("失败：%+v", it)
	}
	if it := by["pb1"]; it.Tone != "muted" || !it.Movable || it.Status != "scheduled" {
		t.Fatalf("定时：%+v", it)
	}
	for i := 1; i < len(items); i++ {
		if items[i-1].Date > items[i].Date {
			t.Fatalf("没按日期排：%+v", items)
		}
	}
}

// 日历接口：按月、周、起止日查，计划首发日带落后标记；target_date 能存能清
func TestCalendarAPI(t *testing.T) {
	e := setup(t)
	today := time.Now()
	soon := today.AddDate(0, 0, 3).Format(time.DateOnly)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"赶不上","orientations":["landscape"],"target_date":"`+soon+`"}`, 201)
	if v["target_date"] != soon {
		t.Fatalf("target_date：%v", v)
	}
	vid := v["id"].(string)
	if code, out := call(t, e.h, "PATCH", "/api/video/videos/"+vid, `{"target_date":"11/03"}`); code != 400 {
		t.Fatalf("日期格式不对要 400：%d %v", code, out)
	}
	at := today.AddDate(0, 0, 2).UTC().Format(time.RFC3339)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"channels","variant":"landscape","title":"周三首发","scheduled_at":"`+at+`"}`, 201)["id"].(string)

	_, out := call(t, e.h, "GET", "/api/video/calendar?from="+today.Format(time.DateOnly)+"&to="+today.AddDate(0, 0, 10).Format(time.DateOnly), "")
	items, _ := out["data"].([]any)
	meta, _ := out["meta"].(map[string]any)
	if len(items) != 2 || meta["behind"] != 1.0 || meta["late_days"] != float64(LateDays) {
		t.Fatalf("日历：%v", out)
	}
	var target, pub map[string]any
	for _, x := range items {
		m := x.(map[string]any)
		switch m["kind"] {
		case "target":
			target = m
		case "publish":
			pub = m
		}
	}
	if target["ref_id"] != vid || target["behind"] != true || target["tone"] != "danger" || target["date"] != soon {
		t.Fatalf("首发日：%v", target)
	}
	if pub["ref_id"] != pb || pub["status"] != "planned" || pub["platform"] != "channels" || pub["movable"] != true {
		t.Fatalf("发布：%v", pub)
	}
	// 按周、按月：soon 所在的那一周和那个月都有它
	for _, q := range []string{"week=" + soon, "month=" + soon[:7]} {
		_, out := call(t, e.h, "GET", "/api/video/calendar?"+q, "")
		found := false
		for _, x := range out["data"].([]any) {
			if m := x.(map[string]any); m["kind"] == "target" && m["ref_id"] == vid {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s 里没有首发日：%v", q, out)
		}
	}
	_, out = call(t, e.h, "GET", "/api/video/calendar?week=2026-10-29", "")
	if m := out["meta"].(map[string]any); m["from"] != "2026-10-26" || m["to"] != "2026-11-01" {
		t.Fatalf("周从周一起：%v", m)
	}
	_, out = call(t, e.h, "GET", "/api/video/calendar?month=2026-02", "")
	if m := out["meta"].(map[string]any); m["from"] != "2026-02-01" || m["to"] != "2026-02-28" {
		t.Fatalf("月：%v", m)
	}
	for _, q := range []string{"month=2026-13", "week=x", "from=2026-01-01", "from=2026-03-01&to=2026-01-01", "from=2026-01-01&to=2026-12-31", "month=2026-01&week=2026-01-01"} {
		if code, out := call(t, e.h, "GET", "/api/video/calendar?"+q, ""); code != 400 {
			t.Fatalf("%s 要 400：%d %v", q, code, out)
		}
	}
	// 第一章验收过了就不落后；清掉首发日就不上日历
	mustCall(t, e.h, "PATCH", "/api/video/videos/"+vid, `{"target_date":null}`, 200)
	_, out = call(t, e.h, "GET", "/api/video/calendar?week="+soon, "")
	for _, x := range out["data"].([]any) {
		if x.(map[string]any)["kind"] == "target" {
			t.Fatalf("清掉的首发日还在：%v", out)
		}
	}
}
