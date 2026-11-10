// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// 稿件正文（VID-09a）：GET/PUT /api/video/artifacts/{id}/content 读写原文、口播稿、大纲的文件内容（同原型 ScriptText）。
// 正文就是视频工程目录里 Artifact.path 那个文件，读要 fs:read:project、写要 fs:write:project，只认工程目录内的路径
// （符号链接解析后也不能越出去）。升版本前把当前版本的文件另存到工程目录的 .versions/ 下，旧版本照样能读。

// TextKinds 是能在内容编写里直接写的产出物类型，同原型 TextKind。
var TextKinds = []string{"article", "script", "outline"}

// maxContent 是正文的大小上限。
const maxContent = 512 << 10

// versionsDir 是旧版本正文的存放目录，相对视频工程目录。
const versionsDir = ".versions"

// ArtifactContent 是一份正文。version 是读的第几版；exists 为 false 是文件还没写过（正文为空）；
// versions 是 .versions/ 里留着的旧版本号，从小到大。
type ArtifactContent struct {
	ArtifactID string `json:"artifact_id"`
	Version    int    `json:"version"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	Exists     bool   `json:"exists"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modified_at,omitempty"`
	Versions   []int  `json:"versions"`
}

// textFile 是一条文本产出物在磁盘上的位置。
type textFile struct {
	wd  string // 工程目录（绝对路径）
	rel string // 相对工程目录的路径
}

func (f textFile) abs() string { return filepath.Join(f.wd, filepath.FromSlash(f.rel)) }

// versionRel 是第 n 版的另存路径：.versions/<目录>/<文件名>.v<n><扩展名>。
func (f textFile) versionRel(n int) string {
	dir, base := path.Split(f.rel)
	ext := path.Ext(base)
	return path.Join(versionsDir, dir, strings.TrimSuffix(base, ext)+".v"+strconv.Itoa(n)+ext)
}

func (f textFile) versionAbs(n int) string {
	return filepath.Join(f.wd, filepath.FromSlash(f.versionRel(n)))
}

// textFileOf 校验产出物能不能读写正文，回它在工程目录里的位置。perm 是要的权限。
func (h *handler) textFileOf(ctx context.Context, a Artifact, perm string) (textFile, error) {
	if !slices.Contains(TextKinds, a.Kind) {
		return textFile{}, apiErr(errValidation, "只有原文、口播稿、大纲能读写正文，%s不行", kindLabel(a.Kind))
	}
	if !h.c.Granted(perm) {
		what := "读"
		if perm == "fs:write:project" {
			what = "写"
		}
		return textFile{}, apiErr(errValidation, "视频插件没有%s工程目录的权限（%s）", what, perm)
	}
	v, err := h.getVideo(ctx, a.VideoID)
	if err != nil {
		return textFile{}, err
	}
	wd, err := h.workdirOf(ctx, v)
	if err != nil {
		return textFile{}, apiErr(errValidation, "%v", err)
	}
	rel, err := cleanRelPath(a.Path)
	if err != nil {
		return textFile{}, err
	}
	if strings.HasSuffix(rel, "/") {
		return textFile{}, apiErr(errValidation, "路径 %s 是目录，不是文件", a.Path)
	}
	if rel == versionsDir || strings.HasPrefix(rel, versionsDir+"/") {
		return textFile{}, apiErr(errValidation, "路径不能放在 %s/ 下，那里存旧版本", versionsDir)
	}
	return textFile{wd: wd, rel: rel}, nil
}

// checkInside 看 p 解析符号链接后还在工程目录里：从 p 往上找第一个存在的路径解析，工程目录不存在时不算越界。
func checkInside(wd, p string) error {
	rwd, err := filepath.EvalSymlinks(wd)
	if err != nil {
		return nil
	}
	for cur := p; ; cur = filepath.Dir(cur) {
		rp, err := filepath.EvalSymlinks(cur)
		if err == nil {
			rel, err := filepath.Rel(rwd, rp)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return apiErr(errValidation, "路径越出了视频工程目录")
			}
			return nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return apiErr(errValidation, "路径读不了：%v", err)
		}
		if filepath.Dir(cur) == cur {
			return nil
		}
	}
}

// readText 读一个文本文件：不存在回 exists=false；不是普通文件、太大、不是 UTF-8 的 400。
func readText(wd, p string) (body string, exists bool, size int64, mod string, err error) {
	if err := checkInside(wd, p); err != nil {
		return "", false, 0, "", err
	}
	st, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, 0, "", nil
	}
	if err != nil {
		return "", false, 0, "", apiErr(errValidation, "文件读不了：%v", err)
	}
	if !st.Mode().IsRegular() {
		return "", false, 0, "", apiErr(errValidation, "不是普通文件")
	}
	if st.Size() > maxContent {
		return "", false, 0, "", apiErr(errValidation, "文件有 %d KB，超过 %d KB，不能在这里读写", st.Size()>>10, maxContent>>10)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", false, 0, "", apiErr(errValidation, "文件读不了：%v", err)
	}
	if !utf8.Valid(b) {
		return "", false, 0, "", apiErr(errValidation, "不是 UTF-8 文本文件")
	}
	return string(b), true, int64(len(b)), st.ModTime().UTC().Format(time.RFC3339), nil
}

