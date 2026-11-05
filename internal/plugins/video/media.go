package video

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // DecodeConfig 认 gif
	_ "image/jpeg"
	_ "image/png"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// B-roll 素材目录和浏览（TSK-0456，同原型 storyboard.tsx 的 MediaDrawer）。
//
// 素材目录有两种：这一集的视频工程目录（id 固定 project，不登记，读要 fs:read:project），
// 和用户在界面上登记的本机目录（表 video_media_roots，读要 fs:read:registered）。都是只读：
// 这里没有任何写、移动、删除原文件的代码路径，写的只有插件自己的缓存目录（缩略图）。
//
// 路径安全：所有接口只认「根目录 id + 相对路径」。相对路径不能是绝对路径、不能带反斜杠和 NUL、
// 任何一段都不能是 .. 或 . 开头的隐藏项；拼上根目录后解析符号链接，结果必须还在（解析后的）根目录里，
// 指到外面的链接 400。列目录时跳过隐藏项和指到根外面的链接。
//
// 元数据和缩略图：本机有 ffprobe、ffmpeg 并且确认过 process:spawn 时取视频时长、尺寸，生成 JPEG 缩略图，
// 缓存到插件缓存目录（Core.CacheDir()/thumbs/），按「解析后的路径 + 大小 + 修改时间」取哈希命名，文件变了自然换一张；
// 图片尺寸用标准库读文件头（jpeg、png、gif）。都没有时降级成只给文件名、大小、修改时间。

// ProjectRootID 是视频工程目录这个虚拟根的 id。
const ProjectRootID = "project"

// RegisteredPerm 是读登记目录要的权限。
const RegisteredPerm = "fs:read:registered"

