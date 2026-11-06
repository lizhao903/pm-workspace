package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// fakeClaude 把一段 shell 写成可执行文件，当作 claude 用。
//
// 测试一律不调真的 claude：它依赖外部 CLI、网络和用户的登录态，
// 任何一条不满足就会让「进程能不能被杀干净」这种纯本地的性质测不出来。
// 真 CLI 的冒烟单独放在 TestSmokeRealClaude。
func fakeClaude(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	return path
}

// newRun 造一个指向假 claude 的 Runner 和一次执行请求，工作区是一次性临时目录。
func newRun(t *testing.T, script string) (*Runner, Request) {
	t.Helper()
	return &Runner{Bin: fakeClaude(t, script)},
		Request{RunID: "run_test01", Workdir: t.TempDir(), Prompt: "做点什么"}
}

func collect(evs *[]Event) func(Event) {
	return func(e Event) { *evs = append(*evs, e) }
}

// --- workdir 必填且必须可用 ---

func TestStartRejectsEmptyWorkdir(t *testing.T) {
	r := &Runner{Bin: fakeClaude(t, "echo hi")}
	_, err := r.Start(context.Background(), Request{RunID: "run_1", Prompt: "x"}, nil)
	if err == nil {
		t.Fatal("空 workdir 必须被拒绝：否则 claude 会落到工作台自己的源码目录里改文件")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("want validation error, got %v", err)
	}
	// 这句话是用户唯一能看到的指引，必须原样保留。
	if !strings.Contains(err.Error(), "请先为这个任务或它所属的项目设置工作区目录") {
		t.Fatalf("message should tell the user what to do, got %q", err)
	}
}

func TestStartRejectsUnusableWorkdir(t *testing.T) {
	bin := fakeClaude(t, "echo hi")
	base := t.TempDir()

	file := filepath.Join(base, "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	readonly := filepath.Join(base, "readonly")
	if err := os.Mkdir(readonly, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readonly, 0o700) })

	cases := []struct {
		name string
		dir  string
		want string
	}{
		{"不存在", filepath.Join(base, "nope"), "不存在"},
		{"是文件", file, "不是目录"},
		{"相对路径", "relative/path", "绝对路径"},
		{"不可写", readonly, "不可写"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.name == "不可写" && os.Geteuid() == 0 {
				t.Skip("root 无视权限位")
			}
			r := &Runner{Bin: bin}
			_, err := r.Start(context.Background(),
				Request{RunID: "run_1", Workdir: c.dir, Prompt: "x"}, nil)
			if err == nil {
				t.Fatalf("workdir %q 必须被拒绝", c.dir)
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("want validation error, got %v", err)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("message %q should mention %q", err, c.want)
			}
		})
	}
}

