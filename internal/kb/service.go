package kb

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 本地目录只收这几种扩展名（SPEC-settings-13.4「只收 .md、.txt 文件」）。
var dirExt = map[string]bool{"md": true, "markdown": true, "txt": true, "text": true}

// 上传接受的扩展名（SPEC-settings-11.16）；文本类直接读正文，pdf、docx 先收进来，索引时报原因。
var (
	uploadText = map[string]bool{"md": true, "markdown": true, "txt": true, "csv": true}
	uploadExt  = map[string]bool{"md": true, "markdown": true, "txt": true, "csv": true, "pdf": true, "docx": true}
)

// MaxUpload 是上传文件的上限：请求体整体限 2MB，base64 之后要装得下。
const MaxUpload = 1 << 20

// Service 把来源的正文取出来、切块、写进 store。读本地文件只走 fsbrowse（和 DOC-01a 同一套边界），
// Allow 是接口层给的拦截：库文件、密钥证书、数据目录里的文件回 false（同 /api/fs/read）。
type Service struct {
	St      Store
	DataDir string // 上传的原文件存在 <DataDir>/kb/<知识库 id>/<文档 id>/ 下；空串不存
	Allow   func(path string) bool
}

// Store 是 Service 用到的存储：知识库一组，加上读工作台文档。
type Store interface {
	store.KnowledgeStore
	GetObject(ctx context.Context, id string) (*domain.Object, error)
	ListObjects(ctx context.Context, f domain.ObjectFilter) ([]*domain.Object, int, error)
}

// Error 是给用户看的一句话，Kind 是 domain 的哨兵错误。
type Error struct {
	Msg  string
	Kind error
}

func (e *Error) Error() string { return e.Msg }
func (e *Error) Unwrap() error { return e.Kind }

func invalid(format string, a ...any) error {
	return &Error{Msg: fmt.Sprintf(format, a...), Kind: domain.ErrValidation}
}

func conflict(format string, a ...any) error {
	return &Error{Msg: fmt.Sprintf(format, a...), Kind: domain.ErrConflict}
}

func (sv *Service) allow(path string) bool { return sv.Allow == nil || sv.Allow(path) }

// AddInput 是加一篇资料。Data 只有上传用；目录里的文件不走这里，由挂目录和同步收进来。
type AddInput struct {
	Type  string `json:"type"`
	Ref   string `json:"ref"`
	Title string `json:"title"`
	Text  string `json:"text"`
	Data  []byte `json:"data"`
}

// Add 校验后加进知识库并立即索引，回索引后的那篇。
func (sv *Service) Add(ctx context.Context, k *store.KnowledgeBase, in AddInput) (*store.KbDoc, error) {
	d := &store.KbDoc{KbID: k.ID, Source: store.KbSource{Type: in.Type, Ref: strings.TrimSpace(in.Ref)}, Title: strings.TrimSpace(in.Title), Text: in.Text}
	switch in.Type {
	case store.KbSrcLibrary:
		if d.Source.Ref == "" {
			return nil, invalid("至少选一篇")
		}
		o, err := sv.St.GetObject(ctx, d.Source.Ref)
		if err != nil || o.DeletedAt != nil {
			return nil, invalid("文档 %s 不存在", d.Source.Ref)
		}
		if o.TypeID != "doc" {
			return nil, invalid("%s 不是工作台文档", o.Ref)
		}
		docs, err := sv.St.ListKbDocs(ctx, k.ID)
		if err != nil {
			return nil, err
		}
		for _, x := range docs {
			if x.Source.Type == store.KbSrcLibrary && x.Source.Ref == o.ID {
				return nil, conflict("「%s」已在库里", o.Title)
			}
		}
		d.Source.Ref, d.Title, d.Text = o.ID, o.Title, o.Body
	case store.KbSrcUpload:
		name := filepath.Base(strings.ReplaceAll(d.Source.Ref, "\\", "/"))
		if d.Source.Ref == "" || name == "." || name == "/" {
			return nil, invalid("先选文件")
		}
		ext := extOf(name)
		if !uploadExt[ext] {
			return nil, invalid("支持 .md、.txt、.csv，.pdf 和 .docx 要带可提取的文字")
		}
		if len(in.Data) > MaxUpload {
			return nil, invalid("文件太大，最多 1MB")
		}
		d.Source.Ref = name
		if d.Title == "" {
			d.Title = name
		}
		d.Text = ""
		if uploadText[ext] && utf8.Valid(in.Data) {
			d.Text = string(in.Data)
		}
	case store.KbSrcLink:
		u, err := url.Parse(d.Source.Ref)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, invalid("填一个 http 或 https 开头的网址")
		}
		if d.Title == "" {
			d.Title = d.Source.Ref
		}
	case store.KbSrcNote:
		d.Source.Ref = ""
		if d.Title == "" || strings.TrimSpace(d.Text) == "" {
			return nil, invalid("标题和正文都要填")
		}
	case store.KbSrcDir:
		return nil, invalid("本地目录里的文件在知识库设置里挂目录、同步时收进来")
	default:
		return nil, invalid("来源只能是 library、upload、link、note")
	}
	made, err := sv.St.CreateKbDoc(ctx, d)
	if err != nil {
		return nil, err
	}
	if in.Type == store.KbSrcUpload && sv.DataDir != "" {
		dir := filepath.Join(sv.DataDir, "kb", k.ID, made.ID)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("save upload: %w", err)
		}
		if err := os.WriteFile(filepath.Join(dir, made.Source.Ref), in.Data, 0o600); err != nil {
			return nil, fmt.Errorf("save upload: %w", err)
		}
	}
	return sv.Index(ctx, k, made)
}

