// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package idgen

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestRegistryUnique(t *testing.T) {
	if err := Check(Registry, Aliases); err != nil {
		t.Fatal(err)
	}
}

func TestCheckRejectsDuplicate(t *testing.T) {
	cases := map[string]struct {
		reg     []Entry
		aliases []Alias
	}{
		"同一前缀登记两次": {reg: append(append([]Entry{}, Registry...), Entry{Prefix: "obj", Entity: "other"})},
		"同一实体登记两次": {reg: append(append([]Entry{}, Registry...), Entry{Prefix: "zz", Entity: "object"})},
		"占用原型保留前缀": {reg: append(append([]Entry{}, Registry...), Entry{Prefix: "tk", Entity: "other"}), aliases: Aliases},
		"别名指向未登记":  {reg: Registry, aliases: []Alias{{Proto: "x", From: "xx", Prefix: "nope"}}},
		"前缀格式不对":   {reg: []Entry{{Prefix: "Obj", Entity: "object"}}},
	}
	for name, c := range cases {
		if Check(c.reg, c.aliases) == nil {
			t.Errorf("%s：应当报错", name)
		}
	}
}

// 仓库里每处 idgen.Prefixed 调用用到的前缀都必须登记过
func TestPrefixedCallsAreRegistered(t *testing.T) {
	root := filepath.Join("..", "..")
	re := regexp.MustCompile(`idgen\.Prefixed\("([^"]*)"\)`)
	seen := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "web", "web-next", "frontend", "data":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range re.FindAllStringSubmatch(string(b), -1) {
			seen++
			if _, ok := Lookup(m[1]); !ok {
				t.Errorf("%s 用了未登记的前缀 %q，先在 internal/idgen/prefixes.go 登记", p, m[1])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("一个 idgen.Prefixed 调用都没扫到，扫描路径不对")
	}
}

// 与原型 web-next/src/ids.ts 的 ID_PREFIX 对齐：每个原型前缀要么同名登记，要么在 Aliases 里写明
func TestAlignedWithPrototype(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "web-next", "src", "ids.ts"))
	if err != nil {
		t.Skip("没有原型 ids.ts：", err)
	}
	src := string(b)
	start := strings.Index(src, "export const ID_PREFIX = {")
	end := strings.Index(src, "} as const")
	if start < 0 || end < start {
		t.Fatal("ids.ts 里找不到 ID_PREFIX 定义")
	}
	re := regexp.MustCompile(`(?m)^\s*(\w+):\s*'([a-z]+)',`)
	proto := map[string]string{}
	for _, m := range re.FindAllStringSubmatch(src[start:end], -1) {
		proto[m[1]] = m[2]
	}
	if len(proto) == 0 {
		t.Fatal("ID_PREFIX 一项都没解析出来")
	}

	for k, p := range proto {
		ok := false
		for _, e := range Registry {
			if e.Proto == k && e.Prefix == p {
				ok = true
			}
		}
		for _, a := range Aliases {
			if a.Proto == k && a.From == p {
				ok = true
			}
		}
		if !ok {
			t.Errorf("原型 %s: '%s' 没有对应登记", k, p)
		}
	}
	for _, e := range Registry {
		if e.Proto != "" && proto[e.Proto] == "" {
			t.Errorf("登记 %s 写的原型 key %s 在 ids.ts 里不存在", e.Prefix, e.Proto)
		}
	}
	for _, a := range Aliases {
		if proto[a.Proto] != a.From {
			t.Errorf("别名 %s 和 ids.ts 不一致：原型是 %q", a.Proto, proto[a.Proto])
		}
	}
}
