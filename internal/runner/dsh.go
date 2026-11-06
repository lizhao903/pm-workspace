package runner

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// dsh 适配：把 deepseek-harness 的 headless 一次性任务模式当成第二个执行器。
//
// 为什么是 headless 而不是 `dsh acp` 或者 `dsh web`：工作台的执行模型是
// 「一个任务一个进程，跑完收尾」，headless 正好就是这个形状——stdin 进任务、
// stdout 出事件、退出码给结果、不留后台的东西。ACP 要长连接和双向 RPC，
// 那是「Agent 常驻工位」才需要的东西，不是这一层的事。
//
// 三条硬约束，和 claude 那边是同一条道理：
//
//   - 任务文本走 stdin，不走命令行。一次带上下文的提示词动辄几十 KB，
//     塞进 argv 会撞上 ARG_MAX，而且会被 ps 看见。
//   - 密钥只走进程环境。写进 patch 文件就留在磁盘上了。
//   - 进程自成一个进程组。dsh 会拉起 bash、子 agent、MCP server，
//     取消时只杀父进程会留下一地孤儿继续写盘。

const (
	// DefaultDSHBin 走 PATH 查找，用户用 npm / pnpm 装在哪都行。
	DefaultDSHBin = "dsh"

	// DefaultDSHProfile 直接用随包发布的 headless。不另建专用 profile：
	// 未知名字的 profile 不会被自动创建（实测报 "profile does not exist"），
	// 要求用户先跑一条命令去建，是把装机成本转嫁给用户；而 --patch 是**叠加**、
	// 只影响这一次执行、不写回 profile，所以跑在 headless 上不会污染用户自己的配置。
	DefaultDSHProfile = "headless"

	// dshAPIKeyEnv 是传给 dsh 的密钥环境变量名，patch 里 apiKeyEnv 指向它。
	dshAPIKeyEnv = "PMW_DSH_API_KEY"

	// dshRouteID 是 patch 里那个 provider 路由的名字。固定用 "pmw"：
	// 每次执行现生成、现用现扔，不需要让用户看见，也不会和用户自己的路由重名。
	dshRouteID = "pmw"

	// dshPatchName 是临时 patch 的文件名。
	dshPatchName = "pmw.patch.yml"

	// dshTelemetryEnv 关掉 dsh 的会话遥测（TSK-0722）。headless 下没人点反馈，按 dsh 的
	// FEEDBACK_ONLY 口径本来就不会上传；这里再显式关一次，任务正文、工作目录里的东西
	// 不该有任何一条路离开这台机器——除了发给用户自己选的模型服务商。
	dshTelemetryEnv = "DSH_TELEMETRY_MODE=DISABLED"

	// dshMCPPlugin 是 dsh 的 MCP 客户端插件包名（0.2.2 实测），patch 里按它挂工作台 MCP。
	dshMCPPlugin = "@deepseek-ai/dsh-mcp-client"

	// DSHActor 是 dsh 经工作台 MCP 写入时记的操作者名（pmw-mcp --actor）。
	DSHActor = "deepseek"
)

// dsh 的沙箱档位（sandbox-policy.mode）。
const (
	DSHReadOnly       = "read-only"
	DSHWorkspaceWrite = "workspace-write"
)

