// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 分镜（TSK-0456，同原型 storyboard.tsx 的 StoryboardDesk 和 storyboarddata.ts 的 Shot、Broll、shotsFromText）。
// 每期视频一份有序的分镜（video_shots），每个分镜挂若干 B-roll（video_shot_brolls，存素材目录 id 加相对路径）。
// 读的时候逐个检查 B-roll 的文件还在不在，不在的标 missing，不报错。素材目录、浏览见 media.go。

// SpeechRate 是口播语速（每分钟多少字），同原型 SPEECH_RATE。
const SpeechRate = 240

// Shot 是一个分镜。no 是序号（从 1 起）；duration 是手填的秒数，没填为 null，est 是按口播字数估的秒数。
type Shot struct {
	ID        string  `json:"id"`
	VideoID   string  `json:"video_id"`
	No        int     `json:"no"`
	Text      string  `json:"text"`
	Visual    string  `json:"visual"`
	Duration  *int    `json:"duration"`
	Est       int     `json:"est"`
	Brolls    []Broll `json:"brolls"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// Broll 是分镜里的一条素材。in、out 是视频的入点、出点（秒），没设为 null；missing 是文件找不到了（目录被移除、文件被移走或删掉）。
type Broll struct {
	ID        string   `json:"id"`
	ShotID    string   `json:"shot_id"`
	RootID    string   `json:"root_id"`
	Path      string   `json:"path"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Note      string   `json:"note"`
	In        *float64 `json:"in"`
	Out       *float64 `json:"out"`
	Missing   bool     `json:"missing"`
	CreatedAt string   `json:"created_at"`
}

const (
	maxShots       = 300
	maxBrollsShot  = 50
	maxShotText    = 5000
	maxShotVisual  = 1000
	maxBrollNote   = 500
	maxClipSeconds = 24 * 3600
)

func (h *handler) registerStoryboard(m plugin.RouteRegistrar) {
	m.HandleFunc("GET /api/video/videos/{id}/shots", h.listShots)
	m.HandleFunc("POST /api/video/videos/{id}/shots", h.addShot)
	m.HandleFunc("POST /api/video/videos/{id}/shots/reorder", h.reorderShots)
	m.HandleFunc("POST /api/video/videos/{id}/shots/generate", h.generateShots)
	m.HandleFunc("PATCH /api/video/shots/{id}", h.updateShot)
	m.HandleFunc("DELETE /api/video/shots/{id}", h.removeShot)
	m.HandleFunc("POST /api/video/shots/{id}/brolls", h.addBrolls)
	m.HandleFunc("POST /api/video/shots/{id}/brolls/reorder", h.reorderBrolls)
	m.HandleFunc("PATCH /api/video/brolls/{id}", h.updateBroll)
	m.HandleFunc("DELETE /api/video/brolls/{id}", h.removeBroll)
	h.registerMedia(m)
}

/* ---------- 估时长 ---------- */

var (
	mdFenceRe   = regexp.MustCompile("(?s)```.*?```")
	mdLinkRe    = regexp.MustCompile(`\]\([^)]*\)`)
	mdLeadRe    = regexp.MustCompile(`(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+`)
	mdMarkRe    = regexp.MustCompile("[*_`~\\[\\]#>|]")
	wordRe      = regexp.MustCompile(`[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*`)
	headingRe   = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	listMarkRe  = regexp.MustCompile(`^\s*(\d+[.、)]|[-*+])\s*`)
	blankLineRe = regexp.MustCompile(`\n\s*\n`)
)

// speechChars 同原型 textStats：去掉 Markdown 记号后，汉字一个算一个，英文按词。
func speechChars(md string) int {
	plain := mdFenceRe.ReplaceAllString(md, " ")
	plain = mdLinkRe.ReplaceAllString(plain, " ")
	plain = mdLeadRe.ReplaceAllString(plain, "")
	plain = mdMarkRe.ReplaceAllString(plain, " ")
	han := 0
	var rest strings.Builder
	for _, r := range plain {
		if unicode.Is(unicode.Han, r) {
			han++
			rest.WriteRune(' ')
		} else {
			rest.WriteRune(r)
		}
	}
	return han + len(wordRe.FindAllString(rest.String(), -1))
}

