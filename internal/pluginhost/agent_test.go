// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/agent"
)

type fakeCompleter struct{ got agent.CompleteRequest }

func (f *fakeCompleter) Complete(_ context.Context, req agent.CompleteRequest) (string, error) {
	f.got = req
	return "本次是有氧基础跑\n- 建议下周加一次节奏跑", nil
}

func installWithPerms(t *testing.T, perms []string) (*Host, *pluginProcess) {
	t.Helper()
	obj := testManifestObj(platformKey(), "bin/hello_world")
	list := make([]any, 0, len(perms))
	reasons := map[string]any{}
	for _, p := range perms {
		list = append(list, p)
		reasons[p] = "测试"
	}
	obj["permissions"] = list
	obj["permissions_reason"] = reasons
	dir := t.TempDir()
	writeTestPackage(t, dir, obj)
	h, _ := newFakeHost(t, Options{})
	ctx := context.Background()
	if _, err := h.Install(ctx, Source{Type: "dir", Path: dir}, perms); err != nil {
		t.Fatalf("安装失败：%v", err)
	}
	if _, err := h.Enable(ctx, "hello_world"); err != nil {
		t.Fatal(err)
	}
	p := h.lookupProc("hello_world")
	if p == nil {
		t.Fatal("进程没起来")
	}
	return h, p
}

func TestHostAgentRun(t *testing.T) {
	h, p := installWithPerms(t, []string{"agent:run"})
	raw, _ := json.Marshal(map[string]any{"prompt": "分析这次跑步", "system": "你是跑步教练", "preset_id": "跑步教练"})

	// 没接模型：unavailable
	if _, err := p.agentRun(context.Background(), raw); err == nil {
		t.Fatal("没接模型时应报错")
	}
	fc := &fakeCompleter{}
	h.SetAgent(fc)
	out, err := p.agentRun(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	if m["status"] != "done" || m["summary"] != "本次是有氧基础跑" || m["result"] != "本次是有氧基础跑\n- 建议下周加一次节奏跑" {
		t.Fatalf("返回不对：%v", m)
	}
	if fc.got.Agent != "跑步教练" || fc.got.System != "你是跑步教练" || fc.got.Prompt != "分析这次跑步" {
		t.Fatalf("没把参数传给模型服务：%+v", fc.got)
	}
	// 空提示词
	if _, err := p.agentRun(context.Background(), json.RawMessage(`{"prompt":"  "}`)); err == nil {
		t.Fatal("空 prompt 应拒绝")
	}
}

func TestHostAgentRunNeedsPermission(t *testing.T) {
	h, p := installWithPerms(t, []string{"notify"})
	h.SetAgent(&fakeCompleter{})
	if _, err := p.agentRun(context.Background(), json.RawMessage(`{"prompt":"hi"}`)); err == nil {
		t.Fatal("没声明 agent:run 应拒绝")
	}
}
