// Package runner 把一个工作对象交给本机的 claude CLI 去执行。
//
// 它只做四件事：拼提示词、起进程、把 stream-json 翻成界面能用的事件、
// 保证这个进程最后一定会死。没有重试、没有队列、没有并发上限——
// 这是个人工具，同时跑两个任务已经是极限，加调度只会让「为什么它没动」
// 变成一个需要看日志才能回答的问题。
//
// 两条不可让步的约束：
//
//   - 工作目录必填且实测可写。空目录会让 claude 落到进程的当前目录，
//     也就是工作台自己的源码目录里改文件。见 checkWorkdir。
//   - 取消必须杀掉整个进程组。claude 会拉起子进程（bash、子 agent、MCP server），
//     只 kill 父进程会留下一地孤儿继续跑、继续写盘。见 process.kill。
//
// 本包依赖 POSIX 的进程组语义，只在 macOS / Linux 上构建。
package runner

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

const (
	// DefaultBin 走 PATH 查找，用户装在哪都行。
	DefaultBin = "claude"

	// DefaultTimeout 是单次执行的上限。十分钟足够 claude 做完一件正经事，
	// 又不至于让一次跑飞的执行占着资源到天亮。
	DefaultTimeout = 10 * time.Minute

	// DefaultMaxOutput 是落库输出的上限。超过它就截断，完整输出写进工作区。
	DefaultMaxOutput = 1 << 20 // 1 MiB

	// captureCap 是内存里最多攒的输出。跑飞的进程能在几分钟内吐出几个 G，
	// 上限之外的内容直接丢弃——反正落库的只有前 1 MB。
	captureCap = 64 << 20

	// stderrCap 只为了出错时能说清原因，不需要留全。
	stderrCap = 8 << 10

	// maxLineBytes 是单行 NDJSON 的上限。claude 的一条 tool_result 可能很大，
	// 但没有任何理由超过这个数；超出的部分丢掉，不让一行把内存吃穿。
	maxLineBytes = 4 << 20

	// killGrace 是 SIGTERM 到 SIGKILL 之间给进程的收尾时间。
	killGrace = 3 * time.Second

	// runLogDir 是完整输出在工作区里的落脚点。带前缀是为了一眼看出不是用户的文件。
	runLogDir = ".pmw-runs"
)

// --- 事件 ---

const (
	EventStart      = "start"
	EventDelta      = "delta"
	EventTool       = "tool"
	EventToolResult = "tool_result"
	EventDone       = "done"
	EventError      = "error"
	// EventArtifact 在执行收尾时发，每登记一件产物一条。
	// 不等用户下次打开产物页才告诉他：这次执行到底产出了什么，
	// 是他盯着这条流最想知道的事。
	EventArtifact = "artifact"
	// EventConfirm / EventDecision 只有 harness=agent（TSK-0460）会发：Agent 要做一次需要人确认的写操作，
	// 执行停下等（记录状态 waiting）；确认、拒绝或等待超时后发 decision，接着跑。
	EventConfirm  = "confirm"
	EventDecision = "decision"
)

// Event 是推给前端的一条流事件，字段契约见 web/src/lib/types.ts 的 TaskRunEvent。
//
// tool 与 tool_result 是分开的两条，靠 ID 配对。合成一条（等结果出来再发）会更省事，
// 但那样界面在一条跑 60 秒的 Bash 期间什么都看不到——实时感正是 tool 事件存在的理由。
// 分开还有一个好处：进程被取消时，已经发出去的 tool 收不到配对的 tool_result，
// 界面上它就停在「进行中」，这是诚实的；合成一条的话它会干脆消失，
// 用户看不出 claude 当时正卡在哪一步。
//
// 各种事件的字段集合互不相同，所以自己实现 MarshalJSON 而不是靠 omitempty：
// omitempty 会让 detail 为空的 tool 事件丢掉 detail 字段（前端拿到 undefined），
// 而不带 omitempty 又会给每条 delta 都挂上一串空字段。这里是前后端契约的边界，
// 值得写这几行。
type Event struct {
	Type     string
	Text     string // delta
	ID       string // tool / tool_result，配对用
	Name     string // tool / tool_result
	Detail   string // tool
	OK       bool   // tool_result
	RunID    string // start / done
	Workdir  string // start
	ExitCode int    // done
	// Message 在 error 上是失败原因，在 tool_result 上是这次工具调用的错误文本。
	Message string

	// 以下仅 artifact 事件使用。Path 是相对 workdir 的路径（界面上显示它），
	// ArtifactID 给前端做跳转。
	ArtifactID string
	Path       string
	Size       int64
	IsNew      bool

	// 以下仅 harness=agent（TSK-0460）使用。SessionID 在 start 上是这次用的 Agent 会话；
	// Summary 在 tool_result 上是给人看的结果一句话、在 confirm 上是要确认的操作；Args 是 confirm 的参数原文；
	// Deadline 是 confirm 等到什么时候按拒绝处理；Approved、Reason（user / timeout）在 decision 上。
	SessionID string
	Summary   string
	Args      string
	Deadline  time.Time
	Approved  bool
	Reason    string
}

