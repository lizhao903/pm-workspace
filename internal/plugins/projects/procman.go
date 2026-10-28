package projects

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 原型进程管理（PJ-04a）：每次启用插件一个 manager，状态和日志只在内存。
// 进程起在自己的进程组里（Setpgid），停的时候只按本 manager 记下的进程组发信号，不按名字找进程。
// 插件停用、服务关闭时常驻任务的 ctx 被取消，closeAll 停掉这里起的全部原型。

// 原型状态，对照原型 PROTO_STATUS：stopping 不单列（停止是同步等退出的），error 改叫 crashed。
const (
	statusStopped  = "stopped"
	statusStarting = "starting"
	statusRunning  = "running"
	statusCrashed  = "crashed"
)

const (
	logLines     = 1000            // 每个原型的日志环形缓冲行数
	maxLogLine   = 4096            // 单行最长字节，超出截断
	crashLogTail = 50              // 崩溃记录里留最后多少行
	stopGrace    = 5 * time.Second // SIGTERM 后等多久再 SIGKILL
	waitDelay    = 2 * time.Second // 进程退出后等子进程关掉输出管道的上限
	probeEvery   = 200 * time.Millisecond
)

// reservedPorts 是不许原型占的端口，原因给用户看。服务自己的端口按请求现取，另查。
var reservedPorts = map[int]string{
	7777: "真实数据的工作台服务",
	7796: "测试实例",
	7778: "原型站点（web-next）",
	7780: "正式前端的开发服务",
}

// LogLine 是一行原型输出，stdout 和 stderr 合在一起，seq 从 1 递增。
type LogLine struct {
	Seq  int64     `json:"seq"`
	At   time.Time `json:"at"`
	Text string    `json:"text"`
}

// ring 是定长的日志缓冲，满了丢最早的。
type ring struct {
	lines []LogLine
	next  int64 // 下一行的 seq
}

func (r *ring) add(text string) {
	r.next++
	r.lines = append(r.lines, LogLine{Seq: r.next, At: time.Now().UTC(), Text: text})
	if len(r.lines) > logLines {
		r.lines = r.lines[len(r.lines)-logLines:]
	}
}

// after 返回 seq 大于 n 的行，最多 limit 行（取最新的）。
func (r *ring) after(n int64, limit int) []LogLine {
	out := []LogLine{}
	for _, l := range r.lines {
		if l.Seq > n {
			out = append(out, l)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// proc 是一个原型在本 manager 里的运行情况，停了也留着，日志跨次启动保留。
type proc struct {
	id, projectID       string
	name, projectName   string
	port                int
	status              string
	errMsg              string
	pid                 int
	startedAt           time.Time
	runFrom             int64 // 本次启动第一行日志的 seq，崩溃记录只取本次的
	stopping            bool
	done                chan struct{}
	logs                ring
	partial             []byte // 还没遇到换行的半行
	exitCode            *int
	exitSignal, exitMsg string
}

// Runtime 是原型的运行状态，拼进接口返回。
type Runtime struct {
	Status    string     `json:"status"`
	Error     string     `json:"error"`
	PID       int        `json:"pid"`
	StartedAt *time.Time `json:"started_at"`
}

type manager struct {
	c      plugin.Core
	mu     sync.Mutex
	closed bool
	procs  map[string]*proc
}

func newManager(c plugin.Core) *manager { return &manager{c: c, procs: map[string]*proc{}} }

func (m *manager) runtime(id string) Runtime {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.procs[id]
	if p == nil {
		return Runtime{Status: statusStopped}
	}
	rt := Runtime{Status: p.status, Error: p.errMsg}
	if p.status == statusStarting || p.status == statusRunning {
		rt.PID = p.pid
		t := p.startedAt
		rt.StartedAt = &t
	}
	return rt
}

func (m *manager) active(id string) bool {
	rt := m.runtime(id)
	return rt.Status == statusStarting || rt.Status == statusRunning
}

func (m *manager) logs(id string, after int64, limit int) ([]LogLine, int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.procs[id]
	if p == nil {
		return []LogLine{}, 0
	}
	return p.logs.after(after, limit), p.logs.next
}

// forget 删原型时丢掉内存里的记录（调用方已确认没在跑）。
func (m *manager) forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.procs, id)
}

// reservedReason 查保留端口和服务自己的端口，selfPort 为 0 表示不知道。
func reservedReason(port, selfPort int) string {
	if why, ok := reservedPorts[port]; ok {
		return fmt.Sprintf("%d 端口给%s用着，换一个端口", port, why)
	}
	if selfPort > 0 && port == selfPort {
		return fmt.Sprintf("%d 是当前工作台服务自己的端口，换一个端口", port)
	}
	return ""
}

// portBusy 看端口上是不是已经有别的程序：能连上，或者绑不上。
func portBusy(port int) bool {
	if c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 300*time.Millisecond); err == nil {
		_ = c.Close()
		return true
	}
	l, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return true
	}
	_ = l.Close()
	return false
}

