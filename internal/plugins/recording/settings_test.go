// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateSettingsDefaults(t *testing.T) {
	s := Settings{}
	if err := validateSettings(&s); err != nil {
		t.Fatalf("空设置应该补成默认值，没报错：%v", err)
	}
	if s.DefaultEngine != "whisper_local" || s.Model != "small" || s.Language != "zh" || s.RetentionMode != "keep" {
		t.Fatalf("默认值不对：%+v", s)
	}
}

func TestValidateSettingsRejects(t *testing.T) {
	cases := []struct {
		name string
		in   Settings
	}{
		{"未知引擎", Settings{DefaultEngine: "cloud", Model: "small", Language: "zh", RetentionMode: "keep"}},
		{"未知模型", Settings{DefaultEngine: "whisper_local", Model: "tiny", Language: "zh", RetentionMode: "keep"}},
		{"语言不合法", Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh-CN!", RetentionMode: "keep"}},
		{"线程数越界", Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "keep", Threads: 65}},
		{"保留策略不认识", Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "delete_everything"}},
		{"whisper 路径不可执行", Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "keep", WhisperPath: "/nonexistent/whisper-cli"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := c.in
			err := validateSettings(&s)
			if err == nil {
				t.Fatalf("应该校验失败：%+v", c.in)
			}
			if !errors.Is(err, errValidation) {
				t.Fatalf("错误应该带 validation 类别：%v", err)
			}
		})
	}
}

func TestValidateSettingsCreatesModelDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "models")
	s := Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "keep", ModelDir: dir}
	if err := validateSettings(&s); err != nil {
		t.Fatalf("不存在的模型目录应该能建出来：%v", err)
	}
}

func TestEffectiveThreads(t *testing.T) {
	if got := effectiveThreads(Settings{Threads: 4}); got != 4 {
		t.Errorf("指定 4 线程 = %d", got)
	}
	auto := effectiveThreads(Settings{})
	if auto < 1 || auto > 8 {
		t.Errorf("自动线程数应在 1–8，实际 %d", auto)
	}
	if got := effectiveThreads(Settings{Threads: 99}); got != 64 {
		t.Errorf("线程数上限应该是 64，实际 %d", got)
	}
}

func TestCatalogSizes(t *testing.T) {
	for _, spec := range catalog {
		if spec.bytes <= 0 || spec.file == "" {
			t.Errorf("模型 %s 的元信息不完整：%+v", spec.name, spec)
		}
	}
	if len(catalogByName) != len(catalog) {
		t.Errorf("模型索引和清单不一致")
	}
}

func TestDefaultSettingsThreshold(t *testing.T) {
	if got := defaultSettings().MinutesThreshold; got != defaultMinutesThreshold {
		t.Errorf("设置默认阈值应为 %.1f，实际 %v", defaultMinutesThreshold, got)
	}
}

func TestValidateSettingsThresholdRange(t *testing.T) {
	base := Settings{DefaultEngine: "whisper_local", Model: "small", Language: "zh", RetentionMode: "keep"}
	// 0 是合法值（推送全部候选），不能被改成 0.7。
	s := base
	s.MinutesThreshold = 0
	if err := validateSettings(&s); err != nil {
		t.Fatalf("阈值 0 应该合法：%v", err)
	}
	if s.MinutesThreshold != 0 {
		t.Errorf("阈值 0 应原样保留，实际 %v", s.MinutesThreshold)
	}
	// 0.42 原样保留。
	s = base
	s.MinutesThreshold = 0.42
	if err := validateSettings(&s); err != nil || s.MinutesThreshold != 0.42 {
		t.Fatalf("阈值 0.42 应合法：%v %v", s.MinutesThreshold, err)
	}
	for _, bad := range []float64{-0.1, 1.1} {
		s = base
		s.MinutesThreshold = bad
		if err := validateSettings(&s); !errors.Is(err, errValidation) {
			t.Errorf("阈值 %v 应校验失败：%v", bad, err)
		}
	}
}

// 阈值 0 能存能读：saveSettings 写进去的是 0（不是默认 0.7），loadSettings 读回来还是 0。
func TestSettingsZeroThresholdRoundTrip(t *testing.T) {
	store := &fakeStore{}
	// settingsCols 的列顺序：... minutes_flow, minutes_threshold, auto_diarize, python_path,
	// voiceprint_model_dir, max_speakers, match_threshold, auto_summarize, retention_mode, updated_at
	store.row = []any{"whisper_local", "small", "", "", "", "zh", 0, "", "", "", "", 0.0,
		0, "", "", 8, 0.65, 0, "keep", "2026-11-10T00:00:00Z"}
	c := &fakeCore{store: store}
	got, err := loadSettings(context.Background(), c)
	if err != nil {
		t.Fatalf("读设置失败：%v", err)
	}
	if got.MinutesThreshold != 0 {
		t.Errorf("库里的阈值 0 应原样读出，实际 %v", got.MinutesThreshold)
	}
	if err := saveSettings(context.Background(), c, got); err != nil {
		t.Fatalf("存设置失败：%v", err)
	}
	q, args := store.lastExec()
	if !strings.Contains(q, "minutes_threshold = ?") {
		t.Fatalf("保存语句里没写阈值：%s", q)
	}
	if len(args) < 12 || args[11] != float64(0) {
		t.Errorf("保存的阈值应是 0，实际 %v", args)
	}
}
