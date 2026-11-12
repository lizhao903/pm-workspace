package main

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
)

func oldInstalledSOP(t *testing.T, enabled bool) string {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	p := sop.New()
	entries, err := fs.ReadDir(p.Migrations(), ".")
	if err != nil {
		t.Fatal(err)
	}
	migrations := plugin.NewSQLMigrationStore(d)
	for _, entry := range entries {
		if entry.Name() >= "0008" {
			continue
		}
		body, err := fs.ReadFile(p.Migrations(), entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		// Derive the original checksum from the registered migration plan.
		r := plugin.NewRegistry(plugin.NewSQLStateStore(d), nil)
		r.Migrations = migrations
		if err := r.Add(p); err != nil {
			t.Fatal(err)
		}
		steps, err := r.MigrationSteps(ctx, "sop")
		if err != nil {
			t.Fatal(err)
		}
		var checksum string
		for _, step := range steps {
			if step.File == entry.Name() {
				checksum = step.Checksum
			}
		}
		if err := migrations.Apply(ctx, plugin.AppliedMigration{Plugin: "sop", File: entry.Name(), Checksum: checksum, PluginVersion: "0.11.0"}, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := plugin.NewSQLStateStore(d).Save(ctx, plugin.State{ID: "sop", Installed: true, Enabled: enabled, Version: "0.11.0", Permissions: []string{}}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.W.ExecContext(ctx, `INSERT INTO sop_flows (id,name,version,created_at,updated_at) VALUES ('sop_local','本地修改',7,'before','before'); INSERT INTO sop_runs (id,flow_id,flow_version,title,flow,status,started_at,updated_at) VALUES ('old_run','sop_local',7,'旧执行','{"name":"旧快照"}','done','before','before')`); err != nil {
		t.Fatal(err)
	}
	path := d.Path
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func prepareTestRegistry(t *testing.T, s *sqlite.Store, log *slog.Logger) *plugin.Registry {
	t.Helper()
	r := plugin.NewRegistry(plugin.NewSQLStateStore(s.DB()), log)
	r.Migrations = plugin.NewSQLMigrationStore(s.DB())
	if err := r.Add(sop.New()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func TestAutomaticSOPMigrationThenJSONImport(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		t.Run(map[bool]string{true: "enabled", false: "disabled"}[enabled], func(t *testing.T) {
			path := oldInstalledSOP(t, enabled)
			root := t.TempDir()
			dir := filepath.Join(root, "config", "sop-build-in")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			t.Chdir(root)
			for _, id := range []string{"sop_local", "sop_new"} {
				body := `{"id":"` + id + `","name":"JSON 定义","fields":[],"steps":[{"key":"end","name":"结束","kind":"end"}]}`
				if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx := context.Background()
			for restart := 0; restart < 2; restart++ {
				s, err := sqlite.Open(ctx, path)
				if err != nil {
					t.Fatal(err)
				}
				var logs bytes.Buffer
				log := slog.New(slog.NewTextHandler(&logs, nil))
				r := prepareTestRegistry(t, s, log)
				backups := 0
				err = r.PrepareStartup(ctx, "sop", func(ctx context.Context) (string, error) {
					backups++
					info, err := s.Snapshot(ctx, "")
					if err != nil {
						return "", err
					}
					snapshot, err := db.Open(info.Path)
					if err != nil {
						return "", err
					}
					defer snapshot.Close()
					var n int
					if err := snapshot.R.QueryRow(`SELECT count(*) FROM pragma_table_info('sop_flows') WHERE name='ownership'`).Scan(&n); err != nil {
						return "", err
					}
					if n != 0 {
						t.Fatal("backup must precede migration")
					}
					return info.Path, nil
				})
				if err != nil {
					t.Fatal(err)
				}
				expectedBackups := 0
				if restart == 0 {
					expectedBackups = 1
				}
				if backups != expectedBackups {
					t.Fatalf("backups=%d want %d", backups, expectedBackups)
				}
				// Import must already be complete before any plugin jobs have started.
				for _, id := range []string{"sop_local", "sop_new"} {
					var name, owner, updated string
					var version int
					if err := s.DB().R.QueryRow(`SELECT name,ownership,version,updated_at FROM sop_flows WHERE id=?`, id).Scan(&name, &owner, &version, &updated); err != nil {
						t.Fatal(err)
					}
					if id == "sop_local" && (name != "本地修改" || owner != "nobuild-in" || version != 7 || updated != "before") {
						t.Fatalf("local overwritten: %s %s %d %s", name, owner, version, updated)
					}
					if id == "sop_new" && (name != "JSON 定义" || owner != "buildin" || version != 1) {
						t.Fatalf("JSON import: %s %s %d", name, owner, version)
					}
				}
				var snapshot string
				if err := s.DB().R.QueryRow(`SELECT flow FROM sop_runs WHERE id='old_run'`).Scan(&snapshot); err != nil || snapshot != `{"name":"旧快照"}` {
					t.Fatalf("run snapshot changed: %s %v", snapshot, err)
				}
				states, err := plugin.NewSQLStateStore(s.DB()).Load(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if states["sop"].Version != "0.11.0" || len(states["sop"].Permissions) != 0 || states["sop"].Enabled != enabled {
					t.Fatal("startup changed version/permissions/enabled state")
				}
				steps, err := r.MigrationSteps(ctx, "sop")
				if err != nil {
					t.Fatal(err)
				}
				for _, step := range steps {
					if step.Applied == nil {
						t.Fatalf("migration not recorded: %s", step.File)
					}
				}
				for _, want := range []string{"plugin startup preparation started", "SOP JSON flow skipped", "flow_id=sop_local", "SOP JSON import completed"} {
					if !strings.Contains(logs.String(), want) {
						t.Fatalf("missing log %q:\n%s", want, logs.String())
					}
				}
				if restart == 0 {
					for _, want := range []string{"backup completed", "plugin migration started", "file=0008_flow_ownership.sql", "plugin migration applied", "created=1 skipped=1"} {
						if !strings.Contains(logs.String(), want) {
							t.Fatalf("missing log %q:\n%s", want, logs.String())
						}
					}
					if strings.Index(logs.String(), "plugin migration applied") > strings.Index(logs.String(), "SOP JSON import started") {
						t.Fatal("JSON import preceded migration")
					}
				} else if !strings.Contains(logs.String(), "created=0 skipped=2") {
					t.Fatal("restart did not skip existing IDs")
				}
				if err := r.Start(ctx); err != nil {
					t.Fatal(err)
				}
				info, err := r.Get("sop")
				if err != nil || info.Running != enabled {
					t.Fatalf("running=%v err=%v", info.Running, err)
				}
				if restart == 0 {
					changed := `{"id":"sop_new","name":"新的 JSON 定义","fields":[],"steps":[{"key":"end","name":"结束","kind":"end"}]}`
					if err := os.WriteFile(filepath.Join(dir, "sop_new.json"), []byte(changed), 0600); err != nil {
						t.Fatal(err)
					}
				}
				r.Close()
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestSOPAutomaticUpgradeBackupFailureStopsBeforeImport(t *testing.T) {
	ctx := context.Background()
	path := oldInstalledSOP(t, true)
	s, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var logs bytes.Buffer
	r := prepareTestRegistry(t, s, slog.New(slog.NewTextHandler(&logs, nil)))
	boom := errors.New("backup failed")
	if err := r.PrepareStartup(ctx, "sop", func(context.Context) (string, error) { return "", boom }); !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
	var n int
	if err := s.DB().R.QueryRow(`SELECT count(*) FROM pragma_table_info('sop_flows') WHERE name='ownership'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("schema changed: %d %v", n, err)
	}
	if strings.Contains(logs.String(), "SOP JSON import started") || !strings.Contains(logs.String(), "backup failed") {
		t.Fatalf("unexpected logs: %s", logs.String())
	}
}

func TestSOPAutomaticUpgradeRejectsChangedHistory(t *testing.T) {
	ctx := context.Background()
	s, err := sqlite.Open(ctx, oldInstalledSOP(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.DB().W.ExecContext(ctx, `UPDATE plugins_migrations SET checksum='changed' WHERE plugin_id='sop' AND file='0001_flows.sql'`); err != nil {
		t.Fatal(err)
	}
	r := prepareTestRegistry(t, s, slog.Default())
	err = r.PrepareStartup(ctx, "sop", func(context.Context) (string, error) { t.Fatal("history check must precede backup"); return "", nil })
	if err == nil || !strings.Contains(err.Error(), "0001_flows.sql") {
		t.Fatalf("got %v", err)
	}
}

func TestSOPAutomaticUpgradeImportFailureCanRetry(t *testing.T) {
	ctx := context.Background()
	s, err := sqlite.Open(ctx, oldInstalledSOP(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	root := t.TempDir()
	dir := filepath.Join(root, "config", "sop-build-in")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(root)
	file := filepath.Join(dir, "retry.json")
	if err := os.WriteFile(file, []byte(`{"id":`), 0600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	r := prepareTestRegistry(t, s, slog.New(slog.NewTextHandler(&logs, nil)))
	backup := func(ctx context.Context) (string, error) {
		info, err := s.Snapshot(ctx, "")
		if err != nil {
			return "", err
		}
		return info.Path, nil
	}
	err = r.PrepareStartup(ctx, "sop", backup)
	if err == nil || !strings.Contains(err.Error(), "retry.json") || !strings.Contains(logs.String(), "SOP JSON import failed") {
		t.Fatalf("expected import failure: %v\n%s", err, logs.String())
	}
	info, err := r.Get("sop")
	if err != nil || info.Running {
		t.Fatalf("plugin started before import succeeded: %v", err)
	}
	body := `{"id":"sop_retry","name":"重试","fields":[],"steps":[{"key":"end","name":"结束","kind":"end"}]}`
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	r2 := prepareTestRegistry(t, s, slog.Default())
	if err := r2.PrepareStartup(ctx, "sop", func(context.Context) (string, error) {
		t.Fatal("completed migration must not run or back up again")
		return "", nil
	}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.DB().R.QueryRow(`SELECT count(*) FROM sop_flows WHERE id='sop_retry'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("retry import: %d %v", n, err)
	}
}

func TestSOPAutomaticUpgradeMigrationFailureStopsBeforeImport(t *testing.T) {
	ctx := context.Background()
	s, err := sqlite.Open(ctx, oldInstalledSOP(t, true))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Inconsistent database: column exists but the migration record is absent.
	// Do not guess at history or proceed to JSON import after the DDL fails.
	body, err := fs.ReadFile(sop.New().Migrations(), "0008_flow_ownership.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().W.ExecContext(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	r := prepareTestRegistry(t, s, slog.New(slog.NewTextHandler(&logs, nil)))
	var backupPath string
	err = r.PrepareStartup(ctx, "sop", func(ctx context.Context) (string, error) {
		info, err := s.Snapshot(ctx, "")
		if err != nil {
			return "", err
		}
		backupPath = info.Path
		return info.Path, nil
	})
	if err == nil || backupPath == "" || !strings.Contains(err.Error(), backupPath) {
		t.Fatalf("missing migration failure/backup: %v", err)
	}
	if !strings.Contains(logs.String(), "plugin migration failed") || !strings.Contains(logs.String(), "0008_flow_ownership.sql") || strings.Contains(logs.String(), "SOP JSON import started") {
		t.Fatalf("unexpected logs:\n%s", logs.String())
	}
	var n int
	if err := s.DB().R.QueryRow(`SELECT count(*) FROM plugins_migrations WHERE plugin_id='sop' AND file='0008_flow_ownership.sql'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("failed migration was recorded: %d %v", n, err)
	}
}
