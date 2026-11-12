// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// Settings 是录音插件的设置，存在 recording_settings 单行（id=1）。
// 模型目录、工具路径留空表示用默认：模型放 CacheDir()/models，whisper-cli/ffmpeg 自动探测。
type Settings struct {
	DefaultEngine      string  `json:"default_engine"`
	Model              string  `json:"model"`
	ModelDir           string  `json:"model_dir"`
	WhisperPath        string  `json:"whisper_path"`
	FFmpegPath         string  `json:"ffmpeg_path"`
	Language           string  `json:"language"`
	Threads            int     `json:"threads"`
	DefaultProjectID   string  `json:"default_project_id"`
	MinutesProvider    string  `json:"minutes_provider"`
	MinutesModel       string  `json:"minutes_model"`
	MinutesFlow        string  `json:"minutes_flow"`
	MinutesThreshold   float64 `json:"minutes_threshold"`
	AutoDiarize        bool    `json:"auto_diarize"`
	PythonPath         string  `json:"python_path"`
	VoiceprintModelDir string  `json:"voiceprint_model_dir"`
	MaxSpeakers        int     `json:"max_speakers"`
	MatchThreshold     float64 `json:"match_threshold"`
	AutoSummarize      bool    `json:"auto_summarize"`
	RetentionMode      string  `json:"retention_mode"`
	UpdatedAt          string  `json:"updated_at"`
}

const settingsCols = `default_engine, model, model_dir, whisper_path, ffmpeg_path, language, threads,
	default_project_id, minutes_provider, minutes_model, minutes_flow, minutes_threshold,
	auto_diarize, python_path, voiceprint_model_dir, max_speakers, match_threshold,
	auto_summarize, retention_mode, updated_at`

var (
	// engines 是设置里能选的引擎；云引擎 M4 再加 tencent_flash。
	engines = []string{"whisper_local"}
	// retentionModes 是音频保留策略：keep 一直留着；delete_audio_after_ready 只留 M3 之后清理。
	retentionModes = []string{"keep", "delete_audio_after_ready"}
	// languageRe 是 whisper-cli -l 的取值：auto 或 2–3 位小写语言码。
	languageRe = regexp.MustCompile(`^(auto|[a-z]{2,3})$`)
)

// defaultMinutesThreshold 是「高置信度」阈值的默认值（M4a）。
const defaultMinutesThreshold = 0.7

// M5 声纹默认值：最多 8 个说话人，余弦相似度 ≥ 0.65 算同一个人。
const (
	defaultMaxSpeakers    = 8
	defaultMatchThreshold = 0.65
)

// defaultSettings 是没设置过时的默认值。
func defaultSettings() Settings {
	return Settings{
		DefaultEngine:    "whisper_local",
		Model:            "small",
		Language:         "zh",
		Threads:          0,
		MinutesThreshold: defaultMinutesThreshold,
		AutoDiarize:      true,
		MaxSpeakers:      defaultMaxSpeakers,
		MatchThreshold:   defaultMatchThreshold,
		RetentionMode:    "keep",
	}
}

// ensureSettings 补默认设置行；安装时调一次，读设置读不到时再补一次。
func ensureSettings(ctx context.Context, c plugin.Core) error {
	_, err := c.Store().Exec(ctx,
		`INSERT OR IGNORE INTO recording_settings (id, updated_at) VALUES (1, ?)`, nowRFC())
	return err
}

// loadSettings 读设置；行不存在时先补默认行。
func loadSettings(ctx context.Context, c plugin.Core) (Settings, error) {
	if err := ensureSettings(ctx, c); err != nil {
		return Settings{}, err
	}
	var s Settings
	var autoDiarize, autoSummarize int
	err := c.Store().QueryRow(ctx, `SELECT `+settingsCols+` FROM recording_settings WHERE id = 1`).Scan(
		&s.DefaultEngine, &s.Model, &s.ModelDir, &s.WhisperPath, &s.FFmpegPath, &s.Language, &s.Threads,
		&s.DefaultProjectID, &s.MinutesProvider, &s.MinutesModel, &s.MinutesFlow, &s.MinutesThreshold,
		&autoDiarize, &s.PythonPath, &s.VoiceprintModelDir, &s.MaxSpeakers, &s.MatchThreshold,
		&autoSummarize, &s.RetentionMode, &s.UpdatedAt,
	)
	if err != nil {
		return Settings{}, err
	}
	s.AutoDiarize = autoDiarize != 0
	s.AutoSummarize = autoSummarize != 0
	return s, nil
}

