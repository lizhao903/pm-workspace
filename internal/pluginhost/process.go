// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

// 外部插件子进程管理（docs/plugin-spec-v2.md 7.1 / 7.3 / 7.8，brief §1）：
//
//	宿主是 Unix domain socket server，插件进程启动后连上来；
//	握手 plugin.hello → host.welcome 校验 token/protocol/plugin_id/api；
//	随后宿主发 plugin.activate（≤10s）和 plugin.health（≤5s，失败只记日志）。
//	停用：plugin.deactivate（≤10s）→ SIGTERM（5s）→ SIGKILL，日志写 <base>/logs/<id>.log。

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

const (
	// handshakeTimeout 是首帧 plugin.hello 的时限。
	handshakeTimeout = 10 * time.Second
	// activateTimeout 是 plugin.activate 的时限。
	activateTimeout = 10 * time.Second
	// healthTimeout 是启用后首次 plugin.health 的时限（失败只记日志）。
	healthTimeout = 5 * time.Second
	// deactivateTimeout 是 plugin.deactivate 的时限。
	deactivateTimeout = 10 * time.Second
	// termGrace 是 SIGTERM 之后等进程退出的时间，超时 SIGKILL。
	termGrace = 5 * time.Second
	// maxCrashRestarts 是崩溃自动重启的最大次数（spec 7.8）。
	maxCrashRestarts = 3
	// healthFailures 是周期健康检查连续失败多少次后终止进程（交给崩溃重启）。
	healthFailures = 3
)

// pluginProcess 是一个正在运行（或正在启动/停止）的插件实例。
type pluginProcess struct {
	host     *Host
	row      *stateRow
	manifest *Manifest

	id         string
	version    string
	installDir string
	dataDir    string
	cacheDir   string
	logPath    string

	binPath    string
	socketPath string
	token      string
	healthWait time.Duration

	listener net.Listener
	conn     *rpcConn
	db       *db.DB
	cmd      *exec.Cmd
	logFile  *os.File

	running   atomic.Bool
	exited    atomic.Bool
	stopping  atomic.Bool
	helloSeen atomic.Bool

	// granted 是运行期已授予的权限（Grant/Revoke 可在进程运行中变更，broker 每次调用都读它）。
	grantedMu sync.RWMutex
	granted   []string

	connReady   chan *rpcConn
	done        chan struct{}
	doneOnce    sync.Once
	cleanupOnce sync.Once
}

