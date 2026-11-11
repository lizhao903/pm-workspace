// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParseAudioDevices(t *testing.T) {
	out := `[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] MacBook Pro麦克风
[AVFoundation indev @ 0x123] [1] WeMeet Audio Device
[AVFoundation indev @ 0x123] [2] BlackHole 2ch
[in#0 @ 0x456] Error opening input: Input/output error
Error opening input file .
`
	devices := parseAudioDevices(out)
	if len(devices) != 3 {
		t.Fatalf("设备数 = %d，想要 3：%+v", len(devices), devices)
	}
	if devices[0].Index != 0 || devices[0].Name != "MacBook Pro麦克风" || devices[0].Virtual {
		t.Fatalf("第一个设备不对：%+v", devices[0])
	}
	if !devices[1].Virtual || devices[1].Name != "WeMeet Audio Device" {
		t.Fatalf("WeMeet 应该算虚拟声卡：%+v", devices[1])
	}
	if devices[2].Index != 2 || devices[2].Name != "BlackHole 2ch" || !devices[2].Virtual {
		t.Fatalf("BlackHole 不对：%+v", devices[2])
	}
}

func TestParseAudioDevicesEmpty(t *testing.T) {
	if got := parseAudioDevices("ffmpeg version 7.1\nError opening input file .\n"); len(got) != 0 {
		t.Fatalf("没有 audio devices 段时应该没有设备，得到 %+v", got)
	}
}

func TestIsVirtualAudioDevice(t *testing.T) {
	cases := map[string]bool{
		"BlackHole 2ch":         true,
		"Loopback Audio":        true,
		"WeMeet Audio Device":   true,
		"MacBook Pro麦克风":        false,
		"External Microphone":   false,
		"腾讯会议虚拟声卡":              true,
		"VB-Cable":              true,
		"Microsoft Teams Audio": true,
	}
	for name, want := range cases {
		if got := isVirtualAudioDevice(name); got != want {
			t.Errorf("isVirtualAudioDevice(%q) = %v，想要 %v", name, got, want)
		}
	}
}

// TestSystemCaptureLifecycle 用假进程验证开始/停止/清理这条状态机，不碰真设备。
func TestSystemCaptureLifecycle(t *testing.T) {
	dir := t.TempDir()
	c := &fakeCore{attachmentDir: dir}
	p := New()

	old := startCaptureProcess
	t.Cleanup(func() { startCaptureProcess = old })
	startCaptureProcess = func(_ string, _ int, out string) (*exec.Cmd, *bytes.Buffer, error) {
		// 先把 wav 占位内容写出来（模拟 ffmpeg 持续写文件），然后挂住等 SIGINT。
		cmd := exec.Command("sh", "-c", `dd if=/dev/zero of="$0" bs=1024 count=4 2>/dev/null; exec sleep 30`, out)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		return cmd, &stderr, cmd.Start()
	}

	ctx := context.Background()
	view, err := p.startSystemCapture(ctx, c, "rec_test", AudioDevice{Index: 1, Name: "WeMeet Audio Device"}, "ffmpeg")
	if err != nil {
		t.Fatalf("开始采集失败：%v", err)
	}
	if !view.Running || view.Device != 1 || view.DeviceName != "WeMeet Audio Device" {
		t.Fatalf("采集视图不对：%+v", view)
	}
	if p.captureView("rec_test") == nil || !p.anyCaptureRunning() {
		t.Fatal("开始后应该有正在进行的采集")
	}
	path := filepath.Join(dir, "recording", "rec_test", "capture.wav")
	// 假进程在后台写文件，等它落盘再继续。
	for i := 0; i < 40; i++ {
		if _, err := os.Stat(path); err == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("采集文件应该已经创建：%v", err)
	}

	st, err := p.stopCapture("rec_test")
	if err != nil {
		t.Fatalf("停止采集失败：%v", err)
	}
	if st.Path != path {
		t.Fatalf("停止后路径 = %q，想要 %q", st.Path, path)
	}
	if p.captureView("rec_test") != nil || p.anyCaptureRunning() {
		t.Fatal("停止后采集状态应该清掉")
	}
	if _, err := p.stopCapture("rec_test"); err == nil {
		t.Fatal("再次停止应该报没有在采集")
	}
}

// TestMixMicAndSystem 用 ffmpeg 造两条正弦波混音，验证混音命令和时长；没有 ffmpeg 就跳过。
func TestMixMicAndSystem(t *testing.T) {
	ffmpeg := findTool("", "ffmpeg")
	if ffmpeg == "" {
		t.Skip("没有 ffmpeg，跳过混音用例")
	}
	dir := t.TempDir()
	sysPath := filepath.Join(dir, "system.wav")
	micPath := filepath.Join(dir, "mic.webm")
	outPath := filepath.Join(dir, "mixed.wav")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(ffmpeg, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("造测试音频失败：%v %s", err, out)
		}
	}
	run("-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", sysPath)
	run("-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-ac", "1", "-ar", "16000", "-c:a", "libopus", micPath)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := mixMicAndSystem(ctx, ffmpeg, sysPath, micPath, outPath, 100); err != nil {
		t.Fatalf("混音失败：%v", err)
	}
	if d := probeDurationMs(ctx, findFFprobe(ffmpeg), outPath); d < 900 || d > 1400 {
		t.Fatalf("混音时长 = %dms，想要约 1000ms", d)
	}
}