// saveSettings 整行覆盖写，UpdatedAt 用当前时间。
func saveSettings(ctx context.Context, c plugin.Core, s Settings) error {
	s.UpdatedAt = nowRFC()
	_, err := c.Store().Exec(ctx, `UPDATE recording_settings SET default_engine = ?, model = ?, model_dir = ?,
		whisper_path = ?, ffmpeg_path = ?, language = ?, threads = ?, default_project_id = ?,
		minutes_provider = ?, minutes_model = ?, minutes_flow = ?, minutes_threshold = ?, auto_diarize = ?,
		python_path = ?, voiceprint_model_dir = ?, max_speakers = ?, match_threshold = ?, auto_summarize = ?,
		retention_mode = ?, updated_at = ? WHERE id = 1`,
		s.DefaultEngine, s.Model, s.ModelDir, s.WhisperPath, s.FFmpegPath, s.Language, s.Threads,
		s.DefaultProjectID, s.MinutesProvider, s.MinutesModel, s.MinutesFlow, s.MinutesThreshold,
		boolToInt(s.AutoDiarize), s.PythonPath, s.VoiceprintModelDir, s.MaxSpeakers, s.MatchThreshold,
		boolToInt(s.AutoSummarize), s.RetentionMode, s.UpdatedAt)
	return err
}

