package fsbrowse

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// 文档挂载本机目录（DOC-01a）要读文件内容。边界和目录浏览是同一套：
// 先过 resolve 的两道检查，读到的永远是解析软链后、落在允许根内的真实路径。

// MaxReadBytes 是单个文件一次最多返回的字节数，超出截断。
// 1MB：阅读器整篇渲染，Markdown 文档绝大多数在 100KB 以内；再大的多是日志或导出的数据，
// 看个开头就够，整篇塞进一个 JSON 响应只会让页面卡住。截断而不是拒绝，用户至少能看到前面。
const MaxReadBytes = 1 << 20

// sniffBytes 是判断二进制时看的前缀长度，和 git 判断二进制的做法一样看前 8000 字节有没有 NUL。
const sniffBytes = 8000

// 文件清单的上限：挂一个大目录（比如整个主目录）时不能无限走下去。
const (
	maxListFiles   = 1000
	maxListVisited = 20000
)

// TextExt 是文件清单里收的扩展名，和原型 web-next/src/localdir.ts 的 TEXT_EXT 一致。
var TextExt = []string{"md", "markdown", "txt", "text", "log", "csv", "json", "yaml", "yml", "toml", "xml", "html", "sql"}

// skipDirs 是不往下走的目录，和原型 SKIP_DIRS 一致：依赖和版本库目录里的文本没人想看。
var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, ".venv": true, "__pycache__": true}

// FileContent 是读一个文件的结果。Binary 为 true 时 Content 为空，只给元信息。
type FileContent struct {
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	Ext       string    `json:"ext"`
	Size      int64     `json:"size"`
	Modified  time.Time `json:"modified"`
	Binary    bool      `json:"binary"`
	Truncated bool      `json:"truncated"`
	Limit     int       `json:"limit"`
	Content   string    `json:"content"`
}

// FileItem 是文件清单里的一项。Rel 是相对挂载目录的路径，分隔符统一用 /。
type FileItem struct {
	Rel      string    `json:"rel"`
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Ext      string    `json:"ext"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

// FileList 是一个目录下的文本文件清单。Skipped 是不是文本被跳过的文件数；
// Truncated 表示文件太多或目录太大，没走完。
type FileList struct {
	Path      string      `json:"path"`
	Files     []*FileItem `json:"files"`
	Skipped   int         `json:"skipped"`
	Truncated bool        `json:"truncated"`
}

// ResolveDir 校验 path 是允许根内、存在的目录，返回解析软链后的真实路径。挂载目录用它。
func ResolveDir(path string) (string, error) {
	dir, err := resolve(path)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return "", statErr(err, dir)
	}
	if !fi.IsDir() {
		return "", &PathError{Kind: ErrNotDir, Msg: "这是一个文件，不是目录：" + dir}
	}
	return dir, nil
}

func statErr(err error, p string) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return notExist("路径不存在：" + p)
	case errors.Is(err, fs.ErrPermission):
		return denied("没有权限访问：" + p)
	}
	return badRequest("无法访问这个路径：" + p)
}

func extOf(name string) string {
	if i := strings.LastIndex(name, "."); i > 0 {
		return strings.ToLower(name[i+1:])
	}
	return ""
}

// ReadFile 只读地读一个文件，最多 MaxReadBytes。
// 二进制（前 8000 字节有 NUL，或不是合法 UTF-8）只给元信息：JSON 字符串装不下原始字节，
// 阅读器也只渲染文本；要 base64 送过去体积多三分之一，眼下没有地方用得上。
func ReadFile(path string) (*FileContent, error) {
	real, err := resolve(path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, statErr(err, real)
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return nil, statErr(err, real)
	}
	if fi.IsDir() {
		return nil, badRequest("这是一个目录，不是文件：" + real)
	}
	// 管道、设备之类读起来可能永远不返回
	if !fi.Mode().IsRegular() {
		return nil, badRequest("不是普通文件，不能读取：" + real)
	}
	buf, err := io.ReadAll(io.LimitReader(f, MaxReadBytes+1))
	if err != nil {
		return nil, statErr(err, real)
	}
	out := &FileContent{
		Path: real, Name: filepath.Base(real), Ext: extOf(filepath.Base(real)),
		Size: fi.Size(), Modified: fi.ModTime().UTC(), Limit: MaxReadBytes,
	}
	if len(buf) > MaxReadBytes {
		out.Truncated = true
		buf = buf[:MaxReadBytes]
		// 截断点可能落在一个多字节字符中间，退到字符边界
		for i := 0; i < utf8.UTFMax && len(buf) > 0 && !utf8.Valid(buf); i++ {
			buf = buf[:len(buf)-1]
		}
	}
	if bytes.IndexByte(buf[:min(len(buf), sniffBytes)], 0) >= 0 || !utf8.Valid(buf) {
		out.Binary = true
		return out, nil
	}
	out.Content = string(buf)
	return out, nil
}

// ListFiles 递归列出目录下的文本文件，规则和原型一致：跳过隐藏项和 skipDirs，只收 TextExt。
// 软链一律不跟：跟进去就可能走出允许根。
func ListFiles(path string) (*FileList, error) {
	dir, err := ResolveDir(path)
	if err != nil {
		return nil, err
	}
	text := map[string]bool{}
	for _, e := range TextExt {
		text[e] = true
	}
	out := &FileList{Path: dir, Files: []*FileItem{}}
	visited := 0
	stop := errors.New("stop")
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if p == dir {
			return err
		}
		if err != nil {
			// 子目录没权限之类的，跳过这一支，不让整个清单失败
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if visited++; visited > maxListVisited {
			out.Truncated = true
			return stop
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if skipDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		ext := extOf(name)
		if !text[ext] {
			out.Skipped++
			return nil
		}
		if len(out.Files) >= maxListFiles {
			out.Skipped++
			out.Truncated = true
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		out.Files = append(out.Files, &FileItem{
			Rel: filepath.ToSlash(rel), Path: p, Name: name, Ext: ext,
			Size: info.Size(), Modified: info.ModTime().UTC(),
		})
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		return nil, statErr(err, dir)
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Rel < out.Files[j].Rel })
	return out, nil
}
