// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// newBrokerProcess 造一个带私有库的 pluginProcess，用于直接测 broker 分发。
func newBrokerProcess(t *testing.T, granted []string, notifier Notifier) *pluginProcess {
	t.Helper()
	d := newTestDB(t, true)
	h := newTestHost(t, Options{DB: d, Notifier: notifier})
	data, err := json.Marshal(testManifestObj(platformKey(), "bin/hello_world"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := Parse(data)
	if err != nil {
		t.Fatalf("测试清单不合法：%v", err)
	}
	pdb, err := h.openPluginDB("hello_world")
	if err != nil {
		t.Fatalf("打开插件私有库失败：%v", err)
	}
	t.Cleanup(func() { _ = pdb.Close() })
	return &pluginProcess{
		host:     h,
		manifest: m,
		row:      &stateRow{ID: "hello_world", Granted: granted},
		id:       "hello_world",
		db:       pdb,
	}
}

func callBroker(t *testing.T, p *pluginProcess, method, params string) (any, error) {
	t.Helper()
	return p.handleHostCall(context.Background(), method, json.RawMessage(params))
}

func assertRPCError(t *testing.T, err error, name string) *rpcError {
	t.Helper()
	if err == nil {
		t.Fatalf("期望 %s 错误，得到 nil", name)
	}
	var re *rpcError
	if !errors.As(err, &re) {
		t.Fatalf("期望 *rpcError，得到 %T：%v", err, err)
	}
	if re.Code != rpcErrorCodes[name] {
		t.Fatalf("错误码不对：期望 %d(%s)，得到 %d(%s)", rpcErrorCodes[name], name, re.Code, re.Message)
	}
	return re
}

func TestBrokerObjectsListPermissionDenied(t *testing.T) {
	p := newBrokerProcess(t, nil, nil)
	_, err := callBroker(t, p, "host.objects.list", `{"limit":5}`)
	re := assertRPCError(t, err, "permission_denied")
	data, ok := re.Data.(map[string]any)
	if !ok || data["permission"] != "objects:read" || data["declared"] != true || data["granted"] != false {
		t.Fatalf("permission_denied 的 data 不对：%+v", re.Data)
	}

	// 未声明的权限 declared=false。
	p2 := newBrokerProcess(t, nil, nil)
	_, err = callBroker(t, p2, "host.notify", `{"title":"x"}`)
	re = assertRPCError(t, err, "permission_denied")
	if data, _ := re.Data.(map[string]any); data["declared"] != true {
		// notify 在测试清单里是声明过的，这里应 granted=false。
		if data["granted"] != false {
			t.Fatalf("data 不对：%+v", data)
		}
	}
}

func TestBrokerObjectsListAndGet(t *testing.T) {
	p := newBrokerProcess(t, []string{"objects:read"}, nil)
	d := p.host.opts.DB
	seedObject(t, d, "obj_1", "task", "第一个任务")
	seedObject(t, d, "obj_2", "project", "第二个项目")

	out, err := callBroker(t, p, "host.objects.list", `{"limit":1}`)
	if err != nil {
		t.Fatalf("objects.list 失败：%v", err)
	}
	list := out.(map[string]any)["items"].([]map[string]any)
	if len(list) != 1 {
		t.Fatalf("limit 没生效：%+v", list)
	}

	out, err = callBroker(t, p, "host.objects.list", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	list = out.(map[string]any)["items"].([]map[string]any)
	if len(list) != 2 {
		t.Fatalf("默认 limit 应返回全部 2 条：%+v", list)
	}
	for _, item := range list {
		if item["id"] == "" || item["title"] == "" || item["type"] == "" {
			t.Fatalf("item 字段不全：%+v", item)
		}
	}

	obj, err := callBroker(t, p, "host.objects.get", `{"id":"obj_1"}`)
	if err != nil {
		t.Fatalf("objects.get 失败：%v", err)
	}
	m := obj.(map[string]any)
	if m["title"] != "第一个任务" || m["type"] != "task" {
		t.Fatalf("objects.get 结果不对：%+v", m)
	}

	_, err = callBroker(t, p, "host.objects.get", `{"id":"nope"}`)
	assertRPCError(t, err, "not_found")
}

func TestBrokerStoreQueryExec(t *testing.T) {
	p := newBrokerProcess(t, nil, nil)

	out, err := callBroker(t, p, "host.store.query", `{"sql":"SELECT 1 AS ok"}`)
	if err != nil {
		t.Fatalf("store.query 失败：%v", err)
	}
	res := out.(map[string]any)
	if cols := res["columns"].([]string); len(cols) != 1 || cols[0] != "ok" {
		t.Fatalf("columns 不对：%+v", cols)
	}
	rows := res["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["ok"] != int64(1) {
		t.Fatalf("rows 不对：%+v", rows)
	}

	// exec 允许写插件自己的表。
	out, err = callBroker(t, p, "host.store.exec",
		`{"sql":"INSERT INTO _pmw_settings (key, value) VALUES (?, ?)","args":["k1","v1"]}`)
	if err != nil {
		t.Fatalf("store.exec 失败：%v", err)
	}
	if affected := out.(map[string]any)["rows_affected"]; affected != int64(1) {
		t.Fatalf("rows_affected 不对：%+v", affected)
	}
	out, err = callBroker(t, p, "host.store.query",
		`{"sql":"SELECT key, value FROM _pmw_settings WHERE key = ?","args":["k1"]}`)
	if err != nil {
		t.Fatal(err)
	}
	rows = out.(map[string]any)["rows"].([]map[string]any)
	if len(rows) != 1 || rows[0]["value"] != "v1" {
		t.Fatalf("插入后查询不对：%+v", rows)
	}

	// DDL / ATTACH / 事务控制 / 多语句 / 非只读查询都要拒绝。
	for _, tc := range []struct{ sql, want string }{
		{"CREATE TABLE x (id TEXT)", "CREATE"},
		{"DROP TABLE _pmw_settings", "DROP"},
		{"ATTACH DATABASE '/tmp/x.db' AS x", "ATTACH"},
		{"PRAGMA journal_mode=DELETE", "PRAGMA"},
		{"BEGIN", "BEGIN"},
		{"SELECT 1; DROP TABLE _pmw_settings", "一条"},
	} {
		_, err := callBroker(t, p, "host.store.exec", `{"sql":`+strconvQuote(tc.sql)+`}`)
		if err == nil {
			t.Fatalf("exec 应拒绝 %q", tc.sql)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("exec 拒绝 %q 的错误信息缺少 %q：%v", tc.sql, tc.want, err)
		}
	}
	for _, sql := range []string{"CREATE TABLE x (id TEXT)", "DELETE FROM _pmw_settings"} {
		_, err := callBroker(t, p, "host.store.query", `{"sql":`+strconvQuote(sql)+`}`)
		if err == nil {
			t.Fatalf("query 应拒绝非只读语句 %q", sql)
		}
	}
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestBrokerSettings(t *testing.T) {
	p := newBrokerProcess(t, nil, nil)
	out, err := callBroker(t, p, "host.settings.get", `{"key":"theme"}`)
	if err != nil {
		t.Fatalf("settings.get 失败：%v", err)
	}
	if out.(map[string]any)["value"] != nil {
		t.Fatalf("不存在的设置应为 null：%+v", out)
	}
	if _, err := callBroker(t, p, "host.settings.set", `{"key":"theme","value":"dark"}`); err != nil {
		t.Fatalf("settings.set 失败：%v", err)
	}
	out, err = callBroker(t, p, "host.settings.get", `{"key":"theme"}`)
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["value"] != "dark" {
		t.Fatalf("设置值不对：%+v", out)
	}
	if _, err := callBroker(t, p, "host.settings.set", `{"value":"x"}`); err == nil {
		t.Fatal("缺少 key 应报错")
	}
}

type fakeNotifier struct {
	pluginID string
	title    string
	body     string
	calls    int
}

func (f *fakeNotifier) Notify(_ context.Context, pluginID, title, body string) error {
	f.calls++
	f.pluginID, f.title, f.body = pluginID, title, body
	return nil
}

func TestBrokerNotify(t *testing.T) {
	// 已声明且授予 + 有 Notifier。
	n := &fakeNotifier{}
	p := newBrokerProcess(t, []string{"notify"}, n)
	if _, err := callBroker(t, p, "host.notify", `{"level":"info","title":"你好","body":"正文"}`); err != nil {
		t.Fatalf("host.notify 失败：%v", err)
	}
	if n.calls != 1 || n.pluginID != "hello_world" || n.title != "你好" || n.body != "正文" {
		t.Fatalf("Notifier 调用不对：%+v", n)
	}

	// 已声明但未授予。
	p2 := newBrokerProcess(t, nil, n)
	_, err := callBroker(t, p2, "host.notify", `{"title":"x"}`)
	assertRPCError(t, err, "permission_denied")

	// 授予了但宿主没有 Notifier。
	p3 := newBrokerProcess(t, []string{"notify"}, nil)
	_, err = callBroker(t, p3, "host.notify", `{"title":"x"}`)
	assertRPCError(t, err, "unavailable")
}

func TestBrokerUnknownMethod(t *testing.T) {
	p := newBrokerProcess(t, nil, nil)
	// host.agent.run 已实现（2026-11-23），换一个确实没有的方法
	_, err := callBroker(t, p, "host.nope.call", `{}`)
	assertRPCError(t, err, "method_not_found")
}
