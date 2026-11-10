// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 主动发消息（IM 插件 0.17.0）的纯逻辑：可选的会话、发不了的原因、请求体、「回复了我发出的」的说明。
// 能发给：已有会话（收到过消息的群和私聊，来自会话统计）+ Slack 里账号所在、还没收过消息的频道（GET /api/im/connectors/{id}/conversations）；
// 不支持给没联系过的人新开私聊。
import type { Connector, ImConversationOption, ImConversationSummary, ImMention, ImMessage, ImSendInput } from '../../core/data'
import { displayName } from './groupAdminModel'
import { timeAgo } from './model'

/** 会话下拉的值：已登记的会话 cv:<会话 id>；还没收过消息的频道 ext:<频道编号> */
export type SendTarget = { kind: 'cv'; id: string } | { kind: 'ext'; id: string; name: string }

export type SendOption = { value: string; label: string; group: string; hint: string; keywords: string }

const GROUP_CHAT = '群聊'
const DIRECT_CHAT = '私聊'
const NEW_CHANNEL = '还没收过消息的频道'

/**
 * 一个渠道（一个实例）下能发的会话：已有会话按最近一条消息倒序（分群聊、私聊两组），
 * 有多个实例时只列最近一条消息在这个实例上的；再接上这个实例账号所在、还没收过消息的频道（不含已归档的）
 */
export function sendOptions(rows: readonly ImConversationSummary[], extra: readonly ImConversationOption[], channel: string,
  connectorId: string, multiInstance: boolean, now = Date.now()): SendOption[] {
  const mine = rows.filter((s) => s.channel === channel && s.total > 0 && (!multiInstance || !connectorId || s.connector_id === connectorId))
  const opt = (s: ImConversationSummary): SendOption => ({
    value: `cv:${s.conversation_id}`, label: displayName(s), group: s.kind === 'direct' ? DIRECT_CHAT : GROUP_CHAT,
    hint: `${s.total} 条${s.last_at ? ` · ${timeAgo(s.last_at, now)}` : ''}`, keywords: [s.name, s.external_id, ...s.participants].join(' '),
  })
  const known = new Set(rows.filter((s) => s.channel === channel).map((s) => s.external_id))
  const fresh = extra.filter((c) => c.is_member && !c.is_archived && !known.has(c.id)).map((c): SendOption => ({
    value: `ext:${c.id}`, label: c.kind === 'mpim' ? c.name : `#${c.name}`, group: NEW_CHANNEL,
    hint: c.kind === 'private' ? '私有频道' : c.kind === 'mpim' ? '多人私信' : '频道', keywords: c.id,
  }))
  return [...mine.filter((s) => s.kind !== 'direct').map(opt), ...mine.filter((s) => s.kind === 'direct').map(opt), ...fresh]
}

export function parseTarget(value: string, options: readonly SendOption[]): SendTarget | null {
  if (value.startsWith('cv:')) return { kind: 'cv', id: value.slice(3) }
  if (value.startsWith('ext:')) {
    const o = options.find((x) => x.value === value)
    return { kind: 'ext', id: value.slice(4), name: (o?.label ?? '').replace(/^#/, '') }
  }
  return null
}

/** 请求体：已登记的会话带上选的实例；新频道带实例、频道编号和名字；有 @ 的带上 mentions（0.18.0） */
export function sendInput(t: SendTarget, connectorId: string, text: string, mentions: readonly ImMention[] = []): ImSendInput {
  const body = text.trim()
  const ms = mentions.length ? { mentions: [...mentions] } : {}
  return t.kind === 'cv'
    ? { conversation_id: t.id, ...(connectorId ? { connector_id: connectorId } : {}), text: body, ...ms }
    : { connector_id: connectorId, conversation_external_id: t.id, conversation_name: t.name, text: body, ...ms }
}

/** 这个实例发不了的原因（同回复的分类）；null 是能发 */
export function sendBlocker(c: Connector | undefined): string | null {
  if (!c) return '先选渠道'
  if (c.status === 'paused') return `连接器「${c.name}」已暂停`
  if (c.status === 'disconnected') return `连接器「${c.name}」已断开，去设置里重新连接`
  if (c.status === 'connecting') return `连接器「${c.name}」正在连接`
  if (c.direction === 'receive') return `连接器「${c.name}」设置为只收消息`
  return null
}

/** 消息行上「回复了我发出的」的悬停说明 */
export function sentReplyTitle(m: Pick<ImMessage, 'replied_sent'>, now = Date.now()): string {
  const r = m.replied_sent
  if (!r) return ''
  const text = r.text.replace(/\s+/g, ' ')
  return `${r.via === 'thread' ? '在消息列里回复了' : '回复了'}我 ${timeAgo(r.at, now)}发出的「${text.length > 40 ? `${text.slice(0, 40)}…` : text}」`
}
