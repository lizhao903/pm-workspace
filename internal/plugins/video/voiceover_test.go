// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"strings"
	"testing"
)

// 系列上能存「配音」音色和语速，没给时语速默认 1.0，越界和带路径的音色被拒。
func TestSeriesVoiceoverFields(t *testing.T) {
	e := setup(t)
	s := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"配音系列","voice":"voice-broleez","voice_speed":1.25}`, 201)
	if s["voice"] != "voice-broleez" || s["voice_speed"] != 1.25 {
		t.Fatalf("系列配音字段 = %v", s)
	}
	id := s["id"].(string)
	got := mustCall(t, e.h, "GET", "/api/video/series/"+id, "", 200)
	if got["voice"] != "voice-broleez" || got["voice_speed"] != 1.25 {
		t.Fatalf("读回配音字段 = %v", got)
	}

	plain := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"默认配音"}`, 201)
	if plain["voice"] != "" || plain["voice_speed"] != 1.0 {
		t.Fatalf("没配音配置时应为空音色、语速 1.0：%v", plain)
	}

	up := mustCall(t, e.h, "PATCH", "/api/video/series/"+id, `{"voice":"voice-sincere-adult","voice_speed":2}`, 200)
	if up["voice"] != "voice-sincere-adult" || up["voice_speed"] != 2.0 {
		t.Fatalf("改配音字段 = %v", up)
	}

	mustCall(t, e.h, "PATCH", "/api/video/series/"+id, `{"voice_speed":3}`, 400)
	mustCall(t, e.h, "PATCH", "/api/video/series/"+id, `{"voice":"a/b"}`, 400)
	mustCall(t, e.h, "PATCH", "/api/video/series/"+id, `{"voice_speed":"fast"}`, 400)
}

// 音频合成阶段没配执行器也能跑：默认技能带上系列里的音色和语速，不让模型回头问用户配置。
func TestAudioStageDefaultRunnerUsesSeriesVoiceover(t *testing.T) {
	e := setup(t)
	fc := &fakeClaude{}
	e.r.SetClaudeRunner(fc)

	s := mustCall(t, e.h, "POST", "/api/video/series", `{"name":"配音系列","voice":"voice-sincere-adult","voice_speed":1.25}`, 201)
	sid := s["id"].(string)
	root := t.TempDir()
	v := mustCall(t, e.h, "POST", "/api/video/videos",
		`{"title":"配音测试","series_id":"`+sid+`","orientations":["landscape"],"root":"`+root+`","chapters":2}`, 201)
	vid := v["id"].(string)
	// 直接推到音频合成阶段：前面的检查点已通过（省得走完整流程）。
	if _, err := e.d.W.Exec(`UPDATE video_videos SET stage = 'audio' WHERE id = ?`, vid); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.W.Exec(`UPDATE video_checkpoints SET state = 'passed' WHERE video_id = ? AND stage IN ('plan','ch1')`, vid); err != nil {
		t.Fatal(err)
	}
	// 不配执行器直接跑：应该 202 发起到技能，而不是 409「没配执行器」。
	mustCall(t, e.h, "POST", "/api/video/videos/"+vid+"/runners/audio/run", "", 202)
	req := fc.last()
	for _, want := range []string{"配音要求", "voice-sincere-adult", "1.25", "IndexTTS"} {
		if !strings.Contains(req.Prompt, want) {
			t.Fatalf("提示词里缺少 %q：\n%s", want, req.Prompt)
		}
	}
}

// 单集视频（没有系列）用默认配音要求，不报错。
func TestVoiceoverBriefDefaults(t *testing.T) {
	brief := voiceoverBrief(Series{VoiceSpeed: 0})
	if !strings.Contains(brief, "默认音色") || !strings.Contains(brief, "1.00") {
		t.Fatalf("默认配音要求 = %s", brief)
	}
}
