// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 评论收件（VID-08b）：按发布记录经平台适配器拉新评论，落成评论素材（kind comment，带 publish_id），同原型素材箱「收集评论」。
// 按平台评论 id 去重：video_clips.remote_id 存「平台:评论 id」，唯一索引兜底，拉几次都只落一份。
// 后台任务每 30 分钟拉一次最近 30 天公开的稿件；素材箱的按钮走 POST /api/video/clips/comments 立刻拉。
// 只拉不回：在平台上回复评论是对外发布，不在这里做。

const (
	commentEvery    = 30 * time.Minute
	commentWindow   = 30 * 24 * time.Hour
	commentMaxPages = 5 // 每条稿件一次最多翻几页；一页全是收过的就不往下翻
)

// CollectSkip 是这次没拉成的一条发布记录和原因。
type CollectSkip struct {
	PublishID string `json:"publish_id"`
	Reason    string `json:"reason"`
}

// CollectResult 是一次收集的结果：新落的素材、已经收过的条数、拉了几条稿件、没拉成的。
type CollectResult struct {
	Added      []Clip
	Duplicates int
	Publishes  int
	Skipped    []CollectSkip
}

func commentJob(h *handler) plugin.Job {
	return plugin.Job{Name: "collect_comments", Every: commentEvery, Run: func(ctx context.Context, _ plugin.Core) error {
		if !h.anyCommentPlatform() {
			return nil
		}
		res, err := h.collectComments(ctx, "")
		if err != nil {
			return err
		}
		if len(res.Added) > 0 || len(res.Skipped) > 0 {
			h.c.Log().Info("collect comments", "added", len(res.Added), "duplicates", res.Duplicates, "publishes", res.Publishes, "skipped", len(res.Skipped))
		}
		return nil
	}}
}

func (h *handler) anyCommentPlatform() bool {
	for _, a := range h.platforms {
		if hasCap(a, CapComments) {
			return true
		}
	}
	return false
}

// collectComments 拉评论。only 为空时是全部最近 30 天公开、有稿件链接、平台能拉评论的发布记录，拉不了的记进 Skipped；
// 给了发布记录 id 时只拉这一条，不看时间，拉不了直接回错误（平台出错是 *PlatformError）。
func (h *handler) collectComments(ctx context.Context, only string) (CollectResult, error) {
	h.collectMu.Lock()
	defer h.collectMu.Unlock()
	res := CollectResult{Added: []Clip{}, Skipped: []CollectSkip{}}
	var pubs []Publish
	if only != "" {
		p, err := h.getPublish(ctx, only)
		if err != nil {
			return res, err
		}
		pubs = []Publish{p}
	} else {
		since := time.Now().Add(-commentWindow).UTC().Format(time.RFC3339)
		rows, err := h.c.Store().Query(ctx, `SELECT `+publishCols+` FROM video_publishes WHERE status = 'published' AND url <> ''
			AND (published_at IS NULL OR published_at >= ?) ORDER BY created_at, rowid`, since)
		if err != nil {
			return res, err
		}
		for rows.Next() {
			p, err := scanPublish(rows)
			if err != nil {
				_ = rows.Close()
				return res, err
			}
			pubs = append(pubs, p)
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return res, err
		}
	}
	for _, p := range pubs {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		a := h.platforms[p.Platform]
		if !hasCap(a, CapComments) {
			if only != "" {
				return res, apiErr(errValidation, "%s还不能经连接器拉评论", PlatformLabels[p.Platform])
			}
			continue
		}
		added, dup, err := h.collectOne(ctx, p, a)
		res.Added = append(res.Added, added...)
		res.Duplicates += dup
		if err != nil {
			if only != "" || errors.Is(err, context.Canceled) {
				return res, err
			}
			_, msg, _ := strings.Cut(err.Error(), ": ")
			if !errors.Is(err, errValidation) && !errors.Is(err, errConflict) {
				msg = err.Error()
			}
			res.Skipped = append(res.Skipped, CollectSkip{PublishID: p.ID, Reason: clipText(msg, 500)})
			continue
		}
		res.Publishes++
	}
	return res, nil
}

