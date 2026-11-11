// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Package recording 是录音转写插件的后端（M1）：浏览器录的音频存进 attachments/recording/，
// 后台队列用本机 ffmpeg + whisper-cli 转写成带时间戳的文本，结果供前端展示、编辑与导出。
//
// 本地优先：音频和文本不出本机，唯一联网点是「下载模型」（network:model，可不用，手动放文件也行）。
// 接口契约见 docs/api-contract.md「录音转写插件 recording」，设计见 docs/recording-transcription-design.md。
package recording

import (
	"context"
	"embed"
	"io/fs"
	"sync"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

//go:embed plugin.json
var manifestJSON []byte

//go:embed migrations/*.sql
var migrationsFS embed.FS

//go:embed voiceprint.py
var voiceprintScript []byte

// Plugin 是录音转写插件的入口，cmd/pmw 用 Registry.Add 登记。
type Plugin struct {
	m plugin.Manifest

	// mu 守着下载状态和 worker 的 ctx（都在运行时改）。
	mu        sync.Mutex
	downloads map[string]*downloadState
	workerCtx context.Context

	// capMu 守着正在跑的系统音频采集（M6）：handlers 和退出时的清理都会读写。
	capMu    sync.Mutex
	captures map[string]*captureState
}

// New 建插件；清单写错（第一方插件）直接 panic。
func New() *Plugin {
	return &Plugin{m: plugin.MustParse(manifestJSON), downloads: map[string]*downloadState{}, captures: map[string]*captureState{}}
}

func (p *Plugin) Manifest() plugin.Manifest { return p.m }

// Migrations 是 migrations/ 下的 .sql，安装时由内核按文件名顺序应用。
func (p *Plugin) Migrations() fs.FS {
	sub, err := fs.Sub(migrationsFS, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// OnInstall 安装时补默认设置行（迁移只建表，不写数据）。
func (p *Plugin) OnInstall(ctx context.Context, c plugin.Core) error {
	return ensureSettings(ctx, c)
}

// Register 只登记：路由、常驻转写队列和 SOP 节点，不做 IO、不起协程。
func (p *Plugin) Register(r plugin.Registrar) error {
	h := &handlers{p: p, c: r.Core()}
	r.Routes(h.routes)
	// SOP 节点登记时按 kind 补上节点声明（TSK-0490，sopspec.go）
	r = plugin.WithSOPSpecs(r, sopSpecs)
	h.registerSOP(r)
	r.Job(plugin.Job{Name: "recording_worker", Every: 0, Run: func(ctx context.Context, c plugin.Core) error {
		return runWorker(ctx, p, c)
	}})
	// 插件停用/进程退出时把还在跑的系统音频采集收掉，别留孤儿 ffmpeg。
	r.Job(plugin.Job{Name: "recording_capture_guard", Every: 0, Run: func(ctx context.Context, _ plugin.Core) error {
		<-ctx.Done()
		p.stopAllCaptures()
		return nil
	}})
	return nil
}

// handlers 挂路由的处理函数。
type handlers struct {
	p *Plugin
	c plugin.Core
}

// routes 登记本插件的全部接口（路径都以 /api/recording/ 开头）。
func (h *handlers) routes(m plugin.RouteRegistrar) {
	m.HandleFunc("GET /api/recording/meta", h.getMeta)
	m.HandleFunc("GET /api/recording/recordings", h.listRecordings)
	m.HandleFunc("POST /api/recording/recordings", h.createRecording)
	m.HandleFunc("GET /api/recording/recordings/{id}", h.getRecording)
	m.HandleFunc("PATCH /api/recording/recordings/{id}", h.patchRecording)
	m.HandleFunc("DELETE /api/recording/recordings/{id}", h.deleteRecording)
	m.HandleFunc("POST /api/recording/recordings/{id}/audio", h.uploadAudio)
	m.HandleFunc("GET /api/recording/recordings/{id}/audio", h.getAudio)
	m.HandleFunc("GET /api/recording/audio-devices", h.listAudioDevices)
	m.HandleFunc("POST /api/recording/recordings/{id}/capture/start", h.startCapture)
	m.HandleFunc("GET /api/recording/recordings/{id}/capture", h.getCapture)
	m.HandleFunc("POST /api/recording/recordings/{id}/capture/stop", h.stopCapture)
	m.HandleFunc("DELETE /api/recording/recordings/{id}/capture", h.deleteCapture)
	m.HandleFunc("POST /api/recording/recordings/{id}/transcribe", h.retranscribe)
	m.HandleFunc("POST /api/recording/recordings/{id}/minutes", h.postMinutes)
	m.HandleFunc("POST /api/recording/recordings/{id}/sop", h.postSOP)
	m.HandleFunc("GET /api/recording/recordings/{id}/files", h.listFiles)
	m.HandleFunc("GET /api/recording/recordings/{id}/files/{name}", h.downloadFile)
	m.HandleFunc("POST /api/recording/recordings/{id}/todos/{index}/confirm", h.postConfirmTodo)
	m.HandleFunc("POST /api/recording/recordings/{id}/todos/{index}/ignore", h.postIgnoreTodo)
	m.HandleFunc("POST /api/recording/recordings/{id}/diarize", h.postDiarize)
	m.HandleFunc("GET /api/recording/recordings/{id}/speakers", h.listSpeakers)
	m.HandleFunc("PATCH /api/recording/recordings/{id}/speakers/{label}", h.patchSpeaker)
	m.HandleFunc("POST /api/recording/recordings/{id}/speakers/{label}/bind", h.bindSpeaker)
	m.HandleFunc("GET /api/recording/voiceprints", h.listVoiceprints)
	m.HandleFunc("DELETE /api/recording/voiceprints/{contact_id}", h.deleteVoiceprint)
	m.HandleFunc("GET /api/recording/settings", h.getSettings)
	m.HandleFunc("PUT /api/recording/settings", h.putSettings)
	m.HandleFunc("GET /api/recording/models", h.listModels)
	m.HandleFunc("POST /api/recording/models/{name}/download", h.downloadModel)
	m.HandleFunc("DELETE /api/recording/models/{name}", h.deleteModel)
}
