// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package selfupdate 是设置页「版本更新」（SYS-UPD）的后端：看源码目录比正在跑的版本新多少，
// 点了就按固定几步把工作台更新到源码目录里的最新代码并原地重启。
//
// 「最新版本」只有一个来源：本机源码目录（正在跑的二进制所在 bin/ 的上一级、有 go.mod 和 cmd/pmw 的那个仓库）。
// 仓库没有远端，也就不去拉代码；构建用的是磁盘上的当前内容，含未提交的改动，和 scripts/dev-instance.sh 一致。
//
// 几条硬约束：
//   - 先备份库，再构建；构建产物先写 <程序>.new，自检过了才替换。任何一步失败都不碰正在跑的二进制，旧版本照常服务。
//   - 替换时旧的改名成 <程序>.prev 留着回退；MCP 程序（bin/pmw-mcp 或 bin/pmw-mcp-dev）一起换。
//   - 重启交给 main：同一个进程原地 exec 新二进制，参数、环境、进程号都不变，pid 文件、数据目录、vault.key 跟着不变。
//   - 同一时间只跑一次更新。
package selfupdate

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// Build 是正在跑的这个程序的构建信息（Go 编译时自动记的 vcs.*）
type Build struct {
	Version  string `json:"version"`
	Commit   string `json:"commit"`
	Modified bool   `json:"modified"`
	// CommitAt 是那次提交的时间（vcs.time），不是编译时间
	CommitAt string `json:"commit_at"`
	Binary   string `json:"binary"`
}

// Commit 是一条提交的摘要
type Commit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	At      string `json:"at"`
}

// Source 是源码目录现在的样子
type Source struct {
	Repo   string  `json:"repo"`
	Branch string  `json:"branch"`
	Head   *Commit `json:"head"`
	// Dirty 是还没提交的改动文件数（git status --porcelain 的行数）
	Dirty int `json:"dirty"`
	// Ahead 是正在跑的版本之后源码里多出来的提交，新的在前，最多 MaxCommits 条；正在跑的提交不在这条线上时为空
	Ahead      []Commit `json:"ahead"`
	AheadTotal int      `json:"ahead_total"`
	// Diverged 正在跑的提交不是 HEAD 的祖先（换过分支、改过历史），这时列不出新提交，只能说「和源码不同」
	Diverged bool `json:"diverged"`
}

// Step 是更新里的一步
type Step struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// State：pending / running / done / failed / skipped
	State string `json:"state"`
	Note  string `json:"note,omitempty"`
}

// Job 是最近一次更新
type Job struct {
	// State：running / failed / restarting
	State     string `json:"state"`
	Steps     []Step `json:"steps"`
	Error     string `json:"error,omitempty"`
	Log       string `json:"log"`
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at,omitempty"`
}

// Status 是 GET /api/admin/update 回的
type Status struct {
	Running Build   `json:"running"`
	Source  *Source `json:"source"`
	// Available 源码和正在跑的不一样：有新提交、HEAD 不是正在跑的那个，或者有未提交的改动
	Available bool `json:"available"`
	// Blocked 不能更新的原因（找不到源码目录、缺 go / npm 等）；能更新时为空
	Blocked string `json:"blocked,omitempty"`
	Job     *Job   `json:"job"`
}

// MaxCommits 新提交最多列这么多条
const MaxCommits = 30

// logMax 日志只留最后这么多字节
const logMax = 16 << 10

// Snapshotter 备份库（store.Snapshot 的子集），回快照文件路径
type Snapshotter func(ctx context.Context) (string, error)

// Updater 管一个工作台进程的版本更新
type Updater struct {
	// Exe 是正在跑的二进制的绝对路径
	Exe string
	// Repo 源码目录；空串表示没找到
	Repo string
	// Version 是 -ldflags 打进去的版本号，构建新版本时沿用
	Version string
	// Snapshot 备份库
	Snapshot Snapshotter
	// Restart 换好二进制后由它原地重启；回来之前不保证进程还在
	Restart func(exe string)
	// Timeout 整个更新的上限
	Timeout time.Duration

	mu  sync.Mutex
	job *Job
	log bytes.Buffer
}

