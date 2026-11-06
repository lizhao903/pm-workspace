package video

import (
	"encoding/json"
	"testing"
)

// 清单里登记的 SOP 节点都要有声明（TSK-0490）：名字、说明、配置项、输出字段；配置项要有 key 和 label。
// 没声明的节点保存校验不查多余配置、下游引用它的字段只给警告，编辑器和 AI 协助也不知道它输出什么。
func TestSOPNodeSpecsComplete(t *testing.T) {
	var m struct {
		Provides struct {
			SOPNodes []string `json:"sop_nodes"`
		} `json:"provides"`
	}
	if err := json.Unmarshal(manifestJSON, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range m.Provides.SOPNodes {
		sp, ok := sopSpecs[k]
		switch {
		case !ok:
			t.Errorf("节点 %s 没有声明", k)
		case sp.Label == "" || sp.Desc == "":
			t.Errorf("节点 %s 没写名字或说明", k)
		case sp.Params == nil || sp.Outputs == nil:
			t.Errorf("节点 %s 的配置项或输出没声明（没有就写空切片）", k)
		}
		for _, p := range sp.Params {
			if p.Key == "" || p.Label == "" {
				t.Errorf("节点 %s 有配置项没写 key 或 label", k)
			}
		}
		for _, o := range sp.Outputs {
			if o.Path == "" || o.Type == "" || o.Label == "" {
				t.Errorf("节点 %s 有输出字段没写 path、type 或 label", k)
			}
		}
	}
	if len(sopSpecs) != len(m.Provides.SOPNodes) {
		t.Errorf("声明了 %d 个节点，清单里有 %d 个", len(sopSpecs), len(m.Provides.SOPNodes))
	}
}
