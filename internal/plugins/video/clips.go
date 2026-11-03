package video

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 素材：表 video_clips，接口 /api/video/clips（VID-08a）。
// 现在只能手动收进来，拉热榜、收评论接内容平台是 VID-04 起的事。
// 来源可追溯：评论带 publish_id（发布记录），IM 消息带 message_id（im 插件的消息，只存不查）。

// ClipKinds 同原型 CLIP_KIND。
var ClipKinds = []string{"link", "note", "trend", "comment", "competitor", "im"}

// Clip 同原型 Clip，多 publish_id、message_id 和 updated_at；url、heat、publish_id、message_id 没有就不返回。
type Clip struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	URL       string   `json:"url,omitempty"`
	Source    string   `json:"source"`
	Heat      *int64   `json:"heat,omitempty"`
	Tags      []string `json:"tags"`
	Starred   bool     `json:"starred"`
	TopicIDs  []string `json:"topic_ids"`
	Triaged   bool     `json:"triaged"`
	PublishID *string  `json:"publish_id,omitempty"`
	MessageID string   `json:"message_id,omitempty"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

const clipCols = `id, kind, title, content, url, source, heat, tag_list, starred, triaged, publish_id, message_id, created_at, updated_at`

var clipFields = []string{"kind", "title", "content", "url", "source", "heat", "tags", "starred", "triaged", "publish_id", "message_id"}

var messageIDRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,100}$`)

func scanClip(row plugin.Row) (Clip, error) {
	var c Clip
	var tags string
	var starred, triaged int
	if err := row.Scan(&c.ID, &c.Kind, &c.Title, &c.Content, &c.URL, &c.Source, &c.Heat, &tags, &starred, &triaged, &c.PublishID,
		&c.MessageID, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return Clip{}, err
	}
	c.Tags, c.Starred, c.Triaged, c.TopicIDs = jsonStrings(tags), starred == 1, triaged == 1, []string{}
	return c, nil
}

// loadClips 按收进来的时间倒序（同原型收件箱，新的在上）。
func (h *handler) loadClips(ctx context.Context, where string, args ...any) ([]Clip, error) {
	rows, err := h.c.Store().Query(ctx, `SELECT `+clipCols+` FROM video_clips `+where+` ORDER BY created_at DESC, rowid DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Clip{}
	idx := map[string]int{}
	for rows.Next() {
		c, err := scanClip(rows)
		if err != nil {
			return nil, err
		}
		idx[c.ID] = len(out)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	q, qargs := `SELECT clip_id, topic_id FROM video_topic_clips`, []any{}
	if len(out) == 1 {
		q, qargs = q+` WHERE clip_id = ?`, []any{out[0].ID}
	}
	lrows, err := h.c.Store().Query(ctx, q+` ORDER BY at, rowid`, qargs...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		var cid, tid string
		if err := lrows.Scan(&cid, &tid); err != nil {
			return nil, err
		}
		if i, ok := idx[cid]; ok {
			out[i].TopicIDs = append(out[i].TopicIDs, tid)
		}
	}
	return out, lrows.Err()
}

func (h *handler) getClip(ctx context.Context, id string) (Clip, error) {
	xs, err := h.loadClips(ctx, `WHERE id = ?`, id)
	if err != nil {
		return Clip{}, err
	}
	if len(xs) == 0 {
		return Clip{}, apiErr(errNotFound, "素材不存在")
	}
	return xs[0], nil
}

// listClips：box 是 todo（待整理）/ starred（收藏）/ all，同原型收件箱三栏；meta.todo 是全部待整理的条数（红点用）。
func (h *handler) listClips(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var conds []string
	var args []any
	q := r.URL.Query()
	switch q.Get("box") {
	case "", "all":
	case "todo":
		conds = append(conds, "triaged = 0")
	case "starred":
		conds = append(conds, "starred = 1")
	default:
		fail(w, r, h.c, apiErr(errValidation, "box 只能是 todo、starred、all"))
		return
	}
	if s := q.Get("kind"); s != "" {
		if !slices.Contains(ClipKinds, s) {
			fail(w, r, h.c, apiErr(errValidation, "kind 只能是 %s", strings.Join(ClipKinds, "、")))
			return
		}
		conds, args = append(conds, "kind = ?"), append(args, s)
	}
	for _, k := range []string{"publish_id", "message_id"} {
		if s := q.Get(k); s != "" {
			conds, args = append(conds, k+" = ?"), append(args, s)
		}
	}
	if s := q.Get("topic_id"); s != "" {
		conds, args = append(conds, "id IN (SELECT clip_id FROM video_topic_clips WHERE topic_id = ?)"), append(args, s)
	}
	// 搜标题、内容、来源、标签，同原型
	if s := strings.ToLower(strings.TrimSpace(q.Get("q"))); s != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s) + "%"
		conds = append(conds, `lower(title || ' ' || content || ' ' || source || ' ' || tag_list) LIKE ? ESCAPE '\'`)
		args = append(args, like)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	out, err := h.loadClips(ctx, where, args...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var todo int
	if err := h.c.Store().QueryRow(ctx, `SELECT COUNT(*) FROM video_clips WHERE triaged = 0`).Scan(&todo); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out), "todo": todo}})
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (h *handler) showClip(w http.ResponseWriter, r *http.Request) {
	c, err := h.getClip(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": c})
}

func boolField(raw map[string]json.RawMessage, key string, dst *bool) error {
	b, ok := raw[key]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(b, dst); err != nil || isNull(b) {
		return apiErr(errValidation, "%s 必须是布尔值", key)
	}
	return nil
}

// applyClip 写可改的字段：标题、内容、链接、来源、热度、标签、收藏、已整理。
func applyClip(c *Clip, raw map[string]json.RawMessage) error {
	for _, f := range []struct {
		key, label string
		dst        *string
		limit      int
	}{
		{"title", "标题", &c.Title, 200},
		{"content", "内容", &c.Content, 5000},
		{"url", "链接", &c.URL, 2000},
		{"source", "来源", &c.Source, 200},
	} {
		if b, ok := raw[f.key]; ok && isNull(b) {
			*f.dst = ""
			continue
		}
		if err := strField(raw, f.key, f.label, f.dst, f.limit); err != nil {
			return err
		}
	}
	if c.URL != "" && !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		return apiErr(errValidation, "链接要是 http:// 或 https:// 开头")
	}
	if b, ok := raw["heat"]; ok {
		if isNull(b) {
			c.Heat = nil
		} else {
			var n int64
			if err := json.Unmarshal(b, &n); err != nil || n < 0 || n > 1e12 {
				return apiErr(errValidation, "热度要是非负整数")
			}
			c.Heat = &n
		}
	}
	if err := tagsField(raw, "tags", &c.Tags); err != nil {
		return err
	}
	if err := boolField(raw, "starred", &c.Starred); err != nil {
		return err
	}
	return boolField(raw, "triaged", &c.Triaged)
}

