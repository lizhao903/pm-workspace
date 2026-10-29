package sop

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func TestManifestValid(t *testing.T) {
	m, err := plugin.Parse(manifestJSON)
	if err != nil {
		t.Fatalf("清单不合法：%v", err)
	}
	if m.ID != "sop" || m.TablePrefix != "sop_" || len(m.Permissions) != 0 {
		t.Fatalf("id=%s table_prefix=%s permissions=%v", m.ID, m.TablePrefix, m.Permissions)
	}
	if !reflect.DeepEqual(m.Provides.Modules, []string{"sop"}) {
		t.Fatalf("provides.modules=%v", m.Provides.Modules)
	}
}

func TestMigrationsEmbedded(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 || New().Migrations() == nil {
		t.Fatalf("migrations/ 里有 %d 条迁移，Migrations() 不能是 nil", len(files))
	}
}

// 在真库上装好、启用 SOP 插件，返回注册表和挂了插件路由的 handler
func setup(t *testing.T, p *Plugin) (*plugin.Registry, http.Handler) {
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
	if err := r.Add(p); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	if err := r.Install(ctx, "sop", nil); err != nil {
		t.Fatal(err)
	}
	if err := r.Enable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, rt := range r.Routes(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }) {
		mux.HandleFunc(rt.Pattern, rt.Handler)
	}
	return r, mux
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

func errMsg(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["message"].(string)
	return s
}

func TestDisableHidesRoutes(t *testing.T) {
	r, h := setup(t, New())
	if code, _ := call(t, h, "GET", "/api/sop/flows", ""); code != 200 {
		t.Fatalf("启用时 %d", code)
	}
	if err := r.Disable(context.Background(), "sop"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/api/sop/flows", "/api/sop/node-types"} {
		if code, _ := call(t, h, "GET", p, ""); code != 404 {
			t.Fatalf("停用后 %s 应当 404，实际 %d", p, code)
		}
	}
}

// 原型 SOPS（testdata 里是 JSON.stringify 的结果，函数字段已经丢了）原样存进去、取回来一致
func TestPrototypeFlowsRoundTrip(t *testing.T) {
	_, h := setup(t, New())
	b, err := os.ReadFile(filepath.Join("testdata", "prototype_sops.json"))
	if err != nil {
		t.Fatal(err)
	}
	var sops []map[string]any
	if err := json.Unmarshal(b, &sops); err != nil {
		t.Fatal(err)
	}
	if len(sops) < 3 {
		t.Fatalf("原型流程只有 %d 条", len(sops))
	}
	for _, s := range sops {
		body, _ := json.Marshal(s)
		code, out := call(t, h, "POST", "/api/sop/flows", string(body))
		if code != 201 {
			t.Fatalf("存 %v：%d %s", s["id"], code, errMsg(out))
		}
		code, out = call(t, h, "GET", "/api/sop/flows/"+s["id"].(string), "")
		if code != 200 {
			t.Fatalf("取 %v：%d", s["id"], code)
		}
		got := out["data"].(map[string]any)
		for k, want := range s {
			if !reflect.DeepEqual(got[k], want) {
				t.Errorf("%v 的 %s 取回来不一致\n存：%v\n取：%v", s["id"], k, want, got[k])
			}
		}
		if got["version"] != float64(1) {
			t.Errorf("新建的 version=%v", got["version"])
		}
	}
	code, out := call(t, h, "GET", "/api/sop/flows", "")
	if code != 200 || len(out["data"].([]any)) != len(sops) {
		t.Fatalf("列表 %d %v", code, out["meta"])
	}
	if first := out["data"].([]any)[0].(map[string]any); first["id"] != sops[0]["id"] {
		t.Errorf("列表按新建先后，第一条应当是 %v，实际 %v", sops[0]["id"], first["id"])
	}
	// 同一个 id 再存一次 409
	body, _ := json.Marshal(sops[0])
	if code, _ := call(t, h, "POST", "/api/sop/flows", string(body)); code != 409 {
		t.Errorf("重复 id 应当 409，实际 %d", code)
	}
}

