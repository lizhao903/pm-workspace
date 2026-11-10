// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
)

// 接真的 SOP 插件（VID-03d）：启用后「视频周更」出现在流程库里、能跑到规划检查；复制一份改名；
// 卸载视频插件撤下没改过的模板，复制的副本留着
func TestWeeklyTemplateInRealSOP(t *testing.T) {
	fastSOP(t)
	ctx := context.Background()
	e := setupWith(t, sop.New())
	until(t, "写入内置流程", func() bool { return templateRows(t, e.d) == 1 })
	flow := mustCall(t, e.h, "GET", "/api/sop/flows/"+WeeklyFlowID, "", 200)
	if flow["name"] != "视频周更" || flow["version"] != float64(1) || len(flow["steps"].([]any)) != 8 {
		t.Fatalf("模板：%v", flow)
	}
	fc := &fakeClaude{}
	e.r.SetClaudeRunner(fc)
	v := mustCall(t, e.h, "POST", "/api/video/videos", `{"title":"模板","orientations":["portrait"],"root":"`+t.TempDir()+`"}`, 201)
	vid := v["id"].(string)
	atScript(t, e, vid)
	mustCall(t, e.h, "PUT", "/api/video/videos/"+vid+"/runners/script", `{"type":"skill","ref_id":"sk_video"}`, 200)
	rid := mustCall(t, e.h, "POST", "/api/sop/flows/"+WeeklyFlowID+"/runs", `{"input":{"video_id":"`+vid+`"}}`, 201)["id"].(string)
	untilStep(t, e, rid, "plan", "停在规划检查", waitingStep)
	mustCall(t, e.h, "POST", "/api/sop/runs/"+rid+"/actions", `{"kind":"stop"}`, 200)

	// 复制一份
	body := strings.Replace(weeklyBody(t), `"id":"`+WeeklyFlowID+`"`, `"id":"sop_my_weekly"`, 1)
	body = strings.Replace(body, `"name":"视频周更"`, `"name":"我的视频周更"`, 1)
	mustCall(t, e.h, "POST", "/api/sop/flows", body, 201)

	if err := e.r.Disable(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.r.Uninstall(ctx, "video", plugin.UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, e.h, "GET", "/api/sop/flows/"+WeeklyFlowID, ""); code != 404 {
		t.Fatalf("卸载后模板应当撤下：%d", code)
	}
	mustCall(t, e.h, "GET", "/api/sop/flows/sop_my_weekly", "", 200)
}
