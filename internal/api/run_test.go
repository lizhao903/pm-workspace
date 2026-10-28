package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// fakeClaudeBin 造一个假的 claude：测试绝不调真的 CLI，
// 那会让这些用例依赖外部程序、网络和用户的登录态。
func fakeClaudeBin(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("写假 claude: %v", err)
	}
	return path
}

// runFixture 准备一条能跑的任务：一个带 workdir 的对象 + 一个指向假 claude 的 Server。
func runFixture(t *testing.T, script string) (*Server, *fakeStore, *domain.Object, string) {
	t.Helper()
	f := newFakeStore()
	f.types["task"] = &domain.ObjectType{
		ID: "task", Name: "待办", RefPrefix: "TSK",
		Statuses: []domain.Status{{Key: "doing", Label: "进行中"}},
	}
	wd := t.TempDir()
	obj, err := f.CreateObject(t.Context(), &domain.Object{
		TypeID: "task", Title: "把日报脚本补上", Body: "每天 9 点跑一次。",
		Status: "doing", Priority: "P1", Workdir: wd,
	}, store.DefaultActor)
	if err != nil {
		t.Fatalf("建对象: %v", err)
	}
	s := newTestServer(f, func(o *Options) { o.ClaudeBin = fakeClaudeBin(t, script) })
	return s, f, obj, wd
}

// runEvents 把执行流的响应体拆成一串事件对象。
func runEvents(t *testing.T, w *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, 期望 text/event-stream (body=%s)", ct, w.Body.String())
	}
	var out []map[string]any
	for _, chunk := range strings.Split(w.Body.String(), "\n\n") {
		line := strings.TrimSpace(chunk)
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m); err != nil {
			t.Fatalf("事件不是合法 JSON: %v (%q)", err, line)
		}
		out = append(out, m)
	}
	return out
}

func typesOf(evs []map[string]any) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i], _ = e["type"].(string)
	}
	return out
}

// --- 执行 ---

const runNDJSON = `{"type":"assistant","message":{"content":[{"type":"text","text":"开始干活。"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu9","name":"Write","input":{"file_path":"report.py"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu9","content":"File created successfully"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"写好了","permission_denials":[]}`

func TestRunObjectStreamsAndPersists(t *testing.T) {
	s, f, obj, wd := runFixture(t, "cat <<'EOF'\n"+runNDJSON+"\nEOF")

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}

	evs := runEvents(t, w)
	// start 必须是第一条，且发出时库里已经有这条记录了。
	if got := typesOf(evs); len(got) != 5 || got[0] != "start" ||
		got[1] != "delta" || got[2] != "tool" || got[3] != "tool_result" || got[4] != "done" {
		t.Fatalf("事件序列 = %v，期望 start/delta/tool/tool_result/done", got)
	}
	if evs[0]["run_id"] != evs[4]["run_id"] {
		t.Errorf("start 和 done 的 run_id 对不上：%v vs %v", evs[0]["run_id"], evs[4]["run_id"])
	}
	if evs[0]["workdir"] != wd {
		t.Errorf("start.workdir = %v，期望后端最终解析出的 %q", evs[0]["workdir"], wd)
	}
	evs = evs[1:]
	if evs[0]["text"] != "开始干活。" {
		t.Errorf("delta.text = %v", evs[0]["text"])
	}
	// tool 事件是这个界面最有价值的一半：用户要看到 claude 在动哪些文件。
	if evs[1]["name"] != "Write" || evs[1]["detail"] != "report.py" {
		t.Errorf("tool 事件 = %v", evs[1])
	}
	if _, ok := evs[1]["detail"]; !ok {
		t.Error("tool 事件必须带 detail 字段，哪怕是空串——前端的类型说它是 string")
	}
	// 配对的结果：id 对得上，名字由后端从对照表补出来（原始 JSON 那行只有 id）。
	if evs[2]["id"] != evs[1]["id"] || evs[2]["name"] != "Write" || evs[2]["ok"] != true {
		t.Errorf("tool_result 事件 = %v，应当与 tool 配对且 ok=true", evs[2])
	}
	if evs[3]["exit_code"] != float64(0) {
		t.Errorf("done.exit_code = %v", evs[3]["exit_code"])
	}
	runID, _ := evs[3]["run_id"].(string)
	if runID == "" {
		t.Fatal("done 事件必须带 run_id，前端靠它去拉这次执行的记录")
	}

	// 先落库再发 done：前端看到 done 就认为「已经留痕」，这时去查必须查得到。
	run, err := f.GetTaskRun(t.Context(), runID)
	if err != nil {
		t.Fatalf("取执行记录: %v", err)
	}
	if run.Status != domain.RunDone || run.FinishedAt == nil {
		t.Fatalf("记录没收尾: status=%s finished=%v", run.Status, run.FinishedAt)
	}
	if run.Workdir != wd {
		t.Errorf("workdir = %q, 期望 %q", run.Workdir, wd)
	}
	for _, want := range []string{"开始干活。", "[工具] Write · report.py"} {
		if !strings.Contains(run.Output, want) {
			t.Errorf("落库的过程记录缺少 %q:\n%s", want, run.Output)
		}
	}
	// 提示词要让 claude 知道它在做什么。
	for _, want := range []string{obj.Ref, "把日报脚本补上", "每天 9 点跑一次。", "进行中", "P1", wd} {
		if !strings.Contains(run.Prompt, want) {
			t.Errorf("提示词缺少 %q:\n%s", want, run.Prompt)
		}
	}
}