// New 按正在跑的二进制找源码目录：exe 所在目录的上一级有 go.mod 和 cmd/pmw/ 就是
func New(exe, version string, snap Snapshotter, restart func(string)) *Updater {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return &Updater{Exe: exe, Repo: FindRepo(exe), Version: version, Snapshot: snap, Restart: restart, Timeout: 15 * time.Minute}
}

// FindRepo 从二进制位置往上找两级，找有 go.mod 和 cmd/pmw/main.go 的目录
func FindRepo(exe string) string {
	dir := filepath.Dir(exe)
	for i := 0; i < 2; i++ {
		dir = filepath.Dir(dir)
		if isFile(filepath.Join(dir, "go.mod")) && isFile(filepath.Join(dir, "cmd", "pmw", "main.go")) {
			return dir
		}
	}
	// 二进制就在仓库根目录（go build -o ./pmw）
	d := filepath.Dir(exe)
	if isFile(filepath.Join(d, "go.mod")) && isFile(filepath.Join(d, "cmd", "pmw", "main.go")) {
		return d
	}
	return ""
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// RunningBuild 读这个进程自己的构建信息
func RunningBuild(version, exe string) Build {
	b := Build{Version: version, Binary: exe}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return b
	}
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			b.Commit = s.Value
		case "vcs.modified":
			b.Modified = s.Value == "true"
		case "vcs.time":
			b.CommitAt = s.Value
		}
	}
	return b
}

// mcpOf 和 exe 配套的 MCP 程序：pmw → pmw-mcp，pmw-dev → pmw-mcp-dev；不是这两种名字的不管
func mcpOf(exe string) string {
	dir, base := filepath.Dir(exe), filepath.Base(exe)
	switch {
	case base == "pmw":
		return filepath.Join(dir, "pmw-mcp")
	case strings.HasPrefix(base, "pmw-"):
		return filepath.Join(dir, "pmw-mcp-"+strings.TrimPrefix(base, "pmw-"))
	}
	return ""
}

// toolEnv 补上 go、npm 常见的安装位置：LaunchAgent 起的进程 PATH 只有系统目录
func toolEnv() []string {
	env := os.Environ()
	extra := []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		extra = append(extra, filepath.Join(home, "go", "bin"), filepath.Join(home, ".local", "bin"))
	}
	path := os.Getenv("PATH")
	for _, e := range extra {
		if !strings.Contains(":"+path+":", ":"+e+":") {
			path += ":" + e
		}
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, "PATH=") {
			out = append(out, kv)
		}
	}
	return append(out, "PATH="+path)
}

func lookTool(name string) (string, error) {
	for _, kv := range toolEnv() {
		if !strings.HasPrefix(kv, "PATH=") {
			continue
		}
		for _, d := range filepath.SplitList(strings.TrimPrefix(kv, "PATH=")) {
			p := filepath.Join(d, name)
			if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				return p, nil
			}
		}
	}
	return "", fmt.Errorf("找不到 %s", name)
}

func (u *Updater) git(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", u.Repo}, args...)...)
	cmd.Env = toolEnv()
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimRight(string(out), "\n"), nil
}

func parseCommits(out string) []Commit {
	var cs []Commit
	for _, line := range strings.Split(out, "\n") {
		f := strings.SplitN(line, "\x00", 3)
		if len(f) == 3 {
			cs = append(cs, Commit{SHA: f[0], Subject: f[1], At: f[2]})
		}
	}
	return cs
}

