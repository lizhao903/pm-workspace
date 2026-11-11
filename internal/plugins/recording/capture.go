// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

// 系统音频采集（M6）：浏览器 getUserMedia 只能拿麦克风，拿不到别的 App 的声音。
// 这里用本机 ffmpeg 的 avfoundation 输入抓一块音频设备（macOS 上要用虚拟声卡：
// BlackHole、Loopback、腾讯会议 WeMeet Audio Device 之类），录成 wav；需要麦克风时
// 前端同时用 MediaRecorder 录麦克风，停止后把两轨混成一条再转写。
// 浏览器「分享标签页声音」（getDisplayMedia）不需要本机设备，走原来的上传接口，不在这一层。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// AudioDevice 是系统里能采集的一块音频输入设备（GET /audio-devices 的一项）。
type AudioDevice struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Default bool   `json:"default"`
	Virtual bool   `json:"virtual"`
}

// RecordingCapture 是一次进行中的系统音频采集（录音详情里的 capture 字段）。
type RecordingCapture struct {
	Running    bool   `json:"running"`
	Device     int    `json:"device"`
	DeviceName string `json:"device_name"`
	StartedAt  string `json:"started_at"`
	DurationMs int64  `json:"duration_ms"`
}

// captureState 是插件内存里一次进行中的采集；停止后从 map 里删掉。
type captureState struct {
	Device     int
	DeviceName string
	StartedAt  time.Time
	Path       string
	cmd        *exec.Cmd
	stderr     *bytes.Buffer
	done       chan struct{}
	err        error // cmd.Wait 的结果，done 关闭后读安全
}

func (st *captureState) view() RecordingCapture {
	return RecordingCapture{
		Running:    true,
		Device:     st.Device,
		DeviceName: st.DeviceName,
		StartedAt:  st.StartedAt.UTC().Format(time.RFC3339),
		DurationMs: time.Since(st.StartedAt).Milliseconds(),
	}
}

// captureSupported 是系统音频采集的平台范围：先做 macOS（avfoundation）。
func captureSupported() bool { return runtime.GOOS == "darwin" }

// platformName 给界面提示当前平台。
func platformName() string { return runtime.GOOS }

// virtualDeviceHints 用来认出虚拟声卡；命中就标 virtual，界面上提示「这就是系统声音」。
var virtualDeviceHints = []string{
	"blackhole", "loopback", "soundflower", "vb-cable", "virtual", "aggregate",
	"wemeet", "we meet", "zoom", "teams audio", "parrot", "虚拟", "回环",
}

func isVirtualAudioDevice(name string) bool {
	low := strings.ToLower(name)
	for _, h := range virtualDeviceHints {
		if strings.Contains(low, h) {
			return true
		}
	}
	return false
}

// deviceLineRe 匹配 ffmpeg 列表里的「[0] 设备名」行。
var deviceLineRe = regexp.MustCompile(`^\s*\[[^\]]*\]\s*\[(\d+)\]\s+(.+?)\s*$`)

// parseAudioDevices 从 `ffmpeg -f avfoundation -list_devices true -i ""` 的 stderr 里
// 只取 audio devices 段：`[AVFoundation indev @ 0x…] AVFoundation audio devices:` 之后的行。
func parseAudioDevices(output string) []AudioDevice {
	var out []AudioDevice
	inAudio := false
	for _, line := range strings.Split(output, "\n") {
		low := strings.ToLower(line)
		if strings.Contains(low, "audio devices") {
			inAudio = true
			continue
		}
		if strings.Contains(low, "video devices") {
			inAudio = false
			continue
		}
		if !inAudio {
			continue
		}
		m := deviceLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		idx, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		name := strings.TrimSpace(m[2])
		if name == "" {
			continue
		}
		out = append(out, AudioDevice{Index: idx, Name: name, Virtual: isVirtualAudioDevice(name)})
	}
	return out
}

