// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package fsbrowse

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 额外可浏览目录（FS-01）：默认三块之外，用户在「设置 - 本机目录」里加的根。
// 存在数据目录的 fs-roots.json 里，不进库：内核没有通用的设置表，为一张清单加迁移不值得，
// 文件删掉就回到默认范围。fsbrowse 是进程级的（文档挂载、知识库也直接调它），所以这里也是。

// ExtraRootsFile 是数据目录下存额外根的文件名。
const ExtraRootsFile = "fs-roots.json"

// maxExtraRoots 是额外根的上限，防手滑把一堆目录塞进来。
const maxExtraRoots = 50

// ErrConflict 是同一个目录加两次。
var ErrConflict = domain.ErrConflict

// ExtraRoot 是一个额外根。Path 是解析软链后的绝对路径。
type ExtraRoot struct {
	Path    string    `json:"path"`
	AddedAt time.Time `json:"added_at"`
}

// sysDirs 是不许当根的系统目录：它们本身和下面的任何地方都不行。
// 做成变量只为测试：t.TempDir() 在 macOS 上就在 /private/var 下面。
var sysDirs = []string{"/etc", "/System", "/private", "/usr", "/bin", "/sbin", "/var", "/dev", "/Library"}

var extra struct {
	mu    sync.RWMutex
	file  string // 空串只放内存
	roots []ExtraRoot
}

func extraPaths() []string {
	extra.mu.RLock()
	defer extra.mu.RUnlock()
	out := make([]string, 0, len(extra.roots))
	for _, r := range extra.roots {
		out = append(out, r.Path)
	}
	return out
}

// ExtraRoots 返回当前的额外根，按加入先后。
func ExtraRoots() []ExtraRoot {
	extra.mu.RLock()
	defer extra.mu.RUnlock()
	return append([]ExtraRoot{}, extra.roots...)
}

// DefaultRoots 是默认三块里本机存在的那些，给设置页显示。
func DefaultRoots() []string {
	out := []string{}
	for _, r := range rootsFn() {
		if fi, err := os.Stat(r); err == nil && fi.IsDir() {
			out = append(out, filepath.Clean(r))
		}
	}
	return out
}

// LoadExtraRoots 从 file 读额外根，之后的增删都写回这个文件；文件不存在当作空清单。
// 文件里不合规的条目（被手改成 / 之类）丢掉，返回的错误只是告知，清单照常生效。
func LoadExtraRoots(file string) error {
	var roots []ExtraRoot
	var bad []string
	b, err := os.ReadFile(file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("read %s: %w", file, err)
	default:
		var doc struct {
			Roots []ExtraRoot `json:"roots"`
		}
		if err := json.Unmarshal(b, &doc); err != nil {
			return fmt.Errorf("parse %s: %w", file, err)
		}
		for _, r := range doc.Roots {
			p := filepath.Clean(r.Path)
			if !filepath.IsAbs(r.Path) || sysReason(p) != "" {
				bad = append(bad, r.Path)
				continue
			}
			roots = append(roots, ExtraRoot{Path: p, AddedAt: r.AddedAt})
		}
	}
	extra.mu.Lock()
	extra.file, extra.roots = file, roots
	extra.mu.Unlock()
	if len(bad) > 0 {
		return fmt.Errorf("%s: dropped invalid roots %v", file, bad)
	}
	return nil
}

// resetExtraRoots 清空额外根并回到只放内存，给测试用。
func resetExtraRoots() {
	extra.mu.Lock()
	extra.file, extra.roots = "", nil
	extra.mu.Unlock()
}

// sysReason 说明 p 为什么不能当根，能当回空串。
func sysReason(p string) string {
	if p == "/" {
		return "不能把根目录 / 加为可浏览目录，范围太大，会把系统目录和别人的文件一起放开"
	}
	for _, d := range sysDirs {
		if p == d {
			return p + " 是系统目录，不能加为可浏览目录"
		}
		if within(p, []string{d}) {
			return p + " 在系统目录 " + d + " 里，不能加为可浏览目录"
		}
	}
	return ""
}

