// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
)

// GitHub 版本更新收件（VID-10）：把公开仓库的 Release 一条一条收成版本更新素材（kind release），
// 之后照常「转为选题」做成版本更新说明视频。同原型素材收件箱的「拉取 GitHub 更新」。
//
// 只拉公开仓库的匿名 GitHub API（出网走 Core.HTTP("github")，域名清单 internal/plugin/network.go 只放
// api.github.com），不做 token、不碰私有仓库。没有新迁移：复用 video_clips.remote_id 去重，
// 存「github:owner/repo:tag_name」（0009 的唯一索引兜底），同一个 Release 拉几次都只落一份。
//
// 列表按 created_at DESC, rowid DESC 排，同一时刻落库的 rowid 大的在前；所以落库按 Release 从旧到新，
// 响应里的 data 再倒过来，新收的在前。不发事件、不记审计。

const (
	// githubAPI 是匿名 GitHub API；只读 Release，别的接口不碰。
	githubAPI = "https://api.github.com"
	// githubTimeout 是拉一次 Release 列表的总超时（含域名检查、重定向）。
	githubTimeout = 20 * time.Second
)

// githubRelease 是 GitHub Release 里用到的字段（GET /repos/{owner}/{repo}/releases 的一项）。
type githubRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
}

// releaseSkip 是这次没落库的一条 Release 和原因。
type releaseSkip struct {
	Tag    string `json:"tag"`
	Reason string `json:"reason"`
}

// githubHTTPError 是 GitHub API 回了非 200 的错误；404 在接口层是 400，其余是 502 fetch_failed。
type githubHTTPError struct {
	Status int
	Msg    string
}

func (e *githubHTTPError) Error() string { return e.Msg }

// pullGitHubReleases 是 POST /api/video/clips/github：{repo, limit?, include_prerelease?}，
// 立刻拉公开仓库的 Release 收进素材箱。
func (h *handler) pullGitHubReleases(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw, err := readBody(r, "repo", "limit", "include_prerelease")
	if err != nil {
		fail(w, r, h.c, err)
		return
	}
	var repoIn string
	if err := strField(raw, "repo", "repo", &repoIn, 500); err != nil {
		fail(w, r, h.c, err)
		return
	}
	owner, repo, ok := parseGitHubRepo(repoIn)
	if !ok {
		fail(w, r, h.c, apiErr(errValidation, "repo 要是 owner/repo 或者 GitHub 仓库地址"))
		return
	}
	limit := 30
	if err := intField(raw, "limit", "limit", &limit, 1, 100); err != nil {
		fail(w, r, h.c, err)
		return
	}
	var includePrerelease bool
	if err := boolField(raw, "include_prerelease", &includePrerelease); err != nil {
		fail(w, r, h.c, err)
		return
	}
	// 出网要清单声明过、用户确认过 network:github；升级到 0.10.0 后没确认的回 400，去插件管理确认。
	hc, err := h.c.HTTP("github")
	if err != nil {
		fail(w, r, h.c, apiErr(errValidation, "还不能访问 GitHub：去插件管理里确认视频插件的 network:github 权限"))
		return
	}
	releases, err := fetchGitHubReleases(ctx, hc, owner, repo, limit)
	if err != nil {
		var he *githubHTTPError
		if errors.As(err, &he) && he.Status == http.StatusNotFound {
			fail(w, r, h.c, apiErr(errValidation, "GitHub 上没有这个仓库，或者它不是公开仓库"))
			return
		}
		upstreamFail(w, "fetch_failed", err, map[string]any{"repo": owner + "/" + repo})
		return
	}

	// 从旧到新落库（见文件头），返回时再倒过来；added 只放新落的，重复的单独计数。
	added := []Clip{}
	duplicates := 0
	skipped := []releaseSkip{}
	for i := len(releases) - 1; i >= 0; i-- {
		rel := releases[i]
		tag := strings.TrimSpace(rel.TagName)
		switch {
		case rel.Draft:
			skipped = append(skipped, releaseSkip{Tag: tag, Reason: "草稿"})
			continue
		case rel.Prerelease && !includePrerelease:
			skipped = append(skipped, releaseSkip{Tag: tag, Reason: "预发布"})
			continue
		case tag == "":
			skipped = append(skipped, releaseSkip{Tag: tag, Reason: "没有版本号"})
			continue
		}
		c, ok, err := h.saveRelease(ctx, owner, repo, rel, tag)
		if err != nil {
			fail(w, r, h.c, err)
			return
		}
		if ok {
			added = append(added, c)
		} else {
			duplicates++
		}
	}
	out := make([]Clip, 0, len(added))
	for i := len(added) - 1; i >= 0; i-- {
		out = append(out, added[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": out, "meta": map[string]any{
		"repo": owner + "/" + repo, "added": len(added), "duplicates": duplicates,
		"releases": len(releases), "skipped": skipped,
	}})
}

