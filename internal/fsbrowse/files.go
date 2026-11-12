// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package fsbrowse

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
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
