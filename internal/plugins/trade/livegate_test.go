package trade

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 实盘评审闸门（TRD-08c）。「用户本人」只能在测试里模拟：给请求 ctx 放一个来源 ui、不带会话的操作者，
// 和 api 层 withActor 中间件按 X-Actor-Source 解析出来的一样。

var (
	asUser  = store.Actor{Name: "me", Source: "ui"}
	asAgent = store.Actor{Name: "Claude Code", Source: "agent", Session: "be557ce3"}
	asUISes = store.Actor{Name: "me", Source: "ui", Session: "spoof"}
)

// as 让请求带上这个操作者。
func as(h http.Handler, a store.Actor) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r.WithContext(audit.WithActor(r.Context(), a)))
	})
}

func errOf(out map[string]any) map[string]any {
	e, _ := out["error"].(map[string]any)
	return e
}

func liveRecords(t *testing.T, e liveEnv, action string) int {
	t.Helper()
	var n int
	if err := e.d.R.QueryRow(`SELECT COUNT(*) FROM trade_live_reviews WHERE action = ?`, action).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func checkOf(t *testing.T, v map[string]any, key string) map[string]any {
	t.Helper()
	for _, x := range v["checks"].([]any) {
		if c := x.(map[string]any); c["key"] == key {
			return c
		}
	}
	t.Fatalf("没有评审项 %s：%v", key, v["checks"])
	return nil
}

func TestLiveGate(t *testing.T) {
	e := setupLive(t)
	ctx := context.Background()
	h := e.h
	user, agent := as(h, asUser), as(h, asAgent)

	// 装好只有模拟盘：trade:live 声明了但没授予，升级、安装也不要求确认它
	in, err := e.reg.Get("trade")
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(in.State.Permissions, LivePerm) || e.p.paper.c.Granted(LivePerm) || len(in.NewPermissions()) != 0 {
		t.Fatalf("安装不该授予 trade:live：%v，新增 %v", in.State.Permissions, in.NewPermissions())
	}
	if got := in.SeparateDeclared(); !slices.Equal(got, []string{LivePerm}) {
		t.Fatalf("单独申请的权限 = %v", got)
	}

	v := data(t, h, "GET", "/api/trade/live", "")
	if len(v["checks"].([]any)) != 5 || v["granted"] != false || v["enabled"] != false || v["can_enable"] != false || v["live_orders"] != true ||
		v["plugin_name"] != "交易套件" || v["review"].(map[string]any)["status"] != "pending" || len(v["blockers"].([]any)) != 2 {
		t.Fatalf("初始 = %v", v)
	}
	for _, c := range v["checks"].([]any) {
		if c.(map[string]any)["ok"] != false || len(c.(map[string]any)["evidence"].([]any)) == 0 {
			t.Fatalf("什么都没做时每项都不满足、都带证据链接：%v", c)
		}
	}
	if p := checkOf(t, v, "paper"); !strings.Contains(p["text"].(string), "TRD-05d") {
		t.Fatalf("模拟盘两周记录要说明 TRD-05d 没做：%v", p)
	}

	// 评审没通过：内核单独授予 trade:live 被插件拒绝
	var gd *plugin.GrantDeniedError
	if err := e.reg.Grant(ctx, "trade", LivePerm); !errors.As(err, &gd) || !strings.Contains(gd.Reason, "评审还差 5 项") {
		t.Fatalf("评审没通过就授予：%v", err)
	}

	// 代理、接口、带会话标识的界面请求提交评审：一律 403 not_user，记评审记录和审计
	for _, c := range []struct {
		name string
		h    http.Handler
	}{{"agent", agent}, {"api", h}, {"ui+session", as(h, asUISes)}} {
		code, out := call(t, c.h, "POST", "/api/trade/live/checks/audit/confirm", `{}`)
		if code != 403 || errOf(out)["reason"] != "not_user" || !strings.Contains(errOf(out)["message"].(string), "只能由用户本人在界面上操作") {
			t.Fatalf("%s 确认评审 = %d %v", c.name, code, out)
		}
		code, out = call(t, c.h, "POST", "/api/trade/live/switch", `{"enabled":true}`)
		if code != 403 || errOf(out)["reason"] != "not_user" {
			t.Fatalf("%s 打开开关 = %d %v", c.name, code, out)
		}
	}
	if n := liveRecords(t, e, "denied"); n != 6 {
		t.Fatalf("拒绝要记评审记录：%d", n)
	}
	if acts := e.auditActions(t, "action=live_denied"); len(acts) != 6 {
		t.Fatalf("拒绝要记审计：%v", acts)
	}

	// 用户本人：条件不满足的项 409；开关 403 并写缺什么
	if code, out := call(t, user, "POST", "/api/trade/live/checks/audit/confirm", ``); code != 409 || errOf(out)["reason"] != "check" {
		t.Fatalf("条件不满足确认 = %d %v", code, out)
	}
	code, out := call(t, user, "POST", "/api/trade/live/switch", `{"enabled":true}`)
	if er := errOf(out); code != 403 || er["reason"] != "live_gate" || len(er["missing"].([]any)) != 2 ||
		!strings.Contains(er["message"].(string), "评审还差 5 项没确认") || !strings.Contains(er["message"].(string), "还没授予 trade:live") {
		t.Fatalf("评审没过打开开关 = %d %v", code, out)
	}
	if code, _ := call(t, user, "POST", "/api/trade/live/checks/nope/confirm", `{}`); code != 404 {
		t.Fatalf("不存在的项 = %d", code)
	}

	// 把五项的条件做齐：模拟盘一笔成交（审计）、一笔风控拦截（异常）、一键全停再解除（演练）、实盘账户对账一致、模拟盘两周记录（测试里换掉）
	aid := e.account(t, `{"initial":1000000,"fee_bp":0}`)
	o := e.order(t, `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":1}`)
	e.waitOrder(t, o["id"].(string), "filled")
	data(t, h, "PATCH", "/api/trade/risk", `{"max_order_value":50}`)
	if code, _ := call(t, h, "POST", "/api/trade/orders", `{"account_id":"`+aid+`","symbol":"FAKE:BTCUSDT","side":"buy","type":"market","qty":5,"confirmed":true}`); code != 409 {
		t.Fatalf("超单笔上限应当被拦：%d", code)
	}
	data(t, h, "POST", "/api/trade/risk/kill", `{"reason":"全停演练"}`)
	data(t, h, "POST", "/api/trade/risk/release", `{"reason":"演练完毕"}`)
	e.fake.set(func(f *fakeAcctEx) {
		f.bnPerms = map[string]bool{"enableReading": true, "enableSpotAndMarginTrading": true}
	})
	lid := data(t, h, "POST", "/api/trade/accounts", `{"connector_id":"`+e.addConn(t, BinanceAccountTool, bnSecrets())+`","trade":true}`)["id"].(string)
	e.p.paperRecord = func(context.Context) (bool, string) { return true, "测试：模拟盘连续 14 天" }

	v = data(t, h, "GET", "/api/trade/live", "")
	for _, k := range []string{"audit", "recon", "incident", "drill", "paper"} {
		if c := checkOf(t, v, k); c["ok"] != true {
			t.Fatalf("%s 的条件应当满足了：%v", k, c)
		}
	}
	if ev := checkOf(t, v, "audit")["evidence"].([]any)[0].(map[string]any); !strings.HasPrefix(ev["href"].(string), "/api/trade/audit?order_id=") {
		t.Fatalf("审计的证据要能按委托查：%v", ev)
	}
	// 证据链接能直接查到：一笔委托 place、fill 都在
	href := checkOf(t, v, "audit")["evidence"].([]any)[0].(map[string]any)["href"].(string)
	if acts := e.auditActions(t, strings.TrimPrefix(href, "/api/trade/audit?")); !slices.Contains(acts, "place") || !slices.Contains(acts, "fill") {
		t.Fatalf("证据 %s 查到 %v", href, acts)
	}

	// 用户本人逐项确认；前四项后评审还没通过，插件不同意授予
	for _, k := range []string{"audit", "recon", "incident", "drill"} {
		data(t, user, "POST", "/api/trade/live/checks/"+k+"/confirm", `{"note":"看过证据"}`)
	}
	if code, out := call(t, user, "POST", "/api/trade/live/checks/audit/confirm", `{}`); code != 409 || errOf(out)["reason"] != "state" {
		t.Fatalf("重复确认 = %d %v", code, out)
	}
	if err := e.reg.Grant(ctx, "trade", LivePerm); !errors.As(err, &gd) || !strings.Contains(gd.Reason, "模拟盘两周记录") {
		t.Fatalf("差一项时授予：%v", err)
	}
	v = data(t, user, "POST", "/api/trade/live/checks/paper/confirm", `{}`)
	rv := v["review"].(map[string]any)
	if rv["status"] != "passed" || rv["reviewer"] != "me" || len(rv["missing"].([]any)) != 0 || liveRecords(t, e, "pass") != 1 {
		t.Fatalf("五项都确认后评审通过：%v", rv)
	}
	if c := checkOf(t, v, "audit"); c["reviewer"] != "me" || c["confirmed_at"] == nil || c["note"] != "看过证据" || c["confirmed"].(map[string]any)["ok"] != true {
		t.Fatalf("确认要记评审人、时间、备注和证据快照：%v", c)
	}
	if bl := strs(v["blockers"]); len(bl) != 1 || !strings.Contains(bl[0], "trade:live") || v["can_enable"] != false {
		t.Fatalf("评审过了还差 trade:live：%v", v["blockers"])
	}
	if code, out := call(t, user, "POST", "/api/trade/live/switch", `{"enabled":true}`); code != 403 || errOf(out)["reason"] != "live_gate" {
		t.Fatalf("没授予 trade:live 打开开关 = %d %v", code, out)
	}

	// 评审通过后授予 trade:live（内核的单独申请，接口层要求用户本人和插件名；这里直接调注册表），开关可用
	if err := e.reg.Grant(ctx, "trade", LivePerm); err != nil {
		t.Fatalf("评审通过后授予：%v", err)
	}
	if !e.p.paper.c.Granted(LivePerm) {
		t.Fatal("授予后 Granted 应当为真")
	}
	if code, out := call(t, agent, "POST", "/api/trade/live/switch", `{"enabled":true}`); code != 403 || errOf(out)["reason"] != "not_user" {
		t.Fatalf("代理打开开关 = %d %v", code, out)
	}
	v = data(t, user, "POST", "/api/trade/live/switch", `{"enabled":true}`)
	if v["enabled"] != true || v["can_enable"] != true || v["changed_by"] != "me" || v["live_orders"] != true {
		t.Fatalf("打开开关 = %v", v)
	}

	// 开关开着、trade:live 授予了（TRD-08d）：代理代为下实盘单、部署到实盘账户一律 403 not_user，不出网
	for _, c := range []struct{ path, body string }{
		{"/api/trade/orders", `{"account_id":"` + lid + `","symbol":"BINANCE:BTCUSDT","side":"buy","type":"limit","qty":0.001,"price":1}`},
		{"/api/trade/runs", `{"account_id":"` + lid + `","strategy_id":"x","capital":100}`},
	} {
		code, out := call(t, agent, "POST", c.path, c.body)
		if code != 403 || errOf(out)["reason"] != "not_user" {
			t.Fatalf("代理对实盘账户 %s = %d %v", c.path, code, out)
		}
	}
	e.onlyReadCalls(t)

	// 撤回一项（谁撤都行，只会更保守）：评审回到未通过、trade:live 一并收回、开关关掉
	v = data(t, agent, "POST", "/api/trade/live/checks/drill/revoke", ``)
	if v["review"].(map[string]any)["status"] != "pending" || v["granted"] != false || v["enabled"] != false || e.p.paper.c.Granted(LivePerm) {
		t.Fatalf("撤回后 = review %v granted %v enabled %v", v["review"], v["granted"], v["enabled"])
	}
	if liveRecords(t, e, "reopen") != 1 || liveRecords(t, e, "revoke") != 1 {
		t.Fatal("撤回要记评审记录")
	}
	if in, _ := e.reg.Get("trade"); slices.Contains(in.State.Permissions, LivePerm) {
		t.Fatalf("状态表里 trade:live 要收回：%v", in.State.Permissions)
	}
	// 开关关掉的原因写清楚
	if !strings.Contains(v["off_reason"].(string), "评审还差 1 项") {
		t.Fatalf("自动关掉的原因 = %v", v["off_reason"])
	}
	e.noSecrets(t)
}

// 开关开着时 trade:live 被收回（用户在插件管理里收回）：下次读开关就自动关掉，重新授予也不会自己回来。
func TestLiveSwitchSettlesWhenPermissionRevoked(t *testing.T) {
	e := setupLive(t)
	ctx := context.Background()
	user := as(e.h, asUser)
	// 直接写库做出「五项都确认」的评审记录，只测开关和权限的联动
	for _, k := range liveCheckKeys() {
		if _, err := e.d.W.Exec(`INSERT INTO trade_live_checks (key, confirmed_at, reviewer) VALUES (?, '2026-11-05T00:00:00.000Z', 'me')`, k); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.reg.Grant(ctx, "trade", LivePerm); err != nil {
		t.Fatal(err)
	}
	if v := data(t, user, "POST", "/api/trade/live/switch", `{"enabled":true}`); v["enabled"] != true {
		t.Fatalf("打开 = %v", v)
	}
	if err := e.reg.Revoke(ctx, "trade", LivePerm); err != nil {
		t.Fatal(err)
	}
	v := data(t, e.h, "GET", "/api/trade/live", "")
	if v["enabled"] != false || !strings.Contains(v["off_reason"].(string), "trade:live") {
		t.Fatalf("收回后开关要关掉：%v", v)
	}
	if err := e.reg.Grant(ctx, "trade", LivePerm); err != nil {
		t.Fatal(err)
	}
	if v := data(t, e.h, "GET", "/api/trade/live", ""); v["enabled"] != false || v["can_enable"] != true {
		t.Fatalf("重新授予后开关不能自己回来：%v", v)
	}
	// 关开关谁调都行
	if v := data(t, as(e.h, asAgent), "POST", "/api/trade/live/switch", `{"enabled":false}`); v["enabled"] != false {
		t.Fatalf("关 = %v", v)
	}
	if code, _ := call(t, user, "POST", "/api/trade/live/switch", `{}`); code != 400 {
		t.Fatalf("不给 enabled 应当 400：%d", code)
	}
}