// startPlugin 读安装记录并拉起插件；已运行则直接成功返回（幂等）。
func (h *Host) startPlugin(ctx context.Context, row *stateRow) error {
	if p := h.lookupProc(row.ID); p != nil {
		if p.isRunning() {
			return nil
		}
		// 上一轮崩掉但清理还没跑完的实例：先停掉再重新拉起。
		p.stop(ctx, false)
	}

	m, err := decodeManifest(row.ManifestJSON)
	if err != nil {
		return wrap(ErrValidation, "插件 %s 的清单已损坏：%v", row.ID, err)
	}
	if err := CheckCompatibility(m, h.opts.Version); err != nil {
		return wrap(ErrIncompatible, "插件 %s 与当前宿主不兼容：%s", row.ID, err)
	}
	if m.Runtime.Backend == nil {
		// 纯前端插件没有子进程；启用成功但 Running=false（前端由 API 层提供）。
		return nil
	}
	platform := platformKey()
	entry, ok := m.Runtime.Backend.Entry[platform]
	if !ok {
		return wrap(ErrIncompatible, "插件 %s 没有当前平台 %s 的二进制", row.ID, platform)
	}
	binPath, err := safeJoin(row.InstallDir, entry)
	if err != nil || !isRegularFile(binPath) {
		return wrap(ErrIncompatible, "插件 %s 的二进制不存在：%s", row.ID, entry)
	}

	p := &pluginProcess{
		host:       h,
		row:        row,
		manifest:   m,
		id:         row.ID,
		version:    row.Version,
		installDir: row.InstallDir,
		dataDir:    h.dataDir(row.ID),
		cacheDir:   h.cacheDir(row.ID),
		logPath:    h.logPath(row.ID),
		binPath:    binPath,
		healthWait: m.Runtime.Backend.HealthTimeout(),
		connReady:  make(chan *rpcConn, 1),
		done:       make(chan struct{}),
	}
	if p.healthWait <= 0 || p.healthWait > 60*time.Second {
		p.healthWait = 10 * time.Second
	}

	if err := os.MkdirAll(p.dataDir, 0o750); err != nil {
		return fmt.Errorf("创建插件数据目录失败：%w", err)
	}
	if err := os.MkdirAll(p.cacheDir, 0o750); err != nil {
		return fmt.Errorf("创建插件缓存目录失败：%w", err)
	}
	if err := os.MkdirAll(h.logsDir, 0o750); err != nil {
		return fmt.Errorf("创建插件日志目录失败：%w", err)
	}

	// 插件私有库 + 包内 migrations（启用时应用）。
	pdb, err := h.openPluginDB(row.ID)
	if err != nil {
		return err
	}
	if err := applyPluginMigrations(ctx, pdb, row.InstallDir, m, h.log.With("plugin", row.ID)); err != nil {
		_ = pdb.Close()
		return err
	}
	p.db = pdb

	ln, socketPath, err := h.listenPlugin(row.ID)
	if err != nil {
		_ = pdb.Close()
		return err
	}
	p.listener = ln
	p.socketPath = socketPath
	token, err := randomHex(32)
	if err != nil {
		p.cleanup()
		return fmt.Errorf("生成握手 token 失败：%w", err)
	}
	p.token = token
	if err := p.ensureExecutable(); err != nil {
		p.cleanup()
		return err
	}

	logFile, err := os.OpenFile(p.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		p.cleanup()
		return fmt.Errorf("打开插件日志失败：%w", err)
	}
	p.logFile = logFile

	if err := p.launch(); err != nil {
		p.cleanup()
		return err
	}
	go p.monitor()

	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		p.stop(ctx, false)
		return wrap(ErrNotRunning, "宿主正在关闭，无法启动插件 %s", row.ID)
	}
	h.procs[row.ID] = p
	h.mu.Unlock()

	if err := p.handshake(ctx); err != nil {
		p.stop(ctx, false)
		return err
	}
	p.running.Store(true)
	p.setGranted(row.Granted)
	h.resetRestarts(row.ID)
	h.log.Info("外部插件已启动", "plugin", p.id, "version", p.version, "socket", socketPath, "pid", p.pid())
	go p.healthLoop()
	return nil
}

// hasGranted 读运行期已授予权限（Grant/Revoke 可以在进程运行中变更）。
func (p *pluginProcess) hasGranted(perm string) bool {
	p.grantedMu.RLock()
	granted := p.granted
	p.grantedMu.RUnlock()
	if granted == nil && p.row != nil {
		// 兼容测试里直接构造的 pluginProcess（没有走 startPlugin 的 setGranted）。
		return containsString(p.row.Granted, perm)
	}
	return containsString(granted, perm)
}

// setGranted 替换进程的已授予权限快照（Grant/Revoke 后同步）。
func (p *pluginProcess) setGranted(list []string) {
	p.grantedMu.Lock()
	p.granted = append([]string{}, list...)
	p.grantedMu.Unlock()
}

// healthLoop 周期 health 探测：连续 healthFailures 次失败就把进程杀掉，交给 onProcExit 按退避重启。
func (p *pluginProcess) healthLoop() {
	interval := p.host.opts.HealthInterval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			if !p.isRunning() {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), healthTimeout)
			_, err := p.call(ctx, "plugin.health", nil)
			cancel()
			if err == nil {
				failures = 0
				continue
			}
			failures++
			p.host.log.Warn("插件周期健康检查失败", "plugin", p.id, "failures", failures, "err", err)
			if failures >= healthFailures {
				msg := "连续 " + strconv.Itoa(healthFailures) + " 次健康检查失败，已终止进程"
				_ = p.host.setLastError(context.Background(), p.id, msg)
				p.signal(syscall.SIGKILL)
				return
			}
		}
	}
}

// pid 返回子进程 pid（测试 fake 客户端时为 0）。
func (p *pluginProcess) pid() int {
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}

// ensureExecutable 给后端二进制补执行位（解包/复制时可能丢）。
func (p *pluginProcess) ensureExecutable() error {
	st, err := os.Stat(p.binPath)
	if err != nil {
		return wrap(ErrIncompatible, "读取插件二进制失败：%v", err)
	}
	if st.Mode()&0o111 == 0 {
		if err := os.Chmod(p.binPath, st.Mode()|0o755); err != nil {
			return wrap(ErrIncompatible, "插件二进制不可执行：%v", err)
		}
	}
	return nil
}