// estSeconds 按语速估口播时长（秒），有字时至少 1 秒。
func estSeconds(text string) int {
	n := speechChars(text)
	if n == 0 {
		return 0
	}
	return max(1, int(math.Round(float64(n)/SpeechRate*60)))
}

/* ---------- 读 ---------- */

func (h *handler) loadShots(ctx context.Context, v Video) ([]Shot, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT id, video_id, position, text, visual, duration, created_at, updated_at FROM video_shots
		WHERE video_id = ? ORDER BY position, rowid`, v.ID)
	if err != nil {
		return nil, err
	}
	out := []Shot{}
	idx := map[string]int{}
	for rows.Next() {
		var s Shot
		if err := rows.Scan(&s.ID, &s.VideoID, &s.No, &s.Text, &s.Visual, &s.Duration, &s.CreatedAt, &s.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		s.Est = estSeconds(s.Text)
		s.Brolls = []Broll{}
		idx[s.ID] = len(out)
		out = append(out, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	brows, err := h.c.Store().Query(ctx, `SELECT b.id, b.shot_id, b.root_id, b.path, b.kind, b.note, b.in_sec, b.out_sec, b.created_at
		FROM video_shot_brolls b JOIN video_shots s ON s.id = b.shot_id WHERE s.video_id = ? ORDER BY b.position, b.rowid`, v.ID)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	roots := map[string]string{} // root id -> 能用的绝对路径；用不了的是空串
	for brows.Next() {
		var b Broll
		if err := brows.Scan(&b.ID, &b.ShotID, &b.RootID, &b.Path, &b.Kind, &b.Note, &b.In, &b.Out, &b.CreatedAt); err != nil {
			return nil, err
		}
		b.Name = path.Base(b.Path)
		rp, ok := roots[b.RootID]
		if !ok {
			rp = h.rootPathFor(ctx, b.RootID, v)
			roots[b.RootID] = rp
		}
		b.Missing = rp == "" || !brollExists(rp, b.Path)
		if i, ok := idx[b.ShotID]; ok {
			out[i].Brolls = append(out[i].Brolls, b)
		}
	}
	return out, brows.Err()
}

// rootPathFor 回素材目录能用时的绝对路径，用不了（移除了、没权限、不在了）回空串。
func (h *handler) rootPathFor(ctx context.Context, id string, v Video) string {
	var mr MediaRoot
	if id == ProjectRootID {
		mr = h.projectRoot(ctx, v)
	} else {
		var err error
		if mr, err = h.mediaRoot(ctx, id, ""); err != nil {
			return ""
		}
	}
	if !mr.Available {
		return ""
	}
	return mr.Path
}

func brollExists(root, rel string) bool {
	clean, err := mediaRel(rel)
	if err != nil || clean == "" {
		return false
	}
	abs, err := resolveMedia(root, clean)
	if err != nil {
		return false
	}
	st, err := os.Stat(abs)
	return err == nil && st.Mode().IsRegular()
}

func (h *handler) shotsOf(ctx context.Context, videoID string) (Video, []Shot, error) {
	v, err := h.getVideo(ctx, videoID)
	if err != nil {
		return Video{}, nil, err
	}
	xs, err := h.loadShots(ctx, v)
	return v, xs, err
}

func (h *handler) writeShots(w http.ResponseWriter, r *http.Request, status int, videoID string) {
	_, xs, err := h.shotsOf(r.Context(), videoID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": xs, "meta": map[string]any{"total": len(xs)}})
}

// shotVideo 回分镜所属的视频 id。
func (h *handler) shotVideo(ctx context.Context, shotID string) (string, error) {
	var vid string
	err := h.c.Store().QueryRow(ctx, `SELECT video_id FROM video_shots WHERE id = ?`, shotID).Scan(&vid)
	if errors.Is(err, plugin.ErrNoRows) {
		return "", apiErr(errNotFound, "分镜不存在")
	}
	return vid, err
}

func (h *handler) listShots(w http.ResponseWriter, r *http.Request) {
	h.writeShots(w, r, http.StatusOK, r.PathValue("id"))
}

// 写完回整份分镜（序号、缺失都是现算的），前端整份换进缓存。

func shotFields(raw map[string]json.RawMessage, text, visual *string, dur **int) error {
	if err := strField(raw, "text", "口播段落", text, maxShotText); err != nil {
		return err
	}
	if err := strField(raw, "visual", "画面说明", visual, maxShotVisual); err != nil {
		return err
	}
	if v, ok := raw["duration"]; ok {
		if isNull(v) {
			*dur = nil
		} else {
			var n int
			if err := json.Unmarshal(v, &n); err != nil || n < 1 || n > 3600 {
				return apiErr(errValidation, "时长要是 1 到 3600 的整数秒，传 null 按口播字数估")
			}
			*dur = &n
		}
	}
	return nil
}

// renumber 把这一集的分镜序号重排成 1..n（删了中间的以后）。
func (h *handler) renumber(ctx context.Context, videoID string) error {
	_, err := h.c.Store().Exec(ctx, `UPDATE video_shots SET position = (SELECT COUNT(*) FROM video_shots s2 WHERE s2.video_id = video_shots.video_id
		AND (s2.position < video_shots.position OR (s2.position = video_shots.position AND s2.rowid <= video_shots.rowid))) WHERE video_id = ?`, videoID)
	return err
}

func (h *handler) countShots(ctx context.Context, videoID string) (int, error) {
	var n int
	err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_shots WHERE video_id = ?`, videoID).Scan(&n)
	return n, err
}