// RemoveFiles 删掉上传的原文件；docID 为空删整个知识库的。
func (sv *Service) RemoveFiles(kbID, docID string) {
	if sv.DataDir == "" || kbID == "" {
		return
	}
	p := filepath.Join(sv.DataDir, "kb", kbID)
	if docID != "" {
		p = filepath.Join(p, docID)
	}
	_ = os.RemoveAll(p)
}

// Index 重新取来源的正文（工作台文档、目录文件）、按知识库当前的切分设置切块，回索引后的那篇。
// 取不到正文时状态为 failed，error 是原因；这不算出错，err 只给存储失败。
func (sv *Service) Index(ctx context.Context, k *store.KnowledgeBase, d *store.KbDoc) (*store.KbDoc, error) {
	title, text, reason := sv.fetch(ctx, k, d)
	if reason == "" && (title != d.Title || text != d.Text) {
		next := *d
		next.Title, next.Text = title, text
		u, err := sv.St.UpdateKbDoc(ctx, &next)
		if err != nil {
			return nil, err
		}
		d = u
	}
	if reason == "" && strings.TrimSpace(d.Text) == "" {
		reason = emptyReason(d)
	}
	if reason != "" {
		return sv.St.IndexKbDoc(ctx, d.ID, store.KbFailed, reason, nil)
	}
	cs := Split(d.Text, k.Settings.ChunkSize, k.Settings.Overlap)
	chunks := make([]store.KbChunk, len(cs))
	rs := []rune(d.Text)
	for i, c := range cs {
		chunks[i] = store.KbChunk{Index: i, Start: c.Start, End: c.End, Text: string(rs[c.Start:c.End])}
	}
	return sv.St.IndexKbDoc(ctx, d.ID, store.KbIndexed, "", chunks)
}

// fetch 取最新的标题和正文；reason 非空表示取不到。
func (sv *Service) fetch(ctx context.Context, k *store.KnowledgeBase, d *store.KbDoc) (title, text, reason string) {
	title, text = d.Title, d.Text
	switch d.Source.Type {
	case store.KbSrcLibrary:
		o, err := sv.St.GetObject(ctx, d.Source.Ref)
		if err != nil || o.DeletedAt != nil {
			return title, text, "原文档已删除，移除这篇或换一篇"
		}
		return o.Title, o.Body, ""
	case store.KbSrcDir:
		body, why := sv.readDirFile(k, d.Source.Ref)
		if why != "" {
			return title, text, why
		}
		return title, body, ""
	}
	return title, text, ""
}

func emptyReason(d *store.KbDoc) string {
	switch d.Source.Type {
	case store.KbSrcUpload:
		switch extOf(d.Source.Ref) {
		case "pdf":
			return "PDF 里的文字还提取不了，导出成 .md 或 .txt 再传"
		case "docx":
			return "这种格式还提取不了文字，转成 .md 或 .txt 再传"
		}
		return "文件里没有可以索引的文字"
	case store.KbSrcLink:
		return "没有正文：网页不联网抓取，把关键段落贴进正文摘录"
	}
	return "没有正文可以索引"
}

// readDirFile 读知识库目录里的一个文件；不在挂着的目录里、隐藏、被拦截、不是文本都给原因。
func (sv *Service) readDirFile(k *store.KnowledgeBase, path string) (string, string) {
	if dirOf(k, path) == "" {
		return "", "这个文件不在挂着的目录里了"
	}
	if !sv.allow(path) || !dirExt[extOf(path)] {
		return "", "这类文件不能收进知识库"
	}
	f, err := fsbrowse.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "目录里找不到这个文件了"
		}
		return "", "读不到这个文件：" + err.Error()
	}
	if f.Binary {
		return "", "不是文本文件"
	}
	return f.Content, ""
}

