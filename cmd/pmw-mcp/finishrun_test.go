package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// pmw_finish_run 的回写路径：POST /api/runs/{id}/finish，带 status 和去掉首尾空白的 summary。
func TestFinishRunCallsAPI(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.Method + " " + r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		now := time.Now()
		_ = json.NewEncoder(w).Encode(map[string]any{"data": domain.TaskRun{ID: "run_1", Status: "done", Mode: "terminal",
			StartedAt: now.Add(-time.Minute), FinishedAt: &now}})
	}))
	defer srv.Close()
	c := newClient(srv.URL)
	r, err := c.finishRun(context.Background(), "run_1", "done", "  写完了  ")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "POST /api/runs/run_1/finish" || gotBody["status"] != "done" || gotBody["summary"] != "写完了" {
		t.Fatalf("请求：%s %v", gotPath, gotBody)
	}
	if line := runLine(r); !strings.Contains(line, "终端") || !strings.Contains(line, "耗时") {
		t.Fatalf("runLine：%s", line)
	}
	if runModeText("") != "流式" {
		t.Fatal("老记录按流式算")
	}
}