// fetchGitHubReleases 拉一页 Release（按 GitHub 默认排序：新发布的在前）。非 200、网络错误、解析失败都回错误。
func fetchGitHubReleases(ctx context.Context, hc *http.Client, owner, repo string, limit int) ([]githubRelease, error) {
	ctx, cancel := context.WithTimeout(ctx, githubTimeout)
	defer cancel()
	u := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=%d", githubAPI, url.PathEscape(owner), url.PathEscape(repo), limit)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "pmw-video-plugin")
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连不上 GitHub：%w", err)
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, &githubHTTPError{Status: res.StatusCode, Msg: "GitHub 上没有这个仓库，或者它不是公开仓库"}
	case http.StatusForbidden, http.StatusTooManyRequests:
		if res.Header.Get("X-RateLimit-Remaining") == "0" {
			return nil, &githubHTTPError{Status: res.StatusCode, Msg: "GitHub 匿名接口限流了（每小时 60 次），稍后再试"}
		}
		return nil, &githubHTTPError{Status: res.StatusCode, Msg: fmt.Sprintf("GitHub 返回 %d", res.StatusCode)}
	default:
		return nil, &githubHTTPError{Status: res.StatusCode, Msg: fmt.Sprintf("GitHub 返回 %d", res.StatusCode)}
	}
	var out []githubRelease
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("GitHub 返回的数据解析不了：%w", err)
	}
	return out, nil
}

// saveRelease 落一条版本更新素材：标题取 tag（name 不空且不等于 tag 时拼上），内容取 Release 说明，
// 来源是「GitHub · owner/repo」，标签是版本号和发布日期；收过的回 false（remote_id 唯一索引兜底）。
func (h *handler) saveRelease(ctx context.Context, owner, repo string, rel githubRelease, tag string) (Clip, bool, error) {
	title := tag
	if name := strings.TrimSpace(rel.Name); name != "" && name != tag {
		title = tag + " " + name
	}
	c := Clip{
		ID:       idgen.Prefixed("cl"),
		Kind:     "release",
		Title:    cutRunes(title, 200),
		Content:  cutRunes(strings.TrimSpace(rel.Body), 5000),
		URL:      releaseURL(rel.HTMLURL),
		Source:   cutRunes("GitHub · "+owner+"/"+repo, 200),
		Tags:     releaseTags(tag, rel.PublishedAt),
		TopicIDs: []string{},
	}
	remote := cutRunes("github:"+owner+"/"+repo+":"+tag, 200)
	now := nowStr()
	tags, _ := json.Marshal(c.Tags)
	res, err := h.c.Store().Exec(ctx, `INSERT OR IGNORE INTO video_clips (`+clipCols+`, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.Kind, c.Title, c.Content, c.URL, c.Source, c.Heat, string(tags), b2i(c.Starred), b2i(c.Triaged), c.PublishID, c.MessageID, now, now, remote)
	if err != nil {
		return Clip{}, false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return Clip{}, false, err
	}
	c.CreatedAt, c.UpdatedAt = now, now
	return c, true, nil
}

// releaseURL 只收 http、https 链接，别的当没有（同素材链接的校验口径）。
func releaseURL(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return ""
	}
	return cutRunes(s, 2048)
}

// releaseTags 是版本号标签加发布日期（YYYY-MM-DD）；日期没给或认不出就只放版本号。
func releaseTags(tag, publishedAt string) []string {
	tags := []string{cutRunes(tag, 40)}
	if t, err := time.Parse(time.RFC3339, strings.TrimSpace(publishedAt)); err == nil {
		tags = append(tags, t.UTC().Format("2006-01-02"))
	}
	return tags
}

// parseGitHubRepo 把 owner/repo、https://github.com/owner/repo、结尾带 .git 或 / 的写法规整成 owner、repo；
// 别的写法（带分支、带子路径、不是 GitHub 域名）回 false。
func parseGitHubRepo(s string) (owner, repo string, ok bool) {
	s = strings.TrimSpace(s)
	low := strings.ToLower(s)
	for _, p := range []string{"https://github.com/", "http://github.com/", "github.com/"} {
		if strings.HasPrefix(low, p) {
			s = s[len(p):]
			break
		}
	}
	s = strings.TrimRight(s, "/")
	s = strings.TrimSuffix(s, ".git")
	s = strings.TrimRight(s, "/")
	parts := strings.Split(s, "/")
	if len(parts) != 2 || !validGitHubOwner(parts[0]) || !validGitHubRepoName(parts[1]) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// validGitHubOwner 是 GitHub 用户名/组织的形状：字母、数字、连字符，首尾不能是连字符，最多 39 个字符。
func validGitHubOwner(s string) bool {
	if s == "" || len(s) > 39 || strings.HasPrefix(s, "-") || strings.HasSuffix(s, "-") {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// validGitHubRepoName 是仓库名的形状：字母、数字、. _ -，不能是 . 或 ..，最多 100 个字符。
func validGitHubRepoName(s string) bool {
	if s == "" || s == "." || s == ".." || len(s) > 100 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
