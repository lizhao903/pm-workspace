package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/kb"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// --- 知识库（AG-01b3，0034）。名称、切分设置的校验在 store，取正文、切块、同步、检索在 internal/kb，
// 这里校验目录路径（和 DOC-01a 挂载同一套边界）、拼视图、记审计 ---

// kbService 读本地文件的拦截和 /api/fs/read 一致：库文件、密钥证书、数据目录里的不收。
func (s *Server) kbService() *kb.Service {
	return &kb.Service{St: s.st, DataDir: s.opt.DataDir, Tracker: s.kbSync, Allow: func(p string) bool {
		real := realPath(p)
		return !sensitiveFile(real) && !s.inDataDir(real)
	}}
}

type kbDirView struct {
	store.KbDir
	Files int `json:"files"`
}

type kbSettingsView struct {
	store.KbSettings
	Dirs []kbDirView `json:"dirs"`
}

// kbView 是接口里的知识库：counts 是各状态篇数，agents 是挂着它的 Agent，dirs 带收进来的文件数。
type kbView struct {
	store.KnowledgeBase
	Settings kbSettingsView `json:"settings"`
	Counts   store.KbCounts `json:"counts"`
	Agents   []skillAgent   `json:"agents"`
}

// kbAgents 是 知识库 id -> 挂着它的 Agent，Agent 按新建的在前。
func (s *Server) kbAgents(ctx context.Context) (map[string][]skillAgent, error) {
	agents, err := s.st.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string][]skillAgent{}
	for _, a := range agents {
		for _, id := range a.KBs {
			out[id] = append(out[id], skillAgent{ID: a.ID, Name: a.Name})
		}
	}
	return out, nil
}

func newKbView(k *store.KnowledgeBase, counts map[string]store.KbCounts, agents map[string][]skillAgent, docs []*store.KbDoc) kbView {
	v := kbView{KnowledgeBase: *k, Counts: counts[k.ID], Agents: agents[k.ID]}
	if v.Agents == nil {
		v.Agents = []skillAgent{}
	}
	v.Settings = kbSettingsView{KbSettings: k.Settings, Dirs: []kbDirView{}}
	for _, d := range k.Settings.Dirs {
		n := 0
		for _, doc := range docs {
			if kb.InDir(doc, d.Path) {
				n++
			}
		}
		v.Settings.Dirs = append(v.Settings.Dirs, kbDirView{KbDir: d, Files: n})
	}
	return v
}

func (s *Server) kbView(ctx context.Context, k *store.KnowledgeBase) (kbView, error) {
	counts, err := s.st.KbCounts(ctx)
	if err != nil {
		return kbView{}, err
	}
	agents, err := s.kbAgents(ctx)
	if err != nil {
		return kbView{}, err
	}
	docs, err := s.st.ListKbDocs(ctx, k.ID)
	if err != nil {
		return kbView{}, err
	}
	return newKbView(k, counts, agents, docs), nil
}