// clipTitle：没给标题时同原型「收进来」：网址取去掉协议的前 60 字，否则取内容前 40 字。
func clipTitle(c Clip) string {
	cut := func(s string, n int) string {
		if r := []rune(s); len(r) > n {
			return string(r[:n])
		}
		return s
	}
	if c.URL != "" {
		return cut(strings.TrimPrefix(strings.TrimPrefix(c.URL, "https://"), "http://"), 60)
	}
	return cut(strings.TrimSpace(c.Content), 40)
}

func (h *handler) addClip(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, clipFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	c := Clip{Tags: []string{}, TopicIDs: []string{}}
	if _, ok := raw["kind"]; !ok {
		fail(w, r, h.c, apiErr(errValidation, "kind 必填"))
		return
	}
	if err := enumField(raw, "kind", "kind", &c.Kind, ClipKinds); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := applyClip(&c, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if c.Title == "" {
		c.Title = clipTitle(c)
	}
	if c.Title == "" {
		fail(w, r, h.c, apiErr(errValidation, "标题、内容、链接至少给一个"))
		return
	}
	if c.Source == "" {
		c.Source = "手动添加"
	}
	if b, ok := raw["publish_id"]; ok {
		id, err := optID(b, "publish_id")
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if id != nil {
			if c.Kind != "comment" {
				fail(w, r, h.c, apiErr(errValidation, "只有评论能带 publish_id"))
				return
			}
			if _, err := h.getPublish(ctx, *id); err != nil {
				if errors.Is(err, errNotFound) {
					err = apiErr(errValidation, "发布记录不存在")
				}
				fail(w, r, h.c, err)
				return
			}
		}
		c.PublishID = id
	}
	if err := strField(raw, "message_id", "message_id", &c.MessageID, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if c.MessageID != "" {
		if c.Kind != "im" {
			fail(w, r, h.c, apiErr(errValidation, "只有 IM 消息能带 message_id"))
			return
		}
		if !messageIDRe.MatchString(c.MessageID) {
			fail(w, r, h.c, apiErr(errValidation, "message_id 只能有字母、数字和 . _ : -"))
			return
		}
	}
	// 同一条 IM 消息只收一份，再收回已有的那条（VID-08b）
	if c.MessageID != "" {
		imClipMu.Lock()
		defer imClipMu.Unlock()
		if old, ok, err := h.existingIMClip(ctx, c.MessageID); err != nil || ok {
			if err != nil {
				fail(w, r, h.c, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"data": old, "meta": map[string]bool{"existing": true}})
			return
		}
	}
	c.ID = idgen.Prefixed("cl")
	now := nowStr()
	tags, _ := json.Marshal(c.Tags)
	if _, err := h.c.Store().Exec(ctx, `INSERT INTO video_clips (`+clipCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.Kind, c.Title, c.Content, c.URL, c.Source, c.Heat, string(tags), b2i(c.Starred), b2i(c.Triaged), c.PublishID, c.MessageID, now, now); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getClip(ctx, c.ID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": out})
}

// updateClip：类型和来源出处登记后不能改；归到哪个选题用 link、转选题，取消关联改选题的 clip_ids。
func (h *handler) updateClip(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, append(clipFields, "topic_ids")...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	for _, k := range []string{"kind", "publish_id", "message_id", "topic_ids"} {
		if _, ok := raw[k]; ok {
			fail(w, r, h.c, apiErr(errValidation, "%s 登记后不能改", k))
			return
		}
	}
	c, err := h.getClip(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := applyClip(&c, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if c.Title == "" {
		fail(w, r, h.c, apiErr(errValidation, "标题不能为空"))
		return
	}
	tags, _ := json.Marshal(c.Tags)
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_clips SET title = ?, content = ?, url = ?, source = ?, heat = ?, tag_list = ?, starred = ?,
		triaged = ?, updated_at = ? WHERE id = ?`,
		c.Title, c.Content, c.URL, c.Source, c.Heat, string(tags), b2i(c.Starred), b2i(c.Triaged), nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getClip(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out})
}

// removeClip：和选题的关联随外键一起删，选题留着。
func (h *handler) removeClip(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	if _, err := h.getClip(ctx, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, err := h.c.Store().Exec(ctx, `DELETE FROM video_clips WHERE id = ?`, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": nil})
}

// clipToTopic：转为选题，同原型 toTopic。标题用素材标题，大纲用素材内容，标签照搬；
// 需求度按热度给（过万 4，否则 3），契合度、成本都是 3。body 里给的选题字段覆盖这些默认值。
func (h *handler) clipToTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, topicFields...)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, ok := raw["clip_ids"]; ok {
		fail(w, r, h.c, apiErr(errValidation, "转选题只关联这一条素材，不能带 clip_ids"))
		return
	}
	c, err := h.getClip(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t := newTopic()
	t.Title, t.Outline, t.Tags = c.Title, c.Content, c.Tags
	if c.Heat != nil && *c.Heat > 10000 {
		t.Score.Demand = 4
	}
	if err := h.applyTopic(ctx, &t, raw); err != nil {
		fail(w, r, h.c, err)
		return
	}
	t.ID = idgen.Prefixed("tp")
	t.CreatedAt = nowStr()
	t.UpdatedAt = t.CreatedAt
	if err := h.insertTopic(ctx, t); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if err := h.linkClip(ctx, t.ID, id, t.CreatedAt); err != nil {
		fail(w, r, h.c, err)
		return
	}
	h.writeLinked(w, r, http.StatusCreated, t.ID, id)
}

// linkTopic：并入已有选题，同原型「归到选题」。只能归到进行中的选题（不是已做成、放弃）；已经关联的照样回 200。
func (h *handler) linkTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, "topic_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var tid string
	if err := strField(raw, "topic_id", "topic_id", &tid, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if tid == "" {
		fail(w, r, h.c, apiErr(errValidation, "topic_id 必填"))
		return
	}
	c, err := h.getClip(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	t, err := h.getTopic(ctx, tid)
	if errors.Is(err, errNotFound) {
		err = apiErr(errValidation, "选题不存在")
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if !slices.Contains(c.TopicIDs, tid) {
		if t.Status == "made" || t.Status == "dropped" {
			fail(w, r, h.c, apiErr(errConflict, "选题已经%s了，只能归到进行中的选题", map[string]string{"made": "做成", "dropped": "放弃"}[t.Status]))
			return
		}
		now := nowStr()
		if err := h.linkClip(ctx, tid, id, now); err != nil {
			fail(w, r, h.c, err)
			return
		}
		if _, err := h.c.Store().Exec(ctx, `UPDATE video_topics SET updated_at = ? WHERE id = ?`, now, tid); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	h.writeLinked(w, r, http.StatusOK, tid, id)
}

// writeLinked 回 {topic, clip}，两边的关联都是最新的。
func (h *handler) writeLinked(w http.ResponseWriter, r *http.Request, status int, topicID, clipID string) {
	t, err := h.getTopic(r.Context(), topicID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	c, err := h.getClip(r.Context(), clipID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, status, map[string]any{"data": map[string]any{"topic": t, "clip": c}})
}
