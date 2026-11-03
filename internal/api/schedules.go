package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/schedule"
)

// --- 定时任务（TASK-03a 定义和下次执行时间，TASK-03b 执行记录和手动执行）---

// maxPreview 是预览最多算几次。
const maxPreview = 10

func (s *Server) schedulesConfigured(w http.ResponseWriter) bool {
	if s.opt.Schedules == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "schedules are not configured on this server"}})
		return false
	}
	return true
}

func (s *Server) handleListSchedules(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	var (
		items []schedule.Schedule
		err   error
	)
	// ?object_id= 只看关联这个对象的提醒（任务抽屉里的「提醒」）
	if id := strings.TrimSpace(r.URL.Query().Get("object_id")); id != "" {
		items, err = s.opt.Schedules.ListByObject(r.Context(), id)
	} else {
		items, err = s.opt.Schedules.List(r.Context())
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleCreateSchedule(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	var in schedule.Input
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	sc, err := s.opt.Schedules.Create(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditSchedule(r, audit.KindAgent, "create", sc, "新建定时任务「"+sc.Name+"」", nil)
	respondData(w, http.StatusCreated, sc)
}

func (s *Server) handleGetSchedule(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	sc, err := s.opt.Schedules.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, sc)
}

func (s *Server) handleUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	keys, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var p schedule.Patch
	if err := json.Unmarshal(body, &p); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	sc, err := s.opt.Schedules.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for k := range keys {
		fields[k] = true
	}
	s.auditSchedule(r, audit.KindAgent, "update", sc, "修改定时任务「"+sc.Name+"」", map[string]any{"fields": givenFields(fields)})
	respondData(w, http.StatusOK, sc)
}

func (s *Server) handleDeleteSchedule(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	id := r.PathValue("id")
	sc, err := s.opt.Schedules.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.Schedules.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditSchedule(r, audit.KindDelete, "delete", sc, "删除定时任务「"+sc.Name+"」", nil)
	respondData(w, http.StatusOK, nil)
}

// handlePreviewSchedule 是 POST /api/schedules/preview：编辑时还没保存的规则，算接下来几次。
func (s *Server) handlePreviewSchedule(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	var body struct {
		Rule  schedule.Rule `json:"rule"`
		Count int           `json:"count"`
	}
	if err := decodeBody(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	n := body.Count
	if n == 0 {
		n = 3
	}
	if n < 1 || n > maxPreview {
		s.fail(w, r, validationf("count must be 1..%d, got %d", maxPreview, body.Count))
		return
	}
	st := s.opt.Schedules
	rule, err := st.CheckRule(body.Rule)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, struct {
		Rule     schedule.Rule `json:"rule"`
		NextRuns []time.Time   `json:"next_runs"`
		TimeZone string        `json:"time_zone"`
	}{rule, schedule.NextN(rule, st.Now(), st.Location(), n), st.ZoneName()})
}

// handleListScheduleRuns 是 GET /api/schedules/{id}/runs：执行记录，计划时刻新的在前。
func (s *Server) handleListScheduleRuns(w http.ResponseWriter, r *http.Request) {
	if !s.schedulesConfigured(w) {
		return
	}
	limit, err := newParams(r).limit("limit", schedule.DefaultRunLimit, schedule.MaxRunLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.opt.Schedules.ListRuns(r.Context(), r.PathValue("id"), limit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: limit})
}

// handleRunSchedule 是 POST /api/schedules/{id}/run：按保存的配置马上执行一次，停用的也能跑，不影响下次执行时间。
func (s *Server) handleRunSchedule(w http.ResponseWriter, r *http.Request) {
	if s.opt.ScheduleRunner == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "schedule runner is not configured on this server"}})
		return
	}
	run, err := s.opt.ScheduleRunner.RunNow(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if sc, err := s.opt.Schedules.Get(r.Context(), run.ScheduleID); err == nil {
		s.auditSchedule(r, audit.KindAgent, "run", sc, "手动执行定时任务「"+sc.Name+"」："+run.Text, nil)
	}
	respondData(w, http.StatusCreated, run)
}

// auditSchedule 按契约的审计口径记一条：删除不分来源都记，新建和修改只记 Agent 来源的。
func (s *Server) auditSchedule(r *http.Request, kind, action string, sc *schedule.Schedule, summary string, detail map[string]any) {
	if kind == audit.KindAgent && actorFrom(r).Source != "agent" {
		return
	}
	s.opt.Audit.Note(r.Context(), audit.Entry{
		Kind: kind, Action: action, TargetType: "schedule", TargetID: sc.ID, Summary: summary, Detail: detail,
	})
}
