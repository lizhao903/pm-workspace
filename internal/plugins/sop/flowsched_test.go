package sop

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// 定时触发（TSK-0463）：接上真的定时任务表，回注册表、handler 和定时任务的 Store
func setupSched(t *testing.T) (*plugin.Registry, http.Handler, *schedule.Store) {
	t.Helper()
	p := New()
	reg, h, d := setupDB(t, p)
	cores[reg] = p
	ss := schedule.New(d, time.UTC)
	reg.SetSOPRefs(ss.SOPRefs)
	reg.SetSOPSchedules(ss)
	return reg, h, ss
}

const schedSteps = `"steps":[{"key":"a","name":"甲","kind":"auto","after":[]}]`

func flowSched(out map[string]any) map[string]any {
	sc, _ := out["data"].(map[string]any)["schedule"].(map[string]any)
	return sc
}

func ruleOf(sc map[string]any) map[string]any { return sc["rule"].(map[string]any) }

// 选「定时」保存：建一条随流程管理的定时任务，名字跟流程名；改规则、改名改的是同一条；定时任务页改的流程这边看得到
func TestScheduleTriggerSync(t *testing.T) {
	ctx := context.Background()
	_, h, ss := setupSched(t)
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"日报","trigger":"schedule",
		"schedule":{"rule":{"freq":"monthly","time":"08:30","day":15}},`+schedSteps+`}`)
	if code != 201 {
		t.Fatalf("新建 %d %s", code, errMsg(out))
	}
	id := out["data"].(map[string]any)["id"].(string)
	sc := flowSched(out)
	if sc == nil || sc["name"] != "日报" || sc["enabled"] != true || ruleOf(sc)["freq"] != "monthly" || sc["next_run_at"] == nil {
		t.Fatalf("schedule = %v", sc)
	}
	if a := sc["action"].(map[string]any); a["kind"] != "sop" || a["sop_id"] != id || a["managed"] != true {
		t.Fatalf("action = %v", a)
	}
	sid := sc["id"].(string)

	// 改规则、改名：还是这一条
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"name":"日报二","schedule":{"rule":{"freq":"weekly","time":"18:00","weekdays":[5,1]}}}`)
	if code != 200 {
		t.Fatalf("改 %d %s", code, errMsg(out))
	}
	if sc = flowSched(out); sc["id"] != sid || sc["name"] != "日报二" || ruleOf(sc)["time"] != "18:00" {
		t.Fatalf("改后 schedule = %v", sc)
	}
	all, _ := ss.List(ctx)
	if len(all) != 1 {
		t.Fatalf("应当只有一条定时任务，实际 %d", len(all))
	}

	// 定时任务页改规则、停用：流程这边看到的是新的
	r := schedule.Rule{Freq: "daily", Time: "07:00"}
	off := false
	if _, err := ss.Update(ctx, sid, schedule.Patch{Rule: &r, Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	_, out = call(t, h, "GET", "/api/sop/flows/"+id, "")
	if sc = flowSched(out); ruleOf(sc)["freq"] != "daily" || sc["enabled"] != false || sc["next_run_at"] != nil {
		t.Fatalf("定时任务页改后 schedule = %v", sc)
	}
	_, out = call(t, h, "GET", "/api/sop/flows", "")
	if got := out["data"].([]any)[0].(map[string]any)["schedule"].(map[string]any); got["id"] != sid {
		t.Fatalf("列表 schedule = %v", got)
	}
	// 定时任务页不能把它改成指向别的流程或别的动作
	if _, err := ss.Update(ctx, sid, schedule.Patch{Action: &schedule.Action{Kind: "sop", SOPID: "sop_other"}}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("改动作应当拦下：%v", err)
	}
	// 动作原样提交（定时任务页保存时不带 managed）照样是随流程管理的
	if sc, err := ss.Update(ctx, sid, schedule.Patch{Action: &schedule.Action{Kind: "sop", SOPID: id}}); err != nil || !sc.Action.Managed {
		t.Fatalf("原样提交动作：%v %v", sc, err)
	}
	// 新建时带 managed 不认
	if sc, err := ss.Create(ctx, schedule.Input{Name: "手建", Rule: r, Action: schedule.Action{Kind: "sop", SOPID: id, Managed: true}}); err != nil || sc.Action.Managed {
		t.Fatalf("手建：%v %v", sc, err)
	}

	// 规则不对：400，流程不改
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"name":"日报三","schedule":{"rule":{"freq":"weekly","time":"18:00","weekdays":[]}}}`)
	if code != 400 || !strings.HasPrefix(errMsg(out), "定时规则不对：") {
		t.Fatalf("规则不对 %d %s", code, errMsg(out))
	}
	if _, out = call(t, h, "GET", "/api/sop/flows/"+id, ""); out["data"].(map[string]any)["name"] != "日报二" {
		t.Fatalf("规则不对时流程不该改：%v", out["data"].(map[string]any)["name"])
	}
}

// 改回别的触发方式：默认停用，schedule_off=delete 删掉；改回定时重新启用同一条。定时任务页删掉后是「定时，未配置」
func TestScheduleTriggerOff(t *testing.T) {
	ctx := context.Background()
	_, h, ss := setupSched(t)
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"周报","trigger":"schedule","schedule":{"rule":{"freq":"daily","time":"09:00"}},`+schedSteps+`}`)
	if code != 201 {
		t.Fatalf("新建 %d %s", code, errMsg(out))
	}
	id := out["data"].(map[string]any)["id"].(string)
	sid := flowSched(out)["id"]

	_, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"trigger":"manual"}`)
	if sc := flowSched(out); sc == nil || sc["id"] != sid || sc["enabled"] != false {
		t.Fatalf("改手动后应当停用：%v", sc)
	}
	_, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"trigger":"schedule"}`)
	if sc := flowSched(out); sc["id"] != sid || sc["enabled"] != true {
		t.Fatalf("改回定时应当重新启用：%v", sc)
	}
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"trigger":"im","schedule_off":"delete"}`)
	if code != 200 || flowSched(out) != nil {
		t.Fatalf("删掉：%d %v", code, out["data"])
	}
	if all, _ := ss.List(ctx); len(all) != 0 {
		t.Fatalf("定时任务应当删掉了：%d", len(all))
	}
	if code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"schedule_off":"later"}`); code != 400 {
		t.Fatalf("schedule_off 不对：%d %s", code, errMsg(out))
	}

	// 定时任务页删掉：触发方式还是 schedule，schedule 为 null
	_, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"trigger":"schedule","schedule":{"rule":{"freq":"daily","time":"10:00"}}}`)
	sid = flowSched(out)["id"]
	if err := ss.Delete(ctx, sid.(string)); err != nil {
		t.Fatal(err)
	}
	_, out = call(t, h, "GET", "/api/sop/flows/"+id, "")
	if f := out["data"].(map[string]any); f["trigger"] != "schedule" || f["schedule"] != nil {
		t.Fatalf("删掉后：trigger=%v schedule=%v", f["trigger"], f["schedule"])
	}
}

// 删流程：随流程管理的那条跟着删，不拦；用户手建的照旧拦
func TestScheduleTriggerDelete(t *testing.T) {
	ctx := context.Background()
	_, h, ss := setupSched(t)
	_, out := call(t, h, "POST", "/api/sop/flows", `{"name":"巡检","trigger":"schedule","schedule":{"rule":{"freq":"daily","time":"09:00"}},`+schedSteps+`}`)
	id := out["data"].(map[string]any)["id"].(string)
	mine, err := ss.Create(ctx, schedule.Input{Name: "我建的", Rule: schedule.Rule{Freq: "daily", Time: "12:00"}, Action: schedule.Action{Kind: "sop", SOPID: id}})
	if err != nil {
		t.Fatal(err)
	}
	code, out := call(t, h, "DELETE", "/api/sop/flows/"+id, "")
	if code != 409 || errMsg(out) != "定时任务「我建的」会发起它，先改掉或删掉这些定时任务" {
		t.Fatalf("手建的应当拦下：%d %s", code, errMsg(out))
	}
	if sch := out["error"].(map[string]any)["schedules"].([]any); len(sch) != 1 {
		t.Fatalf("schedules = %v", sch)
	}
	if err := ss.Delete(ctx, mine.ID); err != nil {
		t.Fatal(err)
	}
	if code, out = call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 200 {
		t.Fatalf("删 %d %s", code, errMsg(out))
	}
	if all, _ := ss.List(ctx); len(all) != 0 {
		t.Fatalf("随流程管理的应当跟着删：%d", len(all))
	}
}

// 写流程时传旧触发方式：存成 schedule，按等价规则建
func TestLegacyTriggerOnSave(t *testing.T) {
	_, h, _ := setupSched(t)
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"周报","trigger":"weekly",`+schedSteps+`}`)
	if code != 201 {
		t.Fatalf("新建 %d %s", code, errMsg(out))
	}
	f := out["data"].(map[string]any)
	sc := flowSched(out)
	if f["trigger"] != "schedule" || sc == nil || ruleOf(sc)["freq"] != "weekly" || ruleOf(sc)["time"] != "18:00" {
		t.Fatalf("trigger=%v schedule=%v", f["trigger"], sc)
	}
	// 再传一次旧值不改已有规则
	_, out = call(t, h, "PATCH", "/api/sop/flows/"+f["id"].(string), `{"trigger":"daily","schedule":{"rule":{"freq":"daily","time":"06:00"}}}`)
	if sc2 := flowSched(out); sc2["id"] != sc["id"] || ruleOf(sc2)["time"] != "06:00" {
		t.Fatalf("改后 %v", sc2)
	}
	// 没接定时任务时传旧值也能存（只是没有定时任务）
	_, h2 := setup(t, New())
	if code, out := call(t, h2, "POST", "/api/sop/flows", `{"name":"周报","trigger":"daily",`+schedSteps+`}`); code != 201 || out["data"].(map[string]any)["schedule"] != nil {
		t.Fatalf("没接定时任务：%d %v", code, out)
	}
	// 没接定时任务又明确给了规则：400
	if code, out := call(t, h2, "POST", "/api/sop/flows", `{"name":"周报","trigger":"schedule","schedule":{"rule":{"freq":"daily","time":"09:00"}},`+schedSteps+`}`); code != 400 {
		t.Fatalf("没接定时任务给规则：%d %s", code, errMsg(out))
	}
}

