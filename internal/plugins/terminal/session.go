package terminal

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
)

// 终端会话管理（TERM-01a）：每次启用插件一个 manager，会话和输出只在内存。
// shell 起在自己的会话和进程组里（pty.Start 默认 Setsid），结束时按进程组发信号，不按名字找进程。
// 插件停用、服务关闭时常驻任务的 ctx 被取消，closeAll 结束这里起的全部会话。

const (
	maxSessions = 16                     // 同时在跑的会话上限
	maxKept     = 32                     // 连已退出的一起最多留多少个，超出丢最早退出的
	ringBytes   = 256 << 10              // 每个会话留多少字节输出，重连时先补发
	subQueue    = 256                    // 每个连接最多积压多少块输出，积压满了断开让它重连
	hupGrace    = 2 * time.Second        // SIGHUP 后等多久再 SIGKILL
	killWait    = 2 * time.Second        // SIGKILL 后最多再等多久
	drainWait   = 500 * time.Millisecond // shell 退出后等剩余输出读完的上限
	minSize     = 1
	maxSize     = 1000
)

const (
	statusRunning = "running"
	statusExited  = "exited"
)

var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

// Session 是接口返回的一个终端会话。
type Session struct {
	ID        string     `json:"id"`
	Cwd       string     `json:"cwd"`
	Shell     string     `json:"shell"`
	Cols      int        `json:"cols"`
	Rows      int        `json:"rows"`
	PID       int        `json:"pid"`
	Status    string     `json:"status"`
	ExitCode  *int       `json:"exit_code"`
	Output    int64      `json:"output_bytes"`
	CreatedAt time.Time  `json:"created_at"`
	ExitedAt  *time.Time `json:"exited_at"`
}

// 订阅结束的原因，ws 按它决定关闭码
const (
	endExited  = "exited"
	endClosed  = "closed"
	endTooSlow = "too_slow"
)

type sub struct {
	ch  chan []byte
	end string // 关 ch 之前写好
}

type session struct {
	id, cwd, shell string
	createdAt      time.Time
	cmd            *exec.Cmd
	ptmx           *os.File
	pid            int
	done           chan struct{} // shell 退出、状态写好后关
	readDone       chan struct{} // 读 pty 的协程退出后关
	closeOnce      sync.Once

	mu       sync.Mutex
	cols     int
	rows     int
	buf      []byte // 最近 ringBytes 字节输出
	total    int64  // 累计输出字节数，buf 末尾的绝对位置
	subs     map[*sub]struct{}
	exited   bool
	exitCode int
	exitedAt time.Time
}

func (s *session) view() Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := Session{ID: s.id, Cwd: s.cwd, Shell: s.shell, Cols: s.cols, Rows: s.rows, PID: s.pid,
		Status: statusRunning, Output: s.total, CreatedAt: s.createdAt}
	if s.exited {
		v.Status = statusExited
		code, at := s.exitCode, s.exitedAt
		v.ExitCode, v.ExitedAt = &code, &at
	}
	return v
}

// attach 登记一个订阅，返回 after 之后还留着的输出和它的起始位置。after 早于缓冲开头时从开头给。
// 会话已退出时 sub 为 nil，只补发输出。
func (s *session) attach(after int64) (from int64, data []byte, sb *sub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := s.total - int64(len(s.buf))
	from = max(start, min(after, s.total))
	data = append([]byte(nil), s.buf[from-start:]...)
	if s.exited {
		return from, data, nil
	}
	sb = &sub{ch: make(chan []byte, subQueue)}
	s.subs[sb] = struct{}{}
	return from, data, sb
}

func (s *session) detach(sb *sub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[sb]; ok {
		delete(s.subs, sb)
		close(sb.ch)
	}
}

// endSubs 关掉全部订阅，调用方持有 s.mu。
func (s *session) endSubs(why string) {
	for sb := range s.subs {
		sb.end = why
		close(sb.ch)
		delete(s.subs, sb)
	}
}

func (s *session) push(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.total += int64(len(p))
	s.buf = append(s.buf, p...)
	if over := len(s.buf) - ringBytes; over > 0 {
		// 丢最早的，切口挪到下一个 UTF-8 字符开头
		for over < len(s.buf) && s.buf[over]&0xC0 == 0x80 {
			over++
		}
		s.buf = append(s.buf[:0:0], s.buf[over:]...)
	}
	for sb := range s.subs {
		select {
		case sb.ch <- p:
		default:
			sb.end = endTooSlow
			close(sb.ch)
			delete(s.subs, sb)
		}
	}
}

func (s *session) readLoop() {
	defer close(s.readDone)
	buf := make([]byte, 32<<10)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.push(append([]byte(nil), buf[:n]...))
		}
		if err != nil {
			return
		}
	}
}

func (s *session) waitLoop() {
	err := s.cmd.Wait()
	code := 0
	if err != nil {
		code = -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
	}
	// 剩下的输出读完再报退出，最后几行不丢
	select {
	case <-s.readDone:
	case <-time.After(drainWait):
	}
	s.mu.Lock()
	s.exited, s.exitCode, s.exitedAt = true, code, time.Now().UTC()
	s.endSubs(endExited)
	s.mu.Unlock()
	close(s.done)
}

