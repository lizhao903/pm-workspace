package fsbrowse

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// maxNameLen 是单个目录名的上限，绝大多数文件系统的 255 字节。
const maxNameLen = 255

// List 列出一个目录下的子目录。path 为空时从主目录起步。
//
// 只返回目录：文件出现在这里对「选一个工作目录」没有任何帮助，反而让列表变长、
// 让人误以为可以点开看内容。
func List(path string) (*domain.FsListing, error) {
	if strings.TrimSpace(path) == "" {
		path = homeDir()
		if path == "" {
			return nil, badRequest("取不到主目录，请直接填写一个绝对路径")
		}
	}
	dir, err := resolve(path)
	if err != nil {
		return nil, err
	}

	fi, err := os.Stat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, notExist("目录不存在：" + dir)
	case errors.Is(err, fs.ErrPermission):
		return nil, denied("没有权限访问：" + dir)
	case err != nil:
		return nil, badRequest("无法访问这个路径，请检查它是否正确：" + dir)
	}
	if !fi.IsDir() {
		return nil, &PathError{Kind: ErrNotDir, Msg: "这是一个文件，不是目录：" + dir}
	}

	items, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return nil, denied("没有权限读取这个目录：" + dir + "。macOS 上部分目录需要在「系统设置 - 隐私与安全性 - 完全磁盘访问权限」里授权。")
		}
		return nil, badRequest("无法读取这个目录：" + dir)
	}

	roots := rootForms()
	out := &domain.FsListing{
		Path:     dir,
		Parent:   parentOf(dir, roots),
		Root:     rootOf(dir, roots),
		Writable: writable(dir),
		Entries:  []*domain.FsEntry{},
	}
	for _, it := range items {
		e := entryOf(dir, it, roots)
		if e == nil {
			continue
		}
		out.Entries = append(out.Entries, e)
	}
	// 忽略大小写排序：Documents 和 downloads 该挨在一起，不该被 ASCII 分到两头。
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i].Name, out.Entries[j].Name
		if la, lb := strings.ToLower(a), strings.ToLower(b); la != lb {
			return la < lb
		}
		return a < b
	})
	return out, nil
}

// entryOf 把一条目录项转成 FsEntry，不该出现在列表里的返回 nil。
//
// 这里所有的「跳过」都是有意为之：任何一条改成返回错误，一个 ~/Library 就能让
// 整个主目录列不出来——用户看到的是一片空白，而不是「除了这一个都好好的」。
func entryOf(dir string, it fs.DirEntry, roots []string) *domain.FsEntry {
	name := it.Name()
	// 隐藏 . 开头的条目（.git、.ssh、.Trash 之类）。只是不显示，不是不让进——
	// 用户明确把路径打进来照样能浏览，他知道自己在干什么。
	if strings.HasPrefix(name, ".") {
		return nil
	}
	full := filepath.Join(dir, name)
	// 用 Stat 而不是 DirEntry.IsDir()：软链指向的目录也该能选，Lstat 只会看到软链本身。
	info, err := os.Stat(full)
	if err != nil {
		// 权限不足、断掉的软链、刚好被删掉——跳过这一条，继续列剩下的。
		return nil
	}
	if !info.IsDir() {
		return nil
	}
	// 软链要看它到底指到哪。指向范围之外的不列出来，否则用户点进去才被拒，
	// 白点一次还以为是坏了。
	if it.Type()&fs.ModeSymlink != 0 {
		real, err := filepath.EvalSymlinks(full)
		if err != nil || !within(real, roots) {
			return nil
		}
	}
	return &domain.FsEntry{Name: name, Path: full, IsDir: true, Writable: writable(full)}
}

// parentOf 返回上一级目录；已经站在可浏览范围的边界上就回空串，界面据此隐藏
// 「返回上级」，而不是让用户点一下再吃一个 403。
func parentOf(dir string, roots []string) string {
	p := filepath.Dir(dir)
	if p == dir || !within(p, roots) {
		return ""
	}
	return p
}

// rootOf 返回 dir 所在的最外层根：面包屑要能一路回到 /Volumes，而不是停在某个更里面的根上。
func rootOf(dir string, roots []string) string {
	best := ""
	for _, r := range roots {
		if within(dir, []string{r}) && (best == "" || len(r) < len(best)) {
			best = r
		}
	}
	return best
}

// cand 是一条候选起跳点。
type cand struct{ label, path string }

// volumesDir 是外接盘的挂载点。做成变量只为测试。
var volumesDir = "/Volumes"