func (e Event) MarshalJSON() ([]byte, error) {
	switch e.Type {
	case EventStart:
		if e.SessionID != "" {
			return jsonObject("type", EventStart, "run_id", e.RunID, "workdir", e.Workdir, "session_id", e.SessionID)
		}
		return jsonObject("type", EventStart, "run_id", e.RunID, "workdir", e.Workdir)
	case EventDelta:
		return jsonObject("type", EventDelta, "text", e.Text)
	case EventTool:
		return jsonObject("type", EventTool, "id", e.ID, "name", e.Name, "detail", e.Detail)
	case EventToolResult:
		if e.Summary != "" {
			return jsonObject("type", EventToolResult, "id", e.ID, "name", e.Name,
				"ok", e.OK, "error", e.Message, "summary", e.Summary)
		}
		return jsonObject("type", EventToolResult, "id", e.ID, "name", e.Name,
			"ok", e.OK, "error", e.Message)
	case EventDone:
		return jsonObject("type", EventDone, "run_id", e.RunID, "exit_code", e.ExitCode)
	case EventError:
		return jsonObject("type", EventError, "message", e.Message)
	case EventArtifact:
		return jsonObject("type", EventArtifact, "artifact_id", e.ArtifactID,
			"path", e.Path, "size", e.Size, "is_new", e.IsNew)
	case EventConfirm:
		return jsonObject("type", EventConfirm, "id", e.ID, "name", e.Name, "args", e.Args,
			"summary", e.Summary, "deadline", e.Deadline.UTC().Format(time.RFC3339))
	case EventDecision:
		return jsonObject("type", EventDecision, "id", e.ID, "approved", e.Approved, "reason", e.Reason)
	}
	return nil, fmt.Errorf("unknown run event type %q", e.Type)
}

// --- 请求与结果 ---

type Request struct {
	RunID   string // 执行记录的 ID，同时用作取消的句柄和日志文件名
	Workdir string // 绝对路径，必填
	Prompt  string // 完整提示词，由 BuildPrompt 产出
	Timeout time.Duration

	// AllowWrites 决定要不要放开文件编辑，默认 false（只读）。
	//
	// 这是一个必须由用户显式勾选的开关，不能默认开、更不能偷偷开：
	// 从工作台发起的执行会在用户的真实目录里动手，那个决定只能用户自己做。
	// 但默认只读也不能就这么算了——什么都改不了的执行等于功能不可用，
	// 所以被拒的工具调用会被检出来并在结尾明确告诉用户该勾哪个开关，
	// 见 denialReason。
	AllowWrites bool

	// MCPConfig 可选，额外的 MCP 配置文件（--mcp-config）：插件运行回写结论用（AUTO-01），
	// 任务的后台执行也用它接上工作台 MCP（TSK-0499，见 mcp.go）。
	// AllowedTools 是不用确认就能调的工具（--allowedTools）：工作台 MCP 加上档位的命令白名单（permissions.go）。
	MCPConfig    string
	AllowedTools []string

	// Permission 是这次的权限档位（permissions.go），只用在被拒提示里说「这次是哪一档」；
	// 真正生效的是 AllowWrites 和 AllowedTools。空按 AllowWrites 推（只读 / 允许改文件）。
	Permission string

	// Harness 指定这次交给谁跑，空由 Runner.Harness 决定，两者都空是 claude。
	//
	// 单次覆盖而不是全局配置：同一个工作台上，「改代码」这类活给 claude，
	// 「读需求写方案」这类活给 DeepSeek，是同时存在的两种情况。
	Harness Harness
	// DeepSeek 只在 Harness 是 deepseek 时用：模型路由。为 nil 时直接回
	// 「先配服务商」，不会退回 claude——那会让用户以为自己换了模型其实没换。
	DeepSeek *DeepSeekRoute
	// SessionID 只在 Harness 是 deepseek 时用：接着这个会话继续跑。
	// 空表示新开一个。未知 id 会让 dsh 直接失败，不会悄悄换成新会话。
	SessionID string
}

