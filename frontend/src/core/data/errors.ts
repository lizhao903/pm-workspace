// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 统一的错误提示（CORE-03a）：接口层抛的 ApiError、StreamError 和普通 Error 都在这里转成给人看的一句话。
import { isApiError, isStreamError, type ApiErrorCode } from '../api'

// 后端没给说明时按错误码兜底
const CODE_TEXT: Record<ApiErrorCode, string> = {
  validation: '填写的内容不符合要求',
  not_found: '找不到这条记录，可能已被删除',
  conflict: '和别处的改动冲突了，刷新后再试',
  readonly: '没有权限做这个操作',
  internal: '后端出错了',
  network: '连不上后端',
}

/** 错误转成一句话；后端给了说明就用后端的，请求没到后端时说清楚是连不上 */
export function errorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === 'network') return `${CODE_TEXT.network}${e.message ? `（${e.message}）` : ''}`
    return e.message || CODE_TEXT[e.code]
  }
  if (isStreamError(e) || e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

/** 4xx 是请求本身的问题，重试没用；network 和 5xx 才重试 */
export function retryable(e: unknown): boolean {
  return !(isApiError(e) && e.status >= 400 && e.status < 500)
}
