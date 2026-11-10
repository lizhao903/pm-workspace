// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

func artifactData(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	m := decodeEnvelope(t, w)
	d, ok := m["data"].(map[string]any)
	if !ok {
		t.Fatalf("响应里没有 data 对象: %s", w.Body.String())
	}
	return d
}

// TestCreateArtifactForcesManualSource 守「来源不可自报」。
//
// 让调用方填 source 的话，统计页上「AI 助手产出了多少」「任务执行产出了多少」
// 就不再可信——而那几个数看起来完全正常。
func TestCreateArtifactForcesManualSource(t *testing.T) {
	s := newTestServer(newFakeStore())

	w := do(s, http.MethodPost, "/api/artifacts",
		`{"url":"https://x/1","source":"agent","title":"伪装成 Agent 产出的"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d，期望 201 (body=%s)", w.Code, w.Body.String())
	}
	if got := artifactData(t, w)["source"]; got != domain.ArtifactSourceManual {
		t.Errorf("source = %v，期望被强制成 manual", got)
	}

	// 带上 pmw-mcp 用的那个头，来源要变成 mcp。
	//
	// 这一半必须单独验。只验「请求体里的 source 被覆盖」的话，一个把来源
	// 写死成 manual 的实现照样全绿，而后果是统计页上「外部工具」永远是 0——
	// 那看起来只像「还没有人这么用过」。
	w = do(s, http.MethodPost, "/api/artifacts",
		`{"url":"https://x.atlassian.net/wiki/2","title":"MCP 回写的"}`,
		[2]string{"X-Actor-Source", "agent"})
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	if got := artifactData(t, w)["source"]; got != domain.ArtifactSourceMCP {
		t.Errorf("带 X-Actor-Source:agent 时 source = %v，期望 mcp", got)
	}
}

// TestCreateArtifactNeedsALocation 保证 400 而不是 500。
func TestCreateArtifactNeedsALocation(t *testing.T) {
	s := newTestServer(newFakeStore())
	assertError(t, do(s, http.MethodPost, "/api/artifacts", `{"title":"两个位置都空"}`),
		http.StatusBadRequest, "validation")
}

// TestListArtifactsPassesTriStateFilters 是这一组接口最容易静默出错的地方。
//
// has_url=false 的语义是「只看还没发出去的本地文件」。任何一层把它当成
// 「没传」处理（HTTP 参数解析、handler 拼 filter、store 拼 WHERE），
// 结果都是**返回全部产物**——不报错，用户只会觉得这个筛选按钮点了没反应。
func TestListArtifactsPassesTriStateFilters(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	mk := func(body string) {
		if w := do(s, http.MethodPost, "/api/artifacts", body); w.Code != http.StatusCreated {
			t.Fatalf("建产物失败: %s", w.Body.String())
		}
	}
	mk(`{"path":"/tmp/只在本地.md"}`)
	mk(`{"url":"https://x/1","platform":"confluence"}`)
	mk(`{"path":"/tmp/两边都有.md","url":"https://x/2","platform":"confluence"}`)

	cases := []struct {
		name  string
		query string
		want  int
	}{
		{"不传就是不过滤", "", 3},
		{"已发出去的", "?has_url=true", 2},
		{"还没发出去的本地文件", "?has_url=false", 1},
		{"没有本地副本的", "?has_path=false", 1},
		{"按平台", "?platform=confluence", 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(s, http.MethodGet, "/api/artifacts"+c.query, "")
			if w.Code != http.StatusOK {
				t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
			}
			m := decodeEnvelope(t, w)
			items, _ := m["data"].([]any)
			if len(items) != c.want {
				t.Errorf("列表 %d 条，期望 %d 条", len(items), c.want)
			}
			// 统计必须跟列表说同一件事，否则页面上会出现「共 3 件」但只列出 1 行。
			ws := do(s, http.MethodGet, "/api/artifacts/stats"+c.query, "")
			if ws.Code != http.StatusOK {
				t.Fatalf("统计状态码 = %d (body=%s)", ws.Code, ws.Body.String())
			}
			if got := artifactData(t, ws)["total"]; int(got.(float64)) != c.want {
				t.Errorf("统计 total = %v，期望 %d（与列表分叉了）", got, c.want)
			}
		})
	}
}

// TestListArtifactsRejectsContradictoryScope 守「自相矛盾要报错，不能静默返回空」。
// 静默返回空会被读成「这个对象没有产物」。
func TestListArtifactsRejectsContradictoryScope(t *testing.T) {
	s := newTestServer(newFakeStore())
	assertError(t, do(s, http.MethodGet, "/api/artifacts?object_id=obj_1&unscoped=true", ""),
		http.StatusBadRequest, "validation")
}

// TestPatchArtifactObjectIDThreeStates 守 PATCH 的三态。
//
// 字段不出现 / null / 有值必须是三种不同的结果。少了这一层，「把产物移出这个对象」
// 永远无法表达，而且不报错——用户点了「解除归属」，刷新后它还在那儿。
func TestPatchArtifactObjectIDThreeStates(t *testing.T) {
	s := newTestServer(newFakeStore())

	w := do(s, http.MethodPost, "/api/artifacts", `{"url":"https://x/1","object_id":"obj_a"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("建产物失败: %s", w.Body.String())
	}
	id, _ := artifactData(t, w)["id"].(string)

	// 1. 字段不出现：不改。
	got := artifactData(t, do(s, http.MethodPatch, "/api/artifacts/"+id, `{"note":"改个备注"}`))
	if got["object_id"] != "obj_a" {
		t.Errorf("没给 object_id 时归属不该变，得到 %v", got["object_id"])
	}

	// 2. 有值：改挂过去。
	got = artifactData(t, do(s, http.MethodPatch, "/api/artifacts/"+id, `{"object_id":"obj_b"}`))
	if got["object_id"] != "obj_b" {
		t.Errorf("应改挂到 obj_b，得到 %v", got["object_id"])
	}

	// 3. null：解除归属。这条最容易退化成「不改」。
	got = artifactData(t, do(s, http.MethodPatch, "/api/artifacts/"+id, `{"object_id":null}`))
	if got["object_id"] != nil {
		t.Errorf("object_id=null 应解除归属，得到 %v", got["object_id"])
	}
}

// TestPatchArtifactRejectsBadObjectID 保证类型不对时是 400 而不是 500。
func TestPatchArtifactRejectsBadObjectID(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodPost, "/api/artifacts", `{"url":"https://x/1"}`)
	id, _ := artifactData(t, w)["id"].(string)

	assertError(t, do(s, http.MethodPatch, "/api/artifacts/"+id, `{"object_id":123}`),
		http.StatusBadRequest, "validation")
}

