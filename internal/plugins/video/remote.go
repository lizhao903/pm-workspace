package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 发布记录经内容平台连接器投稿、查状态、拉数据和评论（VID-04b）。适配接口见 platform.go，B 站见 bilibili.go。
// 投稿是同步的：上传、设封面、投稿都在一个请求里做完；失败时发布记录置为 failed 并写上原因。
// 渠道异常（令牌失效、连不上）时连接器经 RecordSync 置为异常，成功一次恢复。

// PlatformInfo 是 GET /api/video/platforms 的一项。
type PlatformInfo struct {
	Key        string           `json:"key"`
	Label      string           `json:"label"`
	Tool       string           `json:"tool,omitempty"`
	Caps       []string         `json:"caps"`
	Covers     []string         `json:"covers"`
	Connectors []PlatformTarget `json:"connectors"`
}

// PlatformTarget 是这个平台已接入的连接器实例（一个实例一个平台账号）。
type PlatformTarget struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Account string `json:"account"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

func (h *handler) listPlatforms(w http.ResponseWriter, r *http.Request) {
	out := make([]PlatformInfo, 0, len(Platforms))
	for _, k := range Platforms {
		p := PlatformInfo{Key: k, Label: PlatformLabels[k], Caps: []string{}, Covers: PlatformCovers[k], Connectors: []PlatformTarget{}}
		if a := h.platforms[k]; a != nil {
			p.Tool, p.Caps = a.ConnectorDef().Tool, a.Caps()
			list, err := h.c.Connectors().List(r.Context(), p.Tool)
			if err != nil {
				fail(w, r, h.c, err)
				return
			}
			for _, cn := range list {
				p.Connectors = append(p.Connectors, PlatformTarget{ID: cn.ID, Name: cn.Name, Account: cn.Account, Status: cn.Status, Error: cn.Error})
			}
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]int{"total": len(out)}})
}

// upstreamFail 是平台出错：502，code 是 publish_failed / sync_failed / fetch_failed，message 是原因。
func upstreamFail(w http.ResponseWriter, code string, err error, extra map[string]any) {
	e := map[string]any{"code": code, "message": err.Error()}
	for k, v := range extra {
		e[k] = v
	}
	writeJSON(w, http.StatusBadGateway, map[string]any{"error": e})
}

// adapterFor 是发布记录所在平台的适配器，没有或没有这项能力 400。
func (h *handler) adapterFor(p Publish, capability, doing string) (PlatformAdapter, error) {
	a := h.platforms[p.Platform]
	if !hasCap(a, capability) {
		return nil, apiErr(errValidation, "%s还不能经连接器%s", PlatformLabels[p.Platform], doing)
	}
	return a, nil
}

// pickConnector：给了 id 用它（要是这个平台的）；没给时这个平台只接了一个就用它。暂停、断开的 409。
func (h *handler) pickConnector(ctx context.Context, a PlatformAdapter, id string) (plugin.ConnectorInfo, error) {
	tool, label := a.ConnectorDef().Tool, PlatformLabels[a.Platform()]
	var cn plugin.ConnectorInfo
	if id != "" {
		got, err := h.c.Connectors().Get(ctx, id)
		if errors.Is(err, plugin.ErrNoRows) || err == nil && got.Tool != tool {
			return cn, apiErr(errValidation, "连接器 %s 不存在或不是%s的", id, label)
		} else if err != nil {
			return cn, err
		}
		cn = got
	} else {
		list, err := h.c.Connectors().List(ctx, tool)
		if err != nil {
			return cn, err
		}
		switch len(list) {
		case 0:
			return cn, apiErr(errValidation, "还没接入%s：到「设置 / 连接器」里接入", label)
		case 1:
			cn = list[0]
		default:
			return cn, apiErr(errValidation, "接了 %d 个%s账号，要用 connector_id 指定用哪个", len(list), label)
		}
	}
	switch cn.Status {
	case "paused":
		return cn, apiErr(errConflict, "连接器「%s」已暂停", cn.Name)
	case "disconnected":
		return cn, apiErr(errConflict, "连接器「%s」已断开", cn.Name)
	}
	return cn, nil
}

// withPlatform 拿出网客户端和连接器配置跑 fn；渠道异常时连接器置为异常，成功时恢复。
func (h *handler) withPlatform(ctx context.Context, cn plugin.ConnectorInfo, fn func(Session) error) error {
	hc, err := h.c.HTTP("media-platforms")
	if err != nil {
		return err
	}
	err = h.c.Connectors().With(ctx, cn.ID, func(cfg plugin.ConnectorConfig) error {
		return fn(Session{HTTP: hc, Config: cfg})
	})
	// 请求被取消的不算渠道异常
	if ctx.Err() != nil {
		return err
	}
	switch {
	case err == nil:
		if _, rerr := h.c.Connectors().RecordSync(ctx, cn.ID, nil); rerr != nil {
			h.c.Log().Warn("record connector sync", "connector", cn.ID, "err", rerr)
		}
	case channelErr(err):
		if _, rerr := h.c.Connectors().RecordSync(ctx, cn.ID, err); rerr != nil {
			h.c.Log().Warn("record connector error", "connector", cn.ID, "err", rerr)
		}
	}
	return err
}

// localFile 把产出物解析成工程目录里的文件：要在、是普通文件、不空。
func (h *handler) localFile(ctx context.Context, v Video, a Artifact, label string) (LocalFile, error) {
	if !h.c.Granted("fs:read:project") {
		return LocalFile{}, apiErr(errValidation, "视频插件没有读工程目录的权限（fs:read:project）")
	}
	wd, err := h.workdirOf(ctx, v)
	if err != nil {
		return LocalFile{}, apiErr(errValidation, "找不到%s：%v", label, err)
	}
	rel, err := cleanRelPath(a.Path)
	if err != nil || strings.HasSuffix(rel, "/") {
		return LocalFile{}, apiErr(errValidation, "%s的路径 %s 不是一个文件", label, a.Path)
	}
	p := filepath.Join(wd, filepath.FromSlash(rel))
	st, err := os.Stat(p)
	switch {
	case err != nil:
		return LocalFile{}, apiErr(errValidation, "%s %s 不在工程目录里", label, a.Path)
	case !st.Mode().IsRegular():
		return LocalFile{}, apiErr(errValidation, "%s %s 不是普通文件", label, a.Path)
	case st.Size() == 0:
		return LocalFile{}, apiErr(errValidation, "%s %s 是空文件", label, a.Path)
	}
	return LocalFile{Path: p, Name: filepath.Base(p), Size: st.Size()}, nil
}

// videoArtifact 是要传的成片：给了 file_id 用它，没给取同方向的成片里验收过的、版本最新的。
func (h *handler) videoArtifact(ctx context.Context, p Publish, fileID string) (Artifact, error) {
	if fileID == "" {
		rows, err := h.c.Store().Query(ctx, `SELECT id FROM video_artifacts WHERE video_id = ? AND kind = 'video' AND variant = ?
			ORDER BY status IN ('final', 'published') DESC, version DESC, created_at DESC, rowid DESC LIMIT 1`, p.VideoID, p.Variant)
		if err != nil {
			return Artifact{}, err
		}
		for rows.Next() {
			if err := rows.Scan(&fileID); err != nil {
				_ = rows.Close()
				return Artifact{}, err
			}
		}
		_ = rows.Close()
		if err := rows.Err(); err != nil {
			return Artifact{}, err
		}
		if fileID == "" {
			return Artifact{}, apiErr(errValidation, "这集还没有%s成片：先登记成片，或用 file_id 指定", orientLabel(p.Variant))
		}
	}
	a, err := h.getArtifact(ctx, fileID)
	if errors.Is(err, errNotFound) {
		return Artifact{}, apiErr(errValidation, "成片 %s 不存在", fileID)
	} else if err != nil {
		return Artifact{}, err
	}
	switch {
	case a.VideoID != p.VideoID:
		return Artifact{}, apiErr(errValidation, "成片 %s 不是这个视频的", a.ID)
	case a.Kind != "video":
		return Artifact{}, apiErr(errValidation, "file_id 要是成片，%s 是%s", a.ID, kindLabel(a.Kind))
	case a.Variant != p.Variant:
		return Artifact{}, apiErr(errValidation, "成片是%s的，这条发布是%s", orientLabel(a.Variant), orientLabel(p.Variant))
	}
	return a, nil
}

// stringList 读字符串数组，去首尾空白、去空串。
func stringList(raw map[string]json.RawMessage, key string, max int) ([]string, error) {
	v, ok := raw[key]
	if !ok || isNull(v) {
		return nil, nil
	}
	var in []string
	if err := json.Unmarshal(v, &in); err != nil {
		return nil, apiErr(errValidation, "%s 必须是字符串数组", key)
	}
	out := []string{}
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) > max {
		return nil, apiErr(errValidation, "%s 最多 %d 个", key, max)
	}
	return out, nil
}

// submitPublish 是 POST /api/video/publishes/{id}/submit：上传成片、设封面、投稿。
func (h *handler) submitPublish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	raw, err := readBody(r, "connector_id", "file_id", "tags", "category", "collection")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	p, err := h.getPublish(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.Status == "published" || p.URL != "" {
		fail(w, r, h.c, apiErr(errConflict, "这条发布已经有稿件了，不能再投一次"))
		return
	}
	a, err := h.adapterFor(p, CapUpload, "投稿，手动发布后回填链接")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var connID, fileID string
	in := PublishInput{Title: p.Title, Desc: p.Desc}
	for _, f := range []struct {
		key string
		dst *string
		max int
	}{{"connector_id", &connID, 100}, {"file_id", &fileID, 100}, {"category", &in.Category, 100}, {"collection", &in.Collection, 200}} {
		if err := strField(raw, f.key, f.key, f.dst, f.max); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	if in.Tags, err = stringList(raw, "tags", 50); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.ScheduledAt != nil && parseTime(*p.ScheduledAt).After(parseTime(nowStr())) {
		in.ScheduledAt = *p.ScheduledAt
		if !hasCap(a, CapSchedule) {
			fail(w, r, h.c, apiErr(errValidation, "%s还不能定时投稿，清掉定时或到点再发", PlatformLabels[p.Platform]))
			return
		}
	}
	v, err := h.getVideo(ctx, p.VideoID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	file, err := h.videoArtifact(ctx, p, fileID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if in.Video, err = h.localFile(ctx, v, file, "成片"); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if p.CoverID != "" {
		cv, err := h.getArtifact(ctx, p.CoverID)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		f, err := h.localFile(ctx, v, cv, "封面")
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		in.Cover = &f
	}
	if err := a.Validate(in); err != nil {
		fail(w, r, h.c, apiErr(errValidation, "%s", err.Error()))
		return
	}
	cn, err := h.pickConnector(ctx, a, connID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	if _, busy := h.submitting.LoadOrStore(id, true); busy {
		fail(w, r, h.c, apiErr(errConflict, "这条发布正在投稿"))
		return
	}
	defer h.submitting.Delete(id)

	var ref RemoteRef
	err = h.withPlatform(ctx, cn, func(s Session) error {
		upload, err := a.UploadVideo(ctx, s, in.Video)
		if err != nil {
			return err
		}
		cover := ""
		if in.Cover != nil {
			if cover, err = a.UploadCover(ctx, s, *in.Cover); err != nil {
				return err
			}
		}
		ref, err = a.Submit(ctx, s, in, upload, cover)
		return err
	})
	// 请求断了也要把结果记下
	wctx := context.WithoutCancel(ctx)
	if err != nil {
		msg := clipText(err.Error(), 2000)
		if _, uerr := h.c.Store().Exec(wctx, `UPDATE video_publishes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, msg, nowStr(), id); uerr != nil {
			fail(w, r, h.c, uerr)
			return
		}
		upstreamFail(w, "publish_failed", errors.New(msg), map[string]any{"publish_id": id, "connector_id": cn.ID})
		return
	}
	now := nowStr()
	status, publishedAt := "published", &now
	if in.ScheduledAt != "" {
		status, publishedAt = "scheduled", nil
	}
	if _, err := h.c.Store().Exec(wctx, `UPDATE video_publishes SET status = ?, url = ?, error = '', published_at = ?, updated_at = ? WHERE id = ?`,
		status, ref.URL, publishedAt, now, id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getPublish(wctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{"connector_id": cn.ID, "remote_id": ref.ID}})
}

