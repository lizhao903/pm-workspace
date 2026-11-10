// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/runner"
)

// holdClaude 是一直跑到放行的假 Claude Code。
type holdClaude struct {
	started chan string
	release chan struct{}
}

func (h *holdClaude) Start(ctx context.Context, req runner.Request, _ func(runner.Event)) (*runner.Result, error) {
	h.started <- req.RunID
	select {
	case <-h.release:
		return &runner.Result{Status: domain.RunDone}, nil
	case <-ctx.Done():
		return &runner.Result{Status: domain.RunCanceled, ExitCode: -1}, nil
	}
}

// TestFinishPluginRunReport：POST /api/runs/{id}/finish 对插件交给 Claude Code 的运行只记回报（AUTO-01）：
// 带结构化 result，进程退出后进运行结果；result 要是 JSON 对象；回报两次 409。
func TestFinishPluginRunReport(t *testing.T) {
	s, reg, d := newPluginServer(t)
	ctx := context.Background()
	if err := reg.Install(ctx, "demo", []string{"network:localhost"}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Enable(ctx, "demo"); err != nil {
		t.Fatal(err)
	}
	h := &holdClaude{started: make(chan string, 1), release: make(chan struct{})}
	reg.SetClaudeRunner(h)
	runs, err := d.Runs()
	if err != nil {
		t.Fatal(err)
	}
	id, err := runs.StartClaudeCode(ctx, pluginClaudeStart(t))
	if err != nil {
		t.Fatal(err)
	}
	<-h.started
	assertError(t, do(s, "POST", "/api/runs/"+id+"/finish", `{"status":"done","result":[1]}`), http.StatusBadRequest, "validation")
	w := do(s, "POST", "/api/runs/"+id+"/finish", `{"status":"done","summary":"评审不通过","result":{"verdict":"reject","issues":["缺验收标准"]}}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), id) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	assertError(t, do(s, "POST", "/api/runs/"+id+"/finish", `{"status":"done"}`), http.StatusConflict, "conflict")
	close(h.release)
	if !reg.WaitRuns(5 * time.Second) {
		t.Fatal("运行没收完")
	}
	info, err := runs.Get(id)
	if err != nil || !info.Finished || info.Summary != "评审不通过" || info.Result["verdict"] != "reject" {
		t.Fatalf("运行 = %+v %v", info, err)
	}
	assertError(t, do(s, "POST", "/api/runs/"+id+"/finish", `{"status":"done"}`), http.StatusConflict, "conflict")
}

func pluginClaudeStart(t *testing.T) plugin.ClaudeCodeStart {
	return plugin.ClaudeCodeStart{Workdir: t.TempDir(), Prompt: "评审", ReportBack: true}
}