// MediaRoot 是一个素材目录。builtin 为 true 的是工程目录；available 为 false 时 reason 写原因（没权限、目录不在了）。
type MediaRoot struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Builtin   bool   `json:"builtin"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// MediaFile 是目录里的一个图片或视频。path 相对根目录；width、height、duration 取不到就不返回；
// thumb 为 true 表示能取缩略图（GET /media/thumb）。
type MediaFile struct {
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	Kind       string   `json:"kind"`
	Size       int64    `json:"size"`
	ModifiedAt string   `json:"modified_at"`
	Width      *int     `json:"width,omitempty"`
	Height     *int     `json:"height,omitempty"`
	Duration   *float64 `json:"duration,omitempty"`
	Thumb      bool     `json:"thumb"`
}

// MediaDir 是一个子目录。
type MediaDir struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// MediaListing 是浏览的一页：dir 是当前目录（相对根，根本身是空串），parent 是上一级（在根上时不返回）；
// dirs 是子目录（搜索时为空），files 是这一页的文件；tools 说明本机有没有 ffprobe、ffmpeg。
type MediaListing struct {
	Root      MediaRoot   `json:"root"`
	Dir       string      `json:"dir"`
	Parent    *string     `json:"parent,omitempty"`
	Dirs      []MediaDir  `json:"dirs"`
	Files     []MediaFile `json:"files"`
	Truncated bool        `json:"truncated"`
	Tools     MediaTools  `json:"tools"`
}

// MediaTools 是本机的媒体工具：probe 能取视频时长和尺寸，thumbs 能生成缩略图。
type MediaTools struct {
	Probe  bool `json:"probe"`
	Thumbs bool `json:"thumbs"`
}

var (
	imageExts = []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".avif", ".tif", ".tiff"}
	videoExts = []string{".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
	// 浏览器能直接显示的图片，预览原图只认这些；别的（heic、tif）只看缩略图
	webImageExts = []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
	mediaMIME    = map[string]string{
		".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
		".bmp": "image/bmp", ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
		".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
	}
)

// mediaKind 按扩展名认 image / video，别的回空串。
func mediaKind(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch {
	case slices.Contains(imageExts, ext):
		return "image"
	case slices.Contains(videoExts, ext):
		return "video"
	}
	return ""
}

// mediaRel 规范化相对根目录的路径，空串和 . 是根本身。
func mediaRel(s string) (string, error) {
	if s == "" || s == "." {
		return "", nil
	}
	switch {
	case len(s) > 2000:
		return "", apiErr(errValidation, "路径太长")
	case strings.ContainsAny(s, "\\\x00"):
		return "", apiErr(errValidation, "路径用 / 分隔，不能有反斜杠")
	case strings.HasPrefix(s, "/") || strings.HasPrefix(s, "~") || driveRe.MatchString(s):
		return "", apiErr(errValidation, "路径要相对素材目录写，不能是绝对路径")
	}
	for _, seg := range strings.Split(s, "/") {
		if seg == ".." {
			return "", apiErr(errValidation, "路径不能有 ..，不能越出素材目录")
		}
		if strings.HasPrefix(seg, ".") && seg != "." {
			return "", apiErr(errValidation, "隐藏的文件和目录不能浏览")
		}
	}
	c := path.Clean(s)
	if c == "." {
		return "", nil
	}
	return c, nil
}

// within 看 p 是不是 root 本身或在 root 里面（都是解析过符号链接的绝对路径）。
func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// resolveMedia 把根目录加相对路径解析成磁盘上的真实路径：符号链接解开后必须还在根目录里。
// 根目录不在了、文件不在了回 errNotFound。
func resolveMedia(root, rel string) (string, error) {
	rroot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", apiErr(errNotFound, "素材目录 %s 不在了", root)
	}
	p := filepath.Join(rroot, filepath.FromSlash(rel))
	rp, err := filepath.EvalSymlinks(p)
	if errors.Is(err, fs.ErrNotExist) {
		return "", apiErr(errNotFound, "%s 不在了（被移走或删掉了）", rel)
	}
	if err != nil {
		return "", apiErr(errValidation, "路径读不了：%v", err)
	}
	if !within(rroot, rp) {
		return "", apiErr(errValidation, "路径越出了素材目录")
	}
	return rp, nil
}

// mediaRoot 按 id 找素材目录，查权限；project 要带视频 id。回素材目录和它在磁盘上的绝对路径。
func (h *handler) mediaRoot(ctx context.Context, id, videoID string) (MediaRoot, error) {
	if id == "" {
		return MediaRoot{}, apiErr(errValidation, "root 必填")
	}
	if id == ProjectRootID {
		if videoID == "" {
			return MediaRoot{}, apiErr(errValidation, "工程目录要带 video_id")
		}
		v, err := h.getVideo(ctx, videoID)
		if err != nil {
			return MediaRoot{}, err
		}
		return h.projectRoot(ctx, v), nil
	}
	var r MediaRoot
	err := h.c.Store().QueryRow(ctx, `SELECT id, name, path, created_at FROM video_media_roots WHERE id = ?`, id).Scan(&r.ID, &r.Name, &r.Path, &r.CreatedAt)
	if errors.Is(err, plugin.ErrNoRows) {
		return MediaRoot{}, apiErr(errNotFound, "素材目录不存在（可能已经移除）")
	}
	if err != nil {
		return MediaRoot{}, err
	}
	h.checkRoot(&r, RegisteredPerm)
	return r, nil
}

// projectRoot 是这一集的工程目录，没填、没权限、不在了的 available 为 false。
func (h *handler) projectRoot(ctx context.Context, v Video) MediaRoot {
	r := MediaRoot{ID: ProjectRootID, Name: "工程目录", Builtin: true}
	wd, err := h.workdirOf(ctx, v)
	if err != nil {
		r.Reason = err.Error()
		return r
	}
	r.Path = wd
	h.checkRoot(&r, "fs:read:project")
	return r
}

func (h *handler) checkRoot(r *MediaRoot, perm string) {
	r.Available, r.Reason = false, ""
	if !h.c.Granted(perm) {
		r.Reason = fmt.Sprintf("视频插件的 %s 权限还没确认，到插件管理里升级并确认", perm)
		return
	}
	st, err := os.Stat(r.Path)
	switch {
	case err != nil:
		r.Reason = "目录不在了"
	case !st.IsDir():
		r.Reason = "不是目录"
	default:
		r.Available = true
	}
}

// usable 把不可用的根变成错误。
func (r MediaRoot) usable() error {
	if !r.Available {
		return apiErr(errValidation, "素材目录「%s」用不了：%s", r.Name, r.Reason)
	}
	return nil
}

func (h *handler) registerMedia(m plugin.RouteRegistrar) {
	m.HandleFunc("GET /api/video/media/roots", h.listMediaRoots)
	m.HandleFunc("POST /api/video/media/roots", h.addMediaRoot)
	m.HandleFunc("PATCH /api/video/media/roots/{id}", h.updateMediaRoot)
	m.HandleFunc("DELETE /api/video/media/roots/{id}", h.removeMediaRoot)
	m.HandleFunc("GET /api/video/media/browse", h.browseMedia)
	m.HandleFunc("GET /api/video/media/file", h.mediaFile)
	m.HandleFunc("GET /api/video/media/thumb", h.mediaThumb)
}

func (h *handler) loadMediaRoots(ctx context.Context) ([]MediaRoot, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT id, name, path, created_at FROM video_media_roots ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MediaRoot{}
	for rows.Next() {
		var r MediaRoot
		if err := rows.Scan(&r.ID, &r.Name, &r.Path, &r.CreatedAt); err != nil {
			return nil, err
		}
		h.checkRoot(&r, RegisteredPerm)
		out = append(out, r)
	}
	return out, rows.Err()
}

// listMediaRoots：带 video_id 时最前面是这一集的工程目录。
func (h *handler) listMediaRoots(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := []MediaRoot{}
	if vid := r.URL.Query().Get("video_id"); vid != "" {
		v, err := h.getVideo(ctx, vid)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		out = append(out, h.projectRoot(ctx, v))
	}
	xs, err := h.loadMediaRoots(ctx)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out = append(out, xs...)
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"total": len(out)}})
}

// sysMediaDirs 是不能登记成素材目录的系统目录（本身和下面都不行），解开符号链接前后各查一次。
var sysMediaDirs = []string{"/etc", "/System", "/usr", "/bin", "/sbin", "/dev", "/Library", "/private/etc", "/private/var/db"}

// checkRootPath 校验要登记的目录：绝对路径、存在、是目录，不是磁盘根、系统目录，路径里没有隐藏段。回规范化后的路径。
func checkRootPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", apiErr(errValidation, "目录路径必填")
	}
	if !filepath.IsAbs(p) || strings.HasPrefix(p, "~") {
		return "", apiErr(errValidation, "填绝对路径，以 / 开头")
	}
	if len([]rune(p)) > 1000 {
		return "", apiErr(errValidation, "路径最多 1000 字")
	}
	c := filepath.Clean(p)
	real, err := filepath.EvalSymlinks(c)
	if err != nil {
		return "", apiErr(errValidation, "找不到这个目录")
	}
	for _, x := range []string{c, real} {
		if x == "/" {
			return "", apiErr(errValidation, "不能登记整个磁盘的根目录，选一个具体的素材目录")
		}
		for _, s := range sysMediaDirs {
			if x == s || strings.HasPrefix(x, s+"/") {
				return "", apiErr(errValidation, "系统目录 %s 不能登记成素材目录", s)
			}
		}
		for _, seg := range strings.Split(x, "/") {
			if strings.HasPrefix(seg, ".") {
				return "", apiErr(errValidation, "路径里有隐藏目录（%s），不能登记", seg)
			}
		}
	}
	st, err := os.Stat(real)
	if err != nil {
		return "", apiErr(errValidation, "找不到这个目录")
	}
	if !st.IsDir() {
		return "", apiErr(errValidation, "这不是目录")
	}
	return c, nil
}

func (h *handler) addMediaRoot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "path", "name")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := plugin.Require(h.c, RegisteredPerm); err != nil {
		fail(w, r, h.c, apiErr(errConflict, "%v", err))
		return
	}
	var p, name string
	if err := strField(raw, "path", "目录路径", &p, 1000); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := strField(raw, "name", "名称", &name, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	c, err := checkRootPath(p)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if name == "" {
		name = filepath.Base(c)
	}
	var n int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_media_roots WHERE path = ?`, c).Scan(&n); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n > 0 {
		fail(w, r, h.c, apiErr(errConflict, "这个目录已经登记过了"))
		return
	}
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_media_roots`).Scan(&n); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n >= 50 {
		fail(w, r, h.c, apiErr(errValidation, "最多登记 50 个素材目录"))
		return
	}
	mr := MediaRoot{ID: idgen.Prefixed("vmr"), Name: name, Path: c, CreatedAt: nowStr()}
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_media_roots (id, name, path, created_at) VALUES (?, ?, ?, ?)`, mr.ID, mr.Name, mr.Path, mr.CreatedAt); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.checkRoot(&mr, RegisteredPerm)
	writeJSON(w, http.StatusCreated, map[string]any{"data": mr})
}