// DSHSandboxMode 把工作台的权限档位（TSK-0499，permissions.go）翻成 dsh 的沙箱档位（TSK-0722）。
//
// dsh 没有 claude 那种「按命令放行」的规则表：命令一律在它的沙箱里跑，能不能写由沙箱档位定。
// 所以对应关系是：
//
//   - read_only → read-only：命令照跑，写任何文件都会被沙箱挡下（EROFS / EPERM）；
//   - accept_edits、edits_and_tests → workspace-write：能写工作目录（和软链接进来的目录），
//     命令在沙箱里都能跑——测试、构建也在内，所以这两档在 dsh 里是同一档；
//   - custom → 没有对应：自定义白名单是 Claude Code 的权限规则，dsh 没有逐条放行命令的能力，
//     与其悄悄当成 workspace-write（比用户写的白名单宽得多），不如拒绝并说清。
//
// 不会给出 danger-full-access：那一档连沙箱都没有，工作台不替用户开。
// perm 为空时按 allowWrites 推（同 claude 那边的旧口径）。
func DSHSandboxMode(perm string, allowWrites bool) (string, error) {
	switch strings.TrimSpace(perm) {
	case "":
		if allowWrites {
			return DSHWorkspaceWrite, nil
		}
		return DSHReadOnly, nil
	case PermReadOnly:
		return DSHReadOnly, nil
	case PermAcceptEdits, PermEditsAndTests:
		return DSHWorkspaceWrite, nil
	case PermCustom:
		return "", validationErr("DeepSeek（dsh）没有命令白名单，不支持「自定义白名单」档位；换「允许改文件」（dsh 的 workspace-write 沙箱）或改用 Claude Code")
	}
	return "", validationErr("不认识权限档位「" + perm + "」")
}

// buildDSHArgs 拼 dsh 的命令行。
//
// 顺序有讲究：--profile 是启动器的参数，必须排在应用参数前面；后面的
// --json、--session-id 才是 headless 自己的。末尾那个 "-" 是让 headless
// 从 stdin 读任务，不能省。
//
// 实测 0.2.1-rc.5 的 headless 只认 --json、--session-id、-h 三个参数：
// 文档站上那个版本的 --approval-policy / --permission-mode / --add-dir 在这一版
// 还不存在，传了会被当成任务文本。所以「审批策略」「沙箱档位」「额外可写目录」
// 全部走 patch（见 writeDSHPatch），不走命令行——这也是更稳的一层：
// 那些是配置，本来就不该出现在命令行里。
func buildDSHArgs(profile, patch, sessionID string) []string {
	args := []string{
		"--profile", profile,
		"--patch", patch,
		"--json",
	}
	if sid := strings.TrimSpace(sessionID); sid != "" {
		// 续跑：沿用这个 id 的持久化会话，未知 id 会让 dsh 直接失败而不是悄悄新开一段。
		args = append(args, "--session-id", sid)
	}
	return append(args, "-")
}

