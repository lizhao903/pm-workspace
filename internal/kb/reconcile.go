package kb

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// 插件按自己的资料同步知识库（TSK-0721，项目插件的「项目资料同步到知识库」节点）。
// 插件给出它这边「现在应该在知识库里的」全部资料（Item），Reconcile 让知识库里 origin 名下的篇目和它一致：
// 新的加进来，内容变了的重新索引，资料没了的移出。只动 origin 名下的（kb_docs.origin，0054），人工加的、目录和分类同步收进来的不动；
// 和人工加的重复的（同一篇工作台文档、同一个文件、同一个网址）不重复收，记一条跳过。
// 读本机文件和目录同步同一套边界：fsbrowse 的允许根、隐藏段、Allow（库文件、密钥证书、数据目录）；只收 md、markdown、txt、text，
// 单个文件超过 1MB 跳过。

// 资料的种类（Item.Kind）。
const (
	ItemFile    = "file"    // 本机单个文件，Ref 是绝对路径
	ItemDir     = "dir"     // 本机目录，Ref 是绝对路径；下面认得的文本文件一个一篇
	ItemNote    = "note"    // 一段文字，Title、Text
	ItemLink    = "link"    // 网址，Ref 是网址；不联网抓取，正文是 Text（标题、备注之类）
	ItemLibrary = "library" // 工作台文档，Ref 是对象 id；标题、正文取自文档
)

// Item 是插件要放进知识库的一条资料。
type Item struct {
	// Key 是插件那边的资料（例 material:pm_…、doc:obj_…），note、link、library 用它认「还是不是同一篇」；
	// file、dir 展开的文件按路径认（file:<绝对路径>），同一个文件从两条资料来只收一次
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	Ref   string `json:"ref"`
	Title string `json:"title"`
	Text  string `json:"text"`
	// Label 是给人看的这条资料叫什么，跳过、失败的原因里用；空串用 Title 或 Ref
	Label string `json:"label"`
}

// Problem 是一条没收进来的资料和原因。
type Problem struct {
	Title  string `json:"title"`
	Ref    string `json:"ref,omitempty"`
	Reason string `json:"reason"`
}

// ReconcileResult 是一次同步的结果。Failures、Skips 各最多列 MaxProblems 条，条数以 Failed、Skipped 为准。
type ReconcileResult struct {
	Added     int       `json:"added"`
	Updated   int       `json:"updated"`
	Removed   int       `json:"removed"`
	Unchanged int       `json:"unchanged"`
	Skipped   int       `json:"skipped"`
	Failed    int       `json:"failed"`
	Failures  []Problem `json:"failures"`
	Skips     []Problem `json:"skips"`
}

// MaxProblems 是结果里最多列几条失败、几条跳过。
const MaxProblems = 50

func (r *ReconcileResult) fail(title, ref, reason string) {
	r.Failed++
	if len(r.Failures) < MaxProblems {
		r.Failures = append(r.Failures, Problem{Title: title, Ref: ref, Reason: reason})
	}
}

func (r *ReconcileResult) skip(title, ref, reason string) {
	r.Skipped++
	if len(r.Skips) < MaxProblems {
		r.Skips = append(r.Skips, Problem{Title: title, Ref: ref, Reason: reason})
	}
}

// 跳过的原因，测试和插件按原文比对。
const (
	ReasonFileType  = "不支持的文件类型：只收 md、markdown、txt、text"
	ReasonTooLarge  = "文件超过 1MB，跳过"
	ReasonBlocked   = "这类文件不能收进知识库（库文件、密钥证书、工作台数据目录里的）"
	ReasonBinary    = "不是文本文件"
	ReasonDuplicate = "知识库里已经有了（人工加的或挂的目录收进来的），不重复收"
)

// reconciler 是一次同步的状态。
type reconciler struct {
	sv     *Service
	k      *store.KnowledgeBase
	origin string
	owned  map[string]*store.KbDoc // origin_key -> 这个 origin 已有的篇
	others map[string]bool         // 别的来源已有的 <类型>|<ref>（目录文件和本机文件都记成 path|<路径>）
	seen   map[string]bool         // 这次认到的 origin_key
	keep   []string                // 列不全的目录：下面没认到的不移出
	res    *ReconcileResult
}

