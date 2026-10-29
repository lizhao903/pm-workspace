package video

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// 原型 topicdata.ts 里 Topic、TopicScore、Clip 的字段，Go 结构里都要有；多出的只能是时间和来源出处
func TestTopicFieldsMatchPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "topicdata.ts"))
	if err != nil {
		t.Skip("没有原型 topicdata.ts：", err)
	}
	src := string(b)
	fieldRe := regexp.MustCompile(`(?m)^\s*(\w+)\??:`)
	extra := map[string][]string{"Clip": {"updated_at", "publish_id", "message_id"}}
	for name, v := range map[string]any{"Topic": Topic{}, "TopicScore": TopicScore{}, "Clip": Clip{}} {
		head := "export interface " + name + " {"
		i := strings.Index(src, head)
		if i < 0 {
			t.Fatalf("topicdata.ts 里找不到 interface %s", name)
		}
		body := src[i+len(head):]
		var proto []string
		if nl, end := strings.Index(body, "\n"), strings.Index(body, "}"); end < nl {
			// 单行的 interface
			for _, f := range strings.Split(body[:end], ";") {
				if k, _, ok := strings.Cut(strings.TrimSpace(f), ":"); ok {
					proto = append(proto, strings.TrimSuffix(k, "?"))
				}
			}
		} else {
			for _, m := range fieldRe.FindAllStringSubmatch(body[:strings.Index(body, "\n}")], -1) {
				proto = append(proto, m[1])
			}
		}
		if len(proto) == 0 {
			t.Fatalf("%s 一个字段都没解析出来", name)
		}
		var tags []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			tag, _, _ := strings.Cut(rt.Field(i).Tag.Get("json"), ",")
			tags = append(tags, tag)
		}
		for _, f := range proto {
			if !slices.Contains(tags, f) {
				t.Errorf("%s.%s 原型里有，Go 结构里没有", name, f)
			}
		}
		for _, f := range tags {
			if !slices.Contains(proto, f) && f != "created_at" && f != "updated_at" && !slices.Contains(extra[name], f) {
				t.Errorf("%s.%s Go 结构多出来的，原型里没有", name, f)
			}
		}
	}
}