// remoteOf 是发布记录对应的平台稿件，从 url 里认。
func (h *handler) remoteOf(p Publish, a PlatformAdapter) (RemoteRef, error) {
	ref, ok := a.RefOf(p.URL)
	if !ok {
		return RemoteRef{}, apiErr(errValidation, "这条发布还没有%s的稿件链接：先投稿，或回填稿件链接", PlatformLabels[p.Platform])
	}
	return ref, nil
}

func (h *handler) connectorQuery(r *http.Request, raw map[string]json.RawMessage) (string, error) {
	id := r.URL.Query().Get("connector_id")
	if raw != nil {
		if err := strField(raw, "connector_id", "connector_id", &id, 100); err != nil {
			return "", err
		}
	}
	return id, nil
}

// syncPublish 是 POST /api/video/publishes/{id}/sync：查稿件状态、拉数据，写回发布记录。
func (h *handler) syncPublish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	var raw map[string]json.RawMessage
	if r.ContentLength != 0 {
		var err error
		if raw, err = readBody(r, "connector_id"); err != nil {
			fail(w, r, h.c, err)
			return
		}
	}
	p, err := h.getPublish(ctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a := h.platforms[p.Platform]
	if !hasCap(a, CapUpload) && !hasCap(a, CapMetrics) {
		fail(w, r, h.c, apiErr(errValidation, "%s还不能经连接器查状态和拉数据，手动回填", PlatformLabels[p.Platform]))
		return
	}
	ref, err := h.remoteOf(p, a)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	connID, err := h.connectorQuery(r, raw)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	cn, err := h.pickConnector(ctx, a, connID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var (
		st    RemoteStatus
		stats *RemoteStats
	)
	err = h.withPlatform(ctx, cn, func(s Session) error {
		if hasCap(a, CapUpload) {
			if st, err = a.Status(ctx, s, ref); err != nil {
				return err
			}
		}
		if hasCap(a, CapMetrics) && st.State != RemoteFailed {
			got, err := a.Stats(ctx, s, ref)
			if err != nil {
				return err
			}
			stats = &got
		}
		return nil
	})
	if err != nil {
		upstreamFail(w, "sync_failed", errors.New(clipText(err.Error(), 2000)), map[string]any{"publish_id": id, "connector_id": cn.ID})
		return
	}
	switch st.State {
	case RemoteFailed:
		p.Status, p.Error = "failed", st.Reason
	case RemotePublished:
		p.Status, p.Error = "published", ""
		if p.PublishedAt == nil && st.PublishedAt != "" {
			p.PublishedAt = &st.PublishedAt
		}
	case RemoteReviewing:
		p.Error = ""
	}
	if stats != nil {
		p.Metrics = &Metrics{Views: stats.Views, Likes: stats.Likes, Comments: stats.Comments, Shares: stats.Shares, UpdatedAt: nowStr()}
	}
	wctx := context.WithoutCancel(ctx)
	if _, err := h.c.Store().Exec(wctx, `UPDATE video_publishes SET status = ?, error = ?, published_at = ?, metrics = ?, updated_at = ? WHERE id = ?`,
		p.Status, p.Error, p.PublishedAt, metricsCol(p.Metrics), nowStr(), id); err != nil {
		fail(w, r, h.c, err)
		return
	}
	out, err := h.getPublish(wctx, id)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	meta := map[string]any{"connector_id": cn.ID, "remote_id": ref.ID}
	if st.State != "" {
		meta["remote"] = st
	}
	if stats != nil {
		meta["stats"] = stats
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": meta})
}

// listComments 是 GET /api/video/publishes/{id}/comments?cursor=&connector_id=：拉这条稿件的一页评论，不落库。
func (h *handler) listComments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := h.getPublish(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	a, err := h.adapterFor(p, CapComments, "拉评论")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	ref, err := h.remoteOf(p, a)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	connID, _ := h.connectorQuery(r, nil)
	cn, err := h.pickConnector(ctx, a, connID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	cursor := r.URL.Query().Get("cursor")
	if len(cursor) > 500 {
		fail(w, r, h.c, apiErr(errValidation, "cursor 太长"))
		return
	}
	var page CommentPage
	err = h.withPlatform(ctx, cn, func(s Session) error {
		page, err = a.Comments(ctx, s, ref, cursor)
		return err
	})
	if err != nil {
		upstreamFail(w, "fetch_failed", fmt.Errorf("%s", clipText(err.Error(), 2000)), map[string]any{"publish_id": p.ID, "connector_id": cn.ID})
		return
	}
	if page.Items == nil {
		page.Items = []Comment{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": page.Items, "meta": map[string]any{"total": len(page.Items), "next": page.Next, "connector_id": cn.ID}})
}
