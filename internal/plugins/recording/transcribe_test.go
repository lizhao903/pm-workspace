// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func writeTempJSON(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "out.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseWhisperJSON(t *testing.T) {
	path := writeTempJSON(t, `{
		"transcription": [
			{"offsets": {"from": 0, "to": 2400}, "text": " 今天开个会 "},
			{"offsets": {"from": 2400, "to": 5200}, "text": ""},
			{"offsets": {"from": 5200, "to": 9100}, "text": "先过一下上周的进度"}
		]
	}`)
	segs, err := parseWhisperJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 {
		t.Fatalf("空文本应该被丢掉，剩 2 段，实际 %d 段：%+v", len(segs), segs)
	}
	if segs[0].Text != "今天开个会" || segs[0].StartMs != 0 || segs[0].EndMs != 2400 {
		t.Errorf("第一段不对：%+v", segs[0])
	}
	if segs[0].Seq != 0 || segs[1].Seq != 1 {
		t.Errorf("seq 应该重排成 0、1：%+v", segs)
	}
	if segs[1].StartMs != 5200 || segs[1].EndMs != 9100 {
		t.Errorf("第二段时间戳不对：%+v", segs[1])
	}
	if got, want := joinSegments(segs), "今天开个会\n先过一下上周的进度"; got != want {
		t.Errorf("全文拼接 = %q，想要 %q", got, want)
	}
}

func TestParseWhisperJSONMissingFile(t *testing.T) {
	if _, err := parseWhisperJSON(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("文件不存在应该报错")
	}
}

func TestParseWhisperJSONBadContent(t *testing.T) {
	path := writeTempJSON(t, `not json`)
	if _, err := parseWhisperJSON(path); err == nil {
		t.Fatal("坏 JSON 应该报错")
	}
}

func TestWhisperProgressRegex(t *testing.T) {
	cases := map[string]int{
		"whisper_print_progress_callback: progress =   0%": 0,
		"whisper_print_progress_callback: progress =  41%": 41,
		"whisper_print_progress_callback: progress = 100%": 100,
	}
	for line, want := range cases {
		m := whisperProgressRe.FindStringSubmatch(line)
		if len(m) < 2 {
			t.Fatalf("没解析出进度：%q", line)
		}
		got, err := strconv.Atoi(m[1])
		if err != nil {
			t.Fatalf("%q 里的进度不是数字：%v", line, err)
		}
		if got != want {
			t.Errorf("%q 解析成 %d，想要 %d", line, got, want)
		}
	}
	if whisperProgressRe.MatchString("no progress here") {
		t.Error("不含进度的行不该匹配")
	}
}

func TestSniffAudioExt(t *testing.T) {
	cases := []struct {
		name string
		head []byte
		want string
	}{
		{"webm", []byte{0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42}, "webm"},
		{"wav", []byte("RIFF\x24\x08\x00\x00WAVEfmt "), "wav"},
		{"m4a", []byte("\x00\x00\x00\x20ftypM4A "), "m4a"},
		{"mp3-id3", []byte("ID3\x04\x00\x00"), "mp3"},
		{"ogg", []byte("OggS\x00\x02"), "ogg"},
		{"flac", []byte("fLaC\x00\x00"), "flac"},
		{"empty", nil, "webm"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "audio.bin")
			if err := os.WriteFile(path, c.head, 0o644); err != nil {
				t.Fatal(err)
			}
			if got := sniffAudioExt(path, ""); got != c.want {
				t.Errorf("sniffAudioExt = %q，想要 %q", got, c.want)
			}
		})
	}
}
