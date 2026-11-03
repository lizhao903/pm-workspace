package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

// --- 运行异常（INC-01a，0043）---

func (s *Server) incidentsConfigured(w http.ResponseWriter) bool {
	if s.opt.Incidents == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "incidents are not configured on this server"}})
		return false
	}
	return true
}

// handleListIncidents 是 GET /api/incidents：status、level、module 都可以逗号多选，最近一次新的在前，不分页。
func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request) {
	if !s.incidentsConfigured(w) {
		return
	}
	p := newParams(r)
	items, err := s.opt.Incidents.List(r.Context(), incident.Filter{
		Status: p.csv("status"), Level: p.csv("level"), Module: p.csv("module"),
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleGetIncident(w http.ResponseWriter, r *http.Request) {
	if !s.incidentsConfigured(w) {
		return
	}
	x, err := s.opt.Incidents.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, x)
}

// handleUpdateIncident 是 PATCH /api/incidents/{id}：只改 status。
func (s *Server) handleUpdateIncident(w http.ResponseWriter, r *http.Request) {
	if !s.incidentsConfigured(w) {
		return
	}
	var body struct {
		Status *string `json:"status"`
	}
	if err := decodeBody(r, &body); err != nil {
		s.fail(w, r, err)
		return
	}
	if body.Status == nil {
		s.fail(w, r, validationf("status is required"))
		return
	}
	x, err := s.opt.Incidents.SetStatus(r.Context(), r.PathValue("id"), *body.Status, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, x)
}

// handleIncidentTask 是 POST /api/incidents/{id}/task：转研发任务，回 201 + {task, incident}。body 可以不传。
func (s *Server) handleIncidentTask(w http.ResponseWriter, r *http.Request) {
	if !s.incidentsConfigured(w) {
		return
	}
	b, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in incident.TaskInput
	if len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &in); err != nil {
			s.fail(w, r, validationf("malformed JSON body: %v", err))
			return
		}
	}
	res, err := s.opt.Incidents.ToTask(r.Context(), r.PathValue("id"), in, actorFrom(r))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, res)
}

// incidentReport 是前端上报的 body。
type incidentReport struct {
	Level       string         `json:"level"`
	Module      string         `json:"module"`
	Title       string         `json:"title"`
	Message     string         `json:"message"`
	Stack       string         `json:"stack"`
	Context     map[string]any `json:"context"`
	URL         string         `json:"url"`
	Fingerprint string         `json:"fingerprint"`
}

// handleReportIncident 是 POST /api/incidents/report：前端上报一条，回 201 + Incident（合并后的）。
// 单条 32KB 上限；整体每分钟最多 60 次，超了 429 rate_limited；同一指纹一分钟内只加次数。
func (s *Server) handleReportIncident(w http.ResponseWriter, r *http.Request) {
	if !s.incidentsConfigured(w) {
		return
	}
	b, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(b) > incident.ReportMaxBytes {
		s.fail(w, r, validationf("report exceeds %d bytes", incident.ReportMaxBytes))
		return
	}
	if len(b) == 0 {
		s.fail(w, r, validationf("request body is required"))
		return
	}
	var in incidentReport
	if err := json.Unmarshal(b, &in); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	if !s.opt.Incidents.AllowReport() {
		writeJSON(w, http.StatusTooManyRequests, errBody{Error: errPayload{Code: "rate_limited",
			Message: "运行异常上报太频繁：每分钟最多 60 条，稍后再报"}})
		return
	}
	fp := strings.TrimSpace(in.Fingerprint)
	if fp == "" {
		fp = incident.FrontendFingerprint(in.Module, in.Title, in.Stack)
	}
	ctx := in.Context
	if ctx == nil {
		ctx = map[string]any{}
	}
	if u := strings.TrimSpace(in.URL); u != "" {
		if _, ok := ctx["页面地址"]; !ok {
			ctx["页面地址"] = u
		}
	}
	x, err := s.opt.Incidents.Record(r.Context(), incident.Report{
		Fingerprint: fp, Level: in.Level, Module: in.Module, Title: in.Title, Message: in.Message,
		Stack: in.Stack, Context: ctx, Source: incident.SourceFrontend,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, x)
}
