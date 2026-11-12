// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package tts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// voiceFile 是一个可用的音色：name 是文件名去掉 .voice.pt，path 是绝对路径。
type voiceFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// resolved 是一次合成/查询要用的有效配置：连接器实例覆盖自动检测的结果。
type resolved struct {
	Engine       string
	VoiceDir     string
	DefaultVoice string
	Voices       []voiceFile
	Speed        float64
	Configured   bool
	Warnings     []string

	bin    string
	ffmpeg string
}

// blocking 返回不能合成的原因；空串表示可以合成。
func (e resolved) blocking() string {
	switch {
	case e.bin == "":
		return "没找到 indextts 命令：先安装 IndexTTS-MLX（uv tool install -e .），或在 设置 → 连接器 → 语音合成 里填 indextts 路径"
	case e.ffmpeg == "":
		return "没找到 ffmpeg：先 brew install ffmpeg，或在 设置 → 连接器 → 语音合成 里填 ffmpeg 路径"
	case e.VoiceDir == "":
		return "没找到音色目录：把 .voice.pt 音色放到 web-video 目录，或在 设置 → 连接器 → 语音合成 里填音色目录"
	case len(e.Voices) == 0:
		return "音色目录里没有 .voice.pt 文件：" + e.VoiceDir
	}
	return ""
}

// resolveValues 把连接器配置（可为空）和自动检测结果合并成一次调用要用的配置。
// configured 表示是否真的建了连接器实例（只用来给前端提示，不影响取值）。
func resolveValues(_ context.Context, vals map[string]string, configured bool, voiceOverride, speedOverride string) resolved {
	e := resolved{Engine: "indextts", Speed: 1, Configured: configured, Warnings: []string{}}
	get := func(k string) string { return strings.TrimSpace(vals[k]) }

	if engine := get("engine"); engine != "" && engine != "indextts" {
		e.Warnings = append(e.Warnings, "只支持 indextts 引擎，已按 indextts 处理")
	}

	// 音色目录：连接器填了就用它，没填自动找；都找不到时取个默认目录显示给人看。
	dir := get("voice_dir")
	if dir == "" {
		dir = detectVoiceDir()
	}
	e.VoiceDir = dir
	e.Voices = listVoices(dir)

	// 默认音色：试听/视频配音的覆盖值 > 连接器 > 自动偏好（voice-broleez）> 第一个。
	voice := firstNonEmpty(voiceOverride, get("voice"))
	if voice != "" && !hasVoice(e.Voices, voice) {
		e.Warnings = append(e.Warnings, "音色「"+voice+"」不在音色目录里，已改用默认音色")
		voice = ""
	}
	if voice == "" {
		voice = preferredVoice(e.Voices)
	}
	e.DefaultVoice = voice

	// 语速：0.5 – 2.0，别的值给警告并用默认 1.0。
	speed := firstNonEmpty(speedOverride, get("speed"))
	if speed != "" {
		if f, err := strconv.ParseFloat(speed, 64); err == nil && f >= 0.5 && f <= 2.0 {
			e.Speed = f
		} else {
			e.Warnings = append(e.Warnings, "语速要在 0.5 到 2.0 之间，已用 1.0")
		}
	}

	e.bin = firstNonEmpty(get("bin"), findTool("indextts", indexttsCandidates()...))
	e.ffmpeg = firstNonEmpty(get("ffmpeg"), findTool("ffmpeg", ffmpegCandidates()...))
	if e.bin == "" {
		e.Warnings = append(e.Warnings, "没找到 indextts 命令，语音合成用不了；装好 IndexTTS-MLX 或在连接器里填路径")
	}
	if e.ffmpeg == "" {
		e.Warnings = append(e.Warnings, "没找到 ffmpeg，合成出来的 wav 转不了 mp3；装好 ffmpeg 或在连接器里填路径")
	}
	if e.VoiceDir == "" {
		e.Warnings = append(e.Warnings, "没找到音色目录（*.voice.pt），在连接器里填音色目录，或把音色放到 web-video 目录下")
	} else if len(e.Voices) == 0 {
		e.Warnings = append(e.Warnings, "音色目录里没有 .voice.pt 文件："+e.VoiceDir)
	}
	return e
}

// detectVoiceDir 从常见位置找带 .voice.pt 的音色目录；优先有 voice-broleez 的那个。
func detectVoiceDir() string {
	var first string
	for _, dir := range voiceDirCandidates() {
		voices := listVoices(dir)
		if len(voices) == 0 {
			continue
		}
		if first == "" {
			first = dir
		}
		if hasVoice(voices, preferredVoiceName) {
			return dir
		}
	}
	return first
}

// voiceDirCandidates 是自动检测音色目录的候选：环境变量、用户目录、本机常见挂载路径。
func voiceDirCandidates() []string {
	var out []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" || !filepath.IsAbs(p) {
			return
		}
		for _, x := range out {
			if x == p {
				return
			}
		}
		out = append(out, p)
	}
	add(os.Getenv("INDEXTTS_VOICE_DIR"))
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, "web-video"))
		add(filepath.Join(home, "Projects", "web-video"))
	}
	for _, pattern := range []string{
		"/Volumes/*/web-video",
		"/Volumes/*/*/web-video",
		"/Volumes/*/*/*/web-video",
		"/Users/*/web-video",
	} {
		matches, _ := filepath.Glob(pattern)
		sort.Strings(matches)
		for _, m := range matches {
			add(m)
		}
	}
	return out
}

// listVoices 列出目录下的 *.voice.pt，按名字排序；目录不存在或没有音色回空数组。
func listVoices(dir string) []voiceFile {
	out := []voiceFile{}
	if dir == "" {
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".voice.pt") {
			continue
		}
		out = append(out, voiceFile{
			Name: strings.TrimSuffix(e.Name(), ".voice.pt"),
			Path: filepath.Join(dir, e.Name()),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// preferredVoiceName 是零配置时的默认音色：本机一直在用的那个。
const preferredVoiceName = "voice-broleez"

// preferredVoice 挑默认音色：优先 voice-broleez，没有就取第一个。
func preferredVoice(voices []voiceFile) string {
	if hasVoice(voices, preferredVoiceName) {
		return preferredVoiceName
	}
	if len(voices) > 0 {
		return voices[0].Name
	}
	return ""
}

func hasVoice(voices []voiceFile, name string) bool {
	for _, v := range voices {
		if v.Name == name {
			return true
		}
	}
	return false
}

// findTool 先在 PATH 里找，再试几个常见安装位置；找到回绝对路径。
func findTool(name string, candidates ...string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// indexttsCandidates 是 indextts 命令的常见安装位置（uv tool 装在 ~/.local/bin）。
func indexttsCandidates() []string {
	var out []string
	if home, err := os.UserHomeDir(); err == nil {
		out = append(out, filepath.Join(home, ".local", "bin", "indextts"))
	}
	return append(out, "/opt/homebrew/bin/indextts", "/usr/local/bin/indextts")
}

// ffmpegCandidates 是 ffmpeg 的常见安装位置。
func ffmpegCandidates() []string {
	return []string{"/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"}
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x = strings.TrimSpace(x); x != "" {
			return x
		}
	}
	return ""
}
