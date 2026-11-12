// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"testing"
	"time"
	_ "time/tzdata"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

// newScheduleServer 用真库、上海时区、固定在 2026-10-29 10:00（周四）的时钟。
func newScheduleServer(t *testing.T) (*Server, *schedule.Store) {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	sh, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	ss := schedule.New(st.DB(), sh)
	now := time.Date(2026, 10, 29, 10, 0, 0, 0, sh)
	ss.SetClock(func() time.Time { return now })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	ws := audit.WrapStore(st, al)
	runner := schedule.NewRunner(ss, ws, log)
	return New(ws, Options{Version: "test", Logger: log, Audit: al, Schedules: ss, ScheduleRunner: runner}), ss
}

type scheduleResp struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Enabled   bool           `json:"enabled"`
	Rule      schedule.Rule  `json:"rule"`
	Action    map[string]any `json:"action"`
	NextRunAt *time.Time     `json:"next_run_at"`
}

func decodeSchedule(t *testing.T, body []byte) scheduleResp {
	t.Helper()
	var env struct {
		Data scheduleResp `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func TestSchedulesCRUD(t *testing.T) {
	s, _ := newScheduleServer(t)

	// 新建：每周一 09:00 建任务
	w := do(s, "POST", "/api/schedules", `{"name":" 周会前整理议程 ","rule":{"freq":"weekly","time":"09:00","weekdays":[1,1]},
		"action":{"kind":"task","title":"整理本周议程","priority":"P2","assignee":"我","due_days":0,"sop_id":"多余字段"}}`)
	mustCode(t, w, http.StatusCreated, "create")
	sc := decodeSchedule(t, w.Body.Bytes())
	if sc.ID == "" || sc.Name != "周会前整理议程" || !sc.Enabled {
		t.Fatalf("create = %+v", sc)
	}
	if got := sc.NextRunAt.Format("2006-01-02 15:04 -07:00"); got != "2026-11-02 09:00 +08:00" {
		t.Errorf("next_run_at = %s", got)
	}
	if len(sc.Rule.Weekdays) != 1 {
		t.Errorf("weekdays 没去重：%v", sc.Rule.Weekdays)
	}
	if _, ok := sc.Action["sop_id"]; ok {
		t.Errorf("task 动作不该带 sop_id：%v", sc.Action)
	}
	if v, ok := sc.Action["due_days"]; !ok || v.(float64) != 0 {
		t.Errorf("due_days 为 0 也要输出：%v", sc.Action)
	}

	// 第二个：每月 31 号，排在第一个前面（10-31 早于 11-02）
	w = do(s, "POST", "/api/schedules", `{"name":"月底对账","rule":{"freq":"monthly","time":"10:00","day":31},"action":{"kind":"sop","sop_id":"sop_x"}}`)
	mustCode(t, w, http.StatusCreated, "create monthly")
	monthly := decodeSchedule(t, w.Body.Bytes())
	// 第三个：停用的，排最后
	w = do(s, "POST", "/api/schedules", `{"name":"停用的","enabled":false,"rule":{"freq":"daily","time":"08:00"},"action":{"kind":"agent","agent_id":"ag_1","prompt":"写周报"}}`)
	mustCode(t, w, http.StatusCreated, "create disabled")
	off := decodeSchedule(t, w.Body.Bytes())
	if off.Enabled || off.NextRunAt != nil {
		t.Errorf("停用的不该有下次执行：%+v", off)
	}

	w = do(s, "GET", "/api/schedules", "")
	mustCode(t, w, http.StatusOK, "list")
	var list struct {
		Data []scheduleResp `json:"data"`
		Meta Meta           `json:"meta"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Data) != 3 || list.Meta.Total != 3 {
		t.Fatalf("list = %d, meta %+v", len(list.Data), list.Meta)
	}
	if list.Data[0].ID != monthly.ID || list.Data[1].ID != sc.ID || list.Data[2].ID != off.ID {
		t.Errorf("顺序不对：%s %s %s", list.Data[0].Name, list.Data[1].Name, list.Data[2].Name)
	}

	// 改：只改启停，规则不变
	w = do(s, "PATCH", "/api/schedules/"+off.ID, `{"enabled":true}`)
	mustCode(t, w, http.StatusOK, "enable")
	if got := decodeSchedule(t, w.Body.Bytes()); got.NextRunAt == nil || got.NextRunAt.Format("01-02 15:04") != "10-30 08:00" {
		t.Errorf("启用后 next = %v", got.NextRunAt)
	}
	// 改规则整体替换
	w = do(s, "PATCH", "/api/schedules/"+sc.ID, `{"rule":{"freq":"cron","cron":"0 18 * * 1"},"name":"周会纪要"}`)
	mustCode(t, w, http.StatusOK, "update rule")
	if got := decodeSchedule(t, w.Body.Bytes()); got.Name != "周会纪要" || got.Rule.Freq != "cron" || got.NextRunAt.Format("01-02 15:04") != "11-02 18:00" {
		t.Errorf("update = %+v next %v", got, got.NextRunAt)
	}
	w = do(s, "GET", "/api/schedules/"+sc.ID, "")
	mustCode(t, w, http.StatusOK, "get")
	if got := decodeSchedule(t, w.Body.Bytes()); got.Action["title"] != "整理本周议程" {
		t.Errorf("没改的 action 应保留：%v", got.Action)
	}

	// 删
	mustCode(t, do(s, "DELETE", "/api/schedules/"+sc.ID, ""), http.StatusOK, "delete")
	assertError(t, do(s, "GET", "/api/schedules/"+sc.ID, ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, "DELETE", "/api/schedules/"+sc.ID, ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, "PATCH", "/api/schedules/nope", `{"enabled":false}`), http.StatusNotFound, "not_found")

	// 删除记审计
	found := false
	for _, a := range listAudits(t, s, "target_type=schedule") {
		if a["kind"] == "delete" && a["target_id"] == sc.ID {
			found = true
		}
	}
	if !found {
		t.Error("删除定时任务没记审计")
	}
}

