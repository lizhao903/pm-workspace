package projects

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 需求级 git worktree（AUTO-07）。代码库都是 t.TempDir() 里 git init 出来的临时仓库。

type wtProbe struct{ c plugin.Core }

var wtProbeManifest = plugin.MustParse([]byte(`{"id":"probe","name":"探针","version":"0.1.0","core":">=1.0.0 <2.0.0",
	"provides":{"modules":[],"settings":[],"object_types":[],"connectors":[],"skills":[],"agent_tools":[],"sop_nodes":[],"today_cards":[],"commands":[],"search":[]},
	"emits":[],"subscribes":[],"permissions":[]}`))

func (p *wtProbe) Manifest() plugin.Manifest         { return wtProbeManifest }
func (p *wtProbe) Migrations() fs.FS                 { return nil }
func (p *wtProbe) Register(r plugin.Registrar) error { p.c = r.Core(); return nil }

type wtEnv struct {
	r     *plugin.Registry
	h     http.Handler
	d     *db.DB
	data  string
	probe *wtProbe
	plug  *Plugin
}

// tests 是插件当前启用的那份测试服务（AUTO-09 的测试要直接调到点回收）。
func (e *wtEnv) tests(t *testing.T) *testService {
	t.Helper()
	if e.plug.tests == nil {
		t.Fatal("项目插件没启用")
	}
	return e.plug.tests
}