// Result 是一次执行的收尾信息，调用方据此落库。
//
// Start 返回 (*Result, error) 而不是只返回 error：这次执行的价值在过程，
// 退出码、完整输出、是超时还是取消，都得原样交回给调用方去存。
// 把它们塞进 error 的文案里，落库的那一步就只能靠解析字符串还原。
type Result struct {
	Status    string // domain.RunDone / RunFailed / RunCanceled
	ExitCode  int
	Output    string // 已按 MaxOutput 截断，可直接落库
	Error     string // 失败原因，成功时为空
	Truncated bool
	LogPath   string // 截断时完整输出的落盘位置

	// Denials 是被权限策略挡下来的工具调用。它非空时这次执行一律算失败——
	// 哪怕 claude 自己以退出码 0 正常结束（它确实会这么做）。
	// 退出码只说明「进程正常退出」，不说明「任务做成了」。
	Denials []Denial

	// SessionID 是 dsh 这次用的会话 id（0.2.x 的新会话形如 session-<uuid>）。
	// 落库之后下一次可以带上它接着跑；claude 没有这个概念，留空。
	SessionID string
}

// --- Runner ---

type Runner struct {
	Bin       string        // claude 可执行文件，空则走 PATH
	Timeout   time.Duration // 空则用 DefaultTimeout
	MaxOutput int           // 空则用 DefaultMaxOutput
	Logger    *slog.Logger

	// Harness 是这个 Runner 的默认执行器，空是 claude；单次请求可以在
	// Request.Harness 里覆盖它。取消、并发登记、残留判定不区分执行器：
	// 它们靠 runID，而 runID 全库唯一。
	Harness Harness
	// DSHBin 是 dsh 可执行文件，空则走 PATH。和 Bin 分开是因为两者常常
	// 一个在 PATH 里、另一个装在不常见的位置（npx 装的、nvm 下的）。
	DSHBin string

	mu   sync.Mutex
	live map[string]*process
}

func (r *Runner) logger() *slog.Logger {
	if r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func (r *Runner) maxOutput() int {
	if r.MaxOutput > 0 {
		return r.MaxOutput
	}
	return DefaultMaxOutput
}

// Running 报告某次执行是不是还活着。API 层用它区分「正在跑」和
// 「库里写着 running 但进程早没了」（服务重启过）。
func (r *Runner) Running(runID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.live[runID]
	return ok
}

// Cancel 取消一次执行，返回是否真的找到了对应的活进程。
// 它只是发出请求就返回，不等进程真的死——调用方（HTTP handler）不该
// 为了一个取消动作被 SIGTERM 的宽限期堵住三秒。真正的收尾由 Start 那一侧完成。
func (r *Runner) Cancel(runID string) bool {
	r.mu.Lock()
	p, ok := r.live[runID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	p.requestCancel()
	return true
}

func (r *Runner) register(runID string, p *process) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.live == nil {
		r.live = map[string]*process{}
	}
	if _, dup := r.live[runID]; dup {
		return &invalid{msg: "这次执行已经在跑了", sentinel: domain.ErrConflict}
	}
	r.live[runID] = p
	return nil
}

func (r *Runner) unregister(runID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.live, runID)
}