// dirOf 是 path 所在的挂载目录（目录以下不能有隐藏段），没有回空串。
func dirOf(k *store.KnowledgeBase, path string) string {
	for _, d := range k.Settings.Dirs {
		rel, err := filepath.Rel(d.Path, path)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		hidden := false
		for _, seg := range strings.Split(rel, string(filepath.Separator)) {
			if strings.HasPrefix(seg, ".") {
				hidden = true
			}
		}
		if !hidden {
			return d.Path
		}
	}
	return ""
}

// InDir 判断一篇是不是从这个目录收进来的。
func InDir(d *store.KbDoc, dir string) bool {
	return d.Source.Type == store.KbSrcDir && strings.HasPrefix(d.Source.Ref, strings.TrimSuffix(dir, "/")+"/")
}

func extOf(name string) string {
	base := filepath.Base(name)
	if i := strings.LastIndex(base, "."); i > 0 {
		return strings.ToLower(base[i+1:])
	}
	return ""
}

// SyncResult 是一次同步的结果。Errors 是同步不了的目录 -> 原因。
type SyncResult struct {
	Added     int               `json:"added"`
	Updated   int               `json:"updated"`
	Removed   int               `json:"removed"`
	Unchanged int               `json:"unchanged"`
	Failed    int               `json:"failed"`
	Errors    map[string]string `json:"errors"`
}

func (r *SyncResult) count(before, after *store.KbDoc) {
	switch {
	case after.Status == store.KbFailed:
		r.Failed++
	case before == nil:
		r.Added++
	case before.Text != after.Text || before.Title != after.Title || before.Status != after.Status:
		r.Updated++
	default:
		r.Unchanged++
	}
}

// Sync 同步来源：path 为空时同步文档分类和全部目录，否则只同步这个目录。
// 目录：新文件收进来，内容变了的重新索引，不在了的移出；文档分类：没收进来的收进来，改过的重新索引。
func (sv *Service) Sync(ctx context.Context, k *store.KnowledgeBase, path string) (*SyncResult, error) {
	res := &SyncResult{Errors: map[string]string{}}
	docs, err := sv.St.ListKbDocs(ctx, k.ID)
	if err != nil {
		return nil, err
	}
	if path == "" {
		if err := sv.syncLibrary(ctx, k, docs, res); err != nil {
			return nil, err
		}
	}
	found := false
	for _, d := range k.Settings.Dirs {
		if path != "" && d.Path != path {
			continue
		}
		found = true
		if err := sv.syncDir(ctx, k, d.Path, docs, res); err != nil {
			var pe *fsbrowse.PathError
			if errors.As(err, &pe) {
				res.Errors[d.Path] = pe.Msg
				continue
			}
			return nil, err
		}
		if err := sv.St.SetKbDirSynced(ctx, k.ID, d.Path, time.Now()); err != nil {
			return nil, err
		}
	}
	if path != "" && !found {
		return nil, &Error{Msg: "这个目录没挂在知识库上：" + path, Kind: domain.ErrNotFound}
	}
	return res, nil
}

func (sv *Service) syncLibrary(ctx context.Context, k *store.KnowledgeBase, docs []*store.KbDoc, res *SyncResult) error {
	have := map[string]*store.KbDoc{}
	for _, d := range docs {
		if d.Source.Type == store.KbSrcLibrary {
			have[d.Source.Ref] = d
		}
	}
	// 已在库里的工作台文档重新取正文，不管在不在来源分类里
	for _, d := range docs {
		if d.Source.Type != store.KbSrcLibrary {
			continue
		}
		after, err := sv.Index(ctx, k, d)
		if err != nil {
			return err
		}
		res.count(d, after)
	}
	for _, cat := range k.Sources {
		for off := 0; ; off += 200 {
			items, _, err := sv.St.ListObjects(ctx, domain.ObjectFilter{TypeIDs: []string{"doc"}, CategoryID: cat,
				CategorySubtree: true, Sort: "-updated_at", Limit: 200, Offset: off})
			if err != nil {
				return err
			}
			for _, o := range items {
				if have[o.ID] != nil {
					continue
				}
				d, err := sv.Add(ctx, k, AddInput{Type: store.KbSrcLibrary, Ref: o.ID})
				if err != nil {
					return err
				}
				have[o.ID] = d
				res.count(nil, d)
			}
			if len(items) < 200 {
				break
			}
		}
	}
	return nil
}

