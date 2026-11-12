// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package connector

import (
	"context"
	"testing"
)

// TestPluginDefs：插件的定义排在内核的后面；和内核同 tool 时内核的优先；每次现取，取不到就没有。
func TestPluginDefs(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(Fake()); err != nil {
		t.Fatal(err)
	}
	mine, err := Prepare(Def{Tool: "echo", Label: "插件的", Source: "demo", Auth: []AuthMode{AuthNone},
		Test: func(context.Context, Config) (string, error) { return "", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if mine.Fields == nil || mine.Tools == nil || mine.Source != "demo" {
		t.Fatalf("Prepare 没补默认值：%+v", mine)
	}
	clash := mine
	clash.Tool, clash.Label = FakeTool, "冒名的"
	on := true
	r.SetPluginDefs(func() []Def {
		if !on {
			return nil
		}
		return []Def{clash, mine}
	})
	ds := r.List()
	if len(ds) != 2 || ds[0].Tool != FakeTool || ds[0].Source != "core" || ds[1].Tool != "echo" {
		t.Fatalf("List = %+v", ds)
	}
	if d, ok := r.Get(FakeTool); !ok || d.Source != "core" {
		t.Fatalf("同名时内核的优先：%+v", d)
	}
	if d, ok := r.Get("echo"); !ok || d.Source != "demo" {
		t.Fatalf("Get echo = %+v, %v", d, ok)
	}
	on = false
	if _, ok := r.Get("echo"); ok || len(r.List()) != 1 {
		t.Fatal("插件的定义没了还取得到")
	}
}
