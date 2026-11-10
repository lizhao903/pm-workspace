// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"sync"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/incident"
)

type fakeIncidents struct {
	mu  sync.Mutex
	got []incident.Report
}

func (f *fakeIncidents) Record(_ context.Context, r incident.Report) (*incident.Incident, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, r)
	return &incident.Incident{}, nil
}

// TestStepFailureRecordsIncident：步骤失败记一条运行异常（INC-01a），每次失败都记，指纹按流程和步骤。
func TestStepFailureRecordsIncident(t *testing.T) {
	r, h := setup(t, New())
	f := &fakeIncidents{}
	r.SetIncidents(f)
	id := newFlow(t, h, `{"name":"周报","steps":[{"key":"ai","name":"AI 起草","kind":"ai","after":[]}]}`)
	rid := startRun(t, h, id, `{}`)["id"].(string)
	waitStatus(t, h, rid, "failed")
	if code, _ := act(t, h, rid, `{"kind":"retry","step":"ai"}`); code != 200 {
		t.Fatal("重试")
	}
	waitStatus(t, h, rid, "failed")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.got) != 2 {
		t.Fatalf("两次失败应记两次：%+v", f.got)
	}
	g := f.got[1]
	if g.Fingerprint != "sop:"+id+":ai" || g.Level != "error" || g.Module != "SOP" || g.Title != "「周报」AI 起草失败" ||
		g.Source != "plugin:sop" || g.Context["执行 id"] != rid || g.Context["第几次"] != 2 || g.Message == "" {
		t.Fatalf("记下的 = %+v", g)
	}
}