// Missing 是来源分类里还没收进知识库的工作台文档（SPEC-settings-11.5）。
func (sv *Service) Missing(ctx context.Context, k *store.KnowledgeBase) ([]*domain.Object, error) {
	docs, err := sv.St.ListKbDocs(ctx, k.ID)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, d := range docs {
		if d.Source.Type == store.KbSrcLibrary {
			have[d.Source.Ref] = true
		}
	}
	out := []*domain.Object{}
	for _, cat := range k.Sources {
		for off := 0; ; off += 200 {
			items, _, err := sv.St.ListObjects(ctx, domain.ObjectFilter{TypeIDs: []string{"doc"}, CategoryID: cat,
				CategorySubtree: true, Sort: "-updated_at", Limit: 200, Offset: off})
			if err != nil {
				return nil, err
			}
			for _, o := range items {
				if !have[o.ID] {
					have[o.ID] = true
					out = append(out, o)
				}
			}
			if len(items) < 200 {
				break
			}
		}
	}
	return out, nil
}

func (sv *Service) syncDir(ctx context.Context, k *store.KnowledgeBase, dir string, docs []*store.KbDoc, res *SyncResult) error {
	list, err := fsbrowse.ListFiles(dir)
	if err != nil {
		return err
	}
	have := map[string]*store.KbDoc{}
	for _, d := range docs {
		if InDir(d, dir) {
			have[d.Source.Ref] = d
		}
	}
	seen := map[string]bool{}
	for _, f := range list.Files {
		if !dirExt[f.Ext] || !sv.allow(f.Path) || dirOf(k, f.Path) == "" {
			continue
		}
		seen[f.Path] = true
		before := have[f.Path]
		d := before
		if d == nil {
			if d, err = sv.St.CreateKbDoc(ctx, &store.KbDoc{KbID: k.ID, Title: f.Name,
				Source: store.KbSource{Type: store.KbSrcDir, Ref: f.Path}}); err != nil {
				return err
			}
		}
		after, err := sv.Index(ctx, k, d)
		if err != nil {
			return err
		}
		res.count(before, after)
	}
	var gone []string
	for ref, d := range have {
		if !seen[ref] {
			gone = append(gone, d.ID)
		}
	}
	if err := sv.St.DeleteKbDocs(ctx, k.ID, gone); err != nil {
		return err
	}
	res.Removed += len(gone)
	return nil
}

// RemoveDir 把从这个目录收进来的文档一起移出（SPEC-settings-13.7），回移出的篇数。
func (sv *Service) RemoveDir(ctx context.Context, kbID, dir string) (int, error) {
	docs, err := sv.St.ListKbDocs(ctx, kbID)
	if err != nil {
		return 0, err
	}
	var ids []string
	for _, d := range docs {
		if InDir(d, dir) {
			ids = append(ids, d.ID)
		}
	}
	return len(ids), sv.St.DeleteKbDocs(ctx, kbID, ids)
}

// SearchHit 是一段命中，给接口和 kb_search 用。
type SearchHit struct {
	KbID   string         `json:"kb_id"`
	DocID  string         `json:"doc_id"`
	Title  string         `json:"title"`
	Source store.KbSource `json:"source"`
	Index  int            `json:"index"`
	Start  int            `json:"start"`
	End    int            `json:"end"`
	Text   string         `json:"text"`
	Score  float64        `json:"score"`
	Terms  []string       `json:"terms"`
}

// Search 在这些知识库里按关键词检索，回拆出的检索词和前 top 段命中。
func Search(ctx context.Context, st store.KnowledgeStore, kbIDs []string, q string, top int) ([]string, []SearchHit, error) {
	terms := Terms(q)
	hits := []SearchHit{}
	if len(terms) == 0 {
		return terms, hits, nil
	}
	cands, err := st.KbSearchCandidates(ctx, kbIDs, terms)
	if err != nil {
		return nil, nil, err
	}
	src := map[string]*store.KbCandidate{}
	cs := make([]Candidate, len(cands))
	for i, c := range cands {
		key := fmt.Sprintf("%s#%d", c.DocID, c.Index)
		src[key] = c
		cs[i] = Candidate{DocID: key, Title: c.Title, Index: c.Index, Chunk: Chunk{Start: c.Start, End: c.End}, Text: c.Text}
	}
	for _, h := range Rank(cs, terms, top) {
		c := src[h.DocID]
		hits = append(hits, SearchHit{KbID: c.KbID, DocID: c.DocID, Title: c.Title, Source: c.Source, Index: c.Index,
			Start: c.Start, End: c.End, Text: c.Text, Score: h.Score, Terms: h.Terms})
	}
	return terms, hits, nil
}
