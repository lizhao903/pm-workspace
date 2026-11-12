// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// PrepareStartup runs synchronously after migrations and before engine jobs.
func (p *Plugin) PrepareStartup(ctx context.Context, c plugin.Core) error {
	rows, err := c.Store().Query(ctx, "SELECT "+flowCols+" FROM sop_flows LIMIT 0")
	if err != nil {
		return fmt.Errorf("verify sop_flows before JSON import: %w", err)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return importBuiltinsFrom(ctx, c.Store(), "config/sop-build-in", c.Log())
}

// Initial installation also has to seed JSON definitions before enabling SOP.
func (p *Plugin) OnInstall(ctx context.Context, c plugin.Core) error {
	return p.PrepareStartup(ctx, c)
}

func importBuiltinsFrom(ctx context.Context, store plugin.Store, dir string, logs ...*slog.Logger) (err error) {
	log := slog.Default()
	if len(logs) > 0 && logs[0] != nil {
		log = logs[0]
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return err
	}
	inserted, skipped := 0, 0
	log.Info("SOP JSON import started", "dir", dir)
	defer func() {
		if err != nil {
			log.Error("SOP JSON import failed", "dir", dir, "created", inserted, "skipped", skipped, "err", err)
		}
	}()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		log.Warn("SOP JSON import skipped", "dir", dir, "reason", "directory does not exist")
		return nil
	}
	if err != nil {
		return err
	}
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			files = append(files, filepath.Join(dir, entry.Name()))
		}
	}
	var definitions []Flow

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
		if _, err := apply(&f, raw, func(k string) (NodeType, bool) {
			if t, ok := nodeType(k); ok {
				return t, true
			}
			return NodeType{Kind: k}, true
		}); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		definitions = append(definitions, f)
	}
	// Validate the entire directory before creating any new flows.
	for i, f := range definitions {
		file := files[i]
		now := time.Now().UTC().Format(time.RFC3339)
		result, err := store.Exec(ctx, `INSERT INTO sop_flows (`+flowCols+`) VALUES (?, 'buildin', ?, ?, ?, ?, ?, ?, 1, ?, ?)
   ON CONFLICT(id) DO NOTHING`, f.ID, f.Name, f.Desc, f.Trigger, string(f.Fields), string(f.Steps), layoutCol(f.Layout), now, now)
		if err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		if count == 0 {
			skipped++
			log.Info("SOP JSON flow skipped", "file", file, "flow_id", f.ID, "reason", "id already exists")
		} else {
			inserted++
			log.Info("SOP JSON flow created", "file", file, "flow_id", f.ID)
		}
	}
	log.Info("SOP JSON import completed", "dir", dir, "files", len(files), "created", inserted, "skipped", skipped)
	return nil
}