func TestStartRejectsMissingBinary(t *testing.T) {
	r := &Runner{Bin: "pmw-no-such-binary-hopefully"}
	_, err := r.Start(context.Background(),
		Request{RunID: "run_1", Workdir: t.TempDir(), Prompt: "x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "找不到 claude") {
		t.Fatalf("want a clear 'claude not installed' error, got %v", err)
	}
}

// --- stream-json 解析 ---

// ndjson 是一段打桩的 claude 输出：一句话、一次 Write、一次 Bash、再一句话，最后收尾。
const ndjson = `{"type":"system","subtype":"init","cwd":"/tmp"}
{"type":"assistant","message":{"content":[{"type":"text","text":"先看一下目录。"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/tmp/x/README.md","content":"很长的正文……"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"go test ./...","description":"跑测试"}}]}}
not json at all
{"type":"assistant","message":{"content":[{"type":"text","text":"完成了。"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"完成了。"}`

func TestStreamParsing(t *testing.T) {
	r, req := newRun(t, "cat <<'EOF'\n"+ndjson+"\nEOF")

	var evs []Event
	res, err := r.Start(context.Background(), req, collect(&evs))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Status != domain.RunDone || res.ExitCode != 0 {
		t.Fatalf("want done/0, got %s/%d (%s)", res.Status, res.ExitCode, res.Error)
	}

	var got []string
	for _, e := range evs {
		switch e.Type {
		case EventDelta:
			got = append(got, "delta:"+e.Text)
		case EventTool:
			got = append(got, "tool:"+e.Name+":"+e.Detail)
		case EventToolResult:
			got = append(got, "tool_result:"+e.Name+":"+strconv.FormatBool(e.OK))
		default:
			t.Fatalf("runner 不该发 %s 事件：done/error 由 API 层在落库之后自己发", e.Type)
		}
	}
	want := []string{
		"delta:先看一下目录。",
		"tool:Write:/tmp/x/README.md",
		"tool_result:Write:true",  // 名字由 id 对照表补上
		"tool:Bash:go test ./...", // command 比 description 更有信息量，要优先
		"delta:完成了。",
	}
	if len(got) != len(want) {
		t.Fatalf("events\n got %q\nwant %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("event %d = %q, want %q", i, got[i], want[i])
		}
	}

	// 落库的是给人读的过程记录，不是原始 NDJSON。
	for _, want := range []string{"先看一下目录。", "[工具] Write · /tmp/x/README.md", "[工具] Bash · go test ./...", "完成了。"} {
		if !strings.Contains(res.Output, want) {
			t.Errorf("output 缺少 %q：\n%s", want, res.Output)
		}
	}
	if strings.Contains(res.Output, "很长的正文") {
		t.Error("工具入参的正文不该整段落进输出，那是 Write 的文件内容")
	}
}

func TestStreamResultErrorMarksFailed(t *testing.T) {
	line := `{"type":"result","subtype":"error_max_turns","is_error":true,"result":"达到最大轮数"}`
	r, req := newRun(t, "echo '"+line+"'")

	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// 退出码是 0，但 claude 自己说这轮是错的——以它的说法为准。
	if res.Status != domain.RunFailed {
		t.Fatalf("want failed, got %s", res.Status)
	}
	if !strings.Contains(res.Error, "达到最大轮数") {
		t.Fatalf("error 应带上 claude 给的原因，got %q", res.Error)
	}
}

func TestNonZeroExitFallsBackToStderr(t *testing.T) {
	// claude 什么 JSON 都没吐就挂了（比如鉴权失败），这时 stderr 是唯一的线索。
	r, req := newRun(t, "echo '模型鉴权失败' >&2\nexit 3")

	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Status != domain.RunFailed || res.ExitCode != 3 {
		t.Fatalf("want failed/3, got %s/%d", res.Status, res.ExitCode)
	}
	if !strings.Contains(res.Error, "模型鉴权失败") {
		t.Fatalf("没有 JSON 可依据时要把 stderr 交出来，got %q", res.Error)
	}
}

func TestReadLineTruncatesOverlongLineWithoutEatingTheNext(t *testing.T) {
	br := bufio.NewReader(strings.NewReader(strings.Repeat("a", 100) + "\nshort\n"))

	got, err := readLine(br, 10)
	if err != nil {
		t.Fatalf("readLine: %v", err)
	}
	if string(got) != strings.Repeat("a", 10) {
		t.Fatalf("超长行应被截到 10 字节，got %q", got)
	}
	// 关键：丢掉的只是这一行的尾巴，后面的行不能被吃掉。
	got, _ = readLine(br, 10)
	if string(got) != "short" {
		t.Fatalf("下一行应完整读出，got %q", got)
	}
}

// --- 取消：必须杀掉整个进程组 ---

// TestCancelKillsProcessGroup 是这个包最重要的一条测试。
//
// 假 claude 先拉起一个后台子进程再自己睡着，正是 claude 的真实形态
// （它会起 bash、子 agent、MCP server）。只 kill 父进程的话：
//   - 子进程会继续跑、继续写盘；
//   - 它还捏着 stdout 管道，Start 会卡在读不到 EOF 上永远不返回。
//
// 所以这条测试一旦退化成「只杀父进程」，会同时以超时和残留进程两种方式失败。
func TestCancelKillsProcessGroup(t *testing.T) {
	r, req := newRun(t, `sleep 600 &
echo $! > child.pid
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"started"}]}}'
sleep 600`)

	type outcome struct {
		res *Result
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := r.Start(context.Background(), req, nil)
		done <- outcome{res, err}
	}()

	// 等孙子进程真的起来了再取消，否则可能测了个空。
	pidFile := filepath.Join(req.Workdir, "child.pid")
	var childPID int
	waitFor(t, 5*time.Second, "子进程启动", func() bool {
		b, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		childPID, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && childPID > 0
	})
	if !alive(childPID) {
		t.Fatalf("前置条件不成立：子进程 %d 应该活着", childPID)
	}

	if !r.Cancel(req.RunID) {
		t.Fatal("Cancel 应该找得到这次执行")
	}

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("start: %v", got.err)
		}
		if got.res.Status != domain.RunCanceled {
			t.Fatalf("want canceled, got %s (%s)", got.res.Status, got.res.Error)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("取消后 Start 没有返回：多半是只杀了父进程，孙子进程还捏着 stdout 管道")
	}

	// 真正的证据：孙子进程必须已经不在了。
	waitFor(t, 5*time.Second, "子进程消失", func() bool { return !alive(childPID) })

	if r.Running(req.RunID) {
		t.Error("执行结束后不该还留在活进程表里")
	}
}

