package sop

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 失败执行重跑的幂等和「已重跑」（迁移 0005 的 relaunched_to）：
// 重跑后原执行从「失败」「待我处理」、今日卡片里拿掉，「全部」里仍在并指向新执行；再重跑跳过；并发重跑只建一条；
// 已重跑的不能再重试；retry 第二次跳过；迁移把存量的批量重跑回填上。

// 没接模型时 AI 节点失败，起一条失败的执行
func failedRun(t *testing.T, h http.Handler, flowID, topic string) string {
	t.Helper()
	id := startRun(t, h, flowID, `{"input":{"topic":"`+topic+`"}}`)["id"].(string)
	waitStatus(t, h, id, "failed")
	return id
}

func batchAct(t *testing.T, h http.Handler, action string, ids ...string) map[string]any {
	t.Helper()
	code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"`+action+`","run_ids":["`+strings.Join(ids, `","`)+`"]}`)
	if code != 200 {
		t.Fatalf("批量 %s：%d %v", action, code, out)
	}
	return out["data"].(map[string]any)
}

func listIDs(t *testing.T, h http.Handler, q string) map[string]map[string]any {
	t.Helper()
	code, out := call(t, h, "GET", "/api/sop/runs"+q, "")
	if code != 200 {
		t.Fatalf("列表 %s：%d %s", q, code, errMsg(out))
	}
	m := map[string]map[string]any{}
	for _, x := range out["data"].([]any) {
		r := x.(map[string]any)
		m[r["id"].(string)] = r
	}
	if total := int(out["meta"].(map[string]any)["total"].(float64)); total != len(m) {
		t.Fatalf("列表 %s total=%d 条数=%d", q, total, len(m))
	}
	return m
}

func countSource(t *testing.T, h http.Handler, ref string) int {
	t.Helper()
	n := 0
	for _, r := range listIDs(t, h, "") {
		if r["source_ref"] == ref && r["source_name"] == relaunchSourceName {
			n++
		}
	}
	return n
}

func TestRelaunchMarksAndIsIdempotent(t *testing.T) {
	r, h := setup(t, New())
	ctx := context.Background()
	fid := newFlow(t, h, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	f1 := failedRun(t, h, fid, "周会")
	f2 := failedRun(t, h, fid, "复盘")

	d := batchAct(t, h, "relaunch", f1)
	if len(d["done"].([]any)) != 1 {
		t.Fatalf("第一次重跑新起一条：%v", d)
	}
	nid := d["done"].([]any)[0].(map[string]any)["new_run_id"].(string)

	// 原执行仍是 failed，带 relaunched_to；「失败」「待我处理」里没有它，「全部」里有
	orig := getRun(t, h, f1)
	if orig["status"] != "failed" || orig["relaunched_to"] != nid {
		t.Fatalf("原执行：status=%v relaunched_to=%v", orig["status"], orig["relaunched_to"])
	}
	for _, q := range []string{"?status=failed", "?mine=true", "?status=failed,waiting", "?status=failed&mine=true"} {
		got := listIDs(t, h, q)
		if _, ok := got[f1]; ok {
			t.Fatalf("%s 里不该有已重跑的 %s", q, f1)
		}
		if _, ok := got[f2]; !ok {
			t.Fatalf("%s 里该有没重跑的 %s", q, f2)
		}
	}
	all := listIDs(t, h, "")
	if x, ok := all[f1]; !ok || x["relaunched_to"] != nid || x["status"] != "failed" {
		t.Fatalf("全部里的已重跑：%v", x)
	}
	if _, ok := all[f2]["relaunched_to"]; ok {
		t.Fatalf("没重跑的不带 relaunched_to：%v", all[f2])
	}
	// 今日卡片不数已重跑的：没重跑的 f2 和新执行（没接模型也失败）
	waitStatus(t, h, nid, "failed")
	seen := false
	for _, c := range r.TodayCards(ctx) {
		if c.Key == "sop_pending" {
			seen = true
			items, _ := json.Marshal(c.Items)
			if c.Total != 2 || strings.Contains(string(items), f1) || !strings.Contains(string(items), f2) {
				t.Fatalf("今日卡片 total=%d items=%s", c.Total, items)
			}
		}
	}
	if !seen {
		t.Fatal("还有没重跑的失败，今日卡片要在")
	}

	// 再重跑一次：跳过「已重跑过」并带新执行 id，不新建
	d = batchAct(t, h, "relaunch", f1)
	if len(d["done"].([]any)) != 0 || len(d["skipped"].([]any)) != 1 {
		t.Fatalf("第二次重跑跳过：%v", d)
	}
	sk := d["skipped"].([]any)[0].(map[string]any)
	if sk["reason"] != reasonRelaunched || sk["new_run_id"] != nid {
		t.Fatalf("跳过原因：%v", sk)
	}
	// 已重跑的也不再批量重试、单条重试
	d = batchAct(t, h, "retry", f1)
	if len(d["skipped"].([]any)) != 1 || d["skipped"].([]any)[0].(map[string]any)["reason"] != reasonRelaunched {
		t.Fatalf("已重跑的批量重试跳过：%v", d)
	}
	if code, out := act(t, h, f1, `{"kind":"retry","step":"ai"}`); code != 409 || !strings.Contains(errMsg(out), nid) {
		t.Fatalf("已重跑的单条重试 409：%d %v", code, out)
	}
	if code, _ := act(t, h, f1, `{"kind":"skip","step":"ai"}`); code != 409 {
		t.Fatalf("已重跑的跳过步骤 409：%d", code)
	}
	if n := countSource(t, h, f1); n != 1 {
		t.Fatalf("f1 只重跑出 1 条，实际 %d", n)
	}
}

// 同一条失败执行并发重跑：条件更新占位，只建一条
func TestRelaunchConcurrentCreatesOne(t *testing.T) {
	_, h := setup(t, New())
	fid := newFlow(t, h, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	id := failedRun(t, h, fid, "周会")
	const n = 8
	var wg sync.WaitGroup
	var mu sync.Mutex
	done, skipped := 0, 0
	newIDs := map[string]bool{}
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"relaunch","run_ids":["`+id+`"]}`)
			if code != 200 {
				t.Errorf("并发重跑：%d %v", code, out)
				return
			}
			d := out["data"].(map[string]any)
			mu.Lock()
			defer mu.Unlock()
			for _, x := range d["done"].([]any) {
				done++
				newIDs[x.(map[string]any)["new_run_id"].(string)] = true
			}
			for _, x := range d["skipped"].([]any) {
				skipped++
				r := x.(map[string]any)["reason"]
				if r != reasonRelaunched && r != reasonRelaunching {
					t.Errorf("跳过原因：%v", r)
				}
			}
		}()
	}
	wg.Wait()
	if done != 1 || skipped != n-1 {
		t.Fatalf("并发 %d 次：新起 %d、跳过 %d", n, done, skipped)
	}
	if c := countSource(t, h, id); c != 1 {
		t.Fatalf("库里重跑出来的执行 %d 条", c)
	}
	var nid string
	for k := range newIDs {
		nid = k
	}
	if got := getRun(t, h, id)["relaunched_to"]; got != nid {
		t.Fatalf("relaunched_to=%v，要 %s", got, nid)
	}
}