func TestRunObjectPassesExtraPrompt(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo '"+`{"type":"result","is_error":false,"result":"ok"}`+"'")

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{"extra_prompt":"只改 README，别碰代码"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if len(runs) != 1 {
		t.Fatalf("want 1 run, got %d", len(runs))
	}
	if !strings.Contains(runs[0].Prompt, "只改 README，别碰代码") {
		t.Errorf("补充要求没进提示词:\n%s", runs[0].Prompt)
	}
}

// TestRunObjectWithoutWorkdirIsRejected 是这条链路最要紧的一条守卫。
// 没有工作目录就退化成「用当前目录」的话，claude 会在工作台自己的源码目录里动手。
func TestRunObjectWithoutWorkdirIsRejected(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")
	f.objs[obj.ID].Workdir = "" // 对象和它所属的项目都没设

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	e := assertError(t, w, http.StatusBadRequest, "validation")
	msg, _ := e["message"].(string)
	// 用户唯一能看到的就是这句话，它必须说清下一步做什么。
	if !strings.Contains(msg, "请先为这个任务或它所属的项目设置工作区目录") {
		t.Fatalf("message = %q，没告诉用户该怎么办", msg)
	}
	if runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0); len(runs) != 0 {
		t.Error("被拒绝的执行不该在库里留下记录")
	}
}

func TestRunObjectRejectsUnusableWorkdir(t *testing.T) {
	s, _, obj, _ := runFixture(t, "echo hi")

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run",
		`{"workdir":"/tmp/pmw-definitely-not-here-98f2"}`)
	e := assertError(t, w, http.StatusBadRequest, "validation")
	if msg, _ := e["message"].(string); !strings.Contains(msg, "不存在") {
		t.Fatalf("message = %q，应当说清目录不存在", msg)
	}
}

