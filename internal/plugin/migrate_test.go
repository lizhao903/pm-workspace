package plugin_test

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugin/plugintest"
)

// migPlugin 是带迁移目录的 fakePlugin，测静态检查。
type migPlugin struct {
	*fakePlugin
	migs fs.FS
}

func (p migPlugin) Migrations() fs.FS { return p.migs }

func migratedDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "pm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := db.Migrate(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	return d
}

// sqlRegistry 起一个状态和迁移记录都在库里的注册表，等于一次进程启动。
func sqlRegistry(t *testing.T, d *db.DB, ps ...plugin.Plugin) (*plugin.Registry, error) {
	t.Helper()
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), quiet)
	r.Migrations = plugin.NewSQLMigrationStore(d)
	for _, p := range ps {
		if err := r.Add(p); err != nil {
			return nil, err
		}
	}
	if err := r.Start(context.Background()); err != nil {
		return nil, err
	}
	t.Cleanup(r.Close)
	return r, nil
}

func columns(t *testing.T, d *db.DB, table string) []string {
	t.Helper()
	rows, err := d.R.Query(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

// TestPluginMigrationsApplyOnInstall：示例插件的迁移在自己的目录、自己的编号下应用，
// 记录进 plugins_migrations，不进内核的 schema_migrations。
func TestPluginMigrationsApplyOnInstall(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	var kernelBefore int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&kernelBefore); err != nil {
		t.Fatal(err)
	}

	r, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	steps, err := r.MigrationSteps(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].Applied != nil || steps[1].Applied != nil {
		t.Fatalf("安装前应有两条待应用迁移：%+v", steps)
	}
	installEnable(t, r, "demo")

	if got := strings.Join(columns(t, d, "demo_items"), ","); got != "id,object_id,title,created_at,note" {
		t.Fatalf("demo_items 的列 = %s", got)
	}
	steps, err = r.MigrationSteps(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	wantFiles := []string{"0001_items.sql", "0002_item_note.sql"}
	for i, st := range steps {
		if st.File != wantFiles[i] || st.Applied == nil || st.Plugin != "demo" ||
			len(st.Checksum) != 64 || st.Applied.Checksum != st.Checksum || st.Applied.PluginVersion != "0.1.0" {
			t.Fatalf("第 %d 条迁移不对：%+v %+v", i, st, st.Applied)
		}
	}
	all, err := r.MigrationSteps(ctx, "")
	if err != nil || len(all) != 2 {
		t.Fatalf("全部插件迁移 = %+v, %v", all, err)
	}

	var kernelAfter, leaked int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&kernelAfter); err != nil {
		t.Fatal(err)
	}
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version LIKE '%item%'`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if kernelAfter != kernelBefore || leaked != 0 {
		t.Fatalf("插件迁移写进了内核的 schema_migrations：%d -> %d", kernelBefore, kernelAfter)
	}

	// 重启：已应用的跳过，插件照常起来
	r.Close()
	r2, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour))
	if err != nil {
		t.Fatalf("重启失败：%v", err)
	}
	if info, _ := r2.Get("demo"); !info.Running {
		t.Fatal("重启后插件没起来")
	}
}

// TestModifiedPluginMigrationRejectsStart：已应用的插件迁移被改过，启动报错并点出插件和文件。
func TestModifiedPluginMigrationRejectsStart(t *testing.T) {
	d := migratedDB(t)
	r, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	r.Close()

	sub := demoFS(t)
	orig := mustRead(t, sub, "0002_item_note.sql")
	tampered := fstest.MapFS{
		"0001_items.sql":     &fstest.MapFile{Data: mustRead(t, sub, "0001_items.sql")},
		"0002_item_note.sql": &fstest.MapFile{Data: append(orig, []byte("-- 改一个注释也算改\n")...)},
	}
	_, err = sqlRegistry(t, d, plugintest.NewDemo(time.Hour).WithMigrations(tampered))
	if err == nil {
		t.Fatal("改过的插件迁移没拦住启动")
	}
	for _, want := range []string{"插件 demo", "0002_item_note.sql", "应用后被改过"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("报错里没有 %q：%v", want, err)
		}
	}
}

// TestPendingPluginMigrationKeepsPluginStopped：换了带新迁移的二进制，插件先不起，等升级流程跑迁移。
func TestPendingPluginMigrationKeepsPluginStopped(t *testing.T) {
	ctx := context.Background()
	d := migratedDB(t)
	first := fstest.MapFS{"0001_items.sql": &fstest.MapFile{Data: mustRead(t, demoFS(t), "0001_items.sql")}}
	r, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour).WithMigrations(first))
	if err != nil {
		t.Fatal(err)
	}
	installEnable(t, r, "demo")
	r.Close()

	r2, err := sqlRegistry(t, d, plugintest.NewDemo(time.Hour))
	if err != nil {
		t.Fatalf("有待应用迁移不该拦住整个启动：%v", err)
	}
	if info, _ := r2.Get("demo"); info.Running {
		t.Fatal("有待应用的迁移时插件不该起来")
	}
	steps, err := r2.MigrationSteps(ctx, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[0].Applied == nil || steps[1].Applied != nil {
		t.Fatalf("应是一条已应用、一条待应用：%+v", steps)
	}
	if _, err := r2.MigrationSteps(ctx, "nope"); err == nil {
		t.Fatal("不存在的插件应报错")
	}
}

// TestPluginMigrationStaticCheck：只许建本插件前缀的表和索引、给本插件的表加列。
func TestPluginMigrationStaticCheck(t *testing.T) {
	cases := []struct {
		name, sql, wantErr string
	}{
		{"建表加索引加列", "CREATE TABLE IF NOT EXISTS mig_a (id TEXT PRIMARY KEY, note TEXT DEFAULT 'a;b');\n" +
			"CREATE UNIQUE INDEX mig_a_note ON mig_a(note);\n-- 注释里的 DROP TABLE objects; 不算\nALTER TABLE \"mig_a\" ADD COLUMN x TEXT;", ""},
		{"改内核表", "ALTER TABLE objects ADD COLUMN x TEXT;", "objects 不是本插件前缀"},
		{"删内核表", "DROP TABLE objects;", "第 1 条语句不允许"},
		{"写内核表", "CREATE TABLE mig_a (id TEXT);\nINSERT INTO object_types (id) VALUES ('x');", "第 2 条语句不允许"},
		{"别的前缀", "CREATE TABLE other_a (id TEXT);", "other_a 不是本插件前缀"},
		{"索引名没前缀", "CREATE INDEX idx_a ON mig_a(id);", "idx_a 不是本插件前缀"},
		{"索引建在内核表上", "CREATE INDEX mig_idx ON objects(id);", "objects 不是本插件前缀"},
		{"改列名", "ALTER TABLE mig_a RENAME TO mig_b;", "第 1 条语句不允许"},
		{"PRAGMA", "PRAGMA foreign_keys = OFF;", "第 1 条语句不允许"},
		{"建表选出", "CREATE TABLE mig_a AS SELECT * FROM objects;", "第 1 条语句不允许"},
		{"空文件", "-- 什么都没有\n", "没有语句"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := migPlugin{
				fakePlugin: &fakePlugin{m: manifest(t, "mig", `,"migrations":"migrations","table_prefix":"mig_"`)},
				migs:       fstest.MapFS{"0001_a.sql": &fstest.MapFile{Data: []byte(c.sql)}},
			}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("合规的迁移被拒：%v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) || !strings.Contains(err.Error(), "0001_a.sql") {
				t.Fatalf("err = %v，要含 %q 和文件名", err, c.wantErr)
			}
		})
	}
}

func TestPluginMigrationDirRules(t *testing.T) {
	ok := []byte("CREATE TABLE mig_a (id TEXT);")
	cases := []struct {
		name, extra string
		fs          fstest.MapFS
		wantErr     string
	}{
		{"没写 table_prefix", "", fstest.MapFS{"0001_a.sql": {Data: ok}}, "table_prefix"},
		{"文件名不合规", `,"migrations":"m","table_prefix":"mig_"`, fstest.MapFS{"1_a.sql": {Data: ok}}, "1_a.sql"},
		{"编号重复", `,"migrations":"m","table_prefix":"mig_"`,
			fstest.MapFS{"0001_a.sql": {Data: ok}, "0001_b.sql": {Data: ok}}, "编号重复"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := migPlugin{fakePlugin: &fakePlugin{m: manifest(t, "mig", c.extra)}, migs: c.fs}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("err = %v，要含 %q", err, c.wantErr)
			}
		})
	}
}

// 内存的迁移记录被改写时一样拦住启动，不依赖 SQL。
func TestMemMigrationStoreTamper(t *testing.T) {
	store := plugin.NewMemStateStore()
	migs := plugin.NewMemMigrationStore()
	r := newRegistryM(t, store, migs, plugintest.NewDemo(time.Hour))
	installEnable(t, r, "demo")
	r.Close()
	migs.Tamper("demo", "0001_items.sql", "deadbeef")

	r2 := plugin.NewRegistry(store, quiet)
	r2.Migrations = migs
	if err := r2.Add(plugintest.NewDemo(time.Hour)); err != nil {
		t.Fatal(err)
	}
	err := r2.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "0001_items.sql") || !strings.Contains(err.Error(), "deadbeef") {
		t.Fatalf("err = %v", err)
	}
}

func demoFS(t *testing.T) fs.FS {
	t.Helper()
	return plugintest.NewDemo(time.Hour).Migrations()
}

func mustRead(t *testing.T, fsys fs.FS, name string) []byte {
	t.Helper()
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
