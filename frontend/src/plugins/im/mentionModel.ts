// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 回复框、发消息弹窗里的 @（IM 插件 0.18.0）的纯逻辑：
// - 群聊回复默认 @ 原发信人：回复框底部「回复时 @ 对方」开关（默认打开，记在本机），打开时发送拼到正文开头、放进 mentions；私聊没有开关。
// - 输入 @ 弹出候选（联系人在前：认上联系人的发言人、这个渠道有 IM 身份的联系人，再是没认上的发言人；GET /api/im/conversations/{id}/members），
//   选中后正文里写「@名字 」，记下选过的人；发送时只把正文里还在的「@名字」交给后端。
// - 正文里手打、没从候选里选的 @ 不进 mentions，后端照原样发。
// 工作台里显示自己发出的回复、发件仍是「@名字」（后端存的就是原文）。
import type { ImMember, ImMention, ImMessage } from '../../core/data'

/** 候选列表最多显示几个 */
export const MENTION_LIST_MAX = 8
/** @ 后面最多认几个字当搜索词，再长就不弹了 */
const QUERY_MAX = 24

/** 要 @ 的人：编号 + 名字（同后端 mentions 的一项） */
export type MentionPick = { external_id: string; name: string }

/** 群聊回复「@ 对方」的原发信人；私聊、没有发信人编号时为 null（没有开关） */
export function defaultMention(m: Pick<ImMessage, 'conversation_kind' | 'sender_id' | 'sender_name' | 'contact_name'>): MentionPick | null {
  if (m.conversation_kind !== 'group' || !m.sender_id) return null
  const name = (m.contact_name || m.sender_name || '').trim()
  return name ? { external_id: m.sender_id, name } : null
}

/** 光标前正在输入的 @：@ 在开头或前面是空白、标点（不是邮箱 a@b），@ 到光标之间没有空白；没有时为 null */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > QUERY_MAX || /\s/.test(query)) return null
  if (at > 0 && /[A-Za-z0-9_]/.test(before[at - 1])) return null
  return { start: at, query }
}

/** 按名字、渠道里的名字、编号搜（不分大小写），名字开头匹配的在前；最多 MENTION_LIST_MAX 个 */
export function filterMembers(members: readonly ImMember[], query: string, max = MENTION_LIST_MAX): ImMember[] {
  const q = query.trim().toLowerCase()
  if (!q) return members.slice(0, max)
  const hits = members.filter((m) => [m.name, m.sender_name, m.external_id].some((s) => s.toLowerCase().includes(q)))
  const head = hits.filter((m) => m.name.toLowerCase().startsWith(q))
  return [...head, ...hits.filter((m) => !head.includes(m))].slice(0, max)
}

/** 把光标前的「@搜索词」换成「@名字 」，回新正文和光标位置 */
export function insertMention(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const ins = `@${name} `
  const rest = text.slice(caret)
  const next = `${text.slice(0, start)}${ins}${rest.startsWith(' ') ? rest.slice(1) : rest}`
  return { text: next, caret: start + ins.length }
}

/**
 * 发出去的正文和 mentions：tag（开关打开时的对方）拼到开头（正文已经以它开头的不重复拼），
 * mentions 只留正文里还能找到「@名字」的（删掉了的不带），同一个人同一个名字只留一个
 */
export function composeMentions(text: string, tag: MentionPick | null, picked: readonly MentionPick[]): { text: string; mentions: ImMention[] } {
  let body = text.trim()
  if (tag && body && !body.startsWith(`@${tag.name}`)) body = `@${tag.name} ${body}`
  const seen = new Set<string>()
  const mentions: ImMention[] = []
  for (const m of tag ? [tag, ...picked] : picked) {
    const k = `${m.external_id}\u0000${m.name}`
    if (seen.has(k) || !body.includes(`@${m.name}`)) continue
    seen.add(k)
    mentions.push({ external_id: m.external_id, name: m.name })
  }
  return { text: body, mentions }
}
