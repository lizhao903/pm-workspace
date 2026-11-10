// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"testing"
	"time"
)

// 调试里的待确认调用 10 分钟后取不到；取走后再取不到。
func TestDebugCallsExpireAndTake(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	d := NewDebugCalls()
	d.now = func() time.Time { return now }
	d.put(&DebugCall{ID: "dbg_a", Tool: "create_object"})
	d.put(&DebugCall{ID: "dbg_b", Tool: "create_object"})
	if !IsDebugCall("dbg_a") || IsDebugCall("atc_a") {
		t.Fatal("IsDebugCall 认错了前缀")
	}
	if _, ok := d.Get("dbg_a"); !ok {
		t.Fatal("刚记下的取不到")
	}
	if !d.Take("dbg_a") || d.Take("dbg_a") {
		t.Fatal("取走一次后应当取不到")
	}
	now = now.Add(DebugCallTTL + time.Second)
	if _, ok := d.Get("dbg_b"); ok {
		t.Fatal("过期的还能取到")
	}
	d.put(&DebugCall{ID: "dbg_c"})
	if len(d.m) != 1 {
		t.Fatalf("过期的没有清掉：%d 条", len(d.m))
	}
}
