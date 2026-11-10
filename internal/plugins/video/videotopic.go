// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
)

// 选题一步（VID-09a）：PUT /api/video/videos/{id}/topic 给视频挑选、换掉或摘下选题（同原型 linkTopic）。
// 两边一起写：视频记 topic_id，选题记 video_id、状态改已做成；换下来的选题清掉 video_id、回到可开拍。
// 阶段不动，选题一步用 advance 进内容编写（没挂选题 400）。

var untitledRe = regexp.MustCompile(`^第 \d+ 集：$`)

// upgradeTopicLinks 给 0007 以前立项的视频补 topic_id（选题那边已经记着 video_id），每个进程跑一次，幂等。
func (h *handler) upgradeTopicLinks(ctx context.Context) error {
	h.topicMu.Lock()
	defer h.topicMu.Unlock()
	if h.topicDone {
		return nil
	}
	if _, err := h.c.Store().Exec(ctx, `UPDATE video_videos SET topic_id = (SELECT t.id FROM video_topics t WHERE t.video_id = video_videos.id)
		WHERE topic_id IS NULL AND id IN (SELECT video_id FROM video_topics WHERE video_id IS NOT NULL
		AND id NOT IN (SELECT topic_id FROM video_videos WHERE topic_id IS NOT NULL))`); err != nil {
		return err
	}
	h.topicDone = true
	return nil
}

// topicTitle 同原型：标题还是默认的（空、「新视频」、「第 N 集：」）就换成选题标题，系列里带集数。
func topicTitle(v Video, t Topic) string {
	cur := strings.TrimSpace(v.Title)
	tt := strings.TrimSpace(t.Title)
	if tt == "" || (cur != "" && cur != "新视频" && !untitledRe.MatchString(cur)) {
		return v.Title
	}
	out := tt
	if v.Episode != nil {
		out = fmt.Sprintf("第 %d 集：%s", *v.Episode, tt)
	}
	if n := []rune(out); len(n) > 200 {
		out = string(n[:200])
	}
	return out
}

// topicOrients 是选题目标平台的推荐比例，按 Orients 顺序去重；没选平台回 nil。
func topicOrients(t Topic) []string {
	var out []string
	for _, o := range Orients {
		for _, p := range t.Platforms {
			if PlatformPrefer[p] == o && !slices.Contains(out, o) {
				out = append(out, o)
			}
		}
	}
	return out
}

func (h *handler) putVideoTopic(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, "topic_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	b, ok := raw["topic_id"]
	if !ok {
		fail(w, r, h.c, apiErr(errValidation, "topic_id 必填，传 null 摘下选题"))
		return
	}
	tid, err := optID(b, "topic_id")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	v, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if eqPtr(v.TopicID, tid) {
		h.respondVideoTopic(w, r, id)
		return
	}
	var t Topic
	if tid != nil {
		t, err = h.getTopic(ctx, *tid)
		if err != nil {
			if errors.Is(err, errNotFound) {
				err = apiErr(errValidation, "选题不存在")
			}
			fail(w, r, h.c, err)
			return
		}
		switch {
		case t.VideoID != nil:
			fail(w, r, h.c, apiErr(errConflict, "这个选题已经挂在别的视频上了"))
			return
		case t.Status == "dropped":
			fail(w, r, h.c, apiErr(errConflict, "已放弃的选题不能用"))
			return
		}
	}
	now := nowStr()
	st := h.c.Store()
	// 先把换下来的选题放回去，再按读到的状态占住新选题，占不上算冲突
	if v.TopicID != nil {
		if _, err := st.Exec(ctx, `UPDATE video_topics SET video_id = NULL, status = 'ready', updated_at = ? WHERE id = ? AND video_id = ?`,
			now, *v.TopicID, id); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if tid == nil {
		if _, err := st.Exec(ctx, `UPDATE video_videos SET topic_id = NULL, updated_at = ? WHERE id = ?`, now, id); err != nil {
			fail(w, r, h.c, err)
			return
		}
		h.respondVideoTopic(w, r, id)
		return
	}
	res, err := st.Exec(ctx, `UPDATE video_topics SET video_id = ?, status = 'made', updated_at = ? WHERE id = ? AND video_id IS NULL AND status <> 'dropped'`,
		id, now, *tid)
	if err != nil {
		fail(w, r, h.c, uniqueErr(err))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 换下来的那个已经放回去了，视频这边一起摘掉，保持两边一致
		_, _ = st.Exec(ctx, `UPDATE video_videos SET topic_id = NULL, updated_at = ? WHERE id = ?`, now, id)
		fail(w, r, h.c, apiErr(errConflict, "选题刚被别处改过，刷新后再操作"))
		return
	}
	title := topicTitle(v, t)
	orients := v.Orientations
	if os := topicOrients(t); len(os) > 0 && !v.orientLocked() {
		orients = os
	}
	ob, _ := json.Marshal(orients)
	if _, err := st.Exec(ctx, `UPDATE video_videos SET topic_id = ?, title = ?, orientations = ?, updated_at = ? WHERE id = ?`,
		*tid, title, string(ob), now, id); err != nil {
		_, _ = st.Exec(ctx, `UPDATE video_topics SET video_id = NULL, status = ?, updated_at = ? WHERE id = ?`, t.Status, now, *tid)
		fail(w, r, h.c, uniqueErr(err))
		return
	}
	h.respondVideoTopic(w, r, id)
}

// respondVideoTopic 回 {video, topic}，topic 是挂着的选题，没挂是 null。
func (h *handler) respondVideoTopic(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	v, err := h.getVideo(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var topic any
	if v.TopicID != nil {
		t, err := h.getTopic(ctx, *v.TopicID)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		topic = t
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"video": v, "topic": topic}})
}