func TestCancelUnknownRunReturnsFalse(t *testing.T) {
	r := &Runner{}
	if r.Cancel("run_nothing") {
		t.Fatal("没有这次执行时 Cancel 必须回 false，API 层靠它识别「工作台重启过」")
	}
}

func TestContextCancelStopsRun(t *testing.T) {
	r, req := newRun(t, "sleep 600")
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan *Result, 1)
	go func() {
		res, err := r.Start(ctx, req, nil)
		if err != nil {
			t.Errorf("start: %v", err)
		}
		done <- res
	}()

	waitFor(t, 5*time.Second, "进程登记", func() bool { return r.Running(req.RunID) })
	cancel()

	select {
	case res := <-done:
		if res.Status != domain.RunCanceled {
			t.Fatalf("want canceled, got %s", res.Status)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ctx 取消后 Start 没有返回")
	}
}

// --- 超时 ---

func TestTimeoutFinishesAsFailed(t *testing.T) {
	r, req := newRun(t, "sleep 600")
	r.Timeout = 300 * time.Millisecond

	start := time.Now()
	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if el := time.Since(start); el > 20*time.Second {
		t.Fatalf("超时之后应该立刻收尾，实际耗时 %s", el)
	}
	if res.Status != domain.RunFailed {
		t.Fatalf("want failed, got %s", res.Status)
	}
	// 说清是超时，不然用户只看到一个「失败」，不知道是任务错了还是跑太久。
	if !strings.Contains(res.Error, "超时") {
		t.Fatalf("error 应说明是超时，got %q", res.Error)
	}
}

// --- 输出截断与落盘 ---

func TestLargeOutputTruncatedAndWrittenToWorkdir(t *testing.T) {
	// 每行一条 delta，攒出远超上限的输出。
	script := `i=0
while [ $i -lt 400 ]; do
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$(printf 'x%.0s' $(seq 1 200))"
  i=$((i+1))
done`
	r, req := newRun(t, script)
	r.MaxOutput = 4096

	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !res.Truncated {
		t.Fatal("输出远超上限，应该被截断")
	}
	if len(res.Output) > r.MaxOutput {
		t.Fatalf("截断后仍有 %d 字节，超过上限 %d", len(res.Output), r.MaxOutput)
	}
	if !strings.Contains(res.Output, "已截断") {
		t.Fatalf("截断处必须留下说明，got 尾部 %q", tail(res.Output, 200))
	}

	// 完整输出要能在工作区里找回来，否则「事后复查它做了什么」就断了。
	want := filepath.Join(req.Workdir, runLogDir, req.RunID+".log")
	if res.LogPath != want {
		t.Fatalf("LogPath = %q, want %q", res.LogPath, want)
	}
	if !strings.Contains(res.Output, want) {
		t.Fatalf("截断说明里要写清完整输出在哪，got 尾部 %q", tail(res.Output, 300))
	}
	full, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("读完整输出: %v", err)
	}
	if len(full) <= len(res.Output) {
		t.Fatalf("落盘的应该是完整输出（%d 字节），却不比截断后的（%d 字节）长",
			len(full), len(res.Output))
	}
}