// addShot：{text?, visual?, duration?, position?}，position 是插到第几个（从 1 起），不给放最后。
func (h *handler) addShot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "text", "visual", "duration", "position")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v, err := h.getVideo(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	n, err := h.countShots(ctx, v.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if n >= maxShots {
		fail(w, r, h.c, apiErr(errValidation, "一集最多 %d 个分镜", maxShots))
		return
	}
	var text, visual string
	var dur *int
	if err := shotFields(raw, &text, &visual, &dur); err != nil {
		fail(w, r, h.c, err)
		return
	}
	pos := n + 1
	if err := intField(raw, "position", "position", &pos, 1, n+1); err != nil {
		fail(w, r, h.c, err)
		return
	}
	st := h.c.Store()
	if _, err := st.Exec(ctx, `UPDATE video_shots SET position = position + 1 WHERE video_id = ? AND position >= ?`, v.ID, pos); err != nil {
		fail(w, r, h.c, err)
		return
	}
	now := nowStr()
	id := idgen.Prefixed("vsh")
	if _, err := st.Exec(ctx, `INSERT INTO video_shots (id, video_id, position, text, visual, duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, v.ID, pos, text, visual, dur, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusCreated, v.ID)
}

func (h *handler) updateShot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "text", "visual", "duration")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	id := r.PathValue("id")
	var s Shot
	err = h.c.Store().QueryRow(ctx, `SELECT video_id, text, visual, duration FROM video_shots WHERE id = ?`, id).Scan(&s.VideoID, &s.Text, &s.Visual, &s.Duration)
	if errors.Is(err, plugin.ErrNoRows) {
		fail(w, r, h.c, apiErr(errNotFound, "分镜不存在"))
		return
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := shotFields(raw, &s.Text, &s.Visual, &s.Duration); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_shots SET text = ?, visual = ?, duration = ?, updated_at = ? WHERE id = ?`,
		s.Text, s.Visual, s.Duration, nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, s.VideoID)
}

func (h *handler) removeShot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	vid, err := h.shotVideo(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_shots WHERE id = ?`, r.PathValue("id")); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.renumber(ctx, vid); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, vid)
}

// readIDs 读 {ids}：要正好是 have 里的每个各一次。
func readIDs(r *http.Request, have []string, what string) ([]string, error) {
	raw, err := readBody(r, "ids")
	if err != nil {
		return nil, err
	}
	var ids []string
	if b, ok := raw["ids"]; !ok || json.Unmarshal(b, &ids) != nil {
		return nil, apiErr(errValidation, "ids 必填，是%s id 的数组", what)
	}
	if len(ids) != len(have) {
		return nil, apiErr(errValidation, "ids 要正好列出全部 %d 个%s，各一次", len(have), what)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] || !slices.Contains(have, id) {
			return nil, apiErr(errValidation, "ids 要正好列出全部 %d 个%s，各一次", len(have), what)
		}
		seen[id] = true
	}
	return ids, nil
}

func (h *handler) reorderShots(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	_, xs, err := h.shotsOf(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	have := make([]string, len(xs))
	for i, s := range xs {
		have[i] = s.ID
	}
	ids, err := readIDs(r, have, "分镜")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	b, _ := json.Marshal(ids)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_shots SET position = (SELECT CAST(key AS INTEGER) + 1 FROM json_each(?) WHERE value = video_shots.id),
		updated_at = ? WHERE video_id = ?`, string(b), nowStr(), r.PathValue("id")); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, r.PathValue("id"))
}

