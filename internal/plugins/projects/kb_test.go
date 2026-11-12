// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/api"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// kbEnv 起一个完整服务：项目插件、SOP 插件、定时任务，知识库走内核接口层（TSK-0721）。
func kbEnv(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	reg := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), log)
	reg.Migrations = plugin.NewSQLMigrationStore(st.DB())
	reg.SetSOPSchedules(schedule.New(st.DB(), time.UTC))
	for _, p := range []plugin.Plugin{New(), sop.New()} {
		if err := reg.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := reg.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reg.Close)
	s := api.New(st, api.Options{Version: "test", Logger: log, Plugins: reg})
	for id, perms := range map[string]string{"sop": `["network:any","fs:write:project","process:spawn"]`, "projects": `["process:spawn"]`} {
		if code, out := call(t, s, "POST", "/api/plugins/"+id+"/install", `{"permissions":`+perms+`}`); code != 200 {
			t.Fatalf("安装 %s：%d %v", id, code, out)
		}
		if code, out := call(t, s, "POST", "/api/plugins/"+id+"/enable", `{}`); code != 200 {
			t.Fatalf("启用 %s：%d %v", id, code, out)
		}
	}
	root, err := os.MkdirTemp("/tmp", "pmw-pjkb-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	root, _ = filepath.EvalSymlinks(root)
	code, out := call(t, s, "POST", "/api/agent-providers", `{"name":"本机","kind":"ollama","model":"llama3"}`)
	if code != 201 {
		t.Fatalf("建服务商：%d %v", code, out)
	}
	return s, root, dataOf(out)["id"].(string)
}