// writeText 先写同目录的临时文件再改名，写一半不会留下半截正文。
func writeText(wd, p, body string) error {
	if err := checkInside(wd, p); err != nil {
		return err
	}
	if st, err := os.Lstat(p); err == nil && !st.Mode().IsRegular() && st.Mode()&fs.ModeSymlink == 0 {
		return apiErr(errValidation, "路径上已经有一个不是文件的东西")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return apiErr(errValidation, "建目录失败：%v", err)
	}
	// 建完目录再查一次：中间某级目录是指到外面的符号链接时拦下
	if err := checkInside(wd, filepath.Dir(p)); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*.tmp")
	if err != nil {
		return apiErr(errValidation, "写文件失败：%v", err)
	}
	_, werr := tmp.WriteString(body)
	cerr := tmp.Close()
	if werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp.Name(), p)
	}
	if werr != nil {
		_ = os.Remove(tmp.Name())
		return apiErr(errValidation, "写文件失败：%v", werr)
	}
	return nil
}

// archivedVersions 列 .versions/ 里留着的这个文件的旧版本号。
func (f textFile) archivedVersions() []int {
	out := []int{}
	dir, base := path.Split(f.rel)
	ext := path.Ext(base)
	prefix := strings.TrimSuffix(base, ext) + ".v"
	entries, err := os.ReadDir(filepath.Join(f.wd, versionsDir, filepath.FromSlash(dir)))
	if err != nil {
		return out
	}
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ext) {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, prefix), ext)); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

// archive 把当前文件另存成第 n 版；文件还没写过就不存。
func (f textFile) archive(n int) error {
	body, exists, _, _, err := readText(f.wd, f.abs())
	if err != nil || !exists {
		return err
	}
	return writeText(f.wd, f.versionAbs(n), body)
}

func (h *handler) loadContent(f textFile, a Artifact, version int) (ArtifactContent, error) {
	p, rel := f.abs(), f.rel
	if version != a.Version {
		p, rel = f.versionAbs(version), f.versionRel(version)
	}
	body, exists, size, mod, err := readText(f.wd, p)
	if err != nil {
		return ArtifactContent{}, err
	}
	if !exists && version != a.Version {
		return ArtifactContent{}, apiErr(errNotFound, "第 %d 版的正文没有留存", version)
	}
	return ArtifactContent{ArtifactID: a.ID, Version: version, Path: rel, Content: body, Exists: exists, Size: size, ModifiedAt: mod,
		Versions: f.archivedVersions()}, nil
}

func (h *handler) showContent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	version := a.Version
	if s := r.URL.Query().Get("version"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > a.Version {
			fail(w, r, h.c, apiErr(errValidation, "version 要是 1 到 %d 的整数", a.Version))
			return
		}
		version = n
	}
	f, err := h.textFileOf(ctx, a, "fs:read:project")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.loadContent(f, a, version)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// putContent 写正文。new_version 为 true 时存成下一版（同原型 saveText）：先把当前版本另存进 .versions/，
