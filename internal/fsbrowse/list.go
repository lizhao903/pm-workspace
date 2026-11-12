// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package fsbrowse

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 文档挂载目录的文件清单（DOC-01a 起，「全部文档」改成分页）。
//
// 早先一次列完、最多 1000 个文件，大目录（几千篇笔记加一堆 PDF、图片）列不全。
// 现在按游标分页：每页最多 limit 个文件，下一页从上一页停下的位置接着走，客户端一页页拉到 next_cursor 为空就是全量。
// 走查顺序就是 filepath.WalkDir 的顺序（每层按名字排，目录先自己再里面），游标是「最后处理过的那一项」的相对路径，
// 下一页只要比它靠后的项；它之前的兄弟子树整棵跳过，不重复读目录。
//
// 防爆保护（触到了才 truncated，并给原因）：
//   - 整个目录累计走查超过 MaxListVisited 项（文件、目录都算），停下；
//   - 比挂载目录深 MaxListDepth 层以上的子目录不往下走；
//
// 另外每页有时间预算 pageBudget：走得慢（网络盘、冷缓存）时先把已列的交回去，给 next_cursor 接着拉，不算截断。

// 列表的上限。
const (
	// DefaultPageSize 是不传 limit 时一页的文件数。
	DefaultPageSize = 2000
	// MaxPageSize 是一页最多的文件数，超出按它算。
	MaxPageSize = 10000
	// MaxListVisited 是一个目录累计最多走查的项数（文件、目录都算，跳过的也算），防挂错目录（比如整个主目录）一直走下去。
	MaxListVisited = 200000
	// MaxListDepth 是比挂载目录深多少层的目录不再往下走。正常文档目录十层以内；再深多半是打包产物或循环生成的目录。
	MaxListDepth = 32
)

// pageBudget 是一页的走查时间预算，做成变量只为测试能调小。
var pageBudget = 8 * time.Second

// 截断原因。
const (
	TruncVisited = "visited" // 走查项数到了 MaxListVisited
	TruncDepth   = "depth"   // 有子目录超过 MaxListDepth 层没有往下走
)

// 文件种类：决定清单收不收、阅读区怎么显示。
const (
	KindText   = "text"   // 文本：阅读区直接显示（Markdown 渲染）
	KindPDF    = "pdf"    // PDF：阅读区内嵌预览
	KindImage  = "image"  // 图片：阅读区直接显示
	KindOffice = "office" // Office、iWork 等文档：不预览，给文件信息和「用本机应用打开」
)

// TextExt 是按文本读的扩展名。前 13 个和原型 web-next/src/localdir.ts 的 TEXT_EXT 早期版本一致，
// 后面补上常见的文本数据和图表源文件（jsonl 日志、tsv 表、mermaid 源文件等）。
var TextExt = []string{"md", "markdown", "txt", "text", "log", "csv", "json", "yaml", "yml", "toml", "xml", "html", "sql",
	"htm", "jsonl", "ndjson", "tsv", "mmd", "rst", "ini", "conf", "cfg"}

// PreviewExt 是能在阅读区原样预览的扩展名 -> Content-Type（/api/fs/raw 只认这些）。
var PreviewExt = map[string]string{
	"pdf": "application/pdf",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
	"svg": "image/svg+xml", "bmp": "image/bmp", "avif": "image/avif",
}

// OfficeExt 是认得但不预览的文档：Word、Excel、PowerPoint、iWork、OpenDocument、RTF、EPUB。
var OfficeExt = []string{"doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "odt", "ods", "odp", "rtf", "epub"}

// packageExt 是 macOS 上可能是「目录形式」的文档（老版本 iWork 存成包）：整个包当一个文件列出来，不往里走。
var packageExt = map[string]bool{"key": true, "pages": true, "numbers": true}

// skipDirs 是不往下走的目录，和原型 SKIP_DIRS 一致：依赖和版本库目录里的文本没人想看。
var skipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, ".venv": true, "__pycache__": true}

var kindByExt = func() map[string]string {
	m := map[string]string{}
	for _, e := range TextExt {
		m[e] = KindText
	}
	for _, e := range OfficeExt {
		m[e] = KindOffice
	}
	for e := range PreviewExt {
		if e == "pdf" {
			m[e] = KindPDF
		} else {
			m[e] = KindImage
		}
	}
	return m
}()

