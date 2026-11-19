// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package im

import (
	"context"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 原平台链接（0.32.0）：拼得出的拼，拼不出的为空，不猜
func TestPermalinkBuilders(t *testing.T) {
	base := "https://acme.slack.com/"
	for _, c := range []struct{ base, ext, parent, want string }{
		{base, "C01:1761700000.000100", "", "https://acme.slack.com/archives/C01/p1761700000000100"},
		{"https://acme.slack.com", "D01:1761700004.000100", "", "https://acme.slack.com/archives/D01/p1761700004000100"},
		// 串里的回复：带 thread_ts、cid，点开定位到串里那条
		{base, "C01:1761700100.000200", "C01:1761700000.000100",
			"https://acme.slack.com/archives/C01/p1761700100000200?thread_ts=1761700000.000100&cid=C01"},
		// 父消息就是自己（父消息本身）不带
		{base, "C01:1761700000.000100", "C01:1761700000.000100", "https://acme.slack.com/archives/C01/p1761700000000100"},
		{"", "C01:1761700000.000100", "", ""},
		{"http://acme.slack.com/", "C01:1761700000.000100", "", ""},
		{base, "C01", "", ""},
		{base, "C01:abc", "", ""},
	} {
		if got := slackPermalink(c.base, c.ext, c.parent); got != c.want {
			t.Errorf("slackPermalink(%q, %q, %q) = %q，应为 %q", c.base, c.ext, c.parent, got, c.want)
		}
	}
	for _, c := range []struct{ ext, want string }{
		{"-1001234567890:42", "https://t.me/c/1234567890/42"},
		{"1755029754:1@9056999909", ""}, // 私聊
		{"-4567:3", ""},                 // 普通群
		{"-100:3", ""},
		{"-100123:x", ""},
	} {
		if got := telegramPermalink(c.ext); got != c.want {
			t.Errorf("telegramPermalink(%q) = %q，应为 %q", c.ext, got, c.want)
		}
	}
	if got := slackWorkspaceURL(" https://acme.slack.com "); got != base {
		t.Errorf("规整工作区地址：%q", got)
	}
}

// Slack 消息带 link、permalink；重启后（内存里没有）从拉取进度里读回工作区地址，不另调接口
func TestSlackMessageLinks(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 5)
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("同步：%d %v", code, out)
	}
	_, got := list(t, e.h, "")
	ch := got["C01:1761700000.000100"]
	if ch == nil || ch["permalink"] != "https://acme.slack.com/archives/C01/p1761700000000100" {
		t.Fatalf("permalink：%v", ch)
	}
	if link, _ := ch["link"].(string); !strings.HasSuffix(link, "/messages?m="+ch["id"].(string)) {
		t.Fatalf("link：%v", ch["link"])
	}
	e.fake.mu.Lock()
	calls := e.fake.calls["auth.test"]
	e.fake.mu.Unlock()
	e.sl.mu.Lock()
	e.sl.urls = map[string]string{}
	e.sl.mu.Unlock()
	_, got = list(t, e.h, "")
	if got["C01:1761700000.000100"]["permalink"] != "https://acme.slack.com/archives/C01/p1761700000000100" {
		t.Fatalf("重启后应从进度读回：%v", got["C01:1761700000.000100"]["permalink"])
	}
	e.fake.mu.Lock()
	after := e.fake.calls["auth.test"]
	e.fake.mu.Unlock()
	if after != calls {
		t.Fatalf("拼链接不该调 auth.test")
	}
}

