// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func newIncidentServer(t *testing.T) *Server {
	t.Helper()
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	al := audit.New(st.DB(), log)
	ws := audit.WrapStore(st, al)
	is := incident.New(st.DB(), log)
	is.Audit, is.Tasks = al, ws
	return New(ws, Options{Version: "test", Logger: log, Audit: al, Incidents: is})
}

func decodeIncident(t *testing.T, body []byte) incident.Incident {
	t.Helper()
	var env struct {
		Data incident.Incident `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return env.Data
}

func TestIncidentsAPI(t *testing.T) {
	s := newIncidentServer(t)
	report := `{"level":"error","module":"前端","title":"页面出错了","message":"Cannot read properties of undefined (reading 'label')",
		"stack":"TypeError: x\n    at Page (index.js:1:2)","context":{"页面":"设置"},"url":"http://127.0.0.1:7796/settings"}`
	w := do(s, "POST", "/api/incidents/report", report)
	mustCode(t, w, http.StatusCreated, "report")
	x := decodeIncident(t, w.Body.Bytes())
	if !strings.HasPrefix(x.Fingerprint, "front:") || x.Source != "frontend" || x.Context["页面地址"] != "http://127.0.0.1:7796/settings" || x.Count != 1 {
		t.Fatalf("上报 = %+v", x)
	}
	// 同样的再报一次合并
	w = do(s, "POST", "/api/incidents/report", report)
	mustCode(t, w, http.StatusCreated, "report again")
	if y := decodeIncident(t, w.Body.Bytes()); y.ID != x.ID || y.Count != 2 {
		t.Fatalf("没合并：%+v", y)
	}
	// 不合法的 400
	mustCode(t, do(s, "POST", "/api/incidents/report", `{"level":"fatal","module":"前端","title":"x"}`), http.StatusBadRequest, "bad level")
	big := fmt.Sprintf(`{"level":"error","module":"前端","title":"x","message":%q}`, strings.Repeat("a", incident.ReportMaxBytes))
	mustCode(t, do(s, "POST", "/api/incidents/report", big), http.StatusBadRequest, "too big")

	// 列表、筛选、单条
	w = do(s, "GET", "/api/incidents?status=open&level=error,warn&module=前端", "")
	mustCode(t, w, http.StatusOK, "list")
	var list struct {
		Data []incident.Incident `json:"data"`
		Meta Meta                `json:"meta"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Data) != 1 || list.Meta.Total != 1 {
		t.Fatalf("list = %s", w.Body.String())
	}
	w = do(s, "GET", "/api/incidents?status=resolved", "")
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Data) != 0 {
		t.Fatalf("筛已解决应为空：%s", w.Body.String())
	}
	mustCode(t, do(s, "GET", "/api/incidents/"+x.ID, ""), http.StatusOK, "get")
	mustCode(t, do(s, "GET", "/api/incidents/inc_nope", ""), http.StatusNotFound, "get missing")

	// 改状态
	w = do(s, "PATCH", "/api/incidents/"+x.ID, `{"status":"ignored"}`)
	mustCode(t, w, http.StatusOK, "patch")
	if y := decodeIncident(t, w.Body.Bytes()); y.Status != "ignored" {
		t.Fatalf("patch = %+v", y)
	}
	mustCode(t, do(s, "PATCH", "/api/incidents/"+x.ID, `{"status":"bogus"}`), http.StatusBadRequest, "patch bad")
	mustCode(t, do(s, "PATCH", "/api/incidents/"+x.ID, `{}`), http.StatusBadRequest, "patch empty")
	// 已忽略的不能转任务；重新打开后能转
	mustCode(t, do(s, "POST", "/api/incidents/"+x.ID+"/task", ""), http.StatusConflict, "task ignored")
	mustCode(t, do(s, "PATCH", "/api/incidents/"+x.ID, `{"status":"open"}`), http.StatusOK, "reopen")
	w = do(s, "POST", "/api/incidents/"+x.ID+"/task", `{"priority":"P0"}`)
	mustCode(t, w, http.StatusCreated, "task")
	var res struct {
		Data struct {
			Task     map[string]any    `json:"task"`
			Incident incident.Incident `json:"incident"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Data.Task["source"] != "incident" || res.Data.Task["priority"] != "P0" || res.Data.Incident.Status != "tasked" ||
		res.Data.Incident.TaskRef != res.Data.Task["ref"] {
		t.Fatalf("task = %s", w.Body.String())
	}
	mustCode(t, do(s, "POST", "/api/incidents/"+x.ID+"/task", ""), http.StatusConflict, "task twice")

	// 审计：改状态两次、转任务一次
	w = do(s, "GET", "/api/audits?target_type=incident&target_id="+x.ID, "")
	var au struct {
		Data []audit.Entry `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &au); err != nil || len(au.Data) != 3 {
		t.Fatalf("audits = %s", w.Body.String())
	}
}