// 原型种子 tp_01、tp_03、tp_05 和 cl_03 这种全字段的选题、素材都能存能读
func TestTopicClipFieldsRoundTrip(t *testing.T) {
	e := setup(t)
	sr := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"AI 工具"}`, 201)["id"].(string)
	cl := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"competitor","title":"某科技 UP 主：我用 AI 一天写完一个 App","content":"播放 86 万",
		"url":"https://www.bilibili.com/video/BV1demo01","source":"B 站 · 竞品","heat":860000,"tags":["竞品","AI 编程","竞品"," "],"starred":true}`, 201)
	if !strings.HasPrefix(cl["id"].(string), "cl_") || cl["kind"] != "competitor" || cl["url"] != "https://www.bilibili.com/video/BV1demo01" ||
		cl["source"] != "B 站 · 竞品" || cl["heat"] != 860000.0 || !reflect.DeepEqual(cl["tags"], []any{"竞品", "AI 编程"}) || cl["starred"] != true ||
		cl["triaged"] != false || len(cl["topic_ids"].([]any)) != 0 || cl["created_at"] == "" || cl["publish_id"] != nil || cl["message_id"] != nil {
		t.Fatalf("素材：%v", cl)
	}
	clID := cl["id"].(string)
	tp := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"NotebookLM 把文档变播客","angle":"实测中文效果","audience":"不想露声的人","status":"scheduled",
		"planned_at":"2026-11-03T10:00:00+08:00","score":{"demand":4,"fit":4,"effort":2},"tags":["工具更新"],"series_id":"`+sr+`",
		"platforms":["douyin","channels","douyin"],"outline":"1. 生成过程\n2. 效果对比","clip_ids":["`+clID+`"]}`, 201)
	if !strings.HasPrefix(tp["id"].(string), "tp_") || tp["angle"] != "实测中文效果" || tp["audience"] != "不想露声的人" || tp["status"] != "scheduled" ||
		tp["planned_at"] != "2026-11-03T02:00:00Z" || !reflect.DeepEqual(tp["score"], map[string]any{"demand": 4.0, "fit": 4.0, "effort": 2.0}) ||
		!reflect.DeepEqual(tp["tags"], []any{"工具更新"}) || tp["series_id"] != sr || !reflect.DeepEqual(tp["platforms"], []any{"douyin", "channels"}) ||
		tp["outline"] != "1. 生成过程\n2. 效果对比" || !reflect.DeepEqual(tp["clip_ids"], []any{clID}) || tp["video_id"] != nil || tp["drop_reason"] != nil {
		t.Fatalf("选题：%v", tp)
	}
	// 关联上的素材记为已整理，两边互相记着
	cl = mustCall(t, e.h, "GET", "/api/video/clips/"+clID, "", 200)
	if cl["triaged"] != true || !reflect.DeepEqual(cl["topic_ids"], []any{tp["id"]}) {
		t.Fatalf("素材关联：%v", cl)
	}
	// 放弃：带原因；原因传 null 清掉
	dropped := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"用 AI 给老照片上色","status":"dropped","drop_reason":"和账号定位不符","score":{"demand":2,"fit":1,"effort":2}}`, 201)
	if dropped["drop_reason"] != "和账号定位不符" || dropped["score"].(map[string]any)["fit"] != 1.0 {
		t.Fatalf("放弃的选题：%v", dropped)
	}
	dropped = mustCall(t, e.h, "PATCH", "/api/video/topics/"+dropped["id"].(string), `{"drop_reason":null,"planned_at":null}`, 200)
	if dropped["drop_reason"] != nil {
		t.Fatalf("drop_reason 没清：%v", dropped)
	}
	// 新建空选题同原型：标题可空、打分默认 3
	blank := mustCall(t, e.h, "POST", "/api/video/topics", `{}`, 201)
	if blank["title"] != "" || blank["status"] != "idea" || !reflect.DeepEqual(blank["score"], map[string]any{"demand": 3.0, "fit": 3.0, "effort": 3.0}) {
		t.Fatalf("空选题：%v", blank)
	}
	// 粘贴一行：像网址就当链接，标题取网址；否则当笔记，标题取内容；来源默认「手动添加」
	link := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"link","url":"https://blog.google/technology/ai/notebooklm-audio"}`, 201)
	note := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"note","content":"分支里赋的变量在合并节点取不到"}`, 201)
	if link["title"] != "blog.google/technology/ai/notebooklm-audio" || note["title"] != "分支里赋的变量在合并节点取不到" || note["source"] != "手动添加" || note["url"] != nil {
		t.Fatalf("链接 %v 笔记 %v", link, note)
	}
	// IM 消息带消息 id，只存不查
	im := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"im","title":"同事问：周报能不能全自动","source":"Slack · #product","message_id":"msg_01abc"}`, 201)
	if im["message_id"] != "msg_01abc" {
		t.Fatalf("IM 素材：%v", im)
	}
	_, out := call(t, e.h, "GET", "/api/video/clips?message_id=msg_01abc", "")
	if xs := out["data"].([]any); len(xs) != 1 || xs[0].(map[string]any)["id"] != im["id"] {
		t.Fatalf("按消息 id 反查：%v", out)
	}
	// 修改：收藏、看过了、热度清掉
	cl = mustCall(t, e.h, "PATCH", "/api/video/clips/"+clID, `{"starred":false,"heat":null,"title":"改个标题"}`, 200)
	if cl["starred"] != false || cl["heat"] != nil || cl["title"] != "改个标题" || cl["triaged"] != true {
		t.Fatalf("改素材：%v", cl)
	}
}

func listData(t *testing.T, e env, path string) []any {
	t.Helper()
	code, out := call(t, e.h, "GET", path, "")
	if code != 200 {
		t.Fatalf("GET %s：%d %v", path, code, out)
	}
	return out["data"].([]any)
}

func ids(xs []any) []string {
	out := []string{}
	for _, x := range xs {
		out = append(out, x.(map[string]any)["id"].(string))
	}
	return out
}

// 验收：一条评论素材转成选题，选题立项成视频，三者互相能跳
func TestCommentToTopicToVideo(t *testing.T) {
	e := setup(t)
	addProject(t, e.d, "obj_pj")
	sr := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"一人之下"}`, 201)["id"].(string)
	src := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 3 集：Agent 怎么配","series_id":"`+sr+`","episode":3}`, 201)["id"].(string)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+src+`","platform":"bilibili","variant":"landscape","title":"第 3 集"}`, 201)["id"].(string)

	cl := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"comment","title":"能不能讲讲 Agent 怎么接自己公司的系统","content":"MCP 那块看不太懂",
		"source":"B 站评论 · 第 3 集","heat":15400,"tags":["Agent","MCP"],"publish_id":"`+pb+`"}`, 201)
	clID := cl["id"].(string)
	if cl["publish_id"] != pb {
		t.Fatalf("评论要带发布记录 id：%v", cl)
	}
	// 转为选题：标题、大纲、标签带过去，热度过万需求度 4
	res := mustCall(t, e.h, "POST", "/api/video/clips/"+clID+"/topic", `{"series_id":"`+sr+`","platforms":["bilibili","douyin"]}`, 201)
	tp, cl := res["topic"].(map[string]any), res["clip"].(map[string]any)
	tpID := tp["id"].(string)
	if tp["title"] != "能不能讲讲 Agent 怎么接自己公司的系统" || tp["outline"] != "MCP 那块看不太懂" || !reflect.DeepEqual(tp["tags"], []any{"Agent", "MCP"}) ||
		tp["status"] != "idea" || tp["score"].(map[string]any)["demand"] != 4.0 || !reflect.DeepEqual(tp["clip_ids"], []any{clID}) {
		t.Fatalf("转出来的选题：%v", tp)
	}
	if cl["triaged"] != true || !reflect.DeepEqual(cl["topic_ids"], []any{tpID}) {
		t.Fatalf("转选题后的素材：%v", cl)
	}
	// 已做成不能手动选
	if code, out := call(t, e.h, "PATCH", "/api/video/topics/"+tpID, `{"status":"made"}`); code != 400 {
		t.Fatalf("没立项改已做成要 400：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", "/api/video/topics/"+tpID, `{"video_id":"`+src+`"}`); code != 400 {
		t.Fatalf("直接改 video_id 要 400：%d %v", code, out)
	}
	// 立项：系列里接着排第 4 集，比例按平台偏好，工程目录 videos/<选题 id>
	res = mustCall(t, e.h, "POST", "/api/video/topics/"+tpID+"/make", `{"project_id":"obj_pj"}`, 201)
	tp, v := res["topic"].(map[string]any), res["video"].(map[string]any)
	vid := v["id"].(string)
	if tp["status"] != "made" || tp["video_id"] != vid {
		t.Fatalf("立项后的选题：%v", tp)
	}
	if v["title"] != "第 4 集：能不能讲讲 Agent 怎么接自己公司的系统" || v["series_id"] != sr || v["episode"] != 4.0 || v["project_id"] != "obj_pj" ||
		!reflect.DeepEqual(v["orientations"], []any{"landscape", "portrait"}) || v["root"] != "videos/"+tpID || v["chapters"] != 3.0 || v["stage"] != "script" ||
		len(v["checkpoints"].([]any)) != 4 {
		t.Fatalf("立项生成的视频：%v", v)
	}
	if code, out := call(t, e.h, "POST", "/api/video/topics/"+tpID+"/make", `{}`); code != 409 {
		t.Fatalf("重复立项要 409：%d %v", code, out)
	}

	// 互相能跳
	// 素材 -> 选题、选题 -> 素材
	if got := ids(listData(t, e, "/api/video/topics?clip_id="+clID)); !reflect.DeepEqual(got, []string{tpID}) {
		t.Fatalf("素材反查选题：%v", got)
	}
	if got := ids(listData(t, e, "/api/video/clips?topic_id="+tpID)); !reflect.DeepEqual(got, []string{clID}) {
		t.Fatalf("选题反查素材：%v", got)
	}
	// 选题 -> 视频、视频 -> 选题
	mustCall(t, e.h, "GET", "/api/video/videos/"+vid, "", 200)
	if got := ids(listData(t, e, "/api/video/topics?video_id="+vid)); !reflect.DeepEqual(got, []string{tpID}) {
		t.Fatalf("视频反查选题：%v", got)
	}
	// 评论素材 -> 发布记录 -> 视频；发布记录 -> 评论
	if p := mustCall(t, e.h, "GET", "/api/video/publishes/"+pb, "", 200); p["video_id"] != src {
		t.Fatalf("发布记录：%v", p)
	}
	if got := ids(listData(t, e, "/api/video/clips?publish_id="+pb)); !reflect.DeepEqual(got, []string{clID}) {
		t.Fatalf("发布记录反查评论：%v", got)
	}
	// 已做成的选题不能再归素材
	other := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"note","title":"补充"}`, 201)["id"].(string)
	if code, out := call(t, e.h, "POST", "/api/video/clips/"+other+"/link", `{"topic_id":"`+tpID+`"}`); code != 409 {
		t.Fatalf("归到已做成的选题要 409：%d %v", code, out)
	}
	// 视频删掉：选题留着，video_id 清空，可以重新立项
	mustCall(t, e.h, "DELETE", "/api/video/videos/"+vid, "", 200)
	tp = mustCall(t, e.h, "GET", "/api/video/topics/"+tpID, "", 200)
	if tp["video_id"] != nil {
		t.Fatalf("视频删了 video_id 要清空：%v", tp)
	}
	res = mustCall(t, e.h, "POST", "/api/video/topics/"+tpID+"/make", `{}`, 201)
	if res["video"].(map[string]any)["episode"] != 4.0 {
		t.Fatalf("重新立项：%v", res["video"])
	}
	// 发布记录删掉：评论的 publish_id 清空，素材留着
	mustCall(t, e.h, "DELETE", "/api/video/publishes/"+pb, "", 200)
	if c := mustCall(t, e.h, "GET", "/api/video/clips/"+clID, "", 200); c["publish_id"] != nil {
		t.Fatalf("发布记录删了 publish_id 要清空：%v", c)
	}
}

func TestMergeClipIntoTopic(t *testing.T) {
	e := setup(t)
	tp := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"Cursor 和 Claude Code 怎么选","status":"ready"}`, 201)["id"].(string)
	a := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"trend","title":"AI 编程助手对比搜索量涨 3 倍","heat":21000}`, 201)["id"].(string)
	b := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"comment","title":"能讲讲怎么选吗"}`, 201)["id"].(string)
	if n := len(listData(t, e, "/api/video/clips?box=todo")); n != 2 {
		t.Fatalf("待整理要 2 条：%d", n)
	}
	res := mustCall(t, e.h, "POST", "/api/video/clips/"+a+"/link", `{"topic_id":"`+tp+`"}`, 200)
	mustCall(t, e.h, "POST", "/api/video/clips/"+b+"/link", `{"topic_id":"`+tp+`"}`, 200)
	res = mustCall(t, e.h, "POST", "/api/video/clips/"+a+"/link", `{"topic_id":"`+tp+`"}`, 200)
	if got := res["topic"].(map[string]any)["clip_ids"]; !reflect.DeepEqual(got, []any{a, b}) {
		t.Fatalf("并入后按关联先后排、不重复：%v", got)
	}
	_, out := call(t, e.h, "GET", "/api/video/clips?box=todo", "")
	if len(out["data"].([]any)) != 0 || out["meta"].(map[string]any)["todo"] != 0.0 {
		t.Fatalf("并入后都算已整理：%v", out)
	}
	// 选题这边取消关联：素材留着，仍是已整理
	topic := mustCall(t, e.h, "PATCH", "/api/video/topics/"+tp, `{"clip_ids":["`+b+`"]}`, 200)
	if !reflect.DeepEqual(topic["clip_ids"], []any{b}) {
		t.Fatalf("取消关联：%v", topic)
	}
	if c := mustCall(t, e.h, "GET", "/api/video/clips/"+a, "", 200); len(c["topic_ids"].([]any)) != 0 || c["triaged"] != true {
		t.Fatalf("取消关联后的素材：%v", c)
	}
	// 删选题：素材留着
	mustCall(t, e.h, "DELETE", "/api/video/topics/"+tp, "", 200)
	if c := mustCall(t, e.h, "GET", "/api/video/clips/"+b, "", 200); len(c["topic_ids"].([]any)) != 0 {
		t.Fatalf("删选题后的素材：%v", c)
	}
	// 删素材：选题里的关联跟着没了
	tp2 := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"x","clip_ids":["`+a+`"]}`, 201)["id"].(string)
	mustCall(t, e.h, "DELETE", "/api/video/clips/"+a, "", 200)
	if got := mustCall(t, e.h, "GET", "/api/video/topics/"+tp2, "", 200)["clip_ids"]; len(got.([]any)) != 0 {
		t.Fatalf("删素材后选题关联：%v", got)
	}
}

func TestTopicClipValidation(t *testing.T) {
	e := setup(t)
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"v"}`, 201)["id"].(string)
	pb := mustCall(t, e.h, "POST", "/api/video/publishes", `{"video_id":"`+vid+`","platform":"youtube","variant":"landscape","title":"t"}`, 201)["id"].(string)
	tp := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"t"}`, 201)["id"].(string)
	cl := mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"note","title":"n"}`, 201)["id"].(string)
	dropped := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"d","status":"dropped"}`, 201)["id"].(string)
	for _, c := range []struct {
		method, path, body string
		want               int
	}{
		{"POST", "/api/video/topics", `{"status":"maybe"}`, 400},
		{"POST", "/api/video/topics", `{"score":{"demand":6,"fit":3,"effort":3}}`, 400},
		{"POST", "/api/video/topics", `{"score":{"demand":3,"x":1}}`, 400},
		{"POST", "/api/video/topics", `{"platforms":["weibo"]}`, 400},
		{"POST", "/api/video/topics", `{"series_id":"sr_nope"}`, 400},
		{"POST", "/api/video/topics", `{"clip_ids":["cl_nope"]}`, 400},
		{"POST", "/api/video/topics", `{"planned_at":"明天"}`, 400},
		{"POST", "/api/video/topics", `{"status":"made"}`, 400},
		{"POST", "/api/video/topics", `{"nope":1}`, 400},
		{"GET", "/api/video/topics?status=maybe", ``, 400},
		{"GET", "/api/video/topics/tp_nope", ``, 404},
		{"POST", "/api/video/topics/tp_nope/make", `{}`, 404},
		{"POST", "/api/video/topics/" + dropped + "/make", `{}`, 409},
		{"POST", "/api/video/topics", `{"title":""}`, 201},
		{"POST", "/api/video/topics/" + tp + "/make", `{"project_id":"obj_nope"}`, 400},
		{"POST", "/api/video/clips", `{"title":"x"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"tweet","title":"x"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"note"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"link","url":"ftp://x"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"note","title":"x","heat":-1}`, 400},
		{"POST", "/api/video/clips", `{"kind":"note","title":"x","publish_id":"` + pb + `"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"comment","title":"x","publish_id":"pb_nope"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"note","title":"x","message_id":"msg_1"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"im","title":"x","message_id":"a b"}`, 400},
		{"POST", "/api/video/clips", `{"kind":"note","title":"x","starred":"yes"}`, 400},
		{"PATCH", "/api/video/clips/" + cl, `{"kind":"link"}`, 400},
		{"PATCH", "/api/video/clips/" + cl, `{"topic_ids":[]}`, 400},
		{"PATCH", "/api/video/clips/" + cl, `{"title":""}`, 400},
		{"GET", "/api/video/clips?box=x", ``, 400},
		{"GET", "/api/video/clips?kind=x", ``, 400},
		{"GET", "/api/video/clips/cl_nope", ``, 404},
		{"POST", "/api/video/clips/" + cl + "/link", `{}`, 400},
		{"POST", "/api/video/clips/" + cl + "/link", `{"topic_id":"tp_nope"}`, 400},
		{"POST", "/api/video/clips/" + cl + "/link", `{"topic_id":"` + dropped + `"}`, 409},
		{"POST", "/api/video/clips/" + cl + "/topic", `{"clip_ids":[]}`, 400},
		{"POST", "/api/video/clips/cl_nope/topic", `{}`, 404},
	} {
		if code, out := call(t, e.h, c.method, c.path, c.body); code != c.want {
			t.Errorf("%s %s %s：要 %d，实际 %d %v", c.method, c.path, c.body, c.want, code, out)
		}
	}
	// 搜索：标题、内容、来源、标签都搜得到；% 不当通配符
	mustCall(t, e.h, "POST", "/api/video/clips", `{"kind":"trend","title":"AI 做 PPT","content":"抖音热榜第 14","source":"抖音热榜","tags":["办公"]}`, 201)
	for q, n := range map[string]int{"ppt": 1, "热榜第": 1, "抖音热榜": 1, "办公": 1, "100%": 0} {
		if got := len(listData(t, e, "/api/video/clips?q="+strings.ReplaceAll(q, "%", "%25"))); got != n {
			t.Errorf("搜 %q 要 %d 条，实际 %d", q, n, got)
		}
	}
	// 系列删掉：选题的 series_id 清空
	sr := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"s"}`, 201)["id"].(string)
	mustCall(t, e.h, "PATCH", "/api/video/topics/"+tp, `{"series_id":"`+sr+`"}`, 200)
	mustCall(t, e.h, "DELETE", "/api/video/series/"+sr, "", 200)
	if got := mustCall(t, e.h, "GET", "/api/video/topics/"+tp, "", 200); got["series_id"] != nil {
		t.Fatalf("系列删了 series_id 要清空：%v", got)
	}
	// 不在系列里立项：标题不加集数，没选平台用横屏
	v := mustCall(t, e.h, "POST", "/api/video/topics/"+tp+"/make", `{}`, 201)["video"].(map[string]any)
	if v["title"] != "t" || v["episode"] != nil || !reflect.DeepEqual(v["orientations"], []any{"landscape"}) {
		t.Fatalf("单集立项：%v", v)
	}
}
