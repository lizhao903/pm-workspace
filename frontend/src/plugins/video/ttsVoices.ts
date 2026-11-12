// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 语音合成插件（tts）的可用音色：系列「配音」下拉用。插件没装/没启用时接口 404，这里按没有音色处理，
// 系列配音仍可以留空（音频合成阶段用插件默认音色）。
import { useQuery } from '@tanstack/react-query'
import { isApiError, request } from '../../core/api'

export type TtsVoice = { name: string; path: string }
export type TtsVoices = {
  engine: string
  voice_dir: string
  default_voice: string
  voices: TtsVoice[]
  configured: boolean
  warnings: string[]
}

export function useTtsVoices() {
  return useQuery({
    queryKey: ['tts-voices'],
    queryFn: ({ signal }) => request<TtsVoices>('GET', '/api/tts/voices', { signal }),
    // 插件没装时 404 不重试；其它错误重试一次
    retry: (n, e) => !isApiError(e, 'not_found') && n < 1,
    staleTime: 60_000,
  })
}
