// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 执行器状态与 DeepSeek 集成检查（TSK-0722）。

func runnersOf(t *testing.T, s *Server, query string) map[string]RunnerStatus {
	t.Helper()
	w := do(s, http.MethodGet, "/api/runners"+query, "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/runners = %d (%s)", w.Code, w.Body.String())
	}
	var env struct {
		Data []RunnerStatus `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	out := map[string]RunnerStatus{}
	order := []string{}
	for _, r := range env.Data {
		out[r.Harness] = r
		order = append(order, r.Harness)
	}
	if strings.Join(order, ",") != "claude,deepseek,agent" {
		t.Fatalf("执行器顺序 = %v，期望 claude、deepseek、agent", order)
	}
	return out
}

func problemCodes(st RunnerStatus) string {
	var xs []string
	for _, p := range st.Problems {
		xs = append(xs, p.Code)
	}
	return strings.Join(xs, ",")
}

// TestListRunners 守「缺什么说什么」：没装 dsh、没有能用的服务商、服务商都停用、没有 Agent，
// 每种都是 blocking 的问题；装好、配好后 DeepSeek 可用，默认挑带 deepseek 的服务商而不是默认的 Ollama。
func TestListRunners(t *testing.T) {
	f := newFakeStore()
	claude := fakeClaudeBin(t, "echo '2.1.0 (Claude Code)'")
	dshPath := filepath.Join(t.TempDir(), "dsh")
	s := newTestServer(f, func(o *Options) {
		o.ClaudeBin = claude
		o.DSHBin = dshPath
	})

	st := runnersOf(t, s, "")
	if c := st["claude"]; !c.Available || c.Version != "2.1.0 (Claude Code)" || c.BinSource != "flag" || c.Bin != claude {
		t.Fatalf("claude 应可用并带版本：%+v", c)
	}
	if c := st["claude"]; c.MCP || problemCodes(c) != "no_mcp" || c.Problems[0].Blocking {
		t.Fatalf("没配 MCP 只提示、不 blocking：%+v", c.Problems)
	}
	ds := st["deepseek"]
	if ds.Available || problemCodes(ds) != "not_installed,no_provider,no_mcp" {
		t.Fatalf("没装 dsh、没有服务商：%+v", ds.Problems)
	}
	if len(ds.Problems[0].Steps) == 0 || !strings.Contains(strings.Join(ds.Problems[0].Steps, "\n"), "npm i --prefix") {
		t.Fatalf("没装 dsh 要给出安装步骤（不是全局安装）：%+v", ds.Problems[0])
	}
	if a := st["agent"]; a.Available || problemCodes(a) != "no_agent,no_provider" {
		t.Fatalf("没有 Agent、没有服务商：%+v", a.Problems)
	}

	// 只有一个 dsh 能接的服务商，停用着：provider_disabled
	off, _ := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "关着的", Kind: domain.ProviderOpenAI,
		BaseURL: "https://x", Model: "m", Enabled: false}, "k")
	if ds := runnersOf(t, s, "")["deepseek"]; !strings.Contains(problemCodes(ds), "provider_disabled") {
		t.Fatalf("服务商都停用应报 provider_disabled：%+v", ds.Problems)
	}
	_ = off

	// 装好 dsh（refresh 跳过缓存）、配上默认的 Ollama 和一个 DeepSeek：默认挑 DeepSeek
	if err := os.WriteFile(dshPath, []byte("#!/bin/sh\necho 0.2.2-rc.1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "本机 Ollama", Kind: domain.ProviderOllama,
		BaseURL: "http://localhost:11434", Model: "qwen3:4b", Enabled: true, IsDefault: true}, ""); err != nil {
		t.Fatal(err)
	}
	dsp, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "NewAPI", Kind: domain.ProviderOpenAI,
		BaseURL: "https://newapi.example.com/v1", Model: "deepseek-v4-flash", Enabled: true}, "k")
	if err != nil {
		t.Fatal(err)
	}
	if ds := runnersOf(t, s, "")["deepseek"]; ds.Version != "" || problemCodes(ds) != "not_installed,no_mcp" {
		t.Fatalf("不带 refresh 应走缓存（一分钟内还是上次「没装」的结果）、服务商现查：%+v", ds)
	}
	ds = runnersOf(t, s, "?refresh=true")["deepseek"]
	if ds.Version != "0.2.2-rc.1" || ds.ProviderID != dsp.ID || ds.Model != "deepseek-v4-flash" {
		t.Fatalf("应检测到版本、默认挑带 deepseek 的服务商：%+v", ds)
	}
	if !ds.Available || problemCodes(ds) != "no_mcp" {
		t.Fatalf("装好配好后应可用：%+v", ds.Problems)
	}
}

// TestRunObjectDeepSeekPatch 守 dsh 侧的权限档位、模型和工作台 MCP 都落进了 patch：
// 允许改文件 → workspace-write；指定模型 → 这一次用它；配了 MCP → 挂 pmw-run。
// 自定义白名单没有对应，开流前 400、不建记录。
func TestRunObjectDeepSeekPatch(t *testing.T) {
	s, f, obj, wd := runFixture(t, "exit 0")
	// 假 dsh：把 --patch 指的文件拷进工作目录（真 patch 收尾就删了），吐一段最小事件流
	s.run.DSHBin = fakeClaudeBin(t, `while [ $# -gt 0 ]; do if [ "$1" = --patch ]; then cp "$2" patch.yml; fi; shift; done
cat > /dev/null
echo '{"type":"session","sessionId":"session-p"}'
echo '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}'
echo '{"type":"final","text":"ok"}'`)
	mcpBin := fakeClaudeBin(t, "exit 0")
	s.opt.MCPBin, s.opt.PublicURL = mcpBin, "http://127.0.0.1:7796"
	if _, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "DeepSeek", Kind: domain.ProviderOpenAI,
		BaseURL: "https://api.deepseek.com", Model: "deepseek-chat", Enabled: true}, "sk"); err != nil {
		t.Fatal(err)
	}

	w := do(s, http.MethodPost, "/api/objects/"+obj.ID+"/run", `{"harness":"deepseek","permission":"custom","allow_writes":true}`)
	assertError(t, w, http.StatusBadRequest, "validation")
	if !strings.Contains(w.Body.String(), "自定义白名单") {
		t.Fatalf("要说清 dsh 不支持自定义白名单：%s", w.Body.String())
	}
	if runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0); len(runs) != 0 {
		t.Fatalf("开流前就拒绝了，不该建记录：%d", len(runs))
	}

	w = do(s, http.MethodPost, "/api/objects/"+obj.ID+"/run",
		`{"harness":"deepseek","permission":"edits_and_tests","allow_writes":true,"model":"deepseek-reasoner"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d (%s)", w.Code, w.Body.String())
	}
	patch := mustReadFile(t, filepath.Join(wd, "patch.yml"))
	for _, want := range []string{`mode: "workspace-write"`, `model: "deepseek-reasoner"`, `serverName: "pmw-run"`,
		`command: "` + mcpBin + `"`, `- "http://127.0.0.1:7796"`} {
		if !strings.Contains(patch, want) {
			t.Fatalf("patch 里缺 %q：\n%s", want, patch)
		}
	}
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 1)
	if len(runs) != 1 || !strings.Contains(runs[0].Prompt, "mcp__pmw-run__pmw_append_progress") || !strings.Contains(runs[0].Prompt, runs[0].ID) {
		t.Fatalf("记录里的提示词应带回写一节和这次的执行 id：%+v", runs)
	}

	// 停用的服务商：400
	off, _ := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "关着的", Kind: domain.ProviderOpenAI,
		BaseURL: "https://x", Model: "m", Enabled: false}, "k")
	assertError(t, do(s, http.MethodPost, "/api/objects/"+obj.ID+"/run", `{"harness":"deepseek","provider_id":"`+off.ID+`"}`),
		http.StatusBadRequest, "validation")
}