func (s *Server) handleListKnowledgeBases(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := s.st.ListKnowledgeBases(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	counts, err := s.st.KbCounts(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	agents, err := s.kbAgents(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items := make([]kbView, 0, len(list))
	for _, k := range list {
		var docs []*store.KbDoc
		if len(k.Settings.Dirs) > 0 {
			if docs, err = s.st.ListKbDocs(ctx, k.ID); err != nil {
				s.fail(w, r, err)
				return
			}
		}
		items = append(items, newKbView(k, counts, agents, docs))
	}
	respondList(w, items, Meta{Total: len(items)})
}

func (s *Server) handleGetKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	k, err := s.st.GetKnowledgeBase(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.respondKb(w, r, http.StatusOK, k)
}

func (s *Server) respondKb(w http.ResponseWriter, r *http.Request, status int, k *store.KnowledgeBase) {
	v, err := s.kbView(r.Context(), k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, status, v)
}

// checkKbDirs 校验新挂的目录：绝对路径、允许根内存在的目录、不碰隐藏段和数据目录（同 POST /api/local-dirs），
// 换成解析软链后的路径。已经挂着的路径不再查。越界回的错误带 forbidden 标记。
func (s *Server) checkKbDirs(cur []store.KbDir, dirs *[]store.KbDir) error {
	if dirs == nil {
		return nil
	}
	for i, d := range *dirs {
		p := strings.TrimSpace(d.Path)
		if len(p) > 1 {
			p = strings.TrimRight(p, "/")
		}
		if slices.ContainsFunc(cur, func(x store.KbDir) bool { return x.Path == p }) {
			(*dirs)[i].Path = p
			continue
		}
		if !filepath.IsAbs(p) {
			return validationf("填绝对路径，以 / 开头：%s", p)
		}
		if s.forbiddenMount(p) {
			return errKbForbidden{"这个目录不能挂：隐藏目录和工作台的数据目录不行：" + p}
		}
		real, err := fsbrowse.ResolveDir(p)
		switch {
		case errors.Is(err, fsbrowse.ErrForbidden):
			return errKbForbidden{err.Error()}
		case errors.Is(err, fs.ErrNotExist):
			return validationf("找不到这个目录：%s", p)
		case errors.Is(err, fs.ErrPermission):
			return validationf("没有读权限：%s", p)
		case err != nil:
			return validationf("%s", err.Error())
		}
		if s.forbiddenMount(real) {
			return errKbForbidden{"这个目录不能挂：隐藏目录和工作台的数据目录不行：" + real}
		}
		(*dirs)[i].Path = real
	}
	return nil
}

type errKbForbidden struct{ msg string }

func (e errKbForbidden) Error() string { return e.msg }

func (s *Server) failKb(w http.ResponseWriter, r *http.Request, err error) {
	var fe errKbForbidden
	if errors.As(err, &fe) {
		writeJSON(w, http.StatusForbidden, errBody{Error: errPayload{Code: "forbidden", Message: fe.msg}})
		return
	}
	s.fail(w, r, err)
}

func (s *Server) handleCreateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in store.KbInput
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if in.Settings != nil {
		if err := s.checkKbDirs(nil, in.Settings.Dirs); err != nil {
			s.failKb(w, r, err)
			return
		}
	}
	k, err := s.st.CreateKnowledgeBase(ctx, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// 选了的分类、挂了的目录里的文档马上收进来
	if len(k.Sources) > 0 || len(k.Settings.Dirs) > 0 {
		if _, err := s.kbService().Sync(ctx, k, ""); err != nil {
			s.fail(w, r, err)
			return
		}
		if k, err = s.st.GetKnowledgeBase(ctx, k.ID); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	s.auditConfig(r, "create", "knowledge_base", k.ID, "新建知识库「"+k.Name+"」",
		map[string]any{"name": k.Name, "sources": k.Sources, "dirs": len(k.Settings.Dirs)})
	s.respondKb(w, r, http.StatusCreated, k)
}

// handleUpdateKnowledgeBase：settings.dirs 是整组替换；移除的目录连同收进来的文件一起移出，新挂的马上同步。
// sources 加了分类时把新分类里的文档收进来。切分设置改了不自动重新索引（SPEC-settings-13.11）。
func (s *Server) handleUpdateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	keys, err := patchKeys(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var in store.KbInput
	if err := json.Unmarshal(body, &in); err != nil {
		s.fail(w, r, validationf("malformed JSON body: %v", err))
		return
	}
	cur, err := s.st.GetKnowledgeBase(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if in.Settings != nil {
		if err := s.checkKbDirs(cur.Settings.Dirs, in.Settings.Dirs); err != nil {
			s.failKb(w, r, err)
			return
		}
	}
	k, err := s.st.UpdateKnowledgeBase(ctx, cur.ID, in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	sv := s.kbService()
	for _, d := range cur.Settings.Dirs {
		if !slices.ContainsFunc(k.Settings.Dirs, func(x store.KbDir) bool { return x.Path == d.Path }) {
			if _, err := sv.RemoveDir(ctx, k.ID, d.Path); err != nil {
				s.fail(w, r, err)
				return
			}
		}
	}
	for _, d := range k.Settings.Dirs {
		if !slices.ContainsFunc(cur.Settings.Dirs, func(x store.KbDir) bool { return x.Path == d.Path }) {
			if _, err := sv.Sync(ctx, k, d.Path); err != nil {
				s.fail(w, r, err)
				return
			}
		}
	}
	added := slices.ContainsFunc(k.Sources, func(id string) bool { return !slices.Contains(cur.Sources, id) })
	if added {
		if _, err := sv.Sync(ctx, k, ""); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	if k, err = s.st.GetKnowledgeBase(ctx, k.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	fields := map[string]bool{}
	for key := range keys {
		fields[key] = key == "name" || key == "desc" || key == "sources" || key == "settings"
	}
	s.auditConfig(r, "update", "knowledge_base", k.ID, "修改知识库「"+k.Name+"」", map[string]any{"fields": givenFields(fields)})
	s.respondKb(w, r, http.StatusOK, k)
}

// handleDeleteKnowledgeBase 回删掉的那条，agents 是被摘掉它的 Agent（SPEC-settings-14.7）。
func (s *Server) handleDeleteKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	before, err := s.kbAgents(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	k, detached, err := s.st.DeleteKnowledgeBase(ctx, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.kbService().RemoveFiles(k.ID, "")
	names := map[string]string{}
	for _, a := range before[k.ID] {
		names[a.ID] = a.Name
	}
	ag := make([]skillAgent, 0, len(detached))
	for _, id := range detached {
		ag = append(ag, skillAgent{ID: id, Name: names[id]})
	}
	s.auditConfig(r, "delete", "knowledge_base", k.ID, "删除知识库「"+k.Name+"」",
		map[string]any{"name": k.Name, "detached_agents": detached})
	v := newKbView(k, nil, map[string][]skillAgent{k.ID: ag}, nil)
	respondData(w, http.StatusOK, v)
}

// --- 文档 ---

func (s *Server) kbOf(w http.ResponseWriter, r *http.Request) *store.KnowledgeBase {
	k, err := s.st.GetKnowledgeBase(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return nil
	}
	return k
}

func (s *Server) handleListKbDocs(w http.ResponseWriter, r *http.Request) {
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	docs, err := s.st.ListKbDocs(r.Context(), k.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, docs, Meta{Total: len(docs)})
}

// handleKbMissing 是来源分类里还没收进来的工作台文档（SPEC-settings-11.5）。
func (s *Server) handleKbMissing(w http.ResponseWriter, r *http.Request) {
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	objs, err := s.kbService().Missing(r.Context(), k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	type item struct {
		ID         string  `json:"id"`
		Ref        string  `json:"ref"`
		Title      string  `json:"title"`
		CategoryID *string `json:"category_id"`
	}
	out := make([]item, 0, len(objs))
	for _, o := range objs {
		out = append(out, item{ID: o.ID, Ref: o.Ref, Title: o.Title, CategoryID: o.CategoryID})
	}
	respondList(w, out, Meta{Total: len(out)})
}

// kbAddReq 是加文档：一篇的字段，工作台文档可以用 refs 一次挑多篇（SPEC-settings-11.15）。
type kbAddReq struct {
	kb.AddInput
	Refs []string `json:"refs"`
}

func (s *Server) handleAddKbDocs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	var in kbAddReq
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	var inputs []kb.AddInput
	if in.Type == store.KbSrcLibrary && len(in.Refs) > 0 {
		// 先全部查一遍，有一篇不对就一篇都不加
		have, err := s.st.ListKbDocs(ctx, k.ID)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		seen := map[string]bool{}
		for _, ref := range in.Refs {
			ref = strings.TrimSpace(ref)
			if ref == "" || seen[ref] {
				continue
			}
			seen[ref] = true
			o, err := s.st.GetObject(ctx, ref)
			if err != nil || o.DeletedAt != nil || o.TypeID != "doc" {
				s.fail(w, r, validationf("文档 %s 不存在", ref))
				return
			}
			if slices.ContainsFunc(have, func(d *store.KbDoc) bool { return d.Source.Type == store.KbSrcLibrary && d.Source.Ref == o.ID }) {
				s.fail(w, r, conflictf("「%s」已在库里", o.Title))
				return
			}
			inputs = append(inputs, kb.AddInput{Type: store.KbSrcLibrary, Ref: o.ID})
		}
		if len(inputs) == 0 {
			s.fail(w, r, validationf("至少选一篇"))
			return
		}
	} else {
		inputs = []kb.AddInput{in.AddInput}
	}
	sv := s.kbService()
	out := []*store.KbDoc{}
	for _, x := range inputs {
		d, err := sv.Add(ctx, k, x)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		out = append(out, d)
	}
	ids := make([]string, len(out))
	for i, d := range out {
		ids[i] = d.ID
	}
	s.auditConfig(r, "create", "kb_doc", k.ID, "知识库「"+k.Name+"」加了 "+strconv.Itoa(len(out))+" 篇",
		map[string]any{"source": in.Type, "docs": ids})
	writeJSON(w, http.StatusCreated, envelope{Data: out, Meta: &Meta{Total: len(out)}})
}

// kbDocPatch：excluded 排除、恢复；title、text 只有笔记和网页链接能改，改了马上重新索引。
type kbDocPatch struct {
	Title    *string `json:"title"`
	Text     *string `json:"text"`
	Excluded *bool   `json:"excluded"`
}

func (s *Server) handleUpdateKbDoc(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	var in kbDocPatch
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	d, err := s.st.GetKbDoc(ctx, k.ID, r.PathValue("doc_id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	edit := in.Title != nil || in.Text != nil
	if edit && d.Source.Type != store.KbSrcNote && d.Source.Type != store.KbSrcLink {
		s.fail(w, r, validationf("只有笔记和网页链接能改标题和正文，其他来源改原文后重新索引"))
		return
	}
	next := *d
	if in.Title != nil {
		next.Title = *in.Title
	}
	if in.Text != nil {
		next.Text = *in.Text
	}
	if in.Excluded != nil {
		next.Excluded = *in.Excluded
	}
	if d.Source.Type == store.KbSrcNote && strings.TrimSpace(next.Text) == "" {
		s.fail(w, r, validationf("标题和正文都要填"))
		return
	}
	u, err := s.st.UpdateKbDoc(ctx, &next)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if edit && (u.Title != d.Title || u.Text != d.Text) {
		if u, err = s.kbService().Index(ctx, k, u); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	respondData(w, http.StatusOK, u)
}

// handleDeleteKbDoc 从库里移除这篇，原文档、目录里的文件不受影响；上传的原文件一起删。
func (s *Server) handleDeleteKbDoc(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	d, err := s.st.GetKbDoc(ctx, k.ID, r.PathValue("doc_id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.DeleteKbDocs(ctx, k.ID, []string{d.ID}); err != nil {
		s.fail(w, r, err)
		return
	}
	if d.Source.Type == store.KbSrcUpload {
		s.kbService().RemoveFiles(k.ID, d.ID)
	}
	s.auditConfig(r, "delete", "kb_doc", d.ID, "知识库「"+k.Name+"」移除「"+d.Title+"」",
		map[string]any{"kb_id": k.ID, "source": d.Source.Type})
	respondData(w, http.StatusOK, d)
}

// handleReindexKb 重新索引：doc_ids 给了只索引这几篇，不给是全部（SPEC-settings-11.4、11.10）。
func (s *Server) handleReindexKb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	var in struct {
		DocIDs []string `json:"doc_ids"`
	}
	if err := decodeOptionalBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	docs, err := s.st.ListKbDocs(ctx, k.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if len(in.DocIDs) > 0 {
		for _, id := range in.DocIDs {
			if !slices.ContainsFunc(docs, func(d *store.KbDoc) bool { return d.ID == id }) {
				s.fail(w, r, validationf("文档 %s 不在这个知识库里", id))
				return
			}
		}
		docs = slices.DeleteFunc(docs, func(d *store.KbDoc) bool { return !slices.Contains(in.DocIDs, d.ID) })
	}
	sv := s.kbService()
	out := make([]*store.KbDoc, 0, len(docs))
	for _, d := range docs {
		u, err := sv.Index(ctx, k, d)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		out = append(out, u)
	}
	respondList(w, out, Meta{Total: len(out)})
}

// handleSyncKb 同步来源：path 给了只同步这个目录，不给是文档分类加全部目录（SPEC-settings-13.6）。
func (s *Server) handleSyncKb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	var in struct {
		Path string `json:"path"`
	}
	if err := decodeOptionalBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	p := strings.TrimSpace(in.Path)
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	// 大目录同步要一阵子：和浏览器连接脱钩，页面关了、刷新了也照样跑完（进度看 GET .../sync）
	res, err := s.kbService().Sync(context.WithoutCancel(ctx), k, p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if k, err = s.st.GetKnowledgeBase(ctx, k.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	v, err := s.kbView(ctx, k)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, map[string]any{"result": res, "knowledge_base": v})
}

// handleKbSyncProgress 回这个知识库正在跑的同步的进度，没在同步回 null。界面在同步请求没回来时轮询它。
func (s *Server) handleKbSyncProgress(w http.ResponseWriter, r *http.Request) {
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	respondData(w, http.StatusOK, s.kbSync.Get(k.ID))
}

// handleSearchKb 关键词检索，打分和原型 searchKb 一致（SPEC-settings-12）。
func (s *Server) handleSearchKb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	k := s.kbOf(w, r)
	if k == nil {
		return
	}
	var in struct {
		Q   string `json:"q"`
		Top *int   `json:"top"`
	}
	if err := decodeBody(r, &in); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(in.Q) == "" {
		s.fail(w, r, validationf("问题还没填"))
		return
	}
	top := k.Settings.Top
	if in.Top != nil {
		if *in.Top < 1 || *in.Top > 20 {
			s.fail(w, r, validationf("返回条数在 1 到 20 之间"))
			return
		}
		top = *in.Top
	}
	terms, hits, err := kb.Search(ctx, s.st, []string{k.ID}, in.Q, top)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	counts, err := s.st.KbCounts(ctx)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	c := counts[k.ID]
	respondData(w, http.StatusOK, map[string]any{
		"terms": terms, "hits": hits,
		"scope": map[string]int{"searchable": c.Searchable, "skipped": c.Docs - c.Searchable},
	})
}
