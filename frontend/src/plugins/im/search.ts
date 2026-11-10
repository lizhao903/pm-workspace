// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 命令面板的「消息」数据源（SPEC-messages-0 联动）：按正文、发信人、群名搜，多个词按空格拆开、每个词都要命中
import type { ImMessage } from '../../core/data'

/** 一次最多给几条，和命令面板每组露出的条数一致 */
export const SEARCH_MAX = 6

/** 新的在前 */
export function searchMessages(rows: readonly ImMessage[], q: string): ImMessage[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return rows
    .filter((m) => {
      const hay = `${m.text} ${m.sender_name} ${m.contact_name} ${m.conversation}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, SEARCH_MAX)
}

/** 面板里一行显示：发信人：正文（换行压成空格） */
export const messageTitle = (m: ImMessage) => `${m.contact_name || m.sender_name || '未知发信人'}：${m.text.replace(/\s+/g, ' ').trim()}`