// launch 起子进程（或测试注入的 fake 客户端）。
func (p *pluginProcess) launch() error {
	if p.host.testLaunch != nil {
		if err := p.host.testLaunch(p); err != nil {
			return wrap(ErrIncompatible, "测试启动插件失败：%v", err)
		}
		return nil
	}
	cmd := exec.Command(p.binPath)
	cmd.Dir = p.installDir
	cmd.Env = p.env()
	cmd.Stdout = p.logFile
	cmd.Stderr = p.logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return wrap(ErrIncompatible, "启动插件进程失败：%v", err)
	}
	p.cmd = cmd
	return nil
}

// env 只注入协议规定的白名单变量，不继承宿主环境（brief §1）。
func (p *pluginProcess) env() []string {
	return []string{
		"PMW_PLUGIN_ID=" + p.id,
		"PMW_PLUGIN_VERSION=" + p.version,
		"PMW_PLUGIN_API_VERSION=" + ExternalAPIVersion,
		"PMW_PLUGIN_SOCKET=" + p.socketPath,
		"PMW_PLUGIN_TOKEN=" + p.token,
		"PMW_PLUGIN_DATA_DIR=" + p.dataDir,
		"PMW_PLUGIN_CACHE_DIR=" + p.cacheDir,
		"PMW_PLUGIN_LOG_LEVEL=info",
		"PMW_PLUGIN_OS=" + runtime.GOOS,
		"PMW_PLUGIN_ARCH=" + runtime.GOARCH,
	}
}

// handshake 等插件连上来并完成 hello/welcome、activate、health。
func (p *pluginProcess) handshake(ctx context.Context) error {
	setDeadline(p.listener, time.Now().Add(handshakeTimeout))
	rawConn, err := p.listener.Accept()
	if err != nil {
		return wrap(ErrIncompatible, "插件没有在 %s 内连接宿主 socket：%v", handshakeTimeout, err)
	}
	setDeadline(p.listener, time.Time{})

	conn := newRPCConn(rawConn, p.host.log.With("plugin", p.id))
	p.conn = conn
	select {
	case p.connReady <- conn:
	default:
	}

	type helloOutcome struct {
		welcome map[string]any
		err     *rpcError
	}
	helloCh := make(chan helloOutcome, 1)
	var (
		outcomeMu sync.Mutex
		// 默认非 nil：任何「不是 hello 的响应」都不能被当成握手成功。
		outcome = helloOutcome{err: rpcErrorf("invalid_request", "握手未完成：没有收到 plugin.hello")}
	)
	conn.setHandler(func(_ context.Context, method string, params json.RawMessage) (any, error) {
		if method != "plugin.hello" {
			return nil, rpcErrorf("method_not_found", "握手未完成前只接受 plugin.hello（收到 %s）", method)
		}
		if !p.helloSeen.CompareAndSwap(false, true) {
			return nil, rpcErrorf("invalid_request", "plugin.hello 只能发送一次")
		}
		welcome, rerr := p.validateHello(params)
		outcomeMu.Lock()
		outcome = helloOutcome{welcome: welcome, err: rerr}
		outcomeMu.Unlock()
		if rerr != nil {
			return nil, rerr
		}
		return welcome, nil
	})
	// host.welcome 真正写到线上后才放行 activate：插件先读 welcome 再等 activate，
	// 两条帧乱序会让插件把 activate 当 welcome 解析。
	conn.setOnResponse(func(json.RawMessage) {
		// 只有真的收到过 plugin.hello，才允许把某条响应当成 host.welcome 的回执。
		// 否则首帧若是别的请求，错误响应会带着零值 outcome 把握手放过去（曾是可利用的绕过）。
		if !p.helloSeen.Load() {
			return
		}
		outcomeMu.Lock()
		out := outcome
		outcomeMu.Unlock()
		select {
		case helloCh <- out:
		default:
		}
	})
	// 插件的 broker 处理用宿主后台上下文：API 请求结束后连接仍要能服务插件。
	conn.start(context.Background())
	connected := false
	defer func() {
		if !connected {
			conn.close()
		}
	}()

	select {
	case out := <-helloCh:
		if out.err != nil {
			return wrap(ErrIncompatible, "插件握手失败：%s", out.err.Message)
		}
	case <-time.After(handshakeTimeout):
		return wrap(ErrIncompatible, "插件没有在 %s 内完成 plugin.hello 握手", handshakeTimeout)
	case <-conn.closed():
		return wrap(ErrIncompatible, "插件在握手完成前断开了连接")
	}

	// 握手成功：后续插件 → 宿主请求走 broker。
	conn.setOnResponse(nil)
	conn.setHandler(p.handleHostCall)

	actCtx, cancel := context.WithTimeout(ctx, activateTimeout)
	defer cancel()
	var activateResp struct {
		OK bool `json:"ok"`
	}
	if err := conn.call(actCtx, "plugin.activate", map[string]any{
		"reason":      "enable",
		"permissions": p.manifest.Permissions,
		"granted":     p.row.Granted,
		"data_dir":    p.dataDir,
		"cache_dir":   p.cacheDir,
	}, &activateResp); err != nil {
		return wrap(ErrIncompatible, "插件 activate 失败：%v", err)
	}

	// 健康检查失败只记日志，不阻塞启用（brief §1）。
	healthLimit := healthTimeout
	if p.manifest.Runtime.Backend != nil {
		healthLimit = minDuration(healthLimit, p.manifest.Runtime.Backend.HealthTimeout())
	}
	healthCtx, cancelHealth := context.WithTimeout(ctx, healthLimit)
	defer cancelHealth()
	var health struct {
		Status string          `json:"status"`
		Detail json.RawMessage `json:"detail"`
	}
	if err := conn.call(healthCtx, "plugin.health", map[string]any{}, &health); err != nil {
		p.host.log.Warn("插件健康检查失败（不影响启用）", "plugin", p.id, "err", err)
	} else if health.Status != "" && health.Status != "ok" && health.Status != "degraded" {
		p.host.log.Warn("插件健康状态异常", "plugin", p.id, "status", health.Status)
	}
	connected = true
	return nil
}