// AddExtraRoot 加一个额外根，返回存下的那条。dataDir 是工作台的数据目录，它和它的上级都不许加。
//
// 校验在解开软链之后再做一遍：主目录里放个软链指到 /etc，字面量看着没问题。
func AddExtraRoot(path, dataDir string) (*ExtraRoot, error) {
	p := strings.TrimSpace(path)
	if p == "" {
		return nil, badRequest("请填写一个目录的绝对路径")
	}
	if !filepath.IsAbs(p) {
		return nil, badRequest("请填写绝对路径，例如 /Volumes/data")
	}
	p = filepath.Clean(p)
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return nil, statErr(err, p)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return nil, statErr(err, real)
	}
	if !fi.IsDir() {
		return nil, &PathError{Kind: ErrNotDir, Msg: "这是一个文件，不是目录：" + p}
	}
	// 默认范围里的不用加：加了也不多走一步，删掉时还会让人以为范围变小了。
	// 先于系统目录查：/tmp 解开是 /private/tmp，/private/tmp 下的也该说「已经能浏览」而不是「系统目录」。
	for _, r := range rootsFn() {
		forms := []string{filepath.Clean(r)}
		if ev, err := filepath.EvalSymlinks(r); err == nil {
			forms = append(forms, ev)
		}
		if within(real, forms) {
			return nil, &PathError{Kind: ErrConflict, Msg: p + " 已经在默认的可浏览范围（" + filepath.Clean(r) + "）里，不用另加"}
		}
	}
	if why := sysReason(p); why != "" {
		return nil, badRequest(why)
	}
	if why := sysReason(real); why != "" {
		if real != p {
			why = p + " 指向 " + real + "，" + strings.TrimPrefix(why, real+" ")
		}
		return nil, badRequest(why)
	}
	if dataDir != "" {
		dd := filepath.Clean(dataDir)
		if ev, err := filepath.EvalSymlinks(dd); err == nil {
			dd = ev
		}
		if within(real, []string{dd}) || within(dd, []string{real}) {
			return nil, badRequest("不能加工作台自己的数据目录或它的上级（" + dd + "），那里有库文件和保险箱密钥")
		}
	}

	extra.mu.Lock()
	defer extra.mu.Unlock()
	for _, r := range extra.roots {
		if r.Path == real {
			return nil, &PathError{Kind: ErrConflict, Msg: real + " 已经是可浏览目录了"}
		}
	}
	if len(extra.roots) >= maxExtraRoots {
		return nil, badRequest(fmt.Sprintf("可浏览目录最多 %d 个，先删掉不用的", maxExtraRoots))
	}
	e := ExtraRoot{Path: real, AddedAt: time.Now().UTC().Truncate(time.Millisecond)}
	next := append(append([]ExtraRoot{}, extra.roots...), e)
	if err := saveExtra(extra.file, next); err != nil {
		return nil, err
	}
	extra.roots = next
	return &e, nil
}

// RemoveExtraRoot 删一个额外根，返回删掉的那条；没有这一条回 fs.ErrNotExist。
// 认原样和解开软链两种写法，目录已经不在了也能删。
func RemoveExtraRoot(path string) (*ExtraRoot, error) {
	p := filepath.Clean(strings.TrimSpace(path))
	real := p
	if ev, err := filepath.EvalSymlinks(p); err == nil {
		real = ev
	}
	extra.mu.Lock()
	defer extra.mu.Unlock()
	for i, r := range extra.roots {
		if r.Path != p && r.Path != real {
			continue
		}
		next := append(append([]ExtraRoot{}, extra.roots[:i]...), extra.roots[i+1:]...)
		if err := saveExtra(extra.file, next); err != nil {
			return nil, err
		}
		extra.roots = next
		return &r, nil
	}
	return nil, notExist("没有这个可浏览目录：" + p)
}

// saveExtra 先写临时文件再改名，写到一半断电也不会留下半个 JSON。
func saveExtra(file string, roots []ExtraRoot) error {
	if file == "" {
		return nil
	}
	if roots == nil {
		roots = []ExtraRoot{}
	}
	b, err := json.MarshalIndent(struct {
		Roots []ExtraRoot `json:"roots"`
	}{roots}, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s: %w", tmp, err)
	}
	return nil
}

// SetBoundsForTest 把默认根和系统目录换成受控的一组，并清空额外根，返回还原函数。只给别的包的测试用：
// t.TempDir() 在 macOS 上落在 /private/var 下，用真实的系统目录清单就加不进额外根。
func SetBoundsForTest(roots, sys []string) (restore func()) {
	oldRoots, oldSys := rootsFn, sysDirs
	rootsFn = func() []string { return roots }
	sysDirs = sys
	resetExtraRoots()
	return func() {
		rootsFn, sysDirs = oldRoots, oldSys
		resetExtraRoots()
	}
}
