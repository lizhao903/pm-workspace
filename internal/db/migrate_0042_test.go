package db

import (
	"io/fs"
	"testing"
	"testing/fstest"
)

// TestMigration0042RenamesTaskType 内置任务类型改叫「任务」；手工改过的名字不动。
func TestMigration0042RenamesTaskType(t *testing.T) {
	sub, err := fs.Sub(migrationFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	names, err := migrationNames(sub)
	if err != nil {
		t.Fatal(err)
	}
	upTo := func(last string) fs.FS {
		m := fstest.MapFS{}
		for _, n := range names {
			if n > last {
				continue
			}
			b, err := fs.ReadFile(sub, n)
			if err != nil {
				t.Fatal(err)
			}
			m[n] = &fstest.MapFile{Data: b}
		}
		return m
	}
	read := func(t *testing.T, d *DB) (string, string) {
		var name, plural string
		if err := d.W.QueryRow(`SELECT name, plural FROM object_types WHERE id = 'task'`).Scan(&name, &plural); err != nil {
			t.Fatal(err)
		}
		return name, plural
	}

	t.Run("内置名改成任务", func(t *testing.T) {
		d, ctx := openTestDB(t)
		if err := migrate(ctx, d, upTo("0042_~")); err != nil {
			t.Fatal(err)
		}
		if name, plural := read(t, d); name != "任务" || plural != "任务" {
			t.Fatalf("name=%q plural=%q", name, plural)
		}
		var key string
		if err := d.W.QueryRow(`SELECT ref_prefix FROM object_types WHERE id = 'task'`).Scan(&key); err != nil || key != "TSK" {
			t.Fatalf("ref_prefix=%q err=%v", key, err)
		}
	})

	t.Run("手工改过的名字不动", func(t *testing.T) {
		d, ctx := openTestDB(t)
		if err := migrate(ctx, d, upTo("0041_~")); err != nil {
			t.Fatal(err)
		}
		if _, err := d.W.ExecContext(ctx, `UPDATE object_types SET name = '工单', plural = '工单' WHERE id = 'task'`); err != nil {
			t.Fatal(err)
		}
		if err := migrate(ctx, d, upTo("0042_~")); err != nil {
			t.Fatal(err)
		}
		if name, plural := read(t, d); name != "工单" || plural != "工单" {
			t.Fatalf("name=%q plural=%q", name, plural)
		}
	})
}