// collectOne 拉一条稿件的评论，新的落库；回新落的素材和收过的条数。
func (h *handler) collectOne(ctx context.Context, p Publish, a PlatformAdapter) ([]Clip, int, error) {
	ref, err := h.remoteOf(p, a)
	if err != nil {
		return nil, 0, err
	}
	// 发布记录挂了账号就用账号的连接器，同拉数据、拉评论；一个平台接了几个账号时不挂会报要指定
	cn, err := h.pickConnector(ctx, a, h.accountConnector(ctx, p))
	if err != nil {
		return nil, 0, err
	}
	var added []Clip
	dup := 0
	err = h.withPlatform(ctx, cn, func(s Session) error {
		cursor := ""
		for range commentMaxPages {
			page, err := a.Comments(ctx, s, ref, cursor)
			if err != nil {
				return err
			}
			fresh := 0
			for _, cm := range page.Items {
				c, ok, err := h.saveComment(ctx, p, cm)
				if err != nil {
					return err
				}
				if ok {
					added, fresh = append(added, c), fresh+1
				} else {
					dup++
				}
			}
			if page.Next == "" || page.Next == cursor || fresh == 0 {
				return nil
			}
			cursor = page.Next
		}
		return nil
	})
	return added, dup, err
}

// saveComment 落一条评论素材：标题取正文前 40 字，热度是点赞数，来源是「平台评论 · 发布标题 · 作者」；收过的回 false。
func (h *handler) saveComment(ctx context.Context, p Publish, cm Comment) (Clip, bool, error) {
	text := strings.TrimSpace(cm.Text)
	if strings.TrimSpace(cm.ID) == "" || text == "" {
		return Clip{}, false, nil
	}
	remote := cutRunes(p.Platform+":"+strings.TrimSpace(cm.ID), 200)
	src := []string{PlatformLabels[p.Platform] + "评论"}
	if p.Title != "" {
		src = append(src, p.Title)
	}
	if a := strings.TrimSpace(cm.Author); a != "" {
		src = append(src, a)
	}
	heat := int64(max(cm.Likes, 0))
	c := Clip{ID: idgen.Prefixed("cl"), Kind: "comment", Content: cutRunes(text, 5000), Source: cutRunes(strings.Join(src, " · "), 200),
		Heat: &heat, Tags: []string{}, TopicIDs: []string{}, PublishID: &p.ID}
	c.Title = clipTitle(c)
	now := nowStr()
	res, err := h.c.Store().Exec(ctx, `INSERT OR IGNORE INTO video_clips (`+clipCols+`, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.Kind, c.Title, c.Content, c.URL, c.Source, c.Heat, "[]", 0, 0, c.PublishID, "", now, now, remote)
	if err != nil {
		return Clip{}, false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return Clip{}, false, err
	}
	c.CreatedAt, c.UpdatedAt = now, now
	return c, true, nil
}

// cutRunes 截到 n 个字，不加省略号（存进去的还要能原样 PATCH 回来）。
func cutRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// pullComments 是 POST /api/video/clips/comments：无 body 或 {publish_id?}，立刻拉评论收进素材箱。
func (h *handler) pullComments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var only string
	if r.ContentLength != 0 {
		raw, err := readBody(r, "publish_id")
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if err := strField(raw, "publish_id", "publish_id", &only, 100); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if only == "" && !h.anyCommentPlatform() {
		fail(w, r, h.c, apiErr(errValidation, "接入的平台都还不能经连接器拉评论"))
		return
	}
	res, err := h.collectComments(context.WithoutCancel(ctx), only)
	var pe *PlatformError
	if errors.As(err, &pe) {
		upstreamFail(w, "fetch_failed", fmt.Errorf("%s", clipText(err.Error(), 2000)), map[string]any{"publish_id": only})
		return
	}
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": res.Added, "meta": map[string]any{
		"added": len(res.Added), "duplicates": res.Duplicates, "publishes": res.Publishes, "skipped": res.Skipped}})
}

// imClipMu 让「查有没有收过」和「收进来」连在一起，连点两次不收两份。
var imClipMu sync.Mutex

// existingIMClip 是这条 IM 消息已经收进来的素材，没有回 false。IM 抽屉「收进素材箱」点两次只收一份。
func (h *handler) existingIMClip(ctx context.Context, messageID string) (Clip, bool, error) {
	xs, err := h.loadClips(ctx, `WHERE kind = 'im' AND message_id = ?`, messageID)
	if err != nil || len(xs) == 0 {
		return Clip{}, false, err
	}
	return xs[len(xs)-1], true, nil
}
