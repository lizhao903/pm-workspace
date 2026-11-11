package sop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Import definitions before resuming the engine. Identical files do not create new versions.
func importBuiltins(ctx context.Context, c plugin.Core) error {
	return importBuiltinsFrom(ctx, c.Store(), "config/sop-build-in")
}

func importBuiltinsFrom(ctx context.Context, store plugin.Store, dir string) error {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var f Flow
		if err := json.Unmarshal(data, &f); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		if !flowIDRe.MatchString(f.ID) || seen[f.ID] {
			return fmt.Errorf("%s: invalid or duplicate SOP id %q", file, f.ID)
		}
		seen[f.ID] = true
		// Other plugins may not have registered their node types yet. Validate the structure
		// here; runtime/editor validation checks the full live node catalog.
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			return err
		}
		if err := apply(&f, raw, func(k string) (NodeType, bool) {
			if t, ok := nodeType(k); ok {
				return t, true
			}
			return NodeType{Kind: k}, true
		}); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		_, err = store.Exec(ctx, `INSERT INTO sop_flows (`+flowCols+`) VALUES (?, 'buildin', ?, ?, ?, ?, ?, ?, 1, ?, ?)
   ON CONFLICT(id) DO UPDATE SET ownership = 'buildin', name = excluded.name, description = excluded.description,
   trigger_desc = excluded.trigger_desc, fields = excluded.fields, steps = excluded.steps, layout = excluded.layout,
   version = sop_flows.version + 1, updated_at = excluded.updated_at
   WHERE sop_flows.ownership != 'buildin' OR sop_flows.name != excluded.name OR sop_flows.description != excluded.description
   OR sop_flows.trigger_desc != excluded.trigger_desc OR sop_flows.fields != excluded.fields OR sop_flows.steps != excluded.steps
   OR sop_flows.layout IS NOT excluded.layout`, f.ID, f.Name, f.Desc, f.Trigger, string(f.Fields), string(f.Steps), layoutCol(f.Layout), now, now)
		if err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
	}
	return nil
}