func mustWrite(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func dataOf(out map[string]any) map[string]any { m, _ := out["data"].(map[string]any); return m }

func num(m map[string]any, k string) int { f, _ := m[k].(float64); return int(f) }

// 项目资料同步到知识库：没绑时新建并绑定；各类来源收进来；增量新增、更新、移除，只动自己加的；
// 换绑、解绑；内置流程写进 SOP、定时任务是停用的，手动发起跑通。
func TestProjectKBSync(t *testing.T) {
	h, root, prov := kbEnv(t)
	mustWrite(t, filepath.Join(root, "repo/docs/设计.md"), "# 设计\n首页改版方案")
	mustWrite(t, filepath.Join(root, "repo/docs/old.txt"), "旧的说明")
	mustWrite(t, filepath.Join(root, "材料/会议.md"), "周会：定了上线日期")
	mustWrite(t, filepath.Join(root, "材料/图.png"), "png")
	mustWrite(t, filepath.Join(root, "需求.md"), "需求正文第一版")
	mustWrite(t, filepath.Join(root, "合同.pdf"), "%PDF")

	// 项目：本地项目目录 + 相对的文档目录；默认 Agent
	code, out := call(t, h, "POST", "/api/agents", `{"name":"项目助手","provider_id":"`+prov+`","enabled":false}`)
	if code != 201 {
		t.Fatalf("建 Agent：%d %v", code, out)
	}
	agentID := dataOf(out)["id"].(string)
	body, _ := json.Marshal(map[string]any{"type_id": "project", "title": "官网", "workdir": filepath.Join(root, "repo"),
		"props": map[string]any{"docs_dir": "docs", "agent_ids": []string{agentID}}})
	code, out = call(t, h, "POST", "/api/objects", string(body))
	if code != 201 {
		t.Fatalf("建项目：%d %v", code, out)
	}
	pid := dataOf(out)["id"].(string)
	base := "/api/projects/" + pid
	code, out = call(t, h, "POST", "/api/objects", `{"type_id":"doc","title":"PRD","body":"工作台里的 PRD","project_id":"`+pid+`"}`)
	if code != 201 {
		t.Fatalf("建文档：%d %v", code, out)
	}
	mats := map[string]string{}
	for name, m := range map[string]map[string]any{
		"file":   {"kind": "file", "value": filepath.Join(root, "需求.md")},
		"pdf":    {"kind": "file", "value": filepath.Join(root, "合同.pdf")},
		"folder": {"kind": "folder", "value": filepath.Join(root, "材料")},
		"note":   {"kind": "note", "value": "客户说要深色模式", "name": "客户反馈"},
		"link":   {"kind": "link", "value": "https://example.com/figma", "name": "设计稿", "category": "设计"},
	} {
		b, _ := json.Marshal(m)
		code, out := call(t, h, "POST", base+"/materials", string(b))
		if code != 201 {
			t.Fatalf("加资料 %s：%d %v", name, code, out)
		}
		mats[name] = dataOf(out)["id"].(string)
	}

	if code, out := call(t, h, "GET", base+"/kb", ""); code != 200 || dataOf(out)["kb_id"] != "" || dataOf(out)["kb"] != nil {
		t.Fatalf("没绑时：%d %v", code, out)
	}
	// 第一次同步：新建并绑定，挂到默认 Agent
	code, out = call(t, h, "POST", base+"/kb/sync", "")
	res := dataOf(out)
	// 需求.md、会议.md、笔记、链接、PRD、设计.md、old.txt = 7；合同.pdf 跳过
	if code != 200 || res["created"] != true || num(res, "added") != 7 || num(res, "skipped") != 1 || num(res, "failed") != 0 || res["error"] != "" {
		t.Fatalf("第一次同步：%d %v", code, out)
	}
	kbID := res["kb_id"].(string)
	if res["kb_name"] != "官网 项目知识库" {
		t.Fatalf("知识库名：%v", res["kb_name"])
	}
	_, out = call(t, h, "GET", base+"/kb", "")
	if v := dataOf(out); v["kb_id"] != kbID || v["auto_created"] != true || v["agent_attached"] != true || v["last_result"] == nil {
		t.Fatalf("绑定：%v", v)
	}
	// 人工往知识库加一篇笔记
	if code, out := call(t, h, "POST", "/api/knowledge-bases/"+kbID+"/docs", `{"type":"note","title":"人工","text":"人工加的"}`); code != 201 {
		t.Fatalf("人工加：%d %v", code, out)
	}
	_, out = call(t, h, "GET", "/api/knowledge-bases/"+kbID+"/docs", "")
	docs := out["data"].([]any)
	origins := map[string]int{}
	for _, d := range docs {
		origins[d.(map[string]any)["origin"].(string)]++
	}
	if origins["projects:"+pid] != 7 || origins[""] != 1 {
		t.Fatalf("来源：%v", origins)
	}

	// 改文件、删一条资料、改笔记：更新 2，移除 1（链接），人工的不动
	time.Sleep(10 * time.Millisecond)
	mustWrite(t, filepath.Join(root, "需求.md"), "需求正文第二版")
	if code, _ := call(t, h, "DELETE", base+"/materials/"+mats["link"], ""); code != 200 {
		t.Fatal("删资料")
	}
	if code, _ := call(t, h, "PATCH", base+"/materials/"+mats["note"], `{"value":"客户说要深色模式和大字号"}`); code != 200 {
		t.Fatal("改笔记")
	}
	_, out = call(t, h, "POST", base+"/kb/sync", `{"docs":false}`)
	res = dataOf(out)
	// 关掉「关联的文档」：PRD 也移出
	if num(res, "updated") != 2 || num(res, "removed") != 2 || num(res, "added") != 0 || res["created"] != false {
		t.Fatalf("增量：%v", res)
	}
	_, out = call(t, h, "GET", "/api/knowledge-bases/"+kbID+"/docs", "")
	if n := len(out["data"].([]any)); n != 6 {
		t.Fatalf("剩 %d 篇", n)
	}

	// 内置流程：写进 SOP，定时每周一 10:00、停用
	var flow map[string]any
	for i := 0; i < 100; i++ {
		if code, out := call(t, h, "GET", "/api/sop/flows/"+KBFlowID, ""); code == 200 {
			flow = dataOf(out)
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if flow == nil {
		t.Fatal("内置流程没写进 SOP")
	}
	sc, _ := flow["schedule"].(map[string]any)
	if flow["trigger"] != "schedule" || sc == nil || sc["enabled"] != false || sc["next_run_at"] != nil && sc["enabled"] == true {
		t.Fatalf("定时：trigger=%v schedule=%v", flow["trigger"], sc)
	}
	rule := sc["rule"].(map[string]any)
	if rule["freq"] != "weekly" || rule["time"] != "10:00" || len(rule["weekdays"].([]any)) != 1 || rule["weekdays"].([]any)[0] != 1.0 {
		t.Fatalf("规则：%v", rule)
	}
	// 手动发起一次：所有项目
	code, out = call(t, h, "POST", "/api/sop/flows/"+KBFlowID+"/runs", `{}`)
	if code != 201 {
		t.Fatalf("发起：%d %v", code, out)
	}
	runID := dataOf(out)["id"].(string)
	var run map[string]any
	for i := 0; i < 200; i++ {
		_, out = call(t, h, "GET", "/api/sop/runs/"+runID, "")
		run = dataOf(out)
		if run["status"] == "done" || run["status"] == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if run["status"] != "done" {
		t.Fatalf("执行：%v", run)
	}
	var ks map[string]any
	for _, st := range run["steps"].([]any) {
		if st := st.(map[string]any); st["key"] == "done" {
			ks, _ = st["output"].(map[string]any)["kb_sync"].(map[string]any)
		}
	}
	if ks == nil {
		t.Fatalf("结束步骤没留下 kb_sync：%v", run["steps"])
	}
	tot := ks["totals"].(map[string]any)
	// PRD 重新收进来
	if num(tot, "projects") != 1 || num(tot, "added") != 1 || ks["notified"] != false || ks["ok"] != true {
		t.Fatalf("流程输出：%v", ks)
	}

	// 换绑：新建一个；解绑
	code, out = call(t, h, "PUT", base+"/kb", `{"create":true,"name":"官网资料"}`)
	if code != 200 || dataOf(out)["kb"].(map[string]any)["name"] != "官网资料" || dataOf(out)["auto_created"] != false {
		t.Fatalf("新建并换绑：%d %v", code, out)
	}
	if code, out := call(t, h, "PUT", base+"/kb", `{"attach_agent":true}`); code != 200 || dataOf(out)["agent_attached"] != true {
		t.Fatalf("挂到 Agent：%d %v", code, out)
	}
	if code, _ := call(t, h, "PUT", base+"/kb", `{"kb_id":"kb_none"}`); code != 400 {
		t.Fatalf("不存在的知识库应 400：%d", code)
	}
	if code, _ := call(t, h, "PUT", base+"/kb", `{}`); code != 400 {
		t.Fatalf("空 body 应 400：%d", code)
	}
	if code, out := call(t, h, "PUT", base+"/kb", `{"kb_id":"`+kbID+`"}`); code != 200 || dataOf(out)["kb_id"] != kbID {
		t.Fatalf("换回：%d %v", code, out)
	}
	// 知识库被删了：显示 missing，下次同步新建
	if code, _ := call(t, h, "DELETE", "/api/knowledge-bases/"+kbID, ""); code != 200 {
		t.Fatal("删知识库")
	}
	if _, out := call(t, h, "GET", base+"/kb", ""); dataOf(out)["missing"] != true {
		t.Fatalf("删了之后：%v", out)
	}
	_, out = call(t, h, "POST", base+"/kb/sync", "")
	if res := dataOf(out); res["created"] != true || res["kb_id"] == kbID {
		t.Fatalf("删了之后同步：%v", res)
	}
	if code, out := call(t, h, "PUT", base+"/kb", `{"kb_id":""}`); code != 200 || dataOf(out)["kb_id"] != "" {
		t.Fatalf("解绑：%d %v", code, out)
	}
	if code, _ := call(t, h, "GET", "/api/projects/obj_none/kb", ""); code != 404 {
		t.Fatalf("不存在的项目应 404：%d", code)
	}
}
