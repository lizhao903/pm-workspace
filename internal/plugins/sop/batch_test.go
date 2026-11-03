package sop

import (
	"strings"
	"testing"
)

// 批量发起（IM 页批量分诊）：每个输入一次执行；按 skip_existing_key 跳过已跑过的和同一批里重复的；必填空着的记失败不影响别的；
// 上限 200；按 input_key 查执行、回 input_value。
func TestBatchStartAndInputFilter(t *testing.T) {
	_, h := setup(t, New())
	id := newFlow(t, h, `{"name":"分诊","trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text","required":true}],"steps":[
		{"key":"check","name":"检查","kind":"review","after":[]}]}`)

	code, out := call(t, h, "POST", "/api/sop/flows/"+id+"/runs/batch",
		`{"inputs":[{"message_id":"m1"},{"message_id":"m2"},{"message_id":"m1"},{"message_id":""}],"skip_existing_key":"message_id"}`)
	if code != 200 {
		t.Fatalf("批量发起：%d %v", code, out)
	}
	d := out["data"].(map[string]any)
	started, skipped, failed := d["started"].([]any), d["skipped"].([]any), d["failed"].([]any)
	if len(started) != 2 || len(skipped) != 1 || len(failed) != 1 {
		t.Fatalf("发起 2、同批重复跳过 1、必填空着失败 1：%v", d)
	}
	if s := skipped[0].(map[string]any); s["index"] != float64(2) || s["key"] != "m1" || s["run_id"] != started[0].(map[string]any)["run_id"] {
		t.Fatalf("跳过的指向同批已发起的那次：%v", s)
	}
	if f := failed[0].(map[string]any); !strings.Contains(f["error"].(string), "必填") {
		t.Fatalf("失败原因：%v", f)
	}
	r1 := started[0].(map[string]any)["run_id"].(string)
	run := waitStatus(t, h, r1, "waiting")
	if run["source"] != "manual" || run["source_name"] != "批量发起" {
		t.Fatalf("来源记手动、名字批量发起：%v %v", run["source"], run["source_name"])
	}

	// 再来一次：已跑过的跳过；不给 skip_existing_key 就重跑
	_, out = call(t, h, "POST", "/api/sop/flows/"+id+"/runs/batch", `{"inputs":[{"message_id":"m1"},{"message_id":"m3"}],"skip_existing_key":"message_id"}`)
	if d := out["data"].(map[string]any); len(d["started"].([]any)) != 1 || len(d["skipped"].([]any)) != 1 {
		t.Fatalf("已跑过的跳过：%v", d)
	}
	_, out = call(t, h, "POST", "/api/sop/flows/"+id+"/runs/batch", `{"inputs":[{"message_id":"m1"}]}`)
	if d := out["data"].(map[string]any); len(d["started"].([]any)) != 1 {
		t.Fatalf("重跑：%v", d)
	}

	// 按输入字段查
	code, out = call(t, h, "GET", "/api/sop/runs?input_key=message_id&input_value=m1,m3", "")
	if code != 200 || len(out["data"].([]any)) != 3 {
		t.Fatalf("m1 两次、m3 一次：%d %v", code, out)
	}
	for _, x := range out["data"].([]any) {
		if v := x.(map[string]any)["input_value"]; v != "m1" && v != "m3" {
			t.Fatalf("input_value：%v", v)
		}
	}
	if code, out := call(t, h, "GET", "/api/sop/runs?input_key=message_id&status=waiting,running", ""); code != 200 || len(out["data"].([]any)) != 4 {
		t.Fatalf("进行中的 4 次：%d %v", code, len(out["data"].([]any)))
	}

	// 校验
	for _, c := range []struct{ path, body string }{
		{"/api/sop/flows/" + id + "/runs/batch", `{"inputs":[]}`},
		{"/api/sop/flows/" + id + "/runs/batch", `{"inputs":"x"}`},
		{"/api/sop/flows/" + id + "/runs/batch", `{"inputs":[{}],"skip_existing_key":"a.b"}`},
		{"/api/sop/flows/" + id + "/runs/batch", `{"inputs":[` + strings.Repeat(`{},`, 200) + `{}]}`},
	} {
		if code, out := call(t, h, "POST", c.path, c.body); code != 400 {
			t.Fatalf("%s 要 400：%d %v", c.body[:min(40, len(c.body))], code, out)
		}
	}
	if code, _ := call(t, h, "POST", "/api/sop/flows/sop_none/runs/batch", `{"inputs":[{}]}`); code != 404 {
		t.Fatalf("流程不存在：%d", code)
	}
	for _, q := range []string{"input_key=a.b", "input_value=m1"} {
		if code, _ := call(t, h, "GET", "/api/sop/runs?"+q, ""); code != 400 {
			t.Fatalf("%s 要 400：%d", q, code)
		}
	}
}