func TestCheckRejects(t *testing.T) {
	_, h := setup(t, New())
	cases := map[string]struct {
		steps string
		want  []string
	}{
		"有环": {
			`[{"key":"a","name":"甲","kind":"auto","after":["c"]},{"key":"b","name":"乙","kind":"auto"},{"key":"c","name":"丙","kind":"auto"}]`,
			[]string{"依赖成环：「甲」 → 「乙」 → 「丙」 → 「甲」"},
		},
		"依赖自己": {
			`[{"key":"a","name":"甲","kind":"auto","after":["a"]}]`,
			[]string{"依赖成环：「甲」 → 「甲」"},
		},
		"引用不存在": {
			`[{"key":"a","name":"甲","kind":"auto","after":[]},{"key":"b","name":"乙","kind":"auto","after":["a","x"]}]`,
			[]string{"「乙」依赖的步骤 x 不存在"},
		},
		"分支 case 不存在": {
			`[{"key":"d","name":"判断","kind":"decide","after":[],"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}]},
			  {"key":"a","name":"甲","kind":"auto","after":["d"],"branch":{"of":"d","case":"maybe"}}]`,
			[]string{"「甲」挂的分支 maybe 在「判断」里不存在"},
		},
		"分支指向非判断": {
			`[{"key":"d","name":"普通","kind":"auto","after":[]},{"key":"a","name":"甲","kind":"auto","branch":{"of":"d","case":"yes"}}]`,
			[]string{"「甲」挂在一个不存在的判断上"},
		},
		"必填项没填": {
			`[{"key":"h","name":"调接口","kind":"http","after":[],"config":{"method":"POST","url":"  "}},
			  {"key":"n","name":"发消息","kind":"notify","config":{"to":"研发群"}}]`,
			[]string{"「调接口」还没填「地址」", "「发消息」还没填「内容」"},
		},
		"key 重复": {
			`[{"key":"a","name":"甲","kind":"auto"},{"key":"a","name":"乙","kind":"auto"}]`,
			[]string{"步骤 key 重复：a（第 1 步和第 2 步）"},
		},
	}
	for name, c := range cases {
		code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"x","steps":`+c.steps+`}`)
		if code != 400 {
			t.Errorf("%s：应当 400，实际 %d", name, code)
			continue
		}
		msg := errMsg(out)
		for _, w := range c.want {
			if !strings.Contains(msg, w) {
				t.Errorf("%s：message 里没有「%s」：%s", name, w, msg)
			}
		}
	}

	// 一次列出全部问题
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":" ","fields":[{"key":"q","label":"","type":"text"}],"steps":[
		{"key":"a","name":"甲","kind":"auto","after":["b"]},
		{"key":"b","name":"乙","kind":"auto","after":["a","ghost"]},
		{"key":"c","name":"丙","kind":"template","branch":{"of":"d","case":"zz"}},
		{"key":"d","name":"丁","kind":"classifier","cases":[{"key":"c1","label":"一"},{"key":"c2","label":"二"}]},
		{"key":"e","name":"戊","kind":"nope"}]}`)
	if code != 400 {
		t.Fatalf("应当 400，实际 %d", code)
	}
	msg := errMsg(out)
	for _, w := range []string{"还没有名称", "第 1 个输入字段没有名称", "依赖成环", "「乙」依赖的步骤 ghost 不存在",
		"「丙」还没填「模板」", "「丙」挂的分支 zz 在「丁」里不存在", "「戊」的类型 nope 不存在"} {
		if !strings.Contains(msg, w) {
			t.Errorf("message 里没有「%s」：%s", w, msg)
		}
	}
	issues := out["error"].(map[string]any)["issues"].([]any)
	if len(issues) != 7 {
		t.Errorf("issues 应当 7 条，实际 %d：%v", len(issues), issues)
	}
}

