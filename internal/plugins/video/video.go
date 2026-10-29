// Package video 是「视频创作」插件的后端（VID-01a 起）。清单 plugin.json 只有这一份，前端构建时也读它。
// 系列、视频、检查点、发布记录落在插件表 video_series、video_videos、video_checkpoints、video_publishes，
// 产出物和验收记录（VID-01b）落在 video_artifacts、video_artifact_reviews，形状同原型 web-next/src/videodata.ts。
// 阶段执行器（VID-03b）落在 video_runners、video_runs，经 Core.Runs 发起技能（本机 Claude Code）、SOP、Agent。
// 内容平台连接器是 VID-04，本插件现在不访问任何外部服务。
// 接口契约见 docs/api-contract.md「视频创作插件 video」。
package video

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Plugin 是视频插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct{ m plugin.Manifest }

func New() *Plugin { return &Plugin{m: plugin.MustParse(manifestJSON)} }

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用（CORE-05）。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

func (p *Plugin) Register(r plugin.Registrar) error {
	h := &handler{c: r.Core()}
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/video/series", h.listSeries)
		m.HandleFunc("POST /api/video/series", h.addSeries)
		m.HandleFunc("GET /api/video/series/{id}", h.showSeries)
		m.HandleFunc("PATCH /api/video/series/{id}", h.updateSeries)
		m.HandleFunc("DELETE /api/video/series/{id}", h.removeSeries)
		m.HandleFunc("GET /api/video/videos", h.listVideos)
		m.HandleFunc("POST /api/video/videos", h.addVideo)
		m.HandleFunc("GET /api/video/videos/{id}", h.showVideo)
		m.HandleFunc("PATCH /api/video/videos/{id}", h.updateVideo)
		m.HandleFunc("DELETE /api/video/videos/{id}", h.removeVideo)
		m.HandleFunc("POST /api/video/videos/{id}/advance", h.advance)
		m.HandleFunc("POST /api/video/videos/{id}/checkpoints/{stage}", h.decide)
		m.HandleFunc("PUT /api/video/videos/{id}/runners/{stage}", h.putRunner)
		m.HandleFunc("DELETE /api/video/videos/{id}/runners/{stage}", h.removeRunner)
		m.HandleFunc("POST /api/video/videos/{id}/runners/{stage}/run", h.runStage)
		m.HandleFunc("GET /api/video/publishes", h.listPublishes)
		m.HandleFunc("POST /api/video/publishes", h.addPublish)
		m.HandleFunc("GET /api/video/publishes/{id}", h.showPublish)
		m.HandleFunc("PATCH /api/video/publishes/{id}", h.updatePublish)
		m.HandleFunc("DELETE /api/video/publishes/{id}", h.removePublish)
		m.HandleFunc("GET /api/video/artifacts", h.listArtifacts)
		m.HandleFunc("POST /api/video/artifacts", h.addArtifact)
		m.HandleFunc("GET /api/video/artifacts/{id}", h.showArtifact)
		m.HandleFunc("PATCH /api/video/artifacts/{id}", h.updateArtifact)
		m.HandleFunc("DELETE /api/video/artifacts/{id}", h.removeArtifact)
		m.HandleFunc("POST /api/video/artifacts/{id}/reviews", h.review)
		m.HandleFunc("POST /api/video/artifacts/{id}/bump", h.bump)
		m.HandleFunc("GET /api/video/topics", h.listTopics)
		m.HandleFunc("POST /api/video/topics", h.addTopic)
		m.HandleFunc("GET /api/video/topics/{id}", h.showTopic)
		m.HandleFunc("PATCH /api/video/topics/{id}", h.updateTopic)
		m.HandleFunc("DELETE /api/video/topics/{id}", h.removeTopic)
		m.HandleFunc("POST /api/video/topics/{id}/make", h.makeVideo)
		m.HandleFunc("GET /api/video/clips", h.listClips)
		m.HandleFunc("POST /api/video/clips", h.addClip)
		m.HandleFunc("GET /api/video/clips/{id}", h.showClip)
		m.HandleFunc("PATCH /api/video/clips/{id}", h.updateClip)
		m.HandleFunc("DELETE /api/video/clips/{id}", h.removeClip)
		m.HandleFunc("POST /api/video/clips/{id}/topic", h.clipToTopic)
		m.HandleFunc("POST /api/video/clips/{id}/link", h.linkTopic)
	})
	r.Subscribe(plugin.RunFinishedEvent, h.onRunFinished)
	return nil
}