// writeDSHPatch 生成这一次执行的 patch 文件，回它的绝对路径。
//
// 只写三处：模型路由（llm-pi-ai）、会话的 agent（agent-loop）、文件沙箱
// （sandbox-policy）。别的一律不碰——profile 自己的其余配置照旧生效。
//
// 用字符串拼而不是 yaml.Marshal：这里要的是三块人一眼能读懂的固定结构，
// 走结构体反射反而会把字段名搞成小写驼峰，和 dsh 的 schema 对不上。
// 所有取值都用双引号包住（strconv.Quote），路径里有空格、冒号、中文都不会坏。
func writeDSHPatch(dir string, route DeepSeekRoute, api, workdir, mode string,
	writableRoots []string, mcp *MCPEndpoint) (string, error) {

	if mode != DSHWorkspaceWrite {
		mode = DSHReadOnly
	}
	allowWrites := mode == DSHWorkspaceWrite

	var b strings.Builder
	b.WriteString("# 由工作台生成，每次执行一份，跑完即删。\n")
	b.WriteString("# 模型密钥不在这里：它走进程环境 " + dshAPIKeyEnv + "。\n")

	// 模型路由：工作台的服务商翻译成 dsh 的一条 provider 路由。
	b.WriteString("- id: llm-pi-ai\n  config:\n    providers:\n      " + dshRouteID + ":\n")
	b.WriteString("        apiKeyEnv: " + dshAPIKeyEnv + "\n")
	b.WriteString("        api: " + quote(api) + "\n")
	b.WriteString("        baseURL: " + quote(route.BaseURL) + "\n")
	b.WriteString("        models:\n          - id: " + quote(route.Model) + "\n")

	// 新会话的默认模型。不写这一条的话 headless 会用它自己的默认
	// （deepseek-official + deepseek-flash），根本走不到上面那条路由，
	// 实测报的就是「no API key for provider route "deepseek-official"」。
	b.WriteString("- id: agent-default-model\n  config:\n")
	b.WriteString("    provider: " + dshRouteID + "\n")
	b.WriteString("    model: " + quote(route.Model) + "\n")

	// 会话里的 agent：cwd 必须和 workspaceRoot 一致，否则沙箱按 cwd 判工作区会判错。
	b.WriteString("- id: agent-loop\n  config:\n    agents:\n      - id: main\n")
	b.WriteString("        provider: " + dshRouteID + "\n")
	b.WriteString("        model: " + quote(route.Model) + "\n")
	b.WriteString("        cwd: " + quote(workdir) + "\n")

	b.WriteString("- id: sandbox-policy\n  config:\n")
	b.WriteString("    mode: " + quote(mode) + "\n")
	b.WriteString("    workspaceRoot: " + quote(workdir) + "\n")
	if allowWrites && len(writableRoots) > 0 {
		// 软链接进来的资料目录在 workspaceRoot 之外，workspace-write 默认写不进去。
		b.WriteString("    additionalWritableRoots:\n")
		for _, d := range writableRoots {
			b.WriteString("      - " + quote(d) + "\n")
		}
	}

	// 审批策略恒为 never：headless 没有交互界面，ask 只会停在一个没人回答的确认上。
	b.WriteString("- id: approval\n  config:\n    policy: never\n")

	// 权限预设表要跟着一起改。dsh 启动时会检查「合成的沙箱档位 + 审批策略
	// 能对上表里的某一个预设」，对不上就整条 permission 插件不激活（实测的报错是
	// "composed sandbox and approval defaults match no preset"）。我们把两个旋钮
	// 改成了自定义组合，所以预设表也要给出同一组合，并把默认指到它。
	b.WriteString("- id: permission\n  config:\n    presets:\n")
	for _, p := range []struct{ name, sandbox string }{
		{"read-only", "read-only"},
		{"workspace-write", "workspace-write"},
		{"danger-full-access", "danger-full-access"},
	} {
		b.WriteString("      " + p.name + ":\n")
		b.WriteString("        sandbox: " + p.sandbox + "\n")
		b.WriteString("        approval: never\n")
	}
	b.WriteString("    defaultPreset: " + mode + "\n")

	// 工作台 MCP（TSK-0722）：和 claude 那边同一个 server 名（pmw-run）、同一个程序和地址，
	// 工具名同样是 mcp__pmw-run__pmw_append_progress 这种形状。dsh 的 MCP 客户端起 stdio
	// 子进程时会滤掉名字带 KEY / TOKEN / SECRET 的环境变量，这里也不需要传任何凭证。
	//
	// 必须用 insert：headless profile 里没有 MCP 客户端这一条，按 id 覆盖的写法只会得到一句
	// 「patch: entry not found」的警告，进程照常起、工具列表里却没有 pmw-run（0.2.2 实测）。
	if mcp != nil && strings.TrimSpace(mcp.Bin) != "" && strings.TrimSpace(mcp.API) != "" {
		b.WriteString("- insert:\n    - id: mcp-" + MCPServer + "\n      name: " + quote(dshMCPPlugin) + "\n      config:\n")
		b.WriteString("        serverName: " + quote(MCPServer) + "\n")
		b.WriteString("        transport: stdio\n")
		b.WriteString("        command: " + quote(strings.TrimSpace(mcp.Bin)) + "\n")
		// --actor：回写的变更记录记成 deepseek。不给的话 pmw-mcp 按环境推，工作台若是从 Claude Code 里起的，
		// dsh 子进程继承了 CLAUDECODE=1，进展会被记成 claude-code（实测）。
		b.WriteString("        args:\n          - \"--api\"\n          - " + quote(strings.TrimRight(strings.TrimSpace(mcp.API), "/")) +
			"\n          - \"--actor\"\n          - " + quote(DSHActor) + "\n")
	}

	path := filepath.Join(dir, dshPatchName)
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		return "", fmt.Errorf("写 dsh 配置失败：%w", err)
	}
	return path, nil
}