// volumes 列出 volumesDir 下的分区，只要真实目录：系统盘在这里是一个指回 / 的软链
// （「Macintosh HD」），列出来点进去就是越界。按当前挂载情况现读，插拔盘后刷新即变。
func volumes() []cand {
	items, err := os.ReadDir(volumesDir)
	if err != nil {
		return nil
	}
	out := []cand{}
	for _, it := range items {
		name := it.Name()
		if strings.HasPrefix(name, ".") || it.Type()&fs.ModeSymlink != 0 || !it.IsDir() {
			continue
		}
		out = append(out, cand{"外挂分区：" + name, filepath.Join(volumesDir, name)})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].path) < strings.ToLower(out[j].path) })
	return out
}

// Shortcuts 返回目录选择器的起跳点，省得用户从主目录一层层点下去。
// 不存在的目录不返回——列一个点不进去的入口比不列更糟。
func Shortcuts() []*domain.FsShortcut {
	home := homeDir()
	cands := []cand{
		{"主目录", home},
		{"桌面", filepath.Join(home, "Desktop")},
		{"文稿", filepath.Join(home, "Documents")},
		{"下载", filepath.Join(home, "Downloads")},
		{"当前项目", projectRoot()},
	}
	cands = append(cands, volumes()...)
	cands = append(cands, cand{"/Volumes（全部分区）", volumesDir})
	for _, r := range extraPaths() {
		cands = append(cands, cand{"可浏览目录：" + filepath.Base(r), r})
	}
	cands = append(cands, []cand{
		// /tmp 在允许范围内，但根目录不让浏览，没有这条入口用户就只能手打路径才到得了——
		// 而手打路径正是这套选择器要取消的东西。标签里点明「重启可能清空」：
		// FsShortcut 只有 Label 和 Path，没有副标题字段，性质只能写进标签。
		{"临时目录（重启可能清空）", "/tmp"},
	}...)

	roots := rootForms()
	out := []*domain.FsShortcut{}
	seen := map[string]bool{}
	for _, c := range cands {
		// 取不到主目录时前四项会退化成相对路径，一律不要。
		if !filepath.IsAbs(c.path) {
			continue
		}
		p := filepath.Clean(c.path)
		if seen[p] {
			continue
		}
		fi, err := os.Stat(p)
		if err != nil || !fi.IsDir() || !within(p, roots) {
			continue
		}
		seen[p] = true
		out = append(out, &domain.FsShortcut{Label: c.label, Path: p})
	}
	return out
}

// projectRoot 从进程工作目录向上找 go.mod。写死一条绝对路径的话，换台机器或者
// 把仓库检出到别处，这个快捷入口就指到不存在的地方去了。找不到就退回工作目录本身。
func projectRoot() string {
	cur, err := os.Getwd()
	if err != nil {
		return ""
	}
	start := cur
	for {
		if fi, err := os.Stat(filepath.Join(cur, "go.mod")); err == nil && !fi.IsDir() {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return start
		}
		cur = parent
	}
}

// Mkdir 在 parent 下建一层新目录，返回建好之后 parent 的列表，界面可以直接刷新。
// 只建一层：name 里不许有分隔符，也不许是 ..，否则前面那两道边界检查等于白做。
func Mkdir(parent, name string) (*domain.FsListing, error) {
	dir, err := resolve(parent)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return nil, &PathError{Kind: ErrNotDir, Msg: "上级路径不是一个目录：" + dir}
	}
	n, err := validName(name)
	if err != nil {
		return nil, err
	}

	// 用 Mkdir 而不是 MkdirAll：名字校验已经保证只有一层，MkdirAll 还会把
	// 「目录已存在」当成功，用户就看不出自己是新建了还是撞了个现成的。
	switch err := os.Mkdir(filepath.Join(dir, n), 0o755); {
	case errors.Is(err, fs.ErrExist):
		return nil, badRequest("「" + n + "」已经存在于 " + dir + "，换个名字或直接选它")
	case errors.Is(err, fs.ErrPermission):
		return nil, denied("没有权限在 " + dir + " 下创建目录，请换一个位置")
	case err != nil:
		return nil, badRequest("创建目录失败：" + err.Error())
	}
	return List(dir)
}

// validName 校验新建目录名。这是 Mkdir 唯一的安全性所在。
func validName(name string) (string, error) {
	n := strings.TrimSpace(name)
	switch {
	case n == "":
		return "", badRequest("请填写目录名")
	case strings.ContainsRune(n, '/') || strings.ContainsRune(n, filepath.Separator):
		return "", badRequest("目录名里不能有 /，一次只能新建一层")
	case strings.Contains(n, ".."):
		return "", badRequest("目录名里不能有 ..")
	case n == ".":
		return "", badRequest("目录名不能是 .")
	case strings.ContainsRune(n, 0):
		return "", badRequest("目录名里有非法字符")
	case strings.HasPrefix(n, "."):
		// 允许建了也看不见，不如直接拦下来说清楚。
		return "", badRequest("以 . 开头的目录不会出现在列表里，请换一个名字")
	case len(n) > maxNameLen:
		return "", badRequest("目录名太长了，请控制在 255 个字节以内")
	}
	return n, nil
}
