package video

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// atScript 把视频直接放到内容编写（不挂选题），给只关心后面阶段的测试用。
func atScript(t *testing.T, e env, vid string) {
	t.Helper()
	if _, err := e.d.W.Exec(`UPDATE video_videos SET stage = 'script' WHERE id = ? AND stage = 'topic'`, vid); err != nil {
		t.Fatal(err)
	}
}

// pastTopic 挂一个新选题，确认后进内容编写。
func pastTopic(t *testing.T, e env, vid string) string {
	t.Helper()
	tp := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"测试选题","outline":"- 开场\n- 正文"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", "/api/video/videos/"+vid+"/topic", `{"topic_id":"`+tp+`"}`, 200)
	mustCall(t, e.h, "POST", "/api/video/videos/"+vid+"/advance", `{"from":"topic"}`, 200)
	return tp
}

// 验收：新建视频阶段是选题；选定选题后两边回写，确认后进内容编写；换选题时换下来的回到可开拍
func TestTopicStep(t *testing.T) {
	e := setup(t)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"新视频"}`, 201)
	vid := v["id"].(string)
	path := "/api/video/videos/" + vid
	if v["stage"] != "topic" || v["topic_id"] != nil {
		t.Fatalf("新建视频要从选题开始：%v", v)
	}
	if code, out := call(t, e.h, "POST", path+"/advance", `{"from":"topic"}`); code != 400 || errMsg(out) != "先选一个选题或新建一个" {
		t.Fatalf("没挂选题不能往下走：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PATCH", path, `{"topic_id":"tp_x"}`); code != 400 {
		t.Fatalf("PATCH 带 topic_id 要 400：%d %v", code, out)
	}
	a := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"本地跑大模型","angle":"公司不让用在线 AI","platforms":["douyin"],"status":"ready"}`, 201)["id"].(string)
	b := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"AI 做 PPT"}`, 201)["id"].(string)
	for body, want := range map[string]int{`{}`: 400, `{"topic_id":"tp_nope"}`: 400, `{"topic_id":1}`: 400, `{"topic_id":"` + a + `","x":1}`: 400} {
		if code, out := call(t, e.h, "PUT", path+"/topic", body); code != want {
			t.Fatalf("%s 要 %d：%d %v", body, want, code, out)
		}
	}
	res := mustCall(t, e.h, "PUT", path+"/topic", `{"topic_id":"`+a+`"}`, 200)
	v, tp := res["video"].(map[string]any), res["topic"].(map[string]any)
	if v["topic_id"] != a || v["title"] != "本地跑大模型" || !reflect.DeepEqual(v["orientations"], []any{"portrait"}) || v["stage"] != "topic" {
		t.Fatalf("挂上选题后的视频：%v", v)
	}
	if tp["video_id"] != vid || tp["status"] != "made" {
		t.Fatalf("挂上后的选题：%v", tp)
	}
	// 同一个再挂一次不变
	mustCall(t, e.h, "PUT", path+"/topic", `{"topic_id":"`+a+`"}`, 200)
	v = mustCall(t, e.h, "POST", path+"/advance", `{"from":"topic"}`, 200)
	if v["stage"] != "script" {
		t.Fatalf("确认选题后进内容编写：%v", v["stage"])
	}
	// 已经过了选题一步也能换；标题不是默认的就不动
	res = mustCall(t, e.h, "PUT", path+"/topic", `{"topic_id":"`+b+`"}`, 200)
	if v := res["video"].(map[string]any); v["topic_id"] != b || v["title"] != "本地跑大模型" || v["stage"] != "script" {
		t.Fatalf("换选题后的视频：%v", v)
	}
	if old := mustCall(t, e.h, "GET", "/api/video/topics/"+a, "", 200); old["video_id"] != nil || old["status"] != "ready" {
		t.Fatalf("换下来的选题要清 video_id、回到可开拍：%v", old)
	}
	// 别的视频占着的、已放弃的不能挂
	other := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"另一集"}`, 201)["id"].(string)
	if code, out := call(t, e.h, "PUT", "/api/video/videos/"+other+"/topic", `{"topic_id":"`+b+`"}`); code != 409 {
		t.Fatalf("别的视频占着要 409：%d %v", code, out)
	}
	mustCall(t, e.h, "PATCH", "/api/video/topics/"+a, `{"status":"dropped"}`, 200)
	if code, out := call(t, e.h, "PUT", "/api/video/videos/"+other+"/topic", `{"topic_id":"`+a+`"}`); code != 409 {
		t.Fatalf("已放弃的要 409：%d %v", code, out)
	}
	// 摘下选题
	res = mustCall(t, e.h, "PUT", path+"/topic", `{"topic_id":null}`, 200)
	if res["video"].(map[string]any)["topic_id"] != nil || res["topic"] != nil {
		t.Fatalf("摘下选题：%v", res)
	}
	if tb := mustCall(t, e.h, "GET", "/api/video/topics/"+b, "", 200); tb["video_id"] != nil || tb["status"] != "ready" {
		t.Fatalf("摘下来的选题：%v", tb)
	}
	// 系列里的集换成「第 N 集：选题标题」；选题删掉时视频的 topic_id 一起清掉
	sr := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"系列"}`, 201)["id"].(string)
	ep := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 5 集：","series_id":"`+sr+`","episode":5}`, 201)["id"].(string)
	v = mustCall(t, e.h, "PUT", "/api/video/videos/"+ep+"/topic", `{"topic_id":"`+b+`"}`, 200)["video"].(map[string]any)
	if v["title"] != "第 5 集：AI 做 PPT" {
		t.Fatalf("系列里的标题：%v", v["title"])
	}
	mustCall(t, e.h, "DELETE", "/api/video/topics/"+b, "", 200)
	if v := mustCall(t, e.h, "GET", "/api/video/videos/"+ep, "", 200); v["topic_id"] != nil {
		t.Fatalf("选题删掉后 topic_id 要清掉：%v", v)
	}
	// 立项生成的视频带 topic_id，直接在内容编写
	c := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"立项"}`, 201)["id"].(string)
	v = mustCall(t, e.h, "POST", "/api/video/topics/"+c+"/make", `{}`, 201)["video"].(map[string]any)
	if v["topic_id"] != c || v["stage"] != "script" {
		t.Fatalf("立项生成的视频：%v", v)
	}
}

// 0007 以前立项的视频没有 topic_id，读视频时按选题的 video_id 补上
func TestUpgradeTopicLinks(t *testing.T) {
	e := setup(t)
	c := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"老立项"}`, 201)["id"].(string)
	vid := mustCall(t, e.h, "POST", "/api/video/topics/"+c+"/make", `{}`, 201)["video"].(map[string]any)["id"].(string)
	if _, err := e.d.W.Exec(`UPDATE video_videos SET topic_id = NULL WHERE id = ?`, vid); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if err := e.r.Enable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if v := mustCall(t, e.h, "GET", "/api/video/videos/"+vid, "", 200); v["topic_id"] != c {
		t.Fatalf("要按选题补上 topic_id：%v", v)
	}
}

