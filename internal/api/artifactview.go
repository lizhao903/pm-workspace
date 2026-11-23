// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// --- 产出物查看（DEV-08b 补：任务抽屉「产出物」里的条目都能直接点开看） ---
//
// 本机文件、提交、分支三类产出物在工作台里打开看。接口一律按产出物 id 取，**不接受路径参数**：
// 读的永远是这条登记里的 path（或备注里的 repo=），调用方没法借它换一个路径读。
//
// 登记本身（POST /api/artifacts、PATCH）可以写任意绝对路径，所以「只读登记的路径」挡不住
// 「先登记一条 ~/.ssh/id_rsa 再读」。读之前还要过一道和读挂载目录同级的边界（artifactPathAllowed）：
//   - fsbrowse 的允许根（主目录、/Volumes、/tmp、设置里加的额外根），字面量和解析软链后各查一次；
//   - 路径里任何一段是隐藏项（~/.ssh、~/.aws、.env、.git 里面）都不给读；唯一例外是 Claude Code 的
//     工作树目录 .claude/worktrees/（执行在那里跑，产出物就登记在那里），之后的段照样不许隐藏；
//   - 库文件、密钥、证书类文件（sensitiveFile）不管在哪都不给；
//   - 工作台数据目录里只放行几个登记产出物的子目录（发布报告、测试报告、原型同步、需求工作区），
//     vault.key、库文件、备份所在的其余部分一律不给。

// artifactDataSubdirs 是数据目录下会登记成产出物的子目录（projects 插件的 releases/、test-reports/、
// proto-syncs/，内核的 worktrees/）。写字面量而不是引用插件常量：api 包不依赖具体插件。
var artifactDataSubdirs = map[string]bool{"releases": true, "test-reports": true, "proto-syncs": true, "worktrees": true}

// artifactPathAllowed 判断解析软链后的 real 能不能经产出物接口读，不能时回给用户看的原因。
// 允许根已由 fsbrowse 查过，这里只加产出物特有的几条。
func (s *Server) artifactPathAllowed(real string) (bool, string) {
	if sensitiveFile(real) {
		return false, "库文件、密钥、证书类文件不在工作台里显示：" + filepath.Base(real)
	}
	if s.opt.DataDir != "" {
		dd := realPath(s.opt.DataDir)
		if rel, ok := within(dd, real); ok {
			first := strings.SplitN(rel, string(filepath.Separator), 2)[0]
			if rel == "." || !artifactDataSubdirs[first] {
				return false, "工作台数据目录里只能看发布报告、测试报告、原型同步和需求工作区：" + real
			}
		} else if _, ok := within(real, dd); ok {
			return false, "这个目录包含工作台数据目录，不能读：" + real
		}
	}
	if hiddenArtifactSeg(real) {
		return false, "路径里有隐藏目录或隐藏文件，不在工作台里显示：" + real
	}
	return true, ""
}

// hiddenArtifactSeg：绝对路径里有没有以「.」开头的段；.claude 后面紧跟 worktrees 的那一段放行。
func hiddenArtifactSeg(p string) bool {
	segs := strings.Split(filepath.Clean(p), string(filepath.Separator))
	for i, seg := range segs {
		if !strings.HasPrefix(seg, ".") || seg == "." {
			continue
		}
		if seg == ".claude" && i+1 < len(segs) && segs[i+1] == "worktrees" {
			continue
		}
		return true
	}
	return false
}

func (s *Server) forbid(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden", Message: msg}})
}

// artifactFile 取产出物、校验它的本机路径，回解析软链后的真实路径。不过时已经写好了响应。
// 路径是目录（比如登记成文件的仓库目录）回 400，说明这条要按提交、分支看。
func (s *Server) artifactFile(w http.ResponseWriter, r *http.Request) (*domain.Artifact, string, bool) {
	a, err := s.st.GetArtifact(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return nil, "", false
	}
	if strings.TrimSpace(a.Path) == "" {
		s.fail(w, r, validationf("这条产出物没有本机路径，只有链接：%s", a.URL))
		return nil, "", false
	}
	real, err := fsbrowse.StatFile(a.Path)
	if err != nil {
		s.failFsRead(w, r, err)
		return nil, "", false
	}
	if ok, why := s.artifactPathAllowed(real); !ok {
		s.forbid(w, why)
		return nil, "", false
	}
	return a, real, true
}

// 产出物文件的预览方式。
const (
	previewMarkdown = "markdown"
	previewText     = "text"
	previewHTML     = "html"
	previewImage    = "image"
	previewPDF      = "pdf"
	previewOffice   = "office"
	previewBinary   = "binary"
)

var markdownExt = map[string]bool{"md": true, "markdown": true, "mdx": true}

// previewOf 按扩展名定预览方式；不认得的扩展名（源码、配置）先当文本，读出来是二进制再改成 binary。
func previewOf(ext string) string {
	switch {
	case markdownExt[ext]:
		return previewMarkdown
	case ext == "html" || ext == "htm":
		return previewHTML
	}
	switch fsbrowse.KindOf(ext) {
	case fsbrowse.KindPDF:
		return previewPDF
	case fsbrowse.KindImage:
		return previewImage
	case fsbrowse.KindOffice:
		return previewOffice
	}
	return previewText
}