// 版本号加一、状态回到草稿、来源记成手写，再写新正文；否则原地改当前版本。from 给了要和当前版本一致。
func (h *handler) putContent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "content", "new_version", "from")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.getArtifact(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var body string
	if b, ok := raw["content"]; !ok || json.Unmarshal(b, &body) != nil {
		fail(w, r, h.c, apiErr(errValidation, "content 必填，是正文字符串"))
		return
	}
	if len(body) > maxContent {
		fail(w, r, h.c, apiErr(errValidation, "正文超过 %d KB", maxContent>>10))
		return
	}
	var bump bool
	if b, ok := raw["new_version"]; ok && !isNull(b) {
		if json.Unmarshal(b, &bump) != nil {
			fail(w, r, h.c, apiErr(errValidation, "new_version 必须是布尔值"))
			return
		}
	}
	from := a.Version
	if err := intField(raw, "from", "from", &from, 1, 9999); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if from != a.Version {
		fail(w, r, h.c, apiErr(errConflict, "已经是第 %d 版了，刷新后再操作", a.Version))
		return
	}
	if bump && strings.TrimSpace(body) == "" {
		fail(w, r, h.c, apiErr(errValidation, "稿子是空的，不能存成新版本"))
		return
	}
	if bump && a.Version >= 9999 {
		fail(w, r, h.c, apiErr(errConflict, "版本号到头了"))
		return
	}
	if !h.c.Granted("fs:read:project") {
		fail(w, r, h.c, apiErr(errValidation, "视频插件没有读工程目录的权限（fs:read:project）"))
		return
	}
	f, err := h.textFileOf(ctx, a, "fs:write:project")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := checkInside(f.wd, f.abs()); err != nil {
		fail(w, r, h.c, err)
		return
	}
	st := h.c.Store()
	now := nowStr()
	if bump {
		if err := f.archive(a.Version); err != nil {
			fail(w, r, h.c, err)
			return
		}
		res, err := st.Exec(ctx, `UPDATE video_artifacts SET version = version + 1, status = 'draft', source_type = 'manual', source_label = '手写',
			source_id = '', session_id = '', run_id = '', core_artifact_id = '', updated_at = ? WHERE id = ? AND version = ?`, now, a.ID, a.Version)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			fail(w, r, h.c, apiErr(errConflict, "刚被别处升过版本，刷新后再操作"))
			return
		}
	}
	if err := writeText(f.wd, f.abs(), body); err != nil {
		if bump {
			// 新正文没写上，版本号退回去
			_, _ = st.Exec(ctx, `UPDATE video_artifacts SET version = ?, status = ?, source_type = ?, source_label = ?, source_id = ?, session_id = ?,
				run_id = ?, core_artifact_id = ?, updated_at = ? WHERE id = ? AND version = ?`, a.Version, a.Status, a.Source.Type, a.Source.Label,
				a.Source.ID, a.Source.SessionID, a.Source.RunID, a.Source.ArtifactID, nowStr(), a.ID, a.Version+1)
		}
		fail(w, r, h.c, err)
		return
	}
	if !bump {
		if _, err := st.Exec(ctx, `UPDATE video_artifacts SET updated_at = ? WHERE id = ?`, now, a.ID); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if err := h.touchVideo(ctx, a.VideoID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	art, err := h.getArtifact(ctx, a.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	c, err := h.loadContent(f, art, art.Version)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"artifact": art, "content": c}})
}

// 按选题大纲起草（VID-09a，同原型 draftRun）：内容编写没配执行器时用技能「网页演示做视频」，提示词带上选题。

// draftRunner 是内容编写没配执行器时的默认执行器，同原型 scriptRunner。
var draftRunner = StageRunner{Stage: "script", Type: "skill", RefID: "sk_video", Prompt: "按 Phase 1 照选题的角度和大纲起草口播稿和大纲"}

// topicBrief 是交给执行器的选题：标题、角度、受众、大纲。没挂选题回空串；选题没写大纲回错误（记成起草失败）。
func (h *handler) topicBrief(ctx context.Context, v Video) (string, error) {
	if v.TopicID == nil {
		return "", nil
	}
	t, err := h.getTopic(ctx, *v.TopicID)
	if errors.Is(err, errNotFound) {
		return "", errors.New("这一集的选题被换掉或删掉了，重新选好再起草")
	}
	if err != nil {
		return "", err
	}
	title := t.Title
	if title == "" {
		title = "未命名选题"
	}
	if strings.TrimSpace(t.Outline) == "" {
		return "", fmt.Errorf("选题「%s」还没写大纲，Phase 1 要照大纲起草；先在选题里补上大纲再重试", title)
	}
	orDash := func(s string) string {
		if strings.TrimSpace(s) == "" {
			return "还没写"
		}
		return s
	}
	var b strings.Builder
	fmt.Fprintf(&b, "照这个选题起草：\n选题：%s\n切入角度：%s\n受众：%s\n大纲：\n%s\n", title, orDash(t.Angle), orDash(t.Audience), strings.TrimSpace(t.Outline))
	return b.String(), nil
}

// snapshotTexts 起草前把口播稿、大纲的当前版本另存进 .versions/，执行器跑完升版本后旧版本还能读、能对比。
// 尽力而为：没权限、目录不可用的跳过，只记日志。
func (h *handler) snapshotTexts(ctx context.Context, v Video) {
	if !h.c.Granted("fs:read:project") || !h.c.Granted("fs:write:project") {
		return
	}
	arts, err := h.loadArtifacts(ctx, `WHERE video_id = ? AND kind IN ('script', 'outline')`, v.ID)
	if err != nil {
		h.c.Log().Warn("video snapshot texts", "video", v.ID, "err", err)
		return
	}
	for _, a := range arts {
		f, err := h.textFileOf(ctx, a, "fs:write:project")
		if err != nil {
			continue
		}
		if err := f.archive(a.Version); err != nil {
			h.c.Log().Warn("video snapshot text", "artifact", a.ID, "err", err)
		}
	}
}
