// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
)

func TestSQLIdents(t *testing.T) {
	got := sqlIdents(`SELECT "a b", x1 FROM [t] WHERE c = 'objects' AND n > 1e5`)
	want := []string{"SELECT", "a b", "x1", "FROM", "t", "WHERE", "c", "AND", "n"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %q", got)
	}
}

// Store 只许碰本插件前缀的表：内核表、别的插件的表、系统表、多条语句、改表结构都拒绝
func TestCheckStoreSQL(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(ctx, d); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`CREATE TABLE demo_items (id TEXT)`, `CREATE TABLE other_items (id TEXT)`} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	ok := []string{
		`SELECT id FROM demo_items WHERE id = ?`,
		`INSERT INTO demo_items (id) VALUES ('objects')`, // 字符串里的表名不算
		`UPDATE "demo_items" SET id = ?;`,
		`SELECT COALESCE(MAX(id), 0) + 1 FROM demo_items`,
	}
	for _, q := range ok {
		if err := checkStoreSQL(ctx, d, "demo_", q); err != nil {
			t.Errorf("%s 应该放行：%v", q, err)
		}
	}
	bad := []string{
		`SELECT * FROM objects`,
		`SELECT d.id FROM demo_items d JOIN stakeholders s ON s.id = d.id`,
		`SELECT * FROM demo_items, "objects"`,
		`DELETE FROM other_items`,
		`SELECT name FROM sqlite_master`,
		`SELECT * FROM pragma_table_info('objects')`,
		`PRAGMA foreign_keys = OFF`,
		`DROP TABLE demo_items`,
		`ATTACH DATABASE 'x.db' AS x`,
		`SELECT 1 FROM demo_items; DELETE FROM objects`,
	}
	for _, q := range bad {
		if err := checkStoreSQL(ctx, d, "demo_", q); err == nil {
			t.Errorf("%s 应该被拒", q)
		}
	}
	if err := checkStoreSQL(ctx, d, "", `SELECT 1`); err == nil {
		t.Error("没有前缀的插件不能用 Store")
	}
}
