// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

// 系统音频采集的 HTTP 接口（M6）：
//   GET    /api/recording/audio-devices                      列本机能采集的音频设备
//   POST   /api/recording/recordings/{id}/capture/start      开始采集（本机 ffmpeg + 虚拟声卡）
//   GET    /api/recording/recordings/{id}/capture            查采集状态（详情里也有 capture 字段）
//   POST   /api/recording/recordings/{id}/capture/stop       停止并保存，可带麦克风一起混音
//   DELETE /api/recording/recordings/{id}/capture            放弃采集、删临时文件

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// listAudioDevices 回本机的音频输入设备；非 macOS 也回 200，只是 supported=false。
func (h *handlers) listAudioDevices(w http.ResponseWriter, r *http.Request) {
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ffmpeg := findTool(s.FFmpegPath, "ffmpeg")
	devices, listErr := listAudioDevices(r.Context(), ffmpeg)
	errMsg := ""
	if listErr != nil {
		errMsg = listErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data": devices,
		"meta": map[string]any{
			"supported": captureSupported(),
			"platform":  runtimePlatform(),
			"ffmpeg":    ffmpeg != "",
			"error":     errMsg,
		},
	})
}

// startCapture 开始录系统声音（本机虚拟声卡）。录音先由前端 POST /recordings 建草稿。
func (h *handlers) startCapture(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:write:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := plugin.Require(h.c, "process:spawn"); err != nil {
		h.fail(w, r, err)
		return
	}
	var req struct {
		Device int `json:"device"`
	}
	if err := decodeBody(r, &req); err != nil {
		h.fail(w, r, err)
		return
	}
	if req.Device < 0 || req.Device > 99 {
		h.fail(w, r, apiErr(errValidation, "音频设备编号不合法：%d", req.Device))
		return
	}
	if !captureSupported() {
		h.fail(w, r, apiErr(errValidation, "系统音频采集目前只支持 macOS；先用「麦克风」或浏览器的「分享标签页声音」"))
		return
	}
	if rec.Status == "transcribing" || rec.Status == "summarizing" {
		h.fail(w, r, apiErr(errConflict, "录音「%s」正在转写/生成纪要，等它跑完再重新录", rec.Title))
		return
	}
	if h.p.anyCaptureRunning() {
		h.fail(w, r, apiErr(errConflict, "已经有一条录音在采集系统音频了，先把它停掉"))
		return
	}
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ffmpeg := findTool(s.FFmpegPath, "ffmpeg")
	if ffmpeg == "" {
		h.fail(w, r, apiErr(errValidation, "没找到 ffmpeg，先 brew install ffmpeg"))
		return
	}
	devices, err := listAudioDevices(r.Context(), ffmpeg)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var device *AudioDevice
	for i := range devices {
		if devices[i].Index == req.Device {
			device = &devices[i]
			break
		}
	}
	if device == nil {
		h.fail(w, r, apiErr(errValidation, "音频设备 %d 不在了，刷新设备列表再选", req.Device))
		return
	}
	// 重新录：旧任务作废，避免重复转写；旧音频等 stop 时再覆盖，录失败了原音频还在。
	_, _ = h.c.Store().Exec(r.Context(), `UPDATE recording_jobs SET status = 'failed', last_error = '音频重新录制', updated_at = ? WHERE recording_id = ? AND status IN ('pending','running')`,
		nowRFC(), rec.ID)
	view, err := h.p.startSystemCapture(r.Context(), h.c, rec.ID, *device, ffmpeg)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// getCapture 查当前采集状态；没有在进行就 404。
func (h *handlers) getCapture(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	view := h.p.captureView(rec.ID)
	if view == nil {
		h.fail(w, r, apiErr(errNotFound, "这条录音现在没有在采集系统音频"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": view})
}

// stopCapture 停采集并保存：可选带麦克风音频（multipart 字段 mic），后端混成一条再排队转写。
func (h *handlers) stopCapture(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:write:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	if err := plugin.Require(h.c, "process:spawn"); err != nil {
		h.fail(w, r, err)
		return
	}
	s, err := loadSettings(r.Context(), h.c)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	ffmpeg := findTool(s.FFmpegPath, "ffmpeg")
	if ffmpeg == "" {
		h.fail(w, r, apiErr(errValidation, "没找到 ffmpeg，保存不了系统音频"))
		return
	}
	dir := audioDir(h.c, rec.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		h.fail(w, r, fmt.Errorf("建音频目录失败：%w", err))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
	var micPath string
	micOffsetMs := int64(0)
	durationHint := int64(0)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			h.fail(w, r, apiErr(errValidation, "音频上传解析失败：%v", err))
			return
		}
		if v := r.FormValue("mic_offset_ms"); v != "" {
			micOffsetMs, _ = strconv.ParseInt(v, 10, 64)
		}
		if v := r.FormValue("duration_ms"); v != "" {
			durationHint, _ = strconv.ParseInt(v, 10, 64)
		}
		if file, header, ferr := r.FormFile("mic"); ferr == nil {
			defer func() { _ = file.Close() }()
			tmp := filepath.Join(dir, "mic.tmp")
			out, cerr := os.Create(tmp)
			if cerr != nil {
				h.fail(w, r, fmt.Errorf("写麦克风音频失败：%w", cerr))
				return
			}
			_, copyErr := io.Copy(out, file)
			closeErr := out.Close()
			if copyErr != nil || closeErr != nil {
				_ = os.Remove(tmp)
				h.fail(w, r, apiErr(errValidation, "麦克风音频没收到"))
				return
			}
			ext := sniffAudioExt(tmp, header.Header.Get("Content-Type"))
			p := filepath.Join(dir, "mic."+ext)
			if err := os.Rename(tmp, p); err != nil {
				_ = os.Remove(tmp)
				h.fail(w, r, fmt.Errorf("保存麦克风音频失败：%w", err))
				return
			}
			micPath = p
		}
	}
	if micOffsetMs < 0 {
		micOffsetMs = 0
	}

	st, err := h.p.stopCapture(rec.ID)
	if err != nil {
		if micPath != "" {
			_ = os.Remove(micPath)
		}
		h.fail(w, r, err)
		return
	}
	final := filepath.Join(dir, "audio.wav")
	if micPath != "" {
		mixed := filepath.Join(dir, "mixed.wav")
		if err := mixMicAndSystem(r.Context(), ffmpeg, st.Path, micPath, mixed, micOffsetMs); err != nil {
			// 保留系统轨和麦克风轨，用户可以重试保存（不丢录音）。
			h.fail(w, r, err)
			return
		}
		if err := os.Rename(mixed, final); err != nil {
			h.fail(w, r, fmt.Errorf("保存混合音频失败：%w", err))
			return
		}
		_ = os.Remove(st.Path)
		_ = os.Remove(micPath)
	} else {
		if err := os.Rename(st.Path, final); err != nil {
			h.fail(w, r, fmt.Errorf("保存系统音频失败：%w", err))
			return
		}
	}
	fi, err := os.Stat(final)
	if err != nil || fi.Size() == 0 {
		h.fail(w, r, apiErr(errValidation, "没录到声音：检查系统声音是否真的在播、虚拟声卡是否配好"))
		return
	}
	durationMs := probeDurationMs(r.Context(), findFFprobe(ffmpeg), final)
	if durationMs <= 0 {
		durationMs = durationHint
	}
	if durationMs <= 0 {
		durationMs = st.view().DurationMs
	}
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_jobs SET status = 'failed', last_error = '音频已重新录制', updated_at = ? WHERE recording_id = ? AND status IN ('pending','running')`,
		nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := h.c.Store().Exec(r.Context(), `UPDATE recording_recordings SET status = 'uploaded', audio_path = ?, audio_mime = ?, audio_size = ?, duration_ms = ?, error = '', attempts = 0, updated_at = ? WHERE id = ?`,
		audioRel(rec.ID, "wav"), audioMIMEByExt("wav"), fi.Size(), durationMs, nowRFC(), rec.ID); err != nil {
		h.fail(w, r, err)
		return
	}
	if _, err := createJob(r.Context(), h.c.Store(), rec.ID, "transcribe"); err != nil {
		h.fail(w, r, err)
		return
	}
	rec2, err := loadRecording(r.Context(), h.c.Store(), rec.ID)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	view, err := h.view(r, rec2)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"data": view})
}

// deleteCapture 放弃采集：停进程、删临时文件；录音本身由 DELETE /recordings/{id} 删。
func (h *handlers) deleteCapture(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.loadRecording(w, r)
	if !ok {
		return
	}
	if err := plugin.Require(h.c, "fs:write:attachments"); err != nil {
		h.fail(w, r, err)
		return
	}
	if h.p.captureView(rec.ID) != nil {
		if err := h.p.dropCapture(rec.ID); err != nil && !errors.Is(err, errValidation) {
			// 进程已经退出、文件也在，算放弃成功；只有真删不掉才报错。
			h.c.Log().Warn("recording: 放弃系统音频采集时清理失败", "recording", rec.ID, "err", err)
		}
	}
	dir := audioDir(h.c, rec.ID)
	_ = os.Remove(filepath.Join(dir, "capture.wav"))
	_ = os.Remove(filepath.Join(dir, "mixed.wav"))
	if matches, _ := filepath.Glob(filepath.Join(dir, "mic.*")); matches != nil {
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
}

// runtimePlatform 只给界面提示用。
func runtimePlatform() string { return platformName() }