// 子执行失败：重跑顶层后，顶层和它下面失败的子执行都算已重跑；再点子执行跳过
func TestRelaunchSubflowMarksChildren(t *testing.T) {
	_, h := setup(t, New())
	newFlow(t, h, `{"name":"子流程","steps":[{"key":"ai","name":"AI","kind":"ai","after":[]}]}`)
	parent := newFlow(t, h, `{"name":"父流程","steps":[{"key":"a","name":"子 A","kind":"subflow","after":[],"config":{"sop":"子流程"}}]}`)
	pid := startRun(t, h, parent, `{}`)["id"].(string)
	var ca string
	waitFor(t, "起了子执行", func() bool {
		ca, _ = step(getRun(t, h, pid), "a")["child_run_id"].(string)
		return ca != ""
	})
	waitStatus(t, h, ca, "failed")
	d := batchAct(t, h, "relaunch", ca)
	if len(d["done"].([]any)) != 1 {
		t.Fatalf("子执行重跑顶层：%v", d)
	}
	nid := d["done"].([]any)[0].(map[string]any)["new_run_id"].(string)
	if getRun(t, h, pid)["relaunched_to"] != nid || getRun(t, h, ca)["relaunched_to"] != nid {
		t.Fatal("顶层和失败的子执行都记新执行")
	}
	failed := listIDs(t, h, "?status=failed")
	if _, ok := failed[pid]; ok {
		t.Fatal("顶层不在失败里")
	}
	if _, ok := failed[ca]; ok {
		t.Fatal("子执行不在失败里")
	}
	d = batchAct(t, h, "relaunch", pid, ca)
	if len(d["done"].([]any)) != 0 || len(d["skipped"].([]any)) != 2 {
		t.Fatalf("再点跳过：%v", d)
	}
}