// Start 同步跑完一次执行：起进程、边读边回调、收尾。它会阻塞到进程结束。
//
// on 只收到 delta 与 tool 两种事件。done / error 由调用方在落库之后自己发——
// 只有它知道记录有没有真的存下来，而前端看到 done 就认为「这次执行已经留痕」了。
//
// 返回 error 只有一种情况：进程根本没起来（参数不合法、目录不可用、找不到 claude）。
// 一旦进程起来了，无论它怎么死，都走 (*Result, nil)。
func (r *Runner) Start(ctx context.Context, req Request, on func(Event)) (*Result, error) {
	if on == nil {
		on = func(Event) {}
	}

	runID := strings.TrimSpace(req.RunID)
	if runID == "" {
		return nil, validationErr("run_id 不能为空")
	}
	if runID != filepath.Base(runID) || strings.Contains(runID, "..") {
		// runID 会被拼进落盘路径，不能让它带上路径片段。
		return nil, validationErr("run_id 不合法")
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return nil, validationErr("提示词不能为空")
	}
	workdir, err := checkWorkdir(req.Workdir)
	if err != nil {
		return nil, err
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = r.Timeout
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	bin := r.Bin
	if bin == "" {
		bin = DefaultBin
	}

	// 选执行器。harness 决定后面的一切：命令行、怎么读流、失败文案里叫什么名字。
	h := req.Harness
	if h == "" {
		h = r.Harness
	}
	var spec cmdSpec
	switch h {
	case HarnessDeepSeek:
		spec, err = r.prepareDSH(req, prompt, workdir)
		if err != nil {
			return nil, err
		}
	default:
		spec = cmdSpec{
			bin:  bin,
			name: "claude",
			hint: "请确认本机已安装 Claude Code",
			args: claudeArgs(req, prompt, workdir),
			read: readStream,
		}
	}
	if spec.cleanup != nil {
		// 临时配置（dsh 的 patch）跟着这一次执行走，进程退了就删。
		defer spec.cleanup()
	}

	cmd := exec.Command(spec.bin, spec.args...)
	cmd.Dir = workdir
	// 关键：让子进程自成一个进程组，取消时才能一次干掉它拉起的所有后代。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if len(spec.env) > 0 {
		// 显式的环境变量接在父进程环境后面：同名的以后者为准，这是 exec 的语义。
		cmd.Env = append(os.Environ(), spec.env...)
	}
	if spec.stdin != "" {
		cmd.Stdin = strings.NewReader(spec.stdin)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("open stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, validationErr("找不到 " + spec.name + " 可执行文件（" + spec.bin + "），" + spec.hint)
		}
		return nil, fmt.Errorf("启动 %s 失败：%w", spec.name, err)
	}

	// Setpgid 让子进程成为新进程组的组长，pgid 就等于它的 pid。
	// 不用 Getpgid 去问：进程被回收之后那个调用会失败，而失败的兜底
	// （退回用 pid）正好是最危险的一种——pid 可能已经被系统分配给别的进程了。
	p := &process{pgid: cmd.Process.Pid, stop: make(chan struct{})}
	if err := r.register(runID, p); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	defer r.unregister(runID)

	done := make(chan struct{})
	var timedOut atomic.Bool

	go func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-done:
			return
		case <-p.stop: // 显式取消
		case <-ctx.Done(): // 调用方放弃了
			p.canceled.Store(true)
		case <-timer.C:
			timedOut.Store(true)
		}
		// 先礼后兵：SIGTERM 给进程一个把文件写完的机会，不听话再 SIGKILL。
		p.kill(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(killGrace):
			p.kill(syscall.SIGKILL)
		}
	}()

	errBuf := &capped{max: stderrCap}
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(errBuf, stderr)
	}()

	out := &capped{max: captureCap}
	stream := spec.read(stdout, out, on)

	// StdoutPipe 的约定：必须读到 EOF 之后才能 Wait，否则 Wait 会把管道关掉。
	<-stderrDone
	waitErr := cmd.Wait()
	p.markReaped()
	close(done)

	return r.finish(finishInput{
		req:      req,
		runID:    runID,
		workdir:  workdir,
		output:   out.String(),
		stderr:   errBuf.String(),
		exitCode: exitCodeOf(waitErr),
		timeout:  timeout,
		canceled: p.canceled.Load(),
		timedOut: timedOut.Load(),
		stream:   stream,
		name:     spec.name,
	}), nil
}

// cmdSpec 是「这次执行要起什么进程、怎么读它」的完整描述。
//
// 抽成结构体是为了让两个执行器的差异只出现在一个地方：参数怎么拼、
// 流怎么读、失败时叫什么名字。Start 里剩下的部分（进程组、超时、
// 取消、截断、落库）对 claude 和 dsh 是同一套，不该复制两份。
type cmdSpec struct {
	bin     string
	args    []string
	env     []string // 追加到父进程环境后面，空表示不追加
	stdin   string   // 非空时喂给子进程的 stdin（dsh 的任务文本走这里）
	name    string   // 给人看的执行器名字，用在报错文案里
	hint    string   // 找不到可执行文件时的补救办法
	read    func(io.Reader, io.Writer, func(Event)) streamOutcome
	cleanup func() // 收尾清理，nil 表示没有
}

// claudeArgs 拼 claude 的命令行，含请求里的可选参数。
func claudeArgs(req Request, prompt, workdir string) []string {
	args := buildArgs(prompt, req.AllowWrites, LinkedDirs(workdir)...)
	if req.MCPConfig != "" {
		args = append(args, "--mcp-config", req.MCPConfig)
	}
	for _, t := range req.AllowedTools {
		args = append(args, "--allowedTools", t)
	}
	return args
}