// source 读源码目录的分支、HEAD、未提交改动数，以及 running 之后的新提交
func (u *Updater) source(ctx context.Context, running string) (*Source, error) {
	src := &Source{Repo: u.Repo}
	var err error
	if src.Branch, err = u.git(ctx, "rev-parse", "--abbrev-ref", "HEAD"); err != nil {
		return nil, err
	}
	head, err := u.git(ctx, "log", "-1", "--format=%H%x00%s%x00%cI")
	if err != nil {
		return nil, err
	}
	if cs := parseCommits(head); len(cs) == 1 {
		src.Head = &cs[0]
	}
	st, err := u.git(ctx, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	for _, l := range strings.Split(st, "\n") {
		if strings.TrimSpace(l) != "" {
			src.Dirty++
		}
	}
	if running == "" || src.Head == nil || running == src.Head.SHA {
		return src, nil
	}
	if _, err := u.git(ctx, "merge-base", "--is-ancestor", running, "HEAD"); err != nil {
		src.Diverged = true
		return src, nil
	}
	n, err := u.git(ctx, "rev-list", "--count", running+"..HEAD")
	if err == nil {
		_, _ = fmt.Sscan(n, &src.AheadTotal)
	}
	out, err := u.git(ctx, "log", fmt.Sprintf("-%d", MaxCommits), "--format=%H%x00%s%x00%cI", running+"..HEAD")
	if err == nil {
		src.Ahead = parseCommits(out)
	}
	return src, nil
}

// Status 当前版本、源码目录、能不能更新、最近一次更新
func (u *Updater) Status(ctx context.Context) Status {
	st := Status{Running: RunningBuild(u.Version, u.Exe), Job: u.snapshotJob()}
	if u.Repo == "" {
		st.Blocked = "没找到源码目录：工作台不是从源码仓库的 bin/ 里跑起来的，没法就地更新"
		return st
	}
	src, err := u.source(ctx, st.Running.Commit)
	if err != nil {
		st.Blocked = "读不了源码目录：" + err.Error()
		return st
	}
	st.Source = src
	st.Available = src.Head != nil && (src.Head.SHA != st.Running.Commit || src.Dirty > 0 || st.Running.Modified)
	for _, t := range []string{"go", "npm", "make"} {
		if _, err := lookTool(t); err != nil {
			st.Blocked = fmt.Sprintf("构建要用的 %s 找不到（PATH 里没有，也不在常见安装位置）", t)
			break
		}
	}
	return st
}

func (u *Updater) snapshotJob() *Job {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.job == nil {
		return nil
	}
	j := *u.job
	j.Steps = append([]Step(nil), u.job.Steps...)
	j.Log = u.log.String()
	return &j
}

// ErrBusy 已经有一次更新在跑
var ErrBusy = errors.New("已经在更新了")

// Start 开始一次更新，马上返回；进度看 Status().Job
func (u *Updater) Start() error {
	if u.Repo == "" {
		return errors.New("没找到源码目录，没法就地更新")
	}
	u.mu.Lock()
	if u.job != nil && (u.job.State == "running" || u.job.State == "restarting") {
		u.mu.Unlock()
		return ErrBusy
	}
	u.job = &Job{State: "running", StartedAt: time.Now().UTC().Format(time.RFC3339), Steps: []Step{
		{Key: "backup", Label: "备份数据库", State: "pending"},
		{Key: "frontend", Label: "构建前端", State: "pending"},
		{Key: "backend", Label: "构建后端和 MCP", State: "pending"},
		{Key: "check", Label: "自检新版本", State: "pending"},
		{Key: "swap", Label: "替换并重启", State: "pending"},
	}}
	u.log.Reset()
	u.mu.Unlock()
	go u.run()
	return nil
}

func (u *Updater) logf(format string, a ...any) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.appendLog(fmt.Sprintf(format, a...) + "\n")
}

func (u *Updater) appendLog(s string) {
	u.log.WriteString(s)
	if u.log.Len() > logMax {
		b := u.log.Bytes()
		cut := b[len(b)-logMax:]
		if i := bytes.IndexByte(cut, '\n'); i >= 0 && i < len(cut)-1 {
			cut = cut[i+1:]
		}
		rest := append([]byte(nil), cut...)
		u.log.Reset()
		u.log.Write(rest)
	}
}

func (u *Updater) setStep(key, state, note string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for i := range u.job.Steps {
		if u.job.Steps[i].Key == key {
			u.job.Steps[i].State = state
			u.job.Steps[i].Note = note
		}
	}
}

func (u *Updater) fail(key string, err error) {
	u.setStep(key, "failed", err.Error())
	u.mu.Lock()
	defer u.mu.Unlock()
	u.job.State = "failed"
	u.job.Error = err.Error()
	u.job.EndedAt = time.Now().UTC().Format(time.RFC3339)
	u.appendLog("失败：" + err.Error() + "\n正在跑的旧版本没有动。\n")
}

