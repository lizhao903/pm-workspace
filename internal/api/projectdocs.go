package api

import (
	"context"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// --- 项目的文档目录（TSK-0718） ---
//
// 项目在「设置」里填一个文档目录，存在项目对象的 props.docs_dir：相对本地项目目录（objects.workdir）或绝对路径。
// 项目的「文档」标签列出这个目录下认得的文件（规则同挂载目录 /api/local-dirs/{id}/files），
// 打开、预览走 /api/fs/read、/api/fs/raw、/api/fs/open：项目文档目录和挂载目录一样算作可读范围，
// 隐藏段、数据目录、库文件和密钥证书类文件的拦截不变。执行任务的提示词里「文档在哪里操作」也优先用它。

const (
	projectType = "project"
	// propDocsDir 是项目 props 里文档目录的 key。
	propDocsDir = "docs_dir"
)

// projectDocsDir 把项目 props.docs_dir 解析成绝对路径：去首尾空白和 file:// 前缀，相对路径接在项目目录后面。
// 没填回两个空串；相对路径但项目没填本地项目目录时回 validation。
func projectDocsDir(o *domain.Object) (raw, abs string, err error) {
	v, _ := o.Props[propDocsDir].(string)
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "file://"))
	if raw == "" {
		return "", "", nil
	}
	if filepath.IsAbs(raw) {
		return raw, filepath.Clean(raw), nil
	}
	root := strings.TrimSpace(o.Workdir)
	if root == "" {
		return raw, "", validationf("文档目录「%s」是相对路径，要先在项目设置里填本地项目目录，或者改填绝对路径", raw)
	}
	return raw, filepath.Join(root, raw), nil
}

// handleListProjectDocFiles 是 GET /api/objects/{id}/docs-dir/files?cursor=&limit=：项目文档目录下认得的文件，一页 FsFileList。
// 不是项目 400；没设文档目录 400；越界（允许根外、隐藏段、数据目录）403；目录不存在 404；是文件不是目录 400。
func (s *Server) handleListProjectDocFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 0
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			s.fail(w, r, validationf("limit 要是正整数，最大 %d", fsbrowse.MaxPageSize))
			return
		}
		limit = n
	}
	o, err := s.st.GetObject(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if o.DeletedAt != nil {
		s.fail(w, r, notFoundf("项目已删除"))
		return
	}
	if o.TypeID != projectType {
		s.fail(w, r, validationf("只有项目有文档目录"))
		return
	}
	_, abs, err := projectDocsDir(o)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if abs == "" {
		s.fail(w, r, validationf("这个项目还没设文档目录，在项目的「设置」里填"))
		return
	}
	if s.forbiddenMount(abs) {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden",
			Message: "文档目录不能是隐藏目录或工作台自己的数据目录：" + abs}})
		return
	}
	list, err := fsbrowse.ListFilesPage(abs, q.Get("cursor"), limit)
	if err != nil {
		s.failFsRead(w, r, err)
		return
	}
	respondData(w, http.StatusOK, list)
}

// projectDocsDirs 是所有没删的项目设的文档目录（解析软链后的绝对路径），读文件的边界用。
// 隐藏目录、数据目录不算（同挂载的 forbiddenMount）；相对路径但没有项目目录的跳过。
func (s *Server) projectDocsDirs(ctx context.Context) ([]string, error) {
	var out []string
	const page = 200
	for off := 0; ; off += page {
		items, total, err := s.st.ListObjects(ctx, domain.ObjectFilter{TypeIDs: []string{projectType}, Limit: page, Offset: off})
		if err != nil {
			return nil, err
		}
		for _, o := range items {
			if o.DeletedAt != nil {
				continue
			}
			_, abs, err := projectDocsDir(o)
			if err != nil || abs == "" || s.forbiddenMount(abs) {
				continue
			}
			out = append(out, realPath(abs))
		}
		if len(items) < page || off+page >= total {
			return out, nil
		}
	}
}

// insideProjectDocsDir：p（已解析软链）落在某个项目的文档目录里，且目录以下没有隐藏段。
func (s *Server) insideProjectDocsDir(ctx context.Context, real string) (bool, error) {
	dirs, err := s.projectDocsDirs(ctx)
	if err != nil {
		return false, err
	}
	for _, d := range dirs {
		rel, ok := within(d, real)
		if ok && rel != "." && !hasHiddenSeg(rel) {
			return true, nil
		}
	}
	return false, nil
}