// buildArgs 拼实际执行的命令行。抽成函数是为了让「生产参数长什么样」
// 有一个能一眼读完、能被测试直接盯住的地方，而不是散在 Start 里的一串字面量。
//
// 默认不传任何放宽权限的参数：claude 用它自己的权限策略，用户的
// ~/.claude/settings.json 说了算，我们不替用户放宽安全边界。
//
// allowWrites 为 true 时传 --permission-mode acceptEdits，只放开文件编辑。
// 不用 --dangerously-skip-permissions：那个连命令执行也一起放开，
// 而用户在界面上勾的是「允许修改文件」，不是「允许干任何事」。
//
// addDirs 是工作目录里软链接指向的外部目录（LinkedDirs）：claude 只许访问工作目录，
// 软链接进来的目录实际路径在外面，不加 --add-dir 读不到（SPEC-tasks-6.19）。每个目录单独一个 --add-dir，
// 不写成一个 --add-dir 跟多个值：它是可变参数，后面的参数会被吞进去。
func buildArgs(prompt string, allowWrites bool, addDirs ...string) []string {
	args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose"}
	if allowWrites {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	for _, d := range addDirs {
		args = append(args, "--add-dir", d)
	}
	return args
}

// finishInput 把收尾需要的一堆东西装一起。参数多到要靠位置去数的时候，
// 调换两个 bool 就是一个测不出来的 bug。
type finishInput struct {
	req            Request
	runID, workdir string
	output, stderr string
	exitCode       int
	timeout        time.Duration
	canceled       bool
	timedOut       bool
	stream         streamOutcome
	name           string // 执行器名字，只用在失败文案里
}

// finish 把进程的死法翻译成一条可以落库的记录。
func (r *Runner) finish(in finishInput) *Result {
	res := &Result{ExitCode: in.exitCode, Denials: in.stream.denials, SessionID: in.stream.sessionID}
	switch {
	case in.canceled:
		// 取消优先于超时和退出码：用户按了取消，进程当然是被信号杀死的，
		// 但那不是「失败」，把它记成 failed 只会让历史列表看起来全是红的。
		res.Status = domain.RunCanceled
		res.Error = "执行已被取消"
	case in.timedOut:
		res.Status = domain.RunFailed
		res.Error = fmt.Sprintf("执行超时（超过 %s），进程已被终止", in.timeout)
	case in.stream.sandboxDown && in.stream.okTools == 0:
		// 沙箱后端起不来，dsh 会拒绝在无隔离的情况下跑命令。这不是「任务没做成」，
		// 是这台机器的环境没准备好——把它说成任务失败，用户会去改提示词而不是装后端。
		res.Status = domain.RunFailed
		res.Error = "dsh 的沙箱后端在这台机器上起不来，它拒绝在没有隔离的情况下执行命令，" +
			"所以这次什么都没干成。装一个可用的沙箱后端再重试（Linux 用 bubblewrap 或启用 Landlock 的内核，" +
			"macOS 要求 sandbox-exec 可用），或者改用 Claude Code 执行器。原始报错：" +
			oneLine(in.stream.sandboxMsg, 200)
	case in.stream.writeDenials > 0 && in.stream.okTools == 0 && in.req.AllowWrites:
		// 已经勾了「允许修改文件」还被拒，那说明写的是工作区之外的地方。
		res.Status = domain.RunFailed
		res.Error = fmt.Sprintf("这次执行有 %d 次写入被 dsh 的沙箱拒绝，任务没有真正完成。"+
			"「允许修改文件」已经打开，所以这些路径不在工作区里；"+
			"把目标目录设成工作区，或者在「%s」里放一个指向它的软链接（工作台会把软链目标加成可写目录）。",
			in.stream.writeDenials, in.workdir)
	case in.stream.writeDenials > 0 && in.stream.okTools == 0:
		// 和 claude 那条同一个道理：只读执行里「一个字都没写进去」必须判失败，
		// 不能因为 dsh 正常收尾、退出码是 0 就显示完成。
		res.Status = domain.RunFailed
		res.Error = fmt.Sprintf("这次执行有 %d 次写入被 dsh 的沙箱拒绝（本次是只读执行，沙箱档位 read-only），"+
			"任务没有真正完成。要让它改文件，请在发起时勾选「允许修改文件」。", in.stream.writeDenials)
	case len(in.stream.denials) > 0 && in.stream.okTools == 0:
		// 这一支必须排在「退出码为 0 就算成功」前面。
		//
		// claude 在工具被权限策略拒绝时，会好好地解释一句然后以退出码 0、
		// is_error=false 正常结束——从进程的角度看这次执行完美无缺，
		// 但用户要的文件一个都没建。只看退出码的话，界面会显示一个绿色的
		// 「完成」配一个空目录。这是这个功能最容易骗到人的一种失败。
		//
		// 条件里带上 okTools == 0 是必要的：有调用被拒、但别的调用成功了，
		// 说明 claude 绕过去把事做成了（Write 被拒就改用 Bash 重定向，实测见过）。
		// 那种一律判失败会把真正干成事的执行标红，比漏报更烦人。
		res.Status = domain.RunFailed
		res.Error = denialReason(in.stream.denials, in.req, false)
	case in.exitCode == 0 && !in.stream.finalErr:
		res.Status = domain.RunDone
		if len(in.stream.denials) > 0 {
			// 做成了，但路上有东西被挡。状态是 done，Error 里仍要留一句——
			// 「它绕过去了」不等于「它做的和你要的一样」，用户有权知道。
			res.Error = denialReason(in.stream.denials, in.req, true)
		}
	default:
		res.Status = domain.RunFailed
		res.Error = failureReason(in.exitCode, firstNonEmpty(in.stream.finalText, in.stream.turnReason), in.stderr, in.name)
	}

	res.Output, res.Truncated = truncate(in.output, r.maxOutput())
	if res.Truncated {
		path, err := writeRunLog(in.workdir, in.runID, in.output)
		if err != nil {
			r.logger().Warn("write run log failed", "run", in.runID, "workdir", in.workdir, "err", err)
			res.Output += truncNotice + "（完整输出写盘失败：" + err.Error() + "）"
		} else {
			res.LogPath = path
			res.Output += truncNotice + "完整输出见 " + path
		}
	}
	return res
}

// denialReason 说清「它想做什么、被什么挡住了、你该点哪里」。
//
// 不能只说「有工具调用被拒绝」——用户看不懂那是什么意思，也不知道下一步做什么。
// 这句话是他唯一能看到的指引，必须自带解法（TSK-0499）：
//   - 列出被拒的工具，Bash 带上命令原文（截短），一眼看出是哪条命令；
//   - 文件编辑被拒且这次是只读：叫用户勾「允许修改文件」（选一个写入档位）；
//   - 其余能靠白名单放行的：给出规则，固定写成「建议放行：`规则`、`规则`。」——
//     前端认这个格式，渲染成「去设置放行」的直达入口（设置 / 执行权限，预填这些规则）。
func denialReason(denials []Denial, req Request, partial bool) string {
	names := uniqueToolNames(denials)
	tail := "任务没有真正完成。"
	if partial {
		// 别的调用成功了，不能断言整件事没做成——只能说有步骤被挡过。
		tail = "其余步骤已执行，但被挡下的部分可能没有生效。"
	}
	perm := req.Permission
	if perm == "" {
		perm = PermReadOnly
		if req.AllowWrites {
			perm = PermAcceptEdits
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "这次执行有 %d 个工具调用被权限策略拒绝（%s），%s", len(denials), strings.Join(names, "、"), tail)
	if cmds := deniedCommands(denials); len(cmds) > 0 {
		b.WriteString("被拒的命令：" + strings.Join(cmds, "；") + "。")
		if unsafeSqlite(denials) {
			b.WriteString("查库要写成 sqlite3 -readonly -safe（已在只读白名单里）；不带 -safe 时 .shell 能跑任意命令，不放行。")
		}
	}
	edits := false
	for _, d := range denials {
		if editTools[d.ToolName] {
			edits = true
		}
	}
	if edits && !req.AllowWrites {
		b.WriteString("本次为只读执行；要让它真正改文件，请在发起时勾选「允许修改文件」（选一个写入档位）。")
	}
	if rules := SuggestRules(denials, req.AllowedTools); len(rules) > 0 {
		quoted := make([]string, len(rules))
		for i, r := range rules {
			quoted[i] = "`" + r + "`"
		}
		fmt.Fprintf(&b, "本次档位「%s」没放行这些调用；建议放行：%s。到「设置 / 执行权限」把它们加进自定义白名单，发起时选「%s」档位。",
			PermLabel(perm), strings.Join(quoted, "、"), PermLabel(PermCustom))
	} else if !edits || req.AllowWrites {
		// 推不出规则、又不是只读挡了编辑：多半是用户自己的 deny 规则。
		b.WriteString("本次档位是「" + PermLabel(perm) + "」，这些调用不在工作台的放行范围内，或被你自己的权限配置挡下，请检查 ~/.claude/settings.json 和项目的 .claude/settings*.json。")
	}
	return b.String()
}

// unsafeSqlite 报告被拒的命令里有没有不带 -safe 的 sqlite3。
func unsafeSqlite(denials []Denial) bool {
	for _, d := range denials {
		cmd, _ := d.ToolInput["command"].(string)
		for _, seg := range splitCommand(cmd) {
			if f := strings.Fields(seg); len(f) > 0 && f[0] == "sqlite3" && !strings.Contains(seg, "-safe") {
				return true
			}
		}
	}
	return false
}

// deniedCommands 是被拒的 Bash 命令原文（去重、截短），最多列 5 条。
func deniedCommands(denials []Denial) []string {
	seen := map[string]bool{}
	var out []string
	for _, d := range denials {
		if d.ToolName != "Bash" {
			continue
		}
		cmd, _ := d.ToolInput["command"].(string)
		cmd = oneLine(cmd, 120)
		if cmd == "" || seen[cmd] {
			continue
		}
		if len(out) == 5 {
			out = append(out, "……")
			break
		}
		seen[cmd] = true
		out = append(out, cmd)
	}
	return out
}

// uniqueToolNames 去重并保序。同一个工具被拒十次，列十遍没有任何信息量。
func uniqueToolNames(denials []Denial) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(denials))
	for _, d := range denials {
		n := d.ToolName
		if n == "" {
			n = "未知工具"
		}
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

const truncNotice = "\n\n---\n输出过长已截断。"

// failureReason 拼一句能让用户知道下一步该看哪里的失败原因。
// 执行器自己的收尾文本最有用，其次是 stderr，最后才是光秃秃的退出码。
func failureReason(exitCode int, finalText, stderr, name string) string {
	if name == "" {
		name = "claude"
	}
	if s := strings.TrimSpace(finalText); s != "" {
		return oneLine(s, 500)
	}
	if s := strings.TrimSpace(stderr); s != "" {
		return oneLine(s, 500)
	}
	if exitCode < 0 {
		return name + " 进程被信号终止"
	}
	return fmt.Sprintf("%s 以退出码 %d 结束", name, exitCode)
}

// firstNonEmpty 取第一个非空串。dsh 失败时 final.text 是空的，原因只在 turnReason 里。
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func exitCodeOf(waitErr error) int {
	if waitErr == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		if code := ee.ExitCode(); code >= 0 {
			return code
		}
	}
	// -1 表示「不是正常退出」：被信号杀掉，或者 Wait 本身出错。
	return -1
}

// streamOutcome 是读完整条流之后攒下来的收尾信息。
type streamOutcome struct {
	finalText string
	finalErr  bool
	denials   []Denial
	// okTools 是成功的工具调用数。有它才能把「被拒之后什么都没做成」和
	// 「被拒了但换个路子做成了」分开——claude 确实会绕路（Write 被拒就改用
	// Bash 重定向），一律判失败会把真正做成事的执行标成红的。
	okTools int

	// 以下三个只有 dsh 会填。dsh 没有 claude 那种结构化的被拒清单，
	// 只能从工具失败文本里认（见 dshDeniedWrite / dshSandboxUnavailable）。
	// sandboxDown 是「沙箱后端起不来」，属环境故障，必须和任务失败分开说。
	sandboxDown  bool
	sandboxMsg   string
	writeDenials int

	// turnReason 是 dsh 一轮失败时唯一有信息量的文案：
	// 实测 final.text 在这种情况下是空串，原因只在 turn_end.reason.error.message 里。
	turnReason string

	// sessionID 是这次运行落在哪段会话上，续跑要用。
	sessionID string
}

// noteToolError 把一条工具失败按签名归类。
//
// 先认环境故障再认写入被拒：沙箱起不来的那条报错里本身就带着
// "Operation not permitted"，顺序反了就会把环境问题记成一次写入被拒。
func (so *streamOutcome) noteToolError(msg string) {
	if dshSandboxUnavailable(msg) {
		so.sandboxDown = true
		if so.sandboxMsg == "" {
			so.sandboxMsg = msg
		}
		return
	}
	if dshDeniedWrite(msg) {
		so.writeDenials++
	}
}

// readStream 逐行读 NDJSON，翻成事件回调出去，同时把可读的过程记录攒进 out。
//
// 这里维护一张 tool_use_id → 工具名的对照表：tool_result 那一行只给 id 不给名字，
// 而「哪个工具失败了」正是用户要看的。表只增不减——一次执行里的工具调用数
// 是模型的轮数决定的，不会大到需要清理。
func readStream(stdout io.Reader, out io.Writer, on func(Event)) streamOutcome {
	var so streamOutcome
	toolNames := map[string]string{}

	br := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(br, maxLineBytes)
		if len(line) > 0 {
			for _, ev := range parseLine(line) {
				switch ev.Type {
				case EventTool:
					toolNames[ev.ID] = ev.Name
				case EventToolResult:
					ev.Name = toolNames[ev.ID]
					if ev.OK {
						so.okTools++
					}
				}
				render(out, ev)
				on(ev)
			}
			if text, isErr, denials, ok := finalOf(line); ok {
				so.finalText, so.finalErr = text, isErr
				so.denials = append(so.denials, denials...)
			}
		}
		if err != nil {
			return so
		}
	}
}

