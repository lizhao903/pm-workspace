package video

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
)

// 平台发布规则和发布前校验（VID-05a），同原型 PLATFORM_RULES、checkPublish：
// 新建、修改发布记录时按规则算一遍存在 checks 上，有一项不过就不能切到「已定时」、不能经连接器投稿。

// PlatformRule 同原型 PlatformRule。
type PlatformRule struct {
	Platform       string   `json:"platform"`
	TitleMax       int      `json:"title_max"`
	DescMax        int      `json:"desc_max"`
	TagsMax        int      `json:"tags_max"`
	AllowLink      bool     `json:"allow_link"`
	Cover          []string `json:"cover"`
	DurationMaxSec int      `json:"duration_max_sec,omitempty"`
	Categories     []string `json:"categories,omitempty"`
}

// PlatformRules 同原型 PLATFORM_RULES，封面比例取 PlatformCovers。
var PlatformRules = map[string]PlatformRule{
	"bilibili":    {Platform: "bilibili", TitleMax: 80, DescMax: 2000, TagsMax: 10, AllowLink: false, Cover: PlatformCovers["bilibili"], Categories: []string{"知识", "科技", "生活"}},
	"youtube":     {Platform: "youtube", TitleMax: 100, DescMax: 5000, TagsMax: 15, AllowLink: true, Cover: PlatformCovers["youtube"], Categories: []string{"教育", "科学和技术", "人物和博客"}},
	"douyin":      {Platform: "douyin", TitleMax: 30, DescMax: 1000, TagsMax: 5, AllowLink: false, Cover: PlatformCovers["douyin"], DurationMaxSec: 900},
	"channels":    {Platform: "channels", TitleMax: 30, DescMax: 1000, TagsMax: 10, AllowLink: false, Cover: PlatformCovers["channels"], DurationMaxSec: 3600},
	"xiaohongshu": {Platform: "xiaohongshu", TitleMax: 20, DescMax: 1000, TagsMax: 10, AllowLink: false, Cover: PlatformCovers["xiaohongshu"], DurationMaxSec: 900},
}

// PublishCheck 同原型 PublishCheck。
type PublishCheck struct {
	Key  string `json:"key"`
	OK   bool   `json:"ok"`
	Text string `json:"text"`
}

// CheckInput 是要校验的内容：cover 是封面比例，duration 是成片秒数，没有就不查。
type CheckInput struct {
	Title, Desc string
	Tags        []string
	Cover       string
	Duration    int
}

var linkRe = regexp.MustCompile(`(?i)https?://|www\.`)

// checkPublish 同原型 checkPublish：字数按字符算，文案也一样。
func checkPublish(platform string, x CheckInput) []PublishCheck {
	r, ok := PlatformRules[platform]
	if !ok {
		return nil
	}
	label := PlatformLabels[platform]
	n := func(s string) int { return len([]rune(strings.TrimSpace(s))) }
	tl, dl, gl := n(x.Title), n(x.Desc), len(x.Tags)
	out := []PublishCheck{
		check("title", tl <= r.TitleMax, fmt.Sprintf("标题 %d / %d 字", tl, r.TitleMax), fmt.Sprintf("标题超长：%s最多 %d 字，现在 %d 字", label, r.TitleMax, tl)),
		check("desc", dl <= r.DescMax, fmt.Sprintf("简介 %d / %d 字", dl, r.DescMax), fmt.Sprintf("简介超长：%s最多 %d 字，现在 %d 字", label, r.DescMax, dl)),
		check("tags", gl <= r.TagsMax, fmt.Sprintf("标签 %d / %d 个", gl, r.TagsMax), fmt.Sprintf("标签太多：%s最多 %d 个，现在 %d 个", label, r.TagsMax, gl)),
	}
	if !r.AllowLink {
		link := linkRe.MatchString(x.Desc)
		out = append(out, check("link", !link, "简介没有外链", "简介带外链："+label+"不允许放链接"))
	}
	if x.Cover != "" {
		names := make([]string, len(r.Cover))
		for i, k := range r.Cover {
			names[i] = CoverRatioLabels[k]
		}
		out = append(out, check("cover", slices.Contains(r.Cover, x.Cover), "封面 "+CoverRatioLabels[x.Cover]+" 符合要求", "封面比例不对："+label+"要 "+strings.Join(names, " 或 ")))
	}
	if r.DurationMaxSec > 0 && x.Duration > 0 {
		out = append(out, check("duration", x.Duration <= r.DurationMaxSec,
			fmt.Sprintf("时长 %d 分钟，没超过 %d 分钟", int(math.Ceil(float64(x.Duration)/60)), r.DurationMaxSec/60),
			fmt.Sprintf("时长超出：%s最长 %d 分钟", label, r.DurationMaxSec/60)))
	}
	return out
}

func check(key string, ok bool, yes, no string) PublishCheck {
	if ok {
		return PublishCheck{Key: key, OK: true, Text: yes}
	}
	return PublishCheck{Key: key, OK: false, Text: no}
}

// firstFailed 是第一项没通过的说明，都通过回空串。
func firstFailed(cs []PublishCheck) string {
	for _, c := range cs {
		if !c.OK {
			return c.Text
		}
	}
	return ""
}

// publishChecks 按发布记录现在的内容算校验：封面比例取封面产出物的，时长取同方向最新一版成片的。
func (h *handler) publishChecks(ctx context.Context, p Publish) ([]PublishCheck, error) {
	in := CheckInput{Title: p.Title, Desc: p.Desc, Tags: p.Tags}
	if p.CoverID != "" {
		a, err := h.getArtifact(ctx, p.CoverID)
		if err == nil {
			in.Cover = a.Ratio
		} else if !errors.Is(err, errNotFound) {
			return nil, err
		}
	}
	var dur *int64
	rows, err := h.c.Store().Query(ctx, `SELECT duration FROM video_artifacts WHERE video_id = ? AND kind = 'video' AND variant = ?
		ORDER BY version DESC, created_at DESC, rowid DESC LIMIT 1`, p.VideoID, p.Variant)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		if err := rows.Scan(&dur); err != nil {
			_ = rows.Close()
			return nil, err
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if dur != nil {
		in.Duration = int(*dur)
	}
	return checkPublish(p.Platform, in), nil
}
