package runner

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

// eventConstRe 从源码里抠出所有 EventXxx = "yyy" 常量。
var eventConstRe = regexp.MustCompile(`Event\w*\s*=\s*"([a-z_]+)"`)

// TestEveryEventTypeMarshals 守「加了事件类型就必须能序列化」。
//
// 这条是补的，因为已经踩过一次：加了 artifact 事件、忘了在 MarshalJSON 里加分支，
// 结果 MarshalJSON 返回 error，writeRunSSE 当时是静默 return，那种事件就从流上
// 彻底消失了——后端日志干净、状态码 200、前端不报错，只是界面上少一截。
// 单测全绿，是端到端那条测试才发现的。
//
// 用源码扫常量而不是手写一份名单：手写的那份漏掉新类型时不违反任何规则，
// 而漏掉正是这个测试要防的事。前端那边靠 Record<TaskRunEvent['type'], true>
// 拿到同一个保证（见 taskrun/sse.ts），这里是 Go 侧的对应物。
func TestEveryEventTypeMarshals(t *testing.T) {
	src, err := os.ReadFile("runner.go")
	if err != nil {
		t.Fatalf("读 runner.go: %v", err)
	}
	ms := eventConstRe.FindAllStringSubmatch(string(src), -1)
	if len(ms) < 6 {
		t.Fatalf("只扫到 %d 个事件常量，正则多半失配了——这种失配会让这个测试永远绿", len(ms))
	}

	seen := map[string]bool{}
	for _, m := range ms {
		typ := m[1]
		if seen[typ] {
			continue
		}
		seen[typ] = true
		t.Run(typ, func(t *testing.T) {
			b, err := json.Marshal(Event{Type: typ})
			if err != nil {
				t.Fatalf("事件 %q 序列化失败：MarshalJSON 里少了它的分支。%v", typ, err)
			}
			// 顺带确认 type 字段真的写进去了。返回 {} 也不报错，
			// 而前端按 type 分发，拿到没有 type 的对象会静默忽略。
			var got map[string]any
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("产出的不是合法 JSON: %s", b)
			}
			if got["type"] != typ {
				t.Errorf("序列化结果里 type = %v，期望 %q (%s)", got["type"], typ, b)
			}
		})
	}
}
