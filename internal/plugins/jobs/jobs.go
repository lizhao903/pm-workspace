// Package jobs exposes the kernel's in-memory job statistics as an optional plugin.
package jobs

import (
	_ "embed"
	"encoding/json"
	"io/fs"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

type Plugin struct{ read func() []plugin.JobStats }

func New(read func() []plugin.JobStats) *Plugin { return &Plugin{read: read} }
func (*Plugin) Manifest() plugin.Manifest       { return plugin.MustParse(manifestJSON) }
func (*Plugin) Migrations() fs.FS               { return nil }
func (p *Plugin) Register(r plugin.Registrar) error {
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/jobs/stats", func(w http.ResponseWriter, _ *http.Request) {
			rows := []plugin.JobStats{}
			if p.read != nil {
				rows = p.read()
			}
			if rows == nil {
				rows = []plugin.JobStats{}
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": rows, "meta": map[string]int{"total": len(rows), "limit": len(rows), "offset": 0}})
		})
	})
	return nil
}