func TestSmallOutputNotTruncated(t *testing.T) {
	r, req := newRun(t, `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'`)
	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Truncated || res.LogPath != "" {
		t.Fatal("输出没超限就不该截断，也不该往用户的工作区里丢日志文件")
	}
	if _, err := os.Stat(filepath.Join(req.Workdir, runLogDir)); !os.IsNotExist(err) {
		t.Error("没截断时不该建 .pmw-runs 目录")
	}
}

func TestTruncateKeepsRunesIntact(t *testing.T) {
	s := strings.Repeat("中", 4000) // 每个 3 字节
	got, cut := truncate(s, 4096)
	if !cut {
		t.Fatal("应该被截断")
	}
	if !utf8.ValidString(got) {
		t.Fatal("截断切断了一个 UTF-8 字符，落库的就是一段乱码")
	}
}

// --- 事件的 JSON 形状就是前后端契约 ---

func TestEventJSONMatchesFrontendContract(t *testing.T) {
	cases := []struct {
		ev   Event
		want string
	}{
		{Event{Type: EventDelta, Text: "你好"}, `{"type":"delta","text":"你好"}`},
		{Event{Type: EventTool, ID: "t1", Name: "Write", Detail: "a.md"},
			`{"type":"tool","id":"t1","name":"Write","detail":"a.md"}`},
		// detail 为空也必须出现：前端的类型说它是 string，不是 string | undefined。
		{Event{Type: EventTool, ID: "t2", Name: "Read"},
			`{"type":"tool","id":"t2","name":"Read","detail":""}`},
		{Event{Type: EventToolResult, ID: "t1", Name: "Write", OK: true},
			`{"type":"tool_result","id":"t1","name":"Write","ok":true,"error":""}`},
		{Event{Type: EventToolResult, ID: "t2", Name: "Read", Message: "没权限"},
			`{"type":"tool_result","id":"t2","name":"Read","ok":false,"error":"没权限"}`},
		{Event{Type: EventDone, RunID: "run_1", ExitCode: 0}, `{"type":"done","run_id":"run_1","exit_code":0}`},
		{Event{Type: EventError, Message: "炸了"}, `{"type":"error","message":"炸了"}`},
	}
	for _, c := range cases {
		b, err := json.Marshal(c.ev)
		if err != nil {
			t.Fatalf("marshal %v: %v", c.ev, err)
		}
		if string(b) != c.want {
			t.Errorf("got %s\nwant %s", b, c.want)
		}
	}
}

// --- 提示词 ---

func TestBuildPromptOmitsEmptyFields(t *testing.T) {
	got := BuildPrompt(Task{
		Ref: "TSK-0042", TypeName: "待办", Title: "把日报脚本补上",
		Body: "每天 9 点跑一次。", Status: "进行中", Priority: "P1",
		DueAt: "2026-09-20", Links: []string{"blocks：REQ-0001 日报模板"},
		Workdir: "/tmp/demo", Extra: "先别提交",
	})
	for _, want := range []string{
		"TSK-0042", "待办", "把日报脚本补上", "每天 9 点跑一次。",
		"进行中", "P1", "2026-09-20", "REQ-0001 日报模板", "/tmp/demo", "先别提交",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("提示词缺少 %q:\n%s", want, got)
		}
	}

	bare := BuildPrompt(Task{Title: "只有标题", Workdir: "/tmp/demo"})
	// 空着的「优先级：」只会让模型去猜一个并不存在的约束。
	for _, gone := range []string{"编号：", "优先级：", "到期：", "关联：", "任务描述", "补充要求"} {
		if strings.Contains(bare, gone) {
			t.Errorf("字段为空时 %q 整行应该消失:\n%s", gone, bare)
		}
	}
	if !strings.Contains(bare, "只有标题") {
		t.Error("标题必须在")
	}
}

// --- 真调 claude 的冒烟 ---