func TestIncidentReportRateLimit(t *testing.T) {
	s := newIncidentServer(t)
	for i := range incident.ReportLimit {
		body := fmt.Sprintf(`{"level":"warn","module":"前端","title":"t%d","message":"m"}`, i)
		mustCode(t, do(s, "POST", "/api/incidents/report", body), http.StatusCreated, fmt.Sprintf("report %d", i))
	}
	w := do(s, "POST", "/api/incidents/report", `{"level":"warn","module":"前端","title":"over","message":"m"}`)
	mustCode(t, w, http.StatusTooManyRequests, "over limit")
	if !strings.Contains(w.Body.String(), `"rate_limited"`) {
		t.Fatalf("429 的错误码 = %s", w.Body.String())
	}
}

func TestIncidentsNotConfigured(t *testing.T) {
	s := New(nil, Options{Version: "test", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	mustCode(t, do(s, "GET", "/api/incidents", ""), http.StatusInternalServerError, "not configured")
}

// Claude Code 执行失败记运行异常（INC-01a 追加）：同一个任务反复失败合并，取消、成功不记，服务重启中断的也记。
func TestFailedRunRecordsIncident(t *testing.T) {
	st, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "inc.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	is := incident.New(st.DB(), nil)

	s, f, obj, _ := runFixture(t, "echo '鉴权失败' >&2\nexit 2")
	s.opt.Incidents = is
	do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	list, err := is.List(context.Background(), incident.Filter{})
	if err != nil || len(list) != 1 {
		t.Fatalf("应合并成一条：%+v %v", list, err)
	}
	x := list[0]
	if x.Fingerprint != "claude:"+obj.ID+":failed" || x.Level != "error" || x.Module != "Claude Code" || x.Count != 2 ||
		x.Title != "Claude Code 执行失败："+obj.Ref+" "+obj.Title || !strings.Contains(x.Message, "鉴权失败") || x.Context["任务 id"] != obj.ID {
		t.Fatalf("记下的 = %+v", x)
	}

	// 服务重启中断的执行：读的时候收尾成 failed，同样记
	run, err := f.CreateTaskRun(t.Context(), &domain.TaskRun{ObjectID: obj.ID, Workdir: "/tmp/x", Status: domain.RunRunning})
	if err != nil {
		t.Fatal(err)
	}
	f.taskRuns[run.ID].StartedAt = time.Now().Add(-2 * staleRunGrace)
	do(s, "GET", "/api/objects/"+obj.ID+"/runs", "")
	if got, _ := is.List(context.Background(), incident.Filter{}); len(got) != 1 || got[0].Count != 3 {
		t.Fatalf("重启中断的也该记：%+v", got)
	}

	// 成功的不记
	s2, _, obj2, _ := runFixture(t, "echo ok")
	s2.opt.Incidents = is
	do(s2, "POST", "/api/objects/"+obj2.ID+"/run", `{}`)
	if got, _ := is.List(context.Background(), incident.Filter{}); len(got) != 1 {
		t.Fatalf("成功的不该记：%+v", got)
	}
}