// Render 同 render，给不经 Runner 的执行器（harness=agent，TSK-0460）落同一种格式的过程记录，
// 前端按同一套规则（[工具] / [工具失败] 行）解析回显示块。
func Render(w io.Writer, ev Event) { render(w, ev) }

// render 把事件写成人能读的过程记录。落库的是这一份而不是原始 NDJSON：
// 事后复查的人要读的是「它做了什么」，不是一堆 JSON。
func render(w io.Writer, ev Event) {
	switch ev.Type {
	case EventDelta:
		_, _ = io.WriteString(w, ev.Text)
	case EventTool:
		line := "\n[工具] " + ev.Name
		if ev.Detail != "" {
			line += " · " + ev.Detail
		}
		_, _ = io.WriteString(w, line+"\n")
	case EventToolResult:
		// 成功的调用不写进过程记录：每次成功都留一行「成功」，正文会被冲散。
		// 失败的必须写——事后复查时「它为什么没做成」就在这里。
		if !ev.OK {
			_, _ = io.WriteString(w, "[工具失败] "+ev.Name+" · "+ev.Message+"\n")
		}
	}
}

// readLine 读一行（不含换行符）。超过 max 的部分直接丢弃但仍会读到行尾，
// 不让一行超长的 tool_result 把内存吃穿，也不让它把后面的行挤没。
func readLine(br *bufio.Reader, max int) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if room := max - len(buf); room > 0 {
			if len(chunk) > room {
				chunk = chunk[:room]
			}
			// ReadSlice 返回的是内部缓冲区的切片，下一次读就失效，必须拷走。
			buf = append(buf, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return trimEOL(buf), err
	}
}

