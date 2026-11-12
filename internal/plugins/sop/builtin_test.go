package sop

import (
	"bytes"
	"context"
	"database/sql"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportBuiltinPreservesLocalCollision(t *testing.T) {
	_, h, d := setupDB(t, New())
	const id = "sop_local_collision"
	if code, out := call(t, h, "POST", "/api/sop/flows", `{"id":"`+id+`","name":"本地修改","steps":[{"key":"done","name":"Done","kind":"end"}]}`); code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	var before string
	query := `SELECT json_array(ownership,name,description,trigger_desc,fields,steps,layout,version,created_at,updated_at) FROM sop_flows WHERE id = ?`
	if err := d.R.QueryRow(query, id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "collision.json"), []byte(`{"id":"`+id+`","name":"内置定义","fields":[],"steps":[{"key":"end","name":"End","kind":"end"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := importBuiltinsFrom(context.Background(), builtinTestStore{d.W}, dir); err != nil {
			t.Fatal(err)
		}
	}
	var after string
	if err := d.R.QueryRow(query, id).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("local SOP overwritten: before=%s after=%s", before, after)
	}
	if code, out := call(t, h, "PATCH", "/api/sop/flows/"+id, `{"version":1,"name":"仍可修改"}`); code != 200 {
		t.Fatalf("local SOP must remain editable: %d %v", code, out)
	}
}

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

func TestImportBuiltinDoesNotUpdateExistingBuiltin(t *testing.T) {
	_, _, d := setupDB(t, New())
	ctx := context.Background()
	dir := t.TempDir()
	file := filepath.Join(dir, "existing.json")
	write := func(name string) {
		t.Helper()
		body := `{"id":"sop_existing_builtin","name":"` + name + `","fields":[],"steps":[{"key":"end","name":"结束","kind":"end"}]}`
		if err := os.WriteFile(file, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	store := builtinTestStore{d.W}
	write("原始内置")
	if err := importBuiltinsFrom(ctx, store, dir); err != nil {
		t.Fatal(err)
	}
	var before string
	query := `SELECT json_array(ownership,name,fields,steps,layout,version,created_at,updated_at) FROM sop_flows WHERE id='sop_existing_builtin'`
	if err := d.R.QueryRow(query).Scan(&before); err != nil {
		t.Fatal(err)
	}
	write("改变后的内置")
	if err := importBuiltinsFrom(ctx, store, dir); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := d.R.QueryRow(query).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("builtin overwritten: %s -> %s", before, after)
	}
}

func TestImportBuiltinValidatesDirectoryBeforeWriting(t *testing.T) {
	_, _, d := setupDB(t, New())
	dir := t.TempDir()
	for name, body := range map[string]string{
		"a_valid.json":   `{"id":"sop_should_not_insert","name":"有效","fields":[],"steps":[{"key":"end","name":"结束","kind":"end"}]}`,
		"b_invalid.json": `{"id":`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var logs bytes.Buffer
	err := importBuiltinsFrom(context.Background(), builtinTestStore{d.W}, dir, slog.New(slog.NewTextHandler(&logs, nil)))
	if err == nil || !strings.Contains(err.Error(), "b_invalid.json") {
		t.Fatalf("got %v", err)
	}
	var n int
	if err := d.R.QueryRow(`SELECT count(*) FROM sop_flows WHERE id='sop_should_not_insert'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("partial import: %d %v", n, err)
	}
	if !strings.Contains(logs.String(), "SOP JSON import failed") || !strings.Contains(logs.String(), "created=0") {
		t.Fatalf("missing failure log: %s", logs.String())
	}
}
