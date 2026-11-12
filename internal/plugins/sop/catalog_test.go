// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 流程目录（TSK-0480）：Agent 的 list_sops / get_sop / create_sop / update_sop 经注册表到这里，新建、修改和 POST / PATCH 同一套。
func TestCatalogViaRegistry(t *testing.T) {
	ctx := context.Background()
	reg, h := setup(t, New())
	id := newFlow(t, h, `{"name":"周会","desc":"每周例会","steps":[{"key":"check","name":"检查","kind":"review"}]}`)

	list, err := reg.ListSOPs(ctx)
	if err != nil || len(list) != 1 || list[0].ID != id || list[0].Name != "周会" || list[0].Steps != 1 || list[0].Version != 1 {
		t.Fatalf("列表：%+v %v", list, err)
	}
	doc, err := reg.GetSOP(ctx, "周会")
	if err != nil || doc.ID != id || !strings.Contains(string(doc.StepDefs), `"review"`) {
		t.Fatalf("按名称取：%+v %v", doc, err)
	}
	if _, err := reg.GetSOP(ctx, "sopr_123456"); !errors.Is(err, plugin.ErrSOPNotFound) || err.Error() != "流程 sopr_123456 不存在：流程不存在" {
		t.Fatalf("不存在：%v", err)
	}

	raw := func(m map[string]any) map[string]json.RawMessage {
		out := map[string]json.RawMessage{}
		for k, v := range m {
			b, _ := json.Marshal(v)
			out[k] = b
		}
		return out
	}
	steps := []any{
		map[string]any{"key": "in_conv", "name": "是不是这个群", "kind": "decide", "rule": "conversation_id 等于 cv_1"},
		map[string]any{"key": "not_me", "name": "没有 @我", "kind": "decide", "rule": "relevance 不等于 me", "branch": map[string]any{"of": "in_conv", "case": "yes"}},
		map[string]any{"key": "end", "name": "结束", "kind": "end", "branch": map[string]any{"of": "not_me", "case": "yes"}},
	}
	// 新建：body 里的 id 不认，一律生成
	created, err := reg.SaveSOP(ctx, plugin.SOPSave{Body: raw(map[string]any{"id": "sop_hack", "name": "群消息忽略", "trigger": "im", "steps": steps})})
	if err != nil || created.ID == "sop_hack" || !strings.HasPrefix(created.ID, "sop_") || created.Trigger != "im" || created.Steps != 3 || created.Version != 1 {
		t.Fatalf("新建：%+v %v", created, err)
	}
	if code, out := call(t, h, "GET", "/api/sop/flows/"+created.ID, ""); code != 200 || out["data"].(map[string]any)["name"] != "群消息忽略" {
		t.Fatalf("接口读不到新建的流程：%d %v", code, out)
	}
	// 分支节点没写 cases 补默认出口，分支下的步骤没写 after 补成依赖分支步骤
	if s := string(created.StepDefs); !strings.Contains(s, `"cases":[{"key":"yes","label":"是"},{"key":"no","label":"否"}]`) || !strings.Contains(s, `"after":["in_conv"]`) {
		t.Fatalf("没补默认值：%s", s)
	}

	// 修改：只改给了的字段，版本加一；版本不对是冲突
	got, err := reg.SaveSOP(ctx, plugin.SOPSave{ID: "群消息忽略", Body: raw(map[string]any{"desc": "只看 #ai-octok-platform", "version": 1})})
	if err != nil || got.ID != created.ID || got.Desc != "只看 #ai-octok-platform" || got.Steps != 3 || got.Version != 2 {
		t.Fatalf("修改：%+v %v", got, err)
	}
	if _, err := reg.SaveSOP(ctx, plugin.SOPSave{ID: created.ID, Body: raw(map[string]any{"desc": "x", "version": 1})}); err == nil || !strings.Contains(err.Error(), "第 2 版") {
		t.Fatalf("版本冲突：%v", err)
	}

	// 保存校验没过：带上第几步
	_, err = reg.SaveSOP(ctx, plugin.SOPSave{Body: raw(map[string]any{"name": "坏的", "steps": []any{map[string]any{"key": "a", "name": "甲", "kind": "nope"}}})})
	if err == nil || !strings.HasPrefix(err.Error(), "流程没存上：第 1 步：") {
		t.Fatalf("校验：%v", err)
	}
	if _, err := reg.SaveSOP(ctx, plugin.SOPSave{ID: "sop_none", Body: raw(map[string]any{"desc": "x"})}); !errors.Is(err, plugin.ErrSOPNotFound) {
		t.Fatalf("改不存在的：%v", err)
	}

	kinds, err := reg.SOPNodeKinds(ctx)
	if err != nil || len(kinds) < len(NodeTypes) || kinds[0].Kind != "auto" {
		t.Fatalf("节点：%+v %v", kinds, err)
	}
	for _, k := range kinds {
		if k.Kind == "decide" && (!k.Branching || strings.Join(k.Cases, "/") != "yes/no" || k.Label != "条件分支") {
			t.Fatalf("条件分支：%+v", k)
		}
	}

	if err := reg.Disable(ctx, "sop"); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.ListSOPs(ctx); !errors.Is(err, plugin.ErrNoSOPStarter) {
		t.Fatalf("停用后：%v", err)
	}
}
