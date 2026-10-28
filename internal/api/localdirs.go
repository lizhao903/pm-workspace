package api

import (
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
)

// --- 文档的本机目录挂载和文件读取（DOC-01a，0025） ---

// failFsRead 是读文件和挂载用的错误映射：越界回 403 forbidden，其余同 failFs。
// 只在这几个新接口上用 403；/api/fs/browse、mkdir 仍是原来的 400，不改已有行为。
func (s *Server) failFsRead(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, fsbrowse.ErrForbidden) {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden", Message: err.Error()}})
		return
	}
	s.failFs(w, r, err)
}

// handleFsRead 只读已挂载目录里的文件：允许根（主目录、/Volumes、/tmp）太宽，主目录下有 ~/.ssh、
// 保险箱的 vault.key 这类凭证，读文件接口不能任意读。路径解析软链后必须落在某个挂载目录里，
// 且挂载目录以下的任何一段不能是隐藏项（和文件清单跳过隐藏项的规则一致）。
func (s *Server) handleFsRead(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	p := r.URL.Query().Get("path")
	if ok, err := s.insideMountedDir(r, p); err != nil {
		s.fail(w, r, err)
		return
	} else if !ok {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden",
			Message: "只能读已挂载目录里的非隐藏文件：" + p}})
		return
	}
	f, err := fsbrowse.ReadFile(p)
	if err != nil {
		s.failFsRead(w, r, err)
		return
	}
	respondData(w, http.StatusOK, f)
}

// realPath 是解析软链后的绝对路径；不存在时退回字面量。
func realPath(p string) string {
	c := filepath.Clean(p)
	if ev, err := filepath.EvalSymlinks(c); err == nil {
		return ev
	}
	return c
}

// within 判断 p 是否就是 dir 或在 dir 之下，返回相对路径。
func within(dir, p string) (string, bool) {
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

func hasHiddenSeg(rel string) bool {
	for _, seg := range strings.Split(rel, string(filepath.Separator)) {
		if seg != "." && strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// inDataDir：库文件所在目录（vault.key、库文件、备份都在这里）读文件和挂载都不许碰，挂它的上级也不行。
func (s *Server) inDataDir(real string) bool {
	if s.opt.DataDir == "" {
		return false
	}
	dd := realPath(s.opt.DataDir)
	if _, ok := within(dd, real); ok {
		return true
	}
	_, ok := within(real, dd) // 挂载目录包住了数据目录
	return ok
}

// forbiddenMount：挂载路径有隐藏段（如 ~/.ssh），或碰到数据目录，就不许挂。
func (s *Server) forbiddenMount(p string) bool {
	if !filepath.IsAbs(p) {
		return false // 交给 Create 回 400
	}
	real := realPath(p)
	return hasHiddenSeg(real) || s.inDataDir(real)
}

// sensitiveFile：库文件、密钥、证书这类文件不管在哪个挂载目录里都不给读。
// 数据目录只拦得住本实例自己的；另一个实例（比如测试实例挂了正式库所在的仓库）的 data/ 靠这一道。
func sensitiveFile(p string) bool {
	base := strings.ToLower(filepath.Base(p))
	if base == "vault.key" {
		return true
	}
	switch filepath.Ext(base) {
	case ".db", ".sqlite", ".sqlite3", ".key", ".pem", ".p12", ".pfx", ".keychain":
		return true
	}
	return strings.HasSuffix(base, ".db-wal") || strings.HasSuffix(base, ".db-shm") || strings.HasSuffix(base, ".db-journal")
}

// insideMountedDir 判断 p（绝对路径）解析软链后是否落在某个挂载目录内、且挂载目录以下没有隐藏段。
// 路径不存在时按字面量判断，让 ReadFile 回 404 而不是 403。
func (s *Server) insideMountedDir(r *http.Request, p string) (bool, error) {
	if !filepath.IsAbs(p) {
		return true, nil // 相对路径交给 ReadFile 回 400
	}
	real := realPath(p)
	if s.inDataDir(real) || sensitiveFile(real) {
		return false, nil
	}
	dirs, err := s.opt.LocalDirs.List(r.Context())
	if err != nil {
		return false, err
	}
	for _, d := range dirs {
		rel, ok := within(d.Path, real)
		if ok && rel != "." && !hasHiddenSeg(rel) {
			return true, nil
		}
	}
	return false, nil
}

func (s *Server) localDirsConfigured(w http.ResponseWriter) bool {
	if s.opt.LocalDirs == nil {
		writeJSON(w, http.StatusInternalServerError,
			errBody{Error: errPayload{Code: "internal", Message: "local dirs are not configured on this server"}})
		return false
	}
	return true
}

func (s *Server) handleListLocalDirs(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	items, err := s.opt.LocalDirs.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleCreateLocalDir(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if s.forbiddenMount(req.Path) {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden",
			Message: "不能挂载隐藏目录或工作台自己的数据目录：" + req.Path}})
		return
	}
	d, err := s.opt.LocalDirs.Create(r.Context(), req.Path, req.Name)
	if err != nil {
		s.failFsRead(w, r, err)
		return
	}
	s.auditConfig(r, "create", "local_dir", d.ID, "挂载本机目录「"+d.Name+"」", map[string]any{"path": d.Path})
	respondData(w, http.StatusCreated, d)
}

func (s *Server) handleReorderLocalDirs(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.LocalDirs.Reorder(r.Context(), req.IDs); err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.opt.LocalDirs.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, items, Meta{Total: len(items), Limit: len(items)})
}

func (s *Server) handleUpdateLocalDir(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	var req struct {
		Name *string `json:"name"`
	}
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if req.Name == nil {
		s.fail(w, r, validationf("name is required; only name can be changed"))
		return
	}
	d, err := s.opt.LocalDirs.Rename(r.Context(), r.PathValue("id"), *req.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "update", "local_dir", d.ID, "改名本机目录「"+d.Name+"」", map[string]any{"fields": []string{"name"}})
	respondData(w, http.StatusOK, d)
}

func (s *Server) handleDeleteLocalDir(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	id := r.PathValue("id")
	d, err := s.opt.LocalDirs.Get(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.opt.LocalDirs.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "local_dir", id, "移除本机目录「"+d.Name+"」", map[string]any{"path": d.Path})
	respondData(w, http.StatusOK, nil)
}

// handleListLocalDirFiles 列挂载目录下的文本文件。每次都重新校验边界，目录被移走了回 404。
func (s *Server) handleListLocalDirFiles(w http.ResponseWriter, r *http.Request) {
	if !s.localDirsConfigured(w) {
		return
	}
	d, err := s.opt.LocalDirs.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	list, err := fsbrowse.ListFiles(d.Path)
	if err != nil {
		s.failFsRead(w, r, err)
		return
	}
	respondData(w, http.StatusOK, list)
}