// listening 看原型是不是已经在端口上监听（IPv4 或 IPv6 回环任一能连上）。
func listening(port int) bool {
	for _, host := range []string{"127.0.0.1", "::1"} {
		if c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 300*time.Millisecond); err == nil {
			_ = c.Close()
			return true
		}
	}
	return false
}

// start 起原型进程。冲突、已在跑返回 errConflict，命令找不到、目录不对返回 errValidation。
func (m *manager) start(pt Prototype, projectName string, selfPort int) error {
	if why := reservedReason(pt.Port, selfPort); why != "" {
		return apiErr(errConflict, "%s", why)
	}
	if st, err := os.Stat(pt.Dir); err != nil || !st.IsDir() {
		return apiErr(errValidation, "工作目录 %s 不存在或不是文件夹", pt.Dir)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return apiErr(errConflict, "项目插件正在停用，不能再启动原型")
	}
	p := m.procs[pt.ID]
	if p != nil && (p.status == statusStarting || p.status == statusRunning) {
		return apiErr(errConflict, "原型「%s」已经在运行", pt.Name)
	}
	for _, o := range m.procs {
		if o.id != pt.ID && o.port == pt.Port && (o.status == statusStarting || o.status == statusRunning) {
			return apiErr(errConflict, "%d 端口被「%s / %s」占着", pt.Port, o.projectName, o.name)
		}
	}
	if portBusy(pt.Port) {
		return apiErr(errConflict, "%d 端口已经被本机别的程序占着，先关掉它或换一个端口", pt.Port)
	}
	cmd := exec.Command(pt.Argv[0], pt.Argv[1:]...)
	if cmd.Err != nil {
		return apiErr(errValidation, "找不到命令 %s：%v", pt.Argv[0], cmd.Err)
	}
	if p == nil {
		p = &proc{id: pt.ID}
		m.procs[pt.ID] = p
	}
	p.projectID, p.name, p.projectName, p.port = pt.ProjectID, pt.Name, projectName, pt.Port
	p.errMsg, p.stopping, p.partial, p.exitCode, p.exitSignal, p.exitMsg = "", false, nil, nil, "", ""
	p.runFrom = p.logs.next + 1
	p.logs.add("$ cd " + pt.Dir)
	p.logs.add("$ " + pt.Command)

	cmd.Dir = pt.Dir
	cmd.Env = append(os.Environ(), "PORT="+strconv.Itoa(pt.Port))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	w := &logWriter{m: m, p: p}
	cmd.Stdout, cmd.Stderr = w, w // 同一个 writer，exec 只开一根管道，输出顺序不乱
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		p.status, p.errMsg = statusStopped, "启动失败："+err.Error()
		p.logs.add(p.errMsg)
		return apiErr(errValidation, "启动失败：%v", err)
	}
	p.status, p.pid, p.startedAt = statusStarting, cmd.Process.Pid, time.Now().UTC()
	p.done = make(chan struct{})
	go m.wait(p, cmd, p.pid, p.done)
	go m.probe(p, p.port, p.done)
	return nil
}

// probe 等原型开始监听端口，把 starting 改成 running；进程先退出就不管了。
func (m *manager) probe(p *proc, port int, done chan struct{}) {
	t := time.NewTicker(probeEvery)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
		}
		if !listening(port) {
			continue
		}
		m.mu.Lock()
		if p.done == done && p.status == statusStarting {
			p.status = statusRunning
		}
		m.mu.Unlock()
		return
	}
}

