// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package tts 是语音合成插件（TTS-01）：把本机 IndexTTS 配音能力接进工作台。
//
// 目标是「零配置」：不建连接器也能用——插件自动检测 indextts 命令、音色目录和默认音色
// （优先 voice-broleez），视频插件的「配音」直接取这里的默认值。要换引擎/音色/语速时，
// 到 设置 → 连接器 → 语音合成 建一个实例覆盖默认值，不建就一直用自动检测的结果。
// 本插件没有自己的表，配置都在连接器实例里。
package tts

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

// VoiceTool 是本插件登记的唯一连接器工具：设置 → 连接器 → 语音合成。
const VoiceTool = "voice"

// Plugin 是语音合成插件。
type Plugin struct {
	c plugin.Core
}

// New 新建插件。
func New() *Plugin { return &Plugin{} }

// Manifest 返回清单。
func (*Plugin) Manifest() plugin.Manifest { return plugin.MustParse(manifestJSON) }

// Migrations 没有自己的表。
func (*Plugin) Migrations() fs.FS { return nil }

// Register 登记连接器和接口。
func (p *Plugin) Register(r plugin.Registrar) error {
	p.c = r.Core()
	r.Connector(p.connectorDef())
	r.Routes(func(m plugin.RouteRegistrar) {
		m.HandleFunc("GET /api/tts/voices", p.handleVoices)
		m.HandleFunc("GET /api/tts/status", p.handleStatus)
		m.HandleFunc("POST /api/tts/preview", p.handlePreview)
	})
	return nil
}

// connectorDef 是「语音合成」连接器：字段都可以留空，留空就用自动检测的默认值。
func (p *Plugin) connectorDef() plugin.ConnectorDef {
	return plugin.ConnectorDef{
		Tool: VoiceTool, Label: "语音合成", Category: "media", Color: "#0f8a8a",
		Desc: "本机 IndexTTS 配音：自动检测音色目录和默认音色（优先 voice-broleez），也能换音色、语速；留空即用默认",
		Auth: []connector.AuthMode{connector.AuthNone},
		Fields: []connector.Field{
			{Key: "engine", Label: "引擎", Kind: "select", Options: []string{"indextts"}, Default: "indextts"},
			{Key: "voice", Label: "默认音色", Kind: "text", Placeholder: "留空自动选（优先 voice-broleez）"},
			{Key: "voice_dir", Label: "音色目录", Kind: "text", Placeholder: "留空自动找 web-video 目录下的 .voice.pt"},
			{Key: "speed", Label: "语速", Kind: "text", Placeholder: "0.5 – 2.0，默认 1.0", Default: "1.0"},
			{Key: "bin", Label: "indextts 路径", Kind: "text", Placeholder: "留空自动在 PATH 里找"},
			{Key: "ffmpeg", Label: "ffmpeg 路径", Kind: "text", Placeholder: "留空自动在 PATH 里找"},
		},
		Test: p.test,
	}
}

// test 是连接器的连通测试：能检测到引擎和音色就算通，回一句给人看的说明。
func (p *Plugin) test(ctx context.Context, cfg plugin.ConnectorConfig) (string, error) {
	vals := map[string]string{}
	for _, k := range configKeys {
		vals[k] = strings.TrimSpace(cfg.Get(k))
	}
	e := resolveValues(ctx, vals, true, "", "")
	if e.bin == "" {
		return "", errors.New("没找到 indextts 命令：先安装 IndexTTS-MLX（uv tool install -e .），或在连接器里填 indextts 路径")
	}
	if len(e.Voices) == 0 {
		return "", errors.New("没找到音色文件（*.voice.pt）：在连接器里填音色目录，或把音色放到 web-video 目录下")
	}
	acct := "本机 IndexTTS · " + strconv.Itoa(len(e.Voices)) + " 个音色"
	if e.DefaultVoice != "" {
		acct += "（默认 " + e.DefaultVoice + "）"
	}
	return acct, nil
}

// handleVoices 给视频插件的「配音」选项用：可用音色、默认音色和检测结果。
func (p *Plugin) handleVoices(w http.ResponseWriter, r *http.Request) {
	e := p.effective(r.Context(), "", "")
	respondData(w, map[string]any{
		"engine":        e.Engine,
		"voice_dir":     e.VoiceDir,
		"default_voice": e.DefaultVoice,
		"voices":        e.Voices,
		"configured":    e.Configured,
		"warnings":      e.Warnings,
	}, len(e.Voices))
}