// TestSmokeRealClaude 是唯一一条真的起 claude 的测试：-short 跳过，
// 本机没装也跳过。它验证的是「我们拼的命令行和真 CLI 对得上」，
// 这件事只有真 CLI 能回答；其余所有行为都由打桩的测试覆盖。
func TestSmokeRealClaude(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：不调外部 CLI")
	}
	bin, err := exec.LookPath(DefaultBin)
	if err != nil {
		t.Skip("本机没装 claude")
	}

	// 一次性目录，绝不能指到这个项目：claude 会在 cmd.Dir 里真的动手。
	wd, err := os.MkdirTemp("", "pmw-run-smoke-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(wd) })

	r := &Runner{Bin: bin, Timeout: 3 * time.Minute}
	var evs []Event
	res, err := r.Start(context.Background(), Request{
		RunID:   "run_smoke",
		Workdir: wd,
		Prompt:  "只回复 OK，不要做任何事，不要创建或修改任何文件。",
	}, collect(&evs))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Logf("status=%s exit=%d events=%d\n--- output ---\n%s",
		res.Status, res.ExitCode, len(evs), res.Output)
	if res.Status != domain.RunDone {
		t.Fatalf("want done, got %s (%s)", res.Status, res.Error)
	}
	if !strings.Contains(res.Output, "OK") {
		t.Fatalf("没收到模型的回复，输出是 %q", res.Output)
	}
}

// --- 小工具 ---

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待「%s」超时（%s）", what, d)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// --- 工具结果：被拒 / 失败必须和成功长得不一样 ---

// deniedNDJSON 是实测抓下来的形状（claude 2.1.272，默认权限）：
// 工具被拒时 tool_result.is_error=true，同时 result 行带一份 permission_denials，
// 而 result 行自己的 is_error 是 false、进程退出码是 0。
const deniedNDJSON = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_a","name":"Write","input":{"file_path":"/tmp/e2e/out/NOTE.md"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Claude requested permissions to write to /tmp/e2e/out/NOTE.md, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_a"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"没有写入权限，NOTE.md 未创建。"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"没有写入权限。","permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_a","tool_input":{"file_path":"/tmp/e2e/out/NOTE.md"}}]}`

func TestDeniedToolIsNotReportedAsSuccess(t *testing.T) {
	r, req := newRun(t, "cat <<'EOF'\n"+deniedNDJSON+"\nEOF")

	var evs []Event
	res, err := r.Start(context.Background(), req, collect(&evs))
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	// 进程本身一切正常——这正是这个坑的可怕之处。
	if res.ExitCode != 0 {
		t.Fatalf("前提变了：claude 在工具被拒时是以 0 退出的，got %d", res.ExitCode)
	}
	// 但任务没做成，不能报成功。
	if res.Status != domain.RunFailed {
		t.Fatalf("工具全被拒还报 %s，界面上就是一个绿色的「完成」加一个空目录", res.Status)
	}
	if len(res.Denials) != 1 || res.Denials[0].ToolName != "Write" {
		t.Fatalf("没把被拒的调用挑出来：%+v", res.Denials)
	}
	// 这句话是用户唯一的指引，必须自带解法。
	for _, want := range []string{"Write", "只读执行", "允许修改文件"} {
		if !strings.Contains(res.Error, want) {
			t.Errorf("提示缺少 %q：%s", want, res.Error)
		}
	}

	// 事件流里，被拒的调用必须和成功的区分得开。
	var tool, result *Event
	for i := range evs {
		switch evs[i].Type {
		case EventTool:
			tool = &evs[i]
		case EventToolResult:
			result = &evs[i]
		}
	}
	if tool == nil || result == nil {
		t.Fatalf("tool 与 tool_result 都要有，got %v", evs)
	}
	if tool.ID == "" || tool.ID != result.ID {
		t.Fatalf("两条事件要能靠 id 配对：tool=%q result=%q", tool.ID, result.ID)
	}
	if result.OK {
		t.Fatal("被拒的调用 ok 必须是 false")
	}
	if result.Name != "Write" {
		t.Errorf("tool_result 要补上工具名（那一行原始 JSON 里只有 id），got %q", result.Name)
	}
	if !strings.Contains(result.Message, "permissions") {
		t.Errorf("要带上被拒的原文，got %q", result.Message)
	}
	// 落库的过程记录里也要留下失败，否则事后复查看不出它为什么没做成。
	if !strings.Contains(res.Output, "[工具失败] Write") {
		t.Errorf("过程记录里没有失败痕迹：\n%s", res.Output)
	}
}

// 成功的工具调用不该被当成失败，也不该往过程记录里塞噪音。
func TestSuccessfulToolResult(t *testing.T) {
	const ok = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_b","name":"Write","input":{"file_path":"NOTE.md"}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_b","type":"tool_result","content":"File created successfully at: /tmp/x/NOTE.md"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"建好了","permission_denials":[]}`
	r, req := newRun(t, "cat <<'EOF'\n"+ok+"\nEOF")

	var evs []Event
	res, err := r.Start(context.Background(), req, collect(&evs))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Status != domain.RunDone {
		t.Fatalf("want done, got %s (%s)", res.Status, res.Error)
	}
	var result *Event
	for i := range evs {
		if evs[i].Type == EventToolResult {
			result = &evs[i]
		}
	}
	if result == nil || !result.OK || result.Message != "" {
		t.Fatalf("成功的 tool_result 应当 ok=true 且没有错误文本，got %+v", result)
	}
	if strings.Contains(res.Output, "[工具失败]") {
		t.Error("成功的调用不该在过程记录里留失败行")
	}
}