type handler struct {
	c plugin.Core
	// 0002 时登记的产出物补没补过（VID-02a，artifacts.go 的 upgradeLegacy）
	legacyMu   sync.Mutex
	legacyDone bool
	// 执行收尾一次只收一条：先登记产出物再标 done，读视频的人不会看到「done 了但产出物还是旧的」
	finishMu sync.Mutex
}

// 错误分类，对应信封里的 code
var (
	errValidation = errors.New("validation")
	errNotFound   = errors.New("not_found")
	errConflict   = errors.New("conflict")
)

func apiErr(kind error, format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{kind}, args...)...)
}

const maxBody = 1 << 20

// readBody 读 JSON 对象，出现 allowed 以外的字段 400。
func readBody(r *http.Request, allowed ...string) (map[string]json.RawMessage, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return nil, apiErr(errValidation, "读请求体失败：%v", err)
	}
	if len(body) > maxBody {
		return nil, apiErr(errValidation, "请求体超过 1MB")
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(body, &out); err != nil || out == nil {
		return nil, apiErr(errValidation, "请求体必须是 JSON 对象")
	}
	for k := range out {
		ok := false
		for _, a := range allowed {
			if k == a {
				ok = true
				break
			}
		}
		if !ok {
			return nil, apiErr(errValidation, "不认识的字段 %s", k)
		}
	}
	return out, nil
}

// fail 按内核的错误信封写回：{"error":{"code","message"}}。
func fail(w http.ResponseWriter, r *http.Request, c plugin.Core, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, errConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, errNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, errValidation):
		status, code = http.StatusBadRequest, "validation"
	default:
		c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	if code != "internal" {
		_, msg, _ = strings.Cut(msg, ": ")
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// 字段解析：传了才改。null 只在 nullable 的字段上认。

func isNull(v json.RawMessage) bool { return strings.TrimSpace(string(v)) == "null" }

func strField(raw map[string]json.RawMessage, key, label string, dst *string, limit int) error {
	v, ok := raw[key]
	if !ok {
		return nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return apiErr(errValidation, "%s 必须是字符串", label)
	}
	s = strings.TrimSpace(s)
	if n := len([]rune(s)); n > limit {
		return apiErr(errValidation, "%s 最多 %d 字", label, limit)
	}
	*dst = s
	return nil
}

func intField(raw map[string]json.RawMessage, key, label string, dst *int, lo, hi int) error {
	v, ok := raw[key]
	if !ok {
		return nil
	}
	var n int
	if err := json.Unmarshal(v, &n); err != nil {
		return apiErr(errValidation, "%s 必须是整数", label)
	}
	if n < lo || n > hi {
		return apiErr(errValidation, "%s 要在 %d 到 %d 之间", label, lo, hi)
	}
	*dst = n
	return nil
}

// timeField 认 RFC3339，存成 UTC；null 或空串清掉。
func timeField(raw map[string]json.RawMessage, key, label string, dst **string) error {
	v, ok := raw[key]
	if !ok {
		return nil
	}
	if isNull(v) {
		*dst = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return apiErr(errValidation, "%s 必须是时间字符串", label)
	}
	if s = strings.TrimSpace(s); s == "" {
		*dst = nil
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return apiErr(errValidation, "%s 不是合法的 RFC3339 时间", label)
	}
	out := t.UTC().Format(time.RFC3339)
	*dst = &out
	return nil
}
