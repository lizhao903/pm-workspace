package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// TSK-0499 的验证都在这里：后台执行接上工作台 MCP、按档位放行、回报结论、设置的读写。

// mcpRunFixture 是能接上工作台 MCP 的 runFixture：配了 MCP 程序、本实例地址和数据目录。
// 工作目录是测试临时目录、里面没有 .mcp.json——放行不能依赖工作目录自带的配置。
func mcpRunFixture(t *testing.T, script string) (*Server, *fakeStore, *domain.Object, string, string) {
	t.Helper()
	s, f, obj, wd := runFixture(t, script)
	bin := filepath.Join(t.TempDir(), "pmw-mcp")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	s.opt.MCPBin, s.opt.PublicURL, s.opt.DataDir = bin, "http://127.0.0.1:7801", data
	return s, f, obj, wd, data
}

// 假 claude：回显参数，并把 --mcp-config 指的文件抄到工作目录外的 seen 文件里（证明执行时文件在）。
func argvAndMCPEcho(seen string) string {
	return `prev=""
for a in "$@"; do
  if [ "$prev" = "--mcp-config" ]; then cp "$a" '` + seen + `'; fi
  prev="$a"
done
shift 2
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"ARGV %s"}]}}\n' "$*"`
}

func TestRunObjectInjectsWorkbenchMCPAndReadOnlyAllowlist(t *testing.T) {
	seen := filepath.Join(t.TempDir(), "seen.json")
	s, f, obj, wd, data := mcpRunFixture(t, argvAndMCPEcho(seen))
	if _, err := os.Stat(filepath.Join(wd, ".mcp.json")); err == nil {
		t.Fatal("前提：工作目录里不该有 .mcp.json")
	}
	if w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d %s", w.Code, w.Body.String())
	}
	argv := argvOf(t, f, obj.ID)
	for _, want := range []string{"--mcp-config " + data, "--allowedTools mcp__pmw-run", "--allowedTools Bash(sqlite3 -readonly -safe:*)",
		"--allowedTools Bash(git log:*)", "--allowedTools Bash(wc:*)"} {
		if !strings.Contains(argv, want) {
			t.Errorf("命令行缺 %q：%s", want, argv)
		}
	}
	for _, bad := range []string{"--permission-mode", "dangerously", "Bash(go test:*)"} {
		if strings.Contains(argv, bad) {
			t.Errorf("只读档不该有 %q：%s", bad, argv)
		}
	}
	cfg := mustReadFile(t, seen)
	if !strings.Contains(cfg, `"pmw-run"`) || !strings.Contains(cfg, "http://127.0.0.1:7801") || !strings.Contains(cfg, s.opt.MCPBin) {
		t.Fatalf("MCP 配置不对：%s", cfg)
	}
	// 收尾删掉临时配置
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if _, err := os.Stat(filepath.Join(data, handoffSubdir, runs[0].ID)); !os.IsNotExist(err) {
		t.Errorf("执行收尾后临时 MCP 配置应删掉：%v", err)
	}
	// 记录里的提示词带执行 id 和回写要求
	if p := runs[0].Prompt; !strings.Contains(p, "执行记录 "+runs[0].ID) || !strings.Contains(p, "pmw_finish_run，run_id="+runs[0].ID) {
		t.Fatalf("提示词应带执行 id 的回写一节：\n%s", p)
	}
}

// 档位：edits_and_tests 加测试构建命令；custom 加设置里的自定义白名单；只读角色压成只读。
func TestRunObjectPermissionProfiles(t *testing.T) {
	cases := []struct {
		name, body  string
		want, avoid []string
	}{
		{"测试构建", `{"permission":"edits_and_tests"}`, []string{"--permission-mode acceptEdits", "Bash(go test:*)", "Bash(npm test:*)"}, []string{"Bash(git commit:*)"}},
		{"自定义", `{"permission":"custom"}`, []string{"--permission-mode acceptEdits", "Bash(git commit:*)"}, []string{"Bash(go test:*)"}},
		{"旧客户端只给 allow_writes", `{"allow_writes":true}`, []string{"--permission-mode acceptEdits", "Bash(ls:*)"}, []string{"Bash(go test:*)", "Bash(git commit:*)"}},
		{"只读角色压成只读", `{"permission":"custom","preset_id":"rp_review"}`, []string{"Bash(ls:*)"}, []string{"--permission-mode", "Bash(git commit:*)"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f, obj, _, _ := mcpRunFixture(t, argvEcho)
			if w := do(s, "PUT", "/api/run-permissions", `{"write_profile":"accept_edits","custom":["Bash(git commit:*)"]}`); w.Code != http.StatusOK {
				t.Fatalf("存设置：%d %s", w.Code, w.Body.String())
			}
			if w := do(s, "POST", "/api/objects/"+obj.ID+"/run", c.body); w.Code != http.StatusOK {
				t.Fatalf("状态码 = %d %s", w.Code, w.Body.String())
			}
			argv := argvOf(t, f, obj.ID)
			for _, x := range c.want {
				if !strings.Contains(argv, x) {
					t.Errorf("缺 %q：%s", x, argv)
				}
			}
			for _, x := range c.avoid {
				if strings.Contains(argv, x) {
					t.Errorf("不该有 %q：%s", x, argv)
				}
			}
			if strings.Contains(argv, "dangerously") {
				t.Fatalf("任何档位都不传 --dangerously-skip-permissions：%s", argv)
			}
		})
	}
	s, _, obj, _, _ := mcpRunFixture(t, argvEcho)
	assertError(t, do(s, "POST", "/api/objects/"+obj.ID+"/run", `{"permission":"yolo"}`), http.StatusBadRequest, "validation")
}