// quote 把任意字符串变成一个 YAML 安全的双引号标量。
func quote(s string) string { return strconv.Quote(s) }

// --- 事件流 ---

// dsh 的 --json 每行一个 JSON 对象，词汇表由 dsh 的 headless 投射定义，
// 只有下面这些（其余类型一律忽略，见 parseDSHLine 的注释）：
//
//	session      开场，带 sessionId 与 cwd
//	status       轮次/步的开始与结束
//	thinking     模型的草稿纸
//	text         提交点上的正文增量
//	tool_call    发起一次工具调用
//	tool_result  调用结果（status 是 completed 或 error）
//	final        收尾，带精确的会话 id、结束原因和完整答复
//	error        只在进程根本没跑起来时出现，此时不会有 final
type dshLine struct {
	Type string `json:"type"`
	Text string `json:"text"`

	// status
	Phase  string     `json:"phase"`
	Reason *dshReason `json:"reason"`

	// tool_call。两套字段都要认：0.2.x 发的是 tool + input（对象），
	// master 发的是 name + arguments（JSON 字符串）。只认一套的话，
	// 换一个版本工具行就变成一条空白，而它正是界面上最有价值的那一半。
	CallID    string          `json:"callId"`
	Tool      string          `json:"tool"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Arguments string          `json:"arguments"`

	// tool_result
	Status string          `json:"status"`
	Result string          `json:"result"`
	Error  json.RawMessage `json:"error"`

	// session
	SessionID string `json:"sessionId"`

	// error
	Message string `json:"message"`
}

// dshReason 是 turn_end 上的结束原因。失败时 error 里带着 code 和 message，
// 那是这次执行唯一能拿到的失败说明（final.text 是空的）。
type dshReason struct {
	Kind  string   `json:"kind"`
	Error *dshFail `json:"error"`
}

type dshFail struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

func (dl dshLine) toolName() string {
	if strings.TrimSpace(dl.Name) != "" {
		return dl.Name
	}
	return dl.Tool
}

// toolDetail 从入参里挑一句话。input 是对象就直读，arguments 是字符串就先解一遍。
func (dl dshLine) toolDetail() string {
	if len(dl.Input) > 0 {
		var input map[string]any
		if err := json.Unmarshal(dl.Input, &input); err == nil {
			return toolDetail(input)
		}
	}
	return dshToolDetail(dl.Arguments)
}

// parseDSHLine 把一行翻成零到多个事件。解析不了、或者是不认识的类型返回 nil。
//
// 不认识的类型必须忽略而不是报错：这个词汇表归 dsh 管，它升级时多一种事件
// 是常态，为此让整次执行失败是本末倒置。
//
// tool_result 那一行不带工具名，名字由 readDSHStream 用 id→name 对照表补。
func parseDSHLine(line []byte) []Event {
	var dl dshLine
	if err := json.Unmarshal(line, &dl); err != nil {
		return nil
	}
	switch dl.Type {
	case "text":
		if dl.Text == "" {
			return nil
		}
		return []Event{{Type: EventDelta, Text: dl.Text}}
	case "tool_call":
		return []Event{{
			Type: EventTool, ID: dl.CallID, Name: dl.toolName(), Detail: dl.toolDetail(),
		}}
	case "tool_result":
		ev := Event{Type: EventToolResult, ID: dl.CallID, OK: dl.Status != "error"}
		if !ev.OK {
			ev.Message = oneLine(dshErrorText(dl.Error, dl.Result), 300)
		}
		return []Event{ev}
	}
	// thinking 不展示：那是模型的草稿纸。status / session 只用于收尾，见下面的函数。
	return nil
}

// dshToolDetail 从 arguments（JSON 字符串）里挑一句话摆到界面上。
func dshToolDetail(arguments string) string {
	if strings.TrimSpace(arguments) == "" {
		return ""
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(arguments), &input); err != nil {
		return ""
	}
	return toolDetail(input)
}

// dshErrorText 取工具失败的原因。error 可能是一个对象（带 message），
// 也可能根本没有，那就退回 result 正文。
func dshErrorText(raw json.RawMessage, result string) string {
	if len(raw) > 0 {
		var e struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &e); err == nil && strings.TrimSpace(e.Message) != "" {
			return e.Message
		}
		var s string
		if err := json.Unmarshal(raw, &s); err == nil && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return result
}

// dshFinalOf 从 final 行里取答复正文。
//
// 实测 0.2.1：无论成功还是失败，final 都不带 reason（只有 text，失败时是空串），
// 所以「成功与否」只能由 turn_end 和退出码判断，不能因为 reason 缺失就判失败——
// 那会把每一次成功的执行都标成红的。
func dshFinalOf(line []byte) (text string, ok bool) {
	var dl dshLine
	if err := json.Unmarshal(line, &dl); err != nil || dl.Type != "final" {
		return "", false
	}
	return dl.Text, true
}

// dshTurnEndOf 取一轮的结束原因。kind 不是 completed 就是失败，
// error.message 是这种情况下唯一有信息量的文案（final.text 是空的）。
func dshTurnEndOf(line []byte) (kind, message string, ok bool) {
	var dl dshLine
	if err := json.Unmarshal(line, &dl); err != nil || dl.Type != "status" || dl.Phase != "turn_end" {
		return "", "", false
	}
	if dl.Reason == nil {
		return "", "", true
	}
	msg := ""
	if dl.Reason.Error != nil {
		msg = strings.TrimSpace(dl.Reason.Error.Message)
	}
	return dl.Reason.Kind, msg, true
}

// dshSessionOf 取这次运行的会话 id。续跑要用它，所以必须落在执行记录上。
func dshSessionOf(line []byte) (string, bool) {
	var dl dshLine
	if err := json.Unmarshal(line, &dl); err != nil || dl.Type != "session" {
		return "", false
	}
	return strings.TrimSpace(dl.SessionID), true
}

// dshErrorOf 认出 error 行。它只在直接驱动器失败时出现（agent 没建起来、
// --session-id 不存在、profile 装配失败）。
func dshErrorOf(line []byte) (string, bool) {
	var dl dshLine
	if err := json.Unmarshal(line, &dl); err != nil || dl.Type != "error" {
		return "", false
	}
	msg := strings.TrimSpace(dl.Message)
	if msg == "" {
		msg = oneLine(string(line), 300)
	}
	return msg, true
}

// --- 从工具失败文本里认环境问题 ---
//
// dsh 不给结构化的「被拒清单」（claude 有 permission_denials）：沙箱挡下来
// 的写入就是一条 EROFS / EACCES / EPERM 的工具错误。这些签名都来自 dsh 自己的
// 沙箱实现（见 docs/subsystems/sandbox.zh.md 的 denialSignatures）。认出来不是为了
// 精确计数，是为了把「它明明什么都没做成，却显示完成」和「沙箱根本没起来」
// 这两种最容易被误读的失败说清楚。

// dshSandboxUnavailable：沙箱后端不可用，dsh 拒绝在无隔离的情况下执行命令。
// 这不是任务失败，是这台机器的环境没准备好——必须和普通失败分开说。
func dshSandboxUnavailable(msg string) bool {
	return strings.Contains(msg, "no sandbox backend is usable") ||
		strings.Contains(msg, "refusing to run the command unconfined")
}

// dshDeniedWrite：写入撞上了文件效果限制。
func dshDeniedWrite(msg string) bool {
	for _, sig := range []string{
		"Read-only file system", "EROFS",
		"Permission denied", "EACCES",
		"Operation not permitted", "EPERM",
	} {
		if strings.Contains(msg, sig) {
			return true
		}
	}
	return false
}

// readDSHStream 逐行读 dsh 的 --json 流，翻成事件回调出去，同时攒收尾信息。
//
// 结构和 readStream（claude）一样，只是词汇表不同：两边都维护 id→工具名
// 对照表，因为 tool_result 那行只给 callId。
func readDSHStream(stdout io.Reader, out io.Writer, on func(Event)) streamOutcome {
	var so streamOutcome
	toolNames := map[string]string{}

	br := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(br, maxLineBytes)
		if len(line) > 0 {
			for _, ev := range parseDSHLine(line) {
				switch ev.Type {
				case EventTool:
					toolNames[ev.ID] = ev.Name
				case EventToolResult:
					ev.Name = toolNames[ev.ID]
					if ev.OK {
						so.okTools++
					} else {
						so.noteToolError(ev.Message)
					}
				}
				render(out, ev)
				on(ev)
			}
			if text, ok := dshFinalOf(line); ok {
				so.finalText = text
			}
			if sid, ok := dshSessionOf(line); ok && sid != "" {
				so.sessionID = sid
			}
			if kind, msg, ok := dshTurnEndOf(line); ok && kind != "" && kind != "completed" {
				so.finalErr = true
				if msg != "" {
					so.turnReason = msg
				}
			}
			if msg, ok := dshErrorOf(line); ok {
				so.finalErr = true
				if so.turnReason == "" {
					so.turnReason = msg
				}
			}
		}
		if err != nil {
			return so
		}
	}
}

// --- 准备 ---

// prepareDSH 把一次请求翻译成「起什么进程、怎么读它」。
//
// 所有能在起进程之前判死的错误都在这里判死（没配服务商、没设模型、
// 没有地址、协议不支持）：这些错误走普通 JSON 错误回给前端，
// 用户还能改；一旦进程起来了，就只能推进流里了。
func (r *Runner) prepareDSH(req Request, prompt, workdir string) (cmdSpec, error) {
	route := req.DeepSeek
	if err := route.Validate(); err != nil {
		return cmdSpec{}, err
	}
	api, err := dshAPI(route.Kind)
	if err != nil {
		return cmdSpec{}, err
	}

	bin := strings.TrimSpace(route.Bin)
	if bin == "" {
		bin = strings.TrimSpace(r.DSHBin)
	}
	if bin == "" {
		bin = DefaultDSHBin
	}
	profile := strings.TrimSpace(route.Profile)
	if profile == "" {
		profile = DefaultDSHProfile
	}

	// patch 放系统临时目录，不放工作目录：它是工作台的配置，不是这次执行的产出。
	// 目录权限 0700、文件 0600，跑完整个删掉。
	dir, err := os.MkdirTemp("", "pmw-dsh-")
	if err != nil {
		return cmdSpec{}, fmt.Errorf("建临时目录失败：%w", err)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	mode, err := DSHSandboxMode(req.Permission, req.AllowWrites)
	if err != nil {
		cleanup()
		return cmdSpec{}, err
	}
	linked := LinkedDirs(workdir)
	rt := *route
	rt.BaseURL = dshBaseURL(rt.Kind, rt.BaseURL)
	patch, err := writeDSHPatch(dir, rt, api, workdir, mode, linked, req.MCP)
	if err != nil {
		cleanup()
		return cmdSpec{}, err
	}

	return cmdSpec{
		bin:     bin,
		name:    "dsh",
		hint:    DSHInstallHint,
		args:    buildDSHArgs(profile, patch, req.SessionID),
		env:     []string{dshAPIKeyEnv + "=" + dshAPIKey(*route), dshTelemetryEnv},
		stdin:   prompt,
		read:    readDSHStream,
		cleanup: cleanup,
	}, nil
}

// dshAPIKey 是交给 dsh 的密钥。本机 Ollama 不要密钥，但 dsh 见到空的 apiKeyEnv 会直接报
// 「no API key」不发请求，所以给一个占位值；别的服务商没填密钥就照实交空串，让 dsh 报清楚。
func dshAPIKey(rt DeepSeekRoute) string {
	if strings.TrimSpace(rt.APIKey) == "" && rt.Kind == domain.ProviderOllama {
		return "ollama"
	}
	return rt.APIKey
}