// ArtifactFile 是 GET /api/artifacts/{id}/file 的响应：文件元信息、预览方式，文本类带内容（最多 1MB，超出截断）。
type ArtifactFile struct {
	*fsbrowse.FileContent
	ArtifactID string `json:"artifact_id"`
	Preview    string `json:"preview"`
}

// handleArtifactFile 是 GET /api/artifacts/{id}/file：读这条产出物登记的本机文件。
// 文本、Markdown、HTML 回内容（HTML 的内容是源码，渲染走 /raw）；图片、PDF、Office 只回元信息。
func (s *Server) handleArtifactFile(w http.ResponseWriter, r *http.Request) {
	a, real, ok := s.artifactFile(w, r)
	if !ok {
		return
	}
	name := filepath.Base(real)
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	out := &ArtifactFile{ArtifactID: a.ID, Preview: previewOf(ext)}
	switch out.Preview {
	case previewImage, previewPDF, previewOffice:
		fi, err := os.Stat(real)
		if err != nil {
			s.failFsRead(w, r, err)
			return
		}
		out.FileContent = &fsbrowse.FileContent{Path: real, Name: name, Ext: ext, Size: fi.Size(),
			Modified: fi.ModTime().UTC(), Binary: true, Limit: fsbrowse.MaxReadBytes}
	default:
		f, err := fsbrowse.ReadFile(real)
		if err != nil {
			s.failFsRead(w, r, err)
			return
		}
		out.FileContent = f
		if f.Binary {
			out.Preview = previewBinary
		}
	}
	respondData(w, http.StatusOK, out)
}

// htmlCSP：HTML 产出物在沙箱里只显示、不跑脚本、不发请求（不许借一个登记的 HTML 调本机接口）；
// 内联样式和 data: 图片放行，外链的图片、样式、相对路径的资源都加载不了。
const htmlCSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"

// handleArtifactRaw 是 GET /api/artifacts/{id}/raw：原样回能预览的文件（图片、PDF、HTML），给 img、iframe 用。
// SVG、HTML 加 CSP sandbox，直接打开这个地址也跑不了脚本；其余类型回 400。
func (s *Server) handleArtifactRaw(w http.ResponseWriter, r *http.Request) {
	_, real, ok := s.artifactFile(w, r)
	if !ok {
		return
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(real), "."))
	ctype, ok := fsbrowse.PreviewExt[ext]
	if ext == "html" || ext == "htm" {
		ctype, ok = "text/html; charset=utf-8", true
	}
	if !ok {
		s.fail(w, r, validationf("这类文件不能原样预览，只认图片、PDF、HTML：%s", filepath.Base(real)))
		return
	}
	f, err := os.Open(real)
	if err != nil {
		s.failFsRead(w, r, err)
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		s.fail(w, r, validationf("不是普通文件，不能读取：%s", real))
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": fi.Name()}))
	switch ext {
	case "svg":
		h.Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
	case "html", "htm":
		h.Set("Content-Security-Policy", htmlCSP)
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// handleArtifactOpen 是 POST /api/artifacts/{id}/open {reveal}：用本机默认应用打开这条产出物的文件，
// 或在访达中显示。打开只认文档种类（文本、PDF、图片、Office），同 /api/fs/open，免得借它执行脚本、程序。
func (s *Server) handleArtifactOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reveal bool `json:"reveal"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	_, real, ok := s.artifactFile(w, r)
	if !ok {
		return
	}
	if !req.Reveal && fsbrowse.KindOf(strings.TrimPrefix(filepath.Ext(real), ".")) == "" {
		s.forbid(w, "这类文件不能直接打开，可以在访达中显示："+filepath.Base(real))
		return
	}
	if err := openLocal(real, req.Reveal); err != nil {
		s.fail(w, r, validationf("打不开：%s", err.Error()))
		return
	}
	respondData(w, http.StatusOK, map[string]any{"path": real, "reveal": req.Reveal})
}

// --- 代码类产出物的备注（契约「代码类产物」）：[commit] sha=… branch=… repo=…  备注 ---

var (
	codeNotePrefix = regexp.MustCompile(`^\[(commit|branch|pr)\]\s*`)
	codeNotePair   = regexp.MustCompile(`^(sha|branch|repo)=(\S*)\s*`)
)

type codeNote struct{ kind, sha, branch, repo string }

// parseCodeNote 同前端 artifactNote.ts 的 parseArtifactNote：前缀定种类，紧跟的 key=value 取 sha、branch、repo，空值当没给。
func parseCodeNote(note string) codeNote {
	src := strings.TrimLeft(note, " \t\r\n")
	m := codeNotePrefix.FindStringSubmatch(src)
	if m == nil {
		return codeNote{}
	}
	out := codeNote{kind: m[1]}
	rest := src[len(m[0]):]
	for x := codeNotePair.FindStringSubmatch(rest); x != nil; x = codeNotePair.FindStringSubmatch(rest) {
		switch x[1] {
		case "sha":
			if x[2] != "" {
				out.sha = x[2]
			}
		case "branch":
			if x[2] != "" {
				out.branch = x[2]
			}
		case "repo":
			if x[2] != "" {
				out.repo = x[2]
			}
		}
		rest = rest[len(x[0]):]
	}
	return out
}