// wait 等进程退出，清掉进程组里剩下的子进程，记状态；不是我们要停的、退出码不为 0 的记崩溃。
func (m *manager) wait(p *proc, cmd *exec.Cmd, pgid int, done chan struct{}) {
	err := cmd.Wait()
	// 进程组号就是启动时的 pid；组长退了，组里还可能留着它拉起的子进程（比如 npm 下面的 vite）
	_ = syscall.Kill(-pgid, syscall.SIGKILL)

	code, sig := 0, ""
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code, sig = -1, ws.Signal().String()
		} else {
			code = ee.ExitCode()
		}
	} else if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		code = -1
	}

	m.mu.Lock()
	m.flush(p)
	var reason string
	switch {
	case sig != "":
		reason = "被信号 " + sig + " 结束"
	default:
		reason = "退出码 " + strconv.Itoa(code)
	}
	p.exitCode, p.exitSignal, p.exitMsg = &code, sig, reason
	crash := !p.stopping && (code != 0 || sig != "")
	switch {
	case p.stopping:
		p.status, p.errMsg = statusStopped, ""
		p.logs.add("[已停止] " + reason)
	case crash:
		p.status, p.errMsg = statusCrashed, "进程意外退出："+reason
		p.logs.add("[崩溃] " + reason)
	default:
		p.status, p.errMsg = statusStopped, "进程自己退出了（退出码 0）"
		p.logs.add("[退出] 退出码 0")
	}
	var tail []string
	if crash {
		for _, l := range p.logs.after(p.runFrom-1, crashLogTail) {
			tail = append(tail, l.Text)
		}
	}
	rec := Crash{PrototypeID: p.id, ProjectID: p.projectID, ExitCode: code, Signal: sig, Reason: p.errMsg,
		Log: tail, StartedAt: p.startedAt, ExitedAt: time.Now().UTC()}
	p.pid = 0
	close(done)
	m.mu.Unlock()

	if crash {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := saveCrash(ctx, m.c.Store(), rec); err != nil {
			m.c.Log().Warn("prototype crash not recorded", "prototype", p.id, "err", err)
		}
	}
}

// stop 停原型：先 SIGTERM 整个进程组，等 stopGrace 还没退就 SIGKILL。没在跑直接返回。
func (m *manager) stop(id string) {
	m.mu.Lock()
	p := m.procs[id]
	if p == nil || (p.status != statusStarting && p.status != statusRunning) {
		m.mu.Unlock()
		return
	}
	p.stopping = true
	pgid, done := p.pid, p.done
	m.mu.Unlock()

	if pgid <= 0 {
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-done:
		return
	case <-time.After(stopGrace):
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	select {
	case <-done:
	case <-time.After(waitDelay + time.Second):
		m.c.Log().Warn("prototype did not exit after SIGKILL", "prototype", id, "pgid", pgid)
	}
}

// closeAll 停掉本 manager 起的全部原型，之后不再接受启动。插件停用、服务关闭时调。
func (m *manager) closeAll() {
	m.mu.Lock()
	m.closed = true
	var ids []string
	for id, p := range m.procs {
		if p.status == statusStarting || p.status == statusRunning {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.stop(id)
		}()
	}
	wg.Wait()
	if len(ids) > 0 {
		m.c.Log().Info("prototypes stopped", "count", len(ids))
	}
}

// logWriter 把进程输出按行切进环形缓冲。
type logWriter struct {
	m *manager
	p *proc
}

func (w *logWriter) Write(b []byte) (int, error) {
	w.m.mu.Lock()
	defer w.m.mu.Unlock()
	p := w.p
	p.partial = append(p.partial, b...)
	for {
		i := bytes.IndexByte(p.partial, '\n')
		if i < 0 {
			break
		}
		p.logs.add(cleanLine(p.partial[:i]))
		p.partial = p.partial[i+1:]
	}
	if len(p.partial) > maxLogLine {
		p.logs.add(cleanLine(p.partial))
		p.partial = nil
	}
	return len(b), nil
}

// flush 把最后没有换行的半行也记上，调用方持锁。
func (m *manager) flush(p *proc) {
	if len(p.partial) > 0 {
		p.logs.add(cleanLine(p.partial))
		p.partial = nil
	}
}

func cleanLine(b []byte) string {
	if len(b) > maxLogLine {
		b = b[:maxLogLine]
	}
	s := strings.TrimRight(string(b), "\r")
	return strings.ToValidUTF8(s, "?")
}