// KindOf 按扩展名（小写、不带点）给文件种类，不认识的回空串。
func KindOf(ext string) string { return kindByExt[strings.ToLower(ext)] }

// FileItem 是文件清单里的一项。Rel 是相对挂载目录的路径，分隔符统一用 /。
type FileItem struct {
	Rel      string    `json:"rel"`
	Path     string    `json:"path"`
	Name     string    `json:"name"`
	Ext      string    `json:"ext"`
	Kind     string    `json:"kind"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

// FileList 是一页文件清单。
//   - Skipped：这一页里扩展名不认识被跳过的文件数（多页要累加）；
//   - NextCursor：还没走完时给下一页的游标，空串是走完了；
//   - Truncated、Reason：触到防爆保护（见 TruncVisited、TruncDepth）才为 true，Reason 是原因；
//   - Visited：到这一页为止累计走查的项数。
type FileList struct {
	Path       string      `json:"path"`
	Files      []*FileItem `json:"files"`
	Skipped    int         `json:"skipped"`
	Truncated  bool        `json:"truncated"`
	Reason     string      `json:"reason"`
	NextCursor string      `json:"next_cursor"`
	Visited    int         `json:"visited"`
}

// cursor 是游标的内容：A 是最后处理过的那一项的相对路径（WalkDir 顺序），V 是累计走查项数；
// In 为 true 表示 A 是一个进去了、里面还没走完的目录（下一页要进去），否则 A 整个处理完了（跳过的目录也算）。
type cursor struct {
	A  string `json:"a"`
	V  int    `json:"v"`
	In bool   `json:"in,omitempty"`
}

func encodeCursor(c cursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (cursor, error) {
	var c cursor
	if s == "" {
		return c, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || json.Unmarshal(b, &c) != nil || c.V < 0 || strings.HasPrefix(c.A, "/") || strings.Contains("/"+c.A+"/", "/../") {
		return cursor{}, badRequest("cursor 不对：从第一页重新拉")
	}
	return c, nil
}

// walkCmp 按 WalkDir 的顺序比两个相对路径：逐段按字节比；一个是另一个的上级时上级在前。
// 回 -1/0/1；ancestor 为 true 表示 a 是 b 的上级目录。
func walkCmp(a, b string) (cmp int, ancestor bool) {
	as, bs := strings.Split(a, "/"), strings.Split(b, "/")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if as[i] != bs[i] {
			if as[i] < bs[i] {
				return -1, false
			}
			return 1, false
		}
	}
	switch {
	case len(as) < len(bs):
		return -1, true
	case len(as) > len(bs):
		return 1, false
	}
	return 0, false
}

// ListFiles 一口气列完整个目录（内部一页页拉），给不需要分页的调用方（测试、小目录）。
// 累计走查超过 MaxListVisited 时停下，Truncated 为 true。Skipped 是各页之和。
func ListFiles(path string) (*FileList, error) {
	var out *FileList
	cur := ""
	for {
		page, err := ListFilesPage(path, cur, MaxPageSize)
		if err != nil {
			return nil, err
		}
		if out == nil {
			out = &FileList{Path: page.Path, Files: []*FileItem{}}
		}
		out.Files = append(out.Files, page.Files...)
		out.Skipped += page.Skipped
		out.Visited = page.Visited
		if page.Truncated {
			out.Truncated = true
			if out.Reason == "" || page.Reason == TruncVisited {
				out.Reason = page.Reason
			}
		}
		if page.NextCursor == "" {
			return out, nil
		}
		cur = page.NextCursor
	}
}

// ListFilesPage 列一页：从游标 after 之后接着走，最多 limit 个文件（<=0 用 DefaultPageSize，超过 MaxPageSize 按它算）。
// 规则：跳过隐藏项和 skipDirs；软链一律不跟（跟进去就可能走出允许根）；只收认得的种类（KindOf 非空），其余计入 Skipped。
func ListFilesPage(path, after string, limit int) (*FileList, error) {
	dir, err := ResolveDir(path)
	if err != nil {
		return nil, err
	}
	c, err := decodeCursor(after)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = DefaultPageSize
	}
	limit = min(limit, MaxPageSize)
	out := &FileList{Path: dir, Files: []*FileItem{}, Visited: c.V}
	deadline := time.Now().Add(pageBudget)
	last, in := c.A, c.In // 最后处理完的一项、它是不是进去了的目录；停在哪里，下一页就从它之后接着走
	progressed := false
	mark := func(rel string, entered bool) { last, in, progressed = rel, entered, true }
	next := func() string { return encodeCursor(cursor{A: last, V: out.Visited, In: in}) }
	stop := errors.New("stop")
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, werr error) error {
		if p == dir {
			return werr
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if c.A != "" {
			cmp, anc := walkCmp(rel, c.A)
			if anc || (cmp == 0 && c.In) {
				// 游标所在的那一支：上级目录、进去了还没走完的游标目录要往下走，但这一项本身上一页已经算过了
				return nil
			}
			if cmp <= 0 {
				// 游标本身（上一页已经处理完；目录的话是跳过或整个列过的，比如依赖目录、目录形式的 iWork 文档），和它前面的
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		// 交回去的条件：这一页够数了，或者时间用完了（至少处理过一项，免得原地打转）
		if progressed && time.Now().After(deadline) {
			out.NextCursor = next()
			return stop
		}
		if werr != nil {
			// 子目录没权限之类的，跳过这一支，不让整个清单失败
			mark(rel, false)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if out.Visited >= MaxListVisited {
			out.Truncated, out.Reason = true, TruncVisited
			return stop
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			out.Visited++
			mark(rel, false)
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		ext := extOf(name)
		if d.IsDir() {
			if packageExt[ext] {
				// 目录形式的 iWork 文档：当一个文件列出来，不往里走
				if len(out.Files) >= limit {
					out.NextCursor = next()
					return stop
				}
				out.Visited++
				mark(rel, false)
				out.Files = append(out.Files, item(p, rel, name, ext, d))
				return filepath.SkipDir
			}
			out.Visited++
			if skipDirs[name] {
				mark(rel, false)
				return filepath.SkipDir
			}
			if strings.Count(rel, "/")+1 > MaxListDepth {
				mark(rel, false)
				out.Truncated = true
				if out.Reason == "" {
					out.Reason = TruncDepth
				}
				return filepath.SkipDir
			}
			mark(rel, true)
			return nil
		}
		if !d.Type().IsRegular() {
			out.Visited++
			mark(rel, false)
			return nil
		}
		kind := KindOf(ext)
		if kind != "" && len(out.Files) >= limit {
			out.NextCursor = next()
			return stop
		}
		out.Visited++
		mark(rel, false)
		if kind == "" {
			out.Skipped++
			return nil
		}
		out.Files = append(out.Files, item(p, rel, name, ext, d))
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		return nil, statErr(err, dir)
	}
	return out, nil
}

func item(p, rel, name, ext string, d fs.DirEntry) *FileItem {
	it := &FileItem{Rel: rel, Path: p, Name: name, Ext: ext, Kind: KindOf(ext)}
	if info, err := d.Info(); err == nil {
		it.Modified = info.ModTime().UTC()
		if !info.IsDir() {
			it.Size = info.Size()
		}
	}
	return it
}

// OpenPreview 打开一个能原样预览的文件（PreviewExt 里的扩展名），给 /api/fs/raw 用。
// 边界同 ReadFile：resolve 两道检查，只认普通文件。回真实路径和 Content-Type，调用方负责关文件。
func OpenPreview(path string) (*os.File, os.FileInfo, string, error) {
	real, err := resolve(path)
	if err != nil {
		return nil, nil, "", err
	}
	ctype, ok := PreviewExt[extOf(filepath.Base(real))]
	if !ok {
		return nil, nil, "", badRequest("这类文件不能预览：" + filepath.Base(real))
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, nil, "", statErr(err, real)
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, "", statErr(err, real)
	}
	if !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, "", badRequest("不是普通文件，不能读取：" + real)
	}
	return f, fi, ctype, nil
}

// StatFile 校验 path 是允许根内存在的普通文件（或目录形式的 iWork 文档），回解析软链后的真实路径。打开本机文件用它。
func StatFile(path string) (string, error) {
	real, err := resolve(path)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", statErr(err, real)
	}
	if fi.IsDir() && !packageExt[extOf(filepath.Base(real))] {
		return "", badRequest("这是一个目录，不是文件：" + real)
	}
	if !fi.IsDir() && !fi.Mode().IsRegular() {
		return "", badRequest("不是普通文件：" + real)
	}
	return real, nil
}