func TestPatchAndDelete(t *testing.T) {
	p := New()
	running := 0
	p.activeRuns = func(context.Context, string) (int, error) { return running, nil }
	_, h := setup(t, p)
	code, out := call(t, h, "POST", "/api/sop/flows", `{"name":"演练","trigger":"手动","steps":[{"key":"a","name":"甲","kind":"auto","after":[]}],
		"layout":{"__start":{"x":0,"y":0},"a":{"x":200,"y":0}}}`)
	if code != 201 {
		t.Fatalf("新建 %d %s", code, errMsg(out))
	}
	f := out["data"].(map[string]any)
	id := f["id"].(string)
	if !strings.HasPrefix(id, "sop_") || f["layout"] == nil {
		t.Fatalf("id=%s layout=%v", id, f["layout"])
	}

	// 改坏了不存，版本不变
	if code, _ := call(t, h, "PATCH", "/api/sop/flows/"+id, `{"steps":[{"key":"a","name":"甲","kind":"auto","after":["a"]}]}`); code != 400 {
		t.Fatalf("有环应当 400，实际 %d", code)
	}
	code, out = call(t, h, "PATCH", "/api/sop/flows/"+id, `{"version":1,"name":"演练二","layout":null}`)
	if code != 200 {
		t.Fatalf("改名 %d %s", code, errMsg(out))
	}
	f = out["data"].(map[string]any)
	if f["name"] != "演练二" || f["version"] != float64(2) || f["trigger"] != "手动" {
		t.Fatalf("改后 %v", f)
	}
	if _, has := f["layout"]; has {
		t.Errorf("layout 传 null 应当清掉：%v", f["layout"])
	}
	if code, _ := call(t, h, "PATCH", "/api/sop/flows/"+id, `{"version":1,"name":"旧版本"}`); code != 409 {
		t.Errorf("版本对不上应当 409，实际 %d", code)
	}

	running = 2
	code, out = call(t, h, "DELETE", "/api/sop/flows/"+id, "")
	if code != 409 || !strings.Contains(errMsg(out), "2 个进行中的执行") {
		t.Fatalf("有进行中的执行应当 409：%d %s", code, errMsg(out))
	}
	running = 0
	if code, _ := call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 200 {
		t.Fatalf("删除 %d", code)
	}
	if code, _ := call(t, h, "GET", "/api/sop/flows/"+id, ""); code != 404 {
		t.Fatalf("删后应当 404，实际 %d", code)
	}
	if code, _ := call(t, h, "DELETE", "/api/sop/flows/"+id, ""); code != 404 {
		t.Fatalf("再删应当 404，实际 %d", code)
	}
}

func TestNodeTypes(t *testing.T) {
	_, h := setup(t, New())
	code, out := call(t, h, "GET", "/api/sop/node-types", "")
	if code != 200 {
		t.Fatal(code)
	}
	data := out["data"].([]any)
	if len(data) != len(NodeTypes) {
		t.Fatalf("%d 种", len(data))
	}
	for _, x := range data {
		m := x.(map[string]any)
		if _, ok := m["required"].([]any); !ok {
			t.Errorf("%v 的 required 应当是数组", m["kind"])
		}
	}
}

// 后端的节点表要和原型 NODE_TYPES 同步：kind 同序、必填配置项一致
func TestNodeTypesAlignedWithPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "web-next", "src", "nodetypes.tsx"))
	if err != nil {
		t.Skip("没有原型 nodetypes.tsx：", err)
	}
	src := string(b)
	start := strings.Index(src, "export const NODE_TYPES")
	end := strings.Index(src, "export const typeOf")
	if start < 0 || end < start {
		t.Fatal("原型里找不到 NODE_TYPES，本测试已经失效")
	}
	body := src[start:end]
	// 每个节点以 kind: '...' 开头，到下一个 kind 之前都是它的配置
	parts := strings.Split(body, "kind: '")[1:]
	if len(parts) != len(NodeTypes) {
		t.Fatalf("原型 %d 种节点，后端 %d 种", len(parts), len(NodeTypes))
	}
	for i, part := range parts {
		kind := part[:strings.Index(part, "'")]
		if kind != NodeTypes[i].Kind {
			t.Fatalf("第 %d 种：原型 %s，后端 %s", i+1, kind, NodeTypes[i].Kind)
		}
		if !strings.Contains(part, "group: '"+NodeTypes[i].Group+"'") {
			t.Errorf("%s 的分组和原型不一致", kind)
		}
		if strings.Contains(part, "branching: true") != NodeTypes[i].Branching {
			t.Errorf("%s 是否分支和原型不一致", kind)
		}
		var req []string
		for _, f := range strings.Split(part, "{ key: '")[1:] {
			// 一个配置项写在一行里，到下一个配置项或行尾为止
			if strings.Contains(strings.SplitN(f, "\n", 2)[0], "required: true") {
				req = append(req, f[:strings.Index(f, "'")])
			}
		}
		var have []string
		for _, cf := range NodeTypes[i].Required {
			have = append(have, cf.Key)
		}
		if !reflect.DeepEqual(req, have) {
			t.Errorf("%s 的必填项：原型 %v，后端 %v", kind, req, have)
		}
	}
}