// handleStatus 是完整检测结果，给设置页和排查用。
func (p *Plugin) handleStatus(w http.ResponseWriter, r *http.Request) {
	e := p.effective(r.Context(), "", "")
	respondData(w, map[string]any{
		"engine":        e.Engine,
		"bin":           e.bin,
		"ffmpeg":        e.ffmpeg,
		"voice_dir":     e.VoiceDir,
		"default_voice": e.DefaultVoice,
		"speed":         e.Speed,
		"voices":        e.Voices,
		"configured":    e.Configured,
		"warnings":      e.Warnings,
		"ready":         e.bin != "" && e.ffmpeg != "" && len(e.Voices) > 0,
	}, len(e.Voices))
}

// previewReq 是 POST /api/tts/preview 的请求体：试听一段口播，不落库、不写工程目录。
type previewReq struct {
	Text  string   `json:"text"`
	Voice string   `json:"voice"`
	Speed *float64 `json:"speed"`
}

// handlePreview 现场合成一段文字，直接回 mp3，用来试听音色/语速。
func (p *Plugin) handlePreview(w http.ResponseWriter, r *http.Request) {
	if p.c != nil && !p.c.Granted("process:spawn") {
		fail(w, r, p.c, http.StatusBadRequest, "validation", "语音合成要起本机 indextts，先到插件管理给语音合成插件确认「起子进程」（process:spawn）权限")
		return
	}
	var in previewReq
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&in); err != nil {
		fail(w, r, p.c, http.StatusBadRequest, "validation", "请求体不是合法 JSON")
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" {
		fail(w, r, p.c, http.StatusBadRequest, "validation", "要合成的文字必填")
		return
	}
	if n := len([]rune(text)); n > 2000 {
		fail(w, r, p.c, http.StatusBadRequest, "validation", "试听最多 2000 字")
		return
	}
	speed := ""
	if in.Speed != nil {
		speed = strconv.FormatFloat(*in.Speed, 'f', 2, 64)
	}
	e := p.effective(r.Context(), strings.TrimSpace(in.Voice), speed)
	if msg := e.blocking(); msg != "" {
		fail(w, r, p.c, http.StatusBadRequest, "validation", msg)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
	defer cancel()
	audio, format, err := synthesize(ctx, e, text)
	if err != nil {
		fail(w, r, p.c, http.StatusBadGateway, "internal", "语音合成失败："+err.Error())
		return
	}
	w.Header().Set("Content-Type", format)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(audio)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(audio)
}

// effective 读连接器实例（有就覆盖），没有就用自动检测的默认值。
func (p *Plugin) effective(ctx context.Context, voiceOverride, speedOverride string) resolved {
	vals, configured := p.configuredValues(ctx)
	return resolveValues(ctx, vals, configured, voiceOverride, speedOverride)
}

// configuredValues 取第一个「语音合成」连接器实例的配置；没建实例返回 nil, false。
func (p *Plugin) configuredValues(ctx context.Context) (map[string]string, bool) {
	if p.c == nil {
		return nil, false
	}
	list, err := p.c.Connectors().List(ctx, VoiceTool)
	if err != nil || len(list) == 0 {
		return nil, false
	}
	vals := map[string]string{}
	_ = p.c.Connectors().With(ctx, list[0].ID, func(cfg plugin.ConnectorConfig) error {
		for _, k := range configKeys {
			vals[k] = strings.TrimSpace(cfg.Get(k))
		}
		return nil
	})
	return vals, true
}

// configKeys 是连接器实例里本插件认的配置项。
var configKeys = []string{"engine", "voice", "voice_dir", "speed", "bin", "ffmpeg"}

func respondData(w http.ResponseWriter, data any, total int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"data": data,
		"meta": map[string]int{"total": total, "limit": total, "offset": 0},
	})
}

// fail 和内核接口一致的错误体：{"error":{"code","message"}}。
func fail(w http.ResponseWriter, r *http.Request, c plugin.Core, status int, code, msg string) {
	if status >= 500 && c != nil {
		c.Log().Error("request failed", "method", r.Method, "path", r.URL.Path, "err", msg)
		msg = "语音合成内部错误"
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