/* ---------- 从口播稿生成 ---------- */

// shotDraft 是生成的一个分镜：text 是口播段落，visual 是画面说明（按标题拆时是标题）。
type shotDraft struct {
	Text   string
	Visual string
}

// shotsFromText 同原型 shotsFromText：有标题的按标题拆，一个标题一个分镜（标题当画面说明，下面的正文当口播段落；
// 只有一个一级标题当总标题、下面没正文的跳过）；没有标题的按空行分段，一段一个分镜。列表记号去掉。
func shotsFromText(md string) []shotDraft {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	lines := strings.Split(md, "\n")
	type sec struct {
		level int
		title string
		body  []string
	}
	var secs []sec
	hasHeading := false
	inFence := false
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			inFence = !inFence
			continue
		}
		if !inFence {
			if m := headingRe.FindStringSubmatch(strings.TrimRight(l, " \t")); m != nil {
				hasHeading = true
				secs = append(secs, sec{level: len(m[1]), title: strings.TrimSpace(strings.Trim(m[2], "# "))})
				continue
			}
		}
		if len(secs) == 0 {
			secs = append(secs, sec{})
		}
		secs[len(secs)-1].body = append(secs[len(secs)-1].body, l)
	}
	clean := func(body []string) string {
		var out []string
		for _, l := range body {
			l = strings.TrimSpace(listMarkRe.ReplaceAllString(l, ""))
			out = append(out, l)
		}
		return strings.TrimSpace(blankLineRe.ReplaceAllString(strings.Join(out, "\n"), "\n\n"))
	}
	var out []shotDraft
	if !hasHeading {
		var body []string
		for _, x := range secs {
			body = append(body, x.body...)
		}
		for _, p := range blankLineRe.Split(clean(body), -1) {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, shotDraft{Text: p})
			}
		}
		return out
	}
	for i, s := range secs {
		text := clean(s.body)
		if text == "" && (s.title == "" || (s.level == 1 && len(secs) > i+1)) {
			continue
		}
		out = append(out, shotDraft{Text: text, Visual: s.title})
	}
	return out
}

