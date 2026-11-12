// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package projects

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// recorder 记下插件发布的事件。
type recorder struct {
	mu  sync.Mutex
	evs []map[string]any
}

func (r *recorder) Publish(_ context.Context, eventType string, payload any) error {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	m["type"] = eventType
	r.mu.Lock()
	r.evs = append(r.evs, m)
	r.mu.Unlock()
	return nil
}

func (r *recorder) wait(t *testing.T, n int) []map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		r.mu.Lock()
		got := append([]map[string]any(nil), r.evs...)
		r.mu.Unlock()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("等到 %d 条事件，要 %d 条：%v", len(got), n, got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestPrototypeEvents：启动、停止、崩溃、删除都发事件，载荷带 id、名称、项目、端口（DOM-02a）。
func TestPrototypeEvents(t *testing.T) {
	r, h, _ := setup(t)
	rec := &recorder{}
	r.Events = rec
	base := "/api/projects/obj_p1/prototypes"
	dir := t.TempDir()
	port := freePort(t)
	_, out := call(t, h, "POST", base, argvBody(t, "演示站", dir, port, "sleep", "30"))
	id := out["data"].(map[string]any)["id"].(string)
	path := base + "/" + id

	if code, out := call(t, h, "POST", path+"/start", ""); code != 200 {
		t.Fatalf("启动：%d %v", code, out)
	}
	if code, _ := call(t, h, "POST", path+"/stop", ""); code != 200 {
		t.Fatalf("停止：%d", code)
	}
	evs := rec.wait(t, 2)
	want := map[string]any{"id": id, "name": "演示站", "project_id": "obj_p1", "project_name": "项目一", "port": float64(port)}
	for i, typ := range []string{"projects.prototype_started", "projects.prototype_stopped"} {
		if evs[i]["type"] != typ {
			t.Fatalf("第 %d 条事件：%v", i, evs[i])
		}
		for k, v := range want {
			if evs[i][k] != v {
				t.Fatalf("%s 的 %s = %v，应为 %v", typ, k, evs[i][k], v)
			}
		}
	}
	if evs[1]["status"] != "stopped" {
		t.Fatalf("停止事件的 status：%v", evs[1])
	}

	// 崩溃也发停止事件，status 是 crashed
	_, out = call(t, h, "POST", base, argvBody(t, "会崩", dir, freePort(t), "/bin/sh", "-c", "exit 3"))
	crashPath := base + "/" + out["data"].(map[string]any)["id"].(string)
	call(t, h, "POST", crashPath+"/start", "")
	evs = rec.wait(t, 4)
	if evs[3]["type"] != "projects.prototype_stopped" || evs[3]["status"] != "crashed" {
		t.Fatalf("崩溃事件：%v", evs[3])
	}

	if code, _ := call(t, h, "DELETE", path, ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	evs = rec.wait(t, 5)
	if evs[4]["type"] != "projects.prototype_deleted" || evs[4]["id"] != id || evs[4]["project_name"] != "项目一" || evs[4]["port"] != float64(port) {
		t.Fatalf("删除事件：%v", evs[4])
	}
}
