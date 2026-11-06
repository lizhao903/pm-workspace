package im

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// nameFake 包一层假 Slack：users.info 对 broken 里的人回 errors 里的错误码，limited 为真时回 429；记 users.info 调了几次。
type nameFake struct {
	*fakeSlack
	mu      sync.Mutex
	errs    map[string]string
	limited bool
	asked   []string
}

func (f *nameFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.TrimPrefix(r.URL.Path, "/api/") == "users.info" {
		_ = r.ParseForm()
		u := r.Form.Get("user")
		f.mu.Lock()
		f.asked = append(f.asked, u)
		code, limited := f.errs[u], f.limited
		f.mu.Unlock()
		if limited {
			w.Header().Set("Retry-After", "10")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		if code != "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": code})
			return
		}
	}
	f.fakeSlack.ServeHTTP(w, r)
}

func (f *nameFake) set(errs map[string]string, limited bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs, f.limited, f.asked = errs, limited, nil
}

func (f *nameFake) askedN() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.asked)
}

func summaryRow(t *testing.T, e slackEnv, ext string) map[string]any {
	t.Helper()
	code, out := call(t, e.h, "GET", "/api/im/conversations/summary", "")
	if code != 200 {
		t.Fatalf("会话统计：%d %v", code, out)
	}
	for _, x := range out["data"].([]any) {
		if row := x.(map[string]any); row["external_id"] == ext {
			return row
		}
	}
	t.Fatalf("会话统计里没有 %s：%v", ext, out)
	return nil
}

