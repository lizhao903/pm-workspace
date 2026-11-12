// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/webui"
)

func newTestServer(f *fakeStore, tweak ...func(*Options)) *Server {
	opts := Options{
		Version: "test",
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, fn := range tweak {
		fn(&opts)
	}
	return New(f, opts)
}

func do(s *Server, method, target, body string, headers ...[2]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	for _, h := range headers {
		r.Header.Set(h[0], h[1])
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

// decodeEnvelope 顺带断言 Content-Type，避免退化成 text/plain。
func decodeEnvelope(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, 期望 application/json", ct)
	}
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("响应体不是合法 JSON: %v (%s)", err, w.Body.String())
	}
	return m
}

func assertError(t *testing.T, w *httptest.ResponseRecorder, wantStatus int, wantCode string) map[string]any {
	t.Helper()
	if w.Code != wantStatus {
		t.Fatalf("状态码 = %d, 期望 %d (body=%s)", w.Code, wantStatus, w.Body.String())
	}
	m := decodeEnvelope(t, w)
	e, ok := m["error"].(map[string]any)
	if !ok {
		t.Fatalf("响应里没有 error 字段: %s", w.Body.String())
	}
	if e["code"] != wantCode {
		t.Fatalf("错误码 = %v, 期望 %s", e["code"], wantCode)
	}
	if _, ok := m["data"]; ok {
		t.Fatalf("失败响应不应带 data: %s", w.Body.String())
	}
	return e
}

func TestErrorCodeMapping(t *testing.T) {
	tests := []struct {
		name       string
		setup      func(*fakeStore)
		method     string
		target     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "not_found",
			method:     http.MethodGet,
			target:     "/api/objects/nope",
			wantStatus: http.StatusNotFound,
			wantCode:   "not_found",
		},
		{
			name:       "conflict",
			setup:      func(f *fakeStore) { f.errDeleteType = domain.ErrConflict },
			method:     http.MethodDelete,
			target:     "/api/object-types/task",
			wantStatus: http.StatusConflict,
			wantCode:   "conflict",
		},
		{
			name:       "readonly",
			setup:      func(f *fakeStore) { f.errDeleteType = domain.ErrReadOnly },
			method:     http.MethodDelete,
			target:     "/api/object-types/task",
			wantStatus: http.StatusForbidden,
			wantCode:   "readonly",
		},
		{
			name:       "validation 缺少必填字段",
			method:     http.MethodPost,
			target:     "/api/objects",
			body:       `{"body":"no title"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "validation",
		},
		{
			name:       "validation 非法 query",
			method:     http.MethodGet,
			target:     "/api/objects?limit=abc",
			wantStatus: http.StatusBadRequest,
			wantCode:   "validation",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeStore()
			if tc.setup != nil {
				tc.setup(f)
			}
			w := do(newTestServer(f), tc.method, tc.target, tc.body)
			assertError(t, w, tc.wantStatus, tc.wantCode)
		})
	}
}

// 500 必须只回通用 message，内部错误细节不许泄漏给前端。
func TestInternalErrorHidesDetail(t *testing.T) {
	f := newFakeStore()
	f.errGetObject = errors.New("sqlite: disk image is malformed at /Users/me/data/pm.db")
	w := do(newTestServer(f), http.MethodGet, "/api/objects/x1", "")
	e := assertError(t, w, http.StatusInternalServerError, "internal")
	if msg, _ := e["message"].(string); msg != "internal server error" {
		t.Fatalf("message = %q, 不应包含内部细节", msg)
	}
}

func TestValidationMessageNamesTheParameter(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/api/objects?due_before=昨天", "")
	e := assertError(t, w, http.StatusBadRequest, "validation")
	if msg, _ := e["message"].(string); !strings.Contains(msg, "due_before") {
		t.Fatalf("message = %q, 应指明是哪个参数出错", msg)
	}
}

func TestHealthEnvelope(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/api/health", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	m := decodeEnvelope(t, w)
	data, ok := m["data"].(map[string]any)
	if !ok {
		t.Fatalf("缺少 data: %s", w.Body.String())
	}
	if data["ok"] != true || data["version"] != "test" {
		t.Fatalf("data = %v", data)
	}
	if _, ok := m["meta"]; ok {
		t.Fatalf("单对象接口不应带 meta: %s", w.Body.String())
	}
}

func TestStatsCarriesVersion(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/api/stats", "")
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["version"] != "test" {
		t.Fatalf("stats 未带版本号: %v", data)
	}
}

func TestListMeta(t *testing.T) {
	f := newFakeStore()
	f.objs["o1"] = &domain.Object{ID: "o1", TypeID: "task", Title: "写测试"}
	w := do(newTestServer(f), http.MethodGet, "/api/objects?limit=10&offset=5", "")
	m := decodeEnvelope(t, w)
	meta, ok := m["meta"].(map[string]any)
	if !ok {
		t.Fatalf("列表接口必须带 meta: %s", w.Body.String())
	}
	if meta["total"] != float64(1) || meta["limit"] != float64(10) || meta["offset"] != float64(5) {
		t.Fatalf("meta = %v", meta)
	}
}

// 空列表要回 []，不能回 null，否则前端到处要兜底。
func TestEmptyListIsArray(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/api/tags", "")
	if !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatalf("空列表应为 []: %s", w.Body.String())
	}
}

func TestDeleteReturnsNullData(t *testing.T) {
	f := newFakeStore()
	f.objs["o1"] = &domain.Object{ID: "o1"}
	w := do(newTestServer(f), http.MethodDelete, "/api/objects/o1?hard=true", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	m := decodeEnvelope(t, w)
	if v, ok := m["data"]; !ok || v != nil {
		t.Fatalf("data 应为 null: %s", w.Body.String())
	}
	if !f.lastHard {
		t.Fatal("hard=true 未透传给 store")
	}
}

func TestActorSource(t *testing.T) {
	tests := []struct{ header, want string }{
		{"ui", "ui"},
		{"agent", "agent"},
		{"import", "import"},
		{"", "api"},
		{"hacker", "api"}, // 白名单外一律降级，不因为写错 header 就拒绝写入
		{"UI", "ui"},
	}
	for _, tc := range tests {
		f := newFakeStore()
		s := newTestServer(f)
		w := do(s, http.MethodPost, "/api/objects", `{"type_id":"task","title":"x"}`,
			[2]string{"X-Actor-Source", tc.header})
		if w.Code != http.StatusCreated {
			t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
		}
		if f.lastActor.Source != tc.want {
			t.Fatalf("X-Actor-Source=%q -> source=%q, 期望 %q", tc.header, f.lastActor.Source, tc.want)
		}
		if f.lastActor.Name != "me" {
			t.Fatalf("actor name = %q", f.lastActor.Name)
		}
	}
}

func TestMoveCategoryBody(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantParent *string
		wantSort   int
		wantStatus int
	}{
		{name: "移到指定父节点", body: `{"parent_id":"cat_a","sort_order":3}`, wantParent: ptr("cat_a"), wantSort: 3, wantStatus: http.StatusOK},
		{name: "parent_id 为 null 表示移到根", body: `{"parent_id":null,"sort_order":0}`, wantParent: nil, wantStatus: http.StatusOK},
		{name: "缺省 parent_id 同样按根处理", body: `{"sort_order":7}`, wantParent: nil, wantSort: 7, wantStatus: http.StatusOK},
		{name: "sort_order 类型错误", body: `{"parent_id":null,"sort_order":"3"}`, wantStatus: http.StatusBadRequest},
		{name: "空 body", body: "", wantStatus: http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeStore()
			f.cats["c1"] = &domain.Category{ID: "c1", TypeID: "requirement", Name: "产品"}
			w := do(newTestServer(f), http.MethodPost, "/api/categories/c1/move", tc.body)
			if w.Code != tc.wantStatus {
				t.Fatalf("状态码 = %d, 期望 %d (%s)", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				return
			}
			switch {
			case tc.wantParent == nil && f.lastParentID != nil:
				t.Fatalf("parent_id = %q, 期望 nil", *f.lastParentID)
			case tc.wantParent != nil && (f.lastParentID == nil || *f.lastParentID != *tc.wantParent):
				t.Fatalf("parent_id = %v, 期望 %q", f.lastParentID, *tc.wantParent)
			}
			if f.lastSort != tc.wantSort {
				t.Fatalf("sort_order = %d, 期望 %d", f.lastSort, tc.wantSort)
			}
		})
	}
}

func TestDeleteCategoryReassign(t *testing.T) {
	f := newFakeStore()
	f.cats["c1"] = &domain.Category{ID: "c1"}
	if w := do(newTestServer(f), http.MethodDelete, "/api/categories/c1?reassign_to=c2", ""); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.lastParentID == nil || *f.lastParentID != "c2" {
		t.Fatalf("reassign_to 未透传: %v", f.lastParentID)
	}
}

func TestCreateObjectTypeRejectsBadID(t *testing.T) {
	for _, id := range []string{"", "任务", "with space", "9lives", "-task"} {
		f := newFakeStore()
		w := do(newTestServer(f), http.MethodPost, "/api/object-types",
			`{"id":"`+id+`","name":"任务"}`)
		assertError(t, w, http.StatusBadRequest, "validation")
	}
}

// 大小写只是手滑，规范化成小写即可，不必报错。
func TestCreateObjectTypeNormalizesID(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPost, "/api/object-types", `{"id":" Idea ","name":"想法"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if _, ok := f.types["idea"]; !ok {
		t.Fatalf("id 未规范化: %v", f.types)
	}
}

// builtin 不接受客户端声明，避免 POST 出一个删不掉的类型。
func TestCreateObjectTypeIgnoresBuiltin(t *testing.T) {
	f := newFakeStore()
	w := do(newTestServer(f), http.MethodPost, "/api/object-types", `{"id":"idea","name":"想法","builtin":true}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	if f.types["idea"].Builtin {
		t.Fatal("builtin 不应由客户端指定")
	}
}

func TestCreateLinkReturnsLinkView(t *testing.T) {
	f := newFakeStore()
	f.objs["a"] = &domain.Object{ID: "a", Title: "源"}
	f.objs["b"] = &domain.Object{ID: "b", Title: "对端"}
	w := do(newTestServer(f), http.MethodPost, "/api/objects/a/links", `{"to_id":"b","relation":"blocks"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["direction"] != "out" {
		t.Fatalf("direction = %v", data["direction"])
	}
	peer, ok := data["peer"].(map[string]any)
	if !ok || peer["title"] != "对端" {
		t.Fatalf("peer 未填充: %v", data["peer"])
	}
}

func TestRequestBodyTooLarge(t *testing.T) {
	big := `{"type_id":"task","title":"` + strings.Repeat("x", maxBodyBytes+1) + `"}`
	w := do(newTestServer(newFakeStore()), http.MethodPost, "/api/objects", big)
	assertError(t, w, http.StatusBadRequest, "validation")
}

// API 的 404 必须是 JSON，不能掉进 SPA fallback 回 index.html。
func TestAPINotFoundIsJSON(t *testing.T) {
	s := newTestServer(newFakeStore(), func(o *Options) { o.UI = webui.Handler() })
	w := do(s, http.MethodGet, "/api/nope", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestSPAFallback(t *testing.T) {
	s := newTestServer(newFakeStore(), func(o *Options) { o.UI = webui.Handler() })
	for _, p := range []string{"/", "/inbox", "/objects/obj_123"} {
		w := do(s, http.MethodGet, p, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s 状态码 = %d", p, w.Code)
		}
		if !strings.Contains(w.Body.String(), "<title>") {
			t.Fatalf("%s 未回落到 index.html: %s", p, w.Body.String())
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
			t.Fatalf("%s Cache-Control = %q, index.html 必须 no-cache", p, cc)
		}
	}
}

// 未配置 UI（--dev）时非 API 路径也走 JSON 404，而不是空 body。
func TestNoUIHandler(t *testing.T) {
	w := do(newTestServer(newFakeStore()), http.MethodGet, "/inbox", "")
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestDevCORS(t *testing.T) {
	s := newTestServer(newFakeStore(), func(o *Options) { o.Dev = true })
	w := do(s, http.MethodOptions, "/api/objects", "", [2]string{"Origin", "http://127.0.0.1:5173"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("预检状态码 = %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
		t.Fatalf("Allow-Origin = %q", got)
	}

	// 非 dev 模式不许出现 CORS 头，免得生产部署被顺手放开。
	w2 := do(newTestServer(newFakeStore()), http.MethodGet, "/api/health", "", [2]string{"Origin", "http://evil.test"})
	if got := w2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("非 dev 模式不应带 CORS 头, 得到 %q", got)
	}
}

func TestPanicRecovered(t *testing.T) {
	f := newFakeStore()
	f.errGetObject = errPanic{}
	s := newTestServer(f)
	w := do(s, http.MethodGet, "/api/objects/x", "")
	assertError(t, w, http.StatusInternalServerError, "internal")
}

// errPanic 的 Error() 会 panic，用来触发 recover 中间件。
type errPanic struct{}

func (errPanic) Error() string { panic("boom") }

func ptr[T any](v T) *T { return &v }