// smokeDSH 是集成检查用的假 dsh：任务里有 sleep 30 的（取消、超时那两次）开了会话就睡；
// 正式那一次从提示词里抠出 run_id，经 HTTP 回报结论（代替 MCP 调 pmw_finish_run），再吐一段事件流。
const smokeDSH = `input=$(cat)
case "$input" in
*"sleep 30"*) echo '{"type":"session","sessionId":"session-sleep"}'; sleep 30; exit 0;;
esac
rid=$(printf '%s' "$input" | sed -n 's/.*run_id="\([^"]*\)".*/\1/p' | head -1)
curl -s -X POST -H 'Content-Type: application/json' -H 'X-Actor-Source: agent' "$PMW_SMOKE_API/api/runs/$rid/finish" -d '{"status":"done","summary":"目录里有：README.md、probe.txt"}' > /dev/null
cat <<'EOF'
{"type":"session","sessionId":"session-smoke"}
{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls"}}
{"type":"tool_result","callId":"c1","status":"completed","result":"README.md\nprobe.txt"}
{"type":"tool_call","callId":"c2","tool":"mcp__pmw-run__pmw_finish_run","input":{}}
{"type":"tool_result","callId":"c2","status":"completed","result":"ok"}
{"type":"text","text":"目录里有 README.md 和 probe.txt。"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"目录里有 README.md 和 probe.txt。"}
EOF`

