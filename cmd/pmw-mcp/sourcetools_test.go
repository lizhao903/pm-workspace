// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TSK-0837：后台执行读来源消息走工作台 MCP——消息全文、串的原消息全文、串里的回复（旧→新），不是 IM 转来的说清楚。
func TestSourceMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/objects/obj_t":
			_, _ = w.Write([]byte(`{"data":{"id":"obj_t","ref":"TSK-1","title":"t","props":{"source_ref":{"message_id":"msg_r1","text":"快照"}}}}`))
		case r.URL.Path == "/api/objects/obj_plain":
			_, _ = w.Write([]byte(`{"data":{"id":"obj_plain","ref":"TSK-2","title":"p","props":{}}}`))
		case r.URL.Path == "/api/im/messages/msg_r1":
			_, _ = w.Write([]byte(`{"data":{"id":"msg_r1","channel":"slack","external_id":"C1:2","conversation_id":"cv_1","conversation":"#prd",
				"sender_name":"lin","contact_name":"林原","text":"这个华哥看一下吧","at":"2026-11-19T02:00:00Z",
				"permalink":"https://x.slack.com/archives/C1/p2","thread":{"parent_external_id":"C1:1","parent_text":"摘要"},"replies":[]}}`))
		case r.URL.Path == "/api/im/messages/msg_r1/thread-parent":
			_, _ = w.Write([]byte(`{"data":{"sender":"我","text":"AI 员工要能把文件投递给用户，完整需求如下……","source":"self","partial":false}}`))
		case r.URL.Path == "/api/im/messages":
			if r.URL.Query().Get("conversation_id") != "cv_1" {
				t.Errorf("按会话列消息：%s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"data":[
				{"id":"msg_r2","text":"补充：要支持 zip","at":"2026-11-19T03:00:00Z","sender_name":"wang","thread":{"parent_external_id":"C1:1"}},
				{"id":"msg_x","text":"无关","at":"2026-11-19T01:30:00Z","sender_name":"z","thread":null},
				{"id":"msg_r1","text":"这个华哥看一下吧","at":"2026-11-19T02:00:00Z","contact_name":"林原","thread":{"parent_external_id":"C1:1"}}]}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"no"}}`))
		}
	}))
	defer srv.Close()
	c := newClient(srv.URL)
	ctx := context.Background()

	o, err := c.getObject(ctx, "obj_t")
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.sourceMessage(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"发信人：林原", "这个华哥看一下吧", "原平台链接：https://x.slack.com/archives/C1/p2",
		"串的原消息（我）：", "完整需求如下", "串里收到的回复（2 条"} {
		if !strings.Contains(out, want) {
			t.Errorf("缺 %q：\n%s", want, out)
		}
	}
	if strings.Contains(out, "无关") || strings.Contains(out, "只有摘要") {
		t.Errorf("不属于这个串的消息不列、拿到全文不标摘要：\n%s", out)
	}
	if i, j := strings.Index(out, "林原（就是这条来源消息）"), strings.Index(out, "补充：要支持 zip"); i < 0 || j < 0 || i > j {
		t.Errorf("回复要旧→新：\n%s", out)
	}

	plain, _ := c.getObject(ctx, "obj_plain")
	if out, _ := c.sourceMessage(ctx, plain); !strings.Contains(out, "不是从 IM 消息转来的") {
		t.Errorf("没有来源：%s", out)
	}
}
