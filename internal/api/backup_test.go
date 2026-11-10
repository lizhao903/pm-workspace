// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestMigrationsTruncatesChecksum(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	w := do(s, http.MethodGet, "/api/admin/migrations", "")
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	m := decodeEnvelope(t, w)
	items, ok := m["data"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("data 不是含 1 条的数组: %s", w.Body.String())
	}
	rec := items[0].(map[string]any)
	// 设置页只拿 checksum 做目视比对，64 位铺满一行反而看不出差异。
	if rec["checksum"] != fakeChecksum[:checksumPrefix] {
		t.Errorf("checksum = %v, 期望截成前 %d 位", rec["checksum"], checksumPrefix)
	}
	if rec["version"] != "0001_init.sql" {
		t.Errorf("version = %v", rec["version"])
	}
	if meta, ok := m["meta"].(map[string]any); !ok || meta["total"] != float64(1) {
		t.Errorf("meta.total 不对: %v", m["meta"])
	}
}

func TestSnapshotAcceptsEmptyBody(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	// 前端的「立即备份」是 POST 不带 body，不能被当成参数错误退回。
	w := do(s, http.MethodPost, "/api/admin/snapshot", "")
	if w.Code != http.StatusOK {
		t.Fatalf("空 body 的状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["path"] != "/default/backups/pm-fake.db" {
		t.Errorf("默认目录没用上: %v", data["path"])
	}
	if data["size"] != float64(4096) {
		t.Errorf("size = %v", data["size"])
	}
}

func TestSnapshotPassesDir(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	w := do(s, http.MethodPost, "/api/admin/snapshot", `{"dir":"/tmp/custom"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["path"] != "/tmp/custom/pm-fake.db" {
		t.Errorf("dir 没透传到 store: %v", data["path"])
	}

	w = do(s, http.MethodPost, "/api/admin/snapshot", `{"dir":`)
	assertError(t, w, http.StatusBadRequest, "validation")
}

func TestExportSendsAttachment(t *testing.T) {
	f := newFakeStore()
	s := newTestServer(f)

	cases := []struct {
		format   string
		wantName string
		wantCT   string
	}{
		{"", "pm-export-fake.json", "application/json"},
		{"json", "pm-export-fake.json", "application/json"},
		{"markdown", "pm-export-fake.md", "text/markdown"},
	}
	for _, c := range cases {
		target := "/api/admin/export"
		if c.format != "" {
			target += "?format=" + c.format
		}
		w := do(s, http.MethodGet, target, "")
		if w.Code != http.StatusOK {
			t.Fatalf("format=%q 状态码 = %d (body=%s)", c.format, w.Code, w.Body.String())
		}
		// 导出是开新窗口直接下载，没有附件头浏览器会把内容渲染在页面里。
		cd := w.Header().Get("Content-Disposition")
		if cd != `attachment; filename="`+c.wantName+`"` {
			t.Errorf("format=%q Content-Disposition = %q", c.format, cd)
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, c.wantCT) {
			t.Errorf("format=%q Content-Type = %q, 期望 %s", c.format, ct, c.wantCT)
		}
		if w.Body.Len() == 0 {
			t.Errorf("format=%q 响应体是空的", c.format)
		}
		// 导出走的是裸文件流，不套 envelope。
		if strings.HasPrefix(strings.TrimSpace(w.Body.String()), `{"data"`) {
			t.Errorf("format=%q 被套进了 envelope: %s", c.format, w.Body.String())
		}
	}

	w := do(s, http.MethodGet, "/api/admin/export?format=csv", "")
	assertError(t, w, http.StatusBadRequest, "validation")
}

// --- 标签维护 ---

func TestUpdateTagRoute(t *testing.T) {
	f := newFakeStore()
	tag, _ := f.CreateTag(t.Context(), "云端", "")
	s := newTestServer(f)

	w := do(s, http.MethodPatch, "/api/tags/"+tag.ID, `{"name":"云端平台","color":"#3b5bdb"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["name"] != "云端平台" || data["color"] != "#3b5bdb" {
		t.Errorf("返回的标签不对: %v", data)
	}

	w = do(s, http.MethodPatch, "/api/tags/"+tag.ID, `{"name":"  "}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPatch, "/api/tags/tag_nope", `{"name":"x"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}

func TestUpdateTagRenameConflict(t *testing.T) {
	f := newFakeStore()
	src, _ := f.CreateTag(t.Context(), "云端", "")
	if _, err := f.CreateTag(t.Context(), "云端平台", ""); err != nil {
		t.Fatalf("create tag: %v", err)
	}
	s := newTestServer(f)

	// 改名撞上已有标签名要回 409，不能悄悄合并。
	w := do(s, http.MethodPatch, "/api/tags/"+src.ID, `{"name":"云端平台"}`)
	assertError(t, w, http.StatusConflict, "conflict")
}

func TestMergeTagsRoute(t *testing.T) {
	f := newFakeStore()
	src, _ := f.CreateTag(t.Context(), "云端", "")
	dst, _ := f.CreateTag(t.Context(), "云端平台", "")
	s := newTestServer(f)

	// {id}/merge 不能被 {id} 吃掉。
	w := do(s, http.MethodPost, "/api/tags/"+src.ID+"/merge", `{"target_id":"`+dst.ID+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (body=%s)", w.Code, w.Body.String())
	}
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	if data["id"] != dst.ID {
		t.Errorf("返回的应该是合并后的目标标签，实际 %v", data["id"])
	}

	w = do(s, http.MethodPost, "/api/tags/"+dst.ID+"/merge", `{}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPost, "/api/tags/"+dst.ID+"/merge", `{"target_id":"`+dst.ID+`"}`)
	assertError(t, w, http.StatusBadRequest, "validation")

	w = do(s, http.MethodPost, "/api/tags/tag_nope/merge", `{"target_id":"`+dst.ID+`"}`)
	assertError(t, w, http.StatusNotFound, "not_found")
}
