// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// ai、extract、classifier、iterate 选了 Agent（config.agent）就把它带给 Complete；
// 没选时不带，交给「其他后台调用」的场景默认。编排助手按 sop_assist 场景调。
func TestAINodesPassAgent(t *testing.T) {
	fa := &fakeAgent{complete: func(req plugin.CompleteRequest) (string, error) {
		return `{"a":"1"}`, nil
	}}
	in := Json{"text": "hello", "items": []any{"x"}}
	defs := []stepDef{
		{Kind: "ai", Name: "a", Config: map[string]string{"agent": "ag_1", "provider": "apv_x", "model": "m"}},
		{Kind: "extract", Name: "e", Config: map[string]string{"agent": "ag_1", "fields": "a"}},
		{Kind: "classifier", Name: "c", Cases: []Case{{Key: "k", Label: "一类"}}, Config: map[string]string{"agent": "ag_1"}},
		{Kind: "iterate", Name: "i", Config: map[string]string{"agent": "ag_1", "list": "items"}},
		{Kind: "classifier", Name: "c2", Cases: []Case{{Key: "k", Label: "一类"}}},
	}
	ctx := context.Background()
	for _, d := range defs {
		var r nodeResult
		switch d.Kind {
		case "ai":
			r = runAI(ctx, fa, d, in)
		case "extract":
			r = runExtract(ctx, fa, d, in)
		case "classifier":
			r = runClassifier(ctx, fa, d, in)
		case "iterate":
			r = runIterate(ctx, fa, d, in)
		}
		if r.err != "" {
			t.Fatalf("%s：%s", d.Name, r.err)
		}
	}
	if len(fa.reqs) != 5 {
		t.Fatalf("调了 %d 次", len(fa.reqs))
	}
	for i, r := range fa.reqs[:4] {
		if r.Agent != "ag_1" {
			t.Fatalf("第 %d 个节点没带 Agent：%+v", i+1, r)
		}
	}
	if fa.reqs[4].Agent != "" || fa.reqs[4].Scenario != "" {
		t.Fatalf("没选 Agent 的不该带：%+v", fa.reqs[4])
	}
}