// SOP task 节点建的任务（source_ref 带 run_id、message_id）：记关联，主来源消息还没转任务时记为转成的任务；
// 历史任务（source_ref 没有 message_id）按 sop.task_created 补；一条任务多条消息、一条消息多条任务；重复投递不多记
func TestSOPTaskLinksMessages(t *testing.T) {
	e := setupActions(t)
	ctx := context.Background()
	a := e.push(t, "fake", `{"external_id":"G1:1","connector_id":"cn_ok","conversation_id":"G1","conversation_kind":"group","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"登录页打不开"}`)
	b := e.push(t, "fake", `{"external_id":"G1:2","connector_id":"cn_ok","conversation_id":"G1","conversation_kind":"group","sender_id":"U04LIN","sender_name":"Lin Yuan","text":"补充截图"}`)
	mk := func(title string, ref map[string]any) *domain.Object {
		t.Helper()
		o, err := e.st.CreateObject(ctx, &domain.Object{TypeID: "task", Title: title, Source: "sop",
			Props: map[string]any{domain.PropSourceRef: ref}}, store.Actor{Name: "sop", Source: "sop"})
		if err != nil {
			t.Fatal(err)
		}
		return o
	}

	// 新建：object.created 按 source_ref 记
	t1 := mk("修登录页", map[string]any{"run_id": "spr_1", "step": "s14", "message_id": a})
	e.deliver(t, "object.created", map[string]any{"id": t1.ID, "type_id": "task"})
	e.deliver(t, EventSOPTaskCreated, map[string]any{"task_id": t1.ID, "run_id": "spr_1", "message_id": a, "message_ids": []string{}})
	code, out := call(t, e.h, "GET", "/api/im/messages?task_id="+t1.ID, "")
	rows, _ := out["data"].([]any)
	if code != 200 || len(rows) != 1 || rows[0].(map[string]any)["id"] != a || rows[0].(map[string]any)["task_id"] != t1.ID ||
		rows[0].(map[string]any)["task_ref"] != t1.Ref {
		t.Fatalf("按任务筛来源消息：%d %v", code, out)
	}
	if m := data(mustGet(t, e, a)); len(m["split_tasks"].([]any)) != 0 {
		t.Fatalf("转成的那条不该再算拆出来的：%v", m["split_tasks"])
	}
	// 已经有转成的任务：转任务回 409（同口径）
	if code, _ := call(t, e.h, "POST", "/api/im/messages/"+a+"/task", ""); code != 409 {
		t.Fatalf("已记为转成的任务，再转应 409：%d", code)
	}

	// 历史任务：source_ref 只有 run_id，靠 SOP 回填的事件补；主消息 b、另一条 a 只记关联（a 已有转成的任务，不改）
	t2 := mk("旧任务", map[string]any{"run_id": "spr_2", "step": "task"})
	e.deliver(t, "object.created", map[string]any{"id": t2.ID, "type_id": "task"})
	ev := map[string]any{"task_id": t2.ID, "run_id": "spr_2", "message_id": b, "message_ids": []string{a, "msg_nope"}, "backfill": true}
	e.deliver(t, EventSOPTaskCreated, ev)
	e.deliver(t, EventSOPTaskCreated, ev)
	_, out = call(t, e.h, "GET", "/api/im/messages?task_id="+t2.ID, "")
	if rows, _ = out["data"].([]any); len(rows) != 2 {
		t.Fatalf("一条任务两条消息：%v", out)
	}
	mb := data(mustGet(t, e, b))
	if mb["task_id"] != t2.ID {
		t.Fatalf("主来源消息记为转成的任务：%v", mb["task_id"])
	}
	ma := data(mustGet(t, e, a))
	if st := ma["split_tasks"].([]any); ma["task_id"] != t1.ID || len(st) != 1 || st[0].(map[string]any)["id"] != t2.ID {
		t.Fatalf("一条消息两条任务：task_id=%v split=%v", ma["task_id"], ma["split_tasks"])
	}
	var n int
	if err := e.st.DB().R.QueryRow(`SELECT count(*) FROM im_message_tasks`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("重复投递不多记：%d %v", n, err)
	}

	// 不存在的任务、空 payload 不报错
	e.deliver(t, EventSOPTaskCreated, map[string]any{"task_id": "obj_nope", "message_id": a})
	e.deliver(t, EventSOPTaskCreated, map[string]any{})
}

func mustGet(t *testing.T, e actEnv, id string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/im/messages/"+id, "")
	if code != 200 {
		t.Fatalf("取消息 %s：%d %v", id, code, out)
	}
	return out
}
