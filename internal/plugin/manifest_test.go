package plugin

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// 样例集和前端 frontend/src/core/plugin/manifest.test.ts 共用。
const examplesDir = "../../docs/plugin-manifest-examples"

type expectedFile struct {
	Env struct {
		APIVersion string   `json:"api_version"`
		Plugins    []string `json:"plugins"`
	} `json:"env"`
	Cases map[string][]string `json:"cases"`
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func issueStrings(err error) []string {
	out := []string{}
	for _, is := range Issues(err) {
		out = append(out, is.String())
	}
	return out
}

func loadEnv(t *testing.T, exp expectedFile) Env {
	t.Helper()
	env := Env{APIVersion: exp.Env.APIVersion}
	for _, f := range exp.Env.Plugins {
		b, err := os.ReadFile(filepath.Join(examplesDir, f))
		if err != nil {
			t.Fatal(err)
		}
		m, err := Parse(b)
		if err != nil {
			t.Fatalf("环境里的 %s 不合法：%v", f, err)
		}
		env.Plugins = append(env.Plugins, m)
	}
	return env
}

func TestExamples(t *testing.T) {
	var exp expectedFile
	readJSON(t, filepath.Join(examplesDir, "expected.json"), &exp)
	env := loadEnv(t, exp)

	// 目录里的样例和 expected.json 一一对应，漏写期望或多写都算失败
	var files []string
	for _, dir := range []string{"valid", "invalid"} {
		ents, err := os.ReadDir(filepath.Join(examplesDir, dir))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range ents {
			if strings.HasSuffix(e.Name(), ".json") {
				files = append(files, dir+"/"+e.Name())
			}
		}
	}
	slices.Sort(files)
	if got := sortedKeys(exp.Cases); !slices.Equal(got, files) {
		t.Fatalf("expected.json 的用例 %v 和样例文件 %v 对不上", got, files)
	}

	valid, invalid := 0, 0
	for _, f := range files {
		want := exp.Cases[f]
		if strings.HasPrefix(f, "valid/") != (len(want) == 0) {
			t.Errorf("%s：valid/ 下的样例期望必须为空，invalid/ 下的必须非空", f)
		}
		if len(want) == 0 {
			valid++
		} else {
			invalid++
		}
		t.Run(f, func(t *testing.T) {
			b, err := os.ReadFile(filepath.Join(examplesDir, f))
			if err != nil {
				t.Fatal(err)
			}
			_, err = Validate(b, env)
			if got := issueStrings(err); !slices.Equal(got, want) {
				t.Errorf("错误不对\n得到：%q\n期望：%q", got, want)
			}
		})
	}
	if valid != 3 || invalid != 5 {
		t.Errorf("样例应为 3 个合法、5 个非法，实际 %d、%d", valid, invalid)
	}
}

// docs/plugin-api.md 第 7 节的两份样例和合法样例集里的副本保持一致。
func TestSpecExamplesInSync(t *testing.T) {
	for _, name := range []string{"projects.json", "im.json"} {
		a, err := os.ReadFile(filepath.Join("../../docs/plugin-api", name))
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(examplesDir, "valid", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("docs/plugin-api/%s 和 docs/plugin-manifest-examples/valid/%s 不一致", name, name)
		}
	}
}

type rangesFile struct {
	Match   [][3]any `json:"match"`
	Invalid []string `json:"invalid"`
}

func TestRanges(t *testing.T) {
	var rf rangesFile
	readJSON(t, filepath.Join(examplesDir, "ranges.json"), &rf)
	for _, c := range rf.Match {
		rng, ver, want := c[0].(string), c[1].(string), c[2].(bool)
		if _, ok := ParseRange(rng); !ok {
			t.Errorf("%q 应当合法", rng)
		}
		if got := Satisfies(ver, rng); got != want {
			t.Errorf("Satisfies(%q, %q) = %v，期望 %v", ver, rng, got, want)
		}
	}
	for _, rng := range rf.Invalid {
		if _, ok := ParseRange(rng); ok {
			t.Errorf("%q 应当不合法", rng)
		}
	}
}

// Schema 和代码里的字段、扩展点、权限、版本格式不能漂移。
func TestSchemaInSync(t *testing.T) {
	var s struct {
		Required   []string                   `json:"required"`
		Properties map[string]json.RawMessage `json:"properties"`
		Defs       map[string]struct {
			Pattern string `json:"pattern"`
		} `json:"$defs"`
	}
	readJSON(t, "../../docs/plugin-manifest.schema.json", &s)

	if got, want := sortedKeys(s.Properties), slices.Sorted(slices.Values(ManifestFields)); !slices.Equal(got, want) {
		t.Errorf("schema 顶层字段 %v，代码 %v", got, want)
	}
	if want := []string{"core", "id", "name", "permissions", "provides", "version"}; !slices.Equal(slices.Sorted(slices.Values(s.Required)), want) {
		t.Errorf("schema 必填字段 %v，期望 %v", s.Required, want)
	}

	var provides struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(s.Properties["provides"], &provides); err != nil {
		t.Fatal(err)
	}
	if got, want := sortedKeys(provides.Properties), slices.Sorted(slices.Values(ExtensionPoints)); !slices.Equal(got, want) {
		t.Errorf("schema 扩展点 %v，代码 %v", got, want)
	}

	var perms struct {
		Items struct {
			AnyOf []struct {
				Enum []string `json:"enum"`
			} `json:"anyOf"`
		} `json:"items"`
	}
	if err := json.Unmarshal(s.Properties["permissions"], &perms); err != nil {
		t.Fatal(err)
	}
	if got := perms.Items.AnyOf[0].Enum; !slices.Equal(got, Permissions) {
		t.Errorf("schema 权限 %v，代码 %v", got, Permissions)
	}

	// schema 的范围正则和 ParseRange 对共用用例的判断一致
	var rf rangesFile
	readJSON(t, filepath.Join(examplesDir, "ranges.json"), &rf)
	re := regexp.MustCompile(s.Defs["range"].Pattern)
	check := func(rng string) {
		_, ok := ParseRange(rng)
		if re.MatchString(rng) != ok {
			t.Errorf("范围 %q：schema 判 %v，ParseRange 判 %v", rng, re.MatchString(rng), ok)
		}
	}
	for _, c := range rf.Match {
		check(c[0].(string))
	}
	for _, rng := range rf.Invalid {
		check(rng)
	}
	if !regexp.MustCompile(s.Defs["version"].Pattern).MatchString(APIVersion) {
		t.Errorf("schema 的版本格式不认 APIVersion %s", APIVersion)
	}
}

// base 故意不带右括号，用例自己补上后面的字段。
const base = `{"id":"alpha","name":"A","version":"1.0.0","core":"^1.0.0","provides":{},"permissions":[]`

func mustParse(t *testing.T, s string) *Manifest {
	t.Helper()
	m, err := Parse([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return m
}

func TestCheckCoreAndCycle(t *testing.T) {
	a := mustParse(t, `{"id":"alpha","name":"A","version":"1.0.0","core":">=2.0.0","depends":{"beta":"^1.0.0"},"provides":{},"permissions":[]}`)
	b := mustParse(t, `{"id":"beta","name":"B","version":"1.0.0","core":"^1.0.0","depends":{"gamma":"^1.0.0"},"provides":{},"permissions":[]}`)
	g := mustParse(t, `{"id":"gamma","name":"G","version":"1.0.0","core":"^1.0.0","depends":{"alpha":"^1.0.0"},"provides":{},"permissions":[]}`)
	got := issueStrings(Check(a, Env{Plugins: []*Manifest{b, g}}))
	want := []string{
		"core 不包含当前插件 API 版本 1.0.0：>=2.0.0",
		"depends 形成循环依赖：alpha -> beta -> gamma -> alpha",
	}
	if !slices.Equal(got, want) {
		t.Errorf("得到 %q，期望 %q", got, want)
	}

	// 弱依赖成环允许，没装也不报
	p := mustParse(t, base+`,"optional_depends":{"beta":"^1.0.0","missing":"^1.0.0"}}`)
	q := mustParse(t, `{"id":"beta","name":"B","version":"1.0.0","core":"^1.0.0","optional_depends":{"alpha":"^1.0.0"},"provides":{},"permissions":[]}`)
	if err := Check(p, Env{Plugins: []*Manifest{q}}); err != nil {
		t.Errorf("弱依赖成环应当允许：%v", err)
	}
}

func TestCheckConnectorConflict(t *testing.T) {
	a := mustParse(t, `{"id":"alpha","name":"A","version":"1.0.0","core":"^1.0.0","provides":{"connectors":["slack"]},"permissions":[]}`)
	b := mustParse(t, `{"id":"beta","name":"B","version":"1.0.0","core":"^1.0.0","provides":{"connectors":["lark","slack"]},"permissions":[]}`)
	got := issueStrings(Check(a, Env{Plugins: []*Manifest{a, b}}))
	if want := []string{"provides.connectors[0] 已被插件 beta 声明：slack"}; !slices.Equal(got, want) {
		t.Errorf("得到 %q，期望 %q", got, want)
	}
}

func TestParseStructure(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`[]`, []string{"清单 必须是 JSON 对象"}},
		{`{"id":`, []string{"清单 不是合法的 JSON：unexpected EOF"}},
		{`{}`, []string{"id 必填", "name 必填", "version 必填", "core 必填", "provides 必填", "permissions 必填"}},
		{`{"id":"tasks","name":"T","version":"1.0.0","core":"^1.0.0","provides":{},"permissions":[]}`, []string{"id 是内核保留字：tasks"}},
		{`{"id":"Bad-Id","name":" ","version":"1.0.0","core":"^1.0.0","provides":{"agent_tools":["x"]},"permissions":[]}`,
			[]string{"id 不合法：必须匹配 ^[a-z][a-z0-9_]{1,23}$：Bad-Id", "name 不能为空"}},
		{base + `,"depends":{"alpha":"^1.0.0","Beta":"^1.0.0","gamma":1},"optional_depends":{"gamma":"^1.0.0"}}`,
			[]string{"depends.Beta 不是合法的插件 id", "depends.alpha 不能依赖自己", "depends.gamma 必须是字符串"}},
		{base + `,"depends":{"beta":"^1.0.0"},"optional_depends":{"beta":"^1.0.0"}}`,
			[]string{"optional_depends.beta 已在 depends 里声明"}},
		{`{"id":"alpha","name":"A","version":"1.0.0","core":"^1.0.0","provides":{"object_types":["beta"],"skills":["plan"],"commands":["alpha.go","beta.go"],"modules":["a","a",3],"sop_nodes":"x"},"permissions":[]}`,
			[]string{"provides.modules[2] 必须是字符串", "provides.object_types[0] 必须等于 alpha 或以 alpha_ 开头：beta", "provides.skills[0] 必须以 sk_ 开头：plan", "provides.sop_nodes 必须是字符串数组", "provides.commands[1] 必须是 alpha.<动作>：beta.go"}},
		{base + `,"provides":{"modules":["a","a"]}}`, []string{"provides.modules[1] 重复：a"}},
		{base + `,"emits":["alpha.done","nodot"],"subscribes":["alpha.done","object.created"]}`, []string{"emits[1] 不是合法的事件类型：nodot"}},
		{base + `,"adopts":{"object_types":["project"],"routes":["/x"],"extra":[]}}`, []string{"adopts.extra 是未知字段", "adopts.routes[0] 必须以 /api/ 开头：/x"}},
		{base + `,"permissions":["secrets:im","secrets:im"]}`, []string{"permissions[1] 重复：secrets:im"}},
		{base + `,"migrations":"../x","table_prefix":"beta_"}`, []string{"migrations 必须是插件目录内的相对路径：../x", "table_prefix 必须是 alpha_：beta_"}},
	}
	for _, c := range cases {
		// base 拼出来的用例会重复 provides、permissions 键，后出现的覆盖前面的，和前端 JSON.parse 一致
		_, err := Parse([]byte(c.in))
		if got := issueStrings(err); !slices.Equal(got, c.want) {
			t.Errorf("%s\n得到 %q\n期望 %q", c.in, got, c.want)
		}
	}
}

func TestParseValues(t *testing.T) {
	m := mustParse(t, base+`}`)
	if m.Permissions == nil || len(m.Permissions) != 0 {
		t.Errorf("permissions 应当是空切片，得到 %#v", m.Permissions)
	}
	b, err := os.ReadFile(filepath.Join(examplesDir, "valid", "im.json"))
	if err != nil {
		t.Fatal(err)
	}
	im := mustParse(t, string(b))
	if im.OptionalDepends["projects"] != ">=0.1.0 <1.0.0" || im.TablePrefix != "im_" || len(im.Provides.Connectors) != 4 {
		t.Errorf("im.json 解析结果不对：%+v", im)
	}
}