// TestDeepSeekSmoke 跑一遍集成检查：八项都要过，结论经回报到了检查记录上、落了库；
// 跑着的时候再发起回 409；没服务商时发起前 400。
func TestDeepSeekSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：集成检查要等取消和超时，约 6 秒")
	}
	f := newFakeStore()
	s := newTestServer(f)
	srv := httptest.NewServer(s)
	defer srv.Close()
	t.Setenv("PMW_SMOKE_API", srv.URL)

	// 没有服务商：400，不起检查
	assertError(t, do(s, http.MethodPost, "/api/runners/deepseek/smoke", ""), http.StatusBadRequest, "validation")
	if w := do(s, http.MethodGet, "/api/runners/deepseek/smoke", ""); !strings.Contains(w.Body.String(), `"data":null`) {
		t.Fatalf("还没跑过应回 null：%s", w.Body.String())
	}

	s.run.DSHBin = fakeClaudeBin(t, smokeDSH)
	s.opt.MCPBin, s.opt.PublicURL = fakeClaudeBin(t, "exit 0"), srv.URL
	if _, err := f.CreateProvider(t.Context(), &domain.AgentProvider{Name: "本机 Ollama", Kind: domain.ProviderOllama,
		BaseURL: "http://localhost:11434", Model: "qwen3:4b", Enabled: true}, ""); err != nil {
		t.Fatal(err)
	}

	w := do(s, http.MethodPost, "/api/runners/deepseek/smoke", `{"model":"qwen3:4b"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("发起 = %d (%s)", w.Code, w.Body.String())
	}
	assertError(t, do(s, http.MethodPost, "/api/runners/deepseek/smoke", ""), http.StatusConflict, "conflict")

	var sm RunnerSmoke
	deadline := time.Now().Add(40 * time.Second)
	for {
		var env struct {
			Data RunnerSmoke `json:"data"`
		}
		_ = json.Unmarshal(do(s, http.MethodGet, "/api/runners/deepseek/smoke", "").Body.Bytes(), &env)
		sm = env.Data
		if sm.Status != smokeStatusRunning || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if sm.Status != smokeStatusPassed {
		t.Fatalf("集成检查应全部通过：%+v", sm.Checks)
	}
	if len(sm.Checks) != 8 || sm.Model != "qwen3:4b" || sm.SessionID != "session-smoke" || sm.FinishedAt == nil {
		t.Fatalf("记录不全：%+v", sm)
	}
	if sm.Conclusion != "目录里有：README.md、probe.txt" || !strings.Contains(sm.Answer, "README.md") {
		t.Fatalf("结论和答复要记下：%q / %q", sm.Conclusion, sm.Answer)
	}
	raw, _ := f.AgentSetting(t.Context(), smokeSettingKey)
	if !strings.Contains(string(raw), `"status":"passed"`) {
		t.Fatalf("最后结果要落库：%s", raw)
	}
}
