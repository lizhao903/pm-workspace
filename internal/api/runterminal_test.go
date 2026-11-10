// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// terminalFixture：一条挂在项目下的任务（项目有关联文档目录），一个能发起终端执行的 Server。
func terminalFixture(t *testing.T) (*Server, *fakeStore, *domain.Object, string) {
	t.Helper()
	f := newFakeStore()
	f.types["task"] = &domain.ObjectType{ID: "task", Name: "待办", RefPrefix: "TSK",
		Statuses: []domain.Status{{Key: "todo", Label: "待办"}}}
	f.types["project"] = &domain.ObjectType{ID: "project", Name: "项目", RefPrefix: "PRJ"}
	wd := t.TempDir()
	prj, err := f.CreateObject(t.Context(), &domain.Object{TypeID: "project", Title: "Acme", Workdir: wd,
		Props: map[string]any{"related": []any{
			map[string]any{"path": "", "label": "空的跳过"},
			map[string]any{"path": "file:///Volumes/docs/example/acme-project", "label": "acme-project概况"},
		}}}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	task, err := f.CreateObject(t.Context(), &domain.Object{TypeID: "task", Title: "写一版 PRD", Status: "todo",
		ProjectID: &prj.ID}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "pmw-mcp-dev")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	s := newTestServer(f, func(o *Options) {
		o.MCPBin, o.PublicURL, o.DataDir = bin, "http://127.0.0.1:7796/", data
	})
	return s, f, task, data
}

func TestMCPConfig(t *testing.T) {
	var cfg struct {
		MCPServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(MCPConfig("/x/bin/pmw-mcp-dev", "http://127.0.0.1:7796/"), &cfg); err != nil {
		t.Fatal(err)
	}
	// TSK-0499：server 名和后台执行、插件运行同一个，不和工作目录 .mcp.json 里的 pm-workspace 撞名
	sv, ok := cfg.MCPServers["pmw-run"]
	if !ok || len(cfg.MCPServers) != 1 || sv.Type != "stdio" || sv.Command != "/x/bin/pmw-mcp-dev" ||
		strings.Join(sv.Args, " ") != "--api http://127.0.0.1:7796" {
		t.Fatalf("MCP 配置：%+v", cfg)
	}
}

// 预览：有项目时带项目一节（文档目录取第一个有路径的关联目录，没登记原型时写明可补）；终端方式带回写一节。
func TestRunPromptPreview(t *testing.T) {
	s, _, task, _ := terminalFixture(t)
	m := decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?extra_prompt="+url.QueryEscape("先列提纲"), ""))
	d := m["data"].(map[string]any)
	p := d["prompt"].(string)
	for _, want := range []string{"## 所属项目\n名称：Acme", "文档在哪里操作：/Volumes/docs/example/acme-project（项目关联目录「acme-project概况」）",
		"这个项目没有登记原型目录，可在项目设置里补", "## 本次执行的补充要求\n先列提纲"} {
		if !strings.Contains(p, want) {
			t.Fatalf("预览里应有 %q:\n%s", want, p)
		}
	}
	// TSK-0499：流式（后台执行）也经 MCP 回写，按无人值守的口径写；MCP 接上了就写 server 名
	if !strings.Contains(p, "交给你在后台执行的（执行记录 <发起时生成的执行 id>）") || !strings.Contains(p, "server 名 pmw-run") ||
		!strings.Contains(p, "sqlite3 -readonly -safe") || d["workdir"] == "" {
		t.Fatalf("流式预览应有后台执行的回写一节，工作目录应继承自项目：%v", d)
	}
	// TSK-0722：交给 DeepSeek 的也接工作台 MCP，回写一节同后台执行；权限说法是 dsh 沙箱，不提 Claude Code 的命令白名单
	if p := decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?harness=deepseek", ""))["data"].(map[string]any)["prompt"].(string); !strings.Contains(p, "回写到工作台") ||
		!strings.Contains(p, "server 名 pmw-run") || !strings.Contains(p, "dsh 的沙箱") || strings.Contains(p, "sqlite3 -readonly -safe") {
		t.Fatalf("DeepSeek 预览应有回写一节、按 dsh 沙箱说权限:\n%s", p)
	}
	p = decodeEnvelope(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?mode=terminal", ""))["data"].(map[string]any)["prompt"].(string)
	if !strings.Contains(p, "执行记录 <发起时生成的执行 id>") || !strings.Contains(p, "pmw_finish_run") {
		t.Fatalf("终端预览应有回写一节:\n%s", p)
	}
	assertError(t, do(s, "GET", "/api/objects/"+task.ID+"/run/prompt?mode=x", ""), http.StatusBadRequest, "validation")
	assertError(t, do(s, "GET", "/api/objects/obj_nope/run/prompt", ""), http.StatusNotFound, "not_found")
}

func TestRunTerminalHandoff(t *testing.T) {
	s, f, task, data := terminalFixture(t)
	w := do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", `{"extra_prompt":"只改文档"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Data TerminalHandoff `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	h := resp.Data
	if h.Run == nil || h.Run.Mode != domain.RunModeTerminal || h.Run.Status != domain.RunRunning || h.Workdir == "" {
		t.Fatalf("执行记录：%+v", h)
	}
	dir := filepath.Join(data, "tmp", "handoff", h.Run.ID)
	if h.PromptFile != filepath.Join(dir, "prompt.md") || h.MCPConfig != filepath.Join(dir, "mcp.json") {
		t.Fatalf("临时文件应在数据目录 tmp/handoff/<执行 id>/ 下：%+v", h)
	}
	b, err := os.ReadFile(h.PromptFile)
	if err != nil || !strings.Contains(string(b), "执行记录 "+h.Run.ID) || !strings.Contains(string(b), "只改文档") {
		t.Fatalf("提示词文件：%v\n%s", err, b)
	}
	if st, _ := os.Stat(h.MCPConfig); st.Mode().Perm() != 0o600 {
		t.Fatalf("MCP 配置的权限应为 0600：%v", st.Mode())
	}
	if mb, _ := os.ReadFile(h.MCPConfig); !strings.Contains(string(mb), `"http://127.0.0.1:7796"`) {
		t.Fatalf("MCP 配置：%s", mb)
	}
	// 库里存的提示词是带执行 id 的那份
	if got, _ := f.GetTaskRun(t.Context(), h.Run.ID); got.Prompt != string(b) {
		t.Fatalf("库里的提示词应和文件一致")
	}

	// 终端执行不会因「本进程手上没有」被读的时候判失败
	f.mu.Lock()
	f.runsMap()[h.Run.ID].StartedAt = time.Now().Add(-time.Hour)
	f.mu.Unlock()
	d := decodeEnvelope(t, do(s, "GET", "/api/runs/"+h.Run.ID, ""))["data"].(map[string]any)
	if d["status"] != "running" || d["mode"] != "terminal" {
		t.Fatalf("终端执行应保持进行中：%v", d)
	}

	// 回写收尾：结论落进 output，临时文件删掉
	w = do(s, "POST", "/api/runs/"+h.Run.ID+"/finish", `{"status":"done","summary":"写完了 PRD，放在 acme-project/需求"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("收尾：%d %s", w.Code, w.Body.String())
	}
	got, _ := f.GetTaskRun(t.Context(), h.Run.ID)
	if got.Status != domain.RunDone || got.Output != "写完了 PRD，放在 acme-project/需求" || got.FinishedAt == nil {
		t.Fatalf("收尾后：%+v", got)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("收尾后临时目录应删掉：%v", err)
	}
	assertError(t, do(s, "POST", "/api/runs/"+h.Run.ID+"/finish", `{"status":"done"}`), http.StatusConflict, "conflict")
}

func TestFinishRunRules(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	stream, _ := f.CreateTaskRun(t.Context(), &domain.TaskRun{ObjectID: task.ID, Workdir: "/tmp/x", Status: domain.RunRunning})
	assertError(t, do(s, "POST", "/api/runs/"+stream.ID+"/finish", `{"status":"done"}`), http.StatusConflict, "conflict")

	term, _ := f.CreateTaskRun(t.Context(), &domain.TaskRun{ObjectID: task.ID, Workdir: "/tmp/x", Status: domain.RunRunning, Mode: domain.RunModeTerminal})
	assertError(t, do(s, "POST", "/api/runs/"+term.ID+"/finish", `{"status":"running"}`), http.StatusBadRequest, "validation")
	assertError(t, do(s, "POST", "/api/runs/run_nope/finish", `{"status":"done"}`), http.StatusNotFound, "not_found")

	// 标记失败没写原因：留一句
	if w := do(s, "POST", "/api/runs/"+term.ID+"/finish", `{"status":"failed"}`); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if got, _ := f.GetTaskRun(t.Context(), term.ID); got.Status != domain.RunFailed || got.Error == "" {
		t.Fatalf("%+v", got)
	}

	// 取消终端执行：只标记，说清终端要自己关
	term2, _ := f.CreateTaskRun(t.Context(), &domain.TaskRun{ObjectID: task.ID, Workdir: "/tmp/x", Status: domain.RunRunning, Mode: domain.RunModeTerminal})
	if w := do(s, "POST", "/api/runs/"+term2.ID+"/cancel", ""); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if got, _ := f.GetTaskRun(t.Context(), term2.ID); got.Status != domain.RunCanceled || !strings.Contains(got.Error, "终端") {
		t.Fatalf("%+v", got)
	}
}

func TestRunTerminalNeedsMCP(t *testing.T) {
	s, _, task, _ := terminalFixture(t)
	s.opt.MCPBin = filepath.Join(t.TempDir(), "nope")
	assertError(t, do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", ""), http.StatusConflict, "conflict")
	s.opt.MCPBin = ""
	assertError(t, do(s, "POST", "/api/objects/"+task.ID+"/run/terminal", ""), http.StatusConflict, "conflict")
}

// 流式执行的提示词同样带项目上下文。
func TestStreamRunPromptHasProject(t *testing.T) {
	s, f, task, _ := terminalFixture(t)
	s.run.Bin = fakeClaudeBin(t, "echo '{\"type\":\"result\",\"result\":\"ok\"}'")
	w := do(s, "POST", "/api/objects/"+task.ID+"/run", "")
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	runs, _ := f.ListTaskRuns(t.Context(), task.ID, 10)
	if len(runs) != 1 || runs[0].Mode != domain.RunModeStream || !strings.Contains(runs[0].Prompt, "## 所属项目") {
		t.Fatalf("%+v", runs)
	}
}

func TestCleanHandoff(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"run_old", "run_new", "keep me"} {
		if err := os.MkdirAll(filepath.Join(root, n), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-8 * 24 * time.Hour)
	_ = os.Chtimes(filepath.Join(root, "run_old"), old, old)
	_ = os.Chtimes(filepath.Join(root, "keep me"), old, old)
	cleanHandoff(root, time.Now(), handoffKeep, newTestServer(newFakeStore()).log)
	for n, want := range map[string]bool{"run_old": false, "run_new": true, "keep me": true} {
		if _, err := os.Stat(filepath.Join(root, n)); (err == nil) != want {
			t.Errorf("%s 留下=%v，要 %v", n, err == nil, want)
		}
	}
}