// validateHello 校验 plugin.hello 参数并构造 host.welcome（docs/plugin-spec-v2.md 7.3）。
func (p *pluginProcess) validateHello(params json.RawMessage) (map[string]any, *rpcError) {
	var hello struct {
		Protocol      string   `json:"protocol"`
		PluginID      string   `json:"plugin_id"`
		PluginVersion string   `json:"plugin_version"`
		Token         string   `json:"token"`
		API           string   `json:"api"`
		Capabilities  []string `json:"capabilities"`
	}
	if err := json.Unmarshal(params, &hello); err != nil {
		return nil, rpcErrorf("invalid_params", "plugin.hello 参数不是合法 JSON：%v", err)
	}
	switch {
	case hello.Protocol != ProtocolVersion:
		return nil, rpcErrorf("validation", "协议不匹配：期望 %s，收到 %q", ProtocolVersion, hello.Protocol)
	case subtle.ConstantTimeCompare([]byte(hello.Token), []byte(p.token)) != 1:
		return nil, rpcErrorf("validation", "握手 token 不匹配")
	case hello.PluginID != p.id:
		return nil, rpcErrorf("validation", "plugin_id 不匹配：期望 %s，收到 %q", p.id, hello.PluginID)
	case !plugin.Satisfies(ExternalAPIVersion, hello.API):
		return nil, rpcErrorf("validation", "清单 api 范围 %q 不包含宿主 API 版本 %s", hello.API, ExternalAPIVersion)
	}
	welcome := map[string]any{
		"protocol": ProtocolVersion,
		"host": map[string]any{
			"pmw_version": p.host.opts.Version,
			"api_version": ExternalAPIVersion,
			"os":          runtime.GOOS,
			"arch":        runtime.GOARCH,
		},
		"plugin": map[string]any{"id": p.id, "version": p.version},
		"limits": map[string]any{
			"max_message_bytes":       MaxFrameBytes,
			"max_concurrent_requests": MaxConcurrentRequests,
			"default_timeout_ms":      DefaultTimeoutMS,
		},
		"permissions": grantedOrEmpty(p.row.Granted),
	}
	return welcome, nil
}

