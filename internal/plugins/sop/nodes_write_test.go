// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// 写节点（SOP-02a）：建任务、写文档、写联系人走内核句柄，来源 sop，每次写入一条审计，重启重跑不重复写。

type writeEnv struct {
	st   *sqlite.Store
	boot func(p *Plugin) (*plugin.Registry, http.Handler)
}

// 内核 store 和插件注册表用同一个库，boot 可以调多次模拟重启
func newWriteEnv(t *testing.T) writeEnv {
	t.Helper()
	ctx := context.Background()
	st, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	installed := false
	boot := func(p *Plugin) (*plugin.Registry, http.Handler) {
		r := plugin.NewRegistry(plugin.NewSQLStateStore(st.DB()), slog.New(slog.NewTextHandler(io.Discard, nil)))
		r.Migrations = plugin.NewSQLMigrationStore(st.DB())
		r.SetObjectCreator(st)
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
		if err := r.Start(ctx); err != nil {
			t.Fatal(err)
		}
		if !installed {
			installed = true
			if err := r.Install(ctx, "sop", sopPerms); err != nil {
				t.Fatal(err)
			}
			if err := r.Enable(ctx, "sop"); err != nil {
				t.Fatal(err)
			}
		}
		mux := http.NewServeMux()
		for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
			mux.HandleFunc(rt.Pattern, rt.Handler)
		}
		return r, mux
	}
	return writeEnv{st: st, boot: boot}
}

func (e writeEnv) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := e.st.DB().W.Exec(q, args...); err != nil {
		t.Fatal(err)
	}
}

type auditRow struct {
	action, targetType, targetID, actor, source string
	detail                                      map[string]any
}

func (e writeEnv) audits(t *testing.T, actor string) []auditRow {
	t.Helper()
	rows, err := e.st.DB().R.Query(`SELECT action, target_type, target_id, actor, source, detail FROM audits WHERE actor = ? ORDER BY at, rowid`, actor)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []auditRow
	for rows.Next() {
		var a auditRow
		var d string
		if err := rows.Scan(&a.action, &a.targetType, &a.targetID, &a.actor, &a.source, &d); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal([]byte(d), &a.detail)
		out = append(out, a)
	}
	return out
}

