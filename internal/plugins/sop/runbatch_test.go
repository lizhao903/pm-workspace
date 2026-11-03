package sop

import (
	"strings"
	"testing"
)

// 失败执行批量重跑：retry 在原执行里重试失败的步骤；relaunch 按流程当前定义新发起、原执行保留、来源能追到原执行；
// 不是失败的、不存在的、重复的跳过；子执行换成顶层执行并去重；上限 200、动作不认 400。
func TestRunBatchActions(t *testing.T) {
	_, h := setup(t, New())
	// 没接模型时 AI 节点失败
	id := newFlow(t, h, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	f1 := startRun(t, h, id, `{"input":{"topic":"周会"}}`)["id"].(string)
	f2 := startRun(t, h, id, `{"input":{"topic":"复盘"}}`)["id"].(string)
	waitStatus(t, h, f1, "failed")
	waitStatus(t, h, f2, "failed")
	rv := newFlow(t, h, `{"name":"检查","steps":[{"key":"r","name":"检查","kind":"review","after":[]}]}`)
	w1 := startRun(t, h, rv, `{}`)["id"].(string)
	waitStatus(t, h, w1, "waiting")

	// retry：原执行里重试，attempts 加 1；等待中的、不存在的、重复的跳过
	code, out := call(t, h, "POST", "/api/sop/runs/batch-actions",
		`{"action":"retry","run_ids":["`+f1+`","`+w1+`","spr_none","`+f1+`"]}`)
	if code != 200 {
		t.Fatalf("批量重试：%d %v", code, out)
	}
	d := out["data"].(map[string]any)
	done, skipped, failed := d["done"].([]any), d["skipped"].([]any), d["failed"].([]any)
	if len(done) != 1 || len(skipped) != 3 || len(failed) != 0 {
		t.Fatalf("重试 1、跳过 3：%v", d)
	}
	if x := done[0].(map[string]any); x["run_id"] != f1 || x["new_run_id"] != nil || x["steps"].([]any)[0] != "ai" {
		t.Fatalf("重试的那条：%v", x)
	}
	reasons := ""
	for _, s := range skipped {
		reasons += s.(map[string]any)["reason"].(string) + "；"
	}
	for _, want := range []string{"不是失败状态（待我处理）", "执行不存在", "重复"} {
		if !strings.Contains(reasons, want) {
			t.Fatalf("跳过原因缺「%s」：%s", want, reasons)
		}
	}
	run := waitStatus(t, h, f1, "failed")
	if s := step(run, "ai"); s["attempts"] != float64(2) || !hasLog(s, "第 2 次尝试") {
		t.Fatalf("重试后 attempts=%v", s["attempts"])
	}
	if run["flow_version"] != float64(1) {
		t.Fatalf("重试沿用快照：%v", run["flow_version"])
	}

	// 改流程（AI 节点换成模板），relaunch 按新定义发起，原执行保留
	if code, out := call(t, h, "PATCH", "/api/sop/flows/"+id, `{"name":"写纪要","fields":[{"key":"topic","label":"主题","type":"text","required":true}],"steps":[
		{"key":"tpl","name":"拼标题","kind":"template","after":[],"config":{"template":"纪要：{{topic}}","output":"text"}}]}`); code != 200 {
		t.Fatalf("改流程：%d %v", code, out)
	}
	code, out = call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"relaunch","run_ids":["`+f1+`","`+f2+`","`+w1+`"]}`)
	if code != 200 {
		t.Fatalf("批量重新发起：%d %v", code, out)
	}
	d = out["data"].(map[string]any)
	if len(d["done"].([]any)) != 2 || len(d["skipped"].([]any)) != 1 {
		t.Fatalf("新发起 2、跳过 1：%v", d)
	}
	x := d["done"].([]any)[1].(map[string]any)
	nr := waitStatus(t, h, x["new_run_id"].(string), "done")
	if x["run_id"] != f2 || nr["flow_version"] != float64(2) || nr["input"].(map[string]any)["topic"] != "复盘" {
		t.Fatalf("按新定义、原输入：%v %v", nr["flow_version"], nr["input"])
	}
	if nr["source"] != "manual" || nr["source_ref"] != f2 || nr["source_name"] != "批量重跑" {
		t.Fatalf("来源：%v %v %v", nr["source"], nr["source_ref"], nr["source_name"])
	}
	if getRun(t, h, f2)["status"] != "failed" {
		t.Fatal("原失败执行保留")
	}

	// 子执行：同一顶层执行下两条失败的子执行只重新发起一次顶层
	newFlow(t, h, `{"name":"子流程","steps":[{"key":"ai","name":"AI","kind":"ai","after":[]}]}`)
	parent := newFlow(t, h, `{"name":"父流程","steps":[
		{"key":"a","name":"子 A","kind":"subflow","after":[],"config":{"sop":"子流程"}},
		{"key":"b","name":"子 B","kind":"subflow","after":[],"config":{"sop":"子流程"}}]}`)
	pid := startRun(t, h, parent, `{}`)["id"].(string)
	var ca, cb string
	waitFor(t, "起了两条子执行", func() bool {
		p := getRun(t, h, pid)
		ca, _ = step(p, "a")["child_run_id"].(string)
		cb, _ = step(p, "b")["child_run_id"].(string)
		return ca != "" && cb != ""
	})
	waitStatus(t, h, ca, "failed")
	waitStatus(t, h, cb, "failed")
	code, out = call(t, h, "POST", "/api/sop/runs/batch-actions", `{"action":"relaunch","run_ids":["`+ca+`","`+cb+`"]}`)
	if code != 200 {
		t.Fatalf("子执行重新发起：%d %v", code, out)
	}
	d = out["data"].(map[string]any)
	if len(d["done"].([]any)) != 1 || len(d["skipped"].([]any)) != 1 {
		t.Fatalf("顶层去重：%v", d)
	}
	nid := d["done"].([]any)[0].(map[string]any)["new_run_id"].(string)
	sk := d["skipped"].([]any)[0].(map[string]any)
	if sk["run_id"] != cb || sk["new_run_id"] != nid || !strings.Contains(sk["reason"].(string), pid) {
		t.Fatalf("去重跳过的那条：%v", sk)
	}
	nr = getRun(t, h, nid)
	if nr["flow_id"] != parent || nr["parent_run_id"] != nil || nr["source_ref"] != pid {
		t.Fatalf("新发起的是顶层：%v %v %v", nr["flow_id"], nr["parent_run_id"], nr["source_ref"])
	}

	// 校验
	ids := strings.Repeat(`"x",`, 200) + `"x"`
	for _, body := range []string{
		`{"action":"retry","run_ids":[]}`,
		`{"action":"retry","run_ids":"x"}`,
		`{"action":"redo","run_ids":["x"]}`,
		`{"run_ids":["x"]}`,
		`{"action":"retry","run_ids":[` + ids + `]}`,
	} {
		if code, out := call(t, h, "POST", "/api/sop/runs/batch-actions", body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", body[:min(40, len(body))], code, out)
		}
	}
}