func trimEOL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// --- 进程 ---

type process struct {
	pgid int
	stop chan struct{}
	once sync.Once

	canceled atomic.Bool

	// mu 保护 reaped：进程被 Wait 回收之后，它的 pid 随时可能被系统
	// 分配给别的进程，这时再发信号就是在杀无辜的第三方。
	mu     sync.Mutex
	reaped bool
}

func (p *process) requestCancel() {
	p.canceled.Store(true)
	p.once.Do(func() { close(p.stop) })
}

// kill 给整个进程组发信号。负的 pid 表示进程组，这正是这个功能的要害：
// claude 会拉起 bash、子 agent、MCP server，只杀父进程会留下一地孤儿。
func (p *process) kill(sig syscall.Signal) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reaped {
		return
	}
	// pgid <= 1 时 kill(-pgid) 会打到 init 或者「当前用户的所有进程」。
	// 正常路径下不可能走到这里，但这个赌注的赔率太差，不下。
	if p.pgid <= 1 {
		return
	}
	_ = syscall.Kill(-p.pgid, sig)
}

func (p *process) markReaped() {
	p.mu.Lock()
	p.reaped = true
	p.mu.Unlock()
}

// --- 输出处理 ---

// capped 是一个到量就不再增长的缓冲区。它仍然照常「消费」写入，
// 这样上游的管道不会被堵住——堵住的话进程会卡在 write 上永远不退出。
type capped struct {
	max int
	buf strings.Builder
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

func (c *capped) String() string { return c.buf.String() }

// truncate 把输出截到 max 字节以内，并保证不切断一个 UTF-8 字符——
// 切一半的字符在界面上是一个替换符，在日志里是一段乱码。
// 预留出提示语的长度，截断后的总长仍不超过 max。
func truncate(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	limit := max - len(truncNotice) - 200 // 200 给后面那句「完整输出见 <路径>」留位置
	if limit < 0 {
		limit = 0
	}
	if limit > len(s) {
		limit = len(s)
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit], true
}

// writeRunLog 把完整输出写进工作区，供截断后回溯。
func writeRunLog(workdir, runID, content string) (string, error) {
	dir := filepath.Join(workdir, runLogDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, runID+".log")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