func otherKey(d *store.KbDoc) string {
	switch d.Source.Type {
	case store.KbSrcDir, store.KbSrcFile:
		return "path|" + d.Source.Ref
	case store.KbSrcLibrary, store.KbSrcLink:
		return d.Source.Type + "|" + d.Source.Ref
	}
	return ""
}

// Reconcile 让知识库里 origin 名下的篇目和 items 一致，origin 不能为空。和目录同步共用「同一个知识库同时只跑一次」的拦截。
func (sv *Service) Reconcile(ctx context.Context, k *store.KnowledgeBase, origin string, items []Item) (*ReconcileResult, error) {
	if strings.TrimSpace(origin) == "" {
		return nil, invalid("同步来源没给")
	}
	if sv.Tracker != nil {
		if !sv.Tracker.begin(k.ID) {
			return nil, conflict("这个知识库正在同步，等这次同步完再试")
		}
		defer sv.Tracker.end(k.ID)
	}
	docs, err := sv.St.ListKbDocs(ctx, k.ID)
	if err != nil {
		return nil, err
	}
	rc := &reconciler{sv: sv, k: k, origin: origin, owned: map[string]*store.KbDoc{}, others: map[string]bool{},
		seen: map[string]bool{}, res: &ReconcileResult{Failures: []Problem{}, Skips: []Problem{}}}
	for _, d := range docs {
		if d.Origin == origin {
			rc.owned[d.OriginKey] = d
		} else if key := otherKey(d); key != "" {
			rc.others[key] = true
		}
	}
	for _, it := range items {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := rc.item(ctx, it); err != nil {
			return nil, err
		}
	}
	var gone []string
	for key, d := range rc.owned {
		if rc.seen[key] || rc.kept(d) {
			continue
		}
		gone = append(gone, d.ID)
	}
	if err := sv.St.DeleteKbDocs(ctx, k.ID, gone); err != nil {
		return nil, err
	}
	rc.res.Removed = len(gone)
	return rc.res, nil
}

// kept：这篇是从列不全的目录里来的，没认到也不移出。
func (rc *reconciler) kept(d *store.KbDoc) bool {
	if d.Source.Type != store.KbSrcFile {
		return false
	}
	for _, dir := range rc.keep {
		if strings.HasPrefix(d.Source.Ref, strings.TrimSuffix(dir, "/")+"/") {
			return true
		}
	}
	return false
}

func label(it Item) string {
	for _, s := range []string{it.Label, it.Title, it.Ref} {
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}
	return it.Key
}

func (rc *reconciler) item(ctx context.Context, it Item) error {
	switch it.Kind {
	case ItemFile:
		return rc.file(ctx, label(it), strings.TrimSpace(it.Ref), nil)
	case ItemDir:
		return rc.dir(ctx, label(it), strings.TrimSpace(it.Ref))
	case ItemNote:
		if strings.TrimSpace(it.Text) == "" {
			rc.res.skip(label(it), "", "没有正文")
			return nil
		}
		return rc.text(ctx, it.Key, store.KbSrcNote, "", label(it), it.Text)
	case ItemLink:
		ref := strings.TrimSpace(it.Ref)
		if rc.others[store.KbSrcLink+"|"+ref] {
			rc.res.skip(label(it), ref, ReasonDuplicate)
			return nil
		}
		return rc.text(ctx, it.Key, store.KbSrcLink, ref, label(it), it.Text)
	case ItemLibrary:
		return rc.library(ctx, it)
	}
	rc.res.fail(label(it), it.Ref, "不认识的资料种类："+it.Kind)
	return nil
}

// put 新加或更新一篇并索引，按前后比对计数。before 为 nil 是新加。
func (rc *reconciler) put(ctx context.Context, key string, before *store.KbDoc, d *store.KbDoc) error {
	var err error
	if before == nil {
		d.KbID, d.Origin, d.OriginKey = rc.k.ID, rc.origin, key
		if d, err = rc.sv.St.CreateKbDoc(ctx, d); err != nil {
			return err
		}
	} else if d.Title != before.Title || d.Text != before.Text || d.Source.Ref != before.Source.Ref {
		if d, err = rc.sv.St.UpdateKbDoc(ctx, d); err != nil {
			return err
		}
	}
	after, err := rc.sv.Index(ctx, rc.k, d)
	if err != nil {
		return err
	}
	switch {
	case after.Status == store.KbFailed:
		rc.res.fail(after.Title, after.Source.Ref, after.Error)
	case before == nil:
		rc.res.Added++
	case before.Text != after.Text || before.Title != after.Title || before.Status != after.Status:
		rc.res.Updated++
	default:
		rc.res.Unchanged++
	}
	return nil
}

