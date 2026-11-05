package sop

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 写进项目目录（local_append）：只在临时目录里写。项目的关联目录指到 t.TempDir() 下。

type localEnv struct {
	writeEnv
	root    string // 临时目录（解析过符号链接）
	docs    string // 项目第一个关联目录
	inbox   string // 第二个关联目录
	outside string // 项目目录外面
}

func newLocalEnv(t *testing.T) localEnv {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := localEnv{writeEnv: newWriteEnv(t), root: root, docs: filepath.Join(root, "acme-project"), inbox: filepath.Join(root, "收件"), outside: filepath.Join(root, "outside")}
	for _, d := range []string{e.docs, e.inbox, e.outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	related, _ := json.Marshal(map[string]any{"related": []map[string]string{{"label": "文档", "path": e.docs}, {"label": "收件", "path": "file://" + e.inbox}}})
	gone, _ := json.Marshal(map[string]any{"related": []map[string]string{{"label": "没了", "path": filepath.Join(root, "nope")}}})
	rel, _ := json.Marshal(map[string]any{"related": []map[string]string{{"label": "相对", "path": "docs/x"}}})
	e.exec(t, `INSERT INTO objects (id, type_id, ref, title, props, created_at, updated_at) VALUES
		('obj_acme', 'project', 'PRJ-0101', 'Acme', ?, '2026-01-01', '2026-01-01'),
		('obj_bare', 'project', 'PRJ-0102', '空项目', '{}', '2026-01-02', '2026-01-02'),
		('obj_gone', 'project', 'PRJ-0103', '目录没了', ?, '2026-01-03', '2026-01-03'),
		('obj_rel', 'project', 'PRJ-0104', '相对目录', ?, '2026-01-04', '2026-01-04')`, string(related), string(gone), string(rel))
	old := localNow
	localNow = func() time.Time { return time.Date(2026, 11, 2, 9, 30, 0, 0, time.Local) }
	t.Cleanup(func() { localNow = old })
	return e
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestLocalAppendWritesAndAppends(t *testing.T) {
	e := newLocalEnv(t)
	r, h := e.boot(New())
	defer r.Close()
	fid := newFlow(t, h, `{"name":"收件","fields":[{"key":"text","label":"正文","type":"text"},{"key":"who","label":"谁","type":"text"}],"steps":[
		{"key":"w","name":"写进项目目录","kind":"local_append","after":[],"config":{"project":"Acme","path":"IM收件/{{date}}.md","content":"## {{time}} {{who}}\n{{text}}"}}]}`)
	run := waitStatus(t, h, startRun(t, h, fid, `{"input":{"text":"排期往后挪一周","who":"林原"}}`)["id"].(string), "done")
	f := step(run, "w")["output"].(map[string]any)["file"].(map[string]any)
	want := filepath.Join(e.docs, "IM收件", "2026-11-02.md")
	if f["path"] != want || f["rel"] != "IM收件/2026-11-02.md" || f["created"] != true || f["dir_label"] != "文档" ||
		f["project"].(map[string]any)["id"] != "obj_acme" {
		t.Fatalf("输出 %v", f)
	}
	if got := read(t, want); got != "## 09:30 林原\n排期往后挪一周\n" {
		t.Fatalf("新建的内容 %q", got)
	}
	// 再跑一次：追加，前面空一行
	run = waitStatus(t, h, startRun(t, h, fid, `{"input":{"text":"第二条","who":"周屿"}}`)["id"].(string), "done")
	if f := step(run, "w")["output"].(map[string]any)["file"].(map[string]any); f["created"] != false {
		t.Fatalf("第二次是追加：%v", f)
	}
	if got := read(t, want); got != "## 09:30 林原\n排期往后挪一周\n\n## 09:30 周屿\n第二条\n" {
		t.Fatalf("追加后 %q", got)
	}
	// 文件末尾没有换行时补两个
	if err := os.WriteFile(filepath.Join(e.inbox, "a.md"), []byte("旧内容"), 0o644); err != nil {
		t.Fatal(err)
	}
	// dir 按 label、按序号选；项目按 ref 认；关联目录存成 file:// 也认
	for _, dir := range []string{"收件", "2"} {
		fid := newFlow(t, h, `{"name":"选目录","steps":[
			{"key":"w","name":"写","kind":"local_append","after":[],"config":{"project":"prj-0101","dir":"`+dir+`","path":"a.md","content":"新的"}}]}`)
		waitStatus(t, h, startRun(t, h, fid, `{}`)["id"].(string), "done")
	}
	if got := read(t, filepath.Join(e.inbox, "a.md")); got != "旧内容\n\n新的\n\n新的\n" {
		t.Fatalf("选第二个目录追加 %q", got)
	}
	// 每次写入记一条审计
	n := e.count(t, `SELECT count(*) FROM audits WHERE action = 'append' AND target_type = 'file'`)
	if n != 4 {
		t.Fatalf("审计 %d 条", n)
	}
}

func TestLocalAppendRejects(t *testing.T) {
	e := newLocalEnv(t)
	// 项目目录里放两个指到外面的符号链接：一个目录、一个文件
	if err := os.Symlink(e.outside, filepath.Join(e.docs, "out")); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(e.outside, "secret.md")
	if err := os.WriteFile(secret, []byte("别动\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(e.docs, "link.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(e.docs, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	r, h := e.boot(New())
	defer r.Close()
	big := strings.Repeat("字", 22000)
	cases := []struct{ name, cfg, input, want string }{
		{"点点", `{"project":"Acme","path":"../outside/x.md","content":"x"}`, `{}`, "不能有 .."},
		{"字段里的点点", `{"project":"Acme","path":"{{p}}","content":"x"}`, `{"p":"a/../../outside/x.md"}`, "不能有 .."},
		{"绝对路径", `{"project":"Acme","path":"` + filepath.Join(e.outside, "x.md") + `","content":"x"}`, `{}`, "不能是绝对路径"},
		{"符号链接目录", `{"project":"Acme","path":"out/x.md","content":"x"}`, `{}`, "越出了项目目录"},
		{"符号链接目录下新建子目录", `{"project":"Acme","path":"out/new/x.md","content":"x"}`, `{}`, "越出了项目目录"},
		{"符号链接文件", `{"project":"Acme","path":"link.md","content":"x"}`, `{}`, "越出了项目目录"},
		{"目录", `{"project":"Acme","path":"sub","content":"x"}`, `{}`, "不是普通文件"},
		{"路径空", `{"project":"Acme","path":"{{nothing}}","content":"x"}`, `{}`, "文件路径是空的"},
		{"内容空", `{"project":"Acme","path":"a.md","content":"{{nothing}}"}`, `{}`, "要写的内容是空的"},
		{"太大", `{"project":"Acme","path":"a.md","content":"{{big}}"}`, `{"big":"` + big + `"}`, "一次最多 64 KB"},
		{"项目不存在", `{"project":"Nope","path":"a.md","content":"x"}`, `{}`, "项目「Nope」不存在"},
		{"没关联目录", `{"project":"空项目","path":"a.md","content":"x"}`, `{}`, "没有关联本地目录"},
		{"关联目录没了", `{"project":"目录没了","path":"a.md","content":"x"}`, `{}`, "不存在"},
		{"关联目录是相对路径", `{"project":"相对目录","path":"a.md","content":"x"}`, `{}`, "不是绝对路径"},
		{"没有这个序号", `{"project":"Acme","dir":"3","path":"a.md","content":"x"}`, `{}`, "没有第 3 个"},
		{"没有这个 label", `{"project":"Acme","dir":"素材","path":"a.md","content":"x"}`, `{}`, "没有叫「素材」的关联目录"},
	}
	for _, c := range cases {
		fid := newFlow(t, h, `{"name":"`+c.name+`","fields":[{"key":"p","label":"p","type":"text"},{"key":"big","label":"big","type":"text"}],"steps":[
			{"key":"w","name":"写","kind":"local_append","after":[],"config":`+c.cfg+`}]}`)
		rid := startRun(t, h, fid, `{"input":`+c.input+`}`)["id"].(string)
		var run map[string]any
		waitFor(t, c.name+" 失败", func() bool { run = getRun(t, h, rid); return step(run, "w")["status"] == "failed" })
		if err, _ := step(run, "w")["error"].(string); !strings.Contains(err, c.want) {
			t.Errorf("%s：错误 %q，要含 %q", c.name, err, c.want)
		}
	}
	if got := read(t, secret); got != "别动\n" {
		t.Fatalf("外面的文件被改了：%q", got)
	}
	if ents, _ := os.ReadDir(e.outside); len(ents) != 1 {
		t.Fatalf("外面多了东西：%v", ents)
	}
	if _, err := os.Stat(filepath.Join(e.docs, "a.md")); !os.IsNotExist(err) {
		t.Fatalf("失败的不该写出文件：%v", err)
	}
	if n := e.count(t, `SELECT count(*) FROM audits WHERE action = 'append'`); n != 0 {
		t.Fatalf("失败的不记审计：%d", n)
	}
}

// 项目目录里指向项目目录里面的符号链接照常能写，写到它指向的文件
func TestLocalAppendInnerSymlink(t *testing.T) {
	e := newLocalEnv(t)
	real := filepath.Join(e.docs, "real.md")
	if err := os.WriteFile(real, []byte("一\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(e.docs, "alias.md")); err != nil {
		t.Fatal(err)
	}
	r, h := e.boot(New())
	defer r.Close()
	fid := newFlow(t, h, `{"name":"内部链接","steps":[{"key":"w","name":"写","kind":"local_append","after":[],"config":{"project":"obj_acme","path":"alias.md","content":"二"}}]}`)
	run := waitStatus(t, h, startRun(t, h, fid, `{}`)["id"].(string), "done")
	if f := step(run, "w")["output"].(map[string]any)["file"].(map[string]any); f["path"] != real {
		t.Fatalf("写到指向的文件：%v", f)
	}
	if got := read(t, real); got != "一\n\n二\n" {
		t.Fatalf("%q", got)
	}
}

// 写完、结果还没落库时服务退出：重启后重跑同一次尝试，不重复追加
func TestLocalAppendResumeNoDuplicate(t *testing.T) {
	e := newLocalEnv(t)
	entered := make(chan struct{}, 1)
	afterWrite = func(c context.Context, step string) error {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-c.Done()
		return c.Err()
	}
	defer func() { afterWrite = nil }()
	r1, h1 := e.boot(New())
	fid := newFlow(t, h1, `{"name":"续跑","steps":[{"key":"w","name":"写","kind":"local_append","after":[],"config":{"project":"Acme","path":"log.md","content":"只写一次"}}]}`)
	rid := startRun(t, h1, fid, `{}`)["id"].(string)
	<-entered
	r1.Close()

	afterWrite = nil
	r2, h2 := e.boot(New())
	defer r2.Close()
	run := waitStatus(t, h2, rid, "done")
	if s := step(run, "w"); !hasLog(s, "没有重复写") || s["output"].(map[string]any)["file"].(map[string]any)["path"] != filepath.Join(e.docs, "log.md") {
		t.Fatalf("log=%v output=%v", s["log"], s["output"])
	}
	if got := read(t, filepath.Join(e.docs, "log.md")); got != "只写一次\n" {
		t.Fatalf("重启后重复写了：%q", got)
	}
}

// 建任务认项目 id、ref、名字；认不出来这一步失败，不建任务
func TestTaskProjectByRefOrName(t *testing.T) {
	e := newLocalEnv(t)
	r, h := e.boot(New())
	defer r.Close()
	fid := newFlow(t, h, `{"name":"挂项目","fields":[{"key":"p","label":"p","type":"text"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"跟进","project":"{{p}}"}}]}`)
	for _, key := range []string{"obj_acme", "PRJ-0101", "Acme"} {
		run := waitStatus(t, h, startRun(t, h, fid, `{"input":{"p":"`+key+`"}}`)["id"].(string), "done")
		task := step(run, "t")["output"].(map[string]any)["task"].(map[string]any)
		o, err := e.st.GetObject(context.Background(), task["id"].(string))
		if err != nil || o.ProjectID == nil || *o.ProjectID != "obj_acme" || task["project_id"] != "obj_acme" || task["project"] != "Acme" {
			t.Fatalf("%s：任务 %v 项目 %v", key, task, o.ProjectID)
		}
	}
	rid := startRun(t, h, fid, `{"input":{"p":"Nope"}}`)["id"].(string)
	var run map[string]any
	waitFor(t, "失败", func() bool { run = getRun(t, h, rid); return step(run, "t")["status"] == "failed" })
	if err, _ := step(run, "t")["error"].(string); !strings.Contains(err, "项目「Nope」不存在") {
		t.Fatalf("%q", err)
	}
	if n := e.count(t, `SELECT count(*) FROM objects WHERE type_id = 'task'`); n != 3 {
		t.Fatalf("认不出项目时不建任务：%d", n)
	}
}
