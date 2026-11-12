// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package tts

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// synthSem 让合成串行：indextts 每次加载模型要几十秒，并发跑只会更慢。
var synthSem = make(chan struct{}, 1)

// synthesize 把一段文字合成为 mp3：先调 indextts 出 wav，再用 ffmpeg 转 mp3。
// 全程在本机临时目录里做，不碰工程目录、不落库。
func synthesize(ctx context.Context, e resolved, text string) ([]byte, string, error) {
	select {
	case synthSem <- struct{}{}:
		defer func() { <-synthSem }()
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	voicePath := ""
	for _, v := range e.Voices {
		if v.Name == e.DefaultVoice {
			voicePath = v.Path
		}
	}
	if voicePath == "" {
		return nil, "", fmt.Errorf("没有可用音色")
	}

	dir, err := os.MkdirTemp("", "pmw-tts-")
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	wav := filepath.Join(dir, "out.wav")
	mp3 := filepath.Join(dir, "out.mp3")

	// 语速快 → duration_scale 小；indextts 的 duration_scale 是时长倍率。
	scale := 1 / e.Speed
	run := func(name string, args ...string) error {
		cmd := exec.CommandContext(ctx, name, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("%s：%s", err, tailString(stderr.String(), 600))
		}
		return nil
	}
	if err := run(e.bin, text, "-v", voicePath, "-o", wav, "-f", "--duration_scale", strconv.FormatFloat(scale, 'f', 3, 64)); err != nil {
		return nil, "", fmt.Errorf("indextts 合成失败：%w", err)
	}
	if _, err := os.Stat(wav); err != nil {
		return nil, "", fmt.Errorf("indextts 没有生成 wav 文件")
	}
	if err := run(e.ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-qscale:a", "2", mp3); err != nil {
		return nil, "", fmt.Errorf("ffmpeg 转 mp3 失败：%w", err)
	}
	audio, err := os.ReadFile(mp3)
	if err != nil {
		return nil, "", err
	}
	return audio, "audio/mpeg", nil
}

// tailString 只留错误输出的最后一段，避免把整段日志塞进接口错误。
func tailString(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-max:]
}
