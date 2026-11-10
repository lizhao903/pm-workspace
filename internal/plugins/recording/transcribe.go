// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Segment 是一段带时间戳的转写文本（毫秒），按 seq 排。
type Segment struct {
	Seq     int    `json:"seq"`
	StartMs int64  `json:"start_ms"`
	EndMs   int64  `json:"end_ms"`
	Text    string `json:"text"`
	Speaker string `json:"speaker"`
}

var whisperProgressRe = regexp.MustCompile(`progress\s*=\s*([0-9]+)%`)

// whisperJSON 是 whisper-cli -oj 输出的 JSON 里用得上的部分。
type whisperJSON struct {
	Transcription []struct {
		Offsets struct {
			From int64 `json:"from"`
			To   int64 `json:"to"`
		} `json:"offsets"`
		Text string `json:"text"`
	} `json:"transcription"`
}

// convertToWav 用 ffmpeg 把浏览器录的 webm/mp4（或上传的 wav/mp3）统一转成 16k 单声道 wav：
// whisper-cli 只认 flac、mp3、ogg、wav，不认 webm/mp4。
func convertToWav(ctx context.Context, ffmpeg, in, out string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
		"-i", in, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("ffmpeg 转码失败：%s", clip(msg, 500))
	}
	fi, err := os.Stat(out)
	if err != nil || fi.Size() == 0 {
		return errors.New("ffmpeg 转码失败：没有产出音频（文件可能损坏或没有音轨）")
	}
	return nil
}

// runWhisper 跑 whisper-cli：解析 stderr 的进度、读 -oj 输出的 JSON。
// 参数固定带 -nfa：本机 Homebrew + Metal 构建开 flash attention 会慢一个数量级。
func runWhisper(ctx context.Context, exe, modelPath, wav, language string, threads int, outPrefix string, audioLen time.Duration, onProgress func(int)) ([]Segment, error) {
	timeout := 10 * time.Minute
	if need := audioLen * 8; need > timeout {
		timeout = need
	}
	if timeout > 4*time.Hour {
		timeout = 4 * time.Hour
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{
		"-m", modelPath, "-f", wav, "-l", language, "-t", strconv.Itoa(threads),
		"-nfa", "-pp", "-oj", "-of", outPrefix, "--no-prints",
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 whisper-cli 失败：%w", err)
	}
	tail := &ringLines{max: 20}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			tail.add(line)
			if m := whisperProgressRe.FindStringSubmatch(line); len(m) > 1 {
				if pct, convErr := strconv.Atoi(m[1]); convErr == nil && onProgress != nil {
					onProgress(pct)
				}
			}
		}
	}()
	waitErr := cmd.Wait()
	wg.Wait()
	if waitErr != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, permanent(fmt.Errorf("转写超时（超过 %s），可换小模型或减少线程数再试", timeout))
		}
		return nil, fmt.Errorf("whisper-cli 退出异常：%s", clip(tail.String(), 1000))
	}
	return parseWhisperJSON(outPrefix + ".json")
}

// parseWhisperJSON 把 -oj 的结果转成段落；空文本的段丢掉。
func parseWhisperJSON(path string) ([]Segment, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读不到 whisper 输出的 JSON：%w", err)
	}
	var raw whisperJSON
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("whisper 输出的 JSON 解不开：%w", err)
	}
	segs := make([]Segment, 0, len(raw.Transcription))
	for _, t := range raw.Transcription {
		text := strings.TrimSpace(t.Text)
		if text == "" {
			continue
		}
		segs = append(segs, Segment{Seq: len(segs), StartMs: t.Offsets.From, EndMs: t.Offsets.To, Text: text})
	}
	return segs, nil
}

// ringLines 保留最后 max 行，失败时给错误信息用。
type ringLines struct {
	mu    sync.Mutex
	lines []string
	max   int
}

func (r *ringLines) add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, line)
	if len(r.lines) > r.max {
		r.lines = r.lines[len(r.lines)-r.max:]
	}
}

func (r *ringLines) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}

// transcribeAudio 是完整流水线：原始音频 → 16k wav → whisper-cli → 段落 + 全文。
func transcribeAudio(ctx context.Context, c plugin.Core, s Settings, rec recordingRow, onProgress func(int)) ([]Segment, string, error) {
	tools := detectTools(ctx, s)
	if !tools.Whisper.OK {
		return nil, "", permanent(errors.New(tools.Whisper.Error))
	}
	if !tools.FFmpeg.OK {
		return nil, "", permanent(errors.New(tools.FFmpeg.Error))
	}
	spec, ok := catalogByName[s.Model]
	if !ok {
		return nil, "", permanent(fmt.Errorf("模型 %s 不认识，到「设置 → 录音转写」里重新选", s.Model))
	}
	dir, err := effectiveModelDir(c, s)
	if err != nil {
		return nil, "", permanent(err)
	}
	modelPath := filepath.Join(dir, spec.file)
	if fi, statErr := os.Stat(modelPath); statErr != nil || fi.Size() != spec.bytes {
		return nil, "", permanent(fmt.Errorf("模型 %s 还没下载好（%s），到「设置 → 录音转写」里下载或手动放模型文件", s.Model, modelPath))
	}
	audioAbs, err := resolveAudioPath(c, rec.AudioPath)
	if err != nil {
		return nil, "", permanent(err)
	}
	if _, err := os.Stat(audioAbs); err != nil {
		return nil, "", permanent(fmt.Errorf("原始音频不见了：%w", err))
	}
	cache := c.CacheDir()
	if cache == "" {
		return nil, "", permanent(errors.New("没有可用的缓存目录，跑不了转写"))
	}
	tmpDir := filepath.Join(cache, "tmp", rec.ID)
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return nil, "", fmt.Errorf("建临时目录失败：%w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()
	wav := filepath.Join(tmpDir, "audio16k.wav")
	onProgress(2)
	if err := convertToWav(ctx, tools.FFmpeg.Path, audioAbs, wav); err != nil {
		return nil, "", err
	}
	onProgress(5)
	audioLen := time.Duration(rec.DurationMs) * time.Millisecond
	segs, err := runWhisper(ctx, tools.Whisper.Path, modelPath, wav, s.Language, effectiveThreads(s),
		filepath.Join(tmpDir, "out"), audioLen, func(pct int) {
			onProgress(5 + pct*90/100)
		})
	if err != nil {
		return nil, "", err
	}
	return segs, joinSegments(segs), nil
}

func joinSegments(segs []Segment) string {
	lines := make([]string, 0, len(segs))
	for _, s := range segs {
		lines = append(lines, s.Text)
	}
	return strings.Join(lines, "\n")
}
