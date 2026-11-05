// Package fsbrowse 给界面提供本机目录列表，让用户能「点着选」工作目录。
//
// 为什么要放在服务端：浏览器拿不到本地绝对路径——File System Access API 只给
// handle 不给 path，<input webkitdirectory> 给的是相对名。要让用户选出一个能交给
// Agent 用的绝对路径，只能由服务端来列目录。
//
// 因为是服务端在读本机磁盘，这个包的重点不是「功能」而是「边界」：
//   - 目录浏览只列目录不列文件；读文件只给文档挂载用（files.go），只读、有大小上限。
//   - 只允许主目录、/Volumes、/tmp 三块地方，加上用户在设置里加的额外根（extra.go），其余一律拒绝。
//   - 字面量和解析软链后各查一道边界，两道都过才放行。
package fsbrowse

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// ErrForbidden 表示路径落在可浏览范围之外。调用方据此决定回什么状态码。
var ErrForbidden = errors.New("path is outside the browsable area")

// ErrNotDir 表示路径存在但不是目录。
var ErrNotDir = errors.New("path is not a directory")

// ErrBadRequest 表示入参本身不合法（空路径、相对路径、非法目录名）。
var ErrBadRequest = errors.New("invalid argument")

// PathError 把「给用户看的中文说明」和「给代码判断的哨兵错误」分开：
// Error() 是可以直接丢给界面的一句话，errors.Is 仍能认出是哪一类。
type PathError struct {
	Msg  string
	Kind error
}

func (e *PathError) Error() string { return e.Msg }
func (e *PathError) Unwrap() error { return e.Kind }

func badRequest(msg string) error { return &PathError{Msg: msg, Kind: ErrBadRequest} }
func notExist(msg string) error   { return &PathError{Msg: msg, Kind: fs.ErrNotExist} }
func denied(msg string) error     { return &PathError{Msg: msg, Kind: fs.ErrPermission} }

// rootsFn 是可浏览范围的来源。做成变量只为测试能换成一组受控目录——
// 用真实的 $HOME 做边界测试，换台机器就测不准了。
var rootsFn = defaultRoots

// defaultRoots 列出用户能走到的地方：
//   - 主目录：日常的东西都在这儿；
//   - /Volumes：外接盘和项目卷，本机的代码仓库就挂在这下面；
//   - /tmp：临时产物。
//
// 其余（/etc、/System、/private/var 等）一概不开。选工作目录用不到系统目录，
// 开了只是给自己留一个「服务端替你读任意路径」的口子。
func defaultRoots() []string {
	roots := []string{"/Volumes", "/tmp"}
	if h := homeDir(); h != "" {
		roots = append(roots, h)
	}
	return roots
}

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Clean(h)
}

// rootForms 把每个根展开成「原样」和「解析软链后」两种写法。
// macOS 上 /tmp 是 /private/tmp 的软链，用户传哪一种写法都该认；
// 反过来，解析后的路径也要能对上根，否则 /tmp 下的目录会被自己的边界挡住。
func rootForms() []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	for _, r := range append(rootsFn(), extraPaths()...) {
		if r == "" || !filepath.IsAbs(r) {
			continue
		}
		r = filepath.Clean(r)
		if _, err := os.Stat(r); err != nil {
			// 根本身不存在（比如某些系统没有 /Volumes）就当它没配过。
			continue
		}
		add(r)
		if real, err := filepath.EvalSymlinks(r); err == nil {
			add(real)
		}
	}
	return out
}

// within 判断 path 是否落在某个根之内。前缀后必须正好到头或紧跟一个分隔符——
// 只比前缀的话，/Users/example 会把隔壁的 /Users/exampleevil 一起放进来。
func within(path string, roots []string) bool {
	for _, r := range roots {
		r = strings.TrimSuffix(r, string(filepath.Separator))
		if path == r || strings.HasPrefix(path, r+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// outOfBounds 的说明要能让用户知道下一步干什么，只回一句「拒绝访问」等于没说。
func outOfBounds(shown string) error {
	areas := []string{}
	if h := homeDir(); h != "" {
		areas = append(areas, "主目录（"+h+"）")
	}
	areas = append(areas, "/Volumes（外接盘与项目卷）", "/tmp")
	areas = append(areas, extraPaths()...)
	return &PathError{
		Kind: ErrForbidden,
		Msg: shown + " 不在可浏览范围内。可选的范围是：" + strings.Join(areas, "、") +
			"。要用别处的目录，请在「设置 - 本机目录」里把它加为可浏览目录。",
	}
}

// resolve 是所有对外函数的入口检查，返回解析软链后的真实路径。
//
// 两道边界缺一不可：
//   - 字面量那道拦 ../ 穿越——/Users/me/../../etc 清理后就露馅了；
//   - 解析后那道拦软链逃逸——主目录里放个软链指到 /etc，字面量看着人畜无害。
//
// 返回真实路径而不是用户传的原样，是为了让界面显示的和服务端实际读的是同一个地方。
func resolve(path string) (string, error) {
	p := strings.TrimSpace(path)
	if p == "" {
		return "", badRequest("请提供一个目录路径")
	}
	if !filepath.IsAbs(p) {
		return "", badRequest("请提供绝对路径，例如 " + homeDir())
	}
	p = filepath.Clean(p)

	roots := rootForms()
	if !within(p, roots) {
		return "", outOfBounds(p)
	}

	real, err := filepath.EvalSymlinks(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", notExist("目录不存在：" + p)
	case errors.Is(err, fs.ErrPermission):
		return "", denied("没有权限访问：" + p)
	case err != nil:
		return "", badRequest("无法访问这个路径，请检查它是否正确：" + p)
	}
	// 软链逃逸：字面量在范围内，指向的地方却不在。报错里显示用户给的那个路径，
	// 不显示真实目标——他要的是「这条路走不通」，不是一份系统目录结构。
	if !within(real, roots) {
		return "", outOfBounds(p)
	}
	return real, nil
}

// wOK 是 access(2) 的 W_OK。syscall 包没导出这个常量，unix 上固定为 2。
const wOK = 0x02

// writable 用 access(2) 探可写，不往目录里落文件。
//
// 取舍：另一种做法是建个临时文件再删（internal/agent 的 CheckWorkdir 就这么做），
// 那样连只读挂载和 macOS TCC 授权都能测出来，但列一次目录要往几十个子目录里各写一次，
// 会惊动 iCloud 同步、Time Machine 和一切文件监听。列表只是给用户打个标，用 access
// 够了；用户真正定下目录时还会走 /api/agent/workdir/check 实测一次，那才是准的。
// 代价是「权限位允许但实际写不进去」的目录在列表里会显示成可写。
func writable(path string) bool {
	return syscall.Access(path, wOK) == nil
}
