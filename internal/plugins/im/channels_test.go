package im

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// listConvs 调列会话接口，回状态码和 data（失败时是 error）。
func listConvs(t *testing.T, e slackEnv, id string) (int, map[string]any) {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/im/connectors/"+id+"/conversations", "")
	if code == 200 {
		d, _ := out["data"].(map[string]any)
		return code, d
	}
	errBody, _ := out["error"].(map[string]any)
	return code, errBody
}

func items(d map[string]any) []map[string]any {
	var out []map[string]any
	raw, _ := d["items"].([]any)
	for _, x := range raw {
		out = append(out, x.(map[string]any))
	}
	return out
}

// 默认假 Slack：#product、#random 两个频道和一个私信；列出来只有两个频道，私信不在里面，完整。
func TestSlackListConversations(t *testing.T) {
	e := setupSlack(t)
	c := e.connect(t, 0)
	code, d := listConvs(t, e, c.ID)
	if code != 200 || d["complete"] != true || d["connector_id"] != c.ID {
		t.Fatalf("列会话：%d %v", code, d)
	}
	got := items(d)
	if len(got) != 2 || got[0]["id"] != "C01" || got[0]["name"] != "product" || got[0]["kind"] != ConvPublic ||
		got[0]["is_member"] != true || got[0]["is_archived"] != false || got[1]["id"] != "C02" {
		t.Fatalf("会话：%v", got)
	}
	if n := e.fake.calls["users.conversations"]; n != 1 {
		t.Fatalf("应只调一次 users.conversations，实际 %d", n)
	}

	// 不在的连接器 404
	if code, _ := listConvs(t, e, "conn_nope"); code != 404 {
		t.Fatalf("不在的连接器应 404，得到 %d", code)
	}
	// Token 失效 502，原因带上 Slack 的说法
	e.fake.setRevoked(true)
	if code, b := listConvs(t, e, c.ID); code != 502 || b["code"] != "list_failed" || !strings.Contains(fmt.Sprint(b["message"]), "Token") {
		t.Fatalf("Token 失效：%d %v", code, b)
	}
	e.fake.setRevoked(false)
	// 暂停的 409（内核取配置时就拒绝），界面退回文本框
	off := false
	if _, err := e.conns.Update(context.Background(), c.ID, connector.Patch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if code, b := listConvs(t, e, c.ID); code != 409 || b["reason"] != "connector_paused" {
		t.Fatalf("暂停的连接器：%d %v", code, b)
	}
	// 断开的 409
	if _, err := e.d.W.Exec(`UPDATE connectors SET status = 'disconnected' WHERE id = ?`, c.ID); err != nil {
		t.Fatal(err)
	}
	if code, b := listConvs(t, e, c.ID); code != 409 || b["reason"] != "connector_disconnected" {
		t.Fatalf("断开的连接器：%d %v", code, b)
	}
}

// pagedSlack 包一层假 Slack：users.conversations 按 types 分页回，第 limitPage 页起回 429；其余转给 fakeSlack。
type pagedSlack struct {
	*fakeSlack
	mu        sync.Mutex
	pages     [][]map[string]any
	limitPage int // 从第几页（从 1 数）开始限流；0 不限流
	types     []string
}

func (p *pagedSlack) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/users.conversations" {
		p.fakeSlack.ServeHTTP(w, r)
		return
	}
	_ = r.ParseForm()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.types = append(p.types, r.Form.Get("types"))
	page := 0
	if c := r.Form.Get("cursor"); c != "" {
		_, _ = fmt.Sscanf(c, "p%d", &page)
	}
	if p.limitPage > 0 && page+1 >= p.limitPage {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	next := ""
	if page+1 < len(p.pages) {
		next = fmt.Sprintf("p%d", page+1)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "channels": p.pages[page], "response_metadata": map[string]any{"next_cursor": next}})
}

// 翻页：私有频道、多人私信、已归档都列出来，频道在前按名字排；第二页限流时回第一页的、标为不完整。
func TestSlackListConversationsPagingAndRateLimit(t *testing.T) {
	fake := newFakeSlack()
	p := &pagedSlack{fakeSlack: fake, pages: [][]map[string]any{
		{
			{"id": "G01", "name": "secret-plan", "is_private": true, "is_member": true},
			{"id": "C05", "name": "Archive-old", "is_archived": true},
			{"id": "G02", "name": "mpdm-lin--zhou--me-1", "is_mpim": true, "is_private": true},
		},
		{{"id": "C06", "name": "design"}},
	}}
	e := setupSlackOn(t, fake, p)
	c := e.connect(t, 0)

	code, d := listConvs(t, e, c.ID)
	if code != 200 || d["complete"] != true {
		t.Fatalf("两页都拿到：%d %v", code, d)
	}
	got := items(d)
	var order, kinds []string
	for _, x := range got {
		order = append(order, x["id"].(string))
		kinds = append(kinds, x["kind"].(string))
	}
	if strings.Join(order, ",") != "C05,C06,G01,G02" || strings.Join(kinds, ",") != "public,public,private,mpim" || got[0]["is_archived"] != true {
		t.Fatalf("排序和种类：%v %v %v", order, kinds, got)
	}
	if p.types[0] != "public_channel,private_channel,mpim" {
		t.Fatalf("types 应只列群组会话，得到 %q", p.types[0])
	}

	// 第二页限流：回第一页的，不完整
	p.mu.Lock()
	p.limitPage = 2
	p.mu.Unlock()
	code, d = listConvs(t, e, c.ID)
	if code != 200 || d["complete"] != false || !strings.Contains(fmt.Sprint(d["note"]), "限流") || len(items(d)) != 3 {
		t.Fatalf("第二页限流：%d %v", code, d)
	}
	// 第一页就限流：什么都没拿到，502
	p.mu.Lock()
	p.limitPage = 1
	p.mu.Unlock()
	if code, b := listConvs(t, e, c.ID); code != 502 || !strings.Contains(fmt.Sprint(b["message"]), "限流") {
		t.Fatalf("第一页限流：%d %v", code, b)
	}
}

// 监听频道里勾了多人私信（列表里能选）不算找不到，连接器不置为异常。
func TestSlackChannelsWithMPIMNotMissing(t *testing.T) {
	fake := newFakeSlack()
	fake.convs = []map[string]any{{"id": "C01", "name": "product"}, {"id": "G02", "name": "mpdm-lin--zhou--me-1", "is_mpim": true}}
	e := setupSlackOn(t, fake, fake)
	ctx := context.Background()
	every := 0
	c, err := e.conns.Create(ctx, connector.Input{Tool: connector.SlackTool, Direction: "both", Interval: &every,
		Config:  map[string]string{"channels": "C01,G02"},
		Secrets: map[string]string{"bot_token": "xoxb-good"}})
	if err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("同步：%d %v", code, out)
	}
	if cn, _ := e.conns.Get(ctx, c.ID); cn.Status == connector.StatusError {
		t.Fatalf("勾了多人私信不该报找不到：%q", cn.Error)
	}
}
