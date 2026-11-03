package video

import (
	"net/http"
)

// 发布包（VID-04d）：没有上传能力的平台（抖音、视频号、小红书）发布退化为「生成发布包加打开创作者后台」。
// 发布包是这条发布要手动填的东西：标题、简介、标签、本机的成片和封面路径、校验结果、创作者后台地址；
// 发完由用户回填稿件链接（PATCH url），之后有 metrics 能力的平台照常 sync 拉数据。有上传能力的平台也能用。

// CreatorURLs 是各平台创作者后台的发稿页。
var CreatorURLs = map[string]string{
	"bilibili":    "https://member.bilibili.com/platform/upload/video/frame",
	"youtube":     "https://studio.youtube.com",
	"douyin":      "https://creator.douyin.com/creator-micro/content/upload",
	"channels":    "https://channels.weixin.qq.com/platform/post/create",
	"xiaohongshu": "https://creator.xiaohongshu.com/publish/publish",
}

// PackageFile 是发布包里本机的一个文件。
type PackageFile struct {
	ArtifactID string `json:"artifact_id"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Ratio      string `json:"ratio,omitempty"`
}

// PublishPackage 是 GET /api/video/publishes/{id}/package 的 data。
type PublishPackage struct {
	PublishID   string         `json:"publish_id"`
	Platform    string         `json:"platform"`
	Label       string         `json:"label"`
	CreatorURL  string         `json:"creator_url"`
	Upload      bool           `json:"upload"` // 这个平台能不能经连接器投稿
	Title       string         `json:"title"`
	Desc        string         `json:"desc"`
	Tags        []string       `json:"tags"`
	Category    string         `json:"category,omitempty"`
	Collection  string         `json:"collection,omitempty"`
	ScheduledAt *string        `json:"scheduled_at,omitempty"`
	Video       PackageFile    `json:"video"`
	Cover       *PackageFile   `json:"cover,omitempty"`
	Checks      []PublishCheck `json:"checks"`
	Steps       []string       `json:"steps"`
}

// publishPackage 是 GET /api/video/publishes/{id}/package?file_id=：成片取法同投稿，封面用发布记录的 cover_id。
// 只读，不改发布记录、不出网。
func (h *handler) publishPackage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := h.getPublish(ctx, r.PathValue("id"))
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	fileID := r.URL.Query().Get("file_id")
	if len(fileID) > 100 {
		fail(w, r, h.c, apiErr(errValidation, "file_id 最多 100 字"))
		return
	}
	v, err := h.getVideo(ctx, p.VideoID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	film, err := h.videoArtifact(ctx, p, fileID)
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	f, err := h.localFile(ctx, v, film, "成片")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	label := PlatformLabels[p.Platform]
	pk := PublishPackage{PublishID: p.ID, Platform: p.Platform, Label: label, CreatorURL: CreatorURLs[p.Platform],
		Upload: hasCap(h.platforms[p.Platform], CapUpload), Title: p.Title, Desc: p.Desc, Tags: p.Tags,
		Category: p.Category, Collection: p.Collection, ScheduledAt: p.ScheduledAt,
		Video: PackageFile{ArtifactID: film.ID, Path: f.Path, Name: f.Name, Size: f.Size}}
	if pk.Tags == nil {
		pk.Tags = []string{}
	}
	if p.CoverID != "" {
		cv, err := h.getArtifact(ctx, p.CoverID)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		cf, err := h.localFile(ctx, v, cv, "封面")
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		pk.Cover = &PackageFile{ArtifactID: cv.ID, Path: cf.Path, Name: cf.Name, Size: cf.Size, Ratio: cv.Ratio}
	}
	if pk.Checks, err = h.publishChecks(ctx, p); err != nil {
		fail(w, r, h.c, err)
		return
	}
	if pk.Checks == nil {
		pk.Checks = []PublishCheck{}
	}
	pk.Steps = []string{"打开" + label + "创作者后台：" + pk.CreatorURL, "上传成片：" + f.Path}
	if pk.Cover != nil {
		pk.Steps = append(pk.Steps, "设封面："+pk.Cover.Path)
	}
	pk.Steps = append(pk.Steps, "填标题、简介、标签", "发布后回到这条发布记录，回填稿件链接")
	writeJSON(w, http.StatusOK, map[string]any{"data": pk})
}
