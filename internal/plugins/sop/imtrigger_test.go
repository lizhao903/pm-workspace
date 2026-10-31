package sop

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// IM 触发（SOP-05）：触发方式是 im 的流程来一条新消息自动发起一次，输入是事件里的归类；
// 同一条消息不重复发起；发送时间超过 24 小时的（连接器第一次同步带进来的历史）不发起；
// 必填字段补不齐的跳过；别的触发方式的流程不动。
func TestIMTriggerStartsFlows(t *testing.T) {
	ctx := context.Background()
	reg, h := setup(t, New())
	im := newFlow(t, h, `{"name":"消息分诊","trigger":"im","fields":[{"key":"message_id","label":"消息","type":"text","required":true}],"steps":[
		{"key":"t","name":"拼","kind":"template","after":[],"config":{"template":"{{message_id}}|{{channel}}|{{relevance}}|{{conversation_id}}","output":"text"}},
		{"key":"check","name":"检查","kind":"review"}]}`)
	newFlow(t, h, `{"name":"手动的","trigger":"manual","steps":[{"key":"a","name":"甲","kind":"review","after":[]}]}`)
	newFlow(t, h, `{"name":"要客户","trigger":"im","fields":[{"key":"customer","label":"客户","type":"text","required":true}],
		"steps":[{"key":"a","name":"甲","kind":"review","after":[]}]}`)

	deliver := func(id string, at time.Time) {
		t.Helper()
		payload, _ := json.Marshal(map[string]any{"message_id": id, "channel": "slack", "connector_id": "cn_1",
			"conversation_id": nil, "relevance": "dm", "at": at.UTC().Format("2006-01-02T15:04:05.000Z")})
		subs := reg.Subscribers(imReceivedEvent)
		if len(subs) != 1 {
			t.Fatalf("SOP 插件应订阅 %s，实际 %d 个订阅者", imReceivedEvent, len(subs))
		}
		if err := subs[0].Handle(ctx, plugin.Event{Type: imReceivedEvent, At: time.Now(), Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	runs := func() []any {
		t.Helper()
		code, out := call(t, h, "GET", "/api/sop/runs", "")
		if code != 200 {
			t.Fatalf("列执行：%d %v", code, out)
		}
		return out["data"].([]any)
	}

	deliver("msg_1", time.Now().Add(-time.Minute))
	list := runs()
	if len(list) != 1 || list[0].(map[string]any)["flow_id"] != im {
		t.Fatalf("只该给触发方式是 im、必填补得齐的流程发起一次：%v", list)
	}
	run := waitStatus(t, h, list[0].(map[string]any)["id"].(string), "waiting")
	if got := step(run, "check")["output"].(map[string]any)["text"]; got != "msg_1|slack|dm|" {
		t.Fatalf("输入应带上事件里的归类，没有的为空串：%v", got)
	}

	deliver("msg_1", time.Now())
	if n := len(runs()); n != 1 {
		t.Fatalf("同一条消息不该再发起：%d", n)
	}
	deliver("msg_old", time.Now().Add(-48*time.Hour))
	if n := len(runs()); n != 1 {
		t.Fatalf("24 小时前的消息不该发起：%d", n)
	}
	deliver("msg_2", time.Now())
	if n := len(runs()); n != 2 {
		t.Fatalf("新消息应再发起一次：%d", n)
	}
}
