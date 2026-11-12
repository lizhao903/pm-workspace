package plugin

import (
	"sort"
	"time"
)

// One second buckets bound memory independently of execution frequency.
type jobBucket struct {
	second                    int64
	success, failed, canceled int
}
type jobStats struct {
	view    JobStats
	buckets [3600]jobBucket
}

type JobStats struct {
	PluginID       string     `json:"plugin_id"`
	PluginName     string     `json:"plugin_name"`
	Name           string     `json:"name"`
	EveryMS        int64      `json:"every_ms"`
	Enabled        bool       `json:"enabled"`
	Running        bool       `json:"running"`
	Total          int        `json:"total"`
	Success        int        `json:"success"`
	Failed         int        `json:"failed"`
	Canceled       int        `json:"canceled"`
	LastStartedAt  *time.Time `json:"last_started_at"`
	LastFinishedAt *time.Time `json:"last_finished_at"`
	LastDurationMS int64      `json:"last_duration_ms"`
	LastError      string     `json:"last_error"`
}

func (r *Registry) registerJobStats(id, label string, j Job) {
	r.jobStatsMu.Lock()
	defer r.jobStatsMu.Unlock()
	if r.jobStats == nil {
		r.jobStats = map[string]*jobStats{}
	}
	key := id + "/" + j.Name
	if r.jobStats[key] == nil {
		r.jobStats[key] = &jobStats{}
	}
	s := r.jobStats[key]
	s.view.PluginID, s.view.PluginName, s.view.Name, s.view.EveryMS = id, label, j.Name, j.Every.Milliseconds()
}
func (r *Registry) jobStarted(id, name string, at time.Time) {
	r.jobStatsMu.Lock()
	defer r.jobStatsMu.Unlock()
	if s := r.jobStats[id+"/"+name]; s != nil {
		s.view.Running = true
		s.view.LastStartedAt = &at
	}
}
func (r *Registry) jobFinished(id, name string, start time.Time, err error, canceled bool) {
	r.recordJobFinish(id, name, start, time.Now(), err, canceled)
}
func (r *Registry) recordJobFinish(id, name string, start, end time.Time, err error, canceled bool) {
	r.jobStatsMu.Lock()
	defer r.jobStatsMu.Unlock()
	s := r.jobStats[id+"/"+name]
	if s == nil {
		return
	}
	s.view.Running = false
	s.view.LastFinishedAt = &end
	s.view.LastDurationMS = end.Sub(start).Milliseconds()
	b := &s.buckets[end.Unix()%3600]
	if b.second != end.Unix() {
		*b = jobBucket{second: end.Unix()}
	}
	switch {
	case canceled:
		b.canceled++
	case err != nil:
		b.failed++
		s.view.LastError = err.Error()
	default:
		b.success++
		s.view.LastError = ""
	}
}

// JobStats lists jobs observed since process start, including stopped plugins.
// Counts cover completed runs in the last hour, rounded to seconds; active runs are separate.
func (r *Registry) JobStats() []JobStats { return r.jobStatsAt(time.Now()) }
func (r *Registry) jobStatsAt(now time.Time) []JobStats {
	enabled := map[string]bool{}
	for _, p := range r.List() {
		enabled[p.Manifest.ID] = p.Running
	}
	r.jobStatsMu.Lock()
	defer r.jobStatsMu.Unlock()
	out := []JobStats{}
	for _, s := range r.jobStats {
		v := s.view
		v.Enabled = enabled[v.PluginID]
		for _, b := range s.buckets {
			if b.second > now.Unix()-3600 && b.second <= now.Unix() {
				v.Success += b.success
				v.Failed += b.failed
				v.Canceled += b.canceled
			}
		}
		v.Total = v.Success + v.Failed + v.Canceled
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Failed > 0) != (b.Failed > 0) {
			return a.Failed > 0
		}
		if a.Failed != b.Failed {
			return a.Failed > b.Failed
		}
		if a.Running != b.Running {
			return a.Running
		}
		if a.PluginID != b.PluginID {
			return a.PluginID < b.PluginID
		}
		return a.Name < b.Name
	})
	return out
}