// TestArtifactStatsIgnoresPaging 守「统计不分页」。
// 带上 limit 的话，统计会变成「当前这一页的统计」，而页面上它显示成「共 N 件」。
func TestArtifactStatsIgnoresPaging(t *testing.T) {
	s := newTestServer(newFakeStore())
	for i := 0; i < 5; i++ {
		body, _ := json.Marshal(map[string]string{"url": "https://x/" + string(rune('a'+i))})
		if w := do(s, http.MethodPost, "/api/artifacts", string(body)); w.Code != http.StatusCreated {
			t.Fatalf("建产物失败: %s", w.Body.String())
		}
	}
	got := artifactData(t, do(s, http.MethodGet, "/api/artifacts/stats?limit=2", ""))
	if int(got["total"].(float64)) != 5 {
		t.Errorf("统计 total = %v，期望 5（limit 不该影响统计）", got["total"])
	}
}

// TestArtifactStatsRouteIsNotShadowed 守 /api/artifacts/stats 不被 /{id} 吃掉。
// 被吃掉的表现是 404 artifact not found，看上去像「还没有产物」。
func TestArtifactStatsRouteIsNotShadowed(t *testing.T) {
	s := newTestServer(newFakeStore())
	w := do(s, http.MethodGet, "/api/artifacts/stats", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200——说明 stats 被 /{id} 路由吃掉了 (body=%s)", w.Code, w.Body.String())
	}
	if _, ok := artifactData(t, w)["by_platform"]; !ok {
		t.Error("返回的不是统计结构")
	}
}

// TestSessionArtifactsRejectsMissingSession 守会话存在性检查。
// 这个保证 0012 之后从 store 层挪到了这里，见 sqlite/agent_test.go 的注释。
func TestSessionArtifactsRejectsMissingSession(t *testing.T) {
	s := newTestServer(newFakeStore())
	assertError(t, do(s, http.MethodGet, "/api/agent/sessions/ags_nope/artifacts", ""),
		http.StatusNotFound, "not_found")
}