// monitor 等子进程/连接结束，清理并通知宿主。
func (p *pluginProcess) monitor() {
	var waitErr error
	if p.cmd != nil {
		waitErr = p.cmd.Wait()
	} else {
		// 测试 fake 客户端没有子进程：等握手建立的连接结束。
		select {
		case c := <-p.connReady:
			if c != nil {
				<-c.closed()
			}
		case <-time.After(handshakeTimeout + 2*time.Second):
		}
	}
	p.running.Store(false)
	p.exited.Store(true)
	p.cleanup()
	p.closeDone()
	p.host.onProcExit(p, waitErr)
}

func (p *pluginProcess) closeDone() {
	p.doneOnce.Do(func() { close(p.done) })
}

func (p *pluginProcess) isRunning() bool { return p != nil && p.running.Load() }

// stop 停用插件：deactivate → SIGTERM → SIGKILL，并清理 socket/日志/私有库。
func (p *pluginProcess) stop(ctx context.Context, graceful bool) {
	if p == nil {
		return
	}
	if !p.stopping.CompareAndSwap(false, true) {
		// 另一个 goroutine 正在停：等它收尾。
		select {
		case <-p.done:
		case <-time.After(deactivateTimeout + termGrace + 5*time.Second):
		}
		return
	}

	if graceful && p.conn != nil && p.running.Load() {
		dctx, cancel := context.WithTimeout(ctx, deactivateTimeout)
		_, _ = p.conn.callRaw(dctx, "plugin.deactivate", map[string]any{
			"reason":      "disable",
			"deadline_ms": deactivateTimeout.Milliseconds(),
		})
		cancel()
		select {
		case <-p.done:
		case <-time.After(termGrace):
		}
	}

	if !p.exited.Load() {
		p.signal(syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(termGrace):
		}
	}
	if !p.exited.Load() {
		p.signal(syscall.SIGKILL)
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
		}
	}
	p.cleanup()
	p.closeDone()
}

func (p *pluginProcess) signal(sig syscall.Signal) {
	if p.cmd == nil || p.cmd.Process == nil {
		return
	}
	// 进程组一起发，尽量带走插件自己起的子进程。
	if err := syscall.Kill(-p.cmd.Process.Pid, sig); err != nil {
		_ = p.cmd.Process.Signal(sig)
	}
}

// cleanup 幂等清理连接、监听、socket、私有库、日志文件。
func (p *pluginProcess) cleanup() {
	p.cleanupOnce.Do(func() {
		if p.conn != nil {
			p.conn.close()
		}
		if p.listener != nil {
			_ = p.listener.Close()
		}
		if p.socketPath != "" {
			_ = os.Remove(p.socketPath)
		}
		if p.db != nil {
			_ = p.db.Close()
		}
		if p.logFile != nil {
			_ = p.logFile.Close()
		}
	})
}

// onProcExit 进程退出后更新宿主状态：从运行表删除，异常退出记 last_error。
func (h *Host) onProcExit(p *pluginProcess, waitErr error) {
	h.mu.Lock()
	if h.procs[p.id] == p {
		delete(h.procs, p.id)
	}
	closed := h.closed
	h.mu.Unlock()

	if p.stopping.Load() || closed {
		return
	}
	msg := "插件进程已退出"
	if waitErr != nil {
		msg = "插件进程异常退出：" + waitErr.Error()
	}
	h.log.Warn(msg, "plugin", p.id)
	row, err := h.loadState(context.Background(), p.id)
	if err != nil || !row.Enabled {
		return
	}
	_ = h.setLastError(context.Background(), p.id, msg)
	h.scheduleRestart(p.id, msg)
}