// validateSettings 校验要保存的设置；modelDir 非空时不存在会试着建出来。
// 返回的错误带 "validation" 前缀，接口层映射成 400。
func validateSettings(s *Settings) error {
	s.DefaultEngine = strings.TrimSpace(s.DefaultEngine)
	if s.DefaultEngine == "" {
		s.DefaultEngine = "whisper_local"
	}
	if !contains(engines, s.DefaultEngine) {
		return apiErr(errValidation, "引擎只能是 %s（本地优先，云端引擎 M4 再接）", strings.Join(engines, "、"))
	}
	s.Model = strings.TrimSpace(s.Model)
	if s.Model == "" {
		s.Model = "small"
	}
	if _, ok := catalogByName[s.Model]; !ok {
		return apiErr(errValidation, "模型只能是 %s", modelNameList())
	}
	s.Language = strings.TrimSpace(s.Language)
	if s.Language == "" {
		s.Language = "zh"
	}
	if !languageRe.MatchString(s.Language) {
		return apiErr(errValidation, "语言要用 whisper 的语言码（zh、en、yue、ja…）或 auto")
	}
	if s.Threads < 0 || s.Threads > 64 {
		return apiErr(errValidation, "线程数要在 0 到 64 之间（0 = 自动，最多 8）")
	}
	s.RetentionMode = strings.TrimSpace(s.RetentionMode)
	if s.RetentionMode == "" {
		s.RetentionMode = "keep"
	}
	if !contains(retentionModes, s.RetentionMode) {
		return apiErr(errValidation, "保留策略只能是 %s", strings.Join(retentionModes, "、"))
	}
	// 路径：空表示自动探测；非空必须是可执行文件 / 目录
	s.ModelDir = strings.TrimSpace(s.ModelDir)
	if s.ModelDir != "" {
		s.ModelDir = filepath.Clean(s.ModelDir)
		if fi, err := os.Stat(s.ModelDir); err == nil {
			if !fi.IsDir() {
				return apiErr(errValidation, "模型目录不是目录：%s", s.ModelDir)
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(s.ModelDir, 0o755); err != nil {
				return apiErr(errValidation, "模型目录建不出来：%v", err)
			}
		} else {
			return apiErr(errValidation, "模型目录不可用：%v", err)
		}
	}
	s.WhisperPath = strings.TrimSpace(s.WhisperPath)
	if s.WhisperPath != "" && !isExecutable(s.WhisperPath) {
		return apiErr(errValidation, "whisper-cli 路径不可执行：%s", s.WhisperPath)
	}
	s.FFmpegPath = strings.TrimSpace(s.FFmpegPath)
	if s.FFmpegPath != "" && !isExecutable(s.FFmpegPath) {
		return apiErr(errValidation, "ffmpeg 路径不可执行：%s", s.FFmpegPath)
	}
	s.DefaultProjectID = strings.TrimSpace(s.DefaultProjectID)
	s.MinutesProvider = strings.TrimSpace(s.MinutesProvider)
	s.MinutesModel = strings.TrimSpace(s.MinutesModel)
	s.MinutesFlow = strings.TrimSpace(s.MinutesFlow)
	// 阈值 0 是合法值（推送全部候选），原样保存；默认 0.7 由列默认值和 defaultSettings 给。
	if s.MinutesThreshold < 0 || s.MinutesThreshold > 1 {
		return apiErr(errValidation, "置信度阈值要在 0 到 1 之间（0 = 推送全部候选）")
	}
	// M5 声纹：Python 路径和模型目录只 trim + 长度上限，存在性交给运行时判断
	// （没装 funasr 时只是识别任务失败，不影响转写/纪要；路径在别的机器上也可能暂时不可用）。
	s.PythonPath = strings.TrimSpace(s.PythonPath)
	if len([]rune(s.PythonPath)) > 512 {
		return apiErr(errValidation, "Python 路径最多 512 个字")
	}
	s.VoiceprintModelDir = strings.TrimSpace(s.VoiceprintModelDir)
	if len([]rune(s.VoiceprintModelDir)) > 512 {
		return apiErr(errValidation, "声纹模型目录最多 512 个字")
	}
	// max_speakers 0 表示没填，补默认 8；1–16 合法。
	if s.MaxSpeakers == 0 {
		s.MaxSpeakers = defaultMaxSpeakers
	}
	if s.MaxSpeakers < 1 || s.MaxSpeakers > 16 {
		return apiErr(errValidation, "最多识别几个说话人要在 1 到 16 之间")
	}
	// 匹配阈值 0 是合法值（全部当同一个人），原样保存；默认 0.65 由列默认值和 defaultSettings 给。
	if s.MatchThreshold < 0 || s.MatchThreshold > 1 {
		return apiErr(errValidation, "声纹匹配阈值要在 0 到 1 之间（0 = 全部当同一个人）")
	}
	return nil
}

// effectiveMinutesThreshold 是判断「高置信度」用的阈值；0 表示全部候选都算高置信度。
func effectiveMinutesThreshold(s Settings) float64 {
	if s.MinutesThreshold >= 0 && s.MinutesThreshold <= 1 {
		return s.MinutesThreshold
	}
	return defaultMinutesThreshold
}

// effectiveMatchThreshold 是声纹匹配用的余弦阈值；非法值退回默认 0.65（0 是合法值，表示全部当同一个人）。
func effectiveMatchThreshold(s Settings) float64 {
	if s.MatchThreshold >= 0 && s.MatchThreshold <= 1 {
		return s.MatchThreshold
	}
	return defaultMatchThreshold
}

// effectiveMaxSpeakers 是传给 sidecar 的最多说话人数；非法值退回默认 8。
func effectiveMaxSpeakers(s Settings) int {
	if s.MaxSpeakers >= 1 && s.MaxSpeakers <= 16 {
		return s.MaxSpeakers
	}
	return defaultMaxSpeakers
}

// effectiveModelDir 是实际用哪个目录存模型：设置里给了就用，否则 CacheDir()/models。
func effectiveModelDir(c plugin.Core, s Settings) (string, error) {
	if s.ModelDir != "" {
		return s.ModelDir, nil
	}
	cache := c.CacheDir()
	if cache == "" {
		return "", errors.New("没有可用的缓存目录（数据目录没接上）")
	}
	return filepath.Join(cache, "models"), nil
}

// effectiveThreads 是实际传给 whisper-cli 的线程数：设置里 0 表示自动，最多 8。
func effectiveThreads(s Settings) int {
	if s.Threads > 0 {
		if s.Threads > 64 {
			return 64
		}
		return s.Threads
	}
	n := runtime.NumCPU()
	if n > 8 {
		n = 8
	}
	if n < 1 {
		n = 1
	}
	return n
}

func nowRFC() string { return time.Now().UTC().Format(time.RFC3339) }

// timeNow 给文件名/默认标题用，取本地时间。
func timeNow() time.Time { return time.Now() }

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// clip 截断长文本给界面/错误信息用，按 rune 算长度。
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
