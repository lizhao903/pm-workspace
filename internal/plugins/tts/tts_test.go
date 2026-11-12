// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package tts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lizhao903/pm-workspace/internal/connector"
)

// writeVoice 在目录里放一个音色文件。
func writeVoice(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".voice.pt"), []byte("voice"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeScript 写一个可执行脚本，给假的 indextts / ffmpeg 用。
func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// 零配置默认：目录里同时有多个音色时优先 voice-broleez，音色按名字排序。
func TestResolvePrefersBroleez(t *testing.T) {
	dir := t.TempDir()
	writeVoice(t, dir, "voice-other")
	writeVoice(t, dir, "voice-broleez")
	e := resolveValues(context.Background(), map[string]string{"voice_dir": dir, "bin": "/bin/echo", "ffmpeg": "/bin/echo"}, true, "", "")
	if e.DefaultVoice != preferredVoiceName {
		t.Fatalf("默认音色 = %q，想要 %q", e.DefaultVoice, preferredVoiceName)
	}
	if len(e.Voices) != 2 || e.Voices[0].Name != "voice-broleez" || e.Voices[1].Name != "voice-other" {
		t.Fatalf("音色列表 = %+v", e.Voices)
	}
	if e.Warnings == nil {
		// 没配连接器时 warnings 也得是数组，前端按数组渲染
		t.Fatal("warnings 不能是 nil")
	}
	if e.blocking() != "" {
		t.Fatalf("应该能合成，blocking=%q", e.blocking())
	}
}

// 音色目录没音色时不能合成；语速超范围给警告并用 1.0。
func TestResolveWarnings(t *testing.T) {
	empty := t.TempDir()
	e := resolveValues(context.Background(), map[string]string{"voice_dir": empty, "bin": "/bin/echo", "ffmpeg": "/bin/echo", "speed": "9"}, false, "", "")
	if !strings.Contains(e.blocking(), "没有 .voice.pt") {
		t.Fatalf("blocking = %q", e.blocking())
	}
	if e.Speed != 1 {
		t.Fatalf("语速 = %v，想要 1", e.Speed)
	}
	if !strings.Contains(strings.Join(e.Warnings, "；"), "语速") {
		t.Fatalf("warnings = %v", e.Warnings)
	}

	dir := t.TempDir()
	writeVoice(t, dir, "voice-broleez")
	e = resolveValues(context.Background(), map[string]string{"voice_dir": dir, "bin": "/bin/echo", "ffmpeg": "/bin/echo"}, true, "voice-missing", "")
	if e.DefaultVoice != preferredVoiceName {
		t.Fatalf("指定的音色不在目录里时应回默认，得到 %q", e.DefaultVoice)
	}
	if !strings.Contains(strings.Join(e.Warnings, "；"), "voice-missing") {
		t.Fatalf("warnings = %v", e.Warnings)
	}
}

// 连接器没填音色目录时从 INDEXTTS_VOICE_DIR 自动找。
func TestResolveAutoDetectsEnvDir(t *testing.T) {
	dir := t.TempDir()
	writeVoice(t, dir, "voice-broleez")
	t.Setenv("INDEXTTS_VOICE_DIR", dir)
	e := resolveValues(context.Background(), nil, false, "", "")
	if e.VoiceDir != dir || e.DefaultVoice != preferredVoiceName {
		t.Fatalf("自动检测 = %+v", e)
	}
}

// 连接器定义要能过内核校验。
func TestConnectorDefValid(t *testing.T) {
	d := New().connectorDef()
	if _, err := connector.Prepare(d); err != nil {
		t.Fatalf("连接器定义不合法：%v", err)
	}
}

// 用假的 indextts / ffmpeg 跑完整合成链路，确认参数和产物。
func TestSynthesizeWithFakeTools(t *testing.T) {
	dir := t.TempDir()
	writeVoice(t, dir, "voice-broleez")
	argsFile := filepath.Join(dir, "args.txt")
	bin := writeScript(t, dir, "indextts", `#!/bin/bash
echo "$@" > "`+argsFile+`"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'RIFFfake' > "$out"
`)
	ff := writeScript(t, dir, "ffmpeg", `#!/bin/bash
for last; do :; done
printf 'MP3DATA' > "$last"
`)
	e := resolved{
		DefaultVoice: "voice-broleez",
		Voices:       []voiceFile{{Name: "voice-broleez", Path: filepath.Join(dir, "voice-broleez.voice.pt")}},
		Speed:        1.25,
		bin:          bin,
		ffmpeg:       ff,
	}
	audio, format, err := synthesize(context.Background(), e, "你好，这是配音测试")
	if err != nil {
		t.Fatal(err)
	}
	if string(audio) != "MP3DATA" || format != "audio/mpeg" {
		t.Fatalf("audio=%q format=%q", audio, format)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "--duration_scale 0.800") {
		t.Fatalf("indextts 参数 = %q", args)
	}
}
