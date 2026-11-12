// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 插件卡片按 key 取出，items 转成 JSON 再解回来（和接口层的序列化一致）
func todayCards(t *testing.T, e env) map[string]plugin.TodayCard {
	t.Helper()
	out := map[string]plugin.TodayCard{}
	for _, c := range e.r.TodayCards(context.Background()) {
		if c.Plugin == "video" {
			out[c.Key] = c
		}
	}
	return out
}

func cardItems(t *testing.T, c plugin.TodayCard) []map[string]any {
	t.Helper()
	b, err := json.Marshal(c.Items)
	if err != nil {
		t.Fatal(err)
	}
	var xs []map[string]any
	if err := json.Unmarshal(b, &xs); err != nil {
		t.Fatal(err)
	}
	return xs
}

// 验收：三张卡片的数据和视频接口一致；停用视频插件后聚合里没有它们
func TestTodayCards(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	if got := todayCards(t, e); len(got) != 0 {
		t.Fatalf("没有数据时不出卡片：%v", got)
	}

	// a 停在规划检查（pending），b 被退回，c 还在内容编写（不算）
	newVideo := func(title string) string {
		id := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"`+title+`","orientations":["landscape"]}`, 201)["id"].(string)
		pastTopic(t, e, id)
		return id
	}
	a, b, c := newVideo("甲"), newVideo("乙"), newVideo("丙")
	mustCall(t, e.h, "POST", "/api/video/videos/"+a+"/advance", `{}`, 200)
	mustCall(t, e.h, "POST", "/api/video/videos/"+b+"/advance", `{}`, 200)
	mustCall(t, e.h, "POST", "/api/video/videos/"+b+"/checkpoints/plan", `{"state":"rejected","note":"比例再想想"}`, 200)
	art := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+c+`","kind":"script","variant":"landscape","path":"pc/script.md","status":"review"}`, 201)["id"].(string)
	mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+c+`","kind":"video","variant":"landscape","path":"pc/out.mp4","status":"draft"}`, 201)

	now := time.Now().UTC()
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	pub := func(title, extra string) string {
		return mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+a+`","platform":"bilibili","variant":"landscape","title":"`+title+`",`+extra+`}`, 201)["id"].(string)
	}
	soon := pub("今晚", `"status":"scheduled","scheduled_at":"`+at(3*time.Hour)+`"`)
	late := pub("过点", `"status":"scheduled","scheduled_at":"`+at(-time.Hour)+`"`)
	pub("后天", `"status":"scheduled","scheduled_at":"`+at(48*time.Hour)+`"`)
	pub("计划", `"status":"planned"`)
	failed := pub("失败", `"status":"failed","error":"封面比例不对"`)

	cards := todayCards(t, e)
	if len(cards) != 3 {
		t.Fatalf("要三张卡片：%v", cards)
	}

	// 待验收：和视频接口的检查点状态、产出物状态一致
	w := cards["video_waiting"]
	if w.Title != "视频待验收" || w.Total != 3 {
		t.Fatalf("video_waiting：%+v", w)
	}
	got := map[string]map[string]any{}
	for _, it := range cardItems(t, w) {
		got[it["video_id"].(string)+"/"+it["kind"].(string)] = it
	}
	for _, id := range []string{a, b} {
		v := mustCall(t, e.h, "GET", "/api/video/videos/"+id, "", 200)
		it := got[id+"/checkpoint"]
		cp := cpState(v, v["stage"].(string))
		if it == nil || it["stage"] != v["stage"] || it["state"] != cp["state"] || it["video_title"] != v["title"] || it["link"] != "/videos/v/"+id {
			t.Fatalf("检查点条目 %s：%v，视频接口 %v", id, it, v)
		}
	}
	if got[a+"/checkpoint"]["label"] != "待规划检查" || got[b+"/checkpoint"]["label"] != "退回修改" || got[b+"/checkpoint"]["note"] != "比例再想想" {
		t.Fatalf("检查点文案：%v %v", got[a+"/checkpoint"], got[b+"/checkpoint"])
	}
	if got[c+"/checkpoint"] != nil {
		t.Fatalf("内容编写阶段不算待验收：%v", got[c+"/checkpoint"])
	}
	ai := got[c+"/artifact"]
	ag := mustCall(t, e.h, "GET", "/api/video/artifacts/"+art, "", 200)
	if ai == nil || ai["artifact_id"] != art || ag["status"] != "review" || ai["artifact_name"] != ag["name"] || ai["link"] != "/videos/v/"+c+"/artifacts?a="+art {
		t.Fatalf("产出物条目：%v，产出物接口 %v", ai, ag)
	}

	// 待发布：24 小时内（含过点没发出的），定时早的在前；后天的、计划中的不算
	s := cardItems(t, cards["video_scheduled"])
	if cards["video_scheduled"].Total != 2 || len(s) != 2 || s[0]["id"] != late || s[1]["id"] != soon {
		t.Fatalf("video_scheduled：%+v", cards["video_scheduled"])
	}
	p := mustCall(t, e.h, "GET", "/api/video/publishes/"+soon, "", 200)
	if s[1]["scheduled_at"] != p["scheduled_at"] || s[1]["title"] != p["title"] || s[1]["platform"] != p["platform"] ||
		s[1]["platform_label"] != "B 站" || s[1]["video_title"] != "甲" || s[1]["link"] != "/videos/v/"+a+"?p="+soon {
		t.Fatalf("待发布条目：%v，发布接口 %v", s[1], p)
	}

	// 发布失败：带平台给的原因
	f := cardItems(t, cards["video_failed"])
	if cards["video_failed"].Total != 1 || len(f) != 1 || f[0]["id"] != failed || f[0]["error"] != "封面比例不对" || f[0]["status"] != "failed" {
		t.Fatalf("video_failed：%+v", cards["video_failed"])
	}

	// 处理掉之后卡片跟着变：通过检查点、产出物定稿、失败的改回计划
	mustCall(t, e.h, "POST", "/api/video/videos/"+a+"/checkpoints/plan", `{"state":"passed"}`, 200)
	mustCall(t, e.h, "PATCH", "/api/video/artifacts/"+art, `{"status":"final"}`, 200)
	mustCall(t, e.h, "PATCH", "/api/video/publishes/"+failed, `{"status":"planned","error":""}`, 200)
	cards = todayCards(t, e)
	if w := cards["video_waiting"]; w.Total != 1 || cardItems(t, w)[0]["video_id"] != b {
		t.Fatalf("处理后 video_waiting：%+v", w)
	}
	if _, ok := cards["video_failed"]; ok {
		t.Fatalf("没有失败的发布就不出卡片：%+v", cards["video_failed"])
	}

	// 停用后聚合里没有，再启用回来
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if got := todayCards(t, e); len(got) != 0 {
		t.Fatalf("停用后不该有视频卡片：%v", got)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if got := todayCards(t, e); len(got) != 2 {
		t.Fatalf("启用后卡片回来：%v", got)
	}
}