func TestSchedulesValidation(t *testing.T) {
	s, _ := newScheduleServer(t)
	bad := []string{
		``,
		`{"rule":{"freq":"daily","time":"09:00"},"action":{"kind":"task","title":"x"}}`,
		`{"name":"x","rule":{"freq":"hourly","time":"09:00"},"action":{"kind":"task","title":"x"}}`,
		`{"name":"x","rule":{"freq":"weekly","time":"09:00","weekdays":[]},"action":{"kind":"task","title":"x"}}`,
		`{"name":"x","rule":{"freq":"cron","cron":"0 9 * *"},"action":{"kind":"task","title":"x"}}`,
		// 一次性的时间已经过去
		`{"name":"x","rule":{"freq":"once","date":"2026-10-29","time":"09:00"},"action":{"kind":"task","title":"x"}}`,
		`{"name":"x","rule":{"freq":"daily","time":"09:00"},"action":{"kind":"task"}}`,
		`{"name":"x","rule":{"freq":"daily","time":"09:00"},"action":{"kind":"webhook"}}`,
		`{"name":"x","rule":{"freq":"daily","time":"09:00"},"action":{"kind":"sop"}}`,
	}
	for _, b := range bad {
		assertError(t, do(s, "POST", "/api/schedules", b), http.StatusBadRequest, "validation")
	}

	// 已过期的一次性任务：改名、停用照样可以，改规则要给将来的时间
	w := do(s, "POST", "/api/schedules", `{"name":"一次","rule":{"freq":"once","date":"2026-10-29","time":"10:30"},"action":{"kind":"task","title":"x"}}`)
	mustCode(t, w, http.StatusCreated, "create once")
	sc := decodeSchedule(t, w.Body.Bytes())
	if sc.NextRunAt == nil || sc.NextRunAt.Format("15:04") != "10:30" {
		t.Fatalf("once next = %v", sc.NextRunAt)
	}
	ss := s.opt.Schedules
	ss.SetClock(func() time.Time { return time.Date(2026, 10, 29, 11, 0, 0, 0, ss.Location()) })
	w = do(s, "PATCH", "/api/schedules/"+sc.ID, `{"name":"一次（已过）","enabled":false}`)
	mustCode(t, w, http.StatusOK, "rename expired")
	assertError(t, do(s, "PATCH", "/api/schedules/"+sc.ID, `{"rule":{"freq":"once","date":"2026-10-29","time":"10:45"}}`), http.StatusBadRequest, "validation")
	assertError(t, do(s, "PATCH", "/api/schedules/"+sc.ID, `[1]`), http.StatusBadRequest, "validation")
}