// text 是笔记、链接：正文由插件给，比对后有变化才改。
func (rc *reconciler) text(ctx context.Context, key, typ, ref, title, text string) error {
	if rc.seen[key] {
		return nil
	}
	rc.seen[key] = true
	title = clipTitle(title)
	before := rc.owned[key]
	if before != nil && before.Source.Type != typ {
		// 资料改了种类（笔记改成链接）：旧的移出，按新的加
		if err := rc.sv.St.DeleteKbDocs(ctx, rc.k.ID, []string{before.ID}); err != nil {
			return err
		}
		delete(rc.owned, key)
		rc.res.Removed++
		before = nil
	}
	if before != nil && before.Title == title && before.Text == text && before.Source.Ref == ref && before.Status == store.KbIndexed {
		rc.res.Unchanged++
		return nil
	}
	d := &store.KbDoc{Title: title, Text: text, Source: store.KbSource{Type: typ, Ref: ref}}
	if before != nil {
		next := *before
		next.Title, next.Text, next.Source.Ref = title, text, ref
		d = &next
	}
	return rc.put(ctx, key, before, d)
}

func (rc *reconciler) library(ctx context.Context, it Item) error {
	id := strings.TrimSpace(it.Ref)
	key := it.Key
	if key == "" {
		key = "doc:" + id
	}
	if rc.seen[key] {
		return nil
	}
	if rc.others[store.KbSrcLibrary+"|"+id] {
		rc.res.skip(label(it), id, ReasonDuplicate)
		return nil
	}
	o, err := rc.sv.St.GetObject(ctx, id)
	if err != nil || o.DeletedAt != nil || o.TypeID != "doc" {
		rc.res.fail(label(it), id, "工作台文档不存在或已删除")
		return nil
	}
	rc.seen[key] = true
	before := rc.owned[key]
	if before != nil && before.Title == clipTitle(o.Title) && before.Text == o.Body && before.Status == store.KbIndexed {
		rc.res.Unchanged++
		return nil
	}
	d := &store.KbDoc{Title: o.Title, Text: o.Body, Source: store.KbSource{Type: store.KbSrcLibrary, Ref: o.ID}}
	if before != nil {
		d = before
	}
	return rc.put(ctx, key, before, d)
}

// dir 列目录下认得的文本文件，一个一篇。目录不在、越界的整条记失败，原来从它收进来的不移出（可能只是盘没挂上）。
func (rc *reconciler) dir(ctx context.Context, name, dir string) error {
	if !filepath.IsAbs(dir) {
		rc.res.fail(name, dir, "目录要是绝对路径")
		return nil
	}
	real, err := fsbrowse.ResolveDir(dir)
	if err == nil && (hiddenPath(real) || !rc.sv.allowDir(real)) {
		err = &fsbrowse.PathError{Kind: fsbrowse.ErrForbidden, Msg: "隐藏目录和工作台的数据目录不能收：" + real}
	}
	if err != nil {
		rc.keep = append(rc.keep, dir)
		if real != "" {
			rc.keep = append(rc.keep, real)
		}
		rc.res.fail(name, dir, pathReason(err))
		return nil
	}
	for cur := ""; ; {
		if err := ctx.Err(); err != nil {
			return err
		}
		list, err := fsbrowse.ListFilesPage(real, cur, syncPage)
		if err != nil {
			rc.keep = append(rc.keep, real)
			rc.res.fail(name, dir, pathReason(err))
			return nil
		}
		for _, f := range list.Files {
			if !dirExt[f.Ext] || !rc.sv.allow(f.Path) || hiddenPath(f.Path) {
				continue
			}
			if err := rc.file(ctx, f.Name, f.Path, f); err != nil {
				return err
			}
		}
		if list.Truncated {
			why := "目录太大，走了 " + strconv.Itoa(fsbrowse.MaxListVisited) + " 项还没走完"
			if list.Reason == fsbrowse.TruncDepth {
				why = "有子目录超过 " + strconv.Itoa(fsbrowse.MaxListDepth) + " 层，没往下走"
			}
			rc.keep = append(rc.keep, real)
			rc.res.fail(name, dir, why+"；没列到的不移出")
		}
		if list.NextCursor == "" {
			return nil
		}
		cur = list.NextCursor
	}
}

