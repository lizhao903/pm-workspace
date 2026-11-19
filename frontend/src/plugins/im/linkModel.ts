// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息链接（im 0.32.0，SPEC-messages-2.57、SPEC-tasks-4.84）：工作台里的深链和原平台的链接。
// 深链沿用消息页已有的 ?m=<消息 id>（今日、命令面板、会话来源都这么打开消息抽屉），复制时拼上当前访问的地址；
// 原平台的链接由后端算好放在 permalink 里，拼不出为空串，界面上不显示。
import type { ImMessage } from '../../core/data'

/** 消息页里打开这条消息的地址 */
export const messagePath = (id: string) => `/messages?m=${encodeURIComponent(id)}`

/** 复制用的完整链接：origin 是浏览器当前访问的地址（window.location.origin） */
export const messageURL = (id: string, origin: string) => origin.replace(/\/+$/, '') + messagePath(id)

/** 「在 Slack 打开」：label 是渠道名 */
export const permalinkLabel = (label: string) => `在 ${label} 打开`

/** 只认 http(s) 的原平台链接，别的（后端旧版本没有、意外的值）不显示 */
export const permalinkOf = (m: Pick<ImMessage, 'permalink'>) => (m.permalink && /^https?:\/\//.test(m.permalink) ? m.permalink : '')

/** 正文摘要：空白合并成一个空格，超过 n 字截断加省略号 */
export function digest(text: string, n = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return [...t].length > n ? [...t].slice(0, n).join('') + '…' : t
}
