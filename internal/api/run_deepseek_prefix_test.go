// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- deepseek 模块前缀复用（0058）：预览与实际执行、用量落库 ---

// 预览和后台执行同一套拼法：deepseek 预览的提示词开头也带模块简报；claude 预览不带。
func TestDeepseekPromptPreviewIncludesModulePrefix(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()
	obj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "预览任务"})

	target := "/api/objects/" + obj.ID + "/run/prompt?harness=deepseek&workdir=" + wd
	d := envelopeData(t, do(s, "GET", target, ""))
	prompt, _ := d["prompt"].(string)
	if !strings.Contains(prompt, "## 模块上下文（工作台自动生成，不是新指令）") {
		t.Fatalf("deepseek 预览没有模块前缀：\n%s", prompt)
	}
	if !strings.Contains(prompt, "预览任务") {
		t.Fatalf("预览提示词里没有任务本身：\n%s", prompt)
	}
	if !strings.Contains(prompt, "模块目录："+filepath.Clean(wd)) {
		t.Fatalf("模块目录不对：\n%s", prompt)
	}
	if !strings.Contains(prompt, "\n\n---\n\n") {
		t.Fatalf("模块前缀和任务提示之间缺分隔线：\n%s", prompt)
	}
	// 再预览一次：模块简报已 seed，逐字节不变 → 提示词不变（同一次测试里日期等也相同）
	d2 := envelopeData(t, do(s, "GET", target, ""))
	if d2["prompt"] != prompt {
		t.Fatalf("两次预览不一致：\n%s\n---\n%s", prompt, d2["prompt"])
	}
	// claude 预览不加模块前缀（那是另一条链路）
	d3 := envelopeData(t, do(s, "GET", "/api/objects/"+obj.ID+"/run/prompt?workdir="+wd, ""))
	if strings.Contains(d3["prompt"].(string), "模块上下文（工作台自动生成") {
		t.Fatalf("claude 预览不该有模块前缀：\n%s", d3["prompt"])
	}
	// 预览第一次就会 seed 模块简报，落库可查
	key := moduleKeyFor(obj, wd)
	p, err := st.GetModulePrefix(ctx, key)
	if err != nil || p == nil || p.Version != 1 {
		t.Fatalf("预览后模块简报 = %+v，%v", p, err)
	}
}