// generateShots：{mode?, source?, variant?}。从当前口播稿（没有就用大纲）按标题或段落生成分镜初稿。
// 已经有分镜时 mode 必填：append 追加在后面，replace 覆盖（先写新的再删旧的，B-roll 跟着旧分镜一起删）；没填 409。
func (h *handler) generateShots(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "mode", "source", "variant")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var mode, source, variant string
	for _, f := range []struct {
		key, label string
		dst        *string
		ok         []string
	}{{"mode", "mode", &mode, []string{"", "append", "replace"}}, {"source", "source", &source, []string{"", "script", "outline"}},
		{"variant", "variant", &variant, append([]string{""}, Orients...)}} {
		if err := strField(raw, f.key, f.label, f.dst, 20); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if !slices.Contains(f.ok, *f.dst) {
			fail(w, r, h.c, apiErr(errValidation, "%s 只能是 %s", f.label, strings.Join(f.ok[1:], "、")))
			return
		}
	}
	v, old, err := h.shotsOf(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if len(old) > 0 && mode == "" {
		fail(w, r, h.c, apiErr(errConflict, "已经有 %d 个分镜，选追加还是覆盖", len(old)))
		return
	}
	art, body, err := h.storyboardSource(ctx, v, source, variant)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	drafts := shotsFromText(body)
	if len(drafts) == 0 {
		fail(w, r, h.c, apiErr(errValidation, "%s v%d 里没有能拆成分镜的段落", kindLabel(art.Kind), art.Version))
		return
	}
	base := 0
	if mode == "append" {
		base = len(old)
	}
	if base+len(drafts) > maxShots {
		fail(w, r, h.c, apiErr(errValidation, "一集最多 %d 个分镜，生成出 %d 个，放不下", maxShots, len(drafts)))
		return
	}
	now := nowStr()
	var q strings.Builder
	args := []any{}
	q.WriteString(`INSERT INTO video_shots (id, video_id, position, text, visual, duration, created_at, updated_at) VALUES `)
	for i, d := range drafts {
		if i > 0 {
			q.WriteString(", ")
		}
		q.WriteString("(?, ?, ?, ?, ?, NULL, ?, ?)")
		text, visual := []rune(d.Text), []rune(d.Visual)
		args = append(args, idgen.Prefixed("vsh"), v.ID, base+i+1, string(text[:min(len(text), maxShotText)]), string(visual[:min(len(visual), maxShotVisual)]), now, now)
	}
	if mode == "replace" {
		// 新的先放到旧的后面，写成功再删旧的、重排序号：中途失败旧分镜还在
		for i := range drafts {
			args[i*7+2] = len(old) + i + 1
		}
	}
	if _, err := h.c.Store().Exec(ctx, q.String(), args...); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if mode == "replace" && len(old) > 0 {
		ids := make([]string, len(old))
		for i, s := range old {
			ids[i] = s.ID
		}
		b, _ := json.Marshal(ids)
		if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_shots WHERE id IN (SELECT value FROM json_each(?))`, string(b)); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if err := h.renumber(ctx, v.ID); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	xs, err := h.loadShots(ctx, v)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"shots": xs, "added": len(drafts),
		"source": map[string]any{"artifact_id": art.ID, "kind": art.Kind, "variant": art.Variant, "version": art.Version},
	}})
}

// storyboardSource 找生成分镜用的稿子：source 不给时先口播稿后大纲；variant 不给时取本集第一个比例（没定按横屏），
// 这个比例没有的再取别的比例。正文是当前版本的文件，空的跳过。
func (h *handler) storyboardSource(ctx context.Context, v Video, source, variant string) (Artifact, string, error) {
	if !h.c.Granted("fs:read:project") {
		return Artifact{}, "", apiErr(errValidation, "视频插件没有读工程目录的权限（fs:read:project）")
	}
	kinds := []string{"script", "outline"}
	if source != "" {
		kinds = []string{source}
	}
	if variant == "" {
		variant = "landscape"
		for _, o := range Orients {
			if slices.Contains(v.Orientations, o) {
				variant = o
				break
			}
		}
	}
	arts, err := h.loadArtifacts(ctx, `WHERE video_id = ? AND kind IN ('script', 'outline')`, v.ID)
	if err != nil {
		return Artifact{}, "", err
	}
	var lastErr error
	for _, k := range kinds {
		var cands []Artifact
		for _, a := range arts {
			if a.Kind == k {
				cands = append(cands, a)
			}
		}
		// 指定比例的排前面，同比例的新版本在前
		slices.SortStableFunc(cands, func(a, b Artifact) int {
			ra, rb := a.Variant != variant, b.Variant != variant
			if ra != rb {
				if ra {
					return 1
				}
				return -1
			}
			return b.Version - a.Version
		})
		for _, a := range cands {
			f, err := h.textFileOf(ctx, a, "fs:read:project")
			if err != nil {
				lastErr = err
				continue
			}
			c, err := h.loadContent(f, a, a.Version)
			if err != nil {
				lastErr = err
				continue
			}
			if strings.TrimSpace(c.Content) != "" {
				return a, c.Content, nil
			}
		}
	}
	if lastErr != nil {
		return Artifact{}, "", lastErr
	}
	what := "口播稿和大纲"
	if source != "" {
		what = kindLabel(source)
	}
	return Artifact{}, "", apiErr(errValidation, "这一集还没有写好的%s，先在内容编写里写稿再生成分镜", what)
}

/* ---------- B-roll ---------- */

// addBrolls：{items: [{root_id, path}], position?}。加到分镜的 B-roll 后面（position 给了插到第几个），
// 每个文件要在素材目录里、是图片或视频；已经在这个分镜里的跳过。回整份分镜。
func (h *handler) addBrolls(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "items", "position")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	shotID := r.PathValue("id")
	vid, err := h.shotVideo(ctx, shotID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var items []struct {
		RootID string `json:"root_id"`
		Path   string `json:"path"`
	}
	if b, ok := raw["items"]; !ok || json.Unmarshal(b, &items) != nil || len(items) == 0 {
		fail(w, r, h.c, apiErr(errValidation, "items 必填，是 {root_id, path} 的数组，至少一个"))
		return
	}
	var existing []string
	rows, err := h.c.Store().Query(ctx, `SELECT root_id || char(0) || path FROM video_shot_brolls WHERE shot_id = ?`, shotID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			fail(w, r, h.c, err)
			return
		}
		existing = append(existing, k)
	}
	rows.Close()
	type add struct{ root, rel, kind string }
	var adds []add
	roots := map[string]MediaRoot{}
	for _, it := range items {
		mr, ok := roots[it.RootID]
		if !ok {
			if mr, err = h.mediaRoot(ctx, it.RootID, vid); err != nil {
				fail(w, r, h.c, err)
				return
			}
			if err := mr.usable(); err != nil {
				fail(w, r, h.c, err)
				return
			}
			roots[it.RootID] = mr
		}
		rel, err := mediaRel(it.Path)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		kind := mediaKind(rel)
		if rel == "" || kind == "" {
			fail(w, r, h.c, apiErr(errValidation, "%s 不是图片或视频", it.Path))
			return
		}
		abs, err := resolveMedia(mr.Path, rel)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if st, err := os.Stat(abs); err != nil || !st.Mode().IsRegular() {
			fail(w, r, h.c, apiErr(errValidation, "%s 不是文件", rel))
			return
		}
		key := it.RootID + "\x00" + rel
		if slices.Contains(existing, key) {
			continue
		}
		existing = append(existing, key)
		adds = append(adds, add{it.RootID, rel, kind})
	}
	if len(existing) > maxBrollsShot {
		fail(w, r, h.c, apiErr(errValidation, "一个分镜最多 %d 条 B-roll", maxBrollsShot))
		return
	}
	n := len(existing) - len(adds)
	pos := n + 1
	if err := intField(raw, "position", "position", &pos, 1, n+1); err != nil {
		fail(w, r, h.c, err)
		return
	}
	st := h.c.Store()
	if len(adds) > 0 {
		if _, err := st.Exec(ctx, `UPDATE video_shot_brolls SET position = position + ? WHERE shot_id = ? AND position >= ?`, len(adds), shotID, pos); err != nil {
			fail(w, r, h.c, err)
			return
		}
		now := nowStr()
		var q strings.Builder
		args := []any{}
		q.WriteString(`INSERT INTO video_shot_brolls (id, shot_id, position, root_id, path, kind, note, in_sec, out_sec, created_at, updated_at) VALUES `)
		for i, a := range adds {
			if i > 0 {
				q.WriteString(", ")
			}
			q.WriteString("(?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?)")
			args = append(args, idgen.Prefixed("vbr"), shotID, pos+i, a.root, a.rel, a.kind, now, now)
		}
		if _, err := st.Exec(ctx, q.String(), args...); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if _, err := st.Exec(ctx, `UPDATE video_shots SET updated_at = ? WHERE id = ?`, now, shotID); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	h.writeShots(w, r, http.StatusOK, vid)
}

func (h *handler) brollShot(ctx context.Context, id string) (shotID, videoID, kind string, in, out *float64, err error) {
	err = h.c.Store().QueryRow(ctx, `SELECT b.shot_id, s.video_id, b.kind, b.in_sec, b.out_sec FROM video_shot_brolls b JOIN video_shots s ON s.id = b.shot_id
		WHERE b.id = ?`, id).Scan(&shotID, &videoID, &kind, &in, &out)
	if errors.Is(err, plugin.ErrNoRows) {
		err = apiErr(errNotFound, "B-roll 不存在")
	}
	return
}

func secField(raw map[string]json.RawMessage, key, label string, dst **float64) error {
	v, ok := raw[key]
	if !ok {
		return nil
	}
	if isNull(v) {
		*dst = nil
		return nil
	}
	var f float64
	if err := json.Unmarshal(v, &f); err != nil || f < 0 || f > maxClipSeconds || math.IsNaN(f) {
		return apiErr(errValidation, "%s要是 0 到 %d 之间的秒数，传 null 清掉", label, maxClipSeconds)
	}
	f = math.Round(f*100) / 100
	*dst = &f
	return nil
}

// updateBroll：{note?, in?, out?, shot_id?}。in、out 只有视频能设，出点要晚于入点；shot_id 是挪到同一集的另一个分镜（放最后）。
func (h *handler) updateBroll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "note", "in", "out", "shot_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	id := r.PathValue("id")
	shotID, vid, kind, in, out, err := h.brollShot(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var note string
	if err := h.c.Store().QueryRow(ctx, `SELECT note FROM video_shot_brolls WHERE id = ?`, id).Scan(&note); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := strField(raw, "note", "备注", &note, maxBrollNote); err != nil {
		fail(w, r, h.c, err)
		return
	}
	_, hasIn := raw["in"]
	_, hasOut := raw["out"]
	if (hasIn || hasOut) && kind != "video" {
		fail(w, r, h.c, apiErr(errValidation, "图片没有入点、出点"))
		return
	}
	if err := secField(raw, "in", "入点", &in); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := secField(raw, "out", "出点", &out); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if in != nil && out != nil && *out <= *in {
		fail(w, r, h.c, apiErr(errValidation, "出点要晚于入点"))
		return
	}
	target := shotID
	if err := strField(raw, "shot_id", "shot_id", &target, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	st := h.c.Store()
	now := nowStr()
	if target != shotID {
		tv, err := h.shotVideo(ctx, target)
		if err != nil || tv != vid {
			fail(w, r, h.c, apiErr(errValidation, "只能挪到同一集的分镜"))
			return
		}
		var n int
		if err := st.QueryRow(ctx, `SELECT COUNT(*) FROM video_shot_brolls WHERE shot_id = ?`, target).Scan(&n); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if n >= maxBrollsShot {
			fail(w, r, h.c, apiErr(errValidation, "一个分镜最多 %d 条 B-roll", maxBrollsShot))
			return
		}
		if _, err := st.Exec(ctx, `UPDATE video_shot_brolls SET shot_id = ?, position = ? WHERE id = ?`, target, n+1, id); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if err := h.renumberBrolls(ctx, shotID); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if _, err := st.Exec(ctx, `UPDATE video_shot_brolls SET note = ?, in_sec = ?, out_sec = ?, updated_at = ? WHERE id = ?`, note, in, out, now, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, vid)
}

func (h *handler) renumberBrolls(ctx context.Context, shotID string) error {
	_, err := h.c.Store().Exec(ctx, `UPDATE video_shot_brolls SET position = (SELECT COUNT(*) FROM video_shot_brolls b2 WHERE b2.shot_id = video_shot_brolls.shot_id
		AND (b2.position < video_shot_brolls.position OR (b2.position = video_shot_brolls.position AND b2.rowid <= video_shot_brolls.rowid))) WHERE shot_id = ?`, shotID)
	return err
}

// removeBroll 只删分镜里的这一条，不动原文件。
func (h *handler) removeBroll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shotID, vid, _, _, _, err := h.brollShot(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_shot_brolls WHERE id = ?`, r.PathValue("id")); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.renumberBrolls(ctx, shotID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, vid)
}

func (h *handler) reorderBrolls(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shotID := r.PathValue("id")
	vid, err := h.shotVideo(ctx, shotID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	rows, err := h.c.Store().Query(ctx, `SELECT id FROM video_shot_brolls WHERE shot_id = ?`, shotID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var have []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			fail(w, r, h.c, err)
			return
		}
		have = append(have, id)
	}
	rows.Close()
	ids, err := readIDs(r, have, "B-roll")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	b, _ := json.Marshal(ids)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_shot_brolls SET position = (SELECT CAST(key AS INTEGER) + 1 FROM json_each(?) WHERE value = video_shot_brolls.id)
		WHERE shot_id = ?`, string(b), shotID); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeShots(w, r, http.StatusOK, vid)
}