func TestSchedulePreview(t *testing.T) {
	s, _ := newScheduleServer(t)
	w := do(s, "POST", "/api/schedules/preview", `{"rule":{"freq":"monthly","time":"10:00","day":31}}`)
	mustCode(t, w, http.StatusOK, "preview")
	var env struct {
		Data struct {
			NextRuns []time.Time `json:"next_runs"`
			TimeZone string      `json:"time_zone"`
		} `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	var got []string
	for _, t := range env.Data.NextRuns {
		got = append(got, t.Format("2006-01-02"))
	}
	if len(got) != 3 || got[0] != "2026-10-31" || got[1] != "2026-11-30" || got[2] != "2026-12-31" || env.Data.TimeZone != "Asia/Shanghai" {
		t.Errorf("preview = %v %s", got, env.Data.TimeZone)
	}
	w = do(s, "POST", "/api/schedules/preview", `{"rule":{"freq":"daily","time":"09:00"},"count":10}`)
	mustCode(t, w, http.StatusOK, "preview 10")
	assertError(t, do(s, "POST", "/api/schedules/preview", `{"rule":{"freq":"daily","time":"09:00"},"count":11}`), http.StatusBadRequest, "validation")
	assertError(t, do(s, "POST", "/api/schedules/preview", `{"rule":{"freq":"daily","time":"9点"}}`), http.StatusBadRequest, "validation")
}

func TestSchedulesNotConfigured(t *testing.T) {
	s := newTestServer(newFakeStore())
	for _, c := range [][2]string{{"GET", "/api/schedules"}, {"POST", "/api/schedules/preview"}, {"DELETE", "/api/schedules/x"}} {
		e := assertError(t, do(s, c[0], c[1], `{}`), http.StatusInternalServerError, "internal")
		if e["message"] != "schedules are not configured on this server" {
			t.Errorf("%s %s message = %v", c[0], c[1], e["message"])
		}
	}
}

// 执行记录接口：调度器到点执行、手动执行、错过，都能查到；新的在前。
func TestScheduleRuns(t *testing.T) {
	s, ss := newScheduleServer(t)
	clk := time.Date(2026, 10, 29, 10, 0, 0, 0, ss.Location())
	ss.SetClock(func() time.Time { return clk })

	w := do(s, "POST", "/api/schedules", `{"name":"整理议程","rule":{"freq":"daily","time":"10:30"},"action":{"kind":"task","title":"议程 {{date}}"}}`)
	mustCode(t, w, http.StatusCreated, "create")
	sc := decodeSchedule(t, w.Body.Bytes())

	type runResp struct {
		ID       string  `json:"id"`
		At       string  `json:"at"`
		Status   string  `json:"status"`
		OK       bool    `json:"ok"`
		Text     string  `json:"text"`
		Manual   bool    `json:"manual"`
		Missed   int     `json:"missed"`
		ObjectID *string `json:"object_id"`
		Ref      *string `json:"ref"`
	}
	list := func(q string) ([]runResp, int) {
		t.Helper()
		w := do(s, "GET", "/api/schedules/"+sc.ID+"/runs"+q, "")
		mustCode(t, w, http.StatusOK, "runs")
		var env struct {
			Data []runResp `json:"data"`
			Meta Meta      `json:"meta"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
			t.Fatalf("%v: %s", err, w.Body)
		}
		return env.Data, env.Meta.Limit
	}
	if rs, limit := list(""); len(rs) != 0 || limit != schedule.DefaultRunLimit {
		t.Fatalf("还没执行过：%+v limit=%d", rs, limit)
	}

	// 手动执行一次（Agent 来源记审计）
	w = do(s, "POST", "/api/schedules/"+sc.ID+"/run", "", [2]string{"X-Actor-Source", "agent"})
	mustCode(t, w, http.StatusCreated, "run now")

	// 到点执行一次
	clk = time.Date(2026, 10, 29, 10, 30, 2, 0, ss.Location())
	if err := s.opt.ScheduleRunner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	// 隔两天再看：错过一次（10-30），10-31 这次准时
	clk = time.Date(2026, 10, 31, 10, 30, 5, 0, ss.Location())
	if err := s.opt.ScheduleRunner.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}

	rs, _ := list("")
	if len(rs) != 4 {
		t.Fatalf("应有 4 条：%+v", rs)
	}
	if rs[0].Status != "ok" || rs[0].Manual || rs[0].At != "2026-10-31T10:30:00+08:00" || rs[0].Ref == nil || rs[0].ObjectID == nil {
		t.Errorf("最新一条应为 10-31 准时执行：%+v", rs[0])
	}
	if rs[1].Status != "missed" || rs[1].OK || rs[1].Missed != 1 || rs[1].At != "2026-10-30T10:30:00+08:00" {
		t.Errorf("第二条应为 10-30 错过：%+v", rs[1])
	}
	if rs[2].Status != "ok" || rs[2].At != "2026-10-29T10:30:00+08:00" {
		t.Errorf("第三条应为 10-29 准时执行：%+v", rs[2])
	}
	if !rs[3].Manual || !rs[3].OK || rs[3].Text != "建了任务 "+*rs[3].Ref {
		t.Errorf("最早一条应为手动执行：%+v", rs[3])
	}
	if rs, limit := list("?limit=2"); len(rs) != 2 || limit != 2 {
		t.Errorf("limit=2：%d 条 limit=%d", len(rs), limit)
	}

	// 建出来的任务来源为 schedule
	w = do(s, "GET", "/api/objects?type=task&source=schedule", "")
	mustCode(t, w, http.StatusOK, "objects")
	var objs struct {
		Data []struct {
			Title  string         `json:"title"`
			Source string         `json:"source"`
			Props  map[string]any `json:"props"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &objs); err != nil {
		t.Fatal(err)
	}
	if len(objs.Data) != 3 || objs.Data[0].Source != "schedule" || objs.Data[0].Props["source_ref"].(map[string]any)["schedule_id"] != sc.ID {
		t.Fatalf("建出的任务：%+v", objs.Data)
	}

	found := false
	for _, a := range listAudits(t, s, "target_type=schedule") {
		if a["action"] == "run" && a["target_id"] == sc.ID {
			found = true
		}
	}
	if !found {
		t.Error("Agent 手动执行没记审计")
	}

	assertError(t, do(s, "GET", "/api/schedules/nope/runs", ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, "POST", "/api/schedules/nope/run", ""), http.StatusNotFound, "not_found")
	assertError(t, do(s, "GET", "/api/schedules/"+sc.ID+"/runs?limit=x", ""), http.StatusBadRequest, "validation")

	// 删定时任务后执行记录查不到（级联删除）
	mustCode(t, do(s, "DELETE", "/api/schedules/"+sc.ID, ""), http.StatusOK, "delete")
	assertError(t, do(s, "GET", "/api/schedules/"+sc.ID+"/runs", ""), http.StatusNotFound, "not_found")
}

func TestScheduleRunnerNotConfigured(t *testing.T) {
	s := newTestServer(newFakeStore())
	e := assertError(t, do(s, "POST", "/api/schedules/x/run", ""), http.StatusInternalServerError, "internal")
	if e["message"] != "schedule runner is not configured on this server" {
		t.Errorf("message = %v", e["message"])
	}
	assertError(t, do(s, "GET", "/api/schedules/x/runs", ""), http.StatusInternalServerError, "internal")
}