// file 收一个本机文件。listed 是目录列表里的这一项（有修改时间，已索引且没改过的跳过不读），单个文件为 nil。
func (rc *reconciler) file(ctx context.Context, name, path string, listed *fsbrowse.FileItem) error {
	if !filepath.IsAbs(path) {
		rc.res.fail(name, path, "文件要是绝对路径")
		return nil
	}
	real := path
	if listed == nil {
		if ev, err := filepath.EvalSymlinks(filepath.Clean(path)); err == nil {
			real = ev
		}
	}
	key := "file:" + real
	if rc.seen[key] {
		return nil
	}
	switch {
	case rc.others["path|"+real]:
		rc.res.skip(name, real, ReasonDuplicate)
		return nil
	case !dirExt[extOf(real)]:
		rc.res.skip(name, real, ReasonFileType)
		return nil
	case hiddenPath(real) || !rc.sv.allow(real):
		rc.res.skip(name, real, ReasonBlocked)
		return nil
	}
	before := rc.owned[key]
	title := clipTitle(filepath.Base(real))
	if listed != nil && before != nil && before.Status == store.KbIndexed && before.Title == title && !listed.Modified.After(before.UpdatedAt) {
		rc.seen[key] = true
		rc.res.Unchanged++
		return nil
	}
	f, err := fsbrowse.ReadFile(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && listed == nil && before != nil {
			// 资料还登记着、文件没了：这次不收，原来那篇移出（不标 seen）
			rc.res.fail(name, real, "找不到这个文件了")
			return nil
		}
		rc.seen[key] = before != nil // 读不到（权限、越界）时原来那篇先留着
		rc.res.fail(name, real, pathReason(err))
		return nil
	}
	switch {
	case f.Truncated:
		rc.res.skip(name, real, ReasonTooLarge)
		return nil
	case f.Binary:
		rc.res.skip(name, real, ReasonBinary)
		return nil
	}
	rc.seen[key] = true
	if before != nil && before.Title == title && before.Text == f.Content && before.Status == store.KbIndexed {
		rc.res.Unchanged++
		return nil
	}
	d := &store.KbDoc{Title: title, Text: f.Content, Source: store.KbSource{Type: store.KbSrcFile, Ref: real}}
	if before != nil {
		next := *before
		next.Title, next.Text, next.Source.Ref = title, f.Content, real
		d = &next
	}
	return rc.put(ctx, key, before, d)
}

// readLocalFile 是重新索引 file 类型时重读本机文件，规则同 Reconcile。
func (sv *Service) readLocalFile(path string) (string, string) {
	if hiddenPath(path) || !sv.allow(path) {
		return "", ReasonBlocked
	}
	if !dirExt[extOf(path)] {
		return "", ReasonFileType
	}
	f, err := fsbrowse.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", "找不到这个文件了"
		}
		return "", pathReason(err)
	}
	if f.Truncated {
		return "", ReasonTooLarge
	}
	if f.Binary {
		return "", ReasonBinary
	}
	return f.Content, ""
}

// allowDir：目录本身过 Allow（数据目录、包住数据目录的不行）。Allow 对目录按文件规则判，库文件后缀的目录名一般不会有。
func (sv *Service) allowDir(dir string) bool {
	if sv.AllowDir != nil {
		return sv.AllowDir(dir)
	}
	return sv.allow(dir)
}

// hiddenPath：路径里有以 . 开头的段。
func hiddenPath(p string) bool {
	for _, seg := range strings.Split(filepath.Clean(p), string(filepath.Separator)) {
		if seg != "" && seg != "." && strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func pathReason(err error) string {
	var pe *fsbrowse.PathError
	if errors.As(err, &pe) && pe.Msg != "" {
		return pe.Msg
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "找不到这个路径"
	case errors.Is(err, fs.ErrPermission):
		return "没有读权限"
	}
	return err.Error()
}

// kbTitleMax 同 store 的标题上限（300 字）。
const kbTitleMax = 300

func clipTitle(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > kbTitleMax {
		return string(r[:kbTitleMax-1]) + "…"
	}
	return s
}