// 工具自己失败（bash 退出码非 0 之类）在 agent 干活时是家常便饭，
// 不能拿它判定整次执行失败——否则几乎每次执行都是红的。
// 只有 permission_denials 才是「我们挡住了它」。
func TestOrdinaryToolFailureDoesNotFailTheRun(t *testing.T) {
	const flaky = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_c","name":"Bash","input":{"command":"go test ./..."}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_c","type":"tool_result","content":"FAIL: 一个用例没过","is_error":true}]}}
{"type":"result","subtype":"success","is_error":false,"result":"修好了","permission_denials":[]}`
	r, req := newRun(t, "cat <<'EOF'\n"+flaky+"\nEOF")

	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Status != domain.RunDone {
		t.Fatalf("工具自己失败不等于整次执行失败，got %s (%s)", res.Status, res.Error)
	}
}

func TestDenialReasonDependsOnAllowWrites(t *testing.T) {
	denials := []Denial{{ToolName: "Write"}, {ToolName: "Edit"}, {ToolName: "Write"}}

	readonly := denialReason(denials, Request{}, false)
	if !strings.Contains(readonly, "允许修改文件") {
		t.Errorf("只读模式要告诉用户去勾开关：%s", readonly)
	}
	// 同一个工具被拒两次，列两遍没有任何信息量。
	if strings.Count(readonly, "Write") != 1 {
		t.Errorf("工具名要去重：%s", readonly)
	}
	if !strings.Contains(readonly, "3 个") {
		t.Errorf("次数仍然要如实报：%s", readonly)
	}
	// 编辑被拒靠档位放开，不该叫用户把 Write 加进白名单。
	if strings.Contains(readonly, "建议放行") {
		t.Errorf("文件编辑不进白名单：%s", readonly)
	}

	allowed := denialReason(denials, Request{AllowWrites: true}, false)
	if strings.Contains(allowed, "请在发起时勾选") {
		t.Errorf("开关已经打开了，再叫用户去勾就是错的指引：%s", allowed)
	}
	if !strings.Contains(allowed, "settings.json") {
		t.Errorf("这时该指向用户自己的权限配置：%s", allowed)
	}

	// 有别的调用成功了，就不能断言整件事没做成——claude 会绕路。
	partial := denialReason(denials, Request{}, true)
	if strings.Contains(partial, "任务没有真正完成") {
		t.Errorf("部分被拒时不能断言任务没完成：%s", partial)
	}
	if !strings.Contains(partial, "允许修改文件") {
		t.Errorf("解法仍然要给：%s", partial)
	}
}

// TSK-0499：被拒的命令和 MCP 工具要列出来，并给出可以直接加进白名单的规则（前端认「建议放行：`…`」）。
func TestDenialReasonSuggestsRules(t *testing.T) {
	denials := []Denial{
		{ToolName: "Bash", ToolInput: map[string]any{"command": `sqlite3 -readonly "file:data-dev/pm.db?mode=ro" ".tables" | head -5`}},
		{ToolName: "Bash", ToolInput: map[string]any{"command": "git commit -m x && make deploy"}},
		{ToolName: "mcp__other__do_thing"},
	}
	req := Request{AllowWrites: true, Permission: PermAcceptEdits, AllowedTools: PermAllowed(PermAcceptEdits, nil)}
	msg := denialReason(denials, req, false)
	for _, want := range []string{
		"被拒的命令：sqlite3 -readonly", "建议放行：", "sqlite3 -readonly -safe", "`Bash(git commit:*)`",
		"`Bash(make deploy:*)`", "`mcp__other__do_thing`", "设置 / 执行权限", "「允许改文件」",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("提示缺少 %q：%s", want, msg)
		}
	}
	// head 已在默认白名单里，不是被拒的原因；sqlite3 不给裸的 Bash(sqlite3:*)。
	for _, bad := range []string{"`Bash(head:*)`", "`Bash(sqlite3:*)`"} {
		if strings.Contains(msg, bad) {
			t.Errorf("不该建议 %s：%s", bad, msg)
		}
	}
}

// 被拒了，但别的工具调用成功了：claude 绕过去把事做成了（Write 被拒改用 Bash
// 重定向，实测见过）。这种不能判失败——否则真正干成事的执行会被标红。
func TestPartialDenialStaysDoneButKeepsTheWarning(t *testing.T) {
	const mixed = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"hello.md"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","is_error":true,"content":"requested permissions to write"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"printf hello > hello.md"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu2","content":"done"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"建好了","permission_denials":[{"tool_name":"Write","tool_use_id":"tu1"}]}`
	r, req := newRun(t, "cat <<'EOF'\n"+mixed+"\nEOF")

	res, err := r.Start(context.Background(), req, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if res.Status != domain.RunDone {
		t.Fatalf("有调用成功就不该判失败，got %s (%s)", res.Status, res.Error)
	}
	// 但仍然要留一句：绕过去了不等于做的和你要的一样。
	if !strings.Contains(res.Error, "Write") {
		t.Errorf("被挡下的部分仍要如实说明：%q", res.Error)
	}
	if strings.Contains(res.Error, "任务没有真正完成") {
		t.Errorf("措辞不能断言整件事没做成：%q", res.Error)
	}
}

