package projects

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "projects" || m.TablePrefix != "projects_" {
		t.Fatalf("id=%s table_prefix=%s", m.ID, m.TablePrefix)
	}
}

// 迁移目录里有了 .sql 文件，Migrations 就不能再返回 nil，否则迁移永远不会被应用
func TestMigrationsEmbedded(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) > 0 && New().Migrations() == nil {
		t.Fatalf("migrations/ 里有 %d 条迁移，但 Migrations() 返回 nil", len(files))
	}
	if _, err := os.Stat("migrations"); err != nil {
		t.Fatalf("迁移目录要在：%v", err)
	}
}

func TestLifecycle(t *testing.T) {
	ctx := context.Background()
	r := plugin.NewRegistry(plugin.NewMemStateStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := r.Add(New()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err := r.Install(ctx, "projects", []string{"process:spawn"}); err != nil {
		t.Fatalf("安装：%v", err)
	}
	if err := r.Enable(ctx, "projects"); err != nil {
		t.Fatalf("启用：%v", err)
	}
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatalf("停用：%v", err)
	}
	if _, err := r.Uninstall(ctx, "projects", plugin.UninstallOptions{}); err != nil {
		t.Fatalf("卸载：%v", err)
	}
}

// 在真库上装好、启用项目插件，返回挂了插件路由的 handler 和库
func setup(t *testing.T) (*plugin.Registry, http.Handler, *db.DB) {
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
	r := plugin.NewRegistry(plugin.NewSQLStateStore(d), slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Migrations = plugin.NewSQLMigrationStore(d)
	// 原型崩溃记运行异常（INC-01a）
	r.SetIncidents(incident.New(d, slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err := r.Add(New()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "projects", []string{"process:spawn"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_p1', 'project', 'PRJ-T1', '项目一', '` + now + `', '` + now + `')`,
		`INSERT INTO objects (id, type_id, ref, title, created_at, updated_at) VALUES ('obj_t1', 'task', 'TSK-T1', '任务', '` + now + `', '` + now + `')`,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_a', '甲', '` + now + `', '` + now + `')`,
		`INSERT INTO stakeholders (id, name, created_at, updated_at) VALUES ('stk_b', '乙', '` + now + `', '` + now + `')`,
		`INSERT INTO stakeholders (id, name, archived_at, created_at, updated_at) VALUES ('stk_x', '丙', '` + now + `', '` + now + `', '` + now + `')`,
	} {
		if _, err := d.W.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return r, mux, d
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestStakeholdersAPI(t *testing.T) {
	r, h, d := setup(t)
	base := "/api/projects/obj_p1/stakeholders"

	if code, out := call(t, h, "GET", base, ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("空列表：%d %v", code, out)
	}
	if code, out := call(t, h, "POST", base, `{"stakeholder_id":"stk_a","role":"decider","focus":" 验收 "}`); code != 201 ||
		out["data"].(map[string]any)["focus"] != "验收" || out["data"].(map[string]any)["sort_order"] != 1.0 {
		t.Fatalf("新增：%d %v", code, out)
	}
	if code, _ := call(t, h, "POST", base, `{"stakeholder_id":"stk_b","role":"member"}`); code != 201 {
		t.Fatalf("新增第二个：%d", code)
	}
	// 角色只能五种之一
	for _, role := range []string{"", "boss", "Owner"} {
		if code, out := call(t, h, "POST", base, `{"stakeholder_id":"stk_b","role":"`+role+`"}`); code != 400 {
			t.Fatalf("角色 %q 应 400：%d %v", role, code, out)
		}
	}
	if code, _ := call(t, h, "PATCH", base+"/stk_a", `{"role":"chief"}`); code != 400 {
		t.Fatalf("改成不存在的角色应 400：%d", code)
	}
	// 同一个人不能加两次；没有这个人、已归档的人 400
	if code, _ := call(t, h, "POST", base, `{"stakeholder_id":"stk_a","role":"owner"}`); code != 409 {
		t.Fatalf("重复加应 409：%d", code)
	}
	if code, _ := call(t, h, "POST", base, `{"stakeholder_id":"stk_none","role":"owner"}`); code != 400 {
		t.Fatalf("没有这个人应 400：%d", code)
	}
	if code, _ := call(t, h, "POST", base, `{"stakeholder_id":"stk_x","role":"owner"}`); code != 400 {
		t.Fatalf("已归档应 400：%d", code)
	}
	// 不是项目、不存在的项目 404
	if code, _ := call(t, h, "GET", "/api/projects/obj_t1/stakeholders", ""); code != 404 {
		t.Fatalf("任务不是项目应 404：%d", code)
	}
	if code, _ := call(t, h, "POST", "/api/projects/obj_none/stakeholders", `{"stakeholder_id":"stk_a","role":"owner"}`); code != 404 {
		t.Fatalf("不存在的项目应 404：%d", code)
	}

	if code, out := call(t, h, "PATCH", base+"/stk_a", `{"role":"owner","focus":"交付节奏"}`); code != 200 ||
		out["data"].(map[string]any)["role"] != "owner" || out["data"].(map[string]any)["focus"] != "交付节奏" {
		t.Fatalf("修改：%d %v", code, out)
	}
	if code, out := call(t, h, "PATCH", base+"/stk_a", `{"sort_order":9}`); code != 200 || out["data"].(map[string]any)["role"] != "owner" {
		t.Fatalf("只改顺序不动角色：%d %v", code, out)
	}
	_, out := call(t, h, "GET", base, "")
	if list := out["data"].([]any); len(list) != 2 || list[0].(map[string]any)["stakeholder_id"] != "stk_b" {
		t.Fatalf("列表按 sort_order：%v", out)
	}
	if code, _ := call(t, h, "DELETE", base+"/stk_b", ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	if code, _ := call(t, h, "DELETE", base+"/stk_b", ""); code != 404 {
		t.Fatalf("删两次应 404：%d", code)
	}
	if code, _ := call(t, h, "PATCH", base+"/stk_b", `{"role":"owner"}`); code != 404 {
		t.Fatalf("改不在项目里的人应 404：%d", code)
	}

	// 删联系人连带删关联行
	if _, err := d.W.Exec(`DELETE FROM stakeholders WHERE id = 'stk_a'`); err != nil {
		t.Fatal(err)
	}
	if _, out := call(t, h, "GET", base, ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("删了联系人关联行还在：%v", out)
	}

	// 停用后 404，重新启用恢复
	ctx := context.Background()
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, h, "GET", base, ""); code != 404 {
		t.Fatalf("停用后应 404：%d", code)
	}
	if err := r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, h, "GET", base, ""); code != 200 {
		t.Fatalf("重新启用后应 200：%d", code)
	}
}

// TSK-0718：角色按字典 project_role 校验——新加的角色能用；停用的不能新选，原来就是它的照常改别的字段；
// 字典里删掉的旧值原样留着；被用着的角色在字典里删不掉（引用数统计到插件表）。
func TestStakeholderRolesFromDict(t *testing.T) {
	_, h, d := setup(t)
	base := "/api/projects/obj_p1/stakeholders"
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.W.Exec(`INSERT INTO dict_items (id,dict_id,key,label,sort_order,meta,created_at,updated_at)
		VALUES ('dit_role_sponsor','project_role','sponsor','出资人',60,'{}',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "POST", base, `{"stakeholder_id":"stk_a","role":"sponsor"}`); code != 201 {
		t.Fatalf("字典里新加的角色应能用：%d %v", code, out)
	}
	if _, err := d.W.Exec(`UPDATE dict_items SET archived_at = ? WHERE id = 'dit_role_sponsor'`, now); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "POST", base, `{"stakeholder_id":"stk_b","role":"sponsor"}`); code != 400 {
		t.Fatalf("停用的角色不能新选：%d %v", code, out)
	}
	if code, out := call(t, h, "PATCH", base+"/stk_a", `{"role":"sponsor","focus":"预算"}`); code != 200 || out["data"].(map[string]any)["role"] != "sponsor" {
		t.Fatalf("原来就是停用角色的照常改关注点：%d %v", code, out)
	}
	var n int
	if err := d.R.QueryRow(`SELECT COUNT(*) FROM projects_stakeholders WHERE ` + roleExpr + ` = 'sponsor' AND role = 'member'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("引用数：%d %v", n, err)
	}
	// 内置五个照旧
	if code, out := call(t, h, "POST", base, `{"stakeholder_id":"stk_b","role":"informed"}`); code != 201 {
		t.Fatalf("内置角色：%d %v", code, out)
	}
	// 字典里删掉的旧值（直接删库模拟）：不改角色时放行，改成它 400
	if _, err := d.W.Exec(`DELETE FROM dict_items WHERE id = 'dit_role_sponsor'`); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, h, "PATCH", base+"/stk_a", `{"role":"sponsor","focus":"预算二"}`); code != 200 {
		t.Fatalf("删掉的旧值原样留着：%d %v", code, out)
	}
	if code, _ := call(t, h, "PATCH", base+"/stk_b", `{"role":"sponsor"}`); code != 400 {
		t.Fatalf("改成字典里没有的角色应 400：%d", code)
	}
}