// retry：进到 runner 时步骤已不是失败（另一次已经重试上了）就跳过，并发两次只重试一次
func TestRetrySecondTimeSkipped(t *testing.T) {
	// 第一次进 AI 节点放行（没接模型，失败），之后卡住，让重试后的执行停在执行中
	var mu sync.Mutex
	entered := 0
	release := make(chan struct{})
	p := New()
	p.stepHook = func(ctx context.Context, _, key string) error {
		mu.Lock()
		entered++
		first := entered == 1
		mu.Unlock()
		if first {
			return nil
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	_, h := setup(t, p)
	t.Cleanup(func() { close(release) })
	fid := newFlow(t, h, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	id := failedRun(t, h, fid, "周会")

	const n = 4
	var wg sync.WaitGroup
	var cmu sync.Mutex
	done, skipped := 0, 0
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"retry","run_ids":["`+id+`"]}`)
			if code != 200 {
				t.Errorf("并发重试：%d %v", code, out)
				return
			}
			d := out["data"].(map[string]any)
			cmu.Lock()
			defer cmu.Unlock()
			done += len(d["done"].([]any))
			for _, x := range d["skipped"].([]any) {
				skipped++
				if r := x.(map[string]any)["reason"].(string); !strings.HasPrefix(r, "不是失败状态") {
					t.Errorf("跳过原因：%s", r)
				}
			}
			if f := d["failed"].([]any); len(f) != 0 {
				t.Errorf("不该出错：%v", f)
			}
		}()
	}
	wg.Wait()
	if done != 1 || skipped != n-1 {
		t.Fatalf("并发重试 %d 次：重试 %d、跳过 %d", n, done, skipped)
	}
	run := waitStatus(t, h, id, "running")
	if a := step(run, "ai")["attempts"]; a != float64(2) {
		t.Fatalf("只重试一次，attempts=%v", a)
	}
	// 再来一次：执行中，跳过
	d := batchAct(t, h, "retry", id)
	if len(d["skipped"].([]any)) != 1 || d["skipped"].([]any)[0].(map[string]any)["reason"] != "不是失败状态（执行中）" {
		t.Fatalf("执行中的再重试跳过：%v", d)
	}
	if _, ok := listIDs(t, h, "?status=failed")[id]; ok {
		t.Fatal("重试进入执行中后不在失败里")
	}
}

// 存量回填（迁移 0005 只加列，启动时 backfillRelaunched 补）：以前的批量重跑记到原执行（多次取最新），
// 失败的子执行跟着顶层；手动发起的同 source_ref 不算；补过再跑一遍不变
func TestBackfillRelaunched(t *testing.T) {
	ctx := context.Background()
	r, _, d := setupDB(t, New())
	// This test invokes backfill itself after seeding all historical runs. Stop
	// the engine so its startup backfill cannot race the fixture inserts.
	r.Close()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := d.W.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s：%v", q[:min(60, len(q))], err)
		}
	}
	ins := func(id, status, parent, source, ref, name, started string) {
		exec(`INSERT INTO sop_runs (id, flow_id, flow_version, title, flow, status, parent_run_id, source, source_ref, source_name, started_at, updated_at)
			VALUES (?, 'f', 1, 't', '{}', ?, ?, ?, ?, ?, ?, ?)`, id, status, nullStr(parent), source, ref, name, started, started)
	}
	ins("a", "failed", "", "", "", "", "2026-01-01T00:00:00.000Z")
	ins("a_child", "failed", "a", "subflow", "a", "", "2026-01-01T00:00:01.000Z")
	ins("a_grand", "failed", "a_child", "subflow", "a_child", "", "2026-01-01T00:00:02.000Z")
	ins("a_ok_child", "done", "a", "subflow", "a", "", "2026-01-01T00:00:01.000Z")
	ins("a_new1", "failed", "", "manual", "a", "批量重跑", "2026-01-02T00:00:00.000Z")
	ins("a_new2", "done", "", "manual", "a", "批量重跑", "2026-01-03T00:00:00.000Z")
	ins("b", "failed", "", "", "", "", "2026-01-01T00:00:00.000Z")
	ins("b_manual", "done", "", "manual", "b", "", "2026-01-02T00:00:00.000Z")
	ins("c", "failed", "", "", "", "", "2026-01-01T00:00:00.000Z")

	ins("d", "failed", "", "", "", "", "2026-01-01T00:00:00.000Z")
	exec(`UPDATE sop_runs SET relaunched_to = 'pending:x' WHERE id = 'd'`)
	ins("e", "failed", "", "", "", "", "2026-01-01T00:00:00.000Z")
	ins("e_new", "running", "", "manual", "e", "批量重跑", "2026-01-02T00:00:00.000Z")
	exec(`UPDATE sop_runs SET relaunched_to = 'pending:y' WHERE id = 'e'`)

	want := map[string]string{"a": "a_new2", "a_child": "a_new2", "a_grand": "a_new2", "a_ok_child": "", "a_new1": "", "a_new2": "", "b": "", "b_manual": "", "c": ""}
	want["d"], want["e"], want["e_new"] = "", "e_new", ""
	for range 2 {
		if err := backfillRelaunched(ctx, rawStore{d}); err != nil {
			t.Fatal(err)
		}
		for id, w := range want {
			var got sql.NullString
			if err := d.R.QueryRowContext(ctx, `SELECT relaunched_to FROM sop_runs WHERE id = ?`, id).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got.String != w {
				t.Fatalf("%s relaunched_to=%q，要 %q", id, got.String, w)
			}
		}
	}
}

// 服务启动时修残留的占位（backfillRelaunched）：新执行建好了的记上，没建成的清掉
func TestFixRelaunchClaims(t *testing.T) {
	_, h, d := setupDB(t, New())
	ctx := context.Background()
	fid := newFlow(t, h, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	f1 := failedRun(t, h, fid, "周会")
	f2 := failedRun(t, h, fid, "复盘")
	nid := batchAct(t, h, "relaunch", f1)["done"].([]any)[0].(map[string]any)["new_run_id"].(string)
	// 模拟两条重跑到一半停了：f1 已经建好新执行，f2 还没建
	for _, id := range []string{f1, f2} {
		if _, err := d.W.ExecContext(ctx, `UPDATE sop_runs SET relaunched_to = 'pending:x' WHERE id = ?`, id); err != nil {
			t.Fatal(err)
		}
	}
	// 占位中：不在失败里，重跑、重试都跳过「正在重跑」
	if _, ok := listIDs(t, h, "?status=failed")[f2]; ok {
		t.Fatal("占位中的不在失败里")
	}
	if x, ok := listIDs(t, h, "")[f2]; !ok || x["relaunched_to"] != nil {
		t.Fatalf("占位不往外给：%v", x)
	}
	for _, a := range []string{"retry", "relaunch"} {
		if sk := batchAct(t, h, a, f2)["skipped"].([]any); len(sk) != 1 || sk[0].(map[string]any)["reason"] != reasonRelaunching {
			t.Fatalf("%s 占位中跳过：%v", a, sk)
		}
	}
	if err := backfillRelaunched(ctx, rawStore{d}); err != nil {
		t.Fatal(err)
	}
	if got := getRun(t, h, f1)["relaunched_to"]; got != nid {
		t.Fatalf("f1 补回新执行：%v", got)
	}
	if got := getRun(t, h, f2)["relaunched_to"]; got != nil {
		t.Fatalf("f2 清掉占位：%v", got)
	}
	if _, ok := listIDs(t, h, "?status=failed")[f2]; !ok {
		t.Fatal("清掉占位后回到失败")
	}
}

// rawStore 直接用测试库实现 plugin.Store（不做表名检查），测启动时的修补用
type rawStore struct{ d *db.DB }

func (s rawStore) Exec(ctx context.Context, q string, args ...any) (sql.Result, error) {
	return s.d.W.ExecContext(ctx, q, args...)
}
func (s rawStore) Query(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	return s.d.R.QueryContext(ctx, q, args...)
}
func (s rawStore) QueryRow(ctx context.Context, q string, args ...any) plugin.Row {
	return s.d.R.QueryRowContext(ctx, q, args...)
}
