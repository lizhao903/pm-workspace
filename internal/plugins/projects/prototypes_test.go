package projects

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 空闲端口：先绑一个系统分配的再关掉
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

func argvBody(t *testing.T, name, dir string, port int, argv ...string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"name": name, "dir": dir, "port": port, "argv": argv})
	return string(b)
}

// 轮询原型直到 ok 为真，超时失败
func waitProto(t *testing.T, h http.Handler, path string, ok func(p map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, out := call(t, h, "GET", path, "")
		p, _ := out["data"].(map[string]any)
		if p != nil && ok(p) {
			return p
		}
		if time.Now().After(deadline) {
			t.Fatalf("等 %s 超时：%v", path, out)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil || errors.Is(syscall.Kill(pid, 0), syscall.EPERM)
}

func TestPrototypesAPI(t *testing.T) {
	r, h, d := setup(t)
	base := "/api/projects/obj_p1/prototypes"
	dir := t.TempDir()

	if code, out := call(t, h, "GET", base, ""); code != 200 || len(out["data"].([]any)) != 0 {
		t.Fatalf("空列表：%d %v", code, out)
	}

	// 一行命令按规则拆成参数数组，名字默认取命令
	code, out := call(t, h, "POST", base, `{"dir":"`+dir+`/","command":"sleep  '30'","port":`+strconv.Itoa(freePort(t))+`}`)
	if code != 201 {
		t.Fatalf("新增：%d %v", code, out)
	}
	p := out["data"].(map[string]any)
	if p["name"] != "sleep" || p["dir"] != dir || p["status"] != "stopped" || p["last_crash"] != nil ||
		!strings.HasPrefix(p["id"].(string), "pt_") || len(p["argv"].([]any)) != 2 || p["argv"].([]any)[1] != "30" {
		t.Fatalf("新增返回：%v", p)
	}
	sleepID := p["id"].(string)
	sleepPath := base + "/" + sleepID

	// 校验：保留端口说明原因，命令不经 shell，目录必须是存在的绝对路径
	for body, want := range map[string]string{
		`{"dir":"` + dir + `","command":"sleep 1","port":7777}`:             "真实数据的工作台服务",
		`{"dir":"` + dir + `","command":"sleep 1","port":7796}`:             "测试实例",
		`{"dir":"` + dir + `","command":"sleep 1","port":7780}`:             "正式前端的开发服务",
		`{"dir":"` + dir + `","command":"sleep 1","port":80}`:               "1024 到 65535",
		`{"dir":"` + dir + `","command":"npm run dev | tee x","port":5173}`: "sh -c",
		`{"dir":"` + dir + `","command":"echo $HOME","port":5173}`:          "不经 shell",
		`{"dir":"` + dir + `","command":"PORT=1 npm start","port":5173}`:    "环境变量",
		`{"dir":"` + dir + `","command":"echo 'x","port":5173}`:             "unclosed",
		`{"dir":"` + dir + `","command":"  ","port":5173}`:                  "required",
		`{"dir":"` + dir + `","command":"a","argv":["a"],"port":5173}`:      "either",
		`{"dir":"web","command":"sleep 1","port":5173}`:                     "absolute",
		`{"dir":"` + dir + `/nope","command":"sleep 1","port":5173}`:        "does not exist",
		`{"dir":"` + dir + `","command":"sleep 1"}`:                         "required",
	} {
		code, out := call(t, h, "POST", base, body)
		msg, _ := out["error"].(map[string]any)["message"].(string)
		if code != 400 || !strings.Contains(msg, want) {
			t.Fatalf("%s 应 400 且含 %q：%d %v", body, want, code, out)
		}
	}
	if code, out := call(t, h, "PATCH", sleepPath, `{"port":7777}`); code != 400 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "7777") {
		t.Fatalf("改成 7777 应 400：%d %v", code, out)
	}
	if code, _ := call(t, h, "GET", "/api/projects/obj_t1/prototypes", ""); code != 404 {
		t.Fatalf("任务不是项目应 404：%d", code)
	}
	if code, _ := call(t, h, "POST", "/api/projects/obj_p1/prototypes/pt_none/start", ""); code != 404 {
		t.Fatalf("不存在的原型应 404：%d", code)
	}

	// 启动：不监听端口的命令停在 starting；运行中不能改、不能删、不能重复启动
	if code, out := call(t, h, "POST", sleepPath+"/start", ""); code != 200 || out["data"].(map[string]any)["status"] != "starting" {
		t.Fatalf("启动：%d %v", code, out)
	}
	p = waitProto(t, h, sleepPath, func(p map[string]any) bool { return p["pid"].(float64) > 0 })
	pid := int(p["pid"].(float64))
	if !alive(pid) || p["started_at"] == nil {
		t.Fatalf("进程应在：%v", p)
	}
	if code, _ := call(t, h, "POST", sleepPath+"/start", ""); code != 409 {
		t.Fatalf("重复启动应 409：%d", code)
	}
	if code, _ := call(t, h, "PATCH", sleepPath, `{"name":"x"}`); code != 409 {
		t.Fatalf("运行中改应 409：%d", code)
	}
	if code, _ := call(t, h, "DELETE", sleepPath, ""); code != 409 {
		t.Fatalf("运行中删应 409：%d", code)
	}

	// 同端口的另一个原型启动被拒，说明被谁占着
	sp := int(p["port"].(float64))
	_, out = call(t, h, "POST", base, argvBody(t, "同端口", dir, sp, "sleep", "30"))
	twinPath := base + "/" + out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, h, "POST", twinPath+"/start", ""); code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "项目一 / sleep") {
		t.Fatalf("同端口应 409：%d %v", code, out)
	}

	// 停止：状态回到 stopped，进程没了，不记崩溃
	if code, out := call(t, h, "POST", sleepPath+"/stop", ""); code != 200 || out["data"].(map[string]any)["status"] != "stopped" {
		t.Fatalf("停止：%d %v", code, out)
	}
	if alive(pid) {
		t.Fatalf("停止后进程 %d 还在", pid)
	}
	if _, out := call(t, h, "GET", sleepPath+"/crashes", ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("主动停止不算崩溃：%v", out)
	}
	if code, _ := call(t, h, "POST", sleepPath+"/stop", ""); code != 200 {
		t.Fatalf("停两次照样 200：%d", code)
	}

	// 端口被本机别的程序占着（能连上，按外部运行说明原因）
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	busy := l.Addr().(*net.TCPAddr).Port
	_, out = call(t, h, "POST", base, argvBody(t, "占用", dir, busy, "sleep", "30"))
	busyPath := base + "/" + out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, h, "POST", busyPath+"/start", ""); code != 409 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "不是这里启动的") {
		t.Fatalf("端口被占应 409：%d %v", code, out)
	}
	_ = l.Close()

	// 崩溃：记退出码和最后的日志，stdout 和 stderr 都在
	_, out = call(t, h, "POST", base, argvBody(t, "会崩", dir, freePort(t), "/bin/sh", "-c", "echo hi; echo oops >&2; exit 3"))
	crashPath := base + "/" + out["data"].(map[string]any)["id"].(string)
	if code, out := call(t, h, "POST", crashPath+"/start", ""); code != 200 {
		t.Fatalf("启动会崩的：%d %v", code, out)
	}
	p = waitProto(t, h, crashPath, func(p map[string]any) bool { return p["status"] == "crashed" })
	lc, _ := p["last_crash"].(map[string]any)
	if lc == nil || lc["exit_code"] != 3.0 || !strings.Contains(p["error"].(string), "退出码 3") {
		t.Fatalf("崩溃信息：%v", p)
	}
	// 崩溃记一条运行异常（INC-01a）：warn、模块项目原型、指纹 proto:<id>:crash，上下文带命令
	protoID := strings.TrimPrefix(crashPath, base+"/")
	var lvl, module, title, ctxJSON string
	incDeadline := time.Now().Add(5 * time.Second)
	for {
		err := d.R.QueryRow(`SELECT level, module, title, context FROM incidents WHERE fingerprint = ?`, "proto:"+protoID+":crash").
			Scan(&lvl, &module, &title, &ctxJSON)
		if err == nil {
			break
		}
		if time.Now().After(incDeadline) {
			t.Fatalf("崩溃没记运行异常：%v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if lvl != "warn" || module != "项目原型" || title != "「会崩」启动失败" || !strings.Contains(ctxJSON, "/bin/sh") {
		t.Fatalf("崩溃的运行异常：%s %s %s %s", lvl, module, title, ctxJSON)
	}
	logText := strings.Join(toStrings(lc["log"].([]any)), "\n")
	if !strings.Contains(logText, "hi") || !strings.Contains(logText, "oops") || !strings.Contains(logText, "$ /bin/sh -c") {
		t.Fatalf("崩溃日志：%q", logText)
	}
	_, out = call(t, h, "GET", crashPath+"/logs", "")
	lines := out["data"].([]any)
	last := out["meta"].(map[string]any)["last_seq"].(float64)
	if len(lines) < 4 || lines[len(lines)-1].(map[string]any)["text"] != "[崩溃] 退出码 3" || last != lines[len(lines)-1].(map[string]any)["seq"] {
		t.Fatalf("日志：%v", out)
	}
	if _, out := call(t, h, "GET", crashPath+"/logs?after="+strconv.Itoa(int(last)), ""); len(out["data"].([]any)) != 0 {
		t.Fatalf("after 之后没有新行：%v", out)
	}
	if code, _ := call(t, h, "GET", crashPath+"/logs?limit=0", ""); code != 400 {
		t.Fatalf("limit=0 应 400：%d", code)
	}
	if _, out := call(t, h, "GET", crashPath+"/crashes", ""); len(out["data"].([]any)) != 1 {
		t.Fatalf("崩溃记录：%v", out)
	}

	// 停止会清掉整个进程组：sh 拉起的 sleep 子进程也一起停
	_, out = call(t, h, "POST", base, argvBody(t, "有子进程", dir, freePort(t), "/bin/sh", "-c", "sleep 300 & echo child=$!; wait"))
	groupPath := base + "/" + out["data"].(map[string]any)["id"].(string)
	call(t, h, "POST", groupPath+"/start", "")
	child := 0
	deadline := time.Now().Add(5 * time.Second)
	for child == 0 && time.Now().Before(deadline) {
		_, out = call(t, h, "GET", groupPath+"/logs", "")
		for _, l := range out["data"].([]any) {
			if s, ok := strings.CutPrefix(l.(map[string]any)["text"].(string), "child="); ok {
				child, _ = strconv.Atoi(s)
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if child == 0 || !alive(child) {
		t.Fatalf("子进程没起来：%v", out)
	}
	call(t, h, "POST", groupPath+"/stop", "")
	waitGone(t, child)

	// 真的监听端口的命令进入 running
	if py, err := exec.LookPath("python3"); err == nil {
		port := freePort(t)
		_, out = call(t, h, "POST", base, argvBody(t, "静态站", dir, port, py, "-m", "http.server", strconv.Itoa(port), "--bind", "127.0.0.1"))
		pyPath := base + "/" + out["data"].(map[string]any)["id"].(string)
		call(t, h, "POST", pyPath+"/start", "")
		waitProto(t, h, pyPath, func(p map[string]any) bool { return p["status"] == "running" })
		resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/")
		if err != nil {
			t.Fatalf("原型站点访问不了：%v", err)
		}
		_ = resp.Body.Close()
		call(t, h, "POST", pyPath+"/stop", "")
		if _, out := call(t, h, "GET", pyPath, ""); out["data"].(map[string]any)["status"] != "stopped" {
			t.Fatalf("停止后：%v", out)
		}
	}

	// 停用插件时停掉在跑的原型，路由 404；重新启用后都是已停止
	call(t, h, "POST", sleepPath+"/start", "")
	p = waitProto(t, h, sleepPath, func(p map[string]any) bool { return p["pid"].(float64) > 0 })
	pid = int(p["pid"].(float64))
	ctx := context.Background()
	if err := r.Disable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, h, "GET", base, ""); code != 404 {
		t.Fatalf("停用后应 404：%d", code)
	}
	waitGone(t, pid)
	if err := r.Enable(ctx, "projects"); err != nil {
		t.Fatal(err)
	}
	if _, out := call(t, h, "GET", sleepPath, ""); out["data"].(map[string]any)["status"] != "stopped" {
		t.Fatalf("重新启用后应已停止：%v", out)
	}

	// 删除：不在跑的可以删，崩溃记录一起删
	if code, _ := call(t, h, "DELETE", crashPath, ""); code != 200 {
		t.Fatalf("删除：%d", code)
	}
	if code, _ := call(t, h, "GET", crashPath, ""); code != 404 {
		t.Fatalf("删后应 404：%d", code)
	}
}

// 7778（原型站点 web-next）不再保留，能登记成原型（PJ-04c）；只登记不启动，不碰那个端口上的进程
func TestPrototypePort7778Allowed(t *testing.T) {
	_, h, _ := setup(t)
	base := "/api/projects/obj_p1/prototypes"
	code, out := call(t, h, "POST", base, `{"name":"原型站点","dir":"`+t.TempDir()+`","command":"npm run dev","port":7778}`)
	if code != 201 || out["data"].(map[string]any)["port"] != 7778.0 {
		t.Fatalf("7778 应能新增：%d %v", code, out)
	}
	if code, _ := call(t, h, "DELETE", base+"/"+out["data"].(map[string]any)["id"].(string), ""); code != 200 {
		t.Fatalf("删：%d", code)
	}
}

// 端口被别的程序（这里是测试自己开的监听）占着：状态 external，url 照给、pid 为 0；
// 启动 409 说明原因，停止 200 不发信号、状态不变；汇总算在跑。监听关掉后缓存过期回到 stopped（PJ-04c）
func TestPrototypeExternal(t *testing.T) {
	_, h, _ := setup(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := l.Addr().(*net.TCPAddr).Port
	base := "/api/projects/obj_p1/prototypes"
	code, out := call(t, h, "POST", base, argvBody(t, "外部站", t.TempDir(), port, "sleep", "30"))
	if code != 201 {
		t.Fatalf("新增：%d %v", code, out)
	}
	p := out["data"].(map[string]any)
	path := base + "/" + p["id"].(string)
	if p["status"] != "external" || p["pid"] != 0.0 || p["started_at"] != nil || p["url"] != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("新增后应是 external：%v", p)
	}
	_, out = call(t, h, "GET", base, "")
	if rows := out["data"].([]any); len(rows) != 1 || rows[0].(map[string]any)["status"] != "external" {
		t.Fatalf("列表里应是 external：%v", out)
	}

	code, out = call(t, h, "POST", path+"/start", "")
	if msg, _ := out["error"].(map[string]any)["message"].(string); code != 409 || !strings.Contains(msg, "不是这里启动的") || !strings.Contains(msg, "直接打开") {
		t.Fatalf("外部在跑时启动应 409 并说明：%d %v", code, out)
	}
	code, out = call(t, h, "POST", path+"/stop", "")
	if code != 200 || out["data"].(map[string]any)["status"] != "external" || out["data"].(map[string]any)["pid"] != 0.0 {
		t.Fatalf("停止应 200 且状态不变：%d %v", code, out)
	}
	// 停止没动监听：还能连上
	c, err := net.DialTimeout("tcp", l.Addr().String(), time.Second)
	if err != nil {
		t.Fatalf("停止后外部监听应还在：%v", err)
	}
	_ = c.Close()
	_, out = call(t, h, "GET", "/api/projects/summary", "")
	if pt := out["data"].([]any)[0].(map[string]any)["prototypes"].(map[string]any); pt["total"] != 1.0 || pt["running"] != 1.0 {
		t.Fatalf("汇总应把 external 算在跑：%v", pt)
	}
	_, out = call(t, h, "GET", path+"/logs", "")
	if out["meta"].(map[string]any)["status"] != "external" {
		t.Fatalf("日志 meta 的状态：%v", out)
	}

	_ = l.Close()
	waitProto(t, h, path, func(p map[string]any) bool { return p["status"] == "stopped" })
}

// 服务关闭（注册表 Close）时也停掉原型
func TestPrototypesStopOnClose(t *testing.T) {
	r, h, _ := setup(t)
	base := "/api/projects/obj_p1/prototypes"
	_, out := call(t, h, "POST", base, argvBody(t, "s", t.TempDir(), freePort(t), "sleep", "30"))
	path := base + "/" + out["data"].(map[string]any)["id"].(string)
	call(t, h, "POST", path+"/start", "")
	p := waitProto(t, h, path, func(p map[string]any) bool { return p["pid"].(float64) > 0 })
	pid := int(p["pid"].(float64))
	r.Close()
	waitGone(t, pid)
}

func TestSplitCommand(t *testing.T) {
	for in, want := range map[string][]string{
		`npm run dev -- --port 5173`:         {"npm", "run", "dev", "--", "--port", "5173"},
		`python3 -m http.server 8080`:        {"python3", "-m", "http.server", "8080"},
		`sh -c 'echo $HOME | wc -c'`:         {"sh", "-c", "echo $HOME | wc -c"},
		`node "my app.js" --title="a \"b\""`: {"node", "my app.js", `--title=a "b"`},
		`ls a\ b ''`:                         {"ls", "a b", ""},
		`vite --host=0.0.0.0 --base=/~me/`:   {"vite", "--host=0.0.0.0", "--base=/~me/"},
	} {
		got, err := splitCommand(in)
		if err != nil || strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("%s：%q %v", in, got, err)
		}
		if back, err := splitCommand(joinCommand(got)); err != nil || strings.Join(back, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("拼回再拆 %s：%q %v", joinCommand(got), back, err)
		}
	}
	for _, in := range []string{`a | b`, `a > x`, `a; b`, `a && b`, "a `b`", `a $(b)`, `ls *.go`, `cd ~/x`, `A=1 b`, `a 'b`, `a \`} {
		if _, err := splitCommand(in); err == nil {
			t.Fatalf("%s 应拒绝", in)
		}
	}
}

func TestRing(t *testing.T) {
	var r ring
	for i := 0; i < logLines+5; i++ {
		r.add(strconv.Itoa(i))
	}
	if len(r.lines) != logLines || r.lines[0].Seq != 6 || r.next != logLines+5 {
		t.Fatalf("环形缓冲：len=%d first=%d next=%d", len(r.lines), r.lines[0].Seq, r.next)
	}
	if got := r.after(r.next-3, 0); len(got) != 3 {
		t.Fatalf("after：%v", got)
	}
	if got := r.after(0, 2); len(got) != 2 || got[1].Seq != r.next {
		t.Fatalf("limit 取最新：%v", got)
	}
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("进程 %d 没停", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func toStrings(a []any) []string {
	out := make([]string, len(a))
	for i, v := range a {
		out[i], _ = v.(string)
	}
	return out
}