// --- 命令行 ---

func TestBuildArgs(t *testing.T) {
	ro := buildArgs("做点什么", false)
	want := []string{"-p", "做点什么", "--output-format", "stream-json", "--verbose"}
	if len(ro) != len(want) {
		t.Fatalf("只读模式 argv = %q，want %q", ro, want)
	}
	for i := range want {
		if ro[i] != want[i] {
			t.Fatalf("只读模式 argv = %q，want %q", ro, want)
		}
	}

	rw := strings.Join(buildArgs("做点什么", true), " ")
	// acceptEdits 只放开文件编辑；--dangerously-skip-permissions 连命令执行也放开，
	// 而用户勾的是「允许修改文件」，不是「允许干任何事」。
	if !strings.Contains(rw, "--permission-mode acceptEdits") {
		t.Errorf("allow_writes 应当传 --permission-mode acceptEdits，got %q", rw)
	}
	if strings.Contains(rw, "dangerously") {
		t.Errorf("任何情况下都不该传 --dangerously-skip-permissions，got %q", rw)
	}
}

func TestStartEventJSON(t *testing.T) {
	b, err := json.Marshal(Event{Type: EventStart, RunID: "run_1", Workdir: "/tmp/x"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"start","run_id":"run_1","workdir":"/tmp/x"}`
	if string(b) != want {
		t.Fatalf("got %s\nwant %s", b, want)
	}
}