// scheduleRestart 按 1s/2s/4s 退避自动重启（最多 3 次）；用 lifecycle 串行化，
// 避免和用户同时 Enable/Disable 抢着拉起。超过 3 次只记 last_error，等用户手动启用。
func (h *Host) scheduleRestart(id, reason string) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	attempt := h.restarts[id] + 1
	h.restarts[id] = attempt
	if attempt > maxCrashRestarts {
		h.mu.Unlock()
		_ = h.setLastError(context.Background(), id, "崩溃重启 3 次仍失败："+reason)
		h.log.Error("插件崩溃重启超过上限，停止重试", "plugin", id)
		return
	}
	delay := crashBackoff(attempt, h.opts.CrashBackoffBase)
	h.mu.Unlock()
	h.log.Info("插件崩溃，准备自动重启", "plugin", id, "attempt", attempt, "delay", delay)

	timer := time.AfterFunc(delay, func() {
		h.lifecycle.Lock()
		defer h.lifecycle.Unlock()
		h.mu.Lock()
		closed := h.closed
		delete(h.restartTimers, id)
		h.mu.Unlock()
		if closed {
			return
		}
		row, err := h.loadState(context.Background(), id)
		if err != nil || !row.Enabled || h.lookupProc(id) != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), activateTimeout+handshakeTimeout)
		defer cancel()
		if err := h.startPlugin(ctx, row); err != nil {
			_ = h.setLastError(context.Background(), id, "自动重启失败："+err.Error())
			h.log.Warn("插件自动重启失败", "plugin", id, "err", err)
			h.scheduleRestart(id, err.Error())
		}
	})
	h.mu.Lock()
	if old := h.restartTimers[id]; old != nil {
		old.Stop()
	}
	h.restartTimers[id] = timer
	h.mu.Unlock()
}

// cancelRestart 取消等待中的自动重启（用户停用/卸载/关闭宿主时）。
func (h *Host) cancelRestart(id string) {
	h.mu.Lock()
	if t := h.restartTimers[id]; t != nil {
		t.Stop()
		delete(h.restartTimers, id)
	}
	delete(h.restarts, id)
	h.mu.Unlock()
}

// resetRestarts 在成功拉起后清空连续重启计数。
func (h *Host) resetRestarts(id string) {
	h.mu.Lock()
	delete(h.restarts, id)
	if t := h.restartTimers[id]; t != nil {
		t.Stop()
		delete(h.restartTimers, id)
	}
	h.mu.Unlock()
}

// crashBackoff 返回第 n 次崩溃重启前的等待时间：默认 1s / 2s / 4s；测试可用 Options 调短。
func crashBackoff(attempt int, base time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if base <= 0 {
		base = time.Second
	}
	return time.Duration(1<<uint(attempt-1)) * base
}

// callInto 发请求并把 result 解到 out（用于插件 HTTP 流式开始帧等结构化响应）。
func (p *pluginProcess) callInto(ctx context.Context, method string, params json.RawMessage, out any) error {
	raw, err := p.call(ctx, method, params)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return wrap(ErrValidation, "插件 %s 返回的 %s 不是合法 JSON：%v", p.id, method, err)
	}
	return nil
}

// call 向运行中的插件发一个宿主 → 插件请求。
func (p *pluginProcess) call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	if p == nil || !p.running.Load() || p.conn == nil {
		return nil, wrap(ErrNotRunning, "插件未运行")
	}
	var payload any
	if len(params) > 0 {
		payload = params
	}
	return p.conn.callRaw(ctx, method, payload)
}

// listenPlugin 在同机短路径上建 Unix socket（macOS 路径上限约 104 字节）。
func (h *Host) listenPlugin(id string) (net.Listener, string, error) {
	dir := "/tmp"
	if _, err := os.Stat(dir); err != nil {
		dir = os.TempDir()
	}
	_ = os.MkdirAll(h.runDir, 0o700)
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		suffix, err := randomHex(6)
		if err != nil {
			return nil, "", err
		}
		candidate := filepath.Join(dir, fmt.Sprintf("pmw-%s-%s.sock", id, suffix))
		if len(candidate) > 100 {
			// id 太长时缩成纯随机名，长度优先级高于可读性。
			candidate = filepath.Join(dir, fmt.Sprintf("pmw-%s.sock", suffix))
		}
		ln, err := net.Listen("unix", candidate)
		if err != nil {
			lastErr = err
			if errors.Is(err, syscall.EADDRINUSE) {
				continue
			}
			return nil, "", fmt.Errorf("创建插件 socket 失败：%w", err)
		}
		_ = os.Chmod(candidate, 0o600)
		return ln, candidate, nil
	}
	return nil, "", fmt.Errorf("创建插件 socket 失败：%w", lastErr)
}

// setDeadline 给 UnixListener 设 Accept 超时；不是 deadline 类型时忽略。
func setDeadline(ln net.Listener, t time.Time) {
	if d, ok := ln.(interface{ SetDeadline(time.Time) error }); ok {
		_ = d.SetDeadline(t)
	}
}

// randomHex 返回 n 字节随机数的十六进制串。
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func grantedOrEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