// 库里已有的旧触发方式：启用插件时转换。手建了等价定时任务的认领它；必填输入没默认值的建成停用；重复跑不重复建
func TestMigrateLegacyTriggers(t *testing.T) {
	ctx := context.Background()
	reg, h, ss := setupSched(t)
	daily := newFlow(t, h, `{"name":"早报","trigger":"manual",`+schedSteps+`}`)
	weekly := newFlow(t, h, `{"name":"周报","trigger":"manual","fields":[{"key":"week","label":"周次","type":"text","required":true}],`+schedSteps+`}`)
	adopt := newFlow(t, h, `{"name":"认领","trigger":"manual",`+schedSteps+`}`)
	tag := newFlow(t, h, `{"name":"只是标签","trigger":"manual",`+schedSteps+`}`)
	keep := newFlow(t, h, `{"name":"IM","trigger":"im",`+schedSteps+`}`)
	mine, err := ss.Create(ctx, schedule.Input{Name: "我建的周一", Rule: schedule.Rule{Freq: "weekly", Time: "18:00", Weekdays: []int{1}},
		Action: schedule.Action{Kind: "sop", SOPID: adopt}})
	if err != nil {
		t.Fatal(err)
	}
	// 模拟升级前的库：直接改触发方式
	c := sopCore(t, reg)
	for id, trig := range map[string]string{daily: "daily", weekly: "weekly", adopt: "weekly", tag: "cron"} {
		if _, err := c.Store().Exec(ctx, `UPDATE sop_flows SET trigger_desc = ? WHERE id = ?`, trig, id); err != nil {
			t.Fatal(err)
		}
	}
	// 跑两遍：第二遍什么都不做
	for i := range 2 {
		got, err := migrateLegacy(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		if want := []int{4, 0}[i]; len(got) != want {
			t.Fatalf("第 %d 遍转换了 %d 条，应当 %d 条", i+1, len(got), want)
		}
	}
	all, _ := ss.List(ctx)
	if len(all) != 3 {
		t.Fatalf("应当 3 条定时任务（新建 2、认领 1），实际 %d：%v", len(all), all)
	}
	get := func(id string) (map[string]any, map[string]any) {
		_, out := call(t, h, "GET", "/api/sop/flows/"+id, "")
		return out["data"].(map[string]any), flowSched(out)
	}
	f, sc := get(daily)
	if f["trigger"] != "schedule" || sc == nil || ruleOf(sc)["freq"] != "daily" || ruleOf(sc)["time"] != "09:00" || sc["enabled"] != true || f["version"] != float64(1) {
		t.Fatalf("daily：%v %v", f["trigger"], sc)
	}
	if _, sc = get(weekly); ruleOf(sc)["freq"] != "weekly" || ruleOf(sc)["time"] != "18:00" || sc["enabled"] != false {
		t.Fatalf("weekly（必填没默认值）应当建成停用：%v", sc)
	}
	if _, sc = get(adopt); sc["id"] != mine.ID || sc["name"] != "我建的周一" {
		t.Fatalf("应当认领手建的：%v", sc)
	}
	if f, sc = get(tag); f["trigger"] != "schedule" || sc != nil {
		t.Fatalf("cron 标签：%v %v", f["trigger"], sc)
	}
	if f, _ = get(keep); f["trigger"] != "im" {
		t.Fatalf("im 不该动：%v", f["trigger"])
	}
	// 手建的被认领后删流程不再拦
	if code, out := call(t, h, "DELETE", "/api/sop/flows/"+adopt, ""); code != 200 {
		t.Fatalf("删认领的流程 %d %s", code, errMsg(out))
	}
}

// 启用插件时后台任务跑一次转换
func TestLegacyJobOnEnable(t *testing.T) {
	ctx := context.Background()
	reg, h, ss := setupSched(t)
	id := newFlow(t, h, `{"name":"早报","trigger":"manual",`+schedSteps+`}`)
	if _, err := sopCore(t, reg).Store().Exec(ctx, `UPDATE sop_flows SET trigger_desc = 'daily' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if err := reg.Disable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	if err := reg.Enable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "旧触发方式转换", func() bool {
		sc, _ := ss.FlowSchedule(ctx, id)
		return sc != nil
	})
}

// cores 记着每个注册表里的 SOP 插件，sopCore 取它启用时拿到的 Core
var cores = map[*plugin.Registry]*Plugin{}

func sopCore(t *testing.T, reg *plugin.Registry) plugin.Core {
	t.Helper()
	p := cores[reg]
	if p == nil || p.core == nil {
		t.Fatal("没有 SOP 插件的 Core")
	}
	return p.core
}