// 验收：稿件正文读写落在工程目录，越界路径 400，升版本后旧版本还在
func TestArtifactContent(t *testing.T) {
	e := setup(t)
	root := t.TempDir()
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"稿子","orientations":["landscape"],"root":"`+root+`"}`, 201)["id"].(string)
	a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"script","variant":"landscape","path":"script-landscape.md","status":"review"}`, 201)
	aid := a["id"].(string)
	cpath := "/api/video/artifacts/" + aid + "/content"
	got := mustCall(t, e.h, "GET", cpath, "", 200)
	if got["exists"] != false || got["content"] != "" || got["version"] != 1.0 || got["path"] != "script-landscape.md" || len(got["versions"].([]any)) != 0 {
		t.Fatalf("还没写过：%v", got)
	}
	// 原地写当前版本
	res := mustCall(t, e.h, "PUT", cpath, `{"content":"# 第一版\n开场"}`, 200)
	if c := res["content"].(map[string]any); c["exists"] != true || c["content"] != "# 第一版\n开场" || res["artifact"].(map[string]any)["version"] != 1.0 {
		t.Fatalf("写第一版：%v", res)
	}
	if b, err := os.ReadFile(filepath.Join(root, "script-landscape.md")); err != nil || string(b) != "# 第一版\n开场" {
		t.Fatalf("文件要落在工程目录：%q %v", b, err)
	}
	// 存成下一版：旧版另存，版本加一、草稿、来源手写
	if code, out := call(t, e.h, "PUT", cpath, `{"content":"第二版","new_version":true,"from":2}`); code != 409 {
		t.Fatalf("from 对不上要 409：%d %v", code, out)
	}
	if code, out := call(t, e.h, "PUT", cpath, `{"content":"  ","new_version":true}`); code != 400 {
		t.Fatalf("空稿不能存新版本：%d %v", code, out)
	}
	res = mustCall(t, e.h, "PUT", cpath, `{"content":"第二版","new_version":true,"from":1}`, 200)
	art := res["artifact"].(map[string]any)
	src := art["source"].(map[string]any)
	if art["version"] != 2.0 || art["status"] != "draft" || src["type"] != "manual" || src["label"] != "手写" {
		t.Fatalf("升版本后的产出物：%v", art)
	}
	if c := res["content"].(map[string]any); c["content"] != "第二版" || !reflect.DeepEqual(c["versions"], []any{1.0}) {
		t.Fatalf("升版本后的正文：%v", c)
	}
	old := mustCall(t, e.h, "GET", cpath+"?version=1", "", 200)
	if old["content"] != "# 第一版\n开场" || old["version"] != 1.0 || old["path"] != ".versions/script-landscape.v1.md" {
		t.Fatalf("旧版本还要在：%v", old)
	}
	if b, err := os.ReadFile(filepath.Join(root, ".versions", "script-landscape.v1.md")); err != nil || string(b) != "# 第一版\n开场" {
		t.Fatalf("旧版本文件：%q %v", b, err)
	}
	for _, q := range []string{"?version=0", "?version=3", "?version=x"} {
		if code, out := call(t, e.h, "GET", cpath+q, ""); code != 400 {
			t.Fatalf("%s 要 400：%d %v", q, code, out)
		}
	}
	// 子目录自动建
	o := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"outline","variant":"landscape","path":"pc/outline.md"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", "/api/video/artifacts/"+o+"/content", `{"content":"## 一"}`, 200)
	if b, err := os.ReadFile(filepath.Join(root, "pc", "outline.md")); err != nil || string(b) != "## 一" {
		t.Fatalf("子目录：%q %v", b, err)
	}

	// 越界：库里的路径越出工程目录、经符号链接指到外面、放在 .versions/ 下，都 400
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("外面"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"../escape.md", "link/secret.md", "link/new/x.md", ".versions/x.md", "/etc/hosts"} {
		if _, err := e.d.W.Exec(`UPDATE video_artifacts SET path = ? WHERE id = ?`, p, o); err != nil {
			t.Fatal(err)
		}
		if code, out := call(t, e.h, "GET", "/api/video/artifacts/"+o+"/content", ""); code != 400 {
			t.Fatalf("读 %s 要 400：%d %v", p, code, out)
		}
		if code, out := call(t, e.h, "PUT", "/api/video/artifacts/"+o+"/content", `{"content":"x"}`); code != 400 {
			t.Fatalf("写 %s 要 400：%d %v", p, code, out)
		}
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Fatal("越界写不能在外面建目录")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret.md")); string(b) != "外面" {
		t.Fatal("外面的文件不能被改")
	}

	// 只认原文、口播稿、大纲；太大的 400
	pr := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"presentation","variant":"landscape","path":"presentation-landscape"}`, 201)["id"].(string)
	if code, out := call(t, e.h, "GET", "/api/video/artifacts/"+pr+"/content", ""); code != 400 || !strings.Contains(errMsg(out), "演示工程") {
		t.Fatalf("演示工程不能读正文：%d %v", code, out)
	}
	big := strings.Repeat("字", maxContent/3+10)
	if code, out := call(t, e.h, "PUT", cpath, `{"content":"`+big+`"}`); code != 400 {
		t.Fatalf("太大要 400：%d %v", code, errMsg(out))
	}
	if err := os.WriteFile(filepath.Join(root, "script-landscape.md"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "GET", cpath, ""); code != 400 {
		t.Fatalf("文件太大要 400：%d %v", code, errMsg(out))
	}
	if code, _ := call(t, e.h, "GET", "/api/video/artifacts/vaf_nope/content", ""); code != 404 {
		t.Fatalf("产出物不存在要 404：%d", code)
	}
}

// 按选题大纲起草：没配执行器用技能，提示词带选题；跑完口播稿、大纲升版本，旧版本另存；选题没大纲记起草失败
func TestDraftFromTopic(t *testing.T) {
	e := setup(t)
	fc := &fakeClaude{}
	e.r.SetClaudeRunner(fc)
	root := t.TempDir()
	vid := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"第 1 集：","orientations":["landscape"],"root":"`+root+`"}`, 201)["id"].(string)
	path := "/api/video/videos/" + vid
	// 没挂选题也没配执行器：409
	atScript(t, e, vid)
	if code, out := call(t, e.h, "POST", path+"/runners/script/run", ""); code != 409 {
		t.Fatalf("没选题没执行器要 409：%d %v", code, out)
	}
	tp := mustCall(t, e.h, "POST", "/api/video/topics", `{"title":"一个人怎么管 30 集"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", path+"/topic", `{"topic_id":"`+tp+`"}`, 200)
	v := mustCall(t, e.h, "POST", path+"/runners/script/run", "", 200)
	if lr := v["last_run"].(map[string]any); lr["status"] != "failed" || !strings.Contains(lr["error"].(string), "还没写大纲") {
		t.Fatalf("没大纲要记起草失败：%v", lr)
	}
	mustCall(t, e.h, "PATCH", "/api/video/topics/"+tp, `{"angle":"系列化","audience":"独立博主","outline":"1. 选题池\n2. 排期"}`, 200)
	// 已有 v1 口播稿：起草前另存，跑完升到 v2
	a := mustCall(t, e.h, "POST", "/api/video/artifacts", `{"video_id":"`+vid+`","kind":"script","variant":"landscape","path":"script-landscape.md"}`, 201)["id"].(string)
	mustCall(t, e.h, "PUT", "/api/video/artifacts/"+a+"/content", `{"content":"我写的 v1"}`, 200)
	mustCall(t, e.h, "POST", path+"/runners/script/run", "", 202)
	v = waitRun(t, e, vid)
	if lr := v["last_run"].(map[string]any); lr["status"] != "done" || lr["stage"] != "script" {
		t.Fatalf("起草：%v", lr)
	}
	p := fc.last().Prompt
	for _, s := range []string{"web-video-presentation", "Phase 1", "一个人怎么管 30 集", "系列化", "独立博主", "1. 选题池", "照选题的角度和大纲"} {
		if !strings.Contains(p, s) {
			t.Fatalf("提示词要有 %q：%s", s, p)
		}
	}
	art := mustCall(t, e.h, "GET", "/api/video/artifacts/"+a, "", 200)
	if art["version"] != 2.0 || art["status"] != "review" || art["source"].(map[string]any)["type"] != "skill" {
		t.Fatalf("起草后的口播稿：%v", art)
	}
	if old := mustCall(t, e.h, "GET", "/api/video/artifacts/"+a+"/content?version=1", "", 200); old["content"] != "我写的 v1" {
		t.Fatalf("起草前的版本要留着：%v", old)
	}
}
