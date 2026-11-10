// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package db

import (
	"io/fs"
	"testing"
	"testing/fstest"
)

// TestMigration0031BackfillsProvenance 先应用到 0030、写几条老产物，再应用 0031，
// 看产出者和代码类种类有没有按约定回填，备注是否原样保留。
func TestMigration0031BackfillsProvenance(t *testing.T) {
	d, ctx := openTestDB(t)
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
	if err := migrate(ctx, d, upTo("0030_~")); err != nil {
		t.Fatalf("migrate to 0030: %v", err)
	}
	for _, r := range [][3]string{
		{"art_1", "manual", "普通备注"},
		{"art_2", "mcp", "[commit] sha=abc repo=/r  修好了"},
		{"art_3", "mcp", "[branch] branch=feat/x"},
		{"art_4", "run", "[pr] branch=feat/x"},
		{"art_5", "agent", "提到 [commit] 但不在开头"},
	} {
		if _, err := d.W.ExecContext(ctx, `INSERT INTO artifacts
			(id, url, source, note, created_at, updated_at) VALUES (?, 'https://x', ?, ?, 't', 't')`,
			r[0], r[1], r[2]); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, d, upTo("0031_~")); err != nil {
		t.Fatalf("migrate 0031: %v", err)
	}

	want := map[string][3]string{ // kind, actor_type, note
		"art_1": {"", "user", "普通备注"},
		"art_2": {"commit", "mcp", "[commit] sha=abc repo=/r  修好了"},
		"art_3": {"branch", "mcp", "[branch] branch=feat/x"},
		"art_4": {"pr", "run", "[pr] branch=feat/x"},
		"art_5": {"", "agent", "提到 [commit] 但不在开头"},
	}
	rows, err := d.R.QueryContext(ctx, `SELECT id, kind, actor_type, note, props FROM artifacts`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	n := 0
	for rows.Next() {
		var id, kind, actor, note, props string
		if err := rows.Scan(&id, &kind, &actor, &note, &props); err != nil {
			t.Fatal(err)
		}
		n++
		if w := want[id]; w != [3]string{kind, actor, note} || props != "{}" {
			t.Errorf("%s: kind=%q actor=%q note=%q props=%q，期望 %v", id, kind, actor, note, props, w)
		}
	}
	if n != len(want) {
		t.Errorf("回填后 %d 行，期望 %d", n, len(want))
	}
}