func (s *session) write(p []byte) error {
	_, err := s.ptmx.Write(p)
	return err
}

func (s *session) resize(cols, rows int) error {
	if cols < minSize || cols > maxSize || rows < minSize || rows > maxSize {
		return apiErr(errValidation, "cols 和 rows 要在 %d 到 %d 之间", minSize, maxSize)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exited {
		return nil
	}
	if err := pty.Setsize(s.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return err
	}
	s.cols, s.rows = cols, rows
	return nil
}

// fgGroup 是终端前台进程组（交互 shell 给每个前台作业单开一个进程组），取不到返回 0。
func (s *session) fgGroup() int {
	var pgrp int32
	rc, err := s.ptmx.SyscallConn()
	if err != nil {
		return 0
	}
	var errno syscall.Errno
	_ = rc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(syscall.TIOCGPGRP), uintptr(unsafe.Pointer(&pgrp)))
	})
	if errno != 0 {
		return 0
	}
	return int(pgrp)
}

func signalGroups(groups []int, sig syscall.Signal) {
	for _, g := range groups {
		if g > 1 {
			_ = syscall.Kill(-g, sig)
		}
	}
}

// close 结束会话：shell 的进程组和当时的前台进程组先 SIGHUP，等不到退出再 SIGKILL；
// shell 退出后对这些进程组补一次 SIGKILL，清掉留下的子进程。只按本会话记下的进程组发信号。
func (s *session) close() {
	s.closeOnce.Do(func() {
		groups := []int{s.pid}
		if fg := s.fgGroup(); fg > 0 && fg != s.pid {
			groups = append(groups, fg)
		}
		select {
		case <-s.done:
		default:
			signalGroups(groups, syscall.SIGHUP)
			select {
			case <-s.done:
			case <-time.After(hupGrace):
				signalGroups(groups, syscall.SIGKILL)
				select {
				case <-s.done:
				case <-time.After(killWait):
				}
			}
		}
		signalGroups(groups, syscall.SIGKILL)
		_ = s.ptmx.Close()
		s.mu.Lock()
		s.endSubs(endClosed)
		s.mu.Unlock()
	})
}

type manager struct {
	shell     string   // 空时取 $SHELL，再没有用 /bin/sh
	shellArgs []string // nil 时用 -l（登录 shell，同终端程序）
	env       []string // 追加在服务进程环境后面
	mu        sync.Mutex
	closed    bool
	sessions  map[string]*session
}

func newManager() *manager { return &manager{sessions: map[string]*session{}} }

func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "pn_" + hex.EncodeToString(b[:])
}

func (m *manager) shellPath() string {
	if m.shell != "" {
		return m.shell
	}
	if sh := os.Getenv("SHELL"); sh != "" && filepath.IsAbs(sh) {
		return sh
	}
	return "/bin/sh"
}

func (m *manager) get(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil {
		return nil, apiErr(errNotFound, "terminal session %s not found", id)
	}
	return s, nil
}

func (m *manager) list() []Session {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	out := make([]Session, 0, len(all))
	for _, s := range all {
		out = append(out, s.view())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// start 起一个 shell。cwd 已校验过是存在的绝对目录。
func (m *manager) start(cwd string, cols, rows int) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, apiErr(errConflict, "终端插件正在停用")
	}
	running := 0
	var exited []*session
	for _, s := range m.sessions {
		if s.view().Status == statusRunning {
			running++
		} else {
			exited = append(exited, s)
		}
	}
	if running >= maxSessions {
		return nil, apiErr(errConflict, "最多同时开 %d 个终端，先关掉一些", maxSessions)
	}
	if len(m.sessions) >= maxKept {
		sort.Slice(exited, func(i, j int) bool { return exited[i].view().ExitedAt.Before(*exited[j].view().ExitedAt) })
		for _, s := range exited[:min(len(exited), len(m.sessions)-maxKept+1)] {
			delete(m.sessions, s.id)
			go s.close()
		}
	}

	shell := m.shellPath()
	args := m.shellArgs
	if args == nil {
		args = []string{"-l"}
	}
	cmd := exec.Command(shell, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	cmd.Env = append(cmd.Env, m.env...)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, apiErr(errValidation, "起不来 shell %s：%v", shell, err)
	}
	s := &session{id: newSessionID(), cwd: cwd, shell: shell, createdAt: time.Now().UTC(), cmd: cmd, ptmx: ptmx,
		pid: cmd.Process.Pid, done: make(chan struct{}), readDone: make(chan struct{}),
		cols: cols, rows: rows, subs: map[*sub]struct{}{}}
	m.sessions[s.id] = s
	go s.readLoop()
	go s.waitLoop()
	return s, nil
}

// remove 结束并删掉一个会话，等进程退出后返回。
func (m *manager) remove(id string) error {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s == nil {
		return apiErr(errNotFound, "terminal session %s not found", id)
	}
	s.close()
	return nil
}

// closeAll 停用插件、服务退出时调，并发结束全部会话。
func (m *manager) closeAll() {
	m.mu.Lock()
	m.closed = true
	all := m.sessions
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.close()
		}()
	}
	wg.Wait()
}
