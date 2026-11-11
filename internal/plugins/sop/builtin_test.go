package sop

import (
	"context"
	"database/sql"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"testing"
)

func TestBuiltinReadonlyAndDuplicateID(t *testing.T) {
	_, h, d := setupDB(t, New())
	body := `{"id":"sop_readonly","name":"Test","fields":[],"steps":[{"key":"done","name":"Done","kind":"end"}]}`
	if code, out := call(t, h, "POST", "/api/sop/flows", body); code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	if code, _ := call(t, h, "POST", "/api/sop/flows", body); code != 409 {
		t.Fatalf("duplicate: %d", code)
	}
	if _, err := d.W.ExecContext(context.Background(), `UPDATE sop_flows SET ownership = 'buildin' WHERE id = 'sop_readonly'`); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"PATCH", "DELETE"} {
		if code, out := call(t, h, method, "/api/sop/flows/sop_readonly", body); code != 409 {
			t.Fatalf("%s: %d %v", method, code, out)
		}
	}
	if code, out := call(t, h, "GET", "/api/sop/flows/sop_readonly", ""); code != 200 || out["data"].(map[string]any)["ownership"] != "buildin" {
		t.Fatalf("read: %d %v", code, out)
	}
}

type builtinTestStore struct{ *sql.DB }

func (s builtinTestStore) Exec(ctx context.Context, q string, args ...any) (sql.Result, error) {
	return s.ExecContext(ctx, q, args...)
}
func (s builtinTestStore) Query(ctx context.Context, q string, args ...any) (*sql.Rows, error) {
	return s.QueryContext(ctx, q, args...)
}
func (s builtinTestStore) QueryRow(ctx context.Context, q string, args ...any) plugin.Row {
	return s.QueryRowContext(ctx, q, args...)
}

func TestImportBuiltinFilesIsIdempotent(t *testing.T) {
	_, _, d := setupDB(t, New())
	store := builtinTestStore{d.W}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := importBuiltinsFrom(ctx, store, "../../../config/sop-build-in"); err != nil {
			t.Fatal(err)
		}
	}
	var count, maxVersion int
	if err := d.R.QueryRowContext(ctx, `SELECT count(*), max(version) FROM sop_flows WHERE ownership = 'buildin'`).Scan(&count, &maxVersion); err != nil {
		t.Fatal(err)
	}
	if count != 7 || maxVersion != 1 {
		t.Fatalf("count=%d version=%d", count, maxVersion)
	}
}