func (e writeEnv) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := e.st.DB().R.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestWriteNodes(t *testing.T) {
	e := newWriteEnv(t)
	r, h := e.boot(New())
	defer r.Close()
	e.exec(t, `INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_zhou', '周屿', 'x', 'x'), ('stk_liang', '梁晚晴', 'x', 'x')`)
	fid := newFlow(t, h, `{"name":"写节点","fields":[{"key":"customer","label":"客户","type":"text","default":"远川"}],"steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"跟进 {{customer}} 的反馈","priority":"P1","assignee":"周屿"}},
		{"key":"d","name":"存为内容摘录","kind":"doc","after":["t"],"config":{"title":"{{customer}} 反馈摘录","content":"任务 {{task.ref}}","category":"cat_doc_meet"}},
		{"key":"d2","name":"追加","kind":"doc","after":["d"],"config":{"mode":"append","doc":"{{content_id}}","content":"补一段"}},
		{"key":"c","name":"写入新联系人","kind":"contact","after":["d2"],"config":{"name":"何嘉宁","company":"远舟科技"}},
		{"key":"m","name":"合并字段","kind":"contact","after":["c"],"config":{"mode":"merge","id":"stk_liang","title":"采购总监","email":"wq@yc.tech"}}]}`)
	// 种子里有会议纪要分类；没有的话建一个
	if e.count(t, `SELECT count(*) FROM categories WHERE id = 'cat_doc_meet'`) == 0 {
		e.exec(t, `INSERT INTO categories (id, type_id, name, slug, path, depth, created_at, updated_at) VALUES ('cat_doc_meet', 'doc', '会议纪要', 'meeting', '/meeting/', 0, 'x', 'x')`)
	}
	run := startRun(t, h, fid, `{}`)
	rid := run["id"].(string)
	run = waitStatus(t, h, rid, "done")

	task := step(run, "t")["output"].(map[string]any)["task"].(map[string]any)
	if task["assignee"] != "周屿" || task["priority"] != "P1" || task["title"] != "跟进 远川 的反馈" || !strings.HasPrefix(task["ref"].(string), "TSK-") {
		t.Fatalf("task 输出 %v", task)
	}
	o, err := e.st.GetObject(context.Background(), task["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := o.Props["source_ref"].(map[string]any)
	if o.Source != "sop" || o.TypeID != "task" || o.OwnerID == nil || *o.OwnerID != "stk_zhou" || ref["run_id"] != rid || ref["step"] != "t" || ref["flow_id"] != fid {
		t.Fatalf("任务 source=%s owner=%v props=%v", o.Source, o.OwnerID, o.Props)
	}
	revs, _ := e.st.ListRevisions(context.Background(), o.ID, 10)
	if len(revs) == 0 || revs[0].Actor != "sop#"+rid {
		t.Fatalf("修订的操作者应当是 sop#运行 id：%+v", revs)
	}

	dout := step(run, "d")["output"].(map[string]any)
	doc, err := e.st.GetObject(context.Background(), dout["content_id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if doc.TypeID != "doc" || doc.Title != "远川 反馈摘录" || doc.CategoryID == nil || *doc.CategoryID != "cat_doc_meet" {
		t.Fatalf("文档 %+v", doc)
	}
	if doc.Body != "任务 "+task["ref"].(string)+"\n\n补一段" {
		t.Fatalf("追加后正文 %q", doc.Body)
	}

	cid := step(run, "c")["output"].(map[string]any)["contact_id"].(string)
	sh, err := e.st.GetStakeholder(context.Background(), cid)
	if err != nil || sh.Name != "何嘉宁" || sh.Company != "远舟科技" {
		t.Fatalf("新联系人 %+v %v", sh, err)
	}
	sh, _ = e.st.GetStakeholder(context.Background(), "stk_liang")
	if sh.Title != "采购总监" || sh.Email != "wq@yc.tech" {
		t.Fatalf("合并后 %+v", sh)
	}

	// 五次写入各一条审计，操作者 sop#<运行 id>，detail 带流程和步骤
	got := e.audits(t, "sop#"+rid)
	want := []struct{ action, typ, step string }{
		{"create", "object", "t"}, {"create", "object", "d"}, {"update", "object", "d2"}, {"create", "stakeholder", "c"}, {"update", "stakeholder", "m"},
	}
	if len(got) != len(want) {
		t.Fatalf("审计 %d 条：%+v", len(got), got)
	}
	for i, w := range want {
		a := got[i]
		if a.action != w.action || a.targetType != w.typ || a.source != "plugin" || a.detail["step"] != w.step ||
			a.detail["flow_id"] != fid || a.detail["flow"] != "写节点" || a.detail["run_id"] != rid || a.detail["write_key"] != rid+"/"+w.step+"#1" {
			t.Errorf("第 %d 条审计 %+v", i+1, a)
		}
	}
}

func TestWriteNodeFailures(t *testing.T) {
	e := newWriteEnv(t)
	r, h := e.boot(New())
	defer r.Close()
	fid := newFlow(t, h, `{"name":"写失败","steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"{{nothing}}"}},
		{"key":"d","name":"追加","kind":"doc","after":[],"config":{"mode":"append","doc":"obj_missing"}},
		{"key":"c","name":"联系人","kind":"contact","after":[],"config":{}},
		{"key":"m","name":"合并","kind":"contact","after":[],"config":{"mode":"merge","id":"stk_none","name":"x"}}]}`)
	run := startRun(t, h, fid, `{}`)
	rid := run["id"].(string)
	waitFor(t, "四步都失败", func() bool {
		run = getRun(t, h, rid)
		for _, k := range []string{"t", "d", "c", "m"} {
			if step(run, k)["status"] != "failed" {
				return false
			}
		}
		return true
	})
	for k, msg := range map[string]string{"t": "任务标题是空的", "d": "文档 obj_missing 不存在", "c": "联系人姓名是空的", "m": "联系人 stk_none 不存在"} {
		if s := step(run, k); !strings.Contains(s["error"].(string), msg) {
			t.Errorf("%s 的错误 %v", k, s["error"])
		}
	}
	if n := len(e.audits(t, "sop#"+rid)); n != 0 {
		t.Fatalf("失败的写不记审计，got %d", n)
	}
}

// 建任务写完、结果还没落库时服务退出：重启后按原来那次尝试重跑，任务只有一条；重试是新的一次尝试，会再建
func TestWriteNodeResumeNoDuplicate(t *testing.T) {
	e := newWriteEnv(t)
	ctx := context.Background()
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
	fid := newFlow(t, h1, `{"name":"续跑建任务","steps":[
		{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"只建一条"}},
		{"key":"chk","name":"检查","kind":"review","after":["t"]}]}`)
	rid := startRun(t, h1, fid, `{}`)["id"].(string)
	<-entered
	if n := e.count(t, `SELECT count(*) FROM objects WHERE source = 'sop'`); n != 1 {
		t.Fatalf("写进去了 %d 条", n)
	}
	r1.Close()
	var st string
	if err := e.st.DB().R.QueryRowContext(ctx, `SELECT status FROM sop_run_steps WHERE run_id = ? AND step_key = 't'`, rid).Scan(&st); err != nil || st != "running" {
		t.Fatalf("关掉后 t=%s %v", st, err)
	}

	afterWrite = nil
	r2, h2 := e.boot(New())
	defer r2.Close()
	run := waitStatus(t, h2, rid, "waiting")
	s := step(run, "t")
	if s["status"] != "done" || s["attempts"] != float64(1) || !hasLog(s, "服务重启后重跑") || !hasLog(s, "没有重复写") {
		t.Fatalf("重跑 status=%v attempts=%v log=%v", s["status"], s["attempts"], s["log"])
	}
	if n := e.count(t, `SELECT count(*) FROM objects WHERE source = 'sop' AND type_id = 'task'`); n != 1 {
		t.Fatalf("重启后任务应当只有一条，got %d", n)
	}
	if n := len(e.audits(t, "sop#"+rid)); n != 1 {
		t.Fatalf("审计应当只有一条，got %d", n)
	}
	// 退回重做是新的一次尝试，再建一条
	if code, out := act(t, h2, rid, `{"kind":"rework","step":"chk"}`); code != 200 {
		t.Fatalf("退回 %d %s", code, errMsg(out))
	}
	waitFor(t, "第二次尝试建好", func() bool { return len(e.audits(t, "sop#"+rid)) == 2 })
	if n := e.count(t, `SELECT count(*) FROM objects WHERE source = 'sop'`); n != 2 {
		t.Fatalf("第二次尝试后 %d 条", n)
	}
	got := e.audits(t, "sop#"+rid)
	if len(got) != 2 || got[1].detail["write_key"] != rid+"/t#2" {
		t.Fatalf("第二次尝试的审计 %+v", got)
	}
}

// 写成了但审计没落下（进程正好在这之间退出）：建对象按 props.source_ref.write_key 也能认出来
func TestWriteNodeResumeWithoutAudit(t *testing.T) {
	e := newWriteEnv(t)
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
	fid := newFlow(t, h1, `{"name":"没审计","steps":[{"key":"t","name":"建任务","kind":"task","after":[],"config":{"title":"只建一条"}}]}`)
	rid := startRun(t, h1, fid, `{}`)["id"].(string)
	<-entered
	r1.Close()
	e.exec(t, `DELETE FROM audits WHERE actor = ?`, "sop#"+rid)

	afterWrite = nil
	r2, h2 := e.boot(New())
	defer r2.Close()
	run := waitStatus(t, h2, rid, "done")
	if s := step(run, "t"); !hasLog(s, "没有重复写") {
		t.Fatalf("log=%v", s["log"])
	}
	if n := e.count(t, `SELECT count(*) FROM objects WHERE source = 'sop'`); n != 1 {
		t.Fatalf("任务应当只有一条，got %d", n)
	}
}