// 对象自己没设 workdir 时回退到所属项目的，这条规则是 ResolveWorkdir 的契约。
func TestRunObjectFallsBackToProjectWorkdir(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo '"+`{"type":"result","is_error":false,"result":"ok"}`+"'")

	projWd := t.TempDir()
	proj, err := f.CreateObject(t.Context(), &domain.Object{
		TypeID: "task", Title: "某个项目", Workdir: projWd,
	}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	f.objs[obj.ID].Workdir = ""
	f.objs[obj.ID].ProjectID = &proj.ID

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if len(runs) != 1 || runs[0].Workdir != projWd {
		t.Fatalf("workdir 没回退到项目的：%+v", runs)
	}
}

func TestRunObjectNotFound(t *testing.T) {
	s, _, _, _ := runFixture(t, "echo hi")
	w := do(s, "POST", "/api/objects/obj_nope/run", `{}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

// claude 挂掉不是 HTTP 错误：SSE 的头已经发出去了，只能作为 error 事件写进流里，
// 并且记录仍然要收尾，否则它会永远停在 running。
func TestRunObjectFailureBecomesStreamEvent(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo '鉴权失败' >&2\nexit 2")

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d：流已经开始了就不能再改状态码", w.Code)
	}
	got := typesOf(runEvents(t, w))
	if len(got) != 3 || got[0] != "start" || got[1] != "error" || got[2] != "done" {
		t.Fatalf("事件序列 = %v，期望 start/error/done", got)
	}
	evs := runEvents(t, w)[1:]
	if msg, _ := evs[0]["message"].(string); !strings.Contains(msg, "鉴权失败") {
		t.Errorf("error.message = %q，应当带上原因", msg)
	}
	if evs[1]["exit_code"] != float64(2) {
		t.Errorf("done.exit_code = %v，期望 2", evs[1]["exit_code"])
	}

	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if len(runs) != 1 || runs[0].Status != domain.RunFailed || runs[0].FinishedAt == nil {
		t.Fatalf("失败的执行也必须收尾：%+v", runs)
	}
}

func TestRunObjectTimesOut(t *testing.T) {
	f := newFakeStore()
	f.types["task"] = &domain.ObjectType{ID: "task", Name: "待办", RefPrefix: "TSK"}
	obj, err := f.CreateObject(t.Context(), &domain.Object{
		TypeID: "task", Title: "跑不完的活", Workdir: t.TempDir(),
	}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	s := newTestServer(f, func(o *Options) {
		o.ClaudeBin = fakeClaudeBin(t, "sleep 600")
		o.RunTimeout = 300 * time.Millisecond
	})

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	evs := runEvents(t, w)
	if got := typesOf(evs); len(got) != 3 || got[0] != "start" || got[1] != "error" || got[2] != "done" {
		t.Fatalf("事件序列 = %v，期望 start/error/done", got)
	}
	if msg, _ := evs[1]["message"].(string); !strings.Contains(msg, "超时") {
		t.Errorf("超时要说清是超时，got %q", msg)
	}
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if len(runs) != 1 || runs[0].Status != domain.RunFailed {
		t.Fatalf("超时应当按 failed 收尾：%+v", runs)
	}
}

// --- 历史与取消 ---

func TestListAndGetTaskRuns(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")

	w := do(s, "GET", "/api/objects/"+obj.ID+"/runs", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	m := decodeEnvelope(t, w)
	// 没有记录时要回 []，不是 null。
	if items, ok := m["data"].([]any); !ok || len(items) != 0 {
		t.Fatalf("data = %v，期望空数组", m["data"])
	}

	run, err := f.CreateTaskRun(t.Context(), &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning,
	})
	if err != nil {
		t.Fatal(err)
	}

	m = decodeEnvelope(t, do(s, "GET", "/api/objects/"+obj.ID+"/runs", ""))
	if items, _ := m["data"].([]any); len(items) != 1 {
		t.Fatalf("data = %v，期望 1 条", m["data"])
	}

	m = decodeEnvelope(t, do(s, "GET", "/api/runs/"+run.ID, ""))
	if d, _ := m["data"].(map[string]any); d["id"] != run.ID {
		t.Fatalf("单条查询回的是 %v", m["data"])
	}

	assertError(t, do(s, "GET", "/api/runs/run_nope", ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, "GET", "/api/objects/obj_nope/runs", ""), http.StatusNotFound, "not_found")
}

func TestCancelFinishedRunConflicts(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")
	run, _ := f.CreateTaskRun(t.Context(), &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning,
	})
	if _, err := f.FinishTaskRun(t.Context(), run.ID, domain.RunDone, 0, "", ""); err != nil {
		t.Fatal(err)
	}

	w := do(s, "POST", "/api/runs/"+run.ID+"/cancel", "")
	assertError(t, w, http.StatusConflict, "conflict")
}

// 库里写着 running 但本进程手上没有这个执行：工作台重启过。
// 不能把记录晾在 running 上，那样详情面板会永远转圈。
func TestCancelStaleRunMarksItCanceled(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")
	run, _ := f.CreateTaskRun(t.Context(), &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning,
	})

	w := do(s, "POST", "/api/runs/"+run.ID+"/cancel", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	got, _ := f.GetTaskRun(t.Context(), run.ID)
	if got.Status != domain.RunCanceled || got.FinishedAt == nil {
		t.Fatalf("记录应当被标成取消并收尾：%+v", got)
	}
	if !strings.Contains(got.Error, "重启") {
		t.Errorf("要说清是为什么被标成取消，got %q", got.Error)
	}
}

func TestCancelRunNotFound(t *testing.T) {
	s, _, _, _ := runFixture(t, "echo hi")
	assertError(t, do(s, "POST", "/api/runs/run_nope/cancel", ""), http.StatusNotFound, "not_found")
}

// TestCancelRunningRun 走完整条链路：起一个跑不完的 claude，中途调取消接口，
// 流以 done 收尾，记录落成 canceled。
func TestCancelRunningRun(t *testing.T) {
	f := newFakeStore()
	f.types["task"] = &domain.ObjectType{ID: "task", Name: "待办", RefPrefix: "TSK"}
	obj, err := f.CreateObject(t.Context(), &domain.Object{
		TypeID: "task", Title: "长跑", Workdir: t.TempDir(),
	}, store.DefaultActor)
	if err != nil {
		t.Fatal(err)
	}
	s := newTestServer(f, func(o *Options) {
		o.ClaudeBin = fakeClaudeBin(t, `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"开工"}]}}'
