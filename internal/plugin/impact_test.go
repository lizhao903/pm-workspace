package plugin_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

func impactManifest(t *testing.T, id string) plugin.Manifest {
	t.Helper()
	m, err := plugin.Parse([]byte(`{"id":"` + id + `","name":"` + id + `","version":"0.1.0","core":">=1.0.0 <2.0.0","provides":{},"permissions":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	return *m
}

// TestConnectorImpacts（CONN-03）：有影响的按登记顺序出来、拿得到实例 id；nil、0 条的不出现；
// 出错、panic、effect 不合法的记为没查完；停用的插件不问。
func TestConnectorImpacts(t *testing.T) {
	ctx := context.Background()
	var gotRef plugin.ConnectorRef
	p := &fakePlugin{m: impactManifest(t, "alpha"), reg: func(r plugin.Registrar) error {
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "msgs", Load: func(_ context.Context, _ plugin.Core, cn plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			gotRef = cn
			return &plugin.ConnectorImpactData{Count: 3, Text: "3 条", Effect: plugin.ImpactKeep}, nil
		}})
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "none", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			return nil, nil
		}})
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "zero", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			return &plugin.ConnectorImpactData{Count: 0, Text: "x", Effect: plugin.ImpactKeep}, nil
		}})
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "err", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			return nil, errors.New("boom")
		}})
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "crash", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			panic("boom")
		}})
		r.ConnectorImpact(plugin.ConnectorImpactDef{Key: "bad_effect", Load: func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
			return &plugin.ConnectorImpactData{Count: 1, Text: "x", Effect: "delete"}, nil
		}})
		return nil
	}}
	r := newRegistry(t, plugin.NewMemStateStore(), p)
	ref := plugin.ConnectorRef{ID: "cn_1", Tool: "slack"}
	if got := r.ConnectorImpacts(ctx, ref); len(got) != 0 {
		t.Fatalf("没启用就有影响：%+v", got)
	}
	installEnable(t, r, "alpha")
	got := r.ConnectorImpacts(ctx, ref)
	var keys []string
	for _, x := range got {
		k := x.Plugin + ":" + x.Key
		if x.Failed {
			k += "!"
		}
		keys = append(keys, k)
	}
	if strings.Join(keys, ",") != "alpha:msgs,alpha:err!,alpha:crash!,alpha:bad_effect!" {
		t.Fatalf("impacts = %v", keys)
	}
	if got[0].Count != 3 || got[0].Text != "3 条" || got[0].Effect != plugin.ImpactKeep || gotRef != ref {
		t.Fatalf("got[0] = %+v, ref = %+v", got[0], gotRef)
	}
	if err := r.Disable(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if got := r.ConnectorImpacts(ctx, ref); len(got) != 0 {
		t.Fatalf("停用后还在问：%+v", got)
	}
}

func TestConnectorImpactChecksDef(t *testing.T) {
	load := func(context.Context, plugin.Core, plugin.ConnectorRef) (*plugin.ConnectorImpactData, error) {
		return nil, nil
	}
	cases := []struct {
		name string
		def  []plugin.ConnectorImpactDef
		want string
	}{
		{"key 不合法", []plugin.ConnectorImpactDef{{Key: "Bad-Key", Load: load}}, "只能是小写字母"},
		{"没有 Load", []plugin.ConnectorImpactDef{{Key: "a"}}, "没有 Load"},
		{"重复", []plugin.ConnectorImpactDef{{Key: "a", Load: load}, {Key: "a", Load: load}}, "连接器影响重复"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePlugin{m: impactManifest(t, "bad"), reg: func(r plugin.Registrar) error {
				for _, d := range tc.def {
					r.ConnectorImpact(d)
				}
				return nil
			}}
			err := plugin.NewRegistry(plugin.NewMemStateStore(), quiet).Add(p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，要包含 %q", err, tc.want)
			}
		})
	}
}
