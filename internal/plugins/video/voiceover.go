// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package video

import (
	"context"
	"fmt"
	"strings"
)

// 配音（TTS-01）：音频合成阶段不用用户配执行器，也没配就默认用技能「网页演示做视频」，
// 提示词里写清楚用本机语音合成（IndexTTS）和哪个音色、语速——这些来自系列设置，
// 没设就用「语音合成」插件的默认值。用户不用自己配 TTS / 音色 / API key。

// voiceoverRunner 是音频合成阶段没配执行器时的默认执行器。
func voiceoverRunner(s Series) StageRunner {
	return StageRunner{Stage: "audio", Type: "skill", RefID: "sk_video", Prompt: voiceoverBrief(s)}
}

// voiceoverBrief 是给执行器的配音要求：音色、语速都要写死，别让模型回头问用户。
func voiceoverBrief(s Series) string {
	voice := strings.TrimSpace(s.Voice)
	if voice == "" {
		voice = "语音合成插件的默认音色（优先 voice-broleez）"
	}
	speed := s.VoiceSpeed
	if speed <= 0 {
		speed = 1
	}
	var b strings.Builder
	b.WriteString("配音要求（工作台的「语音合成」已经配好，直接照做，不要停下来问用户用哪种 TTS、音色或 API key）：\n")
	fmt.Fprintf(&b, "- 用本机 IndexTTS 合成各章口播音频；音色：%s；语速：%.2f（indextts 的 --duration_scale 取 %.3f）。\n", voice, speed, 1/speed)
	b.WriteString("- 在 presentation 目录跑 scripts/synthesize-audio-indextts.sh 增量合成（脚本支持 --voice=<音色>）；脚本不存在时用本机 indextts CLI 逐段合成，再用 ffmpeg 转 mp3，输出路径按 audio-segments.json 的 audio 字段。\n")
	b.WriteString("- 不要走 MiniMax/mmx，不要问用户要配置；合成完按 references/AUDIO.md 校验时长，超过 15 秒的报告出来。\n")
	b.WriteString("- 音色目录和命令在 设置 → 连接器 → 语音合成 里；没装/没配时插件会自动检测本机 IndexTTS。\n")
	return b.String()
}

// seriesOf 取视频所在系列；单集视频或系列被删了返回零值（音色空、语速 1.0）。
func (h *handler) seriesOf(ctx context.Context, v Video) Series {
	s := Series{VoiceSpeed: 1}
	if v.SeriesID == nil || strings.TrimSpace(*v.SeriesID) == "" {
		return s
	}
	got, err := h.getSeries(ctx, *v.SeriesID)
	if err != nil {
		return s
	}
	return got
}