// 没配 MCP 程序时照跑：不传 --mcp-config，提示词写明没接上，只读白名单照旧。
func TestRunObjectWithoutMCPStillRuns(t *testing.T) {
	s, f, obj, _ := runFixture(t, argvEcho)
	if w := do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`); w.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", w.Code)
	}
	argv := argvOf(t, f, obj.ID)
	if strings.Contains(argv, "--mcp-config") || strings.Contains(argv, "mcp__pmw-run") || !strings.Contains(argv, "Bash(git status:*)") {
		t.Fatalf("没接上 MCP 时不该放行它，只读白名单照旧：%s", argv)
	}
	runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0)
	if !strings.Contains(runs[0].Prompt, "工作台的 MCP 这次没接上") {
		t.Fatalf("提示词要写明没接上：\n%s", runs[0].Prompt)
	}
}

// 后台执行经 pmw_finish_run 回报结论：跑着时收下（只收一次），收尾时放在输出最前面；结束后再报 409。
func TestStreamRunReportBack(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "go")
	script := `i=0
while [ ! -f '` + flag + `' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"过程"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","permission_denials":[]}'`
	s, f, obj, _, _ := mcpRunFixture(t, script)
	done := make(chan struct{})
	go func() {
		defer close(done)
		do(s, "POST", "/api/objects/"+obj.ID+"/run", `{}`)
	}()
	var runID string
	for i := 0; i < 200 && runID == ""; i++ {
		if runs, _ := f.ListTaskRuns(t.Context(), obj.ID, 0); len(runs) == 1 && s.run.Running(runs[0].ID) {
			runID = runs[0].ID
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if runID == "" {
		t.Fatal("执行没起来")
	}
	if w := do(s, "POST", "/api/runs/"+runID+"/finish", `{"status":"failed","summary":"缺数据，做不下去"}`); w.Code != http.StatusOK {
		t.Fatalf("跑着时应当收下回报：%d %s", w.Code, w.Body.String())
	}
	assertError(t, do(s, "POST", "/api/runs/"+runID+"/finish", `{"status":"done","summary":"再报一次"}`), http.StatusConflict, "conflict")
	if err := os.WriteFile(flag, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	<-done
	run, err := f.GetTaskRun(t.Context(), runID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(run.Output, "缺数据，做不下去\n\n---\n\n") || !strings.Contains(run.Output, "过程") {
		t.Fatalf("结论应放在输出最前面：%q", run.Output)
	}
	if run.Status != domain.RunFailed || !strings.Contains(run.Error, "做不下去") {
		t.Fatalf("回报做不下去时按失败记：%s %q", run.Status, run.Error)
	}
	assertError(t, do(s, "POST", "/api/runs/"+runID+"/finish", `{"status":"done"}`), http.StatusConflict, "conflict")
}

func TestRunPermissionsSettings(t *testing.T) {
	s, _, _, _ := runFixture(t, "exit 0")
	d := decodeEnvelope(t, do(s, "GET", "/api/run-permissions", ""))["data"].(map[string]any)
	if d["write_profile"] != "accept_edits" || d["mcp_server"] != "pmw-run" || len(d["custom"].([]any)) != 0 || len(d["profiles"].([]any)) != 4 {
		t.Fatalf("默认值不对：%v", d)
	}
	w := do(s, "PUT", "/api/run-permissions", `{"write_profile":"edits_and_tests","custom":["Bash(git commit:*)","","Bash(git commit:*)"]}`)
	d = decodeEnvelope(t, w)["data"].(map[string]any)
	if d["write_profile"] != "edits_and_tests" || len(d["custom"].([]any)) != 1 {
		t.Fatalf("保存后：%v", d)
	}
	for _, p := range d["profiles"].([]any) {
		m := p.(map[string]any)
		has := false
		for _, r := range m["allowed"].([]any) {
			has = has || r == "Bash(git commit:*)"
		}
		if has != (m["key"] == "custom") {
			t.Fatalf("自定义白名单只在 custom 档：%v", m)
		}
	}
	for _, body := range []string{`{"write_profile":"read_only"}`, `{"write_profile":"yolo"}`, `{"custom":["Bash(*)"]}`, `{"custom":["Bash"]}`} {
		assertError(t, do(s, "PUT", "/api/run-permissions", body), http.StatusBadRequest, "validation")
	}
}