// defaultInputName 用 system_profiler 找默认输入设备名（macOS）；拿不到就返回空串。
func defaultInputName(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "system_profiler", "SPAudioDataType").Output()
	if err != nil {
		return ""
	}
	lines := strings.Split(string(out), "\n")
	current := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasSuffix(trimmed, ":") && !strings.Contains(trimmed, "Input") && !strings.Contains(trimmed, "Output") {
			current = strings.TrimSuffix(trimmed, ":")
			continue
		}
		if strings.Contains(trimmed, "Default Input Device: Yes") && current != "" {
			return current
		}
	}
	return ""
}

// listAudioDevices 列出本机能采集的音频设备；非 macOS 返回空表（supported=false）。
func listAudioDevices(ctx context.Context, ffmpeg string) ([]AudioDevice, error) {
	if !captureSupported() {
		return nil, nil
	}
	if ffmpeg == "" {
		return nil, errors.New("没找到 ffmpeg，先 brew install ffmpeg")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// ffmpeg 的 -list_devices 会把列表写到 stderr，然后以非 0 退出；这是正常的。
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	_ = cmd.Run()
	devices := parseAudioDevices(stderr.String())
	if def := defaultInputName(ctx); def != "" {
		for i := range devices {
			if devices[i].Name == def {
				devices[i].Default = true
			}
		}
	}
	return devices, nil
}

// startCaptureProcess 是启动 ffmpeg 采集的可替换点，测试里换成假进程。
var startCaptureProcess = func(ffmpeg string, device int, out string) (*exec.Cmd, *bytes.Buffer, error) {
	var stderr bytes.Buffer
	// avfoundation 的音频输入写法是 ":<设备号>"；直接录 16k 单声道 wav，转写时不用再转码。
	cmd := exec.Command(ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-f", "avfoundation", "-i", fmt.Sprintf(":%d", device),
		"-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out)
	cmd.Stderr = &stderr
	return cmd, &stderr, cmd.Start()
}

// startSystemCapture 给一条录音开一路系统音频采集，写 audioDir/capture.wav。
func (p *Plugin) startSystemCapture(ctx context.Context, c plugin.Core, recordingID string, device AudioDevice, ffmpeg string) (RecordingCapture, error) {
	if !captureSupported() {
		return RecordingCapture{}, apiErr(errValidation, "系统音频采集目前只支持 macOS；先用「麦克风」或浏览器的分享标签页声音")
	}
	dir := audioDir(c, recordingID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return RecordingCapture{}, fmt.Errorf("建音频目录失败：%w", err)
	}
	out := filepath.Join(dir, "capture.wav")
	_ = os.Remove(out)

	cmd, stderr, err := startCaptureProcess(ffmpeg, device.Index, out)
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return RecordingCapture{}, apiErr(errValidation, "启动系统音频采集失败：%s", clip(msg, 300))
	}
	st := &captureState{
		Device: device.Index, DeviceName: device.Name, StartedAt: time.Now(),
		Path: out, cmd: cmd, stderr: stderr, done: make(chan struct{}),
	}
	p.capMu.Lock()
	p.captures[recordingID] = st
	p.capMu.Unlock()
	go func() {
		st.err = cmd.Wait()
		close(st.done)
	}()
	return st.view(), nil
}

// captureView 回一条录音正在进行的采集，没有回 nil。
func (p *Plugin) captureView(recordingID string) *RecordingCapture {
	p.capMu.Lock()
	defer p.capMu.Unlock()
	st := p.captures[recordingID]
	if st == nil {
		return nil
	}
	v := st.view()
	return &v
}

// anyCaptureRunning 表示已经有录音在采集：同一时间只允许一路，免得抢同一个音频设备。
func (p *Plugin) anyCaptureRunning() bool {
	p.capMu.Lock()
	defer p.capMu.Unlock()
	return len(p.captures) > 0
}

// stopCapture 停掉采集（SIGINT 让 ffmpeg 把 wav 头写完整），等进程退出后把状态从 map 里删掉。
func (p *Plugin) stopCapture(recordingID string) (*captureState, error) {
	p.capMu.Lock()
	st := p.captures[recordingID]
	p.capMu.Unlock()
	if st == nil {
		return nil, apiErr(errNotFound, "这条录音没有正在进行的系统音频采集")
	}
	if st.cmd.Process != nil {
		_ = st.cmd.Process.Signal(os.Interrupt)
	}
	select {
	case <-st.done:
	case <-time.After(10 * time.Second):
		if st.cmd.Process != nil {
			_ = st.cmd.Process.Kill()
		}
		<-st.done
	}
	p.capMu.Lock()
	delete(p.captures, recordingID)
	p.capMu.Unlock()

	// ffmpeg 收到 SIGINT 后可能以非 0 退出，以文件为准；文件不存在或为空才算没采到。
	fi, err := os.Stat(st.Path)
	if err != nil || fi.Size() == 0 {
		msg := ""
		if st.stderr != nil {
			msg = clip(strings.TrimSpace(st.stderr.String()), 300)
		}
		if msg == "" && err != nil {
			msg = err.Error()
		}
		if msg == "" {
			msg = "没有产出音频（设备可能被占用，或系统拒绝了录音权限）"
		}
		return st, apiErr(errValidation, "没采到系统声音：%s", msg)
	}
	return st, nil
}

// dropCapture 放弃一次采集：停掉进程并删掉临时文件（录音本身由调用方删）。
func (p *Plugin) dropCapture(recordingID string) error {
	st, err := p.stopCapture(recordingID)
	if st != nil {
		_ = os.Remove(st.Path)
	}
	return err
}

// stopAllCaptures 在插件停用/进程退出时把还在跑的采集都收掉，避免 ffmpeg 变孤儿进程。
func (p *Plugin) stopAllCaptures() {
	p.capMu.Lock()
	ids := make([]string, 0, len(p.captures))
	for id := range p.captures {
		ids = append(ids, id)
	}
	p.capMu.Unlock()
	for _, id := range ids {
		_, _ = p.stopCapture(id)
	}
}

// mixMicAndSystem 把系统声音（wav）和麦克风（webm/mp4/wav）混成一条 16k 单声道 wav。
// micOffsetMs 是「系统采集开始」时麦克风已经录了多久：先起麦克风、再起系统采集，
// 混音时把麦克风开头多出来的这段裁掉，让两轨对齐。
func mixMicAndSystem(ctx context.Context, ffmpeg, systemPath, micPath, outPath string, micOffsetMs int64) error {
	if ffmpeg == "" {
		return errors.New("没找到 ffmpeg，混不了麦克风和系统声音")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	micFilter := "[1:a]"
	if micOffsetMs > 0 {
		micFilter = fmt.Sprintf("[1:a]atrim=start=%.3f,asetpts=PTS-STARTPTS", float64(micOffsetMs)/1000)
	}
	filter := micFilter + "[mic];[0:a][mic]amix=inputs=2:duration=longest:normalize=0[a]"
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
		"-i", systemPath, "-i", micPath,
		"-filter_complex", filter, "-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("混合麦克风和系统声音失败：%s", clip(msg, 500))
	}
	fi, err := os.Stat(outPath)
	if err != nil || fi.Size() == 0 {
		return errors.New("混合麦克风和系统声音失败：没有产出音频")
	}
	return nil
}

// convertToWav 已在 transcribe.go；这里复用同一 ffmpeg 参数把浏览器分享的音频转成 wav 时调它。

// probeDurationMs 用 ffprobe 读音频时长；失败回 0（调用方用计时兜底）。
func probeDurationMs(ctx context.Context, ffprobe, path string) int64 {
	if ffprobe == "" {
		return 0
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path).Output()
	if err != nil {
		return 0
	}
	sec, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil || sec <= 0 {
		return 0
	}
	return int64(sec * 1000)
}

// findFFprobe 找 ffprobe：先看 ffmpeg 同目录，再走 PATH/Homebrew。
func findFFprobe(ffmpeg string) string {
	if ffmpeg != "" {
		p := filepath.Join(filepath.Dir(ffmpeg), "ffprobe")
		if isExecutable(p) {
			return p
		}
	}
	return findTool("", "ffprobe")
}