// cmd 在源码目录跑一条命令，输出逐行进日志
func (u *Updater) cmd(ctx context.Context, name string, args ...string) error {
	bin, err := lookTool(name)
	if err != nil {
		return err
	}
	u.logf("$ %s %s", name, strings.Join(args, " "))
	c := exec.CommandContext(ctx, bin, args...)
	c.Dir = u.Repo
	c.Env = toolEnv()
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	c.Stdout, c.Stderr = pw, pw
	if err := c.Start(); err != nil {
		_ = pr.Close()
		_ = pw.Close()
		return err
	}
	_ = pw.Close()
	sc := bufio.NewScanner(pr)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		u.mu.Lock()
		u.appendLog(sc.Text() + "\n")
		u.mu.Unlock()
	}
	_ = pr.Close()
	if err := c.Wait(); err != nil {
		return fmt.Errorf("%s %s 失败：%w", name, strings.Join(args, " "), err)
	}
	return nil
}

func (u *Updater) run() {
	ctx, cancel := context.WithTimeout(context.Background(), u.Timeout)
	defer cancel()
	exe, mcp := u.Exe, mcpOf(u.Exe)
	newExe, newMCP := exe+".new", ""
	defer func() {
		// 没走到替换的，把半成品删掉
		if u.snapshotJob().State == "failed" {
			_ = os.Remove(newExe)
			if newMCP != "" {
				_ = os.Remove(newMCP)
			}
		}
	}()

	u.setStep("backup", "running", "")
	snap, err := u.Snapshot(ctx)
	if err != nil {
		u.fail("backup", fmt.Errorf("备份没成：%w", err))
		return
	}
	u.logf("已备份到 %s", snap)
	u.setStep("backup", "done", snap)

	u.setStep("frontend", "running", "")
	if err := u.cmd(ctx, "make", "frontend"); err != nil {
		u.fail("frontend", err)
		return
	}
	u.setStep("frontend", "done", "")

	u.setStep("backend", "running", "")
	ld := "-X main.version=" + u.Version
	if err := u.cmd(ctx, "go", "build", "-ldflags", ld, "-o", newExe, "./cmd/pmw"); err != nil {
		u.fail("backend", err)
		return
	}
	if mcp != "" {
		newMCP = mcp + ".new"
		if err := u.cmd(ctx, "go", "build", "-ldflags", ld, "-o", newMCP, "./cmd/pmw-mcp"); err != nil {
			u.fail("backend", err)
			return
		}
	}
	u.setStep("backend", "done", "")

	// 自检：新程序能跑起来、认得参数（-h 打印用法后以 0 退出）
	u.setStep("check", "running", "")
	cctx, ccancel := context.WithTimeout(ctx, 20*time.Second)
	out, err := exec.CommandContext(cctx, newExe, "-h").CombinedOutput()
	ccancel()
	if err != nil && !strings.Contains(string(out), "-addr") {
		u.fail("check", fmt.Errorf("新版本跑不起来：%v %s", err, strings.TrimSpace(string(out))))
		return
	}
	u.setStep("check", "done", "")

	u.setStep("swap", "running", "")
	if err := swap(exe, newExe); err != nil {
		u.fail("swap", err)
		return
	}
	u.logf("已替换 %s（旧的留在 %s.prev）", exe, exe)
	if newMCP != "" {
		if err := swap(mcp, newMCP); err != nil {
			// 主程序已经换了，MCP 没换上不拦重启，记一笔
			u.logf("MCP 程序没换上：%v", err)
		} else {
			u.logf("已替换 %s", mcp)
		}
	}
	u.mu.Lock()
	u.job.State = "restarting"
	u.job.EndedAt = time.Now().UTC().Format(time.RFC3339)
	u.appendLog("正在重启…\n")
	u.mu.Unlock()
	u.setStep("swap", "running", "正在重启")
	if u.Restart != nil {
		u.Restart(exe)
	}
}

// swap 把 cur 改名成 cur.prev，再把 next 改名成 cur；第二步失败时把 cur 换回来
func swap(cur, next string) error {
	if _, err := os.Stat(next); err != nil {
		return fmt.Errorf("新程序不在：%w", err)
	}
	prev := cur + ".prev"
	_ = os.Remove(prev)
	hadCur := isFile(cur)
	if hadCur {
		if err := os.Rename(cur, prev); err != nil {
			return fmt.Errorf("旧程序改名失败：%w", err)
		}
	}
	if err := os.Rename(next, cur); err != nil {
		if hadCur {
			_ = os.Rename(prev, cur)
		}
		return fmt.Errorf("新程序换上失败：%w", err)
	}
	return nil
}