func (h *handler) updateMediaRoot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "name")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	mr, err := h.mediaRoot(ctx, r.PathValue("id"), "")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if mr.Builtin {
		fail(w, r, h.c, apiErr(errValidation, "工程目录不能改名"))
		return
	}
	name := mr.Name
	if err := strField(raw, "name", "名称", &name, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if name == "" {
		fail(w, r, h.c, apiErr(errValidation, "名称不能为空"))
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_media_roots SET name = ? WHERE id = ?`, name, mr.ID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	mr.Name = name
	writeJSON(w, http.StatusOK, map[string]any{"data": mr})
}

// removeMediaRoot 只删登记，不动磁盘；分镜里引用它的 B-roll 留着，之后标缺失。
func (h *handler) removeMediaRoot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if id == ProjectRootID {
		fail(w, r, h.c, apiErr(errValidation, "工程目录不能移除"))
		return
	}
	res, err := h.c.Store().Exec(ctx, `DELETE FROM video_media_roots WHERE id = ?`, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, r, h.c, apiErr(errNotFound, "素材目录不存在"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

const (
	mediaPageSize = 60
	mediaPageMax  = 200
	// 搜索时最多走多少个目录项，防止在大目录树上卡住
	mediaWalkMax = 20000
)

// browseMedia 列一个目录里的图片和视频：?root=&video_id=&dir=&type=image|video&q=&page=&page_size=。
// 给了 q 时在 dir 下面（含子目录）按文件名找，不分大小写；文件按名字排，分页。
func (h *handler) browseMedia(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	mr, err := h.mediaRoot(ctx, q.Get("root"), q.Get("video_id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := mr.usable(); err != nil {
		fail(w, r, h.c, err)
		return
	}
	dir, err := mediaRel(q.Get("dir"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	kind := q.Get("type")
	if kind != "" && kind != "image" && kind != "video" {
		fail(w, r, h.c, apiErr(errValidation, "type 只能是 image、video"))
		return
	}
	page, size := 1, mediaPageSize
	for key, dst := range map[string]*int{"page": &page, "page_size": &size} {
		if s := q.Get(key); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 {
				fail(w, r, h.c, apiErr(errValidation, "%s 要是正整数", key))
				return
			}
			*dst = n
		}
	}
	size = min(size, mediaPageMax)
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))

	abs, err := resolveMedia(mr.Path, dir)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		fail(w, r, h.c, apiErr(errValidation, "%s 不是目录", dir))
		return
	}
	rroot, _ := filepath.EvalSymlinks(mr.Path)
	out := MediaListing{Root: mr, Dir: dir, Dirs: []MediaDir{}, Files: []MediaFile{}, Tools: h.tools()}
	if dir != "" {
		p := path.Dir(dir)
		if p == "." {
			p = ""
		}
		out.Parent = &p
	}
	type hit struct {
		rel string
		fi  os.FileInfo
	}
	var hits []hit
	if search == "" {
		entries, err := os.ReadDir(abs)
		if err != nil {
			fail(w, r, h.c, apiErr(errValidation, "目录读不了：%v", err))
			return
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			rel := path.Join(dir, name)
			fi, ok := statInside(rroot, filepath.Join(abs, name))
			if !ok {
				continue
			}
			if fi.IsDir() {
				out.Dirs = append(out.Dirs, MediaDir{Name: name, Path: rel})
				continue
			}
			if k := mediaKind(name); k != "" && (kind == "" || k == kind) && fi.Mode().IsRegular() {
				hits = append(hits, hit{rel, fi})
			}
		}
	} else {
		seen := 0
		_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if seen++; seen > mediaWalkMax {
				out.Truncated = true
				return filepath.SkipAll
			}
			if p != abs && strings.HasPrefix(d.Name(), ".") {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			// WalkDir 不跟符号链接进目录；文件链接要解开看在不在根里
			if d.IsDir() || !strings.Contains(strings.ToLower(d.Name()), search) {
				return nil
			}
			k := mediaKind(d.Name())
			if k == "" || (kind != "" && k != kind) {
				return nil
			}
			fi, ok := statInside(rroot, p)
			if !ok || !fi.Mode().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(rroot, p)
			if err != nil {
				return nil
			}
			hits = append(hits, hit{filepath.ToSlash(rel), fi})
			return nil
		})
	}
	sort.Slice(out.Dirs, func(i, j int) bool { return strings.ToLower(out.Dirs[i].Name) < strings.ToLower(out.Dirs[j].Name) })
	sort.Slice(hits, func(i, j int) bool { return strings.ToLower(hits[i].rel) < strings.ToLower(hits[j].rel) })
	total := len(hits)
	lo := min((page-1)*size, total)
	hi := min(lo+size, total)
	files := make([]MediaFile, hi-lo)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, x := range hits[lo:hi] {
		wg.Add(1)
		go func(i int, rel string, fi os.FileInfo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			files[i] = h.describe(ctx, filepath.Join(rroot, filepath.FromSlash(rel)), rel, fi, out.Tools)
		}(i, x.rel, x.fi)
	}
	wg.Wait()
	out.Files = files
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"total": total, "page": page, "page_size": size}})
}

// statInside 解开 p 的符号链接，还在根里才回文件信息。
func statInside(rroot, p string) (os.FileInfo, bool) {
	rp, err := filepath.EvalSymlinks(p)
	if err != nil || !within(rroot, rp) {
		return nil, false
	}
	fi, err := os.Stat(rp)
	if err != nil {
		return nil, false
	}
	return fi, true
}

// describe 填一个文件的信息：图片读文件头拿尺寸，视频有 ffprobe 时拿时长和尺寸。
func (h *handler) describe(ctx context.Context, abs, rel string, fi os.FileInfo, tools MediaTools) MediaFile {
	f := MediaFile{Name: path.Base(rel), Path: rel, Kind: mediaKind(rel), Size: fi.Size(), ModifiedAt: fi.ModTime().UTC().Format(time.RFC3339)}
	meta := h.probe(ctx, abs, fi, f.Kind, tools)
	f.Width, f.Height, f.Duration = meta.Width, meta.Height, meta.Duration
	f.Thumb = tools.Thumbs || (f.Kind == "image" && slices.Contains(webImageExts, strings.ToLower(filepath.Ext(rel))))
	return f
}

/* ---------- 媒体工具 ---------- */

type mediaMeta struct {
	Width    *int
	Height   *int
	Duration *float64
}

var (
	toolMu    sync.Mutex
	toolPaths = map[string]string{}
	// 元数据缓存：解析后的路径 + 大小 + 修改时间 -> 结果，进程内有效
	metaMu    sync.Mutex
	metaCache = map[string]mediaMeta{}
)

// findTool 先按 PATH 找，再试 Homebrew 的两个目录（launchd 起的进程 PATH 很短）；找不到回空串。结果记下来。
func findTool(name string) string {
	toolMu.Lock()
	defer toolMu.Unlock()
	if p, ok := toolPaths[name]; ok {
		return p
	}
	p, err := exec.LookPath(name)
	if err != nil {
		p = ""
		for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
			c := filepath.Join(dir, name)
			if st, err := os.Stat(c); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
				p = c
				break
			}
		}
	}
	toolPaths[name] = p
	return p
}

// tools 是这次能用的工具：要确认过 process:spawn，缩略图还要有缓存目录。
func (h *handler) tools() MediaTools {
	if !h.c.Granted("process:spawn") {
		return MediaTools{}
	}
	return MediaTools{Probe: findTool("ffprobe") != "", Thumbs: findTool("ffmpeg") != "" && h.c.CacheDir() != ""}
}

func metaKey(abs string, fi os.FileInfo) string {
	return abs + "\x00" + strconv.FormatInt(fi.Size(), 10) + "\x00" + strconv.FormatInt(fi.ModTime().UnixNano(), 10)
}

func (h *handler) probe(ctx context.Context, abs string, fi os.FileInfo, kind string, tools MediaTools) mediaMeta {
	key := metaKey(abs, fi)
	metaMu.Lock()
	m, ok := metaCache[key]
	metaMu.Unlock()
	if ok {
		return m
	}
	if kind == "image" {
		if f, err := os.Open(abs); err == nil {
			if c, _, err := image.DecodeConfig(f); err == nil {
				m.Width, m.Height = &c.Width, &c.Height
			}
			_ = f.Close()
		}
	}
	if (m.Width == nil || kind == "video") && tools.Probe {
		pm := ffprobe(ctx, abs)
		if m.Width == nil {
			m.Width, m.Height = pm.Width, pm.Height
		}
		if kind == "video" {
			m.Duration = pm.Duration
		}
	}
	metaMu.Lock()
	if len(metaCache) > 20000 {
		clear(metaCache)
	}
	metaCache[key] = m
	metaMu.Unlock()
	return m
}

// ffprobe 取第一路视频流的宽高和容器时长，失败回空。
func ffprobe(ctx context.Context, abs string) mediaMeta {
	bin := findTool("ffprobe")
	if bin == "" {
		return mediaMeta{}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
		"-of", "json", "--", abs).Output()
	if err != nil {
		return mediaMeta{}
	}
	var res struct {
		Streams []struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(out, &res) != nil {
		return mediaMeta{}
	}
	var m mediaMeta
	if len(res.Streams) > 0 && res.Streams[0].Width > 0 {
		w, hgt := res.Streams[0].Width, res.Streams[0].Height
		m.Width, m.Height = &w, &hgt
	}
	if d, err := strconv.ParseFloat(res.Format.Duration, 64); err == nil && d > 0 {
		d = float64(int(d*100+0.5)) / 100
		m.Duration = &d
	}
	return m
}

/* ---------- 原文件和缩略图 ---------- */

// mediaTarget 解析 ?root=&video_id=&path= 指的文件：素材目录可用、路径在根里、是图片或视频的普通文件。
func (h *handler) mediaTarget(r *http.Request) (abs string, fi os.FileInfo, err error) {
	q := r.URL.Query()
	mr, err := h.mediaRoot(r.Context(), q.Get("root"), q.Get("video_id"))
	if err != nil {
		return "", nil, err
	}
	if err := mr.usable(); err != nil {
		return "", nil, err
	}
	rel, err := mediaRel(q.Get("path"))
	if err != nil {
		return "", nil, err
	}
	if rel == "" {
		return "", nil, apiErr(errValidation, "path 必填，是相对素材目录的文件路径")
	}
	if mediaKind(rel) == "" {
		return "", nil, apiErr(errValidation, "只能预览图片和视频")
	}
	abs, err = resolveMedia(mr.Path, rel)
	if err != nil {
		return "", nil, err
	}
	fi, err = os.Stat(abs)
	if err != nil {
		return "", nil, apiErr(errNotFound, "%s 不在了", rel)
	}
	if !fi.Mode().IsRegular() {
		return "", nil, apiErr(errValidation, "不是普通文件")
	}
	return abs, fi, nil
}

// mediaFile 原样回图片原图、视频（http.ServeContent 支持 Range，视频能拖进度条）。只读打开，不改文件。
func (h *handler) mediaFile(w http.ResponseWriter, r *http.Request) {
	abs, fi, err := h.mediaTarget(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		fail(w, r, h.c, apiErr(errNotFound, "文件打不开：%v", err))
		return
	}
	defer f.Close()
	ext := strings.ToLower(filepath.Ext(abs))
	w.Header().Set("Content-Type", mediaMIME[ext])
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// thumbFlight 防止同一张缩略图被并发生成多次。
var thumbFlight sync.Map

// mediaThumb 回缩略图（JPEG，最长边 320）：有 ffmpeg 时生成并缓存；没有时浏览器能显示的图片回原图，别的 404。
func (h *handler) mediaThumb(w http.ResponseWriter, r *http.Request) {
	abs, fi, err := h.mediaTarget(r)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	tools := h.tools()
	if !tools.Thumbs {
		if mediaKind(abs) == "image" && slices.Contains(webImageExts, strings.ToLower(filepath.Ext(abs))) {
			h.mediaFile(w, r)
			return
		}
		fail(w, r, h.c, apiErr(errNotFound, "本机没有 ffmpeg（或没确认 process:spawn），视频没有缩略图"))
		return
	}
	sum := sha256.Sum256([]byte(metaKey(abs, fi)))
	name := hex.EncodeToString(sum[:16]) + ".jpg"
	dir := filepath.Join(h.c.CacheDir(), "thumbs", name[:2])
	out := filepath.Join(dir, name)
	if _, err := os.Stat(out); err != nil {
		mu, _ := thumbFlight.LoadOrStore(out, &sync.Mutex{})
		mu.(*sync.Mutex).Lock()
		if _, err := os.Stat(out); err != nil {
			err = makeThumb(r.Context(), abs, mediaKind(abs), dir, out)
			if err != nil {
				mu.(*sync.Mutex).Unlock()
				h.c.Log().Warn("video thumb", "path", abs, "err", err)
				fail(w, r, h.c, apiErr(errNotFound, "缩略图生成失败"))
				return
			}
		}
		mu.(*sync.Mutex).Unlock()
		thumbFlight.Delete(out)
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, out)
}

// makeThumb 用 ffmpeg 抽一帧（视频取 1 秒处，短于 1 秒的取第一帧）缩到最长边 320，先写临时文件再改名。
func makeThumb(ctx context.Context, abs, kind, dir, out string) error {
	bin := findTool("ffmpeg")
	if bin == "" {
		return errors.New("no ffmpeg")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := out + ".tmp.jpg"
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	scale := "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'"
	args := []string{"-hide_banner", "-loglevel", "error", "-y"}
	if kind == "video" {
		args = append(args, "-ss", "1")
	}
	args = append(args, "-i", abs, "-frames:v", "1", "-vf", scale, "-q:v", "5", tmp)
	if err := exec.CommandContext(ctx, bin, args...).Run(); err != nil || !nonEmpty(tmp) {
		if kind != "video" {
			_ = os.Remove(tmp)
			return fmt.Errorf("ffmpeg: %v", err)
		}
		// 短视频 1 秒处没有帧，退回第一帧
		args = []string{"-hide_banner", "-loglevel", "error", "-y", "-i", abs, "-frames:v", "1", "-vf", scale, "-q:v", "5", tmp}
		if err := exec.CommandContext(ctx, bin, args...).Run(); err != nil || !nonEmpty(tmp) {
			_ = os.Remove(tmp)
			return fmt.Errorf("ffmpeg: %v", err)
		}
	}
	return os.Rename(tmp, out)
}

func nonEmpty(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}
