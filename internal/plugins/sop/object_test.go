package sop

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 执行关联到工作对象（SOP-06）：在任务上手动发起带 object_id，Agent 经钩子发起带 ObjectID；
// 按 object_id 查只回这条任务的执行，子流程继承父执行的关联；对象不存在、在回收站里 400，钩子发起时不关联照常起。
func TestRunsLinkedToObject(t *testing.T) {
	ctx := context.Background()
	reg, h, d := setupDB(t, New())
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_t1', 'task', 'TSK-T1', '任务一', '` + now + `', '` + now + `')`,
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_t2', 'task', 'TSK-T2', '任务二', '` + now + `', '` + now + `')`,
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at, deleted_at) VALUES ('obj_gone', 'task', 'TSK-T3', '删了', '` + now + `', '` + now + `', '` + now + `')`,
	} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	child := newFlow(t, h, `{"name":"子流程","steps":[{"key":"r","name":"子检查","kind":"review"}]}`)
	_ = child
	parent := newFlow(t, h, `{"name":"父流程","fields":[{"key":"title","label":"标题","type":"text"}],"steps":[
		{"key":"sub","name":"跑子流程","kind":"subflow","after":[],"config":{"sop":"子流程"}},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	plain := newFlow(t, h, `{"name":"检查","steps":[{"key":"r","name":"检查","kind":"review"}]}`)

	// 手动发起：响应带 object_id
	run := startRun(t, h, parent, `{"input":{"title":"任务一"},"object_id":"obj_t1"}`)
	rid := run["id"].(string)
	if run["object_id"] != "obj_t1" {
		t.Fatalf("发起的执行应带 object_id：%v", run["object_id"])
	}
	var cid string
	waitFor(t, "起了子执行", func() bool {
		cid, _ = step(getRun(t, h, rid), "sub")["child_run_id"].(string)
		return cid != ""
	})
	if c := waitStatus(t, h, cid, "waiting"); c["object_id"] != "obj_t1" {
		t.Fatalf("子执行应继承父执行的关联：%v", c["object_id"])
	}

	// Agent 经钩子发起
	got, err := reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: plain, Source: "agent", SourceID: "ag_1", ObjectID: "obj_t1"})
	if err != nil {
		t.Fatal(err)
	}
	if r := getRun(t, h, got.RunID); r["object_id"] != "obj_t1" {
		t.Fatalf("Agent 发起的应带关联：%v", r["object_id"])
	}
	// 别的任务、不关联的
	other := startRun(t, h, plain, `{"object_id":"obj_t2"}`)["id"].(string)
	free := startRun(t, h, plain, `{}`)
	if _, ok := free["object_id"]; ok {
		t.Fatalf("不关联时不带 object_id：%v", free["object_id"])
	}

	list := func(q url.Values) []string {
		t.Helper()
		code, out := call(t, h, "GET", "/api/sop/runs?"+q.Encode(), "")
		if code != 200 {
			t.Fatalf("列表 %d %s", code, errMsg(out))
		}
		var ids []string
		for _, x := range out["data"].([]any) {
			m := x.(map[string]any)
			ids = append(ids, m["id"].(string))
		}
		if n := int(out["meta"].(map[string]any)["total"].(float64)); n != len(ids) {
			t.Fatalf("total %d 和条数 %d 对不上", n, len(ids))
		}
		return ids
	}
	ids := list(url.Values{"object_id": {"obj_t1"}})
	if len(ids) != 3 || !contains(ids, rid) || !contains(ids, cid) || !contains(ids, got.RunID) {
		t.Fatalf("obj_t1 的执行 = %v", ids)
	}
	if ids := list(url.Values{"object_id": {"obj_t2"}}); len(ids) != 1 || ids[0] != other {
		t.Fatalf("obj_t2 的执行 = %v", ids)
	}
	if ids := list(url.Values{"object_id": {"obj_t1"}, "flow_id": {plain}}); len(ids) != 1 || ids[0] != got.RunID {
		t.Fatalf("和 flow_id 一起筛 = %v", ids)
	}
	if ids := list(url.Values{}); len(ids) != 5 {
		t.Fatalf("不筛应有 5 条：%v", ids)
	}

	// 对象不存在、在回收站里：400，不建执行
	for _, oid := range []string{"obj_none", "obj_gone"} {
		code, out := call(t, h, "POST", "/api/sop/flows/"+plain+"/runs", `{"object_id":"`+oid+`"}`)
		if code != 400 || errMsg(out) != "关联的对象 "+oid+" 不存在" {
			t.Fatalf("%s：%d %s", oid, code, errMsg(out))
		}
	}
	if code, out := call(t, h, "POST", "/api/sop/flows/"+plain+"/runs", `{"object_id":1}`); code != 400 || errMsg(out) != "object_id 必须是字符串" {
		t.Fatalf("类型不对：%d %s", code, errMsg(out))
	}
	if ids := list(url.Values{}); len(ids) != 5 {
		t.Fatalf("失败的发起不该建执行：%v", ids)
	}
	// 钩子发起时对象不在了：照常起，不关联
	got, err = reg.StartSOP(ctx, plugin.SOPStartRequest{FlowID: plain, Source: "agent", ObjectID: "obj_gone"})
	if err != nil {
		t.Fatal(err)
	}
	if r := getRun(t, h, got.RunID); r["object_id"] != nil {
		t.Fatalf("对象不在时不关联：%v", r["object_id"])
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// 发起来源（SOP-06）：界面上发起的一律记 manual（body 里带别的来源不认）；钩子按 Source 记 agent、schedule、plugin，
// 认不得的记空串；子流程记 subflow，source_ref 是父执行、source_name 是父执行标题；列表行同样带。
func TestRunSources(t *testing.T) {
	ctx := context.Background()
	reg, h := setup(t, New())
	newFlow(t, h, `{"name":"子流程","steps":[{"key":"r","name":"子检查","kind":"review"}]}`)
	parent := newFlow(t, h, `{"name":"父流程","fields":[{"key":"title","label":"标题","type":"text"}],"steps":[
		{"key":"sub","name":"跑子流程","kind":"subflow","after":[],"config":{"sop":"子流程"}},
		{"key":"z","name":"收尾","kind":"auto"}]}`)
	plain := newFlow(t, h, `{"name":"检查","steps":[{"key":"r","name":"检查","kind":"review"}]}`)

	manual := startRun(t, h, plain, `{"source":"agent","source_ref":"ag_x","source_name":"冒充"}`)
	if manual["source"] != "manual" || manual["source_ref"] != nil || manual["source_name"] != nil {
		t.Fatalf("界面发起应记 manual、不认 body 里的来源：%v %v %v", manual["source"], manual["source_ref"], manual["source_name"])
	}
	hook := func(q plugin.SOPStartRequest) map[string]any {
		t.Helper()
		q.FlowID = plain
		got, err := reg.StartSOP(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return getRun(t, h, got.RunID)
	}
	for _, c := range []struct {
		q                 plugin.SOPStartRequest
		source, ref, name string
	}{
		{plugin.SOPStartRequest{Source: "agent", SourceID: "ag_1", SourceName: "分诊助手"}, "agent", "ag_1", "分诊助手"},
		{plugin.SOPStartRequest{Source: "schedule", SourceID: "sch_1", SourceName: "周一例会"}, "schedule", "sch_1", "周一例会"},
		{plugin.SOPStartRequest{Source: "plugin", SourceID: "video", SourceName: "video"}, "plugin", "video", "video"},
		{plugin.SOPStartRequest{Source: "manual", SourceID: "x"}, "", "x", ""},
	} {
		r := hook(c.q)
		ref, _ := r["source_ref"].(string)
		name, _ := r["source_name"].(string)
		if r["source"] != c.source || ref != c.ref || name != c.name {
			t.Fatalf("%+v 记成 %v %v %v", c.q, r["source"], r["source_ref"], r["source_name"])
		}
	}

	p := startRun(t, h, parent, `{"input":{"title":"周报"}}`)
	rid := p["id"].(string)
	var cid string
	waitFor(t, "起了子执行", func() bool {
		cid, _ = step(getRun(t, h, rid), "sub")["child_run_id"].(string)
		return cid != ""
	})
	c := getRun(t, h, cid)
	if c["source"] != "subflow" || c["source_ref"] != rid || c["source_name"] != p["title"] {
		t.Fatalf("子流程来源 = %v %v %v（父 %v）", c["source"], c["source_ref"], c["source_name"], p["title"])
	}
	code, out := call(t, h, "GET", "/api/sop/runs?flow_id="+plain, "")
	if code != 200 {
		t.Fatal(code)
	}
	seen := map[any]int{}
	for _, x := range out["data"].([]any) {
		seen[x.(map[string]any)["source"]]++
	}
	if seen["manual"] != 1 || seen["agent"] != 1 || seen["schedule"] != 1 || seen["plugin"] != 1 || seen[""] != 1 {
		t.Fatalf("列表行的来源 = %v", seen)
	}
}