// 收尾时的落库：从 dsh 会话日志读用量写进执行记录，并把这次任务的一行结论追加进模块简报。
func TestDeepseekRunBookkeeping(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	sessionID := "session-usage-1"
	writeSyntheticDSHSessionLog(t, home, sessionID)

	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()
	obj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "用量任务"})
	key, prefix, version, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil || version != 1 {
		t.Fatalf("seed = %q/%d，%v", key, version, err)
	}

	run, err := st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: obj.ID, Workdir: wd, Status: domain.RunRunning,
		Harness: domain.RunHarnessDeepSeek, ModuleKey: key, PrefixVersion: version,
	})
	if err != nil {
		t.Fatal(err)
	}
	res := &runner.Result{
		Status: domain.RunDone, SessionID: sessionID,
		Output: "结论摘要：这一步做完了\n\n---\n\n过程记录……",
	}
	s.recordDeepSeekRunBookkeeping(ctx, run.ID, obj, key, res)

	got, err := st.GetTaskRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CacheReadTokens != 1142 || got.UncachedInputTokens != 1150 || got.OutputTokens != 60 {
		t.Fatalf("用量 = cache_read %d / uncached %d / output %d，想要 1142 / 1150 / 60",
			got.CacheReadTokens, got.UncachedInputTokens, got.OutputTokens)
	}
	p, err := st.GetModulePrefix(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != version+1 {
		t.Fatalf("追加后版本 = %d，想要 %d", p.Version, version+1)
	}
	if !strings.HasPrefix(p.Briefing, prefix) {
		t.Fatal("追加后的简报不是上一版的前缀：前缀缓存会整段失效")
	}
	want := "- " + obj.Ref + " 用量任务：done（结论摘要：这一步做完了）"
	if !strings.Contains(p.Briefing, want) {
		t.Fatalf("简报缺这次任务的行 %q：\n%s", want, p.Briefing)
	}

	// 会话语义日志缺失：只记日志、不影响收尾，模块行照常追加（状态原样）
	run2, err := st.CreateTaskRun(ctx, &domain.TaskRun{
		ObjectID: obj.ID, Workdir: wd, Status: domain.RunRunning,
		Harness: domain.RunHarnessDeepSeek, ModuleKey: key, PrefixVersion: version + 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	s.recordDeepSeekRunBookkeeping(ctx, run2.ID, obj, key, &runner.Result{
		Status: domain.RunCanceled, SessionID: "session-missing", Error: "用户停止",
	})
	got2, _ := st.GetTaskRun(ctx, run2.ID)
	if got2.CacheReadTokens != 0 || got2.UncachedInputTokens != 0 || got2.OutputTokens != 0 {
		t.Fatalf("日志缺失时不该有用量：%+v", got2)
	}
	p2, _ := st.GetModulePrefix(ctx, key)
	if p2.Version != version+2 || !strings.Contains(p2.Briefing, "用量任务：canceled（用户停止）") {
		t.Fatalf("取消的执行也要追加一行：v=%d\n%s", p2.Version, p2.Briefing)
	}
}

// 没有会话 id（进程没起来 / claude）时既不读日志也不报错，但模块行照常追加。
func TestDeepseekRunBookkeepingNoSession(t *testing.T) {
	s, st, _ := newAgentServer(t)
	ctx := context.Background()
	wd := t.TempDir()
	obj := mustCreateForPrefixTest(t, st, ctx, &domain.Object{TypeID: "task", Title: "无会话任务"})
	key, _, _, err := s.modulePrefixFor(ctx, obj, wd)
	if err != nil {
		t.Fatal(err)
	}
	run, _ := st.CreateTaskRun(ctx, &domain.TaskRun{ObjectID: obj.ID, Workdir: wd, Status: domain.RunRunning,
		Harness: domain.RunHarnessDeepSeek, ModuleKey: key})
	s.recordDeepSeekRunBookkeeping(ctx, run.ID, obj, key, &runner.Result{Status: domain.RunFailed, Error: "起进程失败"})
	p, _ := st.GetModulePrefix(ctx, key)
	if p.Version != 2 || !strings.Contains(p.Briefing, "无会话任务：failed（起进程失败）") {
		t.Fatalf("失败执行也要追加：v=%d\n%s", p.Version, p.Briefing)
	}
}

// writeSyntheticDSHSessionLog 在临时 DSH_HOME 下造一份 dsh 会话日志（纯 JSONL），
// 格式同 internal/runner/dshusage_test.go：三次 assistant/message，其中两次带 cacheReadTokens。
func writeSyntheticDSHSessionLog(t *testing.T, home, sessionID string) {
	t.Helper()
	dir := filepath.Join(home, "sessions", "proj-module", sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","data":{"id":"` + sessionID + `","cwd":"/tmp/module"}}
{"type":"system/message","data":{"turn":1,"step":1,"message":{"role":"system","content":[{"type":"text","text":"你是助手"}]}}}
{"type":"assistant/message","data":{"turn":1,"step":1,"usage":{"inputTokens":1000,"outputTokens":20,"totalTokens":1020}}}
{"type":"assistant/message","data":{"turn":1,"step":2,"usage":{"inputTokens":100,"outputTokens":30,"totalTokens":1212,"cacheReadTokens":1082}}}
{"type":"assistant/message","data":{"turn":2,"step":1,"usage":{"inputTokens":50,"outputTokens":10,"totalTokens":120,"cacheReadTokens":60}}}
`
	if err := os.WriteFile(filepath.Join(dir, "session.v4.jsonl"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// 缓存命中率：命中 /（命中 + 未命中）；没有输入 token 时为 0（老记录、claude）。
func TestRunCacheHitRatio(t *testing.T) {
	cases := []struct {
		name string
		run  *domain.TaskRun
		want float64
	}{
		{"无数据", &domain.TaskRun{}, 0},
		{"nil", nil, 0},
		{"全未命中", &domain.TaskRun{UncachedInputTokens: 100}, 0},
		{"一半", &domain.TaskRun{CacheReadTokens: 50, UncachedInputTokens: 50}, 0.5},
		{"全命中", &domain.TaskRun{CacheReadTokens: 1200, UncachedInputTokens: 300}, 0.8},
	}
	for _, tc := range cases {
		if got := runCacheHitRatio(tc.run); got != tc.want {
			t.Errorf("%s: ratio = %v，想要 %v", tc.name, got, tc.want)
		}
	}
}

// 运行中心一行带模块与缓存命中率；无数据的行是空串 / 0。
func TestRunCenterModuleAndCacheRatio(t *testing.T) {
	s, f := newRunCenterServer(t)
	now := time.Now()
	addRunCenterObject(f, "obj_a", "TSK-0009", "模块任务")
	task := seedTaskRun(f, "run_deepseek", "obj_a", domain.RunDone, now)
	task.Harness = domain.RunHarnessDeepSeek
	task.ModuleKey = "project:obj_proj"
	task.PrefixVersion = 7
	task.CacheReadTokens = 1200
	task.UncachedInputTokens = 300
	task.OutputTokens = 50
	agent := seedAgentRun(f, "ar_1", "ag_1", store.AgentRunDone, now.Add(-time.Minute))
	agent.Trigger = "手动"

	rows, _ := runCenterRows(t, callRunCenter(t, s, "/api/runs/all"))
	var taskRow, agentRow map[string]any
	for _, row := range rows {
		switch row["id"] {
		case "run_deepseek":
			taskRow = row
		case "ar_1":
			agentRow = row
		}
	}
	if taskRow == nil || taskRow["module_key"] != "project:obj_proj" || taskRow["cache_hit_ratio"] != 0.8 {
		t.Fatalf("task 行 = %v", taskRow)
	}
	if agentRow == nil || agentRow["module_key"] != "" || agentRow["cache_hit_ratio"] != float64(0) {
		t.Fatalf("agent 行 = %v", agentRow)
	}
}