func setupWT(t *testing.T) *wtEnv {
	t.Helper()
	ctx := context.Background()
	data, _ := filepath.EvalSymlinks(t.TempDir())
	d, err := db.Open(filepath.Join(data, "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	r.DataDir = data
	probe := &wtProbe{}
	plug := New()
	for _, p := range []plugin.Plugin{plug, probe} {
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for id, perms := range map[string][]string{"projects": {"process:spawn"}, "probe": nil} {
		if err := r.Install(ctx, id, perms); err != nil {
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
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p1', 'project', 'PRJ-T1', '项目一', '` + now + `', '` + now + `')`,
	} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return &wtEnv{r: r, h: mux, d: d, data: data, probe: probe, plug: plug}
}

// task 建一条任务，project 为空串时不挂项目。
func (e *wtEnv) task(t *testing.T, id, ref, project string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	var p any
	if project != "" {
		p = project
	}
	if _, err := e.d.W.Exec(`INSERT INTO objects (id, type_id, ref, title, project_id, status, created_at, updated_at) VALUES (?, 'task', ?, ?, ?, 'doing', ?, ?)`,
		id, ref, "任务 "+ref, p, now, now); err != nil {
		t.Fatal(err)
	}
}

// fire 把一条事件直接交给订阅它的插件（总线是异步的，测试里同步调）。
func (e *wtEnv) fire(t *testing.T, typ string, payload map[string]any) {
	t.Helper()
	b, _ := json.Marshal(payload)
	subs := e.r.Subscribers(typ)
	if len(subs) == 0 {
		t.Fatalf("没有插件订阅 %s", typ)
	}
	for _, s := range subs {
		if err := s.Handle(context.Background(), plugin.Event{Type: typ, At: time.Now(), Payload: b}); err != nil {
			t.Fatal(err)
		}
	}
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRepo 建一个有一次提交的临时仓库。
func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("本机没装 git")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	gitRun(t, dir, "init", "-q", "-b", "main")
	write(t, filepath.Join(dir, "README.md"), "hello\n")
	gitRun(t, dir, "add", ".")
	gitRun(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func data(out map[string]any) map[string]any {
	m, _ := out["data"].(map[string]any)
	return m
}

func errMsg(out map[string]any) string {
	m, _ := out["error"].(map[string]any)
	s, _ := m["message"].(string)
	return s
}

func TestWorktreePrepareReuseAndErrors(t *testing.T) {
	e := setupWT(t)
	h := e.h
	prep := func(task string) (int, map[string]any) {
		return call(t, h, "POST", "/api/projects/worktrees", `{"task_id":"`+task+`"}`)
	}

	// 没挂项目、项目没设代码库、代码库不是 git 仓库：400，说清楚
	e.task(t, "obj_t1", "TSK-T1", "")
	if code, out := prep("obj_t1"); code != 400 || !strings.Contains(errMsg(out), "没挂项目") {
		t.Fatalf("没挂项目：%d %v", code, out)
	}
	if _, err := e.d.W.Exec(`UPDATE objects SET project_id = 'obj_p1' WHERE id = 'obj_t1'`); err != nil {
		t.Fatal(err)
	}
	if code, out := prep("TSK-T1"); code != 400 || !strings.Contains(errMsg(out), "还没设代码库目录") {
		t.Fatalf("没设代码库：%d %v", code, out)
	}
	plain := t.TempDir()
	if code, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+plain+`"}`); code != 200 {
		t.Fatalf("设代码库：%d %v", code, out)
	}
	if code, out := prep("obj_t1"); code != 400 || !strings.Contains(errMsg(out), "不是 git 仓库") {
		t.Fatalf("不是仓库：%d %v", code, out)
	}
	if code, _ := prep("obj_none"); code != 404 {
		t.Fatalf("任务不存在应 404，实际 %d", code)
	}

	repo := newRepo(t)
	if code, out := call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+repo+`"}`); code != 200 {
		t.Fatalf("设代码库：%d %v", code, out)
	}
	// 新建：分支 auto/<ref>，目录在数据目录 worktrees/<项目 id>/<ref> 下，不在代码库里
	code, out := prep("TSK-T1")
	w := data(out)
	root := filepath.Join(e.data, "worktrees", "obj_p1", "TSK-T1")
	if code != 201 || w["branch"] != "auto/TSK-T1" || w["root"] != root || w["path"] != root || w["status"] != "active" ||
		w["exists"] != true || w["reused"] != nil || w["repo_dir"] != repo || w["port_count"] != 10.0 {
		t.Fatalf("准备：%d %v", code, out)
	}
	if got := gitRun(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/auto/TSK-T1" {
		t.Fatalf("worktree 检出的分支：%s", got)
	}
	if _, err := os.Stat(filepath.Join(root, "README.md")); err != nil {
		t.Fatal("worktree 里要有代码")
	}
	p1 := int(w["port_start"].(float64))
	if p1 < defaultPortMin || p1+9 > defaultPortMax || w["port_end"] != float64(p1+9) {
		t.Fatalf("端口段：%v", w)
	}

	// 重复准备：复用，同一条、同样的端口，200
	code, out = prep("obj_t1")
	if w2 := data(out); code != 200 || w2["id"] != w["id"] || w2["reused"] != true || w2["port_start"] != w["port_start"] {
		t.Fatalf("复用：%d %v", code, out)
	}

	// 第二个任务：端口段不重叠
	e.task(t, "obj_t2", "TSK-T2", "obj_p1")
	code, out = prep("obj_t2")
	w2 := data(out)
	if p2 := int(w2["port_start"].(float64)); code != 201 || (p2 <= p1+9 && p1 <= p2+9) {
		t.Fatalf("第二个工作区的端口段和第一个重叠：%d %v", code, out)
	}

	// 目录被删了：按原分支、原端口重建，还是同一条
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	code, out = prep("obj_t1")
	if w3 := data(out); code != 201 || w3["id"] != w["id"] || w3["port_start"] != w["port_start"] || w3["exists"] != true {
		t.Fatalf("目录没了重建：%d %v", code, out)
	}

	// 分支被别的 worktree 占着：409，写明在哪
	e.task(t, "obj_t3", "TSK-T3", "obj_p1")
	other := filepath.Join(t.TempDir(), "other")
	gitRun(t, repo, "worktree", "add", "-q", "-b", "auto/TSK-T3", other)
	if code, out := prep("obj_t3"); code != 409 || !strings.Contains(errMsg(out), "检出着") || !strings.Contains(errMsg(out), "other") {
		t.Fatalf("分支被占用：%d %v", code, out)
	}
	// 主目录检出着这个分支也算占用
	e.task(t, "obj_t4", "TSK-T4", "obj_p1")
	gitRun(t, repo, "switch", "-q", "-c", "auto/TSK-T4")
	if code, out := prep("obj_t4"); code != 409 || !strings.Contains(errMsg(out), repo) {
		t.Fatalf("主目录检出着：%d %v", code, out)
	}
	gitRun(t, repo, "switch", "-q", "main")

	// 列：按任务、按状态
	if code, out := call(t, h, "GET", "/api/projects/worktrees?task_id=obj_t1", ""); code != 200 || len(out["data"].([]any)) != 1 {
		t.Fatalf("按任务列：%d %v", code, out)
	}
	if code, out := call(t, h, "GET", "/api/projects/worktrees?project_id=obj_p1&status=active", ""); code != 200 || len(out["data"].([]any)) != 2 {
		t.Fatalf("按项目列：%d %v", code, out)
	}
	if code, _ := call(t, h, "GET", "/api/projects/worktrees?status=bad", ""); code != 400 {
		t.Fatal("status 不对应 400")
	}
}

func TestWorktreeConflictInRepo(t *testing.T) {
	e := setupWT(t)
	repo := newRepo(t)
	call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+repo+`"}`)
	// 造一个没解决的合并冲突
	gitRun(t, repo, "switch", "-q", "-c", "side")
	write(t, filepath.Join(repo, "README.md"), "side\n")
	gitRun(t, repo, "commit", "-q", "-am", "side")
	gitRun(t, repo, "switch", "-q", "main")
	write(t, filepath.Join(repo, "README.md"), "main\n")
	gitRun(t, repo, "commit", "-q", "-am", "main")
	cmd := exec.Command("git", "-C", repo, "merge", "side")
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	_ = cmd.Run()
	e.task(t, "obj_t1", "TSK-T1", "obj_p1")
	if code, out := call(t, e.h, "POST", "/api/projects/worktrees", `{"task_id":"obj_t1"}`); code != 409 || !strings.Contains(errMsg(out), "冲突") ||
		!strings.Contains(errMsg(out), "README.md") {
		t.Fatalf("有冲突：%d %v", code, out)
	}
}

func TestWorktreeCleanup(t *testing.T) {
	e := setupWT(t)
	h := e.h
	repo := newRepo(t)
	call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+repo+`"}`)
	prep := func(task string) map[string]any {
		t.Helper()
		code, out := call(t, h, "POST", "/api/projects/worktrees", `{"task_id":"`+task+`"}`)
		if code != 201 {
			t.Fatalf("准备 %s：%d %v", task, code, out)
		}
		return data(out)
	}
	get := func(id string) map[string]any {
		t.Helper()
		_, out := call(t, h, "GET", "/api/projects/worktrees", "")
		for _, x := range out["data"].([]any) {
			if m := x.(map[string]any); m["id"] == id {
				return m
			}
		}
		t.Fatalf("没找到工作区 %s", id)
		return nil
	}
	branches := func() string { return gitRun(t, repo, "branch", "--list", "auto/*") }

	// 手动清理：有没提交的改动时不删，原因记下；强制清理才删。分支没有新提交（已合并）一起删
	e.task(t, "obj_t1", "TSK-T1", "obj_p1")
	w1 := prep("obj_t1")
	id1, root1 := w1["id"].(string), w1["root"].(string)
	write(t, filepath.Join(root1, "new.txt"), "x")
	code, out := call(t, h, "POST", "/api/projects/worktrees/"+id1+"/cleanup", "")
	if code != 409 || !strings.Contains(errMsg(out), "没提交的改动") {
		t.Fatalf("有改动不强制：%d %v", code, out)
	}
	if g := get(id1); g["status"] != "active" || !strings.Contains(g["last_error"].(string), "没提交的改动") {
		t.Fatalf("失败原因要记下：%v", g)
	}
	code, out = call(t, h, "POST", "/api/projects/worktrees/"+id1+"/cleanup", `{"force":true}`)
	if w := data(out); code != 200 || w["status"] != "removed" || w["removed_reason"] != "manual" || w["branch_deleted"] != true || w["last_error"] != "" {
		t.Fatalf("强制清理：%d %v", code, out)
	}
	if _, err := os.Stat(root1); !os.IsNotExist(err) {
		t.Fatal("worktree 目录要删掉")
	}
	if strings.Contains(branches(), "auto/TSK-T1") {
		t.Fatal("已合并的分支要删")
	}
	// 再清一次：原样回
	if code, out := call(t, h, "POST", "/api/projects/worktrees/"+id1+"/cleanup", ""); code != 200 || data(out)["status"] != "removed" {
		t.Fatalf("重复清理：%d %v", code, out)
	}
	if code, _ := call(t, h, "POST", "/api/projects/worktrees/wt_none/cleanup", ""); code != 404 {
		t.Fatal("不存在的工作区应 404")
	}

	// 任务完成自动清理：分支上有没合并的提交，分支保留
	e.task(t, "obj_t2", "TSK-T2", "obj_p1")
	w2 := prep("obj_t2")
	root2 := w2["root"].(string)
	write(t, filepath.Join(root2, "feature.txt"), "f")
	gitRun(t, root2, "add", ".")
	gitRun(t, root2, "commit", "-q", "-m", "feature")
	e.fire(t, "object.status_changed", map[string]any{"id": "obj_t2", "type_id": "task", "from": "doing", "to": "done"})
	if g := get(w2["id"].(string)); g["status"] != "removed" || g["removed_reason"] != "task_done" || g["branch_deleted"] != false {
		t.Fatalf("完成后自动清理：%v", g)
	}
	if !strings.Contains(branches(), "auto/TSK-T2") {
		t.Fatal("没合并的分支要保留")
	}

	// 阶段进开发中自动准备；到已上线自动清理；别的阶段、别的状态不动
	e.task(t, "obj_t3", "TSK-T3", "obj_p1")
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t3", "type_id": "task", "from": "reviewing", "to": "developing"})
	_, auto := call(t, h, "GET", "/api/projects/worktrees?task_id=obj_t3&status=active", "")
	if len(auto["data"].([]any)) != 1 {
		t.Fatalf("进开发中要自动准备：%v", auto)
	}
	w3 := auto["data"].([]any)[0].(map[string]any)
	// 没挂项目的任务进开发中：准备不了，不报错
	e.task(t, "obj_t9", "TSK-T9", "")
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t9", "type_id": "task", "from": "", "to": "developing"})
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t3", "type_id": "task", "from": "developing", "to": "testing"})
	e.fire(t, "object.status_changed", map[string]any{"id": "obj_t3", "type_id": "task", "from": "todo", "to": "doing"})
	if g := get(w3["id"].(string)); g["status"] != "active" {
		t.Fatalf("别的阶段不清理：%v", g)
	}
	e.fire(t, "object.stage_changed", map[string]any{"id": "obj_t3", "type_id": "task", "from": "testing", "to": "released"})
	if g := get(w3["id"].(string)); g["status"] != "removed" || g["removed_reason"] != "released" {
		t.Fatalf("已上线后自动清理：%v", g)
	}

	// 取消时有改动：自动清理不强制，记下原因、保持在用
	e.task(t, "obj_t4", "TSK-T4", "obj_p1")
	w4 := prep("obj_t4")
	write(t, filepath.Join(w4["root"].(string), "dirty.txt"), "d")
	e.fire(t, "object.status_changed", map[string]any{"id": "obj_t4", "type_id": "task", "from": "doing", "to": "cancelled"})
	if g := get(w4["id"].(string)); g["status"] != "active" || g["last_error"] == "" {
		t.Fatalf("有改动时自动清理不强制：%v", g)
	}

	// 归还的端口段能再分出去：obj_t1 清掉后它那一段又分给了 obj_t2；obj_t4 还在用，新任务分到别的段
	if w2["port_start"] != w1["port_start"] {
		t.Fatalf("端口段要归还：%v，原来 %v", w2["port_start"], w1["port_start"])
	}
	e.task(t, "obj_t5", "TSK-T5", "obj_p1")
	if w5 := prep("obj_t5"); w5["port_start"] == w4["port_start"] {
		t.Fatalf("在用的端口段不能再分：%v", w5["port_start"])
	}
	// 任务完成后再准备是新的一条（旧的已清理）
	if w := prep("obj_t1"); w["id"] == id1 {
		t.Fatal("清理后再准备要建新的一条")
	}
}

func TestWorktreeSettingsAndPorts(t *testing.T) {
	e := setupWT(t)
	h := e.h
	code, out := call(t, h, "GET", "/api/projects/worktree-settings", "")
	if s := data(out); code != 200 || s["port_min"] != 7900.0 || s["port_max"] != 8899.0 || s["port_block"] != 10.0 ||
		s["dir"] != filepath.Join(e.data, "worktrees") {
		t.Fatalf("默认端口范围：%d %v", code, out)
	}
	for _, bad := range []string{`{"port_min":7800}`, `{"port_min":80}`, `{"port_block":0}`, `{"port_min":9000,"port_max":9003,"port_block":5}`, `{"port_max":7000}`} {
		if code, out := call(t, h, "PATCH", "/api/projects/worktree-settings", bad); code != 400 {
			t.Fatalf("%s 应 400：%d %v", bad, code, out)
		}
	}
	// 范围里有被占的端口：跳过那一段
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	busy := l.Addr().(*net.TCPAddr).Port
	body := `{"port_min":` + strconv.Itoa(busy) + `,"port_max":` + strconv.Itoa(busy+5) + `,"port_block":2}`
	if code, out := call(t, h, "PATCH", "/api/projects/worktree-settings", body); code != 200 || data(out)["port_block"] != 2.0 {
		t.Fatalf("改范围：%d %v", code, out)
	}
	repo := newRepo(t)
	call(t, h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+repo+`"}`)
	e.task(t, "obj_t1", "TSK-T1", "obj_p1")
	code, out = call(t, h, "POST", "/api/projects/worktrees", `{"task_id":"obj_t1"}`)
	if w := data(out); code != 201 || w["port_start"] == float64(busy) || w["port_count"] != 2.0 {
		t.Fatalf("要跳过被占的端口：%d %v（占着 %d）", code, out, busy)
	}
}

// SOP 节点「准备工作区」：输出加 worktree，下游 Claude Code 的工作目录填 {{worktree.path}}；没确认 process:spawn 时说清楚
func TestPrepareWorktreeNode(t *testing.T) {
	e := setupWT(t)
	repo := newRepo(t)
	if err := os.MkdirAll(filepath.Join(repo, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(repo, "app", "main.go"), "package main\n")
	gitRun(t, repo, "add", ".")
	gitRun(t, repo, "commit", "-q", "-m", "app")
	// 代码库目录是仓库里的子目录：worktree 建整个仓库，path 指到对应的子目录
	call(t, e.h, "PATCH", "/api/projects/obj_p1/profile", `{"code_dir":"`+filepath.Join(repo, "app")+`"}`)
	e.task(t, "obj_t1", "TSK-T1", "obj_p1")
	ctx := context.Background()
	sop := e.probe.c.SOP()
	out, err := sop.RunNode(ctx, NodePrepareWorktree, plugin.SOPNodeInput{RunID: "sr_1", Step: "wt", Attempt: 1,
		Input: map[string]any{"task_id": "obj_t1", "keep": "x"}, Config: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	wt, _ := out["worktree"].(map[string]any)
	root := filepath.Join(e.data, "worktrees", "obj_p1", "TSK-T1")
	if out["keep"] != "x" || wt["root"] != root || wt["path"] != filepath.Join(root, "app") || wt["branch"] != "auto/TSK-T1" || wt["reused"] != false {
		t.Fatalf("节点输出：%v", out)
	}
	if render("{{worktree.path}}", out) != filepath.Join(root, "app") {
		t.Fatal("{{worktree.path}} 要取到执行目录")
	}
	// 按配置的 ref 找任务，复用
	out, err = sop.RunNode(ctx, NodePrepareWorktree, plugin.SOPNodeInput{Input: map[string]any{"t": "TSK-T1"}, Config: map[string]string{"task": "{{t}}"}})
	if err != nil || out["worktree"].(map[string]any)["reused"] != true {
		t.Fatalf("复用：%v %v", out, err)
	}
	if _, err := sop.RunNode(ctx, NodePrepareWorktree, plugin.SOPNodeInput{Input: map[string]any{}, Config: map[string]string{}}); err == nil ||
		!strings.Contains(err.Error(), "没有指定任务") {
		t.Fatalf("没指定任务：%v", err)
	}
	// 没确认 process:spawn：服务直接回说明
	s := newWorktreeService(denyCore{})
	if _, err := s.Prepare(ctx, "obj_t1"); err == nil || !strings.Contains(err.Error(), "process:spawn") {
		t.Fatalf("没确认权限：%v", err)
	}
}