sleep 600`)
	})

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`) }()

	// 等记录出现在库里，才有 run_id 可以取消。
	var runID string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && runID == "" {
		if runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0); len(runs) > 0 {
			runID = runs[0].ID
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if runID == "" {
		t.Fatal("执行记录没建出来")
	}
	// 再等进程真的登记到 runner 手上，否则取消会走成「工作台重启过」那条路。
	for time.Now().Before(deadline) && !s.run.Running(runID) {
		time.Sleep(20 * time.Millisecond)
	}

	w := do(s, "POST", "/api/runs/"+runID+"/cancel", "")
	if w.Code != http.StatusOK {
		t.Fatalf("取消接口状态码 = %d (body=%s)", w.Code, w.Body.String())
	}

	select {
	case sw := <-done:
		if got := typesOf(runEvents(t, sw)); got[len(got)-1] != "done" {
			t.Fatalf("流应当以 done 收尾，got %v", got)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("取消之后流没有结束")
	}

	got, _ := f.GetTaskRun(t.Context(), runID)
	if got.Status != domain.RunCanceled || got.FinishedAt == nil {
		t.Fatalf("记录应当是 canceled：%+v", got)
	}
}

// --- 允许修改文件 ---

// argvEcho 是一个把自己收到的参数吐成 delta 的假 claude，用来盯住我们到底给
// claude 传了什么。先 shift 掉 `-p <提示词>`：提示词是多行的，原样拼进 JSON
// 字符串会把这一行 NDJSON 撑断，于是断言变成对着空输出做 not-contains，
// 永远是绿的——一条什么都没验证的测试比没有测试更糟。
const argvEcho = `shift 2
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"ARGV %s"}]}}\n' "$*"`

// argvOf 取出假 claude 回显的那行参数，顺带确认它真的回显了。
func argvOf(t *testing.T, f *fakeStore, objID string) string {
	t.Helper()
	runs, _ := f.ListTaskRuns(t.Context(), objID, 0)
	if len(runs) != 1 {
		t.Fatalf("want 1 run, got %d", len(runs))
	}
	_, argv, ok := strings.Cut(runs[0].Output, "ARGV ")
	if !ok {
		t.Fatalf("假 claude 没回显参数，这条断言等于没做：%q", runs[0].Output)
	}
	return argv
}

func TestAllowWritesDefaultsToReadOnly(t *testing.T) {
	s, f, obj, _ := runFixture(t, argvEcho)

	// 不传 allow_writes
	if w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	argv := argvOf(t, f, obj.ID)
	if strings.Contains(argv, "--permission-mode") {
		t.Errorf("默认必须是只读，不该放宽权限：%s", argv)
	}
	if strings.Contains(argv, "dangerously") {
		t.Errorf("任何情况下都不该传 --dangerously-skip-permissions：%s", argv)
	}
}

func TestAllowWritesPassesAcceptEdits(t *testing.T) {
	s, f, obj, _ := runFixture(t, argvEcho)

	if w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{"allow_writes":true}`); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	argv := argvOf(t, f, obj.ID)
	if !strings.Contains(argv, "--permission-mode acceptEdits") {
		t.Fatalf("勾了「允许修改文件」应当传 --permission-mode acceptEdits：%s", argv)
	}
	if strings.Contains(argv, "dangerously") {
		t.Errorf("acceptEdits 只放开文件编辑，不能顺手把命令执行也放开：%s", argv)
	}
}

// 工具被拒时 claude 以退出码 0 正常结束，但任务没做成。
// 界面不能显示成一个绿色的「完成」。
func TestDeniedToolRunIsReportedAsFailure(t *testing.T) {
	const denied = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"NOTE.md"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"requested permissions to write, but you haven't granted it yet"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"没权限","permission_denials":[{"tool_name":"Write","tool_use_id":"tu1"}]}`
	s, f, obj, _ := runFixture(t, "cat <<'EOF'\n"+denied+"\nEOF")

	w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	evs := runEvents(t, w)

	// 事件流里要能把「被拒」和「成功」分开。
	var tr map[string]any
	for _, e := range evs {
		if e["type"] == "tool_result" {
			tr = e
		}
	}
	if tr == nil {
		t.Fatalf("没有 tool_result 事件：%v", typesOf(evs))
	}
	if tr["ok"] != false {
		t.Errorf("被拒的调用 ok 必须是 false：%v", tr)
	}
	if tr["name"] != "Write" || tr["id"] != "tu1" {
		t.Errorf("tool_result 要带上工具名和配对 id：%v", tr)
	}

	// 结尾要主动告诉用户该怎么办，不能让他自己从输出里读出来。
	got := typesOf(evs)
	if got[len(got)-2] != "error" || got[len(got)-1] != "done" {
		t.Fatalf("事件序列应以 error/done 收尾，got %v", got)
	}
	var msg string
	for _, e := range evs {
		if e["type"] == "error" {
			msg, _ = e["message"].(string)
		}
	}
	for _, want := range []string{"Write", "只读执行", "允许修改文件"} {
		if !strings.Contains(msg, want) {
			t.Errorf("提示缺少 %q：%s", want, msg)
		}
	}
	// exit_code 仍然如实是 0——它说的是进程，不是任务。
	if evs[len(evs)-1]["exit_code"] != float64(0) {
		t.Errorf("done.exit_code = %v，应当如实报告进程的退出码", evs[len(evs)-1]["exit_code"])
	}

	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if len(runs) != 1 || runs[0].Status != domain.RunFailed {
		t.Fatalf("工具全被拒的执行应当落成 failed，got %+v", runs)
	}
	if !strings.Contains(runs[0].Error, "允许修改文件") {
		t.Errorf("落库的 error 也要带上解法：%q", runs[0].Error)
	}
}

// --- 工作台重启后的残留记录 ---

// 进程活在内存里，记录活在库里。重启之后库里还挂着 running，
// 但进程早没了——那条记录会在界面上永远转圈。
func TestStaleRunningRunIsReapedOnRead(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")
	run, err := f.CreateTaskRun(t.Context(), &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 装成上一次进程留下的：起始时间推到宽限期之外。
	f.taskRuns[run.ID].StartedAt = time.Now().Add(-2 * staleRunGrace)

	m := decodeEnvelope(t, do(s, "GET", "/api/objects/"+obj.ID+"/runs", ""))
	items, _ := m["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("want 1 run, got %v", m["data"])
	}
	// 这次响应本身就该是修好之后的样子，不能等下一次刷新。
	got, _ := items[0].(map[string]any)
	if got["status"] != domain.RunFailed {
		t.Errorf("响应里的 status = %v，期望 failed", got["status"])
	}
	if got["finished_at"] == nil {
		t.Error("响应里的 finished_at 还是空的，界面会继续转圈")
	}

	stored, _ := f.GetTaskRun(t.Context(), run.ID)
	if stored.Status != domain.RunFailed || stored.FinishedAt == nil {
		t.Fatalf("库里也要收尾：%+v", stored)
	}
	if !strings.Contains(stored.Error, "重启") {
		t.Errorf("要说清为什么被中断：%q", stored.Error)
	}
}

// 刚建出来还没来得及登记进活进程表的记录，不能被误判成残留。
func TestFreshRunningRunIsNotReaped(t *testing.T) {
	s, f, obj, _ := runFixture(t, "echo hi")
	run, err := f.CreateTaskRun(t.Context(), &domain.TaskRun{
		ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning,
	})
	if err != nil {
		t.Fatal(err)
	}

	do(s, "GET", "/api/objects/"+obj.ID+"/runs", "")

	stored, _ := f.GetTaskRun(t.Context(), run.ID)
	if stored.FinishedAt != nil {
		t.Fatalf("刚起的执行不该被当成残留收掉：%+v", stored)
	}
}

// TestRunRegistersChangedFilesAsArtifacts 验的是整条链，不是其中一段。
//
// 链有四节：执行前拍快照 → claude 真的写盘 → 差集算出改动 → 登记进 artifacts。
// 只断言 SSE 里出现了 artifact 事件，证明不了第四节；只查库，证明不了流上有没有回显。
// 所以两边都查，而且先去磁盘上确认文件真的在——事件和库记录都可能在文件没写成时
// 照样产生，那样验的就只是我们自己的簿记。
func TestRunRegistersChangedFilesAsArtifacts(t *testing.T) {
	// 假 claude 写两个文件：一个在根下，一个在子目录里；
	// 再往 node_modules 写一个，它必须被挡掉。
	s, f, obj, wd := runFixture(t, `
mkdir -p docs node_modules
echo '# 方案' > docs/方案.md
echo 'v1' > 记录.txt
echo 'noise' > node_modules/x.js
echo '{"type":"result","subtype":"success","is_error":false}'
`)

	w := do(s, http.MethodPost, "/api/objects/"+obj.ID+"/run", `{"allow_writes":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}

	// 第一节 + 第二节：文件真的落盘了。
	for _, rel := range []string{"docs/方案.md", "记录.txt"} {
		if _, err := os.Stat(filepath.Join(wd, rel)); err != nil {
			t.Fatalf("文件没写成 %s: %v", rel, err)
		}
	}

	// 第三节：流上回显了，而且顺序对——artifact 必须在 done 之前。
	// 反了的话前端收到 done 就去刷产物列表，刷出来是空的。
	evs := runEvents(t, w)
	var artPaths []string
	doneAt, lastArtAt := -1, -1
	for i, ev := range evs {
		switch ev["type"] {
		case "artifact":
			artPaths = append(artPaths, ev["path"].(string))
			lastArtAt = i
		case "done":
			doneAt = i
		}
	}
	if len(artPaths) != 2 {
		t.Fatalf("期望 2 条 artifact 事件（node_modules 那个要被挡掉），得到 %d 条: %v", len(artPaths), artPaths)
	}
	if doneAt < 0 || lastArtAt > doneAt {
		t.Errorf("artifact 事件必须在 done 之前，artifact@%d done@%d", lastArtAt, doneAt)
	}

	// 第四节：真的进库了，而且归属、来源、出处都对。
	// 这一节最容易漏——前三节全对而登记失败时，流上一切正常，
	// 用户要等到打开产物页才发现是空的。
	items, _, err := f.ListArtifacts(t.Context(), domain.ArtifactFilter{ObjectID: obj.ID})
	if err != nil {
		t.Fatalf("列产物: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("库里期望 2 条产物，得到 %d 条", len(items))
	}
	for _, a := range items {
		if a.Source != domain.ArtifactSourceRun {
			t.Errorf("%s 的来源 = %q，期望 run", a.Title, a.Source)
		}
		if a.RunID == nil || *a.RunID == "" {
			t.Errorf("%s 没记下是哪次执行产出的", a.Title)
		}
		if a.BaseDir != wd {
			t.Errorf("%s 的基准目录 = %q，期望 %q", a.Title, a.BaseDir, wd)
		}
		if !strings.HasPrefix(a.Path, wd) {
			t.Errorf("%s 的路径不是绝对路径: %q", a.Title, a.Path)
		}
		if strings.Contains(a.Path, "node_modules") {
			t.Errorf("node_modules 里的文件被登记了: %q", a.Path)
		}
	}
}

// TestRunWithoutChangesRegistersNothing 守空跑：只读跑一遍不该凭空造出产物。
func TestRunWithoutChangesRegistersNothing(t *testing.T) {
	s, f, obj, _ := runFixture(t, `
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"我先看看"}]}}'
echo '{"type":"result","subtype":"success","is_error":false}'
`)

	w := do(s, http.MethodPost, "/api/objects/"+obj.ID+"/run", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	for _, ev := range runEvents(t, w) {
		if ev["type"] == "artifact" {
			t.Errorf("没改动任何文件，不该有 artifact 事件: %v", ev)
		}
	}
	items, _, _ := f.ListArtifacts(t.Context(), domain.ArtifactFilter{ObjectID: obj.ID})
	if len(items) != 0 {
		t.Errorf("没改动任何文件，不该登记产物，得到 %d 条", len(items))
	}
}