func strs(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// TSK-0494：收消息时渠道没给名字的人在群组管理里只显示编号，「查询回填」回渠道查了补上；
// 查不到的记原因、批量时不重查；只补空的，不新增消息、不改状态；之后收到同一个人的消息带上已知的名字。
func TestRefillNames(t *testing.T) {
	fake := &nameFake{fakeSlack: newFakeSlack()}
	fake.convs = []map[string]any{{"id": "C01", "name": "product"}, {"id": "D01", "is_im": true, "user": "U09ZHOU"},
		{"id": "D02", "is_im": true, "user": "U00GONE"}}
	fake.history["D02"] = []map[string]any{{"type": "message", "user": "U00GONE", "text": "外部的人", "ts": "1761700005.000100"}}
	// 第一次同步时查不到 Lin、Zhou、外部的人（模拟一轮查人名撞了上限或限流）
	fake.set(map[string]string{"U04LIN": "ratelimited_soft", "U09ZHOU": "ratelimited_soft", "U00GONE": "user_not_found"}, false)
	e := setupSlackOn(t, fake.fakeSlack, fake)
	c := e.connect(t, 0)
	ctx := context.Background()
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("同步：%d %v", code, out)
	}
	row := summaryRow(t, e, "C01")
	if u := strs(row["unresolved_users"]); len(u) != 1 || u[0] != "U04LIN" || row["can_refill"] != true || row["name_unresolved"] != false || row["refill_error"] != "" {
		t.Fatalf("没名字的人应列进 unresolved_users：%v", row)
	}
	// 一条标成已处理：回填不能动状态
	if _, err := e.d.W.ExecContext(ctx, `UPDATE im_messages SET status = 'done' WHERE external_id = 'C01:1761700000.000100'`); err != nil {
		t.Fatal(err)
	}
	var before int
	_ = e.d.W.QueryRowContext(ctx, `SELECT count(*) FROM im_messages`).Scan(&before)

	// 单个会话：回渠道查到了，界面上换成名字
	fake.set(nil, false)
	cid := row["conversation_id"].(string)
	code, out := call(t, e.h, "POST", "/api/im/conversations/"+cid+"/refill-names", "")
	res, _ := out["data"].(map[string]any)
	if code != 200 || len(res["filled"].([]any)) != 1 || len(res["failed"].([]any)) != 0 {
		t.Fatalf("单个回填：%d %v", code, out)
	}
	if f := res["filled"].([]any)[0].(map[string]any); f["external_id"] != "U04LIN" || f["name"] != "Lin Yuan" || f["source"] != "channel" || f["kind"] != "user" {
		t.Fatalf("补上的：%v", f)
	}
	row = summaryRow(t, e, "C01")
	if p := strs(row["participants"]); len(p) != 1 || p[0] != "Lin Yuan" || len(row["unresolved_users"].([]any)) != 0 {
		t.Fatalf("回填后：%v", row)
	}
	var after int
	var status string
	_ = e.d.W.QueryRowContext(ctx, `SELECT count(*) FROM im_messages`).Scan(&after)
	_ = e.d.W.QueryRowContext(ctx, `SELECT status FROM im_messages WHERE external_id = 'C01:1761700000.000100'`).Scan(&status)
	if after != before || status != "done" {
		t.Fatalf("回填不该新增消息、改状态：%d -> %d，%s", before, after, status)
	}

	// 查不到的：记原因，列表上带着；批量时跳过不重查，retry_failed 才重查
	fake.set(map[string]string{"U00GONE": "user_not_found"}, false)
	row = summaryRow(t, e, "D02")
	code, out = call(t, e.h, "POST", "/api/im/conversations/"+row["conversation_id"].(string)+"/refill-names", "")
	res, _ = out["data"].(map[string]any)
	if code != 200 || len(res["failed"].([]any)) != 1 || res["failed"].([]any)[0].(map[string]any)["code"] != "user_not_found" {
		t.Fatalf("查不到：%d %v", code, out)
	}
	if row = summaryRow(t, e, "D02"); !strings.Contains(row["refill_error"].(string), "查不到这个人") {
		t.Fatalf("列表上应写原因：%v", row)
	}
	fake.set(map[string]string{"U00GONE": "user_not_found"}, false)
	code, out = call(t, e.h, "POST", "/api/im/conversations/refill-names", "")
	res, _ = out["data"].(map[string]any)
	// D01 的 Zhou 查到了，外部的人跳过
	if code != 200 || res["skipped"] != float64(1) || len(res["filled"].([]any)) != 1 || fake.askedN() != 1 {
		t.Fatalf("批量（不重查失败的）：%d %v，users.info %d 次", code, out, fake.askedN())
	}
	code, out = call(t, e.h, "POST", "/api/im/conversations/refill-names", `{"retry_failed":true}`)
	res, _ = out["data"].(map[string]any)
	if code != 200 || res["skipped"] != float64(0) || len(res["failed"].([]any)) != 1 || fake.askedN() != 2 {
		t.Fatalf("批量（重查失败的）：%d %v，users.info %d 次", code, out, fake.askedN())
	}

	// 限流：停下，没查的算 remaining、不记成查不到
	fake.set(nil, true)
	code, out = call(t, e.h, "POST", "/api/im/conversations/refill-names", `{"retry_failed":true}`)
	res, _ = out["data"].(map[string]any)
	if code != 200 || res["remaining"] != float64(1) || len(res["failed"].([]any)) != 0 {
		t.Fatalf("限流：%d %v", code, out)
	}

	// 连接器暂停：单个 409，批量记进 failed
	if _, err := e.d.W.ExecContext(ctx, `UPDATE connectors SET status = 'paused' WHERE id = ?`, c.ID); err != nil {
		t.Fatal(err)
	}
	if code, out = call(t, e.h, "POST", "/api/im/conversations/"+row["conversation_id"].(string)+"/refill-names", ""); code != 409 {
		t.Fatalf("暂停时单个应 409：%d %v", code, out)
	}
	code, out = call(t, e.h, "POST", "/api/im/conversations/refill-names", `{"retry_failed":true}`)
	if res, _ = out["data"].(map[string]any); code != 200 || res["failed"].([]any)[0].(map[string]any)["code"] != "connector_paused" {
		t.Fatalf("暂停时批量：%d %v", code, out)
	}
	if _, err := e.d.W.ExecContext(ctx, `UPDATE connectors SET status = 'connected' WHERE id = ?`, c.ID); err != nil {
		t.Fatal(err)
	}

	// 群名就是编号（登记会话时没有名字）：conversations.info 查回来，列表上显示；内核会话表不动
	if _, err := e.d.W.ExecContext(ctx, `UPDATE conversations SET name = external_id WHERE external_id = 'C01'`); err != nil {
		t.Fatal(err)
	}
	row = summaryRow(t, e, "C01")
	if row["name_unresolved"] != true {
		t.Fatalf("群名是编号应算缺：%v", row)
	}
	fake.set(nil, false)
	code, out = call(t, e.h, "POST", "/api/im/conversations/"+row["conversation_id"].(string)+"/refill-names", "")
	res, _ = out["data"].(map[string]any)
	if code != 200 || len(res["filled"].([]any)) != 1 || res["filled"].([]any)[0].(map[string]any)["name"] != "#product" {
		t.Fatalf("群名回填：%d %v", code, out)
	}
	if row = summaryRow(t, e, "C01"); row["name"] != "#product" || row["name_unresolved"] != false {
		t.Fatalf("群名回填后：%v", row)
	}

	// 收消息：渠道这次没给名字，用已知的；给了名字，把同一个人以前没名字的补上
	fake.set(map[string]string{"U04LIN": "ratelimited_soft"}, false)
	e.sl.mu.Lock()
	e.sl.users = map[string]string{}
	e.sl.mu.Unlock()
	fake.add("C01", map[string]any{"type": "message", "user": "U04LIN", "text": "又一条", "ts": "1761700300.000100"})
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("再同步：%d %v", code, out)
	}
	var name string
	_ = e.d.W.QueryRowContext(ctx, `SELECT sender_name FROM im_messages WHERE external_id = 'C01:1761700300.000100'`).Scan(&name)
	if name != "Lin Yuan" {
		t.Fatalf("渠道没给名字时应用已知的：%q", name)
	}
	if _, err := e.d.W.ExecContext(ctx, `UPDATE im_messages SET sender_name = '' WHERE sender_external_id = 'U04LIN'`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.W.ExecContext(ctx, `DELETE FROM im_name_lookups`); err != nil {
		t.Fatal(err)
	}
	fake.set(nil, false)
	fake.add("C01", map[string]any{"type": "message", "user": "U04LIN", "text": "再一条", "ts": "1761700400.000100"})
	if code, out := call(t, e.h, "POST", "/api/im/connectors/"+c.ID+"/sync", ""); code != 200 {
		t.Fatalf("第三次同步：%d %v", code, out)
	}
	var empty int
	_ = e.d.W.QueryRowContext(ctx, `SELECT count(*) FROM im_messages WHERE sender_external_id = 'U04LIN' AND sender_name = ''`).Scan(&empty)
	if empty != 0 {
		t.Fatalf("收到带名字的消息后，同一个人以前没名字的应补上：还有 %d 条", empty)
	}
}

// 不支持按编号查名字的渠道（没实现 NameResolver 的适配器）：列表上 can_refill 为假，单个回填 409 unsupported。
func TestRefillNamesUnsupported(t *testing.T) {
	h := setup(t).h
	code, out := call(t, h, "POST", "/api/im/callbacks/fake", `{"messages":[{"external_id":"m1","sender_id":"u9","conversation_id":"g1","conversation_name":"测试群","text":"hi"}]}`)
	if code != 200 {
		t.Fatalf("收消息：%d %v", code, out)
	}
	_, out = call(t, h, "GET", "/api/im/conversations/summary", "")
	row := out["data"].([]any)[0].(map[string]any)
	if row["can_refill"] != false || strs(row["unresolved_users"])[0] != "u9" {
		t.Fatalf("不支持的渠道：%v", row)
	}
	code, out = call(t, h, "POST", "/api/im/conversations/"+row["conversation_id"].(string)+"/refill-names", "")
	if code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "不支持") {
		t.Fatalf("应 409 unsupported：%d %v", code, out)
	}
	if code, _ = call(t, h, "POST", "/api/im/conversations/nope/refill-names", ""); code != 404 {
		t.Fatalf("会话不存在应 404：%d", code)
	}
}
